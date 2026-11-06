import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { observedVelocity } from '../bow/track'
import { supportAt } from '../navigation/geometry'
import { seesPlayer } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import { visibleAllies, allyAt, allyOnSegment } from './ally-safety'
import { WIND, windBlockImpact, windAboveWorld, type WindReport } from './team-wind'
import { windTeamSafe, windResistance, WIND_FORECAST_TICKS } from './enemy-wind'

/** Last-packet safety for ordinary self/push wind: unknown allied HP buys zero damage. */
export function windReleaseSafe(bot: any, aim: { yaw: number; pitch: number }, moved: Vec3, explicitReceiver?: string, explicitAllies: string[] = []): boolean {
  const names = new Set(explicitAllies), own = bot.entity
  const extra = (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== own && !(e.id !== undefined && e.id === own?.id) &&
    e.username && e.username !== (bot.username || own?.username) && names.has(e.username) && e.isValid !== false &&
    bot.players?.[e.username]?.gamemode !== 3 && e._ndVisible !== false && seesPlayer(bot, e))
  const allies = [...new Map([...visibleAllies(bot), ...extra].map(e => [e.username, e])).values()].filter(e => e.username !== explicitReceiver)
  if (!allies.length) return true
  if (![aim.yaw, aim.pitch, moved.x, moved.y, moved.z].every(Number.isFinite)) return false
  const from = pick.eyeOf(bot), cp = Math.cos(aim.pitch)
  const velocity = new Vec3(-Math.sin(aim.yaw) * cp, Math.sin(aim.pitch), -Math.cos(aim.yaw) * cp).scaled(WIND.speed).plus(moved)
  const entities = (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity && e.username !== explicitReceiver && !allies.includes(e) &&
    (bot.entity.id === undefined || e.id !== bot.entity.id) && (e.username || e.type === 'player' || e.type === 'mob') && e._ndVisible !== false && seesPlayer(bot, e))
  const sight = observedCollision(bot), reports: WindReport[] = allies.map(e => {
    const velocity = observedVelocity(e)
    return { id: e.username, position: { ...e.position }, velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      onGround: !!supportAt(sight, e.position, .05), yaw: e.yaw || 0, pitch: e.pitch || 0,
      gliding: (require('../elytra/track') as typeof import('../elytra/track')).gliding(e), eyeHeight: pick.eyeHeight(bot, e) }
  })
  const tracks = new Map(), world = { ...bot, blockAt: (p: Vec3) => sight.blockAt(p) }
  const resistance = allies.map(e => e.equipment ? windResistance(e).hi : 1)
  // Projectile.shoot adds bounded triangle noise independently to each axis. Test the centre and corners;
  // the direct-body corridor also includes the continuous dispersion envelope between those samples.
  const velocities = [velocity]
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) velocities.push(velocity.plus(new Vec3(x, y, z).scaled(WIND.speed * WIND.dispersion)))
  for (const v of velocities) {
    const speed = v.norm()
    if (!Number.isFinite(speed) || speed < 1e-6) return false
    const direction = v.scaled(1 / speed)
    let burst: Vec3 | null = null, ticks = 0
    for (let age = 1; age <= WIND_FORECAST_TICKS; age++) {
      const origin = from.plus(v.scaled(age - 1))
      if (windAboveWorld(bot, origin)) { burst = origin; ticks = age; break }
      let unknown = false
      const observed = { blockAt(p: Vec3) { const block = sight.blockAt(p); if (!block) unknown = true; return block } }
      const block = windBlockImpact(observed, origin, direction, speed)
      if (unknown) return false
      let limit = block ? block.distance / speed : 1
      let entityBurst: Vec3 | null = null
      const margin = Math.max(0, Math.min(Math.fround(.3), (age - 2) / 20))
      for (const e of entities) {
        const box = pick.hitboxOf(bot, e), a = allyAt(bot, e, age - 1), b = allyAt(bot, e, age)
        const t = pick.rayBox(origin, v.minus(b.minus(a)), a.offset(-box.w / 2 - margin, -margin, -box.w / 2 - margin),
          a.offset(box.w / 2 + margin, box.h + margin, box.w / 2 + margin), limit)
        if (t !== null && t < limit) { limit = t; entityBurst = origin.plus(v.scaled(t)) }
      }
      const end = origin.plus(v.scaled(limit))
      const spread = WIND.speed * WIND.dispersion * Math.sqrt(3) * age
      if (allyOnSegment(bot, allies, origin, end, age - 1, limit, margin + spread)) return false
      if (entityBurst || block) { burst = entityBurst || block!.burst; ticks = age; break }
    }
    // No observed first impact within the bounded body forecast: its allied splash remains unknown.
    if (!burst) return false
    // Glint does not reveal Blast Protection. A weaker push can fall short of a safe far landing,
    // so check an interior resistance as well as both extremes; exact enchantments stay unread.
    for (const fraction of [0, .5, 1]) {
      reports.forEach((report, i) => { report.attributes = { 'minecraft:explosion_knockback_resistance': { value: resistance[i] * fraction } } })
      if (!windTeamSafe(world, reports, [{ ticks, burst }], undefined, tracks, true)) return false
    }
  }
  return true
}
