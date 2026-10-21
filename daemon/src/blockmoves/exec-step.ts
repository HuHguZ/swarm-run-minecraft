'use strict'
// Исполнитель моста и спуска блоками — тик (st.step на physicsTick). Фазы по порядку прежнего тела: начало тика (сроки
// ответов, «путь не отсюда»), ступени спуска (descTick), очередь клеток моста, отрезок моста (ожидание поиска, клавиши,
// щелчок). Фаза возвращает итог тика или undefined — дальше по фазам (сам тик undefined не возвращает никогда).
import { Vec3 } from 'vec3'
import { EYE, key, replaceable } from './cells'
import { geometry, decide, steerTo } from './geometry'
import { type BridgeExec, nodes, moving, solidAt, filler, prepare, expire, cancelScheduled, finish, replan, fire, cellKey, near } from './exec-state'

// Мост по частичному пути над пустотой: ждать конца поиска не дольше (pathfinder сбрасывает путь «stuck» через 3.5 с).
const HOLD_MS = Number(process.env.ND_BRIDGE_HOLD_MS || 2500)

// Значения тика, общие для фаз (прежние const тела st.step).
interface Tick {
  ns: any
  e: any
  going: boolean
  nd: any
  settled: boolean
}

// ---- спуск блоками (ход ndDescend): фаза 1 — присев к краю (присед не даёт сорваться) и щелчок по грани стены,
// как только она видна; фаза 2 — без приседа шаг с края и полёт на 2 к центру своего блока. Руль — «разгон-
// торможение» из расчёта Codex (codex-lab/mv-descent/sim.js walk-brake): нужное изменение скорости → взгляд по
// нему и «вперёд», если оно больше половины разгона за тик (на земле и в воздухе — свои коэффициенты физики).
function descTick (x: BridgeExec, e) {
  const { bot, st, stats, pending, hand, now, bodyClear } = x
  const d = st.desc
  const C = d.cell
  const T = new Vec3(C.x + 0.5, C.y + 1, C.z + 0.5)
  const p = e.position
  const keys = (fwd, sneak) => {
    bot.setControlState('forward', !!fwd)
    for (const k of ['back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
    bot.jumpQueued = false
    bot.setControlState('sneak', !!sneak)
  }
  // An Emergency support can fill the old landing while this descent is
  // paused. Replan from the rescued position instead of walking into it.
  if (!bodyClear(bot, T)) { d.done = 'blocked'; replan(x, 'спуск: посадка занята', { cell: [C.x, C.y, C.z] }); return null }
  // Встал на свой блок — ступень пройдена.
  if (e.onGround && Math.abs(p.y - T.y) < 0.01 && Math.abs(p.x - T.x) < 0.8 && Math.abs(p.z - T.z) < 0.8) { d.done = 'landed'; return null }
  if (p.y < C.y - 0.5) { d.done = 'fell'; stats.descFell = (stats.descFell || 0) + 1; return null }
  if (now() - d.t0 > 6000 || Math.hypot(p.x - T.x, p.z - T.z) > 3.5) { d.done = 'lost'; replan(x, 'спуск: не вышло', { cell: [C.x, C.y, C.z] }); return null }
  const placed = solidAt(x, C) || pending.has(key(C))
  if (!placed) {
    if (!e.onGround) { d.done = 'air'; return null } // в воздухе без блока — ловит сторож падения
    // Тело не на исходной клетке ступени (путь перестроен из воздуха, из ямки) — ступень не про нас: перестроить.
    const org = d.tag.from
    if (Math.abs(p.y - org.y) > 0.6 || Math.hypot(p.x - (org.x + 0.5), p.z - (org.z + 0.5)) > 1.3) {
      d.done = 'moved'; stats.descMoved = (stats.descMoved || 0) + 1
      replan(x, 'спуск: тело не на ступени', { cell: [C.x, C.y, C.z], from: [org.x, org.y, org.z] })
      return null
    }
    const item = filler(x)
    if (!item) { stats.noItem++; prepare(x); keys(false, true); replan(x, 'спуск: нет блоков в хотбаре'); return { stop: true } }
    // Опора — стена под краем (C − d): грань видна только со свесом за край — к краю (присед держит). Стена сбоку:
    // грань видна из центра своей ступени, а с её края луч цепляет саму ступень — стоять в центре.
    const edge = d.ref.x === C.x - d.tag.dir.x && d.ref.z === C.z - d.tag.dir.z
    const from = d.tag.from
    const st2 = steerTo(bot, e, edge ? T : new Vec3(from.x + 0.5, p.y, from.z + 0.5), true)
    const eye = p.offset(0, EYE, 0)
    const fp = d.ref.offset(0.5 + d.face.x * 0.5, 0.5, 0.5 + d.face.z * 0.5)
    const pitch = Math.atan2(fp.y - eye.y, Math.max(0.05, Math.hypot(fp.x - eye.x, fp.z - eye.z)))
    bot.look(st2.yaw, pitch, true)?.catch?.(() => {})
    keys(st2.forward, true)
    if (!hand.on()) {
      const snap = p.clone()
      st.scheduled = () => fire(x, snap, d.ref, { x: C.x - d.ref.x, z: C.z - d.ref.z }, C, item)
      bot.once('move', st.scheduled)
    }
    d.ticksA = (d.ticksA || 0) + 1
    return { phase: 'place' }
  }
  const st2 = steerTo(bot, e, T, false)
  bot.look(st2.yaw, 0, true)?.catch?.(() => {})
  keys(st2.forward, false)
  if (!d.stepAt) d.stepAt = now()
  return { phase: 'step' }
}

// Спуск блоками: ступень ведём до посадки на свой блок, даже если pathfinder уже засчитал узел (|dy| < 1 в полёте).
function startDesc (x: BridgeExec, nd) {
  const { st, stats, now } = x
  const t = nd.ndDescend
  st.desc = { tag: t, cell: new Vec3(t.cell.x, t.cell.y, t.cell.z), ref: new Vec3(t.ref.x, t.ref.y, t.ref.z), face: t.face, t0: now() }
  stats.descSteps = (stats.descSteps || 0) + 1
}

// Отладка (ND_DEBUG_BRIDGE): тридцать тиков после отрезка моста.
function logAfter (x: BridgeExec, e, ns) {
  const { bot, st, log } = x
  st.after--
  const p = e.position; const n0 = Array.isArray(ns) && ns[0]
  const c = {}; for (const k of ['forward', 'back', 'jump', 'sneak', 'sprint']) c[k] = bot.getControlState(k)
  log('после', { p: [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000), g: e.onGround, yaw: Math.round(e.yaw * 100) / 100, c, node: n0 ? [n0.x, n0.y, n0.z, n0.toPlace.length, n0.toBreak.length, !!n0.parkour] : null, len: Array.isArray(ns) ? ns.length : -1, mv: moving(x) })
}

function hold (x: BridgeExec) {
  const { bot, stats } = x
  for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
  bot.jumpQueued = false
  bot.setControlState('sneak', true)
  stats.held = (stats.held || 0) + 1
  return { hold: true }
}

// Путь «не отсюда»: A* ищет от места, где начался поиск, а тело тем временем ушло вниз по частичному пути (спуск
// блоками) — итоговый путь ведёт к узлу выше прыжка над телом, и тело прыгает на месте до «stuck»/сторожа goto
// (обрыв 20, mv-gap-fin2 и mv-cliff-dbg4: 16–30 с вместо 11, «ступень: fell» по клетке над телом). Перестроить
// отсюда сразу (не чаще раза в секунду): узел выше тела на 1.3+, без постановки (столб), тело на земле не в воде.
function notHere (x: BridgeExec, t: Tick) {
  const { bot, st, stats } = x
  const { e, nd } = t
  const climb = (p) => { const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), false); return !!(b && /ladder|vine|scaffolding/.test(b.name)) }
  if (!st.desc && nd && e.onGround && !e.isInWater && !e.isInLava && !(nd.toPlace && nd.toPlace.length) && nd.y - e.position.y > 1.3 && !climb(e.position) && !climb(nd)) {
    stats.notHere = (stats.notHere || 0) + 1
    replan(x, 'путь не отсюда', { node: [nd.x, nd.y, nd.z], pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100) })
    return true
  }
  return false
}

