import * as gameClock from '../game-clock'
import * as mace from '../mace'
import { blockName } from '../moves'
import * as pick from '../pick'
import { reachFrom } from './body'
import { findItem } from './potions'
import { HIT_REACH } from './rules'
import { crowdTurn } from './turn-crowd'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Моб бьёт или идёт на меня — сперва его.
export async function mobDetourTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { holdWeapon, mobThreat, pathTo, retarget, used } = ctx
  const { heOut, meOut, now, r } = turn
  if (ctx.prof.player && !ctx.mobDetour && now >= ctx.mobCheckAt) {
    ctx.mobCheckAt = now + 250
    const m = mobThreat()
    if (m && (r > HIT_REACH + 1.5 || meOut || heOut || (m.e.name === 'creeper' && m.dist < 3.5))) {
      ctx.mobDetour = { back: ctx.entity, at: now, seenAt: now, name: m.e.name }
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      retarget(m.e)
      used(`${m.e.name} ${m.hitting ? 'бьёт меня' : 'идёт на меня'} — сперва его`)
      await holdWeapon()
      return NEXT
    }
  }
}

// Один против двух: фокус, сброс, паутина, рывок.
export async function duoTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, duo, guard, holdWeapon, maceChain, mc, mf, pathTo, retarget, st, telemetryHp, throwAt, used, windInputs } = ctx
  const { hp, me, now } = turn
  // Трое и больше — бой против толпы (turn-crowd): цель, зелье в кучу, уход из клещей; приёмы двоих — не здесь.
  const crowd = await crowdTurn(ctx, turn)
  if (crowd || ctx.crowd?.on) return crowd
  if (ctx.prof.player && duo.active()) {
    const dz = duo.decide({ entity: ctx.entity, charge: mf.clock.charge(0), justSwung: now - ctx.lastSwing < 250, hp, hasAxe: !!findItem(bot, i => /_axe$/.test(i.name)), meInWeb: blockName(bot, me.floored()) === 'cobweb', perch: !!ctx.perch, fort: !!ctx.fort, cooldownLeft: mf.clock.leftMs(1) })
    if (dz && dz.kind === 'focus' && dz.e !== ctx.entity) { duo.switched(ctx.entity, dz.e, dz.why); retarget(dz.e); await holdWeapon(); await new Promise<any>(resolve => setImmediate(resolve)); return NEXT }
    if (dz && dz.kind === 'reset') { if (ctx.pathing) { pathTo(false); ctx.pathing = false } clear(); const rr = await duo.runReset(ctl, dz); if (rr.pick && rr.pick !== ctx.entity) retarget(rr.pick); return NEXT }
    if (dz && dz.kind === 'web' && (await duo.webSecond(dz.e))) return NEXT
    const bz = duo.burst({ hp, meInWeb: blockName(bot, me.floored()) === 'cobweb', perch: !!ctx.perch, fort: !!ctx.fort })
    if (bz) {
      if (bz.e !== ctx.entity) { duo.switched(ctx.entity, bz.e, bz.why); retarget(bz.e) }
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      if (bz.kind === 'harm') {
        if (guard) await guard.raise(false)
        if (await throwAt(bz.item, '1 против 2: ' + bz.why, { minLand: 3.3 })) { await holdWeapon(); return NEXT }
        duo.burstFailed('harm')
      } else if (bz.kind === 'smash' && (!ctx.failedSmash || ctx.failedSmash.inputs !== windInputs(ctx.failedSmash.native))) {
        if (guard) await guard.raise(false)
        clear()
        ctx.aim = 'free'
        const res = await mace.windSmash(bot, ctl, ctx.entity, {
          chain: maceChain,
          vel: () => ctx.track.vel(),
          stats: mc.st,
          telemetryHp,
          stillOk: () => ctx.entity.isValid && Math.hypot(ctx.entity.position.x - bot.entity.position.x, ctx.entity.position.z - bot.entity.position.z) < 4.6 && !mace.shieldAtUs(bot, ctx.entity) && !duo.secondThreat()
        })
        ctx.aim = 'target'
        ctx.failedSmash = res.hit ? null : { inputs: windInputs(!res.launched), native: !res.launched, why: res.why || (res.launched ? 'missed_landing' : 'launch_not_confirmed') }
      if (res.swung) { st.swings++; ctx.lastSwing = gameClock.now() }
        if (!res.aborted) used('1 против 2: ' + (res.hit ? 'булава в добиваемого — удар с падения' : res.launched ? 'булава в добиваемого — взлёт, не достал' : res.cancelled ? 'булава в добиваемого — передумал' : 'булава в добиваемого — не взлетел'))
        await holdWeapon()
        return NEXT
      }
    }
  }
}

// Разворот на того, кто бьёт в спину.
export async function backAttackerTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, duo, holdWeapon, otherAttacker, retarget, used, vision } = ctx
  const { eye, inSight, r } = turn
  if (ctx.prof.player && !duo.active()) {
    const o = otherAttacker()
    const curInReach = r <= HIT_REACH + 0.3 && inSight
    if (o && !curInReach && vision.visible(o.e) && reachFrom(eye, o.e) <= HIT_REACH && pick.canHit(bot, o.e, { range: HIT_REACH })) {
      used(`разворот на ${o.e.username} — бьёт в спину`)
      retarget(o.e)
      await holdWeapon()
      return NEXT
    }
  }
}
