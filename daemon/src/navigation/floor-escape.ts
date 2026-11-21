import type { Vec3 } from 'vec3'
import { bodyClear, supportAt, type CollisionWorld } from './geometry'
import { PlayerState, controls, simulator, withinArena, arenaAround, type MovementArena, type MovementBot } from './parkour/model'

/** A floor-crack escape must still have support after releasing the keys. */
export function floorEscapeForecast(bot: MovementBot, seen: CollisionWorld, budget: { frames: number; cells: number }, bounds?: MovementArena) {
  const from = bot.entity.position
  // The burst runs along at most six cells. Bound sight work even for unexpected knockback.
  const cells = new Map<string, ReturnType<CollisionWorld['blockAt']>>()
  const read = (p: Vec3) => {
    const cell = p.floored(), key = cell.toString()
    if (!cells.has(key)) {
      if (budget.cells <= 0) return null
      budget.cells--
      cells.set(key, seen.blockAt(cell))
    }
    return cells.get(key)
  }
  const world = { getBlock: read }, known: CollisionWorld = { ...seen, blockAt: read }
  // Unseen shapes may reach fence height. A sole grazing an unobserved cell behind a solid riser does not enter it.
  const unknown = { name: 'unknown', shapes: [[0, 0, 0, 1, 1.5, 1] as const] }
  const clearance: CollisionWorld = { ...seen, blockAt: p => read(p) || { ...unknown, position: p } }
  const sim = simulator(bot), arena = arenaAround(seen, bounds, from)
  // Simulated yaw belongs to the copy. Candidate directions share visible cells and one frame budget.
  return (ticks: number, jump: boolean, yaw: number) => {
    const profiles = [{ hold: ticks, jump }]
    if (jump) profiles.push({ hold: ticks, jump: false })
    if (ticks > 1) for (const hold of new Set([Math.ceil(ticks / 2), 1])) profiles.push({ hold, jump: false })
    for (const profile of profiles) {
      const st = new PlayerState(bot, controls())
      st.yaw = yaw
      for (let t = 0; t < profile.hold + 32; t++) {
        if (budget.frames <= 0) return null
        budget.frames--
        st.control = t < profile.hold ? controls({ forward: true, sprint: true, jump: profile.jump && st.onGround }) : controls()
        const prev = st.pos.clone()
        sim(st, world)
        if (st.pos.y < from.y - 1e-4 || !withinArena(seen, st.pos, arena, prev) || !bodyClear(clearance, st.pos, { from: prev })) break
        if (t >= profile.hold && st.onGround && Math.hypot(st.vel.x, st.vel.z) < .003) {
          if (supportAt(known, st.pos, .04) && (ticks === 0 || Math.hypot(st.pos.x - from.x, st.pos.z - from.z) > .3)) return profile
          break
        }
      }
    }
    return null
  }
}
