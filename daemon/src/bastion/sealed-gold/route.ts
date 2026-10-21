'use strict'
// Штрек к золоту бастиона (sealedGold) — план штрека к целям оборота и ход по нему: старт из своего хода или снаружи,
// вход со вскрытием, закапывание, путь ко входу ногами, исполнение плана. Порядок — SG_STEPS в bastion/sealed-gold.ts.
import { log, sleep, xyz, mobs, goals, gameClock, angerSet, Vec3 } from '../take-gold-block'
import { walkUnlessBrute } from '../booth-trade'
import { burrow, sealBody } from '../defense'
import { type SealedRun, type SealTick, type Turn, routeRetryAt } from './state'

// План штрека: вслепую — мир по шаблону гипотез (видимое — как есть, скрытое — символ куска), иначе — живой мир.
function planView (bot, st) {
  if (!(require('../../nether-cover') as typeof import('../../nether-cover')).blind()) return (require('../../sealed') as typeof import('../../sealed')).worldView(bot, st.sealedState)
  const TV: typeof import('../template-view') = require('../template-view')
  return TV.templateView(bot, TV.piecesOf(st), st.sealedState)
}

// Столб под ногами (видимые клетки: блок, вокруг — воздух с четырёх сторон) — копать вниз по одному, пока под ногами столб и ниже
// не лава; до 16 блоков. true — спустились хоть на блок.
async function downPillar (bot, ctl) {
  const SL: typeof import('../../sealed') = require('../../sealed')
  const eyes: typeof import('../../perception/eyes') = require('../../perception/eyes')
  const air = p => { const b = eyes.seesNow(bot, p) ? bot.blockAt(p, false) : null; return !!b && SL.classOf(b) === SL.AIR }
  const pillar = f => {
    const u = f.offset(0, -1, 0); const b = bot.blockAt(u, false)
    if (!b || b.boundingBox !== 'block' || !bot.entity.onGround) return false
    const lava = bot.blockAt(u.offset(0, -1, 0), false)
    if (!lava || /lava|fire/.test(lava.name)) return false
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => air(u.offset(dx, 0, dz)))
  }
  let n = 0
  for (; n < 16 && !ctl.aborted; n++) {
    const f = SL.bodyCells(bot)[0]
    if (!pillar(f)) break
    const y0 = bot.entity.position.y
    if (await SL.digCell(bot, f.offset(0, -1, 0)) !== 'ok') break
    for (let k = 0; k < 20 && bot.entity.position.y > y0 - 0.9; k++) await sleep(50)
    if (bot.entity.position.y > y0 - 0.9) break
  }
  if (n) log('штрек: вниз по столбу', { blocks: n, at: xyz(bot.entity.position.floored()) })
  return n > 0
}

// Repeating a physical failure is no new evidence. Defer only goals reached by this plan.
export function noteRouteStop (sg: SealedRun, tk: SealTick, r: any, ex: any, from: any, at: any, targets?: string[]) {
  if (process.env.ND_SEALED_OPENING_MEMORY !== '1') return
  const { S, st, ctl } = sg
  if (ex.ok || ctl.aborted || from.x !== at.x || from.y !== at.y || from.z !== at.z || at.dug > from.dug) {
    S.openingRetry = null
    return
  }
  const end = r.path.length ? r.path[r.path.length - 1].to : r.start
  const reached = (targets || tk.tgGoals.filter(q => q.g(end.x, end.y, end.z)).map(q => q.t.k)).slice().sort()
  const cell = p => [p.x, p.y, p.z]
  const key = JSON.stringify([cell(r.start), r.path.map(m => [m.kind, cell(m.to), m.clear.map(cell)]), ex.why, reached])
  const count = S.openingRetry?.key === key ? S.openingRetry.count + 1 : 1
  S.openingRetry = { key, count }
  if (count < 3 || !reached.length) return
  // Finite deferral also survives another RPC; ND_NE_RECOVER's Infinity is RPC-local.
  const until = gameClock.now() + 10 * 60000
  const skipped = S.openingSkips || (S.openingSkips = new Map())
  for (const [k, t] of skipped) if (t <= gameClock.now()) skipped.delete(k)
  for (const k of reached) { st.skip.set(k, until); skipped.set(k, until) }
  log('штрек: повтор стопа — цель отложена', { count, why: ex.why, targets: reached, seconds: 600 })
}

// ND_BASTION_HYP_FOCUS: ноги штрека не ниже y33 — пол бастиона y32, под ним море лавы y31 (nbf53-5408: штрек к гнезду стены ушёл на y30,
// торг из него вскрыл лаву — смерть с 108 слитками). Цели и старт ниже 33 — прежний нижний край.
const lowY = ys => process.env.ND_BASTION_HYP_FOCUS !== '0' && Math.min(...ys) >= 33 ? 33 : 5

