'use strict'
// Колизей (часть colosseum.ts): модель целиком — каркас (frame), этапы постройки по порядку (stages), навесное,
// формы по правилам игры (shapes) и счёт блоков.
import { frame } from './frame'
import { MAT, field, parapetSeams, cavea, facade, parapetLamps, vomitoria, gates, loges } from './stages'
import { finishShapes } from './shapes'
import { parse, isFullCube, isStairs, octMask, faceBits } from './blocks'
import { ATTACHED } from './commands'

function model (opts: any = {} as Record<string, any>) {
  const ctx = frame(opts)
  const { p, g, S, stats, attached } = ctx
  field(ctx)
  parapetSeams(ctx)
  cavea(ctx)
  facade(ctx)
  parapetLamps(ctx)
  vomitoria(ctx)
  gates(ctx)
  const boxes = loges(ctx)

  for (const [x, y, z, s, nbt] of attached) { S(x, y, z, s); if (nbt) g.nbt.set(g.i(x, y, z), nbt) }
  // hideFill(g, cols, p) — хуже: засыпка и так сливается между рядами малярным порядком
  finishShapes(g)
  stats.blocks = 0
  for (let i = 0; i < g.data.length; i++) if (g.data[i]) stats.blocks++
  return { p, g, stats, boxes, pulvinar: boxes[0], attachedKeys: new Set(attached.map(([x, y, z]: any) => g.i(x, y, z))) }
}

// Скрытая засыпка кавеи (ни одной видимой грани) — тем же блоком, что стоит
// над ней в колонке (ступень ряда, пол пояса, пол террасы): колонка ряда
// ставится одним параллелепипедом вместо двух. Видимые грани (стены галерей,
// тоннели, ложи) остаются гладким песчаником.
function hideFill (g, cols, p) {
  const fill = g.palIdx.get(MAT.fill)
  if (fill === undefined) return
  const shown = (s, dir) => { // закрывает ли сосед нашу грань целиком
    if (!s) return true
    if (isFullCube(s)) return false
    if (isStairs(s)) return faceBits(octMask(s), dir) !== 15
    return true
  }
  const nb = [[1, 0, 0, 'west'], [-1, 0, 0, 'east'], [0, 0, 1, 'north'], [0, 0, -1, 'south'], [0, 1, 0, 'down'], [0, -1, 0, 'up']]
  const change = []
  for (const c of cols.values()) {
    if (c.k < 1 || c.k > p.K.m3[1]) continue
    for (let y = g.y0 + 1; y < g.y1; y++) {
      if (g.data[g.i(c.x, y, c.z)] !== fill) continue
      if (nb.some(([dx, dy, dz, face]: any) => shown(g.get(c.x + dx, y + dy, c.z + dz), face))) continue
      let yy = y + 1
      while (yy <= g.y1 && g.data[g.i(c.x, yy, c.z)] === fill) yy++
      const cap = g.get(c.x, yy, c.z)
      if (cap && (isFullCube(cap) || isStairs(cap)) && !ATTACHED.test(parse(cap).name) && !/(glowstone|shroomlight|lantern|obsidian)/.test(cap)) change.push([c.x, y, c.z, cap])
    }
  }
  for (const [x, y, z, s] of change) g.set(x, y, z, s)
}

export { model }
