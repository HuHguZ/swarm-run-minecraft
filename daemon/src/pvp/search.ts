import { Vec3 } from 'vec3'
import { standPositions, supportAt } from '../navigation/geometry'
import { visibleLanding, withinArena } from '../navigation/parkour'
import { combatMovement } from './movement'
import { seesPlayer, SIGHT_TRANSPARENT } from './last-seen'
import { goals, Movements } from 'mineflayer-pathfinder'
import * as clock from '../game-clock'
import * as pick from '../pick'

const samplePoints = [[.5, .5, .5]]
for (const x of [.05, .95]) for (const y of [.05, .95]) for (const z of [.05, .95]) samplePoints.push([x, y, z])
const unknown = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const searchReach = 6
const fullCube = block => block?.boundingBox === 'block' && block.shapes?.some(s =>
  s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1)

// Shared by acquisition and LOS repositioning: packet-only cells stay unknown,
// including apparently empty head space above a visible support.
export function observedCollision (bot, blockAt = pos => bot.blockAt(pos, false), cachedRead = false, snapshotEye?: Vec3) {
  const cells = new Map(); let observedAt = -Infinity
  const occluders: { cell: Vec3; lo: Vec3; hi: Vec3 }[] = []
  const clear = () => { cells.clear(); occluders.length = 0 }
  let resetQueued = false
  return { physics: bot.physics, game: bot.game, blockAt (pos) {
    if (!snapshotEye) {
      const now = clock.now()
      if (observedAt !== now) { observedAt = now; clear() }
      // Doors, cover and the observer's pose can change between two packets in the same game tick.
      if (!resetQueued) {
        resetQueued = true
        queueMicrotask(() => { clear(); resetQueued = false })
      }
    }
    const cell = pos.floored(); const key = cell.toString()
    if (cells.has(key)) return cells.get(key)
    // Flight supplies its own bounded end-of-pass raw cache; other readers still need query-local reuse.
    const raw = cachedRead ? null : new Map()
    const read = cachedRead ? blockAt : at => {
      const key = ((at.x + 30000) * 60001 + at.z + 30000) * 1024 + at.y + 512
      const cached = raw.get(key)
      // Avoid string allocation per ray step; coordinates also disambiguate distant hash collisions.
      if (cached && cached.x === at.x && cached.y === at.y && cached.z === at.z) return cached.block
      const block = blockAt(at)
      raw.set(key, { x: at.x, y: at.y, z: at.z, block })
      return block
    }
    const sightWorld = { blockAt: pos => { try { return read(pos) || unknown } catch { return unknown } } }
    const eye = snapshotEye ?? pick.eyeOf(bot)
    const seen = samplePoints.some(([x, y, z]) => {
      const delta = cell.offset(x, y, z).minus(eye); const len = delta.norm()
      const dir = len > 0 ? delta.scaled(1 / len) : null
      // The same observed full cube can block several rays; partial shapes and failed reads still trace normally.
      if (dir) for (const o of occluders) if (!o.cell.equals(cell) && pick.rayBox(eye, dir, o.lo, o.hi, len) != null) {
        if (o !== occluders[0]) { occluders[1] = occluders[0]; occluders[0] = o }
        return false
      }
      const hit = dir ? pick.blockOnRay(sightWorld, eye, dir, len, /glass|_pane$|^barrier$|^iron_bars$/) : null
      if (!hit || hit.pos.equals(cell)) return true
      if (hit.block !== unknown && fullCube(hit.block)) {
        // Leave a corner/edge touch to the exact DDA instead of treating it as an opaque crossing.
        if (!occluders.some(o => o.cell.equals(hit.pos))) {
          occluders.unshift({ cell: hit.pos, lo: hit.pos.offset(1e-7, 1e-7, 1e-7), hi: hit.pos.offset(1 - 1e-7, 1 - 1e-7, 1 - 1e-7) })
          if (occluders.length > 2) occluders.pop()
        }
      }
      return false
    })
    const block = seen ? read(cell) : null
    cells.set(key, block); return block
  } }
}

