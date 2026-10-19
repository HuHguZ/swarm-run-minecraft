'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as bp from '../blueprint'
import { AIR, FLUID, MADE, V, HORIZ, isSolid, isPassable } from './world'

// Ровное место рядом: пятно L×L, где земля ровная, нет воды и лавы, нет
// чужих построек. Цена — сколько копать и сколько подсыпать плюс дорога.
function pickSurfaceSite (bot, { w, d, h, radius = 16 }: any) {
  const me = bot.entity.position.floored()
  const cols = new Map()
  const column = (x, z) => {
    const k = `${x},${z}`
    if (cols.has(k)) return cols.get(k)
    let top = null; let bad = null; let tree = 0; let made = null
    for (let y = me.y + 14; y >= me.y - 16; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) { bad = 'не прогружено'; break }
      if (AIR.has(b.name)) continue
      if (FLUID.test(b.name)) { bad = b.name; top = y; break }
      if (MADE.test(b.name) && !/_log$/.test(b.name)) { made = b.name; top = y; break }
      if (/_leaves$|_log$|_wood$|_stem$|mushroom_block|bamboo|vine|cactus/.test(b.name)) { tree++; continue }
      if (b.boundingBox !== 'block') continue
      top = y; break
    }
    const r = { top, bad, tree, made }
    cols.set(k, r)
    return r
  }
  let best = null
  const L = Math.max(w, d)
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const x0 = me.x + dx - Math.floor(L / 2); const z0 = me.z + dz - Math.floor(L / 2)
      const hs = []
      let bad = null; let trees = 0
      for (let x = x0 - 1; x <= x0 + L && !bad; x++) {
        for (let z = z0 - 1; z <= z0 + L && !bad; z++) {
          const c = column(x, z)
          const inside = x >= x0 && x < x0 + L && z >= z0 && z < z0 + L
          if (c.bad && (inside || /water|lava/.test(c.bad))) bad = c.bad
          else if (inside && c.made) bad = `тут уже стоит ${c.made}`
          else if (inside) {
            if (c.top === null) bad = 'пропасть'
            hs.push(c.top); trees += c.tree
          }
        }
      }
      if (bad || !hs.length) continue
      const sorted = [...hs].sort((a, b) => a - b)
      const y0 = sorted[Math.floor(sorted.length / 2)]
      if (sorted[sorted.length - 1] - sorted[0] > 4) continue
      let fill = 0; let cut = 0
      for (const t of hs) { if (t < y0) fill += y0 - t; else cut += t - y0 }
      const dist = Math.hypot(x0 + L / 2 - me.x, z0 + L / 2 - me.z)
      const score = cut * 2 + fill + trees * 3 + dist * 0.4
      if (!best || score < best.score) best = { x0, z0, y0, L, fill, cut, trees, dist: Math.round(dist), score }
    }
  }
  return best
}

// Склон под землянку: вход E (где встать), а в сторону d — холм, в котором
// комната целиком в земле и над потолком ещё слой.
function pickHillside (bot, { W, D, H, radius = 12 }: any) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const E = me.offset(dx, dy, dz)
        const f = bot.blockAt(E); const hd = bot.blockAt(E.offset(0, 1, 0)); const fl = bot.blockAt(E.offset(0, -1, 0))
        if (!isPassable(f) || !isPassable(hd) || !isSolid(fl)) continue
        for (const dir of HORIZ) {
          const d = V[dir]
          const side = V[bp.CW[dir]]
          const half = Math.floor(W / 2)
          let total = 0; let rock = 0; let fluid = false; let roof = 0; let roofN = 0
          for (let j = 1; j <= D + 2 && !fluid; j++) {
            for (let l = -half - 1; l <= W - half && !fluid; l++) {
              for (let y = 0; y <= H + 2; y++) {
                const p = E.offset(d.x * j + side.x * l, y, d.z * j + side.z * l)
                const b = bot.blockAt(p)
                if (!b) { fluid = true; break }
                if (FLUID.test(b.name)) { fluid = true; break }
                if (MADE.test(b.name)) { fluid = true; break }
                if (j === 1 && Math.abs(l) === 0 && y <= 1) continue // проём
                total++
                if (isSolid(b)) rock++
                if (y >= H + 1 && j >= 2 && j <= D + 1) { roofN++; if (isSolid(b)) roof++ }
              }
            }
          }
          if (fluid || !total) continue
          const ratio = rock / total
          const roofRatio = roofN ? roof / roofN : 0
          if (ratio < 0.7 || roofRatio < 0.8) continue
          const dist = E.distanceTo(me)
          const score = (1 - ratio) * 40 + (1 - roofRatio) * 30 + dist
          if (!best || score < best.score) best = { E, dir, ratio: +ratio.toFixed(2), roof: +roofRatio.toFixed(2), dist: Math.round(dist), score }
        }
      }
    }
  }
  return best
}

export { pickSurfaceSite, pickHillside }