// Ступени спуска: ведём текущую; встали на свой блок — следующую начинаем в этом же тике.
function descend (x: BridgeExec, t: Tick) {
  const { bot, st, stats, now, log } = x
  const { e, ns, going } = t
  for (let pass = 0; st.desc && pass < 2; pass++) {
    if (!e.isInWater && !e.isInLava) {
      const r = descTick(x, e)
      if (!st.desc.done) return r
    }
    if (process.env.ND_DEBUG_BRIDGE) { const dd = st.desc; log('ступень: ' + (dd.done || 'вода'), { cell: [dd.cell.x, dd.cell.y, dd.cell.z], ms: now() - dd.t0, placeMs: dd.stepAt ? dd.stepAt - dd.t0 : null, ticksA: dd.ticksA || 0, pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100) }) }
    const landed = st.desc.done === 'landed'
    if (landed) stats.descLanded = (stats.descLanded || 0) + 1
    st.desc = null
    try { bot.setControlState('sneak', false); bot.setControlState('forward', false); bot.setControlState('jump', false); bot.jumpQueued = false } catch {}
    // Встали на ступень — следующую начинаем в этом же тике (иначе прыжок pathfinder'а с края ступени, mv-descent:
    // +1.25 к падению). Узел, уже засчитанный pathfinder'ом, пропускаем.
    if (!landed || !going) break
    let k = 0
    while (k < ns.length && ns[k] && ns[k].ndDescend && Math.abs(ns[k].y - e.position.y) < 0.01 && Math.abs(ns[k].x - e.position.x) < 0.8 && Math.abs(ns[k].z - e.position.z) < 0.8) k++
    const next = ns[k]
    // Засчитать ступень pathfinder'у: тело садится в 0.4–0.8 от центра узла, а «прибытие» у исполнителя pathfinder'а —
    // 0.35, и только оно обновляет его lastNodeTime: через 3.5 с — «stuck» посреди спуска и поиск с нуля
    // (mv-cliff-dbg6: три «stuck» на обрыве 20, 26 с вместо 10). Пройденные ступени — долой, первой — метка в точке
    // тела: исполнитель засчитает её на следующем тике (тело стоит) и пойдёт к следующей ступени.
    if (k > 0) {
      const m: any = new Vec3(e.position.x, e.position.y, e.position.z)
      m.toBreak = []; m.toPlace = []; m.parkour = false; m.cost = 0; m.remainingBlocks = (ns[0] && ns[0].remainingBlocks) || 0; m.ndKeep = true
      ns.splice(0, k, m)
      stats.descMarks = (stats.descMarks || 0) + 1
    }
    if (next && next.ndDescend) startDesc(x, next)
  }
  return undefined
}