// Price a detour via a visible opening in the wall that conceals the last sighting.
function sightingApproach(bot, observed, last) {
  const eye = pick.eyeOf(bot), delta = last.position.offset(0, last.height * .6, 0).minus(eye)
  if (Math.max(Math.abs(delta.x), Math.abs(delta.z)) <= Math.abs(delta.y)) return last.position
  const length = delta.norm()
  const hit = pick.blockOnRay({ blockAt: p => observed.blockAt(p) || unknown }, eye, delta.scaled(1 / length),
    Math.min(length, searchReach), SIGHT_TRANSPARENT)
  if (!hit || hit.block === unknown || !fullCube(hit.block)) return last.position
  const dx = Math.abs(delta.x) < Math.abs(delta.z) ? 1 : 0, dz = 1 - dx
  let best = last.position, cost = Infinity
  for (const side of [-1, 1]) for (let n = 1; n <= searchReach; n++) {
    const cell = hit.pos.offset(side * n * dx, 0, side * n * dz), block = observed.blockAt(cell)
    if (!block) break
    const transparent = SIGHT_TRANSPARENT.test(block.name)
    if (fullCube(block) && !transparent) continue
    if (block.boundingBox === 'empty' || transparent) {
      const via = cell.offset(.5, .5, .5), distance = eye.distanceTo(via) + via.distanceTo(last.position)
      if (distance < cost) { best = via; cost = distance }
    }
    break
  }
  return best
}

