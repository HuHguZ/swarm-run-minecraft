const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { FLY_H }: typeof import('./consts') = require('./consts')
const { headroom }: typeof import('./physics') = require('./physics')

// Под перекрытием сначала к видимому просвету, затем вверх в фактически достигнутой колонке.
export function ceilingExit(W, from, inside) {
  from = from.clone()
  const room = headroom(W, from, 4)
  if (room >= 4) return null
  let opening = null, lifting = false, distance = Infinity
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    const q = new Vec3(Math.floor(from.x) + dx + .5, from.y, Math.floor(from.z) + dz + .5)
    const d = q.distanceTo(from)
    if (d > 10 || d >= distance || !inside(q) || headroom(W, q, 4) <= room) continue
    const steps = Math.max(1, Math.ceil(d / .45))
    let clear = true
    for (let i = 1; i <= steps && clear; i++) {
      const at = from.plus(q.minus(from).scaled(i / steps))
      clear = inside(at) && !W.boxHit(at.x, at.y, at.z, FLY_H)
    }
    if (clear) { opening = q; distance = d }
  }
  if (!opening) return null
  return (me, floorY, cruiseY, minY) => {
    if (me.y >= floorY + .6) opening = null
    if (!opening) return null
    if (!lifting && headroom(W, new Vec3(me.x, from.y, me.z), 4) > room) {
      opening = new Vec3(me.x, from.y, me.z)
      lifting = true
    }
    return { kind: 'point', reach: true, at: lifting ? new Vec3(opening.x, cruiseY, opening.z) : opening,
      minY: lifting ? cruiseY : minY }
  }
}
