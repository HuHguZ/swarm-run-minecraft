import { windAt, AllyLaunch } from '../../../daemon/src/swarm/combos/air-ideas'
import { leadTarget } from '../../../daemon/src/bow/track'
import * as pick from '../../../daemon/src/pick'
import { startWindRescue } from './combo-wind-rescue'
import { createPostSmashObserver } from './combo-wind-observation'

export async function windGravityAt(bot: any, target: any, p: AllyLaunch = {}) {
  let gravityPrediction: any = null
  const result = await windAt(bot, target, { ...p, predict(entity, velocity, flightTicks) {
    // Preparation has elapsed before windAt captures velocity. leadTarget adds age; only its pending look tick remains.
    const at = leadTarget(entity, () => velocity, bot, 0)(flightTicks + 1).offset(0, .3, 0)
    const from = pick.eyeOf(bot), ray = at.minus(from)
    // shortcut: static aim boxes omit motion/spread; use swept bodies before turning this diagnostic into a guard.
    const thirdBodies = Object.values<any>(bot.entities ?? {}).filter(e => e && e !== bot.entity && e.id !== bot.entity.id &&
      e.id !== entity.id && e.isValid !== false && (e.username || e.type === 'player' || e.type === 'mob') && pick.canHit(bot, e, { range: 32 }))
      .map(e => { const box = pick.hitboxOf(bot, e); return { id: e.id, username: e.username,
        position: { x: e.position.x, y: e.position.y, z: e.position.z }, rayFraction: pick.rayBox(from, ray, box.lo, box.hi, 1) } })
    const first = thirdBodies.filter(e => e.rayFraction !== null).sort((a, b) => a.rayFraction - b.rayFraction)[0]
    gravityPrediction = { epochMs: Date.now(), flightTicks, horizonTicks: flightTicks + 1 + (velocity.ageTicks || 0),
      usedVelocity: { ...velocity }, point: { x: at.x, y: at.y, z: at.z }, from: { x: from.x, y: from.y, z: from.z },
      collisionModel: 'static_aim_ray_only_no_moving_safety', thirdBodies, firstStaticInterceptorId: first?.id ?? null }
    return at
  } })
  return { ...result, gravityPrediction }
}

export function startGravityWindRescue(a: any, b: any, t: any, enabled: boolean, stop: () => boolean, t0 = Date.now()) {
  const rescue = startWindRescue(a, b, t, enabled, stop, t0, createPostSmashObserver, windGravityAt)
  rescue.trace.policy = 'C2b_strict_postcue_arc_gravity_age_look1_wind'
  return rescue
}

if (require.main === module) {
  const [pairs = '3', hp = '100', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20 || !['20', '100'].includes(hp)) throw new Error('combo-wind-gravity [pairs=3:1..20] [hp=100:20|100]')
  require('./combo-anvil').apexTrials(false, +pairs, +hp, 'wind-gravity').then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