// Очередь клеток моста по узлам пути; итог — первый узел пути (после сдвига проеханного узла-моста).
function bridgeQueue (x: BridgeExec, t: Tick) {
  const { bot, st, stats, pending } = x
  const { e, ns, going } = t
  let n = going ? ns[0] : null
  // Узел-мост, чья клетка уже стоит, а тело его проехало (сбоку дальше 0.35 — pathfinder не засчитал): сдвинуть
  // самим (это тот же массив, что у исполнителя pathfinder'а), иначе тело пятится дальше без опоры.
  if (n && n.ndBridge && e.onGround) {
    const c = new Vec3(n.ndBridge.ref.x + n.ndBridge.dir.x, n.ndBridge.ref.y, n.ndBridge.ref.z + n.ndBridge.dir.z)
    const past = geometry(e.position, c, n.ndBridge.dir)
    if (past.s > -0.4 && Math.abs(past.off) < 0.7 && solidAt(x, c)) { ns.shift(); stats.selfShift = (stats.selfShift || 0) + 1; n = ns[0] }
  }
  if (n && n.ndBridge && !st.queue.some(q => cellKey(q) === cellKey(n.ndBridge))) st.queue.push(n.ndBridge)
  // Поставленные (или в пути к серверу) и далёкие (путь сменился) — из очереди долой.
  st.queue = st.queue.filter(q => {
    const c = new Vec3(q.ref.x + q.dir.x, q.ref.y, q.ref.z + q.dir.z)
    return !solidAt(x, c) && !pending.has(key(c)) && near(q, e.position)
  })
  // Опора первой клетки — воздух, а перед ней твёрдое по той же оси: узел-предшественник срезан pathFromPlayer ещё
  // до fixPath (ревью Codex) — поставить его клетку первой.
  const q0 = st.queue[0]
  if (q0) {
    const r0 = new Vec3(q0.ref.x, q0.ref.y, q0.ref.z)
    const back = r0.offset(-q0.dir.x, 0, -q0.dir.z)
    if (!solidAt(x, r0) && !pending.has(key(r0)) && replaceable(bot.blockAt(r0, false)) && solidAt(x, back)) {
      const pre = { ref: { x: back.x, y: back.y, z: back.z }, dir: q0.dir, y: q0.y, synth: true }
      if (near(pre, e.position)) { st.queue.unshift(pre); stats.synth = (stats.synth || 0) + 1 }
    }
  }
  // Опора клетки не стоит и не появится (её нет в очереди перед ней) — устаревшая запись (путь сменился, отказ).
  st.queue = st.queue.filter((q, i) => {
    if (solidAt(x, new Vec3(q.ref.x, q.ref.y, q.ref.z)) || pending.has(key(q.ref))) return true
    return st.queue.slice(0, i).some(o => cellKey(o) === key(q.ref))
  })
  if (!st.queue.length && n && n.ndBridge) st.queue.push(n.ndBridge) // её клетка уже стоит — идти по ней
  return n
}

