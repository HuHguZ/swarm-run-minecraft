'use strict'
// Свет замка: места спавна без блочного света (spawnDark) и невидимые блоки света (lightFix).

import * as C from '../arena/colosseum'
import * as LG from '../arena/colosseum-light'
import { st } from './common'

// Места спавна без блочного света (верхний мир: блочный свет 0 — спавн
// возможен при тёмном небе).
function spawnDark (g) {
  const T = LG.tables(g)
  const L = LG.blockLight(g, T)
  const MOBS = [['зомби', 0.6, 1.95], ['паук', 1.4, 0.9]]
  const water = new Set(g.pal.map((s, i) => /^water/.test(s) ? i : -1).filter(i => i >= 0))
  const dark = []; let spots = 0
  for (let y = g.y0 + 1; y < g.y1 - 2; y++) {
    for (let z = g.z0 + 1; z < g.z1; z++) {
      for (let x = g.x0 + 1; x < g.x1; x++) {
        const below = g.data[g.i(x, y - 1, z)]
        if (!T.surface[below]) continue
        const i = g.i(x, y, z)
        const feet = g.data[i]; const head = g.data[g.i(x, y + 1, z)]
        if (T.fullColl[feet] || T.fullColl[head] || water.has(feet)) continue
        if (!MOBS.some(([, w, h]: any) => LG.fits(g, T, x, y, z, w, h))) continue
        spots++
        if (L[i] === 0) dark.push([x, y, z])
      }
    }
  }
  return { spots, dark, L, T }
}

// ============================================================== свет

// Мобы не должны спавниться нигде (как в Колизее). Жилое и дорожки освещены
// фонарями, свечами, люстрами; оставшиеся тёмные места (склоны скалы, газоны,
// чердаки под крышами, верхушки башен) закрываются невидимыми блоками света
// уровня level: в верхнем мире монстру нужен блочный свет 0 — хватает 1, а
// свет 9 ночью почти не заметен глазу. Жадно: первый тёмный — свет в клетку
// над ним (голова, если ноги заняты растением), обновить свет от него, повторить.
function lightFix (g, level) {
  // Уровень 6: свет ≥ 1 в радиусе 5; ночью на скале не отличить от лунного.
  const LS = st('light', { level: String(level), waterlogged: 'false' })
  g.id(LS)
  const { dark, L, T } = spawnDark(g)
  const sx = g.sx; const sxz = g.sx * g.sz
  const DIRS = [[1, 0, 0, 'east'], [-1, 0, 0, 'west'], [0, 1, 0, 'up'], [0, -1, 0, 'down'], [0, 0, 1, 'south'], [0, 0, -1, 'north']]
  const OPPD = { east: 'west', west: 'east', up: 'down', down: 'up', south: 'north', north: 'south' }
  const raise = (i0, lv) => {
    L[i0] = Math.max(L[i0], lv)
    const q = [i0]
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi]; const l = L[i]
      if (l <= 1) continue
      const x: any = i % sx; const zz: any = Math.floor(i / sx) % g.sz; const y: any = Math.floor(i / sxz)
      const sv = g.data[i]
      for (const [dx, dy, dz, dn] of (DIRS as Array<any>)) {
        const nx = x + dx; const ny = y + dy; const nz = zz + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= g.sy || nz >= g.sz) continue
        const j = i + dx + dz * sx + dy * sxz
        const tv = g.data[j]
        const pl = l - T.opacity[tv]
        if (pl <= L[j]) continue
        const fa = T.occ[sv] ? C.faceBits(T.occ[sv], dn) : 0
        const fb = T.occ[tv] ? C.faceBits(T.occ[tv], OPPD[dn]) : 0
        if ((fa | fb) === 15) continue
        L[j] = pl
        q.push(j)
      }
    }
  }
  let placed = 0
  for (const [x, y, z] of dark) {
    if (L[g.i(x, y, z)] > 0) continue
    const feet = g.get(x, y, z); const head = g.get(x, y + 1, z)
    // Свет — только в пустую клетку: ноги, голова или соседняя (в проёме
    // двери обе заняты дверью — не затирать её).
    let at = !feet ? [x, y, z] : !head ? [x, y + 1, z] : null
    if (!at) {
      for (const [dx, dy, dz] of [[0, 2, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
        if (g.in(x + dx, y + dy, z + dz) && !g.get(x + dx, y + dy, z + dz)) { at = [x + dx, y + dy, z + dz]; break }
      }
    }
    if (!at) continue
    g.set(at[0], at[1], at[2], LS)
    raise(g.i(at[0], at[1], at[2]), level)
    placed++
  }
  return placed
}

export { spawnDark, lightFix }
