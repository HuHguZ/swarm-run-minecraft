'use strict'
// Замок-собор на скале в море (просьба 2026-09-28: «замок средневековый
// красивый… европейский церковный стиль, у них очень красивые рельефные
// виды… замок-собор; внутри декор и всё продумано, как в настоящем замке, и
// в нём реально можно жить; склады с сундуками, что раньше в замках
// находилось»). Образ — Мон-Сен-Мишель: скала-остров, дамба, нижний город у
// воды, дворец на террасе, готический собор на вершине.
//
// Чистая функция: параметры → воксельная модель (Grid из colosseum.js) →
// команды (/fill жадными параллелепипедами, малярный порядок colosseum.js).
// Оси: x — восток, z — юг, y — вверх; (0, 0, 0) — середина острова; y = 0 —
// первый слой воздуха над морем (вода — до y = −1 включительно).
//
// Ярусы (уровень пола — первая клетка воздуха над полом):
//   море, отмели, дамба с юга → ворота в морской стене → S0 = 2: нижний
//   город (конюшня, кузница, пекарня, дом, колодец на площади, таверна,
//   лавка) → большая лестница вдоль подпорной стены → S1 = 16: терраса с
//   садом перед дворцом → дворец (этажи 16, 23, 30) с винтовой башней →
//   S2 = 30: вершина — собор: запад — две башни, портал и роза; неф на
//   аркбутанах, трансепт с розами, хор с обходом; над средокрестием башня и
//   шпиль (~96); по краю вершины — куртина с башнями. Западная лестница
//   ведёт с террасы на вершину.
//   В скале под вершиной — погреба с выходом из дворца: склад, винный погреб,
//   сокровищница (этаж 23), темница и цистерна (этаж 16).
//
// Здесь — рельеф и сборка (model); части рядом: common (палитры, ярусы, башня),
// town (море и нижний город), palace (терраса, дворец, куртина), cathedral,
// light (свет), commands (команды), kit (воксельные инструменты).


import * as C from '../arena/colosseum'
import * as K from './kit'
import { st, fbm, vnoise, vnoise3, hash, DEFAULTS, LV, ZC, DISK, smoothstep, summitSd, zoneAt, PAL, CAT, roundTower, tree } from './common'
import { lightFix } from './light'
import { commands, entityCommands, footprint } from './commands'
import { buildCellars, buildSeaWall, buildGate, buildTrap, buildTown, furnishCellars } from './town'
import { buildGrandStair, buildTerraceS1, buildPalace, buildWestStair, buildSummitWalls } from './palace'
import { buildCathedral, furnishCathedral } from './cathedral'