// Отрезок моста: первая клетка очереди — ожидание конца поиска, учёт отрезка, клавиши и щелчок.
function bridge (x: BridgeExec, t: Tick, n) {
  const { st, stats, now } = x
  const { e, ns, going, settled } = t
  const br = st.queue[0]
  if (!br) {
    if (going && ns.slice(1, 4).some(q => q && q.ndBridge)) prepare(x)
    finish(x)
    return null
  }
  if (e.isInWater || e.isInLava) return null
  const dir = br.dir
  const ref = new Vec3(br.ref.x, br.ref.y, br.ref.z)
  const cell = ref.offset(dir.x, 0, dir.z)
  // Ждать конца поиска — только над пустотой и не дольше HOLD_MS: pathfinder сам сбрасывает путь «stuck» через
  // 3.5 с без нового узла, и поиск начинается заново — «до конца поиска» не наступало никогда (рельеф, mv-spr-dbg2:
  // цель в 70 бл., у реки тело стояло присев, stuck → тот же частичный путь → goto «застрял» за 27 с). Над водой не
  // ждать вовсе: сорвался — в воду, а мост по частичному пути стоит лишь пары блоков.
  // В воздухе отрезок не начинаем (дальше всё равно «в воздухе — не наше»): иначе ожидание поиска пропускалось,
  // если первый тик отрезка пришёлся на прыжок pathfinder'а у края.
  if (!st.seg && !e.onGround) return null
  if (!st.seg && !settled && !solidAt(x, cell)) {
    const hk = key(cell)
    if (st.holdKey !== hk) { st.holdKey = hk; st.holdT0 = now() }
    if (!br.water && now() - st.holdT0 < HOLD_MS) return hold(x)
    stats.holdGo = (stats.holdGo || 0) + 1
  }
  if (!st.seg) { st.seg = { t0: now(), y0: e.position.y, cells: 0, placed: 0, confirmed: 0, denied: 0, last: null }; stats.segments++ }
  if (st.seg.last !== key(cell)) { st.seg.last = key(cell); st.seg.cells++ }
  // В воздухе — не наше: сорвались — ловит сторож падения (clutch.js), не мешать его клавишам.
  if (!e.onGround) return null
  return bridgeKeys(x, t, n, br, ref, dir, cell)
}

