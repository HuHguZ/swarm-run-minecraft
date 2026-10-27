import { Vec3 } from 'vec3'
import * as pick from '../../pick'
import { visibleAllies, allyOnSegment } from '../../combat/ally-safety'
import { WIND } from '../../combat/team-wind'
import { KINDS, launch } from '../../throw'

export function nearSplash(bot: any, e: any, at: any) {
  if (!e?.position) return false
  const box = pick.hitboxOf(bot, e)
  // Splash compares AABBs; .55 covers the .25 potion height and the .3 projectile margin.
  return Math.hypot(...['x', 'y', 'z'].map(axis => Math.max(0, box.lo[axis] - .55 - at[axis], at[axis] - box.hi[axis] - .55))) < 4
}

/** A nearby body matters only if the actual potion trajectory can hit it before the first block. */
export function unsafeSplash(bot: any, target: any, allies: any[] = [], shot?: any): string | null {
  const team = [bot.entity, ...visibleAllies(bot), ...allies]
  const bodySplash = e => team.some(ally => {
    if (!ally?.position) return false
    const a = pick.hitboxOf(bot, ally), b = pick.hitboxOf(bot, e)
    // Possible body impact: .3 collision margin + .3 splash margin + .25 potion height.
    return Math.hypot(...['x', 'y', 'z'].map(axis => Math.max(0, a.lo[axis] - b.hi[axis] - .85, b.lo[axis] - a.hi[axis] - .85))) < 4
  })
  if (team.some(e => nearSplash(bot, e, target.position))) return 'allied_splash'
  if (bodySplash(target)) return 'unverified_entity_impact'
  if (!shot) return null
  if (!shot.land?.at || !shot.sol || !shot.from) return 'unknown_landing'
  if (team.some(e => nearSplash(bot, e, shot.land.at))) return 'allied_splash'
  const dangerous = [target, ...Object.values<any>(bot.entities || {})].filter(e => e?.position && e.id !== bot.entity.id &&
    e.isValid !== false && bot.players?.[e.username]?.gamemode !== 3 && pick.canHit(bot, e, { range: 32 }) && bodySplash(e))
  if (!dangerous.length) return null
  const k = KINDS.splash_potion, initial = launch(shot.sol.pitch, k)
  let pos = shot.from.clone(), v = new Vec3(-Math.sin(shot.sol.yaw) * initial.vh + shot.moved.x,
    initial.vy + (shot.airborne ? shot.moved.y : 0), -Math.cos(shot.sol.yaw) * initial.vh + shot.moved.z)
  for (let tick = 0; tick < shot.land.ticks; tick++) {
    v = new Vec3(v.x * .99, (v.y - k.g) * .99, v.z * .99)
    const end = tick === shot.land.ticks - 1 ? shot.land.at : pos.plus(v)
    const spread = k.speed * WIND.dispersion * Math.sqrt(3) * (1 - .99 ** (tick + 1)) / .01
    if (allyOnSegment(bot, dangerous, pos, end, tick, Math.min(1, end.distanceTo(pos) / v.norm()), Math.fround(.3) + spread)) return 'unverified_entity_impact'
    pos = end
  }
  return null
}
