export interface CoverPoint { x: number; y: number; z: number }
export interface CoverRecord {
  site: string; dimension: 'the_nether'; at: number; entry: CoverPoint; own: string[]
}
export interface CoverGeometry {
  site: string; dimension: string; now: number; position: CoverPoint
  air(point: CoverPoint): boolean
  firm(point: CoverPoint): boolean
  closed(own: Set<string>): boolean
}
export interface CoverBreach { at: string; open: string; c: string }
const limit = 4000
const lifetimeMs = 3600000
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
  ? value as Record<string, unknown> : null
const point = (value: unknown): CoverPoint | null => {
  const p = object(value)
  if (!p || !['x', 'y', 'z'].every(axis => typeof p[axis] === 'number' && Number.isFinite(p[axis]))) return null
  return { x: p.x as number, y: p.y as number, z: p.z as number }
}
const cell = (key: unknown): CoverPoint | null => {
  if (typeof key !== 'string' || !/^-?\d+,-?\d+,-?\d+$/.test(key)) return null
  const [x, y, z] = key.split(',').map(Number)
  return [x, y, z].every(Number.isSafeInteger) ? { x, y, z } : null
}
const key = (p: CoverPoint) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

export function protectedGeometry(position: CoverPoint, own: Set<string>, breaches: readonly CoverBreach[],
  air: (point: CoverPoint) => boolean, firm: (point: CoverPoint) => boolean): boolean {
  if (!breaches.length) return true
  const mouth = { x: Math.floor(position.x), y: Math.floor(position.y) + 2, z: Math.floor(position.z) }
  if (!air(mouth) || !firm({ ...mouth, y: mouth.y + 1 })) return false
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ ...mouth, x: mouth.x + dx, z: mouth.z + dz }))
  const openings = sides.filter(side => air(side))
  if (openings.length !== 1 || sides.some(side => key(side) !== key(openings[0]) && !firm(side))) return false
  const opening = openings[0]
  if (!firm({ ...opening, y: opening.y - 1 })) return false
  const head = { ...mouth, y: mouth.y - 1 }
  const safe = breaches.every(breach => breach.c === 'air' &&
    (breach.at === key(mouth) && breach.open === key(opening) || breach.at === key(head) && breach.open === key(mouth)))
  if (safe) own.add(key(mouth))
  return safe
}

export function recognizeCover(cells: Iterable<unknown>, geometry: CoverGeometry): { own: Set<string>; entry: CoverPoint } | null {
  if (geometry.dimension !== 'the_nether') return null
  const feet = { x: Math.floor(geometry.position.x), y: Math.floor(geometry.position.y), z: Math.floor(geometry.position.z) }
  const nearest = [...cells].flatMap(value => { const p = cell(value); return p ? [{ value: value as string, p }] : [] })
    .sort((a, b) => Math.abs(a.p.x - feet.x) + Math.abs(a.p.y - feet.y) + Math.abs(a.p.z - feet.z) -
      Math.abs(b.p.x - feet.x) - Math.abs(b.p.y - feet.y) - Math.abs(b.p.z - feet.z)).slice(0, limit)
  const own = new Set(nearest.filter(({ p }) => geometry.air(p)).map(({ value }) => value))
  if (!own.has(key(feet)) || !own.has(key({ ...feet, y: feet.y + 1 })) ||
    !geometry.firm({ ...feet, y: feet.y - 1 }) || !geometry.closed(own)) return null
  return { own, entry: feet }
}

export function coverRecord(site: string, dimension: string, at: number, own: Iterable<unknown>, entry: unknown): CoverRecord | null {
  const origin = point(entry)
  const cells = [...own].filter((value): value is string => !!cell(value)).slice(-limit)
  if (!origin || dimension !== 'the_nether' || !Number.isFinite(at) || !cells.length) return null
  return { site, dimension, at, own: cells, entry: origin }
}

export function restoreCover(value: unknown, geometry: CoverGeometry): { own: Set<string>; entry: CoverPoint } | null {
  const saved = object(value)
  const entry = point(saved?.entry)
  if (!saved || !entry || saved.site !== geometry.site || saved.dimension !== 'the_nether' || geometry.dimension !== 'the_nether' ||
    typeof saved.at !== 'number' || geometry.now < saved.at || geometry.now - saved.at > lifetimeMs ||
    !Array.isArray(saved.own) || saved.own.length > limit) return null
  return recognizeCover(saved.own, geometry)
}

export function storeCover(records: unknown, record: CoverRecord): Record<string, CoverRecord> {
  const valid = Object.entries(object(records) ?? {}).filter((entry): entry is [string, CoverRecord] => {
    const value = object(entry[1])
    return value !== null && typeof value.at === 'number' && Array.isArray(value.own) && !!point(value.entry)
  })
  return Object.fromEntries([...valid.filter(([site]) => site !== record.site), [record.site, record] as [string, CoverRecord]]
    .sort((a, b) => b[1].at - a[1].at).slice(0, 8))
}