function bridgeKeys (x: BridgeExec, t: Tick, n, br, ref, dir, cell) {
  const { bot, st, stats, pending, hand, log } = x
  const { e, going } = t
  const item = filler(x)
  const refSolid = solidAt(x, ref)
  const cellSolid = solidAt(x, cell)
  if (!cellSolid && (!item || !refSolid)) {
    if (!item) { stats.noItem++; prepare(x) }
    // Стоять на краю присев, пока путь не перестроится.
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
    bot.setControlState('sneak', true)
    const p = e.position
    replan(x, !item ? 'нет блоков в хотбаре' : 'нет опоры', { ref: [ref.x, ref.y, ref.z], cell: [cell.x, cell.y, cell.z], pos: [p.x, p.y, p.z].map(v => Math.round(v * 100) / 100),
      refBlock: (bot.blockAt(ref, false) || {}).name, node: n ? [n.x, n.y, n.z, !!n.ndBridge] : null, queue: st.queue.map(cellKey) })
    return { stop: true }
  }
  const d = decide({ pos: e.position, onGround: e.onGround, ref, dir, cellSolid, refSolid, pending: pending.has(key(cell)) })
  // At the placement window, no visible face means stop before walking off the last real support.
  if (process.env.ND_LAVA_NAV_GUARD === '1' && /nether/.test(String(bot.game?.dimension)) &&
      !cellSolid && d.place && !pending.has(key(cell)) &&
      !x.faceAim(bot, ref, new Vec3(dir.x, 0, dir.z), { eye: e.position.offset(0, EYE, 0), range: 4.5 })) {
    stats.noFace++
    replan(x, 'lava-nav: bridge face not visible', { cell: [cell.x, cell.y, cell.z] })
    return hold(x)
  }
  bot.look(d.yaw, d.pitch, true)?.catch?.(() => {})
  if (!going) {
    // Путь кончился на узле-мосте или сброшен посреди моста (block_updated, chunk_loaded, goal_moved: clearStates=false
    // — клавиши остались нажатыми; ревью Codex): не идти; клетка под нависшим телом — поставить; иначе стоять присев.
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
    bot.jumpQueued = false
    bot.setControlState('sneak', !cellSolid && d.s > -0.6 && !d.place)
    if (d.place && item && !hand.on()) {
      const snap = e.position.clone()
      st.scheduled = () => fire(x, snap, ref, dir, cell, item)
      bot.once('move', st.scheduled)
    }
    if (cellSolid || d.s <= -0.6) { st.queue = []; finish(x) }
    return d
  }
  bot.setControlState('forward', false)
  bot.setControlState('back', true)
  bot.setControlState('left', d.strafe === 'left')
  bot.setControlState('right', d.strafe === 'right')
  bot.setControlState('jump', false)
  // pathfinder в этом же тике мог нажать прыжок (canWalkJump над пустотой): mineflayer запоминает нажатие в
  // jumpQueued, и тело прыгнет, даже если клавишу отпустить (ферма 02.10, mv-gap-dbg3: прыжок с края моста).
  bot.jumpQueued = false
  bot.setControlState('sprint', false)
  bot.setControlState('sneak', false)
  if (d.place && item && hand.on()) stats.handBusy = (stats.handBusy || 0) + 1
  if (d.place && item && !hand.on()) {
    const snap = e.position.clone()
    st.scheduled = () => fire(x, snap, ref, dir, cell, item)
    bot.once('move', st.scheduled)
  }
  if (process.env.ND_DEBUG_BRIDGE && st.seg && (st.seg.dbg = (st.seg.dbg || 0) + 1) <= 40) {
    const p = e.position
    log('тик', { p: [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000), v: [e.velocity.x, e.velocity.y, e.velocity.z].map(v => Math.round(v * 1000) / 1000), g: e.onGround, s: Math.round(d.s * 1000) / 1000, place: d.place, cell: cellKey(br), node: n ? [n.x, n.y, n.z, !!n.ndBridge] : null, q: st.queue.length })
  }
  return d
}

// Тик исполнителя (st.step): фазы по порядку.
function step (x: BridgeExec) {
  const { bot, st, session, deps } = x
  if (st.stopped) return null
  cancelScheduled(x)
  expire(x)
  const ns = nodes(x)
  const e = bot.entity
  if (st.after > 0 && e && !st.seg) logAfter(x, e, ns)
  if (!e || !e.position) { st.queue = []; st.desc = null; finish(x); return null }
  const going = Array.isArray(ns) && ns.length > 0 && moving(x)
  const nd = going ? ns[0] : null
  // Новый мост — не по частичному пути, пока поиск ещё идёт (status 'partial'): по нему тело строило мост в пустоту
  // там, где пути вниз так и не нашлось (mv-mlg-3) — стоять присев у края, пока поиск не кончится. Итог поиска
  // ('success', 'timeout' с лучшим путём) — идти. Спуск не ждёт: на обрыве 20 полный путь не находился за 5 с, и тело
  // стояло наверху 80–90 с (mv-gap-6); мосты в небо теперь отсекает высота цели (goalY).
  const status = deps.status ? deps.status() : (session.lastPath && session.lastPath.status)
  const settled = status !== 'partial'
  const t: Tick = { ns, e, going, nd, settled }
  if (notHere(x, t)) return null
  if (!st.desc && nd && nd.ndDescend) startDesc(x, nd)
  const r = descend(x, t)
  if (r !== undefined) return r
  const n = bridgeQueue(x, t)
  return bridge(x, t, n)
}

export { step }
