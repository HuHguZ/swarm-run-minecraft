import { pickFiller } from '../build'
import { keyDir } from '../moves'
import * as tempo from '../tempo'
import * as totemMod from '../totem'
import { hasEffect, reachFrom, stepSafe } from './body'
import { counterattackAfterFailedEscape } from './last-stand'
import { countOf, findItem, findPotion } from './potions'
import { EYE, FIX, TICK_MS } from './rules'
import { Vec3 } from './vec3'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Общая безопасность велит уйти; стратегическая пауза.
export async function safetyTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, duo, escapePearl, finish, guard, holdWeapon, pathTo, releaseFightItems, seesNow, session, st, strategicRequest, tt, used, util } = ctx
  const { arenaStay, flightRecovery, hp, safeMedical, safety } = turn
  if (!arenaStay && !flightRecovery && !(ctx.lastStand && safety.action !== 'dead' && !safety.hazard) && safety.action !== 'fight' && (safety.action !== 'recover' || !safeMedical)) {
    pathTo(false); ctx.pathing = false; clear(); ctx.aim = 'free'
    if (guard) await guard.raise(false)
    const escapeFrom = bot.entity.position.clone()
    let escape = null
    if (safety.action !== 'dead' && ctx.prof.player) {
      const chorus = await util.chorusMaybe(ctl, { hp, foes: duo.foes(), trapped: null,
        pearls: countOf(bot, 'ender_pearl'), canHeal: safety.healable,
        pearlAt: safety.threshold, burst: totemMod.burstOf(bot, ctx.entity) })
      if (chorus?.ok) escape = { clear: true, how: 'уход хорусом', chorus }
      else escape = await escapePearl()
    }
    ctx.aim = 'free'
    if (safety.action !== 'dead' && !escape?.clear) escape = await require('../combat-safety').disengage(session, ctl, tt.threats)
    if (counterattackAfterFailedEscape({ alive: (bot.health ?? 0) > 0, interrupted: ctl.aborted,
      clear: !!escape?.clear, hazardous: !!safety.hazard, targetVisible: seesNow(),
      targetReach: reachFrom(bot.entity.position.offset(0, EYE, 0), ctx.entity), moved: bot.entity.position.distanceTo(escapeFrom) })) {
      ctx.lastStand = true
      st.failedEscapeCounter = (st.failedEscapeCounter || 0) + 1
      used('выход заблокирован — защищаюсь ударами')
      ctx.aim = 'target'
      await holdWeapon()
      if (guard) await guard.wear()
      return NEXT
    }
    used('общая безопасность: ' + safety.reason)
    return { end: finish({ lowHealth: safety.action !== 'dead', safety, escape, health: bot.health }) }
  }
  // A request is data, not cancellation. Awaited skills have returned here;
  // airborne recovery and water pickup retain the body until they finish.
  if (strategicRequest()) {
    const oldAim = ctx.aim
    ctx.aim = 'free'
    try { await releaseFightItems() } finally { ctx.aim = oldAim }
    // Item cleanup can await the server. Keep the duel's watchers alive until
    // the body and the current quote have both been checked after that await.
    const request = strategicRequest()
    if (request) return { end: finish({ stopped: 'strategic preparation', strategicYield: request }, true) }
    return NEXT
  }
}

// Отход из радиуса взрыва.
export async function blastRetreatTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { blastRetreat, bot, clear, holdWeapon, maceNow, pathTo, set } = ctx
  const { me } = turn
  const activeBlast = blastRetreat()
  if (activeBlast && !maceNow() && (activeBlast.inFlight || Math.abs(me.y - activeBlast.at.y) < 3 && Math.hypot(me.x - activeBlast.at.x, me.z - activeBlast.at.z) < activeBlast.radius + .3)) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    const away = p => Math.hypot(p.x - activeBlast.at.x, p.z - activeBlast.at.z)
    const exits = ['back', 'left', 'right', 'forward'].filter(k => stepSafe(bot, keyDir(bot, k)))
      .map(k => ({ k, d: away(me.plus(new Vec3(keyDir(bot, k).x, 0, keyDir(bot, k).z))) }))
      .filter(k => k.d > away(me)).sort((a, b) => b.d - a.d)
    if (exits.length || activeBlast.inFlight) {
      clear(); if (exits[0]) set(exits[0].k, true)
      await holdWeapon(); await ctx.sleep(TICK_MS); return NEXT
    }
  }
}

