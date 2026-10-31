import { Vec3 } from 'vec3'
import { hitboxOf, rayBox } from '../pick'
import { seesPlayer } from '../pvp/last-seen'
import { observedVelocity, leadTarget } from '../bow/track'
import { observedCollision } from '../pvp/search'
import { worldOf } from '../elytra/physics'
import { bodyClear } from '../navigation/geometry'

const observedBots = new WeakMap<object, any>()

/** Public membership alone is enough to refuse an ordinary friendly attack; it reveals no hidden geometry. */
export function isAlly(bot: any, e: any): boolean {
  const name = typeof e === 'string' ? e : e?.username, own = bot.username || bot.entity?.username
  const team = bot.teamMap?.[own]?.team
  return !!name && name !== own && (!!bot._ndSwarmAllies?.includes(name) || !!team && bot.teamMap?.[name]?.team === team)
}

/** Team membership is public; a teammate's geometry and motion still require our own sight. */
export function visibleAllies(bot: any): any[] {
  const own = bot.entity
  return (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== own && !(e.id !== undefined && e.id === own?.id) && e.username &&
    isAlly(bot, e) && e.isValid !== false &&
    bot.players?.[e.username]?.gamemode !== 3 && e._ndVisible !== false && seesPlayer(bot, e))
}

/** Ordinary explosions cannot spend unknown allied HP or rely on hidden cover/enchantments. */
export function blastTeamRisk(bot: any, center: Vec3, power: number) {
  const boom: typeof import('../boom') = require('../boom')
  let damage = 0, push = 0
  for (const ally of visibleAllies(bot)) {
    const result = boom.blast(bot, center, power, ally.position, { seen: 1, def: { armor: 0, tough: 0, epf: 0, kbRes: 0, resist: 0 } })
    damage += result.dmg; push += result.kb.norm()
  }
  return { damage, push, unsafe: damage > 0 || push > 0 }
}

export function allyWorld(bot: any): any {
  let observed = observedBots.get(bot)
  if (!observed) {
    const sight = observedCollision(bot), world = worldOf(bot, { observed: true })
    observed = Object.create(bot)
    observed.blockAt = sight.blockAt
    observed._ndSkyWorld = { floorBelow(x, y, z, depth) {
      const floor = world.floorBelow(x, y, z, depth)
      return floor && sight.blockAt(new Vec3(Math.floor(x), floor.top - 1, Math.floor(z))) ? floor : null
    } }
    observedBots.set(bot, observed)
  }
  return observed
}

export function allyAt(bot: any, e: any, tick: number): Vec3 {
  const observed = allyWorld(bot)
  return leadTarget(e, () => observedVelocity(e), observed, 0)(tick)
}

/** Relative segment versus the moving native AABB; also covers a crossing between two ticks. */
export function allyOnSegment(bot: any, allies: any[], from: Vec3, to: Vec3, tick: number, duration = 1, margin = Math.fround(.3)): any {
  for (const e of allies) {
    const box = hitboxOf(bot, e), a = allyAt(bot, e, tick), b = allyAt(bot, e, tick + duration)
    const direction = to.minus(from).minus(b.minus(a))
    const lo = a.offset(-box.w / 2 - margin, -margin, -box.w / 2 - margin)
    const hi = a.offset(box.w / 2 + margin, box.h + margin, box.w / 2 + margin)
    const delta = b.minus(e.position), steps = Math.max(1, Math.ceil(delta.norm() / (box.w / 2)))
    const observed = { blockAt: allyWorld(bot).blockAt, physics: { playerHalfWidth: box.w / 2, playerHeight: box.h } }
    let clear = true
    for (let i = 1; i <= steps && clear; i++) clear = bodyClear(observed, e.position.plus(delta.scaled(i / steps)), { water: true, web: true, powder: true })
    if (!clear) {
      // A wall, ceiling or unknown cell may stop the ally anywhere along this forecast.
      for (const axis of ['x', 'y', 'z']) {
        const half = axis === 'y' ? 0 : box.w / 2
        lo[axis] = Math.min(lo[axis], e.position[axis] - half - margin, b[axis] - half - margin)
        hi[axis] = Math.max(hi[axis], e.position[axis] + (axis === 'y' ? box.h : half) + margin, b[axis] + (axis === 'y' ? box.h : half) + margin)
      }
      if (rayBox(from, to.minus(from), lo, hi, 1) !== null) return e
    }
    // Unknown terrain may stop a fall earlier; do not approve a shot only because the forecast fell through it.
    if (e.onGround === false && !e.elytraFlying) hi.y = Math.max(hi.y, e.position.y + box.h + margin)
    if (rayBox(from, direction, lo, hi, 1) !== null) return e
  }
  return null
}

/** Spear rays pierce every body, including teammates behind the intended enemy. */
export function allyOnSpearRay(bot: any, eye: Vec3, direction: Vec3, min: number, max: number): any {
  const start = eye.plus(direction.scaled(min)), movement = bot.entity.velocity || new Vec3(0, 0, 0)
  for (const e of visibleAllies(bot)) {
    const box = hitboxOf(bot, e), a = allyAt(bot, e, 0), next = allyAt(bot, e, 1), b = next.offset(-movement.x, -movement.y, -movement.z)
    // Observation age can move both forecasts off the ray while the last visible body still overlaps it.
    // The ally may move first while the server still holds our last position and active spear.
    const lo = new Vec3(Math.min(e.position.x, a.x, b.x, next.x) - box.w / 2 - .125, Math.min(e.position.y, a.y, b.y, next.y) - .125, Math.min(e.position.z, a.z, b.z, next.z) - box.w / 2 - .125)
    const hi = new Vec3(Math.max(e.position.x, a.x, b.x, next.x) + box.w / 2 + .125, Math.max(e.position.y, a.y, b.y, next.y) + box.h + .125, Math.max(e.position.z, a.z, b.z, next.z) + box.w / 2 + .125)
    if (rayBox(start, direction, lo, hi, max - min) !== null) return e
  }
  return null
}