// Search viewpoints from our own pose and visible supports, never the hidden target's packets.
export async function acquireTarget (bot, ctl, vision, raw, { deadline, arena = null, interrupted }: any) {
  const start = clock.now()
  const target = () => raw.username ? bot.players?.[raw.username]?.entity || raw : bot.entities?.[raw.id] || raw
  const observedTarget = vision.observe(target())
  const sighted = view => view && view._ndVisible !== false && view.isValid !== false ? view : null
  let entity = sighted(observedTarget)
  const search = { legs: 0, seconds: 0 }
  if (entity) return { entity, search }
  // A retired player handle can outlive its tab-list entity. Only the observer holds its public trail.
  const last = observedTarget || (raw._ndVisible === false ? vision.observe(raw) : null)
  let lastPlace = last?._ndVisible === false && last.position
    ? { position: last.position.clone(), height: pick.hitboxOf(bot, last).h, width: last.width } : null
  const observed = observedCollision(bot)
  const movement = combatMovement(bot, arena, observed)
  arena = movement.arena
  const mv = bot.pathfinder.movements
  const getBlock = mv?.getBlock; const entityDetection = mv?.allowEntityDetection
  if (getBlock) {
    const visibleMoves = Object.create(mv); visibleMoves.bot = observed
    // fastblocks closes over the packet cache instead of reading this.bot.
    const readBlock = mv._ndFast ? Movements.prototype.getBlock : getBlock
    mv.getBlock = (...args) => readBlock.apply(visibleMoves, args)
    mv.allowEntityDetection = false // Packet-only entities must not alter this unseen-target route's cost.
  }
  const visited: Vec3[] = [], trail: Vec3[] = []
  const attempted = new Set<string>()
  let goal = null, route = null, lastScan: Vec3 | null = null
  let until = start, changed = true, moved = false
  const rescan = () => { changed = true; attempted.clear() }
  const blockChanged = (before, after) => {
    if (goal || changed || (before?.stateId != null && before.stateId === after?.stateId)) return
    const p = (after || before)?.position, me = bot.entity.position
    if (p && Math.abs(me.x - p.x) < 8 && Math.abs(me.z - p.z) < 8 && Math.abs(me.y - p.y) < 6 &&
      observedCollision(bot).blockAt(p)) rescan()
  }
  const columnLoaded = p => {
    const me = bot.entity.position
    if (p && p.x <= me.x + 8 && p.x + 16 > me.x - 8 && p.z <= me.z + 8 && p.z + 16 > me.z - 8) rescan()
  }
  const pathUpdate = result => {
    if (route && bot.pathfinder.goal === route && !result.path?.length && (result.status === 'noPath' || result.status === 'timeout')) until = clock.now()
  }
  let arrived = false, replaced = false
  const goalReached = completed => { if (route && completed === route) arrived = true }
  const goalUpdated = next => { if (route && next !== route) { replaced = true; wake?.() } }
  const stop = () => { route = null; bot.pathfinder.setGoal(null); bot.clearControlStates() }
  let wake = null
  const cancel = () => wake?.()
  ctl.onAbort?.push(cancel)
  bot.on?.('blockUpdate', blockChanged)
  bot.on?.('chunkColumnLoad', columnLoaded)
  bot.on?.('path_update', pathUpdate)
  bot.on?.('goal_reached', goalReached)
  bot.on?.('goal_updated', goalUpdated)
  try {
    while (!replaced && !ctl.aborted && bot.health > 0 && clock.now() < deadline && !interrupted?.()) {
      entity = sighted(vision.observe(target()))
      if (entity) break
      const me = bot.entity.position
      const feet = me.floored()
      if (bot.entity.onGround && !trail.at(-1)?.equals(feet)) {
        // Keep the actual route home; walking back along it consumes that branch.
        const earlier = trail.findIndex(p => p.equals(feet))
        if (earlier >= 0) trail.length = earlier + 1
        else { trail.push(feet); if (trail.length > 64) trail.shift() }
        if (!visited.some(p => p.equals(feet))) { visited.push(feet); if (visited.length > 64) visited.shift() }
      }
      const reached = goal && (arrived || (!('goal' in bot.pathfinder) && goal.floored().equals(feet)))
      if (bot.entity.onGround && (clock.now() >= until || (goal ? reached :
        changed || !lastScan || me.distanceTo(lastScan) >= .25))) {
        // Reaching a waypoint around a corner doesn't yet show whether the last sighting is empty.
        if (reached && lastPlace && seesPlayer(bot, lastPlace)) lastPlace = null
        if ((!goal && clock.now() >= until) || (lastScan && me.distanceTo(lastScan) >= 1)) attempted.clear()
        if (moved) { stop(); moved = false }
        changed = false; lastScan = me.clone()
        const usable = p => !attempted.has(p.toString()) &&
          (!arena || (p.y >= Math.min(arena.y, feet.y) && withinArena(bot, p, arena))) && visibleLanding(bot, p, observed)
        const towards = lastPlace && (reached ? sightingApproach(bot, observed, lastPlace) : lastPlace.position)
        const remaining = towards ? me.distanceTo(towards) : 0
        const yaw = bot.entity.yaw || 0
        let best = null; let score = -Infinity
        for (const radii of [[searchReach, 3], [2, 1]]) {
          for (let i = 0; i < 8; i++) for (const radius of radii) {
            const angle = yaw + i * Math.PI / 4
            const column = new Vec3(me.x - Math.sin(angle) * radius, me.y, me.z - Math.cos(angle) * radius)
            for (const p of standPositions(observed, column, { rise: 1.25, drop: 3 })) {
              const cell = p.floored()
              const novelty = Math.min(...visited.map(old => cell.distanceTo(old)))
              if (!novelty || !usable(p)) continue
              const progress = towards ? remaining - p.distanceTo(towards) : 0
              if (novelty + progress > score) { best = p; score = novelty + progress }
            }
          }
          if (best) break
        }
        const previous = trail.at(-2)
        if (!best && previous) {
          best = standPositions(observed, new Vec3(previous.x, me.y, previous.z), { rise: 1.25, drop: 3 })
            .find(p => p.floored().equals(previous) && usable(p))
        }
        const support = best && supportAt(observed, best, .04)
        goal = support ? best : null
        until = clock.now() + 8000 // Same bounded leg as movement.stuckGuard.
        if (goal) {
          attempted.add(goal.toString())
          // A* indexes the cell above the support; native arrival reports the actual surface, including slabs.
          route = new goals.GoalBlock(goal.x, support.block.position.y + 1, goal.z)
          arrived = false
          bot.pathfinder.setGoal(route)
          search.legs++; moved = true
        }
      }
      await new Promise<void>(resolve => {
        const timer = clock.setTimeout(done, 100)
        function done () { clock.clearTimeout(timer); wake = null; resolve() }
        wake = done
      })
    }
    search.seconds = (clock.now() - start) / 1000
    return { entity, search }
  } finally {
    cancel()
    bot.removeListener?.('blockUpdate', blockChanged)
    bot.removeListener?.('chunkColumnLoad', columnLoaded)
    bot.removeListener?.('path_update', pathUpdate)
    bot.removeListener?.('goal_reached', goalReached)
    bot.removeListener?.('goal_updated', goalUpdated)
    if (ctl.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
    try { if (moved && !replaced) stop() } finally {
      if (getBlock) { mv.getBlock = getBlock; mv.allowEntityDetection = entityDetection }
      movement.restore()
    }
  }
}