// Мало хп: отступление, хорус, жемчуг, столб.
export async function lowHpTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ctl, duo, escapePearl, finish, holdWeapon, itemInputs, perchHeight, pillarOut, retreatAtHealth, routeInputs, st, tt, util } = ctx
  const { d, hp, meInWeb, theyBow, webSafe } = turn
  const canHeal = turn.canHeal = !!(findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
    findItem(bot, i => /golden_apple$/.test(i.name)))
  if (!ctx.lastStand && !ctx.prof.player && hp <= retreatAtHealth && !canHeal) {
    return { end: finish({ lowHealth: true, health: Math.round(hp) }) }
  }
  const chorusInputs = [routeInputs(), itemInputs(/chorus_fruit|trident|ender_pearl/), !!meInWeb, !!ctx.myPit, !!canHeal, !!bot.entity.isInWater].join('|')
  if (!ctx.lastStand && ctx.prof.player && hp <= Math.max(retreatAtHealth, 9) && (!ctx.failedChorus || ctx.failedChorus.inputs !== chorusInputs)) {
    ctx.aim = 'free'
    const cr = (await util.chorusMaybe(ctl, { hp, foes: duo.foes(), trapped: meInWeb && !webSafe ? 'паутина' : ctx.myPit ? 'яма' : null, pearls: countOf(bot, 'ender_pearl'), canHeal, pearlAt: Math.max(retreatAtHealth, 9), burst: totemMod.burstOf(bot, ctx.entity) })) ||
      (hp <= 6 && duo.foes().length >= 2 ? await util.riptideAway(duo.foes(), ctl) : null)
    ctx.aim = 'target'
    ctx.failedChorus = cr?.ok ? null : { inputs: chorusInputs, why: cr?.why || 'chorus_escape_unavailable' }
    if (cr && cr.ok) { await holdWeapon(); return NEXT }
  }
  const pearlAt = Math.max(retreatAtHealth, 9)
  const pearlForSpace = tempo.ON && ctx.prof.player && canHeal && !tt.safe(tempo.consumeMs('golden_apple')).ok && !(FIX && (st.pearlSpace || 0) >= 2)
  if (!ctx.lastStand && ctx.prof.player && hp <= pearlAt && hp > 6 && (!canHeal || pearlForSpace)) {
    const pearl = findItem(bot, i => i.name === 'ender_pearl')
    if (pearl) {
      const r = await escapePearl()
      if (r && r.thrown) {
        if (pearlForSpace) { st.pearlSpace = (st.pearlSpace || 0) + 1; await holdWeapon(); return NEXT }
        const f = pickFiller(bot)
        if (!f || countOf(bot, f.name) < perchHeight()) {
          return { end: finish({ retreated: true, mode: 'ушёл жемчугом', health: Math.round(bot.health ?? 0) }) }
        }
        await holdWeapon()
        return NEXT
      }
    }
  }

  if (!ctx.lastStand && ctx.prof.player && !ctx.perch && hp <= pearlAt && !canHeal && d > 12 && !theyBow) {
    if (await pillarOut()) return NEXT
  }
}

// На столбе: держаться или спуститься.
export async function perchTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, dropFromPerch, rangedAllowed, used, vision } = ctx
  const { canHeal, hp } = turn
  if (ctx.perch) {
    const noArrows = !findItem(bot, i => /arrow$/.test(i.name)) || !findItem(bot, i => i.name === 'bow' || i.name === 'crossbow')
    if (bot.entity.position.y < ctx.perch.top - 1.2) {
      ctx.perch = null
      used('сбили со столба')
    } else {
      const maxHp = bot.entity.attributes?.['minecraft:max_health']?.value ?? 20
      const healingHere = hp < maxHp && (canHeal || (bot.food ?? 0) >= 18 || hasEffect(bot, 'regeneration'))
      const rangedHere = !noArrows && rangedAllowed() && vision.visible(ctx.entity)
      if (!healingHere && !rangedHere) {
        const r = await dropFromPerch()
        if (r.ok || r.acted) return NEXT
      }
    }
  }
}
