'use strict'
// Рельеф в бою: где лава и ямы, и не сидит ли кто в яме, из которой не
// выпрыгнуть (прыжок поднимает на 1.25 — стенка в 2 блока уже тюрьма).
// Нужно для позиционной войны: столкнуть в лаву или яму, самому не стоять к
// ним спиной, выбраться из ямы, запереть в ней другого.

const Vec3: typeof import('vec3').Vec3 = require('vec3')

const AIRY = /^(air|cave_air|void_air|water|cobweb|short_grass|tall_grass|fern)$/

function nameAt (bot, p) {
  const b = bot.blockAt(p)
  return b ? b.name : null
}
function solidAt (bot, p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block'
}

// Опасные клетки вокруг center (в радиусе, на уровне пола под ногами):
// лава в полу и ямы (дыра в полу глубиной от 2). {pos, kind, depth}
function hazardsNear (bot, center, radius = 3) {
  const out = []
  const c = center.floored()
  const fy = c.y - 1
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue
      const p = new Vec3(c.x + dx, fy, c.z + dz)
      const n = nameAt(bot, p)
      if (!n) continue
      if (n === 'lava') { out.push({ pos: p, kind: 'лава', depth: 1 }); continue }
      // Паутина на полу этой клетки (у ног или головы): удар кинет туда — и
      // ни крита, ни ухода (2026-09-26: боты застревали в брошенной паутине).
      if (nameAt(bot, p.offset(0, 1, 0)) === 'cobweb' || nameAt(bot, p.offset(0, 2, 0)) === 'cobweb') { out.push({ pos: p, kind: 'паутина', depth: 0 }); continue }
      if (!AIRY.test(n)) continue
      // Дыра в полу: сколько пустоты вниз.
      let depth = 0
      let bottom = null
      for (let k = 0; k < 8; k++) {
        const q = p.offset(0, -k, 0)
        const qn = nameAt(bot, q)
        if (qn && AIRY.test(qn)) { depth++; continue }
        bottom = qn
        break
      }
      if (bottom === 'lava') out.push({ pos: p, kind: 'лава', depth: depth + 1 })
      else if (depth >= 2) out.push({ pos: p, kind: 'яма', depth })
    }
  }
  return out
}

// Сидит ли тело с ногами в feet в яме: по четырём сторонам в пределах трёх
// клеток — стена от уровня ног высотой от 2. depth — сколько надо подняться.
function pitTrap (bot, feet) {
  const f = feet.floored()
  let minWall = Infinity
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let wall = null
    for (let k = 1; k <= 3; k++) {
      const cell = f.offset(dx * k, 0, dz * k)
      if (solidAt(bot, cell)) {
        let h = 0
        while (h < 8 && solidAt(bot, cell.offset(0, h, 0))) h++
        wall = h
        break
      }
    }
    if (wall === null || wall < 2) return null
    minWall = Math.min(minWall, wall)
  }
  return { depth: minWall, rimY: f.y + minWall }
}

// Ближайшая к точке опасность и направление на неё.
function nearest (list, from) {
  let best = null
  for (const h of list) {
    const d = Math.hypot(h.pos.x + 0.5 - from.x, h.pos.z + 0.5 - from.z)
    if (!best || d < best.d) best = { ...h, d }
  }
  return best
}

export { hazardsNear, pitTrap, nearest }
