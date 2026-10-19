import * as gameClock from '../game-clock'
import { blockName } from '../moves'
import { stepSafe } from './body'
import { FIX } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Защита от TNT и вагонеток.
export async function boomDefenseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { after, bm, bot, ctl, guard, holdWeapon, itemInputs, pathTo, ready, rest, routeInputs, style, used } = ctx
  const boomSeen = ctx.prof.player ? bm.threat() : null
  const boomThreat = after('boomSeen', !!boomSeen, style.reactMs) ? boomSeen : null
  const boomDefenseInputs = boomThreat && [boomThreat.e?.id, boomThreat.ex?.id, boomThreat.kind, routeInputs(), !!guard?.stats?.worn, itemInputs(/obsidian|cobblestone|bucket$/)].join('|')
  if (boomThreat && (!ctx.failedBoomDefense || ctx.failedBoomDefense.inputs !== boomDefenseInputs)) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    ctx.aim = 'free'
    let howB = null
    try { howB = await bm.defend(ctl, boomThreat, { stepSafe: dir => stepSafe(bot, dir) }) } catch {}
    ctx.aim = 'target'
    ctx.failedBoomDefense = howB ? null : { inputs: boomDefenseInputs, why: 'defense_unavailable' }
    if (howB) {
      if (ready('boomNote:' + howB.slice(0, 20))) { rest('boomNote:' + howB.slice(0, 20), 2500); used(howB) }
      await holdWeapon()
      return NEXT
    }
  }
}

// Кристаллы и якоря: план и исполнение.
export async function crystalTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { GRAPH, after, bot, clear, cx, guard, heldName, holdWeapon, itemInputs, noteExchange, noteGate, noticed, pathTo, ready, rest, routeInputs, style, switched, used } = ctx
  const { me, pressing } = turn
  if (ctx.prof.player && blockName(bot, me.floored()) !== 'cobweb' && !ctx.perch && !ctx.fort && cx.engaged()) {
    const ca0 = cx.plan({ vel: ctx.track.vel(), press: pressing })
    // Кристалл/якорь — расходник: калькулятор нашёл дешёвое добивание (удар/выстрел, худший исход попадания > верха
    // оценки его хп) — взрывчатку не тратим (kill-planner: «кулак добивает — кристалл не тратим»).
    const cheapKill = GRAPH && ctx.gp && ctx.gp.plan && /^добиваю/.test(ctx.gp.plan.why || '') && !/^(crystal|anchor)$/.test(ctx.gp.plan.action.kind)
    const ca = ca0 && /^(place|place-hit|place-shoot|anchor|obby)$/.test(ca0.kind) && cheapKill ? (noteGate('кристалл: добиваю дешевле'), null) : ca0
    const react = !ca || !/^(defuse|dodge|shield|cover|wall|anchorPop)$/.test(ca.kind) || after('crystalSeen', true, style.reactMs)
    if (!ca) delete noticed.crystalSeen
    const crystalInputs = ca && [ca.kind, ca.c?.id, ca.cell, ca.base, ca.spot?.base, routeInputs(), itemInputs(/end_crystal|respawn_anchor|glowstone|obsidian|apple$|experience_bottle/), !!bot._ndUse?.cur].join('|')
    if (ca && react && (!ctx.failedCrystal || ctx.failedCrystal.inputs !== crystalInputs) && (!turn.punishAfterRecovery || ca.kind !== 'eat')) {
      if (guard && ca.kind !== 'shield') await guard.raise(false)
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      clear()
      ctx.aim = 'free'
      const beforeC = heldName()
      const rc = await runCrystalAction(ctx, ca)
      ctx.aim = 'target'
      clear()
      switched(beforeC)
      if (rc && rc.note && ready('cxNote:' + ca.kind)) { rest('cxNote:' + ca.kind, 1500); used(rc.note) }
      if (!rc || !rc.keepItem) await holdWeapon()
      ctx.failedCrystal = rc?.ok ? null : { inputs: crystalInputs, why: rc?.why || rc?.note || 'crystal_action_unconfirmed' }
      if (/^(hit|shoot|place-hit|place-shoot)$/.test(ca.kind) && rc && rc.ok) noteExchange()
      return NEXT
    }
  }
}

// Передача ветке кристаллов: еда, затем защита — по очереди, не внахлёст; метка блоков (block-log) на время действия.
export async function runCrystalAction (ctx: DuelCtx, ca) {
  const { bot, ctl, cx, maceNow, style } = ctx
  let rc = null
  // Учёт блоков (block-log): что ставит/ломает ветка кристаллов — по виду плана.
  const CXT = { obby: 'обсидиан под кристалл', surround: 'обсидиан вокруг ног', wall: 'заслон от взрыва (блок между)', cover: 'укрытие от взрыва', anchor: 'якорь у его ног', place: 'кристалл', 'place-hit': 'кристалл', 'place-shoot': 'кристалл' }
  bot._ndBlockTag = CXT[ca.kind] ? { what: CXT[ca.kind], at: gameClock.wall.now() } : null
  const cxCtx = { stepSafe: dir => stepSafe(bot, dir), stop: () => FIX && maceNow(), reactMs: style.reactMs }
  try {
    rc = await cx.run(ctl, ca, cxCtx)
    if (rc?.defense && !ctl.aborted && !cxCtx.stop()) {
      const defense = rc.defense
      const eatNote = rc.note
      bot._ndBlockTag = CXT[defense.kind] ? { what: CXT[defense.kind], at: gameClock.wall.now() } : null
      rc = await cx.run(ctl, defense, cxCtx)
      rc.note = [eatNote, rc.note].filter(Boolean).join('; ')
    }
  } catch (e) { rc = { note: 'кристаллы: ' + e.message } } finally { bot._ndBlockTag = null }
  return rc
}

// Взрывчатка в него.
export async function boomOffenseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bm, bot, clear, ctl, guard, heldName, holdWeapon, itemInputs, maceNow, pathTo, routeInputs, switched, used } = ctx
  const { blocking, d, inWeb, me, meInWeb, theyEat } = turn
  if (ctx.prof.player && !meInWeb && !ctx.perch && !ctx.fort) {
    const vB = ctx.track.vel()
    const closingB = (vB.x * (me.x - ctx.entity.position.x) + vB.z * (me.z - ctx.entity.position.z)) / Math.max(d, 0.1)
    const bp = bm.plan({ closing: closingB, busy: !!(theyEat || inWeb || blocking) })
    const boomInputs = bp && [bp.kind, bp.ex?.id, bp.spot?.base, bp.spot?.cell, routeInputs(), itemInputs(/tnt|rail|end_crystal|obsidian|flint_and_steel/)].join('|')
    if (bp && (!ctx.failedBoom || ctx.failedBoom.inputs !== boomInputs)) {
      if (guard) await guard.raise(false)
      pathTo(false); ctx.pathing = false
      clear()
      ctx.aim = 'free'
      const beforeB = heldName()
      let rb = null
      try { rb = await bm.run(ctl, bp, { stepSafe: dir => stepSafe(bot, dir), stop: () => FIX && maceNow() }) } catch (e) { rb = { note: 'взрывчатка: ' + e.message } }
      ctx.aim = 'target'
      clear()
      switched(beforeB)
      ctx.failedBoom = rb?.ok ? null : { inputs: boomInputs, why: rb?.why || rb?.note || 'blast_action_unconfirmed' }
      if (rb && rb.note) used(rb.note)
      await holdWeapon()
      return NEXT
    }
  }
}
