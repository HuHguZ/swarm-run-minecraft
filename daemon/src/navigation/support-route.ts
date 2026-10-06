import { Vec3 } from 'vec3'
import { bodyClear, standPositions, supportAt, dimensions, shapeBoxes, type CollisionWorld, type Point } from './geometry'
import { clearanceMargin, detour } from './shape-detour'
import { hasFallMitigation, landingDamage } from './landing'

export interface LandingOption { target: Vec3; key: string; score: number; support: string; mode?: 'climb'; climb?: Point; bounce?: Point }
export interface RoutingDiagnostics { workMs?: number; wallMs?: number; nodes?: number; expanded?: number }
// Foot jitter inside one support must not turn a rejected edge into a new edge.
const keyOf = (p: Point) => `${Math.floor(p.x) + .5},${Math.round(p.y * 32) / 32},${Math.floor(p.z) + .5}`
export const transitionKey = (from: Point, to: Point, bounce?: Point) => `${keyOf(from)}>${keyOf(to)}${bounce ? `~${keyOf(bounce)}` : ''}`
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z)
const NODE_LIMIT = 1600
function highRidge(world: CollisionWorld, from: Point, to: Point): boolean {
  // A wall above the maximum unboosted jump cannot be crossed by a short
  // straight hop. Connect through observed side supports first; the native
  // controller still handles local air detours around narrow obstructions.
  const apex = from.y + 1.25; const { half } = dimensions(world)
  for (const t of [.25, .5, .75]) {
    const x = from.x + (to.x - from.x) * t; const z = from.z + (to.z - from.z) * t
    for (let bx = Math.floor(x - half); bx <= Math.floor(x + half); bx++) for (let bz = Math.floor(z - half); bz <= Math.floor(z + half); bz++) {
      for (let y = Math.floor(apex) - 1; y <= Math.floor(apex); y++) {
        const block = world.blockAt(new Vec3(bx, y, bz), false)
        if (!block || shapeBoxes(block).some(b => b.minY <= apex && b.maxY > apex && b.minX < x + half && b.maxX > x - half && b.minZ < z + half && b.maxZ > z - half)) return true
      }
    }
  }
  return false
}
const climbable = new Set<string>((require('../../data/climbable-1.21.11.json').climbable.values as string[]).map(name => name.replace('minecraft:', '')))
export function onClimbable(world: CollisionWorld, at: Point): boolean {
  const block = world.blockAt(new Vec3(at.x, at.y, at.z).floored(), false)
  return !!block && climbable.has(block.name)
}
export interface ClimbColumn { x: number; z: number; bottom: number; top: number }
/** A complete loaded tag column; unknown cells and exhausted observation budgets refuse. */
export function climbColumn(world: CollisionWorld, at: Point, cancelled?: () => boolean, maxMs = 180): ClimbColumn | null {
  const bounds = world.game
  if (!bounds || !Number.isSafeInteger(bounds.minY) || !Number.isSafeInteger(bounds.height) || bounds.height <= 0) return null
  const x = Math.floor(at.x); const z = Math.floor(at.z); const bottom = Math.floor(at.y)
  if (bottom < bounds.minY || bottom >= bounds.minY + bounds.height) return null
  const began = performance.now(); const budget = Number.isFinite(maxMs) ? Math.max(0, Math.min(180, maxMs)) : 180
  for (let y = bottom; y < bounds.minY + bounds.height && y - bottom < NODE_LIMIT; y++) {
    if (cancelled?.() || performance.now() - began >= budget) return null
    const block = world.blockAt(new Vec3(x, y, z), false)
    if (!block) return null
    if (!climbable.has(block.name)) return y > bottom ? { x, z, bottom, top: y } : null
  }
  return null
}
function climbConnection(world: CollisionWorld, from: Point, to: Point, levels: readonly number[], columnAt: (at: Point) => ClimbColumn | null): Point | undefined {
  if (distance(from, to) > 6) return
  // A short ordinary jump can catch a column beside the upper support. Keep
  // that contact as part of the edge; its feet need not start on the column.
  for (let x = Math.floor(to.x) - 1; x <= Math.floor(to.x) + 1; x++) for (let z = Math.floor(to.z) - 1; z <= Math.floor(to.z) + 1; z++) {
    if (Math.hypot(x + .5 - from.x, z + .5 - from.z) > 6 || Math.hypot(x + .5 - to.x, z + .5 - to.z) > 1.8) continue
    for (let bottom = Math.floor(from.y); bottom <= Math.floor(from.y + 1.25); bottom++) {
      const column = columnAt({ x, y: bottom, z })
      if (column && column.top >= Math.floor(to.y) && bottom < Math.floor(to.y)) {
        const contact = { x: x + .5, y: bottom, z: z + .5 }
        if (!bodyClear(world, contact)) continue
        // A tagged column behind a closed shape enclosure is not an approach.
        // Keep side detours and observed low tops reachable by the existing
        // jump bound; only the later native forecast proves a 3D trajectory.
        if (detour(world, from, contact, 0)(from).reachable || levels.some(y => y >= Math.max(from.y, contact.y) && y <= from.y + 1.25 &&
          detour(world, { ...from, y }, { ...contact, y }, 0, y)(from).reachable)) return contact
      }
    }
  }
}

