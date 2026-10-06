import { Vec3 } from 'vec3'

export interface Point { x: number; y: number; z: number }
export type Shape = readonly [number, number, number, number, number, number]
export interface CollisionBlock { name: string; position: Point; shapes?: readonly Shape[]; boundingBox?: string; type?: number; isWaterlogged?: boolean; getProperties?(): Record<string, string | number | boolean> }
export interface CollisionWorld { blockAt(position: Vec3, extraInfos?: boolean): CollisionBlock | null | undefined; physics?: { playerHalfWidth?: number; playerHeight?: number }; game?: { minY: number; height: number } }
export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
export interface Support { block: CollisionBlock; box: Box; top: number; overlap: number }
const EPS = 1e-7
// A body centred exactly on a riser's edge grazes it by float error (s6-author53/55:
// the server stood the body on the upper stair half, +0.5). Keep a millimetre gap.
const TREAD_GAP = 1e-3
export const HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow|wither_rose|end_portal|end_gateway)$/

export function dimensions(world: CollisionWorld): { half: number; height: number } {
  return { half: world.physics?.playerHalfWidth ?? Math.fround(.6) / 2, height: world.physics?.playerHeight ?? 1.8 }
}
export function shapeBoxes(block: CollisionBlock): Box[] {
  // Real Blocks always supply state-specific shapes. Shape-less legacy fixtures
  // retain their explicit full-block bounding box; an explicit [] stays empty.
  const shapes = block.shapes ?? (block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1] as Shape] : [])
  const p = block.position
  return shapes.map(s => ({ minX: p.x + s[0], minY: p.y + s[1], minZ: p.z + s[2], maxX: p.x + s[3], maxY: p.y + s[4], maxZ: p.z + s[5] }))
}
export function bodyBox(world: CollisionWorld, pos: Point): Box {
  const { half, height } = dimensions(world)
  return { minX: pos.x - half, minY: pos.y, minZ: pos.z - half, maxX: pos.x + half, maxY: pos.y + height, maxZ: pos.z + half }
}
export function intersects(a: Box, b: Box): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS && a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS
}
/** `powder`: a native forecast may pass through powder snow (modelled stuck motion); never a resting body. */
export function bodyClear(world: CollisionWorld, pos: Point, { web = false, water = false, powder = false }: { web?: boolean; water?: boolean; powder?: boolean } = {}): boolean {
  const body = bodyBox(world, pos)
  for (let x = Math.floor(body.minX); x <= Math.floor(body.maxX); x++) {
    for (let z = Math.floor(body.minZ); z <= Math.floor(body.maxZ); z++) {
      for (let y = Math.floor(body.minY) - 1; y <= Math.floor(body.maxY); y++) {
        const block = world.blockAt(new Vec3(x, y, z), false)
        if (!block) return false
        const cell = { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 }
        if (intersects(body, cell) && (HAZARD.test(block.name) && !(powder && block.name === 'powder_snow') || !web && block.name === 'cobweb' || !water && /^(water|bubble_column)$/.test(block.name))) return false
        if (shapeBoxes(block).some(box => intersects(body, box))) return false
      }
    }
  }
  return true
}

/** Y clipping can retain onGround for one frame after horizontal support ends. */
export function groundedHazardClear(world: CollisionWorld, pos: Point, velocityY: number, onGround: boolean): boolean {
  if (!onGround || velocityY >= 0 || supportAt(world, pos, .04)) return true
  // Use the integrator's existing downward velocity, never a tuned fall margin.
  // Native 1.21.11 applies full-body fluid contacts between movement receipts.
  const body = bodyBox(world, { ...pos, y: pos.y + velocityY })
  for (let x = Math.floor(body.minX); x <= Math.floor(body.maxX); x++) for (let z = Math.floor(body.minZ); z <= Math.floor(body.maxZ); z++) for (let y = Math.floor(body.minY); y <= Math.floor(body.maxY); y++) {
    const block = world.blockAt(new Vec3(x, y, z), false)
    if (!block || HAZARD.test(block.name) && intersects(body, { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 })) return false
  }
  return true
}