function model (opts: any = {} as Record<string, any>) {
  const p = { ...DEFAULTS, ...opts }
  const g = new C.Grid(-72, 72, -18, 112, -70, 70)
  const B = K.kit(g)
  const S = B.S; const G = B.G
  const seed = p.seed
  const ctx: Record<string, any> = { p, g, B }

  // ============================================================ рельеф
  const NX = g.sx; const NZ = g.sz
  const Hn = new Int16Array(NX * NZ).fill(-999) // естественная высота (верхний блок)
  const H = new Int16Array(NX * NZ).fill(-999) // итоговая
  const Z = new Array(NX * NZ).fill(null) // зона
  const idx = (x, z) => (x - g.x0) * NZ + (z - g.z0)
  const inDisk = (x, z) => Math.hypot(x, z) <= DISK
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      if (!inDisk(x, z)) continue
      const sd = summitSd(x, z)
      let h
      if (sd <= 0) h = LV.S2 - 1
      else {
        const south = smoothstep((z - 6) / 16) * (1 - smoothstep((Math.abs(x + 2) - 44) / 10))
        const D = 12 + 7 * fbm(x * 0.05, z * 0.05, seed) + 25 * south
        const t = Math.min(1.25, sd / D)
        h = (LV.S2 - 1) - 34 * Math.pow(t, 0.78)
        h += (fbm(x * 0.11, z * 0.11, seed + 5) - 0.5) * 9 * (1 - 0.6 * south) * Math.min(1, sd / 3)
        h += (fbm(x * 0.3, z * 0.3, seed + 6) - 0.5) * 3 * Math.min(1, sd / 3)
        // Уступы: местами высота «прилипает» к кратным 4 (слои породы).
        const q = Math.round(h / 4) * 4
        const k = smoothstep((fbm(x * 0.07, z * 0.07, seed + 8) - 0.45) / 0.2)
        h = h * (1 - 0.3 * k) + q * 0.3 * k
      }
      // Дно моря.
      const r = Math.hypot(x, z)
      const bed = -4 - 9 * smoothstep((r - 36) / 30) + (fbm(x * 0.08, z * 0.08, seed + 3) - 0.5) * 4
      h = Math.max(h, bed)
      // Отмели: песчаные косы у подножия на юге и востоке.
      const fl = fbm(x * 0.045, z * 0.045, seed + 9)
      if (h < -1 && r < 62 && fl > 0.56 && (z > -10 || x > 20)) h = Math.max(h, fl > 0.63 ? -1 : -2)
      Hn[idx(x, z)] = Math.round(h)
    }
  }
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const i = idx(x, z)
      if (Hn[i] === -999) continue
      const zn = zoneAt(x, z)
      Z[i] = zn
      H[i] = zn ? zn.top : Hn[i]
    }
  }
  const Hat = (x, z) => (x < g.x0 || x > g.x1 || z < g.z0 || z > g.z1) ? -999 : H[idx(x, z)]
  ctx.Hat = Hat
  ctx.zoneAt = (x, z) => (x < g.x0 || x > g.x1 || z < g.z0 || z > g.z1) ? null : Z[idx(x, z)]

  // Породы: пласты по высоте с шумом; мох и трава на пологом.
  const rockAt = (x, y, z) => {
    const n = vnoise3(x * 0.15, y * 0.35, z * 0.15, seed + 21)
    const band = y + (vnoise(x * 0.04, z * 0.04, seed + 22) - 0.5) * 10
    if (band < -2) return n > 0.6 ? 'tuff' : 'stone'
    if (n > 0.72) return 'andesite'
    if (n < 0.18) return 'tuff'
    if (((Math.floor(band / 5) % 3) + 3) % 3 === 1 && n > 0.45) return 'andesite'
    if (n > 0.66 && n <= 0.72) return 'cobblestone'
    return 'stone'
  }
  const slopeAt = (x, z) => {
    const h = Hat(x, z); let s = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = Hat(x + dx, z + dz); if (n !== -999) s = Math.max(s, Math.abs(h - n)) }
    return s
  }
  const masonry = (x, y, z) => {
    const n = hash(x, y, z, seed + 31)
    if (y < 6 && n < 0.35) return 'mossy_stone_bricks'
    if (n < 0.08) return 'cracked_stone_bricks'
    if (n < 0.16) return 'mossy_stone_bricks'
    return 'stone_bricks'
  }
  ctx.masonry = masonry
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const i = idx(x, z)
      const h = H[i]
      if (h === -999) continue
      for (let y = g.y0; y <= h; y++) S(x, y, z, 'stone')
      const zn = Z[i]
      if (zn) continue // площадки мостятся ниже
      const sl = slopeAt(x, z)
      for (let y = Math.max(g.y0, h - 8); y <= h; y++) S(x, y, z, rockAt(x, y, z))
      if (h <= 0) {
        // Пляж и дно: песок, местами гравий и глина.
        const n = fbm(x * 0.2, z * 0.2, seed + 41)
        const top = h < -3 && n > 0.62 ? 'gravel' : h < -2 && n < 0.3 ? 'clay' : 'sand'
        S(x, h, z, top); S(x, h - 1, z, top === 'clay' ? 'clay' : 'sand')
      } else if (sl <= 1 && h >= 3) {
        S(x, h, z, 'grass_block[snowy=false]'); S(x, h - 1, z, 'dirt'); S(x, h - 2, z, 'dirt')
      } else if (sl <= 2 && h >= 2) {
        const n = hash(x, h, z, seed + 43)
        S(x, h, z, n < 0.45 ? 'moss_block' : n < 0.7 ? 'mossy_cobblestone' : rockAt(x, h, z))
      }
    }
  }
  // Вода.
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const h = H[idx(x, z)]
      if (h === -999) continue
      for (let y = h + 1; y <= -1; y++) S(x, y, z, 'water')
    }
  }
  // Площадки: мощение и подпорные края (где снаружи ниже).
  const edges = []
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const i = idx(x, z); const zn = Z[i]
      if (!zn) continue
      let low = Infinity
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = ctx.zoneAt(x + dx, z + dz); const hn = Hat(x + dx, z + dz)
        if (j === zn) continue
        if (hn !== -999 && hn < zn.top - 1) low = Math.min(low, hn)
      }
      if (low !== Infinity) {
        for (let y = Math.max(g.y0, low - 1); y <= zn.top; y++) S(x, y, z, masonry(x, y, z))
        edges.push({ x, z, zn })
      }
    }
  }
  // Мостовая площадок.
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const zn = Z[idx(x, z)]
      if (!zn || zn.name === 'palace') continue
      const n = hash(x, 0, z, seed + 51)
      S(x, zn.top, z, n < 0.55 ? 'stone_bricks' : n < 0.75 ? 'cobblestone' : n < 0.9 ? 'andesite' : 'mossy_cobblestone')
    }
  }
  ctx.edges = edges

  // ============================================================ постройки
  buildCellars(ctx)
  buildSeaWall(ctx)
  buildGate(ctx)
  buildTown(ctx)
  buildGrandStair(ctx)
  buildTerraceS1(ctx)
  buildPalace(ctx)
  buildWestStair(ctx)
  buildSummitWalls(ctx)
  buildCathedral(ctx)
  furnishCathedral(ctx)
  furnishCellars(ctx)
  buildTrap(ctx)
  vegetation(ctx, { H, Z, idx })

  C.finishShapes(g)
  const lights = p.light === false ? 0 : lightFix(g, p.lightLevel || 6)
  const stats = { blocks: 0, lights }
  for (let i = 0; i < g.data.length; i++) if (g.data[i] && g.pal[g.data[i]] !== 'water') stats.blocks++
  return { p, g, stats, armorStands: ctx.armorStands || [], doors: B.doors }
}

