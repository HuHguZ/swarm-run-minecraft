'use strict'
// Исполнитель моста и спуска блоками (blockmoves install) — состояние и мелкие действия. Прежние константы и `let`
// замыкания install — поля объекта x (BridgeExec); общее с внешним миром состояние (st: seg, desc, queue, stats, pending,
// счёт перестроек) — как было, в x.st, его же возвращает install. Прежние внутренние функции — функции с x первым
// аргументом. Тик (st.step) — blockmoves/exec-step.ts, подписки и останов — blockmoves/exec.ts.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import { FILLER, EYE, key, replaceable, replanSig, replanCount } from './cells'
import { geometry } from './geometry'

export interface BridgeExec {
  session: any
  deps: any
  bot: any
  faceAim: any
  now: () => number
  hand: any
  bodyClear: typeof import('../navigation/geometry')['bodyClear']
  log: (m: any, o?: any) => void
  stats: any
  pending: Map<string, any>
  st: any
  preparing: boolean
}

function openExec (session, deps, bot): BridgeExec {
  const faceAim = deps.faceAim || (require('../pick') as typeof import('../pick')).faceAim
  const now = deps.now || gameClock.now
  const hand = deps.hand || bot._ndHandLock || { hold () {}, on: () => false, as: fn => fn() }
  const bodyClear = (require('../navigation/geometry') as typeof import('../navigation/geometry')).bodyClear
  const log = deps.log || ((m, o) => console.log('[bridge] ' + m, o ? JSON.stringify(o) : ''))
  const stats: any = { placed: 0, confirmed: 0, denied: 0, timeout: 0, noFace: 0, stale: 0, noItem: 0, segments: 0, fell: 0 }
  const pending = new Map()
  const st: any = { stats, pending, seg: null, scheduled: null, stopped: false, replanAt: 0 }
  return { session, deps, bot, faceAim, now, hand, bodyClear, log, stats, pending, st, preparing: false }
}

const nodes = (x: BridgeExec) => (x.deps.nodes ? x.deps.nodes() : x.session.pathNodes)
const moving = (x: BridgeExec) => { const { bot } = x; try { return !!(bot.pathfinder && bot.pathfinder.isMoving()) } catch { return false } }
const solidAt = (x: BridgeExec, p) => { const b = x.bot.blockAt(p, false); return !!(b && b.boundingBox === 'block') }

// Блок на мост: спидранный наполнитель; на арене (ND_SCAFFOLD_ANY) — и блоки постройки (песчаник, кварц: у ботов Колизея
// других нет — мост по рву не вставал ни разу, стенд 22.10), кроме песка: он падает сквозь воду.
const fillName = (n: string) => FILLER.test(n) || process.env.ND_SCAFFOLD_ANY === '1' && !/^(red_)?sand$/.test(n) && (require('../build') as typeof import('../build')).ARENA_FILLER.test(n)
function filler (x: BridgeExec) {
  const { bot } = x
  const mv = bot.pathfinder && bot.pathfinder.movements
  const ids = new Set((mv && mv.scafoldingBlocks) || [])
  // S1f: в Аду доски на мост не идут (дерево Ада — палки и кирки; s1f-FB-1 «нет безопасного дерева на 4 доски»). ND_BRIDGE_PLANKS=1 — как было.
  const okFill = i => i && fillName(i.name) && !(/_planks$/.test(i.name) && /nether/.test(String(bot.game && bot.game.dimension)) && process.env.ND_BRIDGE_PLANKS !== '1')
  const bar = bot.inventory.slots.slice(36, 45).filter(okFill)
  const sel = bot.inventory.slots[36 + bot.quickBarSlot]
  if (okFill(sel) && (!ids.size || ids.has(sel.type))) return sel
  return bar.find(i => !ids.size || ids.has(i.type)) || bar[0] || null
}
function prepare (x: BridgeExec) {
  const { bot, hand } = x
  if (x.preparing || filler(x) || bot.currentWindow || hand.on()) return
  const mv = bot.pathfinder && bot.pathfinder.movements
  const ids = new Set((mv && mv.scafoldingBlocks) || [])
  const it = bot.inventory.items().find(i => i.slot < 36 && fillName(i.name) && !(/_planks$/.test(i.name) && /nether/.test(String(bot.game && bot.game.dimension)) && process.env.ND_BRIDGE_PLANKS !== '1') && (!ids.size || ids.has(i.type)))
  if (!it) return
  let dest = -1
  for (let i = 36; i <= 44; i++) if (!bot.inventory.slots[i] && i !== 36 + bot.quickBarSlot) { dest = i; break }
  x.preparing = true
  const p = dest >= 0 ? bot.moveSlotItem(it.slot, dest) : bot.equip(it, 'hand')
  Promise.resolve(p).catch(() => {}).finally(() => { x.preparing = false })
}