/** Vanilla upward SELF move, clipped against actual body/shape intersections. */
export function verticalLift(world: CollisionWorld, pos: Point, requested: number): number | null {
  const body = bodyBox(world, pos); let allowed = Math.max(0, requested)
  for (let x = Math.floor(body.minX); x <= Math.floor(body.maxX); x++) for (let z = Math.floor(body.minZ); z <= Math.floor(body.maxZ); z++) {
    for (let y = Math.floor(body.maxY); y <= Math.floor(body.maxY + requested); y++) {
      const block = world.blockAt(new Vec3(x, y, z), false)
      if (!block) return null
      for (const shape of shapeBoxes(block)) {
        if (body.minX >= shape.maxX - EPS || body.maxX <= shape.minX + EPS || body.minZ >= shape.maxZ - EPS || body.maxZ <= shape.minZ + EPS || shape.minY < body.maxY - EPS) continue
        allowed = Math.min(allowed, Math.max(0, shape.minY - body.maxY))
      }
    }
  }
  return allowed
}
export function supportAt(world: CollisionWorld, pos: Point, depth = 3): Support | null {
  const body = bodyBox(world, pos)
  let best: Support | null = null
  for (let x = Math.floor(body.minX + EPS); x <= Math.floor(body.maxX - EPS); x++) {
    for (let z = Math.floor(body.minZ + EPS); z <= Math.floor(body.maxZ - EPS); z++) {
      for (let y = Math.floor(pos.y + EPS); y >= Math.floor(pos.y - depth) - 1; y--) {
        const block = world.blockAt(new Vec3(x, y, z), false)
        if (!block || HAZARD.test(block.name)) continue
        for (const box of shapeBoxes(block)) {
          const ox = Math.min(body.maxX, box.maxX) - Math.max(body.minX, box.minX)
          const oz = Math.min(body.maxZ, box.maxZ) - Math.max(body.minZ, box.minZ)
          if (ox <= EPS || oz <= EPS || box.maxY > pos.y + EPS || pos.y - box.maxY > depth + EPS) continue
          if (!best || box.maxY > best.top || box.maxY === best.top && ox * oz > best.overlap) best = { block, box, top: box.maxY, overlap: ox * oz }
        }
      }
    }
  }
  return best
}

/**
 * Body stand positions supported by one block cell, at every top of its shapes.
 * `complete` is false when a dependency was not loaded; such a result is never cached.
 */
function cellStands(observed: CollisionWorld, x: number, y: number, z: number): { positions: Vec3[]; complete: boolean } {
  let complete = true
  const world: CollisionWorld = { ...observed, blockAt(p, extra) { const block = observed.blockAt(p, extra); if (!block) complete = false; return block } }
  const positions: Vec3[] = []; const seen = new Set<string>()
  const block = world.blockAt(new Vec3(x, y, z), false)
  if (!block || HAZARD.test(block.name)) return { positions, complete }
  const { half, height } = dimensions(world)
  for (const box of shapeBoxes(block)) {
    const center = new Vec3((box.minX + box.maxX) / 2, box.maxY, (box.minZ + box.maxZ) / 2)
    const centerKey = `${center.x},${center.y},${center.z}`
    if (!seen.has(centerKey) && bodyClear(world, center)) { seen.add(centerKey); positions.push(center); continue }
    // An exposed tread or floor edge may sit beside a taller riser or under
    // a rail from a different block. Derive body centers from every observed
    // obstruction in its head space, then require real footprint and clearance.
    const obstructions: Box[] = []
    for (let bx = Math.floor(box.minX - half * 2); bx <= Math.floor(box.maxX + half * 2); bx++) for (let bz = Math.floor(box.minZ - half * 2); bz <= Math.floor(box.maxZ + half * 2); bz++) {
      for (let by = Math.floor(box.maxY) - 1; by <= Math.floor(box.maxY + height); by++) {
        const above = world.blockAt(new Vec3(bx, by, bz), false)
        if (above) obstructions.push(...shapeBoxes(above).filter(shape => shape.maxY > box.maxY + EPS && shape.minY < box.maxY + height))
      }
    }
    const xs = [...new Set([(box.minX + box.maxX) / 2, box.minX + half, box.maxX - half, ...obstructions.flatMap(shape => [shape.minX - half - TREAD_GAP, shape.maxX + half + TREAD_GAP])])]
      .filter(x => x > box.minX - half + .04 && x < box.maxX + half - .04)
    const zs = [...new Set([(box.minZ + box.maxZ) / 2, box.minZ + half, box.maxZ - half, ...obstructions.flatMap(shape => [shape.minZ - half - TREAD_GAP, shape.maxZ + half + TREAD_GAP])])]
      .filter(z => z > box.minZ - half + .04 && z < box.maxZ + half - .04)
    for (const x of xs) {
      for (const z of zs) {
        const p = new Vec3(x, box.maxY, z); const key = `${p.x},${p.y},${p.z}`
        if (!seen.has(key) && supportAt(world, p, .01) && bodyClear(world, p)) { seen.add(key); positions.push(p) }
      }
    }
  }
  return { positions, complete }
}

