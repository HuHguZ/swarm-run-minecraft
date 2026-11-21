import { Vec3 } from 'vec3'
import * as edges from '../edges'
import { eyeOf } from '../pick'
import { observedCollision } from '../pvp/search'
import { bodyClear, supportAt } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
import { LAUNCH_BACK } from '../mace/consts'
import { WIND, windInside, windShot, windBlockImpact, windImpulse, windLanding, type WindArena, type WindShot } from './team-wind'

const scatter = [new Vec3(0, 0, 0)]
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) scatter.push(new Vec3(x, y, z).scaled(WIND.speed * WIND.dispersion))

// The sprint jump uses three run-up ticks, takes off on the release packet, then coasts
// after ten ticks. Certify that motion all the way to a visible, settled support.
export function safeRetreatBurst(bot, yaw: number, arena: WindArena, release?: WindShot) {
  const world = edges.worldOf(observedCollision(bot, edges.worldOf(bot).getBlock, true))
  const view = Object.assign(Object.create(bot), { blockAt: world.getBlock })
  const simulate = edges.simOf(bot)
  const walk = { ...edges.IDLE, forward: true, sprint: true }
  const base = edges.stateOf(bot, edges.IDLE)
  const clear = st => windInside(st.pos, arena) && !st.isInLava && !st.isInWater && bodyClear(view, st.pos)
  if (!clear(base)) return false
  let shot = release
  if (!shot) {
    if (!base.onGround) return false
    const eyeH = eyeOf(bot).y - base.pos.y
    let moved: Vec3
    for (let t = 0; t < 4; t++) {
      base.yaw = yaw; base.control = { ...walk, jump: t === 3 }
      const from = base.pos.clone()
      simulate(base, world)
      if (!clear(base)) return false
      moved = base.pos.minus(from)
    }
    const eye = base.pos.offset(0, eyeH, 0)
    if (base.onGround) moved.y = 0
    for (const back of [LAUNCH_BACK, 0]) {
      const p = base.pos.offset(Math.sin(yaw) * back, 0, Math.cos(yaw) * back)
      const floor = supportAt(view, p, WIND.reach)
      if (floor) shot = windShot(view, eye, new Vec3(p.x, floor.top, p.z), moved)
      if (shot?.normal.y === 1) break
    }
  }
  if (!shot || shot.normal.y !== 1) return false
  const lands = (burst?: Vec3, atTick = -1) => {
    const st = edges.cloneState(base, edges.IDLE)
    let peak = st.pos.y, heightAtBurst = peak, settled = 0
    for (let t = 0; t < 80; t++) {
      st.yaw = yaw; st.control = burst && t >= shot.ticks && t < 10 ? walk : edges.IDLE
      if (t === atTick) {
        heightAtBurst = st.pos.y
        st.vel = st.vel.plus(windImpulse(view, st.pos, burst))
      }
      simulate(st, world); peak = Math.max(peak, st.pos.y)
      if (!clear(st)) return false
      if (t >= atTick && st.onGround) {
        const floor = supportAt(view, st.pos, .04)
        const cap = burst && t - atTick <= WIND.forgivenessTicks ? heightAtBurst - st.pos.y : Infinity
        if (!floor || landingDamage(floor.block, peak - st.pos.y, bot.entity.attributes, cap) > 0) return false
      }
      if (t >= (burst ? 10 : 0) && windLanding(view, st, st.pos)) {
        if (++settled >= 6) return true
      } else settled = 0
    }
    return false
  }
  // A changed packet or spent item can cancel the throw after the run-up.
  if (!lands()) return false
  for (const noise of scatter) {
    const velocity = shot.velocity.plus(noise), speed = velocity.norm()
    const hit = windBlockImpact(view, shot.from, velocity.scaled(1 / speed), speed * (shot.ticks + 1), speed)
    if (!hit || hit.normal.y !== 1 || !lands(hit.burst, Math.ceil(hit.distance / speed))) return false
  }
  return true
}