// ---------------------------------------------------------- растительность

function vegetation (ctx, { H, Z, idx }: any) {
  const { B, g } = ctx
  const seed = ctx.p.seed
  const flowers = ['poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'azure_bluet', 'allium']
  // У дверей — чисто: ни кустов, ни цветов в двух шагах.
  const nearDoor = new Set()
  for (const d of B.doors) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) nearDoor.add(`${d.x + dx},${d.z + dz}`)
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const i = idx(x, z)
      const h = H[i]
      if (h === -999 || Z[i]) continue
      if (!/^grass_block/.test(B.G(x, h, z)) || B.G(x, h + 1, z)) continue
      if (nearDoor.has(`${x},${z}`)) continue
      const n = hash(x, h, z, seed + 61)
      const wood = fbm(x * 0.06, z * 0.06, seed + 71) > 0.5 && h > 2
      const parvis = summitSd(x, z) <= 1 && (x < CAT.xW + 1 || z > 9) // паперть и проход у дворца — без деревьев
      if (!parvis && n < (wood ? 0.07 : 0.02) && B.G(x, h + 4, z) === '' && B.G(x + 2, h + 3, z) === '' && B.G(x - 2, h + 3, z) === '') tree(B, x, h + 1, z, n < 0.035 ? 'oak' : 'spruce', 4 + Math.floor(n * 1000) % 3)
      else if (n < 0.32) B.S(x, h + 1, z, 'short_grass')
      else if (n < 0.38) B.S(x, h + 1, z, flowers[Math.floor(n * 1000) % flowers.length])
      else if (n < 0.42) B.S(x, h + 1, z, st('oak_leaves', { distance: '1', persistent: 'true', waterlogged: 'false' }))
    }
  }
}

export { DEFAULTS, LV, ZC, DISK, model, commands, entityCommands, footprint, roundTower, PAL, CAT }