/**
 * Stand positions in one column whose support top lies within [y - drop, y + rise].
 * `cache` (owned by the caller) keeps per-cell results; the owner must delete a
 * cell's key (`x,y,z`) when a block within one cell sideways, three below or one above changes.
 */
export function standPositions(world: CollisionWorld, cell: Point, { rise = 2, drop = 4 }: { rise?: number; drop?: number } = {}, cache?: Map<string, Vec3[]>): Vec3[] {
  const result: Vec3[] = []
  const seen = new Set<string>(); const x = Math.floor(cell.x); const z = Math.floor(cell.z)
  for (let y = Math.floor(cell.y + rise); y >= Math.floor(cell.y - drop) - 1; y--) {
    const key = `${x},${y},${z}`
    let positions = cache?.get(key)
    if (!positions) {
      const computed = cellStands(world, x, y, z); positions = computed.positions
      if (cache && computed.complete) cache.set(key, positions)
    }
    for (const p of positions) {
      if (p.y > cell.y + rise + EPS || p.y < cell.y - drop - EPS) continue
      const id = `${p.x},${p.y},${p.z}`
      if (!seen.has(id)) { seen.add(id); result.push(p) }
    }
  }
  return result.sort((a, b) => Math.abs(a.y - cell.y) - Math.abs(b.y - cell.y))
}

/** Delete cached stand cells that a block change at `at` can affect (see standPositions). */
export function invalidateStands(cache: Map<string, Vec3[]>, at: Point): void {
  const x = Math.floor(at.x); const y = Math.floor(at.y); const z = Math.floor(at.z)
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 3; dy++) cache.delete(`${x + dx},${y - dy},${z + dz}`)
}

export function containsWater(block: CollisionBlock): boolean {
  return /^(water|flowing_water|bubble_column)$/.test(block.name) || block.isWaterlogged === true || block.getProperties?.().waterlogged === true || block.getProperties?.().waterlogged === 'true'
}

/** Body centers that fit inside one observed fluid cell and its real shapes. */
export function waterEntries(world: CollisionWorld, cell: Point): Vec3[] {
  const block = world.blockAt(new Vec3(cell.x, cell.y, cell.z).floored(), false)
  if (!block || !containsWater(block)) return []
  const p = block.position; const { half } = dimensions(world); const margin = .004
  const xs = [p.x + .5, p.x + half + margin, p.x + 1 - half - margin]
  const zs = [p.z + .5, p.z + half + margin, p.z + 1 - half - margin]
  const ys = [p.y + .04]
  for (const shape of shapeBoxes(block)) {
    xs.push(shape.minX - half - margin, shape.maxX + half + margin)
    zs.push(shape.minZ - half - margin, shape.maxZ + half + margin)
    if (shape.maxY < p.y + .9) ys.push(shape.maxY)
  }
  const result: Vec3[] = []
  for (const x of xs) for (const z of zs) for (const y of ys) {
    if (x - half < p.x + margin - EPS || x + half > p.x + 1 - margin + EPS || z - half < p.z + margin - EPS || z + half > p.z + 1 - margin + EPS) continue
    const at = new Vec3(x, y, z)
    if (bodyClear(world, at, { water: true }) && !result.some(old => old.distanceTo(at) < .001)) result.push(at)
  }
  return result.sort((a, b) => a.y - b.y || distanceToCenter(a) - distanceToCenter(b))
  function distanceToCenter(at: Point) { return Math.hypot(at.x - p.x - .5, at.z - p.z - .5) }
}
