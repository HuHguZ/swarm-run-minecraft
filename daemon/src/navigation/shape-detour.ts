import { Vec3 } from 'vec3'
import { bodyClear, dimensions, shapeBoxes, type CollisionWorld, type Point } from './geometry'
const flat = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z)

export function clearanceMargin(geometry: CollisionWorld, target: Point, requested = .03): number {
  const { half, height } = dimensions(geometry)
  return requested && !bodyClear({ blockAt: p => geometry.blockAt(p, false), physics: { playerHalfWidth: half + requested, playerHeight: height } }, target) ? 0 : requested
}

export function detour(geometry: CollisionWorld, start: Point, target: Point, margin = .03, feetY = Math.max(start.y, target.y) + .15): (at: Point) => { distance: number; waypoint: Point; reachable: boolean } {
  const { half, height } = dimensions(geometry)
  margin = clearanceMargin(geometry, target, margin)
  const y = feetY
  const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = []
  const rectangles = new Set<string>()
  for (let x = Math.floor(Math.min(start.x, target.x) - 2); x <= Math.ceil(Math.max(start.x, target.x) + 2); x++) {
    for (let z = Math.floor(Math.min(start.z, target.z) - 2); z <= Math.ceil(Math.max(start.z, target.z) + 2); z++) {
      for (let by = Math.floor(y) - 1; by <= Math.floor(y + height); by++) {
        const block = geometry.blockAt(new Vec3(x, by, z), false)
        if (!block) continue
        for (const box of shapeBoxes(block)) if (box.maxY > y && box.minY < y + height) {
          const rect = { minX: box.minX - half - margin, maxX: box.maxX + half + margin, minZ: box.minZ - half - margin, maxZ: box.maxZ + half + margin }
          const key = `${rect.minX},${rect.maxX},${rect.minZ},${rect.maxZ}`
          if (!rectangles.has(key)) { rectangles.add(key); boxes.push(rect) }
        }
      }
    }
  }
  const visible = (a: Point, b: Point) => !boxes.some(box => {
    let lo = 0; let hi = 1
    for (const [av, bv, min, max] of [[a.x, b.x, box.minX, box.maxX], [a.z, b.z, box.minZ, box.maxZ]]) {
      const delta = bv - av
      if (Math.abs(delta) < 1e-9) { if (av <= min + 1e-6 || av >= max - 1e-6) return false }
      else { const t1 = (min - av) / delta; const t2 = (max - av) / delta; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)) }
    }
    return lo < hi - 1e-6
  })
  const points: Point[] = [target]
  const corners = new Set<string>([`${target.x},${target.z}`])
  for (const b of boxes) for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) {
    const p = { x, y, z }
    const key = `${x},${z}`
    if (!corners.has(key) && !boxes.some(b => x > b.minX + 1e-6 && x < b.maxX - 1e-6 && z > b.minZ + 1e-6 && z < b.maxZ - 1e-6)) { corners.add(key); points.push(p) }
  }
  const distances = points.map((_, i) => i === 0 ? 0 : Infinity); const done = new Set<number>()
  for (let count = 0; count < points.length; count++) {
    let index = -1
    for (let i = 0; i < points.length; i++) if (!done.has(i) && (index < 0 || distances[i] < distances[index])) index = i
    if (index < 0 || !Number.isFinite(distances[index])) break
    done.add(index)
    for (let i = 0; i < points.length; i++) if (!done.has(i) && visible(points[index], points[i])) distances[i] = Math.min(distances[i], distances[index] + flat(points[index], points[i]))
  }
  return at => {
    let distance = Infinity; let waypoint = target
    for (let i = 0; i < points.length; i++) if (visible(at, points[i])) {
      const cost = flat(at, points[i]) + distances[i]
      if (cost < distance) { distance = cost; waypoint = points[i] }
    }
    return { distance: Number.isFinite(distance) ? distance : flat(at, target) + 4, waypoint, reachable: Number.isFinite(distance) }
  }
}