/** A loaded collision graph chooses waypoints; native physics verifies each edge. */
export async function supportRoute(world: CollisionWorld, start: Point, goal: Point, blocked: ReadonlySet<string>, radius = 14, diagnostics?: RoutingDiagnostics, reboundCeilings?: ReadonlyMap<string, number>, cancelled?: () => boolean, maxFallDamage = 0): Promise<LandingOption[]> {
  const cells = new Map<string, ReturnType<CollisionWorld['blockAt']>>()
  const observed = world
  world = { physics: observed.physics, game: observed.game, blockAt(p) {
    const cell = p.floored(); const key = `${cell.x},${cell.y},${cell.z}`
    if (!cells.has(key)) cells.set(key, observed.blockAt(cell, false))
    return cells.get(key)
  } }
  const nodes: LandingOption[] = [{ target: new Vec3(start.x, start.y, start.z), key: keyOf(start), score: 0, support: 'current' }]
  const buckets = new Map<string, number[]>()
  const seen = new Set<string>(); const upper = 8
  const began = performance.now(); let yieldedMs = 0; let slice = began + .25
  const finish = (result: LandingOption[]) => {
    if (diagnostics) { diagnostics.wallMs = performance.now() - began; diagnostics.workMs = diagnostics.wallMs - yieldedMs; diagnostics.nodes = nodes.length }
    return result
  }
  const yieldClock = async () => {
    const at = performance.now(); await new Promise<void>(resolve => setImmediate(resolve))
    yieldedMs += performance.now() - at; slice = performance.now() + .25
  }
  const addPositions = (positions: readonly Vec3[], limit = Infinity) => {
    const tops = new Map<number, Vec3>()
    for (const at of positions) {
      const old = tops.get(at.y)
      const center = { x: Math.floor(at.x) + .5, y: at.y, z: Math.floor(at.z) + .5 }
      if (!old || distance(at, center) < distance(old, center)) tops.set(at.y, at)
    }
    for (const target of tops.values()) {
      if (nodes.length >= limit) break
      const key = keyOf(target)
      if (seen.has(key) || distance(start, target) < .25) continue
      const support = supportAt(world, target, .04)
      if (!support) continue
      seen.add(key); const index = nodes.length
      nodes.push({ target, key, score: 0, support: support.block.name })
      const bucket = `${Math.floor(target.x)},${Math.floor(target.z)}`
      const values = buckets.get(bucket) ?? []; values.push(index); buckets.set(bucket, values)
    }
  }
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue
    if (cancelled?.()) return finish([])
    if (performance.now() > slice) { await yieldClock(); if (cancelled?.()) return finish([]) }
    const positions = standPositions(world, { x: Math.floor(start.x) + dx, y: start.y, z: Math.floor(start.z) + dz }, { rise: upper, drop: 12 })
    // A block may have many overlapping collision boxes. Keep one stable
    // central position per top; narrow shapes still retain their actual center.
    addPositions(positions)
  }
  const columns = new Map<string, ClimbColumn | null>()
  const columnAt = (at: Point) => {
    const key = `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`
    if (!columns.has(key)) columns.set(key, climbColumn(world, at, cancelled))
    return columns.get(key) ?? null
  }
  // Extend only already observed tag columns, not the ordinary vertical scan.
  const entries = new Map<string, Point>()
  for (const block of cells.values()) if (block && climbable.has(block.name)) {
    const key = `${block.position.x},${block.position.z}`; const old = entries.get(key)
    if (!old || block.position.y < old.y) entries.set(key, block.position)
  }
  for (const entry of entries.values()) {
    if (cancelled?.()) return finish([])
    if (performance.now() > slice) { await yieldClock(); if (cancelled?.()) return finish([]) }
    const column = columnAt(entry)
    if (!column) continue
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (nodes.length >= NODE_LIMIT) break
      if (cancelled?.()) return finish([])
      addPositions(standPositions(world, { x: column.x + dx, y: column.top, z: column.z + dz }, { rise: 1.25, drop: 1.25 }), NODE_LIMIT)
    }
  }
  const costs = nodes.map((_, i) => i ? Infinity : 0); const parents = nodes.map(() => -1); const modes: Array<'climb' | undefined> = nodes.map(() => undefined); const climbs: Array<Point | undefined> = nodes.map(() => undefined); const bounces: Array<Point | undefined> = nodes.map(() => undefined); const done = new Set<number>()
  const dropClear = new Map<string, boolean>()
  const levels = [...new Set(nodes.map(node => node.target.y))]
  const springs = nodes.filter(node => node.support === 'slime_block')
  const heuristic = (p: Point) => distance(p, goal) + Math.abs(p.y - goal.y) * 2
  let best = 0; let terminal = 0
  for (let expanded = 0; expanded < Math.min(NODE_LIMIT, nodes.length); expanded++) {
    if (cancelled?.()) return finish([])
    if (performance.now() > slice) { await yieldClock(); if (cancelled?.()) return finish([]) }
    if (diagnostics) diagnostics.expanded = expanded + 1
    let index = -1; let score = Infinity
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && costs[i] + heuristic(nodes[i].target) < score) { score = costs[i] + heuristic(nodes[i].target); index = i }
    if (index < 0) break
    done.add(index); const at = nodes[index].target
    if (heuristic(at) < heuristic(nodes[best].target) - .01) best = index
    if (at.distanceTo(new Vec3(goal.x, goal.y, goal.z)) < .8) { terminal = index; break }
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      for (const next of buckets.get(`${Math.floor(at.x) + dx},${Math.floor(at.z) + dz}`) ?? []) {
        if (cancelled?.()) return finish([])
        if (performance.now() > slice) { await yieldClock(); if (cancelled?.()) return finish([]) }
        if (done.has(next) || blocked.has(transitionKey(at, nodes[next].target))) continue
        const to = nodes[next].target; const rise = to.y - at.y; const span = distance(at, to)
        const climbing = rise > 1.25 && climbConnection(world, at, to, levels, columnAt)
        const floor = rise < -3.75 && maxFallDamage === 1 ? supportAt(world, to, .04) : null
        const damage = floor ? landingDamage(floor.block, -rise) : 0
        if (rise > 1.25 && !climbing || rise < -3.75 && (!floor || !hasFallMitigation(floor.block) || damage > maxFallDamage) || span > 6 || span < .15) continue
        if (rise < -3.75) {
          // A mitigating floor below a roof is not a drop entrance. Route to an
          // observed open shaft first; native physics still verifies its edge.
          const key = nodes[next].key + ',' + at.y
          if (!dropClear.has(key)) {
            let clear = true
            for (let y = to.y; y <= at.y && clear; y++) clear = bodyClear(world, { ...to, y })
            dropClear.set(key, clear)
          }
          if (!dropClear.get(key)) continue
        }
        // An exposed partial tread can have a short safe corner approach even
        // when the straight ridge test intersects its neighbouring riser.
        if (!climbing && highRidge(world, at, to) && (clearanceMargin(world, to) > 0 || detour(world, at, to)(at).distance > span + .5)) continue
        // This is a candidate edge, not a claim of reachability. Prefer short
        // steps and actual ascent; the shared native planner rejects obstructions.
        const gap = [.25, .5, .75].some(t => !supportAt(world, { x: at.x + (to.x - at.x) * t, y: at.y + rise * t, z: at.z + (to.z - at.z) * t }, .04))
        const cost = costs[index] + span + .2 + Math.max(0, -rise) * 3 + (gap ? span * span : 0) + damage
        if (cost < costs[next]) { costs[next] = cost; parents[next] = index; modes[next] = climbing ? 'climb' : undefined; climbs[next] = climbing || undefined; bounces[next] = undefined }
      }
    }
    // A slime contact retains native upward momentum. Represent drop, bounce,
    // and the next stable landing as one candidate edge; stopping/crouching on
    // the spring would erase the route's physical continuation.
    for (const spring of springs) {
      const drop = at.y - spring.target.y
      if (drop < 1 || drop > 12 || distance(at, spring.target) > 6) continue
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (const next of buckets.get(`${Math.floor(spring.target.x) + dx},${Math.floor(spring.target.z) + dz}`) ?? []) {
        if (cancelled?.()) return finish([])
        if (performance.now() > slice) { await yieldClock(); if (cancelled?.()) return finish([]) }
        if (done.has(next) || blocked.has(transitionKey(at, nodes[next].target, spring.target))) continue
        const to = nodes[next].target
        if (to.y <= spring.target.y + 1.25 || to.y > at.y + 1.25 || distance(to, spring.target) > 6 || distance(at, to) > 14) continue
        if (to.y > (reboundCeilings?.get(`${keyOf(at)}~${keyOf(spring.target)}`) ?? Infinity)) continue
        const cost = costs[index] + distance(at, spring.target) + distance(spring.target, to) + 2 + (to.y - spring.target.y) * 2
        if (cost < costs[next]) { costs[next] = cost; parents[next] = index; modes[next] = undefined; climbs[next] = undefined; bounces[next] = spring.target }
      }
    }
  }
  let at = terminal || best; const result: LandingOption[] = []
  while (at > 0) { result.push({ ...nodes[at], mode: modes[at], climb: climbs[at], bounce: bounces[at] }); at = parents[at] }
  return finish(result.reverse())
}

export { keyOf as landingKey }