function silentSet (x: BridgeExec, p, id) {
  const { bot } = x
  try {
    const col = bot.world.getColumnAt(p)
    if (!col) return false
    col.setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), id)
    // Мимо событий мира — кеш блоков pathfinder'а (fastblocks.ts, S9) сбросить самим.
    if (bot._ndFastBlocks) bot._ndFastBlocks.invalidate(p.x, p.y, p.z)
    return true
  } catch { return false }
}
function receipt (x: BridgeExec, p, id) {
  const { bot, pending, stats, st, log } = x
  const k = key(p); const r = pending.get(k)
  if (!r) return
  pending.delete(k)
  // Тот же блок с другим состоянием (базальт/глубинный сланец — ось по грани) — тоже подтверждение (ревью Codex).
  const got = bot.registry.blocksByStateId && bot.registry.blocksByStateId[id]
  if (id === r.stateId || (got && got.name === r.name)) { stats.confirmed++; if (st.seg) st.seg.confirmed++ } else { stats.denied++; if (st.seg) st.seg.denied++; log('отказ сервера', { cell: [r.cell.x, r.cell.y, r.cell.z], got: got ? got.name : id }) }
}
function expire (x: BridgeExec) {
  const { bot, pending, stats, now, deps } = x
  for (const [k, r] of [...pending]) {
    if (now() - r.sentAt < (deps.confirmMs ?? 1500)) continue
    pending.delete(k)
    stats.timeout++
    // Тишина сервера: своё предсказание — назад, уже с событием (pathfinder перестроит путь).
    try { const b = bot.blockAt(r.cell, false); if (b && b.stateId === r.stateId) bot.world.setBlockStateId(r.cell, r.oldStateId) } catch {}
  }
}
function cancelScheduled (x: BridgeExec) {
  const { bot, st } = x
  if (st.scheduled) { bot.removeListener('move', st.scheduled); st.scheduled = null }
}
function finish (x: BridgeExec, recover = true) {
  const { bot, st, stats, now, log } = x
  const s = st.seg
  if (!s) return
  st.seg = null
  const fell = bot.entity && bot.entity.position.y < s.y0 - 0.9
  if (fell) stats.fell++
  if (process.env.ND_DEBUG_BRIDGE) st.after = 30
  log('мост', { cells: s.cells, placed: s.placed, confirmed: s.confirmed, denied: s.denied, ms: now() - s.t0, fell: !!fell, y: bot.entity && Math.round(bot.entity.position.y * 100) / 100, stats })
  // Свои клавиши — отпустить: pathfinder «назад» не трогает никогда, и тело пятилось бы дальше (mv-gap-dbg6).
  try { for (const k of ['back', 'left', 'right']) bot.setControlState(k, false) } catch {}
  // После падения оставшиеся узлы рассчитаны с прежнего пола (W21: y80 → узел y74.875).
  // Отдать pathfinder фактическое положение, сохранив его цель и обычные ограничения перестроек.
  if (fell && recover && !st.stopped && (bot.health ?? 20) > 0 && bot.pathfinder?.goal) replan(x, 'мост: сорвался')
}
function replan (x: BridgeExec, why, info?: any) {
  const { bot, st, now, log } = x
  if (now() - st.replanAt < 1000) return
  // Тот же отказ с того же места — новый поиск даёт тот же путь (s8b-a1-3: «путь не отсюда» узел 87.5,67 при теле 87.7,65 —
  // 62 перестройки подряд, 2.5 мин на месте): после трёх — не перестраивать, решают stuck и goto (ND_BRIDGE_REPLAN3=0 — выкл.).
  const e = bot.entity
  if (replanCount(st, replanSig(why, info), e && e.position) > 3 && process.env.ND_BRIDGE_REPLAN3 !== '0') return
  st.replanAt = now()
  log('перестроить путь', { why, ...info })
  try { bot.pathfinder.setMovements(bot.pathfinder.movements) } catch {}
}
function fire (x: BridgeExec, snap, ref, dir, cell, item) {
  const { bot, st, stats, pending, faceAim, hand, now, log } = x
  st.scheduled = null
  const e = bot.entity
  const skip = (why, extra?: any) => { stats.skip = (stats.skip || 0) + 1; if (process.env.ND_DEBUG_BRIDGE) log('не щёлкнул', { why, cell: [cell.x, cell.y, cell.z], ...extra }) }
  if (!e || e.position.distanceTo(snap) > 1e-7) { stats.stale++; return skip('позиция сменилась', { d: e && e.position.distanceTo(snap) }) }
  if (solidAt(x, cell) || pending.has(key(cell))) return skip('уже стоит')
  const rb = bot.blockAt(ref, false); const cb = bot.blockAt(cell, false)
  if (!rb || rb.boundingBox !== 'block') return skip('нет опоры', { ref: rb && rb.name })
  if (!replaceable(cb)) return skip('клетка занята', { cell: cb && cb.name })
  const face = new Vec3(dir.x, 0, dir.z)
  const eye = e.position.offset(0, EYE, 0)
  const point = faceAim(bot, ref, face, { eye, range: 4.5 })
  if (!point) { stats.noFace++; return skip('грань не видна', { eye: [eye.x, eye.y, eye.z] }) }
  const def = bot.registry.blocksByName[item.name]
  if (!def) return skip('нет блока ' + item.name)
  // Рука — на этот пакет: дольше держать нельзя, следующий блок через ~4.6 тика (230 мс) — свой же замок
  // пропустил бы окно (mv-gap-dbg4: щелчок на s 0.26 вместо 0.05).
  hand.hold(50)
  hand.as(() => {
    const d = point.minus(eye)
    const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    try {
      bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI, onGround: !!e.onGround, flags: { onGround: !!e.onGround, hasHorizontalCollision: !!e.isCollidedHorizontally } })
    } catch {}
    if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
    if (!bot.heldItem || bot.heldItem.name !== item.name) { skip('в руке не блок', { held: bot.heldItem && bot.heldItem.name }); return }
    const rec = { cell: cell.clone(), name: def.name, stateId: def.defaultState, oldStateId: cb.stateId, sentAt: now() }
    const k = key(cell)
    try {
      const sent = bot._genericPlace(rb, face, { delta: point.minus(ref), forceLook: 'ignore', swingArm: 'right' })
      // _genericPlace — async: ошибка записи/руки приходит отказом промиса, уже после предсказания — откатить сразу,
      // а не через 1.5 с тишины (ревью Codex: блок-призрак под ногами).
      Promise.resolve(sent).catch(err => {
        if (pending.get(k) !== rec) return
        pending.delete(k); stats.sendErr = (stats.sendErr || 0) + 1
        log('не отправил', { err: err && err.message })
        try { const b = bot.blockAt(rec.cell, false); if (b && b.stateId === rec.stateId) bot.world.setBlockStateId(rec.cell, rec.oldStateId) } catch {}
      })
    } catch (err) { log('не отправил', { err: err.message }); return }
    pending.set(k, rec)
    silentSet(x, cell, def.defaultState)
    stats.placed++
    if (st.seg) st.seg.placed++
  })
}

// Очередь клеток моста: pathfinder засчитывает узел, когда тело в 0.35 от центра клетки, — а это уже внутри окна
// щелчка (центр за гранью на 0.15–0.3). Узел может «пройти» раньше, чем под ним встал блок: такую клетку
// ставим всё равно, первой (её опора настоящая), и только потом следующую.
const cellKey = (br) => `${br.ref.x + br.dir.x},${br.ref.y},${br.ref.z + br.dir.z}`
function near (br, pos) {
  const g = geometry(pos, br.ref, br.dir)
  return g.s > -1.6 && g.s < 0.6 && Math.abs(g.off) < 1
}

export { openExec, nodes, moving, solidAt, filler, prepare, silentSet, receipt, expire, cancelScheduled, finish, replan, fire, cellKey, near }