export async function sgRoute (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { bot, session, ctl, st, S, SL } = sg
  const view = planView(bot, st)
  S.view = S.honest ? view : null
  // S1f: клетка ног — с поправкой на песок душ (высота 0.875: на нём floored() — клетка самого песка). План от floored() начинался
  // внутри пола: «не шагнул vdown/up … (я …,N.88,…) пол soul_sand» — 50 из 61 остановок штрека во вслепую сериях S1e/S1f, заход с 0
  // золота при верном шаблоне. ND_SOUL_FEET=0 — прежнее.
  const feet = () => process.env.ND_SOUL_FEET === '0' ? bot.entity.position.floored() : SL.bodyCells(bot)[0]
  tk.feet = feet
  const me = feet()
  let starts
  const inTunnel = S.own.has(SL.keyV(me)) && !S.exposed
  if (inTunnel) starts = [{ x: me.x, y: me.y, z: me.z, g: 0 }]
  else {
    // Из открытого: клетки заливки; у брута и хоглина (10 блоков) — дороже.
    const danger = [...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].map((e : any) => e.position)
    starts = []
    let startView: Pick<typeof view, 'cls'> = view
    if (S.honest && process.env.ND_BASTION_OBSERVED_ENTRY === '1') {
      const eyes: typeof import('../../perception/eyes') = require('../../perception/eyes')
      const known = new Map<string, number>()
      startView = { cls: (x, y, z) => {
        const k = SL.key(x, y, z)
        if (!known.has(k)) {
          const p = new Vec3(x, y, z)
          known.set(k, eyes.seesNow(bot, p) ? SL.classOf(bot.blockAt(p, false)) : SL.UNKNOWN)
        }
        return known.get(k)!
      } }
    }
    for (const n of SL.reachCells(startView, process.env.ND_SOUL_FEET === '0' ? bot.entity.position : me, { radius: 28, maxNodes: 5000 })) {
      if (S.badStarts && S.badStarts.has(SL.key(n.x, n.y, n.z))) continue
      let g = n.d * 4
      for (const d of danger) { const dd = d.distanceTo(new Vec3(n.x, n.y, n.z)); if (dd < 10) g += (10 - dd) * 4 }
      starts.push({ x: n.x, y: n.y, z: n.z, g })
    }
    if (S.own.has(SL.keyV(me))) starts.push({ x: me.x, y: me.y, z: me.z, g: 0 })
  }
  tk.tgGoals = tk.tg.map(t => ({ t, rank: process.env.ND_BASTION_GOLD_EVIDENCE === '1' ? (t.rank || 0) : tk.minRank, g: SL.adjacentGoal(t.pos, view.cls), h: SL.manhattan(t.pos) }))
  if (!st.predAll) st.predAll = [...st.pred.values()].map(v => ({ rank: v.rank || 0, pos: v.pos.clone() }))
  const xs = [...starts.map(s => s.x), ...tk.tg.map(t => t.pos.x)]
  const ys = [...starts.map(s => s.y), ...tk.tg.map(t => t.pos.y)]
  const zs = [...starts.map(s => s.z), ...tk.tg.map(t => t.pos.z)]
  const box = { x0: Math.min(...xs) - 14, x1: Math.max(...xs) + 14, y0: Math.max(lowY(ys), Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 12), z0: Math.min(...zs) - 14, z1: Math.max(...zs) + 14 }
  const t0 = gameClock.wall.now()
  const planO = {
    cls: view.cls, dig: view.dig, own: S.own, starts, box, maxNodes: inTunnel ? 60000 : 160000,
    goal: (x, y, z) => tk.tgGoals.some(q => q.g(x, y, z)),
    h: (x, y, z) => Math.min(...tk.tgGoals.map(q => q.h(x, y, z))),
    targets: new Set(tk.tg.filter((t : any) => !t.chest).map(t => t.k)), vup: SL.fillerCount(bot) >= 6, vdown: !S.honest
  }
  let r = await SL.plan(planO)
  // Price the approach per remaining predicted block in a compact known cluster.
  // Keep the existing path if the alternative is dearer or physically impossible.
  if (process.env.ND_BASTION_FIRST_GOLD === '1' && S.honest && r.ok) {
    const endpoint = r.path.length ? r.path[r.path.length - 1].to : r.start
    const current = tk.tgGoals.find(q => q.g(endpoint.x, endpoint.y, endpoint.z))?.t
    const groupKey = t => {
      const v = st.pred.get(t.k), c = v?.wall
      return c ? `${c.piece}|${c.r}|${c.t.x},${c.t.y},${c.t.z}` : t.k
    }
    const amount = t => tk.tg.filter(q => !q.chest && groupKey(q) === groupKey(t))
      .reduce((n, q) => n + (st.pred.get(q.k)?.wall?.p ?? 1), 0)
    const preferred = tk.tg.filter(t => !t.chest && /^(bridge\/bridge_pieces\/bridge|treasure\/entrances\/entrance_0)$/.test(st.pred.get(t.k)?.piece || ''))
    const knownType = st.entryRoute?.start?.type
    if (current && !current.chest && (knownType === 'bridge' || knownType === 'treasure') && preferred.length) {
      const groups = new Map<string, any>()
      for (const t of preferred) if (!groups.has(groupKey(t))) groups.set(groupKey(t), t)
      for (const t of groups.values()) {
        const goals = tk.tgGoals.filter(q => groupKey(q.t) === groupKey(t))
        if (groupKey(current) === groupKey(t)) continue
        const first = await SL.plan({ ...planO,
          goal: (x,y,z) => goals.some(q => q.g(x,y,z)),
          h: (x,y,z) => Math.min(...goals.map(q => q.h(x,y,z))) })
        const price = first.ok ? first.cost / Math.max(1, amount(t)) : Infinity
        const normal = r.cost / Math.max(1, amount(current))
        log('штрек: цена первого золота', { piece: st.pred.get(t.k)?.piece, gold: amount(t), price, normal, ok: first.ok })
        if (price < normal) { r = first; break }
      }
    }
  }
  // Вход из открытой пещеры: первая клетка в толще почти всегда касается воздуха пещеры сбоку (неровная стена), и
  let entryBreach = null
  // ND_ANGER_SAFE=1: золото сломано меньше 30 с назад (злость пиглинов — 600 тиков), злые в 16 — не вскрывать ход во двор,
  // а переждать заложившись (D7s9c-31 03.10: золото в закрытом ходе, следом «вход со вскрытием» — пиглины, смерть).
  if (!r.ok && st.breach && process.env.ND_ANGER_SAFE === '1' && st.lastBreak && gameClock.now() - st.lastBreak < 30000 && angerSet(bot, null, false).length) {
    log('штрек: злость после золота — вскрытие подожду', { s: Math.round((gameClock.now() - st.lastBreak) / 1000), n: angerSet(bot, null, false).length })
    await sealBody(bot, S).catch(() => null)
    while (!ctl.aborted && gameClock.now() - st.lastBreak < 31000) await sleep(500)
  }
  if (!r.ok && st.breach && (starts.length || tk.tg.length)) {
    const near = new Set()
    const around = (p, dyLo, dyHi) => { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) for (let dy = dyLo; dy <= dyHi; dy++) near.add(SL.key(p.x + dx, p.y + dy, p.z + dz)) }
    if (!inTunnel) for (const st0 of starts.slice().sort((a, b) => a.g - b.g).slice(0, 300)) around(st0, -1, 3)
    for (const t of (tk.tg as any)) if (!t.chest) around(t.pos, -2, 2)
    entryBreach = ck => near.has(ck)
    const r2 = await SL.plan({ ...planO, breachOk: (ck) => entryBreach(ck), breachCost: 8 })
    log('штрек: вход из открытого со вскрытием', { ok: r2.ok, nodes: r2.nodes, why: r2.ok ? undefined : r2.why, starts: starts.length, from: inTunnel ? 'штрек' : 'снаружи' })
    if (r2.ok) r = r2
    else entryBreach = null
  }
  S.plans++
  S.planMs += gameClock.wall.now() - t0
  // ND_BASTION_HYP_FOCUS: тело на столбе (вышка обзора, прерванная тактикой: nbf48-5408 — 20 мин на столбе y73–76 у бастиона,
  // каждый вызов «пути нет» за 1 с) — сперва вниз по своему столбу до земли: столб — клетки 1×1 с воздухом с четырёх сторон.
  if (!r.ok && !inTunnel && process.env.ND_BASTION_HYP_FOCUS !== '0' && await downPillar(bot, ctl)) return 'next'
  // Снаружи пути нет (все входы касаются чужого воздуха) — закопаться и планировать из своего кармана.
  if (!r.ok && !inTunnel && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
    st.burrowsSG = (st.burrowsSG || 0) + 1
    const bw = await burrow(session, ctl, st, 'штрек к золоту снаружи не начался')
    if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; return 'next' }
    log('закопаться не вышло', { why: bw.why })
  }
  if (!r.ok) {
    log('штрек: пути нет', { targets: tk.tg.length, rank: tk.minRank, nodes: r.nodes, why: r.why, from: inTunnel ? 'штрек' : 'снаружи', ms: gameClock.wall.now() - t0 })
    // Нет пути ни к одной цели этого ранга — отложить их; из штрека попробовать снаружи.
    for (const t of tk.tg) st.skip.set(t.k, routeRetryAt(10 * 60000))
    if (++sg.noPlan >= 3) return 'stop'
    return 'next'
  }
  log('штрек: план', { from: r.start, moves: r.path.length, dig: r.path.reduce((n, m) => n + m.clear.length, 0), cost: Math.round(r.cost), nodes: r.nodes, ms: gameClock.wall.now() - t0 })
  // Без золотой брони ко входу по открытому не идти (пиглины видят — бьют): закопаться здесь и планировать из своего кармана.
  if (!inTunnel && st.goldless && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z) && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
    st.burrowsSG = (st.burrowsSG || 0) + 1
    const bw = await burrow(session, ctl, st, 'без золотой брони ко входу штрека по открытому не иду')
    if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; return 'next' }
    log('закопаться не вышло', { why: bw.why })
  }
  // Вход из открытого — сперва дойти ногами (без копки) до клетки входа.
  if (!inTunnel && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z)) {
    S.walks++
    // Пол Ада для pathfinder (worlds: не ниже min(40, где стоишь)) — опустить до входа, иначе «пустой путь».
    const floor0 = bot._ndNetherFloor
    bot._ndNetherFloor = Math.min(floor0 ?? 40, r.start.y - 2)
    let w
    try { w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r.start.x, r.start.y, r.start.z), 30000, { dig: false }) } finally { bot._ndNetherFloor = floor0 }
    const f = feet()
    if (!(f.x === r.start.x && f.y === r.start.y && f.z === r.start.z)) {
      // Этот вход ногами не взять — в следующих планах его нет (sealed booth-1: 15 раз «пустой путь» к одной клетке).
      (S.badStarts || (S.badStarts = new Set())).add(SL.key(r.start.x, r.start.y, r.start.z))
      S.fails.push(`ко входу: ${(w && w.error) || 'не дошёл'}`); if (S.fails.length > 14) return 'stop'
      // Пешком не выйти ни к одной клетке входа (тело в яме после спуска со столба, у злых пиглинов
      S.walkFails = (S.walkFails || 0) + 1
      if (S.walkFails >= 2) { for (const v of [f, f.offset(0, 1, 0)]) S.own.add(SL.keyV(v)); S.exposed = true }
      return 'next'
    }
    S.exposed = true
  }
  if (!inTunnel) S.entry = { x: r.start.x, y: r.start.y, z: r.start.z }
  const prevBreach = S.breachOk
  if (entryBreach) S.breachOk = (k, nk) => entryBreach(k) || !!(prevBreach && prevBreach(k, nk))
  const before = process.env.ND_SEALED_OPENING_MEMORY === '1' ? { ...feet(), dug: S.dug } : null
  const end = r.path.length ? r.path[r.path.length - 1].to : r.start
  // adjacentGoal can read the view: execute may change it while revealing a hole.
  const openingTargets = before ? tk.tgGoals.filter(q => q.g(end.x, end.y, end.z)).map(q => q.t.k) : undefined
  let ex
  try { ex = await SL.execute(session, ctl, r.path, S) } finally { if (entryBreach) S.breachOk = prevBreach }
  if (before) noteRouteStop(sg, tk, r, ex, before, { ...feet(), dug: S.dug }, openingTargets)
  if (!ex.ok) {
    // ND_BASTION_HYP_FOCUS: стоп о впервые увиденный воздух (пещера Ада у стены, ход бастиона) — новое знание для следующего плана,
    // а не провал: nbf45-5408 — верная гипотеза, 15 таких стопов за 14 с, и заход кончился («золото по шаблону осталось (33)»).
    const cell = /^(вскрою )?чужой воздух (-?\d+,-?\d+,-?\d+)|^новый проём после вскрытия у (-?\d+,-?\d+,-?\d+)/.exec(ex.why || '')
    const fresh = process.env.ND_BASTION_HYP_FOCUS !== '0' && cell && !(S.stopCells ||= new Set()).has(cell[2] || cell[3]) && (S.infoStops || 0) < 150
    if (fresh) { S.stopCells.add(cell[2] || cell[3]); S.infoStops = (S.infoStops || 0) + 1 } else S.fails.push(ex.why)
    log('штрек: стоп', { why: ex.why, done: ex.done, of: r.path.length, at: xyz(bot.entity.position.floored()), ...(fresh ? { info: S.infoStops } : {}) })
    if (S.fails.length > 14) return 'stop'
    return 'next'
  }
}

export { planView }
