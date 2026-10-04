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

const C = require('./colosseum')
const K = require('./castle-kit')
const { st } = C
const { stairs, slab, wall, fbm, vnoise, vnoise3, hash, DIR, OPP, CW, CCW, dirTo } = K

const DEFAULTS = { seed: 11, cat: 'diorite', version: 1, trap: 'armed' }
// Камень собора: стены, тёсаный (цоколи, пояса), резной (капители), резной
// блок (тимпаны, центры роз), ажур (средники, балюстрады).
const CAT_PAL = {
  tuff: { T: 'tuff_bricks', TP: 'polished_tuff', TC: 'chiseled_tuff', TCB: 'chiseled_tuff_bricks', TW: 'tuff_brick_wall', TPW: 'polished_tuff_wall' },
  diorite: { T: 'polished_diorite', TP: 'smooth_quartz', TC: 'chiseled_quartz_block', TCB: 'chiseled_quartz_block', TW: 'diorite_wall', TPW: 'diorite_wall' },
  endstone: { T: 'end_stone_bricks', TP: 'smooth_sandstone', TC: 'chiseled_sandstone', TCB: 'chiseled_quartz_block', TW: 'end_stone_brick_wall', TPW: 'sandstone_wall' },
  quartz: { T: 'smooth_quartz', TP: 'quartz_block', TC: 'chiseled_quartz_block', TCB: 'quartz_pillar[axis=y]', TW: 'diorite_wall', TPW: 'diorite_wall' },
  stone: { T: 'stone_bricks', TP: 'polished_andesite', TC: 'chiseled_stone_bricks', TCB: 'chiseled_stone_bricks', TW: 'stone_brick_wall', TPW: 'andesite_wall' }
}
const LV = { S0: 2, S1: 16, S2: 30 }
const ZC = -9 // ось собора (z)
const DISK = 68 // радиус модели (море вокруг)

const smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

// Знаковое расстояние до скруглённого прямоугольника (радиусы по углам).
function sdRoundRect (x, z, x0, z0, x1, z1, r) {
  const cx = (x0 + x1) / 2; const cz = (z0 + z1) / 2; const hx = (x1 - x0) / 2; const hz = (z1 - z0) / 2
  const px = x - cx; const pz = z - cz
  const rr = px < 0 ? (pz < 0 ? r.nw : r.sw) : (pz < 0 ? r.ne : r.se)
  const qx = Math.abs(px) - hx + rr; const qz = Math.abs(pz) - hz + rr
  return Math.min(Math.max(qx, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - rr
}

// Плато вершины.
const SUMMIT = { x0: -49, z0: -33, x1: 43, z1: 15, r: { nw: 12, ne: 14, se: 6, sw: 2 } }
const summitSd = (x, z) => sdRoundRect(x, z, SUMMIT.x0, SUMMIT.z0, SUMMIT.x1, SUMMIT.z1, SUMMIT.r)

// Ровные площадки (верх — y блока пола; пол — top + 1).
const ZONES = [
  { name: 'S1', x0: -49, x1: 44, z0: 28, z1: 36, top: LV.S1 - 1, edge: 'crenel' },
  { name: 'palace', x0: -30, x1: 26, z0: 16, z1: 27, top: LV.S1 - 1, edge: null },
  { name: 'S0', x0: -43, x1: 39, z0: 37, z1: 47, top: LV.S0 - 1, edge: null },
  { name: 'landW', x0: -49, x1: -44, z0: 14, z1: 17, top: LV.S2 - 1, edge: 'crenel' }
]
const zoneAt = (x, z) => ZONES.find(q => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) || null

function model (opts = {}) {
  const p = { ...DEFAULTS, ...opts }
  const g = new C.Grid(-72, 72, -18, 112, -70, 70)
  const B = K.kit(g)
  const S = B.S; const G = B.G
  const seed = p.seed
  const ctx = { p, g, B }

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

// ============================================================== свет

// Мобы не должны спавниться нигде (как в Колизее). Жилое и дорожки освещены
// фонарями, свечами, люстрами; оставшиеся тёмные места (склоны скалы, газоны,
// чердаки под крышами, верхушки башен) закрываются невидимыми блоками света
// уровня level: в верхнем мире монстру нужен блочный свет 0 — хватает 1, а
// свет 9 ночью почти не заметен глазу. Жадно: первый тёмный — свет в клетку
// над ним (голова, если ноги заняты растением), обновить свет от него, повторить.
function lightFix (g, level) {
  // Уровень 6: свет ≥ 1 в радиусе 5; ночью на скале не отличить от лунного.
  const LG = require('./colosseum-light')
  const CK = require('./castle-check')
  const LS = st('light', { level: String(level), waterlogged: 'false' })
  g.id(LS)
  const { dark, L, T } = CK.spawnDark(g)
  const sx = g.sx; const sxz = g.sx * g.sz
  const DIRS = [[1, 0, 0, 'east'], [-1, 0, 0, 'west'], [0, 1, 0, 'up'], [0, -1, 0, 'down'], [0, 0, 1, 'south'], [0, 0, -1, 'north']]
  const OPPD = { east: 'west', west: 'east', up: 'down', down: 'up', south: 'north', north: 'south' }
  const raise = (i0, lv) => {
    L[i0] = Math.max(L[i0], lv)
    const q = [i0]
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi]; const l = L[i]
      if (l <= 1) continue
      const x = i % sx; const zz = Math.floor(i / sx) % g.sz; const y = Math.floor(i / sxz)
      const sv = g.data[i]
      for (const [dx, dy, dz, dn] of DIRS) {
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
  void LG
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

// ============================================================ команды

// Порядок: массы по убыванию числа клеток (камень скалы — первым), сыпучие
// (песок, гравий) — после опоры, вода — в самом конце массы (всё, что её
// держит, уже стоит: течь некуда), навесное и мелочь (факелы, фонари,
// двери, кровати, растения, ковры, таблички) — одиночными /setblock последними.
const TAIL = /(torch|^lectern|lantern|_banner|_sign|_door|_bed|carpet|candle|^potted_|^flower_pot|^ladder|vine|^short_grass|^fern|^poppy|^dandelion|^cornflower|^oxeye_daisy|^azure_bluet|^allium|^red_tulip|^wheat|^carrots|^potatoes|^beetroots|_sapling|^bell|_button|_pressure_plate|^lever|rail|^iron_chain|^chain|^end_rod|^lightning_rod|_trapdoor|redstone_wire|tripwire|tripwire_hook|_skull|_head)$/
const FALLING = /^(sand|red_sand|gravel|.*_concrete_powder|anvil|chipped_anvil|damaged_anvil)$/
function castleOrder (g) {
  const count = new Map()
  for (let i = 0; i < g.data.length; i++) { const v = g.data[i]; if (v) count.set(v, (count.get(v) || 0) + 1) }
  const name = v => C.parse(g.pal[v]).name
  const tier = v => { const n = name(v); if (n === 'water') return 3; if (FALLING.test(n)) return 2; return 1 }
  return [...count.keys()].filter(v => !TAIL.test(name(v))).sort((a, b) => tier(a) - tier(b) || count.get(b) - count.get(a))
}
function commands (m, { X, Y, Z }) {
  const q = C.placeGrid(m.g)
  const order = castleOrder(q)
  const main = C.painter(q, order)
  const tail = []
  for (let i = 0; i < q.data.length; i++) {
    const v = q.data[i]
    if (!v || !TAIL.test(C.parse(q.pal[v]).name)) continue
    const x = i % q.sx + q.x0; const rest = Math.floor(i / q.sx); const z = rest % q.sz + q.z0; const y = Math.floor(rest / q.sz) + q.y0
    tail.push({ x, y, z, x2: x, y2: y, z2: z, v, nbt: q.nbt.get(i) })
  }
  // Блоки с NBT из основного прохода (таблички в хвосте; тут — на всякий).
  const out = [...main.map(b => C.toCmd(b, q.pal[b.v], X, Y, Z)), ...tail.map(b => C.toCmd(b, q.pal[b.v], X, Y, Z, b.nbt))]
  for (const c of out) if (c.length > 250) throw new Error('команда длиннее 250: ' + c)
  return out
}
// Стойки с бронёй (оружейная): сущности, ставятся после блоков; метка —
// чтобы повторная постройка не удваивала их.
function entityCommands (m, { X, Y, Z }) {
  const yaw = { north: 180, south: 0, east: -90, west: 90 }
  const out = [`/kill @e[type=armor_stand,tag=castle_stand,x=${X - 80},y=${Y - 30},z=${Z - 80},dx=160,dy=160,dz=160]`]
  for (const [x, y, z, f] of m.armorStands) {
    out.push(`/summon armor_stand ${X + x + 0.5} ${Y + y} ${Z + z + 0.5} {Tags:["castle_stand"],ShowArms:1b,Rotation:[${yaw[f]}f,0f],equipment:{head:{id:"iron_helmet"},chest:{id:"iron_chestplate"},legs:{id:"iron_leggings"},feet:{id:"iron_boots"},mainhand:{id:"iron_sword"}}}`)
  }
  return out
}
// Габарит в мире.
function footprint (m, { X, Y, Z }) {
  const { g } = m
  return { x0: X + g.x0, x1: X + g.x1, y0: Y + g.y0, y1: Y + g.y1, z0: Z + g.z0, z1: Z + g.z1 }
}

// ================================================================ части

// Круглая башня: центр (cx, cz), внешний радиус r, стена от земли до yTop,
// полы на floors (y блока пола), машикули и зубцы (crenel) или конус (cone),
// окна-бойницы: [{ y, h, angles: [рад] }], двери: [{ y, dir }].
function roundTower (ctx, o) {
  const { B, Hat } = ctx
  const { cx, cz, r, yTop } = o
  const f = o.f || 'stone_bricks'
  const inner = r - 1.2
  const R = Math.ceil(r + 2)
  const ground = (x, z) => { const h = Hat(x, z); return h === -999 ? -18 : h }
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dz)
      if (d > r) continue
      const x = cx + dx; const z = cz + dz
      const y0 = Math.min(ground(x, z), o.yBase !== undefined ? o.yBase : 99)
      const isWall = d > inner
      for (let y = y0 - 1; y <= yTop; y++) {
        if (isWall) B.S(x, y, z, o.mat ? o.mat(x, y, z) : ctx.masonry(x, y, z))
        else if (y >= (o.yFloor0 !== undefined ? o.yFloor0 : y0 + 1)) B.S(x, y, z, '')
        else B.S(x, y, z, o.core || 'stone_bricks')
      }
      if (!isWall) {
        for (const fy of (o.floors || [])) B.S(x, fy, z, o.floorMat || 'spruce_planks')
        B.S(x, yTop, z, o.roofFloor || 'stone_bricks')
      }
    }
  }
  // Бойницы и окна.
  for (const w of (o.windows || [])) {
    for (const a of w.angles) {
      const ex = Math.round(cx + Math.cos(a) * (r - 0.5)); const ez = Math.round(cz + Math.sin(a) * (r - 0.5))
      const ix = Math.round(cx + Math.cos(a) * (r - 1.5)); const iz = Math.round(cz + Math.sin(a) * (r - 1.5))
      for (let y = w.y; y < w.y + w.h; y++) { B.S(ex, y, ez, w.glass || 'glass_pane'); if (Math.hypot(ix - cx, iz - cz) > inner) B.S(ix, y, iz, '') }
      B.S(ex, w.y + w.h, ez, stairs(f, dirTo(ex - cx, ez - cz, true), 'top'))
    }
  }
  // Двери наружу.
  for (const dd of (o.doors || [])) {
    const [ux, uz] = DIR[dd.dir]
    for (let k = Math.floor(r - 1.5); k <= Math.ceil(r); k++) {
      const x = cx + ux * k; const z = cz + uz * k
      B.S(x, dd.y, z, ''); B.S(x, dd.y + 1, z, ''); B.S(x, dd.y + 2, z, '')
    }
    const x = cx + ux * Math.round(r - 0.5); const z = cz + uz * Math.round(r - 0.5)
    if (dd.door !== false) B.door(x, dd.y, z, dd.dir, dd.mat || 'spruce_door')
    B.S(x, dd.y + 2, z, stairs(f, OPP[dd.dir], 'top'))
  }
  // Лестница-стремянка по внутренней стене — с нижнего яруса на верхние (и
  // на боевую площадку, если нет конуса). Угол — подальше от окон и дверей.
  const floors = (o.floors || []).slice().sort((a, b) => a - b)
  if (o.ladder !== false && floors.length) {
    const busy = []
    for (const w of (o.windows || [])) busy.push(...w.angles)
    for (const dd of (o.doors || [])) busy.push({ east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }[dd.dir])
    let best = 0; let bestD = -1
    for (let k = 0; k < 4; k++) { // по осям: клетка у стены ровно за лучом
      const a = k * Math.PI / 2
      const d = Math.min(...busy.map(b => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))), 9)
      if (d > bestD) { bestD = d; best = a }
    }
    // Клетка у стены: ближайшая к лучу внутренняя клетка, за ней — стена.
    const [ux, uz] = Math.abs(Math.cos(best)) >= Math.abs(Math.sin(best)) ? [Math.sign(Math.cos(best)), 0] : [0, Math.sign(Math.sin(best))]
    let k = 0
    while (Math.hypot(ux * (k + 1), uz * (k + 1)) <= inner) k++
    const lx = cx + ux * k; const lz = cz + uz * k
    const face = dirTo(-ux, -uz, true) // лицом к центру
    const y0 = o.yFloor0 !== undefined ? o.yFloor0 : floors[0]
    const y1 = o.cone ? floors[floors.length - 1] : yTop
    for (let y = y0; y <= y1; y++) B.S(lx, y, lz, st('ladder', { facing: face, waterlogged: 'false' }))
  }
  // Верх: машикули (консоли на r..r+1 под парапетом) и зубцы — или конус.
  if (o.crenel !== false) {
    const ring = B.ringCells(cx, cz, r, r + 1)
    ring.forEach(([x, z, d, dx, dz], i) => {
      B.S(x, yTop - 1, z, stairs(f, dirTo(dx, dz), 'top'))
      B.S(x, yTop, z, i % 2 ? f : slab(f, 'top'))
      if (!o.cone) { B.S(x, yTop + 1, z, f); if (i % 2 === 0) B.S(x, yTop + 2, z, slab(f)) }
    })
  }
  if (o.cone) B.cone(cx, cz, r + (o.crenel === false ? 1 : 1.5), yTop + 1, o.cone.k || 2, o.cone.f || 'deepslate_tiles')
}

// ------------------------------------------------------------------ погреба

function buildCellars (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  // Помещение в скале: коробка с облицовкой, сводом (перевёрнутые ступени
  // вдоль длинных стен) и столбами через каждые 4.
  const vault = (x0, y0, z0, x1, y1, z1, { floor = 'stone_bricks', pillars = true, axis = 'x' } = {}) => {
    B.box(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y1 + 1, z1 + 1, 'stone_bricks')
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) for (let z = z0 - 1; z <= z1 + 1; z++) B.S(x, y, z, M(x, y, z))
    B.air(x0, y0, z0, x1, y1, z1)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) B.S(x, y0 - 1, z, (x + z) % 2 ? floor : 'polished_andesite')
    // Свод: у длинных стен под потолком — перевёрнутые ступени.
    if (axis === 'x') {
      for (let x = x0; x <= x1; x++) { B.S(x, y1, z0, stairs('stone_bricks', 'north', 'top')); B.S(x, y1, z1, stairs('stone_bricks', 'south', 'top')) }
    } else {
      for (let z = z0; z <= z1; z++) { B.S(x0, y1, z, stairs('stone_bricks', 'west', 'top')); B.S(x1, y1, z, stairs('stone_bricks', 'east', 'top')) }
    }
    if (pillars) {
      for (let x = x0 + 4; x <= x1 - 4; x += 5) {
        for (let z = z0 + 4; z <= z1 - 4; z += 5) {
          B.column(x, z, y0, y1, 'polished_andesite')
          B.S(x, y1, z, 'chiseled_stone_bricks')
          for (const [dx, dz, f] of [[1, 0, 'west'], [-1, 0, 'east'], [0, 1, 'north'], [0, -1, 'south']]) B.S(x + dx, y1, z + dz, stairs('stone_bricks', f, 'top'))
        }
      }
    }
  }
  ctx.cellar = {}
  // Этаж 23 (пол — y 22): большой склад, винный погреб, сокровищница.
  vault(-25, 23, 4, -3, 27, 14) // склад
  vault(-1, 23, 4, 9, 27, 14, { pillars: false }) // винный погреб
  vault(11, 23, 7, 19, 26, 14, { pillars: false }) // сокровищница
  // Этаж 16 (пол — y 15): темница и цистерна.
  vault(-25, 16, 5, -9, 20, 14, { pillars: false }) // темница
  vault(-6, 16, 3, 10, 21, 14) // цистерна
  ctx.cellar = { store: [-25, 23, 4, -3, 27, 14], wine: [-1, 23, 4, 9, 27, 14], treasury: [11, 23, 7, 19, 26, 14], dungeon: [-25, 16, 5, -9, 20, 14], cistern: [-6, 16, 3, 10, 21, 14] }
}

// ------------------------------------------------------------- морская стена

function buildSeaWall (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  const x0 = -43; const x1 = 39
  // Тело стены z 48..50 от дна до y 10; обход поверху.
  for (let x = x0; x <= x1; x++) {
    for (let z = 48; z <= 50; z++) {
      for (let y = -18; y <= 10; y++) B.S(x, y, z, M(x, y, z))
    }
    // Машикули: консоли на z 51 (y 9), парапет над ними.
    B.S(x, 9, 51, stairs('stone_bricks', 'north', 'top'))
    B.S(x, 10, 51, x % 2 ? 'stone_bricks' : slab('stone_bricks', 'top'))
    B.S(x, 11, 51, 'stone_bricks')
    if (x % 2 === 0) B.S(x, 12, 51, slab('stone_bricks'))
    // Внутренний край — низкий бортик.
    B.S(x, 11, 47, slab('stone_bricks'))
  }
  // Боковые стены квартала (x −44 и 40) от стены до подпорной стены.
  for (const x of [x0 - 1, x1 + 1]) {
    for (let z = 36; z <= 50; z++) {
      for (let y = -18; y <= 10; y++) B.S(x, y, z, M(x, y, z))
      B.S(x, 11, z, 'stone_bricks'); if (z % 2 === 0) B.S(x, 12, z, slab('stone_bricks'))
    }
  }
  // Лестницы на обход: вдоль внутренней грани стены (z 47), подъём 9.
  B.flight(-30, 47, 'east', 1, 'north', 2, 9, { f: 'stone_bricks', fill: 'stone_bricks', yFill: 1 })
  B.flight(28, 47, 'west', 1, 'north', 2, 9, { f: 'stone_bricks', fill: 'stone_bricks', yFill: 1 })
  // Башни.
  const towers = [[-44, 49, true], [-18, 51, false], [16, 51, false], [40, 49, true]]
  for (const [cx, cz, corner] of towers) {
    roundTower(ctx, {
      cx, cz, r: corner ? 5 : 4, yTop: corner ? 18 : 15, yBase: -18, yFloor0: 2, floors: [10], roofFloor: 'stone_bricks',
      cone: corner ? { k: 2, f: 'deepslate_tiles' } : null,
      windows: [{ y: 4, h: 2, angles: [Math.PI / 2, Math.PI / 2 - 0.9, Math.PI / 2 + 0.9] }, { y: 12, h: 2, angles: [Math.PI / 2, 0, Math.PI] }],
      doors: [{ y: 11, dir: 'east', door: false }, { y: 11, dir: 'west', door: false }]
    })
    // Дверь с улицы: башня стоит на стыке боковой и морской стен, прямой
    // выход на север упёрся бы в боковую стену — дверь в клетке у её края.
    if (corner) {
      const dxs = cx < 0 ? 1 : -1
      for (const z of [44, 45, 46]) for (let y = 2; y <= 4; y++) B.S(cx + dxs, y, z, '')
      B.door(cx + dxs, 2, 45, 'north', 'spruce_door'); B.S(cx + dxs, 4, 45, stairs('stone_bricks', 'south', 'top'))
    }
  }
}

// --------------------------------------------------------------- ворота

function buildGate (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  // Дамба: x −2..2 от ворот на юг до края; откосы ступенями.
  for (let z = 52; z <= 70; z++) {
    for (let x = -6; x <= 6; x++) {
      if (Math.hypot(x, z) > 68.5) continue
      const ax = Math.abs(x)
      let top
      if (ax <= 2) top = 1
      else if (ax === 3) top = 1
      else if (ax === 4) top = 0
      else if (ax === 5) top = -1
      else top = -2
      for (let y = -18; y <= top; y++) B.S(x, y, z, M(x, y, z))
      if (ax <= 2) B.S(x, 1, z, (x + z) % 3 === 0 ? 'polished_andesite' : 'stone_bricks')
      if (ax === 3) { B.S(x, 2, z, 'stone_brick_wall') }
      if (ax >= 4 && ax <= 5) B.S(x, top, z, stairs('stone_bricks', x > 0 ? 'west' : 'east'))
    }
    if (z % 6 === 0 && z >= 60) for (const x of [-3, 3]) { B.S(x, 3, z, 'stone_brick_wall'); B.S(x, 4, z, st('lantern', { hanging: 'false', waterlogged: 'false' })) }
  }
  // Ров перед воротами (z 55..57) под подъёмным мостом.
  for (let z = 55; z <= 57; z++) {
    for (let x = -3; x <= 3; x++) {
      for (let y = -6; y <= 1; y++) B.S(x, y, z, y <= -1 ? 'water' : '')
      B.S(x, -7, z, 'stone_bricks')
    }
    for (let x = -2; x <= 2; x++) B.S(x, 1, z, 'spruce_planks') // мост опущен
    for (const x of [-3, 3]) B.S(x, 2, z, 'spruce_fence')
  }
  // Надвратный корпус x −5..5, z 46..54.
  for (let x = -5; x <= 5; x++) {
    for (let z = 46; z <= 54; z++) {
      for (let y = -18; y <= 17; y++) B.S(x, y, z, M(x, y, z))
    }
  }
  // Проезд x −1..1, y 2..6, стрельчатый верх.
  for (let z = 46; z <= 54; z++) {
    for (let x = -1; x <= 1; x++) { for (let y = 2; y <= 6; y++) B.S(x, y, z, ''); B.S(x, 1, z, 'stone_bricks') }
    B.S(-1, 7, z, stairs('stone_bricks', 'west', 'top')); B.S(1, 7, z, stairs('stone_bricks', 'east', 'top')); B.S(0, 7, z, '')
  }
  // Решётка поднята: видна верхняя часть.
  for (let x = -1; x <= 1; x++) { B.S(x, 6, 53, 'iron_bars'); B.S(x, 7, 53, 'iron_bars') }
  // Обрамление арки снаружи и изнутри.
  for (const z of [55, 45]) {
    const out = z === 55 ? 'south' : 'north'
    for (let y = 2; y <= 8; y++) { B.S(-2, y, z, 'chiseled_stone_bricks'); B.S(2, y, z, 'chiseled_stone_bricks') }
    B.S(-1, 8, z, stairs('stone_bricks', 'west', 'top')); B.S(1, 8, z, stairs('stone_bricks', 'east', 'top')); B.S(0, 8, z, 'chiseled_stone_bricks'); B.S(0, 9, z, 'chiseled_stone_bricks')
    void out
  }
  // Караульня над проездом: y 9..15, окна на юг.
  B.air(-4, 9, 47, 4, 14, 53)
  for (let x = -4; x <= 4; x++) for (let z = 47; z <= 53; z++) B.S(x, 8, z, 'spruce_planks')
  for (const x of [-3, 0, 3]) { B.S(x, 11, 54, 'glass_pane'); B.S(x, 12, 54, 'glass_pane'); B.S(x, 13, 54, stairs('stone_bricks', 'south', 'top')) }
  // Верх: машикули и зубцы по периметру.
  const per = []
  for (let x = -6; x <= 6; x++) per.push([x, 55])
  for (let z = 54; z >= 45; z--) per.push([6, z])
  for (let x = 6; x >= -6; x--) per.push([x, 45])
  for (let z = 45; z <= 54; z++) per.push([-6, z])
  per.forEach(([x, z]) => {
    const dirIn = z === 55 ? 'north' : z === 45 ? 'south' : x === 6 ? 'west' : 'east'
    B.S(x, 16, z, stairs('stone_bricks', dirIn, 'top'))
    B.S(x, 17, z, 'stone_bricks')
  })
  B.crenel(per, 18, 'stone_bricks')
  for (let x = -5; x <= 5; x++) for (let z = 46; z <= 54; z++) B.S(x, 17, z, 'stone_bricks')
  // Флаги над воротами.
  B.banner(-3, 13, 56, 'south', 'blue'); B.banner(3, 13, 56, 'south', 'blue')
  B.S(-3, 14, 55, 'stone_bricks'); B.S(3, 14, 55, 'stone_bricks')
  // Башни по бокам ворот.
  for (const sx of [-1, 1]) {
    roundTower(ctx, {
      cx: sx * 6, cz: 55, r: 3.5, yTop: 21, yBase: -18, yFloor0: 9, floors: [15], cone: { k: 2.2, f: 'deepslate_tiles' },
      windows: [{ y: 4, h: 2, angles: [Math.PI / 2] }, { y: 11, h: 2, angles: [Math.PI / 2, sx > 0 ? 0 : Math.PI] }, { y: 17, h: 2, angles: [Math.PI / 2] }]
    })
  }
  // Вход в караульню с обхода морской стены (y 11, z 49): двери в боковых
  // стенах корпуса, внутри — площадка и ступень вниз к полу (y 9).
  for (const sx of [-1, 1]) {
    B.door(sx * 5, 11, 49, sx < 0 ? 'east' : 'west', 'spruce_door'); B.S(sx * 5, 13, 49, 'stone_bricks')
    B.S(sx * 4, 9, 49, 'stone_bricks'); B.S(sx * 4, 10, 49, 'stone_bricks'); B.S(sx * 4, 11, 49, ''); B.S(sx * 4, 12, 49, '')
    B.S(sx * 4, 9, 50, stairs('stone_bricks', 'north'))
  }
  // Проходы из караульни в боковые башни ворот (угол x ±4, z 53 — кольцо башни).
  for (const sx of [-1, 1]) { B.S(sx * 4, 9, 53, ''); B.S(sx * 4, 10, 53, '') }
  // Фонари в проезде.
  B.lanternHang(0, 6, 48); B.lanternHang(0, 6, 51)
  // Кольцо света у ворот.
  B.S(-2, 5, 56, st('wall_torch', { facing: 'south' })); B.S(2, 5, 56, st('wall_torch', { facing: 'south' }))
}

// ------------------------------------------------------- привратный капкан
//
//   Ультимативная ловушка замка: гость входит через подъёмный мост над рвом
//   в проезд надвратной башни (killbox x −1..1, y 2..6, z 46..54). Три
//   ступени, всё редстоуном, управление и сброс — из караульни наверху:
//     1) мост-провал: центр настила на липких поршнях; растяжка на мосту
//        (z 56) убирает настил — падение в ров с магмой на дне;
//     2) двойная решётка: растяжка в проезде (z 52) роняет обе решётки
//        (железные прутья на липких поршнях у z 54 и z 46) — killbox заперт;
//     3) «кипящая смола» и стрелы: потолочные раздатчики с лавой в машикулях
//        (x 0, z 48/50/52) и боковые раздатчики со стрелами в бойницах стен.
//   Параметр p.trap: 'armed' — взведена (как строится в мире), 'sprung' —
//   показать сработавшей (для рендера). Скрытая проводка в толще стен;
//   тонкую доводку поршней/решёток делаем на сервере после постройки.
function buildTrap (ctx) {
  const { B, p } = ctx
  const sprung = p.trap === 'sprung'
  // Редстоун-примитивы (block states 1.21).
  const wire = () => st('redstone_wire', { power: '0', north: 'none', south: 'none', east: 'none', west: 'none' })
  const spis = (facing, ext) => st('sticky_piston', { facing, extended: ext ? 'true' : 'false' })
  const disp = facing => st('dispenser', { facing, triggered: 'false' })
  const lever = (face, facing, on) => st('lever', { face, facing, powered: on ? 'true' : 'false' })
  const rwall = (facing, lit) => st('redstone_wall_torch', { facing, lit: lit ? 'true' : 'false' })
  const trip = () => st('tripwire', { attached: 'true', disarmed: 'false', east: 'false', north: 'true', south: 'true', west: 'false', powered: sprung ? 'true' : 'false' })
  const hook = (facing) => st('tripwire_hook', { facing, attached: 'true', powered: sprung ? 'true' : 'false' })

  // ===== 1. Мост-провал над рвом (z 55..57) =====
  // Края x ±2 — неподвижный камень-парапет; центр x −1..1 — настил из люков
  // (крышки), что распахиваются от рычага/растяжки: под ними ров с магмой.
  const deck = open => st('spruce_trapdoor', { facing: 'north', half: 'bottom', open: open ? 'true' : 'false', powered: sprung ? 'true' : 'false', waterlogged: 'false' })
  for (let z = 55; z <= 57; z++) {
    for (const x of [-2, 2]) B.S(x, 1, z, 'stone_bricks') // парапет-рельсы
    for (let x = -1; x <= 1; x++) {
      B.S(x, 1, z, deck(sprung)) // взведена — люк закрыт (проход); сработала — распахнут
      B.S(x, 0, z, ''); B.S(x, -6, z, 'magma_block') // «кипящее» дно рва под водой
    }
  }
  // Растяжка поперёк моста (z 56, y 2) с крючками на парапете.
  B.S(-2, 2, 56, hook('east')); B.S(2, 2, 56, hook('west'))
  for (let x = -1; x <= 1; x++) B.S(x, 2, 56, trip())

  // ===== 2. Двойная решётка (guillotine) на липких поршнях =====
  // zg 53 — вход со стороны рва, zg 47 — выход во двор. Взведена: прутья
  // подняты в потолочную нишу (y 7,8), липкий поршень над ними убран (в
  // караульне); сработала — поршень гонит прутья вниз, проём y 2..6 заперт.
  for (const zg of [53, 47]) {
    for (let x = -1; x <= 1; x++) {
      for (let y = 2; y <= 8; y++) B.S(x, y, zg, '') // очистить проём и нишу
      if (sprung) { for (let y = 2; y <= 6; y++) B.S(x, y, zg, 'iron_bars'); B.S(x, 8, zg, spis('down', true)) } // решётка опущена, поршень выдвинут
      else { B.S(x, 7, zg, 'iron_bars'); B.S(x, 8, zg, 'iron_bars'); B.S(x, 9, zg, spis('down', false)) } // решётка поднята, поршень-лебёдка в караульне
      B.S(x, 10, zg, 'redstone_block') // источник для поршня-лебёдки
    }
  }
  // Растяжка-триггер в проезде (z 51): роняет обе решётки и запускает раздатчики.
  B.S(-2, 2, 51, hook('east')); B.S(2, 2, 51, hook('west'))
  for (let x = -1; x <= 1; x++) B.S(x, 2, 51, trip())

  // ===== 3. «Кипящая смола» и стрелы =====
  // Потолочные раздатчики с лавой в машикулях по оси.
  for (const z of [48, 50, 52]) {
    B.S(0, 7, z, ''); B.S(0, 8, z, disp('down'))
    if (sprung) for (let y = 3; y <= 6; y++) B.S(0, y, z, 'lava') // льётся лава
  }
  // Боковые бойницы со стрелами: раздатчики в стенах x −2 / x 2 бьют в проём.
  for (const z of [48, 51]) {
    B.S(-2, 4, z, disp('east')); B.S(-3, 4, z, wire())
    B.S(2, 4, z, disp('west')); B.S(3, 4, z, wire())
    // Узкие смотровые щели наружу — только видимость бойницы.
    B.S(-2, 5, z, 'stone_brick_wall'); B.S(2, 5, z, 'stone_brick_wall')
  }

  // ===== Проводка и пульт в караульне (y 8..9) =====
  // Вертикальные шахты редстоуна в толще боковых стен (x ±2..±3) — от пола
  // караульни к поршням/раздатчикам; подробная доводка — на сервере.
  for (const x of [-3, 3]) for (let y = 5; y <= 8; y++) B.S(x, y, 50, wire())
  // Пульт: три рычага на приподнятой стойке у северной стены караульни,
  // с табличками. Взведена — все рычаги в исходном (капкан готов).
  const px = -3; const pz = 48
  for (let i = 0; i < 3; i++) {
    B.S(px + i, 8, pz, 'polished_andesite'); B.S(px + i, 9, pz, lever('floor', 'south', false))
    B.S(px + i, 8, pz + 1, wire())
  }
  B.sign(px, 10, pz - 1, 'south', ['', 'МОСТ', 'РЕШЁТКИ', 'ЛАВА'])
  B.S(px, 8, pz + 2, rwall('south', true))
  // Аварийный сброс (поднять всё) — рычаг у окна.
  B.S(2, 10, 53, lever('wall', 'north', false))

  // ===== Тайная ловушка сокровищницы: провал-каменный мешок =====
  trapTreasury(ctx)
}

// Сокровищница (x 11..19, пол y 22): под приманкой-золотом плита; шаг на неё
// убирает пол-плиты (липкие поршни), вор падает в каменный мешок (oubliette)
// на 10 блоков ниже — решётки, паутина, кости; сверху захлопывается люк.
function trapTreasury (ctx) {
  const { B, p } = ctx
  const sprung = p.trap === 'sprung'
  const wire = () => st('redstone_wire', { power: '0', north: 'none', south: 'none', east: 'none', west: 'none' })
  const spis = (facing, ext) => st('sticky_piston', { facing, extended: ext ? 'true' : 'false' })
  // Каменный мешок под сокровищницей: шахта x 14..16, z 9..11, дно y 12.
  B.box(13, 11, 8, 17, 21, 12, 'stone_bricks')
  B.air(14, 12, 9, 16, 21, 11)
  for (let x = 14; x <= 16; x++) for (let z = 9; z <= 11; z++) B.S(x, 12, z, 'polished_andesite') // дно
  // Решётки-стены каземата и цепи по углам.
  for (let y = 13; y <= 20; y++) for (let x = 14; x <= 16; x++) for (const z of [9, 11]) if (!(x === 15)) B.S(x, y, z, 'iron_bars')
  for (let y = 13; y <= 20; y++) for (const x of [14, 16]) B.S(x, y, 10, 'iron_bars')
  // Обстановка каменного мешка: солома, паутина, кости, череп — «прежние гости».
  B.S(15, 12, 10, 'hay_block'); B.S(14, 13, 9, 'cobweb'); B.S(16, 13, 11, 'cobweb')
  B.S(14, 12, 11, st('bone_block', { axis: 'y' })); B.S(16, 12, 9, st('skeleton_skull', { rotation: '8', powered: 'false' }))
  B.S(15, 15, 10, st('iron_chain', { axis: 'y', waterlogged: 'false' })); B.S(15, 16, 10, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
  // Пол-приманка (y 22) над шахтой: липкие поршни утягивают плиты вниз.
  for (let x = 14; x <= 16; x++) for (let z = 9; z <= 11; z++) {
    B.S(x, 21, z, spis('up', !sprung)) // поршень под плитой
    B.S(x, 22, z, sprung ? '' : ((x + z) % 2 ? 'polished_andesite' : 'smooth_stone')) // плита пола
    B.S(x, 20, z, wire())
  }
  // Приманка: золото и эндер-сундук уже стоят рядом (15,z11); добавим кучу золота.
  if (!sprung) { B.S(15, 23, 10, 'gold_block'); B.S(14, 23, 10, 'gold_block'); B.S(16, 23, 10, 'gold_block') }
  // Скрытая нажимная плита-приманка перед золотом.
  if (!sprung) B.S(15, 23, 11, st('polished_blackstone_pressure_plate', { powered: 'false' }))
  B.sign(12, 24, 10, 'east', ['', 'Не бери', 'золото', ''])
}

// -------------------------------------------------------------- нижний город

function buildTown (ctx) {
  const { B } = ctx
  const y0 = LV.S0
  // Улица: мостовая уже есть; колодец на площади.
  const well = (cx, cz) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const x = cx + dx; const z = cz + dz
        if (dx === 0 && dz === 0) { for (let y = -6; y <= y0 - 1; y++) B.S(x, y, z, 'water'); continue }
        B.S(x, y0, z, 'stone_bricks'); B.S(x, y0 + 1, z, slab('stone_bricks'))
      }
    }
    for (const [dx, dz] of [[-1, -1], [1, 1]]) { B.S(cx + dx, y0 + 2, cz + dz, 'spruce_fence'); B.S(cx + dx, y0 + 3, cz + dz, 'spruce_fence') }
    B.S(cx - 1, y0 + 4, cz - 1, stairs('spruce_planks', 'east')); B.S(cx, y0 + 4, cz, slab('spruce_planks')); B.S(cx + 1, y0 + 4, cz + 1, stairs('spruce_planks', 'west'))
    B.S(cx, y0 + 3, cz, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
    B.S(cx, y0 + 2, cz, st('lantern', { hanging: 'true', waterlogged: 'false' }))
  }
  well(0, 41)
  // Дома: ряд вдоль подпорной стены (z 37..42), фасад на улицу (z 42),
  // верхний этаж — фахверк с выносом на улицу (z 43).
  const houses = [
    { x0: -42, x1: -33, kind: 'stable', roof: 'spruce_planks', ridge: 'x' },
    { x0: -31, x1: -24, kind: 'smithy', roof: 'deepslate_tiles', ridge: 'z' },
    { x0: -22, x1: -16, kind: 'bakery', roof: 'bricks', ridge: 'z' },
    { x0: -14, x1: -8, kind: 'house', roof: 'deepslate_tiles', ridge: 'z' },
    { x0: 8, x1: 17, kind: 'inn', roof: 'bricks', ridge: 'x' },
    { x0: 19, x1: 24, kind: 'shop', roof: 'deepslate_tiles', ridge: 'z' }
  ]
  ctx.houses = houses
  for (const h of houses) house(ctx, h)
}

function house (ctx, h) {
  const { B } = ctx
  const y0 = LV.S0
  const { x0, x1 } = h
  const z0 = 37; const z1 = 42
  const up0 = y0 + 5 // пол второго этажа (блок)
  const top = up0 + 5 // верх стен
  const stone = (x, y, z) => hash(x, y, z, 77) < 0.3 ? 'cobblestone' : hash(x, y, z, 78) < 0.2 ? 'mossy_cobblestone' : 'stone_bricks'
  const frame = 'stripped_dark_oak_log'
  const plaster = 'white_terracotta'
  const stable = h.kind === 'stable'
  // Первый этаж — камень.
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1
      for (let y = y0; y < up0; y++) B.S(x, y, z, edge ? stone(x, y, z) : '')
      B.S(x, y0 - 1, z, stable ? 'coarse_dirt' : 'spruce_planks')
      if (!stable) B.S(x, up0, z, 'spruce_planks')
    }
  }
  // Второй этаж — фахверк с выносом на улицу (z1 + 1).
  const zf = z1 + 1
  if (!stable) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= zf; z++) {
        const edge = x === x0 || x === x1 || z === z0 || z === zf
        B.S(x, up0, z, 'spruce_planks')
        for (let y = up0 + 1; y <= top; y++) {
          if (!edge) { B.S(x, y, z, ''); continue }
          const post = x === x0 || x === x1 || (z === zf && (x - x0) % 3 === 0) || (z === z0)
          const beam = y === up0 + 1 || y === top
          const diag = z === zf && ((x - x0) % 3 === 1 && y === up0 + 2)
          B.S(x, y, z, post ? st(frame, { axis: 'y' }) : beam ? st(frame, { axis: 'x' }) : diag ? st(frame, { axis: 'x' }) : plaster)
        }
      }
      B.S(x, up0 - 1, zf, stairs('dark_oak_planks', 'north', 'top')) // консоли выноса
    }
    B.S(x0, up0, zf, st(frame, { axis: 'z' })); B.S(x1, up0, zf, st(frame, { axis: 'z' }))
  }
  // Крыша.
  const rz1 = stable ? z1 : zf
  const ye = (stable ? up0 : top) + 1
  const sl = stable ? 1 : 2
  if (h.ridge === 'x') B.gable(x0, x1, z0, rz1, 'x', ye, { f: h.roof, slope: sl, gable: stable ? 'spruce_planks' : plaster })
  else B.gable(x0, x1, z0, rz1, 'z', ye, { f: h.roof, slope: sl, gable: stable ? 'spruce_planks' : plaster })
  // Дымоход у задней стены.
  if (!stable) { const cx = x0 + 1; for (let y = y0; y <= top + 9; y++) B.S(cx, y, z0, 'bricks'); B.S(cx, top + 10, z0, st('campfire', { facing: 'north', lit: 'true', signal_fire: 'false', waterlogged: 'false' })) }
  // Дверь, окна первого этажа.
  const dx = Math.floor((x0 + x1) / 2)
  if (stable) {
    for (let x = dx - 1; x <= dx + 1; x++) for (let y = y0; y <= y0 + 2; y++) B.S(x, y, z1, '')
    B.S(dx - 1, y0 + 3, z1, stairs('spruce_planks', 'west', 'top')); B.S(dx + 1, y0 + 3, z1, stairs('spruce_planks', 'east', 'top'))
  } else {
    B.door(dx, y0, z1, 'north', 'spruce_door')
    B.S(dx, y0 + 2, z1, stairs('stone_bricks', 'south', 'top'))
  }
  for (const wx of [x0 + 1, x1 - 1]) if (Math.abs(wx - dx) > 1) { B.S(wx, y0 + 1, z1, 'glass_pane'); B.S(wx, y0 + 2, z1, 'glass_pane'); B.S(wx, y0 + 3, z1 + 1, st('spruce_trapdoor', { facing: 'south', half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })) }
  if (!stable) for (let x = x0 + 1; x < x1; x += 2) { B.S(x, up0 + 2, zf, 'glass_pane'); B.S(x, up0 + 3, zf, 'glass_pane') }
  // Вывеска.
  const names = { stable: 'Конюшня', smithy: 'Кузница', bakery: 'Пекарня', house: 'Дом', inn: 'Таверна', shop: 'Лавка' }
  B.sign(dx + 1 <= x1 - 1 ? dx + 1 : dx - 1, y0 + 2, z1 + 1, 'south', ['', names[h.kind], '', ''])
  furnishHouse(ctx, h, { z0, z1, zf, up0, top })
}

function furnishHouse (ctx, h, { z0, z1, zf, up0 }) {
  const { B } = ctx
  const y = LV.S0
  const { x0, x1 } = h
  const ix0 = x0 + 1; const ix1 = x1 - 1; const iz0 = z0 + 1; const iz1 = z1 - 1 // низ: z 38..41
  const upY = up0 + 1
  const dx = Math.floor((x0 + x1) / 2) // дверь (z1) — от неё к задней стене сквозной проход x = dx
  // Всё стоит вдоль стен: задняя (z iz0), боковые (x ix0 / ix1); проход x = dx
  // и клетка перед лестницей свободны.
  if (h.kind === 'stable') {
    // Денники у задней стены (глубина 2) за заборами-перегородками; у каждого
    // сено и поилка. Передний ряд (z 40..41) — проход от ворот.
    const stalls = [[ix0, ix0 + 1], [ix0 + 3, ix0 + 4], [ix0 + 6, ix0 + 7]]
    for (const [a, b] of stalls) {
      B.S(a, y, iz0, 'hay_block'); B.S(b, y, iz0, st('water_cauldron', { level: '3' }))
      if (b + 1 < ix1) for (let z = iz0; z <= iz0 + 1; z++) B.S(b + 1, y, z, 'spruce_fence')
    }
    B.S(ix1, y, iz0, 'hay_block'); B.S(ix1, y + 1, iz0, 'hay_block')
    B.S(ix0, y, iz1, st('composter', { level: '0' })); B.chest(ix1, y, iz1, 'west')
    B.lanternHang(dx, up0 - 1, iz0 + 2)
    return
  }
  // Лестница в дальнем левом углу, люк над ней; подход — справа (ix0 + 1, iz0).
  for (let yy = y; yy <= up0; yy++) B.S(ix0, yy, iz0, st('ladder', { facing: 'south', waterlogged: 'false' }))
  const put = (x, z, s) => { if (x === dx || (x === ix0 + 1 && z === iz0) || (x === ix0 && z === iz0)) return; B.S(x, y, z, s) }
  const hood = (xa, xb) => { for (let x = xa; x <= xb; x++) B.S(x, y + 1, iz0, 'bricks') }
  if (h.kind === 'smithy') {
    // Горн у задней стены справа, наковальня и точило — вдоль правой стены,
    // закалка (вода, лава) — у левой.
    put(ix1, iz0, st('blast_furnace', { facing: 'south', lit: 'true' })); put(ix1 - 1, iz0, st('furnace', { facing: 'south', lit: 'false' })); hood(ix1 - 1, ix1)
    put(ix1 - 2, iz0, 'smithing_table')
    put(ix1, iz0 + 1, st('anvil', { facing: 'north' })); put(ix1, iz0 + 2, st('grindstone', { face: 'floor', facing: 'west' })); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    put(ix0, iz0 + 2, st('water_cauldron', { level: '3' })); put(ix0, iz1, 'lava_cauldron')
  } else if (h.kind === 'bakery') {
    // Печи с кирпичным колпаком у задней стены, мука и зерно в бочках справа,
    // столик для теста у левой стены.
    put(ix1, iz0, st('smoker', { facing: 'south', lit: 'true' })); put(ix1 - 1, iz0, st('furnace', { facing: 'south', lit: 'true' })); hood(ix1 - 1, ix1)
    put(ix1, iz0 + 1, 'crafting_table'); B.barrel(ix1, y, iz0 + 2, 'west'); B.barrel(ix1, y, iz1, 'west'); B.barrel(ix1, y + 1, iz1, 'up')
    put(ix0, iz0 + 2, 'hay_block'); B.table(ix0, iz1, ix0, iz1, y, 'spruce_planks')
  } else if (h.kind === 'house') {
    // Кухня у задней стены, обеденный стол со скамьёй — у левой.
    put(ix1, iz0, st('furnace', { facing: 'south', lit: 'false' })); put(ix1 - 1, iz0, 'crafting_table')
    B.barrel(ix1, y, iz0 + 1, 'west'); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    B.table(ix0, iz0 + 2, ix0, iz1, y, 'oak_planks'); B.bench(ix0 + 1, iz0 + 2, ix0 + 1, iz1, y, 'east', 'oak_planks')
  } else if (h.kind === 'inn') {
    // Стойка с бочками справа у задней стены, два стола со скамьями по
    // сторонам прохода, коптильня у лестницы.
    for (let x = dx + 2; x <= ix1; x++) { B.barrel(x, y, iz0, 'south'); B.barrel(x, y + 1, iz0, 'south') }
    B.table(dx + 2, iz0 + 1, ix1 - 1, iz0 + 1, y, 'spruce_planks')
    put(dx - 1, iz0, st('smoker', { facing: 'south', lit: 'true' }))
    B.table(ix0 + 1, iz0 + 2, ix0 + 1, iz1, y, 'spruce_planks'); B.bench(ix0, iz0 + 2, ix0, iz1, y, 'west', 'spruce_planks')
    B.table(ix1 - 1, iz0 + 2, ix1 - 1, iz1, y, 'spruce_planks'); B.bench(ix1, iz0 + 2, ix1, iz1, y, 'east', 'spruce_planks')
    B.candles(ix0 + 1, y + 1, iz0 + 2, 3); B.candles(ix1 - 1, y + 1, iz1, 3)
  } else if (h.kind === 'shop') {
    // Мастерская лавки у задней стены, товар — в бочках и сундуке справа,
    // прилавок слева у входа.
    put(ix1, iz0, st('loom', { facing: 'south' })); put(ix1, iz0 + 1, 'fletching_table')
    B.barrel(ix1, y, iz0 + 2, 'west'); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    put(ix0, iz0 + 2, 'cartography_table'); B.table(ix0, iz1, ix0, iz1, y, 'spruce_planks')
  }
  B.lanternHang(dx, up0 - 1, iz0 + 2)
  // Второй этаж (z 38..42): кровати изголовьем к задней стене, сундуки у
  // фасада, ковёр посередине; вокруг люка (ix0, iz0) свободно.
  const beds = h.kind === 'inn' ? [ix0 + 2, ix0 + 3, ix1 - 1, ix1] : [ix1]
  const colors = ['red', 'blue', 'green', 'yellow']
  beds.forEach((bx, i) => B.bed(bx, upY, iz0 + 1, 'north', colors[i % 4]))
  B.chest(ix1, upY, zf - 1, 'north')
  if (h.kind === 'inn') B.chest(ix0 + 2, upY, zf - 1, 'north')
  B.carpet(ix0 + 1, iz0 + 2, ix1 - 1, zf - 2, upY, 'brown')
  B.lanternHang(dx, up0 + 4, iz0 + 2)
}

// ------------------------------------------------ большая лестница S0 → S1

function buildGrandStair (ctx) {
  const { B } = ctx
  // Марш вдоль подпорной стены: z 37..38, от x 25 (y 2) на восток до x 38
  // (верх 16), на арках; площадка x 39, вход на террасу через проём.
  const z0 = 37; const z1 = 38
  B.flight(25, z0, 'east', 2, 'south', LV.S0, 14, { f: 'stone_bricks', fill: 'stone_bricks', yFill: LV.S0 - 1, clear: 4 })
  for (let x = 25; x <= 38; x++) {
    // Арки под маршем (кладовые): проём через два.
    if ((x - 25) % 3 === 1 && x < 36) for (let y = LV.S0; y <= Math.min(LV.S0 + (x - 25) - 2, LV.S0 + 3); y++) B.S(x, y, z1, '')
    // Перила снаружи марша; две нижние ступени — во всю ширину (вход с улицы:
    // с запада марш упирается в стену лавки).
    if (x <= 26) {
      for (let y = LV.S0 - 1; y < LV.S0 + (x - 25); y++) B.S(x, y, z1 + 1, ctx.masonry(x, y, z1 + 1))
      B.S(x, LV.S0 + (x - 25), z1 + 1, stairs('stone_bricks', 'east'))
      continue
    }
    B.S(x, LV.S0 + (x - 25) + 1, z1 + 1, 'stone_brick_wall')
    for (let y = LV.S0 - 1; y <= LV.S0 + (x - 25); y++) B.S(x, y, z1 + 1, ctx.masonry(x, y, z1 + 1))
  }
  // Площадка наверху и проём в парапете террасы.
  for (let z = z0; z <= z1 + 1; z++) for (let y = LV.S0 - 1; y <= LV.S1 - 1; y++) B.S(39, y, z, 'stone_bricks')
  for (let x = 37; x <= 39; x++) for (let y = LV.S1; y <= LV.S1 + 3; y++) B.S(x, y, 36, '')
  B.S(39, LV.S1, z1 + 1, 'stone_brick_wall'); B.S(39, LV.S1, z0, '')
  // Фонари на перилах.
  for (let x = 27; x <= 38; x += 4) B.S(x, LV.S0 + (x - 25) + 2, z1 + 1, st('lantern', { hanging: 'false', waterlogged: 'false' }))
}

// ---------------------------------------------------------------- терраса S1

function buildTerraceS1 (ctx) {
  const { B } = ctx
  const y = LV.S1
  // Парапет с зубцами по краям площадок (где снаружи ниже).
  const byZone = new Map()
  for (const e of ctx.edges) { if (!e.zn.edge) continue; (byZone.get(e.zn) || byZone.set(e.zn, []).get(e.zn)).push(e) }
  for (const [zn, list] of byZone) {
    list.sort((a, b) => a.x - b.x || a.z - b.z)
    list.forEach((e, i) => {
      if (B.G(e.x, zn.top + 1, e.z)) return
      B.S(e.x, zn.top + 1, e.z, 'stone_bricks')
      if ((e.x + e.z) % 2 === 0) B.S(e.x, zn.top + 2, e.z, slab('stone_bricks'))
    })
  }
  // Сад на западе: грядки, дорожки, фонтан; на востоке — деревья и лавки.
  const bed = (x0, z0, x1, z1, crop) => {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const water = (z === Math.floor((z0 + z1) / 2)) && (x === Math.floor((x0 + x1) / 2))
        B.S(x, y - 1, z, water ? 'water' : 'farmland[moisture=7]')
        if (!water) B.S(x, y, z, st(crop, crop === 'beetroots' ? { age: '3' } : { age: '7' }))
      }
    }
    for (let x = x0 - 1; x <= x1 + 1; x++) for (const z of [z0 - 1, z1 + 1]) B.S(x, y - 1, z, 'spruce_planks')
    for (let z = z0; z <= z1; z++) for (const x of [x0 - 1, x1 + 1]) B.S(x, y - 1, z, 'spruce_planks')
  }
  bed(-47, 29, -43, 31, 'wheat'); bed(-41, 29, -37, 31, 'carrots'); bed(-47, 33, -43, 35, 'potatoes'); bed(-41, 33, -37, 35, 'beetroots')
  // Фонтан перед дворцом.
  const fx = 10; const fz = 32
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2
      B.S(fx + dx, y - 1, fz + dz, edge ? 'stone_bricks' : 'water')
      if (edge) B.S(fx + dx, y, fz + dz, slab('stone_bricks'))
    }
  }
  B.S(fx, y - 2, fz, 'stone_bricks'); B.S(fx, y - 1, fz, 'stone_bricks'); B.S(fx, y, fz, 'stone_brick_wall'); B.S(fx, y + 1, fz, 'chiseled_stone_bricks'); B.S(fx, y + 2, fz, 'water')
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) B.S(fx + dx, y + 1, fz + dz, stairs('stone_bricks', dirTo(-dx, -dz, true) === 'east' ? 'west' : OPP[dirTo(dx, dz, true)], 'top'))
  // Деревья на востоке террасы.
  for (const [tx, tz] of [[32, 30], [36, 34], [30, 34]]) tree(B, tx, y, tz, 'oak', 4)
  // Лавки у фонтана.
  B.bench(7, 29, 7, 29, y, 'north', 'spruce_planks'); B.bench(13, 29, 13, 29, y, 'north', 'spruce_planks')
  // Фонари на столбах вдоль террасы.
  for (let x = -44; x <= 40; x += 9) { if (x > -32 && x < 28) continue; B.S(x, y, 36, 'stone_brick_wall'); B.S(x, y + 1, 35, '') }
  for (const x of [-28, -18, -8, 4, 16, 24]) { B.S(x, y, 35, 'stone_brick_wall'); B.S(x, y + 1, 35, 'stone_brick_wall'); B.S(x, y + 2, 35, st('lantern', { hanging: 'false', waterlogged: 'false' })) }
}

function tree (B, x, y, z, kind = 'oak', h = 4) {
  for (let i = 0; i < h; i++) B.S(x, y + i, z, st(`${kind}_log`, { axis: 'y' }))
  const leaves = st(`${kind}_leaves`, { distance: '1', persistent: 'true', waterlogged: 'false' })
  for (let dy = -1; dy <= 2; dy++) {
    const r = dy === 2 ? 1 : dy === -1 ? 2 : 2.4
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.hypot(dx, dz) > r) continue
        const yy = y + h - 1 + dy
        if (dx === 0 && dz === 0 && dy < 1) continue
        if (!B.G(x + dx, yy, z + dz)) B.S(x + dx, yy, z + dz, leaves)
      }
    }
  }
}

// -------------------------------------------------------------------- дворец

const PAL = { x0: -30, x1: 26, zN: 16, zS: 27, A: 16, Bf: 23, Cf: 30, top: 38 }

function buildPalace (ctx) {
  const { B } = ctx
  const { x0, x1, zN, zS, A, Bf, Cf, top } = PAL
  const M = ctx.masonry
  // Коробка стен, перекрытия.
  for (let x = x0; x <= x1; x++) {
    for (let z = zN; z <= zS; z++) {
      const edge = x === x0 || x === x1 || z === zN || z === zS
      for (let y = A - 1; y <= top; y++) B.S(x, y, z, edge ? M(x, y, z) : '')
      B.S(x, A - 1, z, 'stone_bricks')
      if (!edge) {
        B.S(x, Bf - 1, z, (x % 4 === 0) ? st('stripped_dark_oak_log', { axis: 'z' }) : 'spruce_planks')
        B.S(x, Cf - 1, z, (x % 4 === 0) ? st('stripped_dark_oak_log', { axis: 'z' }) : 'dark_oak_planks')
      }
    }
  }
  // Пояса (карнизы-слезники) по южному фасаду.
  for (let x = x0; x <= x1; x++) {
    for (const y of [Bf - 1, Cf - 1]) { B.S(x, y, zS, 'polished_andesite'); B.S(x, y, zS + 1, stairs('stone_bricks', 'north', 'top')) }
  }
  // Контрфорсы через 6 по югу.
  const bays = []
  for (let x = x0 + 3; x <= x1 - 3; x += 6) bays.push(x)
  const butX = []
  for (let bx = x0; bx <= x1; bx += 6) {
    if (bx === x0 || bx >= x1) continue
    if (bx >= -9 && bx <= 2) continue // винтовая башня и главный вход (x 0..1)
    butX.push(bx)
  }
  // Окна: A — пары с решёткой, B — стрельчатые 3, C — высокие с витражом.
  const PSouth = B.plane('x', zS, 'south'); const PNorth = B.plane('x', zN, 'north')
  const hallGlass = (a, y) => ((a + y) % 5 === 0 ? 'light_blue_stained_glass_pane' : (y > Cf + 4 ? 'yellow_stained_glass_pane' : 'white_stained_glass_pane'))
  const WF = 'polished_diorite' // белые переплёты — как у собора
  for (const c of bays) {
    if (c >= -9 && c <= -1) { // винтовая башня
      B.lancet(PSouth, c - 1, Cf + 2, 3, 5, { famName: WF, glass: hallGlass, mullion: true })
      continue
    }
    B.lancet(PSouth, c, A + 1, 1, 2, { famName: 'stone_bricks', glass: () => 'iron_bars' })
    B.lancet(PSouth, c - 1, Bf + 1, 3, 3, { famName: WF, mullion: true })
    B.lancet(PSouth, c - 1, Cf + 2, 3, 5, { famName: WF, glass: hallGlass, mullion: true, frame: 'polished_diorite' })
  }
  for (const c of bays) B.lancet(PNorth, c - 1, Cf + 2, 3, 4, { famName: WF, glass: hallGlass, mullion: true })
  // Главный вход (A) — двойная дверь x 0..1 с порталом.
  B.door(0, A, zS, 'north', 'dark_oak_door', 'left'); B.door(1, A, zS, 'north', 'dark_oak_door', 'right')
  for (let y = A; y <= A + 3; y++) { B.S(-1, y, zS + 1, 'chiseled_stone_bricks'); B.S(2, y, zS + 1, 'chiseled_stone_bricks') }
  B.S(0, A + 2, zS, 'stone_bricks'); B.S(1, A + 2, zS, 'stone_bricks')
  B.S(0, A + 3, zS + 1, stairs('stone_bricks', 'west', 'top')); B.S(1, A + 3, zS + 1, stairs('stone_bricks', 'east', 'top'))
  B.S(0, A + 4, zS + 1, 'chiseled_stone_bricks'); B.S(1, A + 4, zS + 1, 'chiseled_stone_bricks')
  B.banner(-1, A + 5, zS + 1, 'south', 'red'); B.banner(2, A + 5, zS + 1, 'south', 'red')
  B.S(-1, A + 6, zS + 1, 'stone_bricks'); B.S(2, A + 6, zS + 1, 'stone_bricks')
  // Двери на вершину (C, север) — к собору.
  for (const dx of [-5, 17]) { B.door(dx, Cf, zN, 'south', 'dark_oak_door'); B.S(dx, Cf + 2, zN, stairs('stone_bricks', 'north', 'top')) }
  // Верх: машикули и зубцы по югу, ход по стене; крыша 2:1.
  for (let x = x0; x <= x1; x++) {
    B.S(x, top, zS + 1, stairs('stone_bricks', 'north', 'top'))
    B.S(x, top + 1, zS + 1, (x % 2) ? 'stone_bricks' : slab('stone_bricks', 'top'))
    B.S(x, top + 2, zS + 1, 'stone_bricks')
    if (x % 2 === 0) B.S(x, top + 3, zS + 1, slab('stone_bricks'))
    B.S(x, top + 1, zS, 'stone_bricks')
  }
  // Контрфорсы: два уступа, над парапетом — пинакли.
  for (const bx of butX) {
    for (let y = A - 1; y <= top + 3; y++) B.S(bx, y, zS + 1, M(bx, y, zS + 1))
    for (let y = A - 1; y <= Bf + 2; y++) B.S(bx, y, zS + 2, M(bx, y, zS + 2))
    B.S(bx, Bf + 3, zS + 2, stairs('stone_bricks', 'north'))
    B.S(bx, A + 2, zS + 3, stairs('stone_bricks', 'north')); for (let y = A - 1; y <= A + 1; y++) B.S(bx, y, zS + 3, M(bx, y, zS + 3))
    B.pinnacle(bx, top + 4, zS + 1, 'stone_bricks', 3, 'chiseled_stone_bricks')
  }
  B.gable(x0, x1, zN, zS - 1, 'x', top + 2, { f: 'deepslate_tiles', slope: 2, gable: 'stone_bricks', ov: 0, ridge: 'deepslate_tile_wall' })
  // Трубы каминов (кухня, горница, зал) — над коньком.
  for (const cx of [-28, 1, 10]) {
    for (let y = top + 1; y <= top + 11; y++) for (const dx of [0, 1]) for (const dz of [0, 1]) B.S(cx + dx, y, zN + dz, 'bricks')
    for (const dx of [-1, 0, 1, 2]) for (const dz of [-1, 0, 1, 2]) if (dx < 0 || dx > 1 || dz < 0 || dz > 1) B.S(cx + dx, top + 11, zN + dz, stairs('stone_bricks', dx < 0 ? 'east' : dx > 1 ? 'west' : dz < 0 ? 'south' : 'north', 'top'))
    B.S(cx, top + 12, zN, st('campfire', { facing: 'north', lit: 'true', signal_fire: 'false', waterlogged: 'false' }))
  }
  // Слуховые окна (люкарны) на южном скате над каждой второй аркой.
  for (const c of bays.filter(c => !(c >= -9 && c <= -1))) {
    const zc = zS - 2
    for (let dx = -1; dx <= 1; dx++) for (let y = top + 3; y <= top + 5; y++) B.S(c + dx, y, zc, dx === 0 && y < top + 5 ? 'glass_pane' : 'stone_bricks')
    B.S(c - 1, top + 6, zc, stairs('deepslate_tiles', 'east')); B.S(c + 1, top + 6, zc, stairs('deepslate_tiles', 'west')); B.S(c, top + 6, zc, 'deepslate_tiles'); B.S(c, top + 7, zc, slab('deepslate_tiles'))
    B.S(c, top + 7, zc - 1, 'deepslate_tiles'); B.pinnacle(c, top + 8, zc, 'stone_bricks', 1)
  }
  // Угловые башни и винтовая лестница.
  const lvls = [A - 1, Bf - 1, Cf - 1]
  roundTower(ctx, { cx: x0, cz: zS, r: 4.5, yTop: top + 6, yFloor0: A, floors: lvls, ladder: false, cone: { k: 2.2, f: 'deepslate_tiles' }, windows: [{ y: Bf + 1, h: 3, angles: [Math.PI * 0.75, Math.PI] }, { y: Cf + 2, h: 4, angles: [Math.PI * 0.6, Math.PI, Math.PI * 1.25] }, { y: A + 2, h: 2, angles: [Math.PI * 0.75] }] })
  roundTower(ctx, { cx: x1, cz: zS, r: 4.5, yTop: top + 6, yFloor0: A, floors: lvls, ladder: false, cone: { k: 2.2, f: 'deepslate_tiles' }, windows: [{ y: Bf + 1, h: 3, angles: [Math.PI * 0.25, 0] }, { y: Cf + 2, h: 4, angles: [Math.PI * 0.4, 0, -Math.PI * 0.25] }, { y: A + 2, h: 2, angles: [Math.PI * 0.25] }] })
  // Проходы из угловых башен во дворец на каждом этаже.
  // Кольцо башни (r 4.5 вокруг угла) входит в комнату дугой; дверь — там,
  // где кольцо в один блок: x ±4 от центра, z = zS − 1.
  for (const [tx, sx] of [[x0, 1], [x1, -1]]) {
    for (const ly of [A, Bf, Cf]) B.door(tx + sx * 4, ly, zS - 1, sx > 0 ? 'east' : 'west', 'spruce_door')
  }
  // Винтовая башня у входа: центр (−5, 30).
  const tcx = -5; const tcz = 30
  roundTower(ctx, { cx: tcx, cz: tcz, r: 4.5, yTop: top + 4, yFloor0: A, floors: [], crenel: false, cone: { k: 2.4, f: 'deepslate_tiles' }, windows: [{ y: A + 3, h: 2, angles: [Math.PI / 2] }, { y: Bf + 3, h: 2, angles: [Math.PI / 2 + 0.7] }, { y: Cf + 3, h: 3, angles: [Math.PI / 2 - 0.7, Math.PI / 2 + 0.7] }] })
  B.spiral(tcx, tcz, 3.4, A, Cf + 7, { f: 'stone_bricks', rev: 7, landDir: 'north' })
  for (const ly of [A, Bf, Cf]) {
    for (let z = zS - 1; z <= zS + 1; z++) for (let y = ly; y <= ly + 2; y++) B.S(tcx, y, z, '')
    B.door(tcx, ly, zS - 1, 'north', 'spruce_door')
    B.S(tcx, ly - 1, zS, 'stone_bricks'); B.S(tcx, ly - 1, zS + 1, 'stone_bricks')
  }
  // Перегородки этажей и комнаты.
  furnishPalace(ctx)
}

// ------------------------------------------------ западная лестница S1 → S2

function buildWestStair (ctx) {
  const { B } = ctx
  // x −48..−46 (3 шириной), с z 31 (пол 16) на север до z 18 (верх 30).
  const xs = -48; const w = 3
  B.flight(xs, 31, 'north', w, 'east', LV.S1, 14, { f: 'stone_bricks', fill: 'stone_bricks', yFill: -18 })
  for (let i = 0; i < 14; i++) {
    const z = 31 - i; const y = LV.S1 + i
    for (const x of [xs - 1, xs + w]) {
      for (let yy = -18; yy <= y; yy++) B.S(x, yy, z, ctx.masonry(x, yy, z))
      B.S(x, y + 1, z, 'stone_brick_wall')
    }
    for (let x = xs; x < xs + w; x++) for (let yy = y + 1; yy <= y + 4; yy++) B.S(x, yy, z, '')
  }
  // Проём в парапете сверху и снизу.
  for (let x = xs; x < xs + w; x++) { for (let y = LV.S2; y <= LV.S2 + 2; y++) { B.S(x, y, 17, ''); B.S(x, y, 16, '') } B.S(x, LV.S2 - 1, 17, 'stone_bricks') }
  for (const z of [22, 27]) for (const x of [xs - 1, xs + w]) B.S(x, LV.S1 + (31 - z) + 2, z, st('lantern', { hanging: 'false', waterlogged: 'false' }))
}

// ---------------------------------------------------- куртина на вершине

function buildSummitWalls (ctx) {
  const { B, Hat } = ctx
  const y = LV.S2
  // Парапет по краю плато (клетки плато, у которых сосед снаружи ниже).
  for (let x = SUMMIT.x0 - 1; x <= SUMMIT.x1 + 1; x++) {
    for (let z = SUMMIT.z0 - 1; z <= SUMMIT.z1 + 1; z++) {
      if (summitSd(x, z) > 0) continue
      if (x >= PAL.x0 - 1 && x <= PAL.x1 + 1 && z >= 14) continue // дворец
      if (x >= -49 && x <= -44 && z >= 14) continue
      let edge = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (summitSd(x + dx, z + dz) > 0 && Hat(x + dx, z + dz) < y - 2) edge = true
      if (!edge) continue
      for (let yy = y - 4; yy < y; yy++) B.S(x, yy, z, ctx.masonry(x, yy, z))
      B.S(x, y, z, 'stone_bricks')
      if ((x + z) % 2 === 0) { B.S(x, y + 1, z, 'stone_bricks'); B.S(x, y + 2, z, slab('stone_bricks')) } else B.S(x, y + 1, z, slab('stone_bricks'))
    }
  }
  // Башни по краю.
  const towers = [[-47, -30, 5], [-8, -35, 4.5], [37, -30, 5], [45, -7, 4.5]]
  for (const [cx, cz, r] of towers) {
    const dirIn = dirTo(-cx, -cz - 9, true)
    roundTower(ctx, {
      cx, cz, r, yTop: y + 11, yFloor0: y, floors: [y + 5], cone: { k: 2.2, f: 'deepslate_tiles' },
      windows: [{ y: y + 2, h: 2, angles: [Math.atan2(cz + 9, cx), Math.atan2(cz + 9, cx) + 1.2, Math.atan2(cz + 9, cx) - 1.2] }, { y: y + 7, h: 2, angles: [Math.atan2(cz + 9, cx), Math.atan2(cz + 9, cx) + 1.6, Math.atan2(cz + 9, cx) - 1.6] }],
      doors: [{ y, dir: dirIn }]
    })
    B.lanternHang(cx, y + 4, cz); B.lanternHang(cx, y + 10, cz)
  }
}

// -------------------------------------------------------------------- собор

// Разметка (x — запад → восток): башни x −37..−27; неф — опоры x −26, −20,
// −14, −8; средокрестие −2..10; хор — опоры 10, 16, 22; апсида — центр
// (22, ZC), обход до r 11. Поперёк: неф |dz| ≤ 5, аркада |dz| = 6, приделы
// 7..10, стены 11, контрфорсы 12..14. Пол 30; своды нефа 50..55, крыша 2:1
// до ~67; средокрестие — башня до 77 и шпиль; западные башни до 80.
const CAT = { xW: -37, xT: -27, piers: [-26, -20, -14, -8], xC0: -2, xC1: 10, choir: [10, 16, 22], ax: 22, F: 30 }

function buildCathedral (ctx) {
  const { B } = ctx
  const F = CAT.F
  const zc = ZC
  const CP = CAT_PAL[ctx.p.cat] || CAT_PAL.tuff
  const { T, TP, TC, TCB, TW, TPW } = CP
  B.pinCap = TCB
  const dzOf = z => Math.abs(z - zc)
  const inApse = (x, z, r) => x > CAT.ax && Math.hypot(x - CAT.ax, z - zc) <= r
  const glassAisle = (a, y) => (y >= F + 7 ? 'yellow_stained_glass_pane' : ((a + y) % 3 === 0 ? 'red_stained_glass_pane' : 'blue_stained_glass_pane'))
  const glassWin = (y0, h) => (a, y) => (y >= y0 + h - 1 ? 'yellow_stained_glass_pane' : ((a + y) % 3 === 0 ? 'red_stained_glass_pane' : 'blue_stained_glass_pane'))
  const glassHigh = (a, y) => (y >= 51 ? 'purple_stained_glass_pane' : ((a * 3 + y) % 4 === 0 ? 'red_stained_glass_pane' : (a + y) % 4 === 1 ? 'light_blue_stained_glass_pane' : 'blue_stained_glass_pane'))

  // ---- 1. Основание: цоколь и пол (весь план собора).
  const planX0 = CAT.xW - 2; const planX1 = CAT.ax + 15
  for (let x = planX0; x <= planX1; x++) {
    for (let z = zc - 20; z <= zc + 20; z++) {
      const dz = dzOf(z)
      let inside = false
      if (x >= CAT.xW && x <= CAT.ax && dz <= 11) inside = true
      if (x >= CAT.xW && x <= CAT.xT && dz <= 16) inside = true // башни
      if (x >= CAT.xC0 && x <= CAT.xC1 && dz <= 18) inside = true // трансепт
      if (inApse(x, z, 11.5)) inside = true
      if (!inside) continue
      B.S(x, F - 1, z, (x + z) % 2 ? 'polished_andesite' : 'smooth_stone')
    }
  }

  // ---- 2. Стены приделов (|dz| = 11) и обхода, приделы внутри — воздух.
  const aisleTop = F + 11 // верх стены придела (y 41)
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x >= CAT.xC0 && x <= CAT.xC1) continue
    for (const s of [-1, 1]) {
      const z = zc + s * 11
      for (let y = F; y <= aisleTop; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP) // цоколь
    }
  }
  for (let x = CAT.ax; x <= CAT.ax + 12; x++) {
    for (let z = zc - 12; z <= zc + 12; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (x <= CAT.ax) continue
      if (r > 10.5 && r <= 11.5) { for (let y = F; y <= aisleTop; y++) B.S(x, y, z, T); B.S(x, F, z, TP) }
    }
  }
  // Своды приделов: потолок y 39..40 (перевёрнутые ступени у стен), кровля
  // приделов — односкатная от 42 у стены к 46 у нефа.
  for (let x = CAT.xW; x <= CAT.ax + 11; x++) {
    for (let z = zc - 10; z <= zc + 10; z++) {
      const dz = dzOf(z)
      const apse = x > CAT.ax
      const r = apse ? Math.hypot(x - CAT.ax, z - zc) : dz
      if (x >= CAT.xC0 && x <= CAT.xC1) continue
      if (!apse && (dz < 7 || x <= CAT.xT)) continue
      if (apse && (r <= 6.5 || r > 10.5)) continue
      // Своды придела.
      B.S(x, F + 10, z, T); B.S(x, F + 11, z, T)
      const outer = apse ? r > 9.5 : dz === 10
      const innerSide = apse ? r <= 7.5 : dz === 7
      if (outer || innerSide) {
        const toAxis = apse ? dirTo(CAT.ax - x, zc - z, true) : (z < zc ? 'south' : 'north')
        B.S(x, F + 9, z, stairs(T, outer ? OPP[toAxis] : toAxis, 'top'))
      }
      // Кровля придела.
      const t = apse ? (10.5 - r) : (10 - dz) // 0 у внешней стены
      const yr = F + 12 + Math.floor(t)
      B.S(x, yr, z, t % 1 >= 0.5 || (Math.floor(t) % 2 === 1) ? stairs('deepslate_tiles', apse ? dirTo(CAT.ax - x, zc - z, true) : (z < zc ? 'south' : 'north')) : 'deepslate_tiles')
      for (let y = F + 12; y < yr; y++) B.S(x, y, z, T)
    }
  }
  // Свес кровли приделов над стенами.
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x >= CAT.xC0 && x <= CAT.xC1) continue
    for (const s of [-1, 1]) { B.S(x, F + 12, zc + s * 12, stairs('deepslate_tiles', s < 0 ? 'south' : 'north')); B.S(x, F + 11, zc + s * 12, stairs(T, s < 0 ? 'south' : 'north', 'top')) }
  }

  // ---- 3. Аркада и стены нефа (|dz| = 6) с трифорием и верхними окнами.
  const naveTop = 56
  const arcade = (x, z, along, isPier) => {
    for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    if (isPier) { B.S(x, F, z, TP); B.S(x, F + 8, z, TC); return }
  }
  const pierXs = [...CAT.piers, CAT.xC0, CAT.xC1, 16, CAT.ax]
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x > CAT.xC0 && x < CAT.xC1) continue
    for (const s of [-1, 1]) {
      const z = zc + s * 6
      const isPier = pierXs.includes(x)
      arcade(x, z, 'x', isPier)
    }
  }
  // Проёмы аркады, трифорий, окна — по пролётам.
  const bays = []
  const allPiers = [CAT.xT, ...CAT.piers, CAT.xC0]
  for (let i = 0; i < allPiers.length - 1; i++) bays.push([allPiers[i], allPiers[i + 1]])
  bays.push([CAT.xC1, 16], [16, CAT.ax])
  for (const [pa, pb] of bays) {
    const a0 = pa + 1; const a1 = pb - 1
    const w = a1 - a0 + 1 // 5
    for (const s of [-1, 1]) {
      const z = zc + s * 6
      const P = B.plane('x', z, s < 0 ? 'north' : 'south')
      // Арка аркады: проём y 30..37, стрельчатый верх.
      for (let a = a0; a <= a1; a++) for (let y = F; y <= F + 7; y++) P.set(a, y, '')
      P.set(a0, F + 7, stairs(T, P.lo, 'top')); P.set(a1, F + 7, stairs(T, P.hi, 'top'))
      P.set(a0 + 1, F + 8, stairs(T, P.lo, 'top')); P.set(a1 - 1, F + 8, stairs(T, P.hi, 'top'))
      P.set(a0 + 2, F + 8, ''); P.set(a0 + 2, F + 9, TC)
      // Трифорий: y 41..43, три малые арки.
      for (const a of [a0, a0 + 2, a1]) { P.set(a, F + 11, ''); P.set(a, F + 12, ''); P.set(a, F + 13, stairs(T, P.in, 'top')) }
      for (let a = a0; a <= a1; a++) P.set(a, F + 10, TP)
      // Верхнее окно (клересторий): 3 шириной со средником, y 46..51, острие 53.
      B.lancet(P, a0 + 1, F + 16, 3, 6, { famName: T, glass: glassHigh, mullion: true, sill: false })
      // Окно придела: в стене |dz| = 11.
      const Pa = B.plane('x', zc + s * 11, s < 0 ? 'north' : 'south')
      B.lancet(Pa, a0 + 1, F + 2, 3, 5, { famName: T, glass: glassAisle, mullion: true })
      void w
    }
  }
  // Апсида: кольцо опор r 6 (стена до верха нефа), проёмы аркады, окна.
  const apseAng = []
  for (let k = -3; k <= 3; k++) apseAng.push(k * Math.PI / 7)
  for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
    for (let z = zc - 7; z <= zc + 7; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 5.5 && r <= 6.6) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    }
  }
  for (const ang of apseAng) {
    // Проём аркады и окно: клетки у луча.
    for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
      for (let z = zc - 7; z <= zc + 7; z++) {
        const r = Math.hypot(x - CAT.ax, z - zc)
        if (!(r > 5.5 && r <= 6.6)) continue
        const a = Math.atan2(z - zc, x - CAT.ax)
        const da = Math.abs(a - ang)
        if (da < 0.2) {
          for (let y = F; y <= F + 7; y++) B.S(x, y, z, '')
          for (let y = F + 16; y <= F + 22; y++) B.S(x, y, z, glassHigh(x + z, y))
        }
      }
    }
    // Окна обхода: в кольце r 11 между контрфорсами.
    for (const d of [-0.1, 0.1]) {
      const a = ang + Math.PI / 14 + d * 0
      const ex = Math.round(CAT.ax + Math.cos(a) * 11); const ez = Math.round(zc + Math.sin(a) * 11)
      if (ex <= CAT.ax) continue
      for (let y = F + 2; y <= F + 7; y++) B.S(ex, y, ez, glassAisle(ex + ez, y))
    }
  }

  // ---- 4. Свод нефа, хора и трансепта; крыша.
  const vaultProfile = { 5: 50, 4: 52, 3: 53, 2: 54, 1: 55, 0: 55 }
  const vaultCell = (x, z, dz, along, ribs) => {
    const yv = vaultProfile[dz]
    for (let y = yv; y <= naveTop; y++) B.S(x, y, z, T)
    if (dz >= 1) {
      const toWall = along === 'x' ? (z < zc ? 'north' : 'south') : (x < CAT.xC0 + 6 ? 'west' : 'east')
      B.S(x, yv, z, stairs(ribs ? TP : T, toWall, 'top'))
    }
  }
  for (let x = CAT.xW + 1; x <= CAT.ax; x++) {
    for (let z = zc - 5; z <= zc + 5; z++) {
      const dz = dzOf(z)
      const rib = pierXs.includes(x) || x === CAT.xT
      vaultCell(x, z, dz, 'x', rib)
    }
  }
  // Трансепт: свод вдоль z.
  for (let z = zc - 17; z <= zc + 17; z++) {
    if (dzOf(z) <= 5) continue
    for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) {
      const d = Math.abs(x - (CAT.xC0 + CAT.xC1) / 2)
      vaultCell(x, z, Math.round(d), 'z', dzOf(z) % 6 === 0)
    }
  }
  // Апсида: полукупол.
  for (let x = CAT.ax + 1; x <= CAT.ax + 6; x++) {
    for (let z = zc - 6; z <= zc + 6; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 5.5) continue
      const yv = vaultProfile[Math.min(5, Math.round(r))]
      for (let y = yv; y <= naveTop; y++) B.S(x, y, z, T)
      if (r >= 1) B.S(x, yv, z, stairs(T, dirTo(x - CAT.ax, z - zc, true), 'top'))
    }
  }
  // Стены трансепта (x = −2 и 10 при |dz| 12..18) и торцы (|dz| = 18).
  for (let z = zc - 18; z <= zc + 18; z++) {
    const dz = dzOf(z)
    if (dz < 11) continue
    for (const x of [CAT.xC0, CAT.xC1]) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
  }
  for (const s of [-1, 1]) {
    const z = zc + s * 18
    for (let x = CAT.xC0; x <= CAT.xC1; x++) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let zz = zc + s * 7; s < 0 ? zz >= zc + s * 17 : zz <= zc + s * 17; zz += s) for (let y = F; y < 50; y++) if (dzOf(zz) >= 7) B.S(x, y, zz, '')
  }
  // Приделы в трансепте открыты: убрать стены |dz| = 11 внутри трансепта
  // (их там и нет), открыть проход нефа в трансепт — аркада средокрестия.
  for (let z = zc - 17; z <= zc + 17; z++) for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let y = F; y < 50; y++) if (dzOf(z) <= 17) B.S(x, y, z, '')
  for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let z = zc - 17; z <= zc + 17; z++) { const dz = dzOf(z); const yv = dz <= 5 ? vaultProfile[dz] : vaultProfile[Math.round(Math.abs(x - 4))]; for (let y = F; y < Math.min(yv, 50); y++) B.S(x, y, z, '') }
  // Внутри нефа — воздух под сводом.
  for (let x = CAT.xW + 1; x <= CAT.ax + 5; x++) {
    for (let z = zc - 5; z <= zc + 5; z++) {
      if (x > CAT.ax && Math.hypot(x - CAT.ax, z - zc) > 5.5) continue
      const dz = dzOf(z)
      const yv = x > CAT.ax ? vaultProfile[Math.min(5, Math.round(Math.hypot(x - CAT.ax, z - zc)))] : vaultProfile[dz]
      for (let y = F; y < yv; y++) B.S(x, y, z, '')
    }
  }
  // Приделы — воздух.
  for (let x = CAT.xT + 1; x <= CAT.ax + 11; x++) {
    for (let z = zc - 10; z <= zc + 10; z++) {
      const dz = dzOf(z)
      const apse = x > CAT.ax
      const r = apse ? Math.hypot(x - CAT.ax, z - zc) : dz
      if (apse ? (r > 6.6 && r <= 10.5) : (dz >= 7 && dz <= 10)) for (let y = F; y < F + 9; y++) B.S(x, y, z, '')
      if (!apse && dz >= 7 && dz <= 10) {
        const toWall = z < zc ? 'north' : 'south'
        if (dz === 10) B.S(x, F + 9, z, stairs(T, toWall, 'top'))
        else if (dz === 7) B.S(x, F + 9, z, stairs(T, OPP[toWall], 'top'))
        else B.S(x, F + 9, z, '')
      }
    }
  }
  // Крыша нефа и хора: 2:1, конёк ~67; трансепт поперёк; апсида — полуконус.
  const roofE = naveTop + 1
  for (let x = CAT.xW + 1; x <= CAT.ax; x++) for (const s of [-1, 1]) { B.S(x, roofE, zc + s * 6, TW) }
  B.gable(CAT.xW + 1, CAT.ax, zc - 5, zc + 5, 'x', roofE, { f: 'deepslate_tiles', slope: 2, gable: T, ov: 0, ends: false })
  B.gable(CAT.xC0 + 1, CAT.xC1 - 1, zc - 17, zc + 17, 'z', roofE, { f: 'deepslate_tiles', slope: 2, gable: T, ov: 0 })
  for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
    for (let z = zc - 7; z <= zc + 7; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 6.5) continue
      if (r > 5.5) { B.S(x, roofE, z, TW); continue }
      const yt = roofE - 1 + Math.round((5.5 - r) * 2)
      for (let y = roofE; y < yt; y++) B.S(x, y, z, 'deepslate_tiles')
      B.S(x, yt, z, r < 0.7 ? 'deepslate_tiles' : stairs('deepslate_tiles', dirTo(CAT.ax - x, zc - z, true)))
    }
  }

  // ---- 5. Контрфорсы с пинаклями и аркбутаны.
  const buttress = (x, s) => {
    for (let dzz = 12; dzz <= 14; dzz++) {
      const z = zc + s * dzz
      const topY = dzz === 12 ? F + 21 : dzz === 13 ? F + 17 : F + 12
      for (let y = F - 1; y <= topY; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP)
      B.S(x, topY + 1, z, stairs(T, s < 0 ? 'south' : 'north'))
    }
    B.pinnacle(x, F + 22, zc + s * 12, T, 4)
    B.pinnacle(x, F + 13, zc + s * 14, T, 2)
    // Аркбутан: от контрфорса (|dz| 11, y 48) к стене нефа (|dz| 7, y 52).
    for (let dzz = 7; dzz <= 11; dzz++) {
      const z = zc + s * dzz
      const yt = F + 18 + (11 - dzz)
      B.S(x, yt, z, stairs(T, s < 0 ? 'south' : 'north'))
      B.S(x, yt - 1, z, T)
      if (dzz >= 9) B.S(x, yt - 2, z, stairs(T, s < 0 ? 'north' : 'south', 'top'))
    }
    B.S(x, F + 11, zc + s * 11, T)
  }
  for (const x of [...CAT.piers, 16, CAT.ax]) for (const s of [-1, 1]) buttress(x, s)
  // Контрфорсы апсиды: радиальные.
  for (let k = 0; k < apseAng.length - 1; k++) {
    const a = (apseAng[k] + apseAng[k + 1]) / 2
    const cells = []
    for (let r = 11.5; r <= 14.5; r += 0.25) {
      const x = Math.round(CAT.ax + Math.cos(a) * r); const z = Math.round(zc + Math.sin(a) * r)
      if (!cells.some(c => c[0] === x && c[1] === z)) cells.push([x, z, r])
    }
    cells.forEach(([x, z, r]) => {
      const topY = r < 12.5 ? F + 21 : r < 13.5 ? F + 17 : F + 12
      for (let y = F - 1; y <= topY; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP)
    })
    const [px, pz] = cells[0]
    B.pinnacle(px, F + 22, pz, T, 4)
    const [ox, oz] = cells[cells.length - 1]
    B.pinnacle(ox, F + 13, oz, T, 2)
    // Аркбутан к стене апсиды (r 6.6 → 11).
    for (let r = 7; r <= 11; r++) {
      const x = Math.round(CAT.ax + Math.cos(a) * r); const z = Math.round(zc + Math.sin(a) * r)
      const yt = F + 18 + (11 - r)
      B.S(x, yt, z, stairs(T, dirTo(CAT.ax - x, zc - z, true)))
      B.S(x, yt - 1, z, T)
    }
  }

  // ---- 6. Западный фасад: две башни, портал, галерея, роза, фронтон.
  const towerTop = 72
  for (const s of [-1, 1]) {
    const zc0 = zc + s * 12 // центр башни (|dz| 7..17)
    const tx0 = CAT.xW; const tx1 = CAT.xT
    const tz0 = zc0 - 5; const tz1 = zc0 + 5
    for (let x = tx0; x <= tx1; x++) {
      for (let z = tz0; z <= tz1; z++) {
        const edge = x === tx0 || x === tx1 || z === tz0 || z === tz1
        for (let y = F; y <= towerTop; y++) B.S(x, y, z, edge ? T : '')
        if (!edge) B.S(x, towerTop, z, T)
      }
    }
    // Угловые контрфорсы башен со ступенчатыми уступами.
    for (const [cx, cz] of [[tx0, tz0], [tx0, tz1], [tx1, tz0], [tx1, tz1]]) {
      const ox = cx === tx0 ? -1 : 1; const oz = cz === tz0 ? -1 : 1
      if (cx === tx1 && Math.abs(cz - zc) < 8) continue // к нефу
      for (const [bx, bz, depth] of [[cx + ox, cz, 2], [cx, cz + oz, 2]]) {
        for (let y = F; y <= towerTop - 4; y++) {
          const k = y < F + 16 ? 2 : y < F + 32 ? 1 : 0
          if (k >= 1) B.S(bx, y, bz, T)
          if (k >= 2) B.S(bx + (bx === cx ? 0 : ox), y, bz + (bz === cz ? 0 : oz), T)
        }
        B.S(bx + (bx === cx ? 0 : ox), F + 16, bz + (bz === cz ? 0 : oz), stairs(T, bx === cx ? (oz < 0 ? 'south' : 'north') : (ox < 0 ? 'east' : 'west')))
        void depth
      }
      B.pinnacle(cx + ox, towerTop - 3, cz + oz, T, 5)
    }
    // Окна башен: ярусы.
    for (const [Pl, aC] of [[B.plane('z', tx0, 'west'), zc0], [B.plane('x', s < 0 ? tz0 : tz1, s < 0 ? 'north' : 'south'), (tx0 + tx1) / 2]]) {
      B.lancet(Pl, aC - 1, F + 17, 3, 7, { famName: T, glass: glassWin(F + 17, 7), mullion: true, frame: TP })
      // Звонница: две высокие арки с деревянными жалюзи.
      const louver = () => st('spruce_trapdoor', { facing: Pl.in, half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })
      for (const off of [-3, 2]) B.lancet(Pl, aC + off, F + 30, 2, 9, { famName: T, glass: louver, sill: true, frame: TP })
      Pl.set(aC, F + 40, TCB); Pl.set(aC, F + 39, TCB)
      // Глухая аркада внизу (ниши).
      for (const off of [-4, -1, 2]) {
        for (let y = F + 2; y <= F + 9; y++) for (let a = aC + off; a <= aC + off + 1; a++) { Pl.set(a, y, '', 0); Pl.set(a, y, T, -1) }
        for (let a = aC + off; a <= aC + off + 1; a++) Pl.set(a, F + 1, TP, 0)
        Pl.set(aC + off, F + 9, stairs(T, Pl.lo, 'top'), 0); Pl.set(aC + off + 1, F + 9, stairs(T, Pl.hi, 'top'), 0)
      }
    }
    // Карнизные тяги по периметру башни.
    for (const yb of [F + 14, F + 28, towerTop - 1]) {
      for (let x = tx0 - 1; x <= tx1 + 1; x++) {
        for (let z = tz0 - 1; z <= tz1 + 1; z++) {
          const ed = x === tx0 - 1 || x === tx1 + 1 || z === tz0 - 1 || z === tz1 + 1
          if (!ed || B.G(x, yb, z)) continue
          B.S(x, yb, z, stairs(T, x === tx0 - 1 ? 'east' : x === tx1 + 1 ? 'west' : z === tz0 - 1 ? 'south' : 'north', 'top'))
        }
      }
    }
    // Галерея наверху: парапет с ажуром и пинакли по углам.
    for (let x = tx0 - 1; x <= tx1 + 1; x++) for (let z = tz0 - 1; z <= tz1 + 1; z++) {
      const edge = x === tx0 - 1 || x === tx1 + 1 || z === tz0 - 1 || z === tz1 + 1
      if (!edge) continue
      B.S(x, towerTop, z, stairs(T, x === tx0 - 1 ? 'east' : x === tx1 + 1 ? 'west' : z === tz0 - 1 ? 'south' : 'north', 'top'))
      B.S(x, towerTop + 1, z, TW)
    }
    // Винтовая лестница с земли в звонницу: площадки через 7 (30 … 58),
    // первая — к проходу в неф/придел (у восточной стены, ближе к оси).
    const bcx = (tx0 + tx1) / 2
    const land = s < 0 ? 'east' : 'north'
    B.spiral(bcx, zc0, 4.2, F, F + 28, { f: T, rev: 7, landDir: land, newel: T })
    // Пол звонницы (58) — вокруг колодца лестницы и над нижней частью
    // последнего марша (ступени там ниже 55 — голове хватает).
    const land0 = { north: -Math.PI / 2, east: 0 }[land]
    for (let x = tx0 + 1; x < tx1; x++) {
      for (let z = tz0 + 1; z < tz1; z++) {
        const dx = x - bcx; const dz = z - zc0
        if (Math.hypot(dx, dz) > 4.2) { B.S(x, F + 27, z, 'spruce_planks'); continue }
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue
        let th = Math.atan2(dz, dx) - land0 + Math.PI / 8
        th = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        const sec = Math.floor(th / (2 * Math.PI) * 16) % 16
        if (sec >= 2 && sec <= 9) B.S(x, F + 27, z, 'spruce_planks') // над нижней частью марша — пол (голове хватает)
      }
    }
    // Колокола — на балках под звонницей (y 61), в углах над полом:
    // с пола до языка рукой подать.
    for (const bz of [zc0 - 3, zc0 + 3]) for (let x = tx0 + 1; x < tx1; x++) B.S(x, F + 31, bz, st('dark_oak_log', { axis: 'x' }))
    for (const bx of [tx0 + 1, tx1 - 1]) for (const bz of [zc0 - 3, zc0 + 3]) B.S(bx, F + 30, bz, st('bell', { attachment: 'ceiling', facing: 'north', powered: 'false' }))
    for (let x = tx0 + 1; x < tx1; x++) for (let z = tz0 + 1; z < tz1; z++) B.S(x, F + 37, z, 'dark_oak_planks')
    // Шпилёк.
    B.spire((tx0 + tx1) / 2, zc0, 3.6, towerTop + 1, 14, { f: 'oxidized_cut_copper', grate: 'oxidized_copper_grate', crocket: true, every: 4, cross: 'z' })
  }
  // Центр фасада между башнями: стена x = xW от F до 64.
  const PW = B.plane('z', CAT.xW, 'west')
  for (let z = zc - 6; z <= zc + 6; z++) for (let y = F; y <= 66; y++) B.S(CAT.xW, y, z, T)
  // Стены нефа между башнями (|dz| = 6).
  for (let x = CAT.xW + 1; x <= CAT.xT; x++) for (const s of [-1, 1]) for (let y = F; y <= naveTop; y++) B.S(x, y, zc + s * 6, T)
  // Портал: три ступени архивольтов (x −39, −38, −37), двери в x −37.
  for (let z = zc - 6; z <= zc + 6; z++) for (let y = F - 1; y <= F + 14; y++) { B.S(CAT.xW - 1, y, z, T); B.S(CAT.xW - 2, y, z, T) }
  for (let z = zc - 4; z <= zc + 4; z++) B.S(CAT.xW - 3, F - 1, z, stairs(T, 'east'))
  const portal = (x, half, h) => {
    for (let z = zc - half; z <= zc + half; z++) for (let y = F; y < F + h; y++) B.S(x, y, z, '')
    B.S(x, F + h, zc - half, stairs(T, 'north', 'top')); B.S(x, F + h, zc + half, stairs(T, 'south', 'top'))
    for (let z = zc - half + 1; z <= zc + half - 1; z++) B.S(x, F + h, z, '')
    if (half >= 2) { B.S(x, F + h + 1, zc - half + 1, stairs(T, 'north', 'top')); B.S(x, F + h + 1, zc + half - 1, stairs(T, 'south', 'top')); for (let z = zc - half + 2; z <= zc + half - 2; z++) B.S(x, F + h + 1, z, '') }
    if (half >= 3) { B.S(x, F + h + 2, zc, '') }
  }
  portal(CAT.xW - 2, 5, 10); portal(CAT.xW - 1, 4, 9); portal(CAT.xW, 3, 7)
  // Тимпан над дверьми: всё открытое в арке выше дверей — резной камень.
  for (let z = zc - 3; z <= zc + 3; z++) for (let y = F + 2; y <= F + 10; y++) if (!B.G(CAT.xW, y, z)) B.S(CAT.xW, y, z, (y + z) % 2 ? TCB : TC)
  // Перемычка и резьба до острия арки.
  for (let z = zc - 2; z <= zc + 2; z++) {
    B.S(CAT.xW, F + 2, z, slab(TP, 'top'))
    for (let y = F + 3; y <= F + 7; y++) if (Math.abs(z - zc) + (y - F - 3) <= 3) B.S(CAT.xW, y, z, (y + z) % 2 ? TCB : TC)
  }
  for (let z = zc - 2; z <= zc + 2; z++) { B.door(CAT.xW, F, z, 'east', 'dark_oak_door', z < zc ? 'left' : 'right') }
  for (const z of [zc - 3, zc + 3]) for (let y = F; y <= F + 6; y++) B.S(CAT.xW, y, z, y === F + 6 ? TC : TPW)
  for (const z of [zc - 4, zc + 4]) for (let y = F; y <= F + 7; y++) B.S(CAT.xW - 1, y, z, y === F + 7 ? TC : TPW)
  for (const z of [zc - 5, zc + 5]) for (let y = F; y <= F + 8; y++) B.S(CAT.xW - 2, y, z, y === F + 8 ? TC : TPW)
  // Вимперг — треугольник над порталом.
  for (let i = 0; i <= 6; i++) {
    for (const s of [-1, 1]) B.S(CAT.xW - 2, F + 13 + i, zc + s * (6 - i), stairs(T, s < 0 ? 'south' : 'north'))
    for (let z = zc - (6 - i) + 1; z <= zc + (6 - i) - 1; z++) B.S(CAT.xW - 2, F + 13 + i, z, T)
  }
  B.S(CAT.xW - 3, F + 15, zc, TCB); B.S(CAT.xW - 3, F + 14, zc, stairs(T, 'east', 'top'))
  B.pinnacle(CAT.xW - 2, F + 20, zc, T, 3)
  for (const s of [-1, 1]) B.pinnacle(CAT.xW - 2, F + 15, zc + s * 6, T, 2)
  // Галерея королей: ниши y 47..50 по x −37.
  for (let z = zc - 6; z <= zc + 6; z++) {
    B.S(CAT.xW - 1, F + 16, z, stairs(T, 'east', 'top'))
    B.S(CAT.xW - 1, F + 21, z, stairs(T, 'east', 'top'))
    if ((z - zc) % 2 === 0) { for (let y = F + 17; y <= F + 19; y++) B.S(CAT.xW, y, z, ''); B.S(CAT.xW, F + 17, z, TP); B.S(CAT.xW, F + 18, z, TPW); B.S(CAT.xW, F + 20, z, stairs(T, 'east', 'top')) }
    for (let y = F + 16; y <= F + 21; y++) if ((z - zc) % 2 !== 0) B.S(CAT.xW - 1, y, z, y === F + 16 || y === F + 21 ? stairs(T, 'east', 'top') : TPW)
  }
  // Роза: центр y 58, R 5.
  B.rose(PW, zc, 58, 6.3, { famName: T, spokes: 8, colors: ['yellow', 'blue', 'red', 'blue', 'purple'], ring: TC, boss: TCB })
  // Фронтон над розой и балюстрада.
  for (let z = zc - 6; z <= zc + 6; z++) { B.S(CAT.xW, 65, z, T); B.S(CAT.xW - 1, 65, z, stairs(T, 'east', 'top')); B.S(CAT.xW - 1, 66, z, TW) }
  for (let i = 0; i <= 6; i++) {
    for (let z = zc - (6 - i); z <= zc + (6 - i); z++) B.S(CAT.xW, 66 + i, z, T)
    for (const s of [-1, 1]) B.S(CAT.xW - 1, 67 + i, zc + s * (6 - i), stairs(T, s < 0 ? 'south' : 'north'))
  }
  for (const y of [68, 69]) B.S(CAT.xW, y, zc, 'glass_pane')
  B.pinnacle(CAT.xW - 1, 73, zc, T, 3)

  // ---- 7. Торцы трансепта: портал, роза, фронтон, башенки по углам.
  for (const s of [-1, 1]) {
    const z = zc + s * 18
    const out = s < 0 ? 'north' : 'south'
    const P = B.plane('x', z, out)
    const xm = (CAT.xC0 + CAT.xC1) / 2 // 4
    // Портал.
    for (let x = xm - 2; x <= xm + 2; x++) for (let y = F - 1; y <= F + 9; y++) P.set(x, y, T, 1)
    for (let x = xm - 1; x <= xm + 1; x++) for (let y = F; y <= F + 4; y++) { P.set(x, y, '', 1); P.set(x, y, y === F + 2 ? slab(TP, 'top') : y > F + 2 ? TCB : '', 0) }
    P.set(xm - 1, F + 5, stairs(T, 'west', 'top'), 1); P.set(xm + 1, F + 5, stairs(T, 'east', 'top'), 1); P.set(xm, F + 5, TCB, 1)
    P.set(xm - 1, F + 5, stairs(T, 'west', 'top'), 0); P.set(xm + 1, F + 5, stairs(T, 'east', 'top'), 0); P.set(xm, F + 5, TCB, 0)
    B.door(xm - 1, F, z, OPP[out], 'dark_oak_door', 'left'); B.door(xm, F, z, OPP[out], 'dark_oak_door', 'left'); B.door(xm + 1, F, z, OPP[out], 'dark_oak_door', 'right')
    for (let i = 0; i <= 3; i++) { P.set(xm - (3 - i), F + 10 + i, stairs(T, 'east'), 1); P.set(xm + (3 - i), F + 10 + i, stairs(T, 'west'), 1); for (let x = xm - (3 - i) + 1; x < xm + (3 - i); x++) P.set(x, F + 10 + i, T, 1) }
    B.pinnacle(xm, F + 14, z + s, T, 2)
    // Окна-ланцеты над порталом, роза.
    for (const off of [-4, 3]) B.lancet(P, xm + off, F + 4, 2, 7, { famName: T, glass: glassAisle })
    B.rose(P, xm, 49, 4.6, { famName: T, spokes: 10, colors: ['yellow', 'red', 'blue', 'red', 'blue'], ring: TC, boss: TCB })
    // Фронтон трансепта над кровлей (y 57..67) с ажурным окошком.
    for (let i = 0; i <= 6; i++) {
      for (let x = xm - (6 - i); x <= xm + (6 - i); x++) B.S(x, 57 + i * 1.5 | 0, z, T)
    }
    for (let y = 57; y <= 66; y++) { const hw = Math.max(0, 6 - Math.floor((y - 57) / 1.5)); for (let x = xm - hw; x <= xm + hw; x++) B.S(x, y, z, T); if (hw >= 1) { P.set(xm - hw - 1, y, stairs(T, 'east'), 1); P.set(xm + hw + 1, y, stairs(T, 'west'), 1) } }
    P.set(xm, 60, 'purple_stained_glass_pane'); P.set(xm, 61, 'purple_stained_glass_pane')
    B.pinnacle(xm, 67, z, T, 3)
    // Угловые башенки трансепта.
    for (const cx of [CAT.xC0 - 1, CAT.xC1 + 1]) {
      for (let y = F - 1; y <= 64; y++) { B.S(cx, y, z, T); B.S(cx, y, z + s, T) }
      B.S(cx, 57, z + s, TCB)
      B.pinnacle(cx, 65, z, T, 4)
      B.pinnacle(cx, 58, z + s, T, 2)
    }
  }

  // ---- 8. Башня средокрестия и шпиль.
  const ctop = 73
  const tx0 = CAT.xC0; const tx1 = CAT.xC1; const tz0 = zc - 6; const tz1 = zc + 6
  for (let x = tx0; x <= tx1; x++) {
    for (let z = tz0; z <= tz1; z++) {
      const edge = x === tx0 || x === tx1 || z === tz0 || z === tz1
      for (let y = roofE; y <= ctop; y++) B.S(x, y, z, edge ? T : '')
      if (!edge) B.S(x, ctop, z, T)
    }
  }
  for (const [Pl, a0] of [[B.plane('x', tz0, 'north'), tx0], [B.plane('x', tz1, 'south'), tx0], [B.plane('z', tx0, 'west'), tz0], [B.plane('z', tx1, 'east'), tz0]]) {
    const louver = () => st('spruce_trapdoor', { facing: Pl.in, half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })
    for (const off of [2, 8]) B.lancet(Pl, a0 + off, 61, 3, 8, { famName: T, glass: louver, mullion: true, frame: TP })
    for (let a = a0; a <= a0 + 12; a++) { Pl.set(a, 60, stairs(T, Pl.in, 'top'), 1); Pl.set(a, ctop, stairs(T, Pl.in, 'top'), 1); Pl.set(a, ctop + 1, TW, 1) }
  }
  for (const [cx, cz] of [[tx0, tz0], [tx0, tz1], [tx1, tz0], [tx1, tz1]]) {
    const ox = cx === tx0 ? -1 : 1; const oz = cz === tz0 ? -1 : 1
    for (let y = roofE; y <= ctop; y++) { B.S(cx + ox, y, cz, T); B.S(cx, y, cz + oz, T); B.S(cx + ox, y, cz + oz, T) }
    B.pinnacle(cx + ox, ctop + 1, cz + oz, T, 6)
  }
  B.spire((tx0 + tx1) / 2, zc, 5.6, ctop + 1, 30, { f: 'oxidized_cut_copper', grate: 'oxidized_copper_grate', crocket: true, every: 4, cross: 'z' })

  // ---- 9. Башня-фонарь: свод средокрестия вскрыт до потолка башни (73) —
  // свет золотых витражей падает в собор с высоты ~40 блоков. Потолок —
  // лазурное «небо» с золотым солнцем, от него вниз — лучи (концевые стержни).
  const lx0 = tx0 + 1; const lx1 = tx1 - 1; const lz0 = tz0 + 1; const lz1 = tz1 - 1
  const lcx = (tx0 + tx1) / 2
  for (let x = lx0; x <= lx1; x++) for (let z = lz0; z <= lz1; z++) for (let y = 50; y < ctop; y++) B.S(x, y, z, '')
  for (let x = lx0; x <= lx1; x++) {
    for (let z = lz0; z <= lz1; z++) {
      const dx = x - lcx; const dz = z - zc; const r = Math.hypot(dx, dz)
      const ray = (dx === 0 || dz === 0 || Math.abs(dx) === Math.abs(dz)) && r <= 5.8
      B.S(x, ctop, z, r <= 1.1 ? 'glowstone' : r <= 2.3 ? 'gold_block' : ray ? ((Math.round(r) % 2) ? 'gold_block' : 'yellow_glazed_terracotta') : ((x * 7 + z * 3) % 11 === 0 ? 'glowstone' : 'lapis_block'))
    }
  }
  // Лучи: кольца стержней разной длины, свисают с «неба».
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8
    for (const [rr, base] of [[2.6, 7], [4.2, 4]]) {
      const x = Math.round(lcx + Math.cos(a) * rr); const z = Math.round(zc + Math.sin(a) * rr)
      if (x < lx0 || x > lx1 || z < lz0 || z > lz1 || B.G(x, ctop - 1, z)) continue
      const len = base + Math.floor(hash(x, 0, z, 91) * 6)
      for (let i = 1; i <= len; i++) B.S(x, ctop - i, z, st('end_rod', { facing: 'down' }))
    }
  }
  // Жалюзи башни — золотые витражи (свет «оттуда»).
  const lantGlass = (a, y) => (y >= 67 ? 'white_stained_glass_pane' : ((a + y) % 4 === 0 ? 'orange_stained_glass_pane' : 'yellow_stained_glass_pane'))
  for (const [Pl, a0] of [[B.plane('x', tz0, 'north'), tx0], [B.plane('x', tz1, 'south'), tx0], [B.plane('z', tx0, 'west'), tz0], [B.plane('z', tx1, 'east'), tz0]]) {
    for (const off of [2, 8]) B.lancet(Pl, a0 + off, 61, 3, 8, { famName: T, glass: lantGlass, mullion: true, frame: TP, sill: false })
  }

  // ---- 10. Окулюс над алтарём: в полукуполе апсиды и кровле — колодец с
  // жёлтым стеклом наверху; из него к престолу свисают лучи.
  const ox = CAT.ax + 2
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = ox + dx; const z = zc + dz
    let yt = -1
    for (let y = 70; y >= 50; y--) if (B.G(x, y, z)) { yt = y; break }
    const yv = vaultProfile[Math.min(5, Math.round(Math.hypot(x - CAT.ax, z - zc)))]
    for (let y = yv; y < yt; y++) B.S(x, y, z, '')
    B.S(x, yt, z, 'yellow_stained_glass')
    if (dx || dz) B.S(x, yv, z, stairs(TP, dirTo(dx, dz, true), 'top'))
  }
  for (let y = 50; y <= 53; y++) B.S(ox, y, zc, st('end_rod', { facing: 'down' }))
}

// --------------------------------------------------------- убранство собора

function furnishCathedral (ctx) {
  const { B } = ctx
  const F = CAT.F; const zc = ZC
  const { T, TP, TCB } = CAT_PAL[ctx.p.cat] || CAT_PAL.tuff
  // Скамьи в нефе: ряды через 2 по x, лицом к алтарю (на восток).
  for (let x = CAT.xT + 2; x <= CAT.xC0 - 2; x += 2) {
    for (let z = zc - 4; z <= zc + 4; z++) {
      if (Math.abs(z - zc) <= 1) continue
      B.S(x, F, z, stairs('spruce_planks', 'west'))
    }
  }
  // Ковровая дорожка по оси.
  B.carpet(CAT.xW + 1, zc - 1, CAT.ax - 2, zc + 1, F, 'red')
  // Хор: скамьи хора вдоль стен лицом к оси.
  for (let x = CAT.xC1 + 1; x <= CAT.ax - 3; x++) { B.S(x, F, zc - 5, stairs('dark_oak_planks', 'north')); B.S(x, F, zc + 5, stairs('dark_oak_planks', 'south')) }
  // Алтарь на возвышении в апсиде.
  for (let x = CAT.ax - 2; x <= CAT.ax + 4; x++) for (let z = zc - 4; z <= zc + 4; z++) if (Math.hypot(x - CAT.ax, z - zc) <= 5.5 || x <= CAT.ax) B.S(x, F, z, x === CAT.ax - 2 ? stairs(TP, 'east') : TP)
  for (let z = zc - 1; z <= zc + 1; z++) { B.S(CAT.ax + 2, F + 1, z, TCB); B.S(CAT.ax + 2, F + 2, z, 'white_carpet') }
  B.candles(CAT.ax + 2, F + 2, zc - 1, 3); B.candles(CAT.ax + 2, F + 2, zc + 1, 3)
  B.S(CAT.ax + 2, F + 2, zc, 'gold_block')
  B.S(CAT.ax + 1, F + 1, zc - 3, st('lectern', { facing: 'west', has_book: 'false', powered: 'false' }))
  // Золотой крест за алтарём.
  for (let y = F + 3; y <= F + 7; y++) B.S(CAT.ax + 4, y, zc, 'gold_block')
  B.S(CAT.ax + 4, F + 6, zc - 1, 'gold_block'); B.S(CAT.ax + 4, F + 6, zc + 1, 'gold_block')
  // Люстры: по пролёту нефа и хора, в средокрестии — большая.
  for (const x of [-32, -23, -17, -11, -5, 13, 19]) B.chandelier(x, 49 - (x > 10 ? 0 : 0), zc, 5, true)
  B.chandelier(4, 49, zc - 11, 4, true); B.chandelier(4, 49, zc + 11, 4, true)
  // Свет в приделах и обходе: фонари на цепях.
  for (let x = CAT.xT + 3; x <= CAT.ax; x += 6) for (const s of [-1, 1]) B.chandelier(x, F + 8, zc + s * 9, 1, false)
  for (const a of [-1, 0, 1]) { const x = Math.round(CAT.ax + Math.cos(a) * 8.5); const z = Math.round(zc + Math.sin(a) * 8.5); B.chandelier(x, F + 8, z, 1, false) }
  // Купель у входа.
  B.S(CAT.xT - 2, F, zc + 3, TP); B.S(CAT.xT - 2, F + 1, zc + 3, st('water_cauldron', { level: '3' }))
  // Проходы из башен в неф и приделы.
  for (const s of [-1, 1]) for (let y = F; y <= F + 6; y++) { for (let dz = 7; dz <= 10; dz++) B.S(CAT.xT, y, zc + s * dz, y <= F + 5 ? '' : stairs(T, 'west', 'top')) }

  // ---- Кафедра проповедника у последней опоры нефа (x −8, север):
  // помост 3×2 на высоте 3, лесенка с запада, аналой с Евангелием лицом к
  // пастве, резной навес-резонатор с золотым крестом.
  {
    const zp = zc - 5; const zq = zc - 4 // у аркады / над скамьями
    for (let x = -9; x <= -7; x++) {
      for (const z of [zp, zq]) { B.S(x, F, z, TP); B.S(x, F + 1, z, T); B.S(x, F + 2, z, 'dark_oak_planks') }
      B.S(x, F + 1, zq, stairs(T, 'south', 'top')) // резной поясок к нефу
    }
    B.S(-10, F, zp, T); B.S(-10, F + 1, zp, stairs('dark_oak_planks', 'east')); B.S(-11, F, zp, stairs('dark_oak_planks', 'east'))
    B.S(-9, F + 3, zq, 'dark_oak_fence'); B.S(-7, F + 3, zq, 'dark_oak_fence'); B.S(-7, F + 3, zp, 'dark_oak_fence')
    B.S(-8, F + 3, zq, st('lectern', { facing: 'north', has_book: 'true', powered: 'false' }))
    B.nbt(-8, F + 3, zq, '{Book:{id:"written_book",components:{written_book_content:{title:"Евангелие",author:"Иоанн",pages:["И свет во тьме светит, и тьма не объяла его. Ин 1:5"]}}}}')
    for (let x = -9; x <= -7; x++) for (const z of [zp, zq]) B.S(x, F + 6, z, slab('dark_oak_planks', 'top'))
    for (let y = F + 7; y <= F + 9; y++) B.S(-8, y, zp, 'gold_block')
    B.S(-9, F + 8, zp, 'gold_block'); B.S(-7, F + 8, zp, 'gold_block')
  }

  // ---- Распятие над входом в хор (x 11): крест тёмного дуба с золотым
  // средокрестием на цепях из-под свода — видно от портала через весь неф.
  {
    const xr = CAT.xC1 + 1
    for (let y = F + 12; y <= F + 19; y++) B.S(xr, y, zc, st('stripped_dark_oak_log', { axis: 'y' }))
    for (const dz of [-2, -1, 1, 2]) B.S(xr, F + 17, zc + dz, st('stripped_dark_oak_log', { axis: 'z' }))
    B.S(xr, F + 17, zc, 'gold_block')
    B.S(xr - 1, F + 17, zc, st('lantern', { hanging: 'false', waterlogged: 'false' }))
    for (let y = F + 20; y < 55; y++) B.S(xr, y, zc, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
  }

  // ---- Крестный путь: 14 стояний по стенам приделов — крест и табличка
  // у каждого простенка (опоры нефа и хора), по кругу от северо-запада.
  {
    const ST = [['I', 'Иисуса', 'осуждают', 'на смерть'], ['II', 'Иисус', 'берёт крест', ''], ['III', 'Иисус падает', 'в первый раз', ''], ['IV', 'Иисус', 'встречает', 'Мать'],
      ['V', 'Симон', 'помогает', 'нести крест'], ['VI', 'Вероника', 'отирает', 'лик Иисуса'], ['VII', 'Иисус падает', 'во второй раз', ''], ['VIII', 'Иисус', 'утешает', 'женщин'],
      ['IX', 'Иисус падает', 'в третий раз', ''], ['X', 'С Иисуса', 'снимают', 'одежды'], ['XI', 'Иисуса', 'пригвождают', 'ко кресту'], ['XII', 'Иисус', 'умирает', 'на кресте'],
      ['XIII', 'Тело Иисуса', 'снимают', 'с креста'], ['XIV', 'Тело Иисуса', 'полагают', 'во гроб']]
    // Простенки приделов (опоры нефа и хора) — по 6 на сторону, и два — в
    // обходе апсиды между окнами: север с запада на восток, обход, юг обратно.
    const xs = [...CAT.piers, 16, CAT.ax]
    const amb = a => { const x = Math.round(CAT.ax + Math.cos(a) * 10); const z = Math.round(zc + Math.sin(a) * 10); return [x, z, dirTo(CAT.ax - x, zc - z, true)] }
    const spots = [...xs.map(x => [x, zc - 10, 'south']), amb(-Math.PI / 7), amb(Math.PI / 7), ...xs.slice().reverse().map(x => [x, zc + 10, 'north'])]
    spots.forEach(([x, z, face], i) => {
      const [ax, az] = face === 'north' || face === 'south' ? [1, 0] : [0, 1]
      for (let y = F + 3; y <= F + 5; y++) B.S(x, y, z, st('stripped_dark_oak_log', { axis: 'y' }))
      for (const k of [-1, 1]) B.S(x + ax * k, F + 4, z + az * k, st('stripped_dark_oak_log', { axis: ax ? 'x' : 'z' }))
      B.sign(x, F + 2, z, face, ST[i], 'dark_oak')
      B.candles(x, F, z, 1, 'white')
    })
  }
}

// ------------------------------------------------------------ комнаты дворца

// Кнопки железной двери (x, y, z) в северной стене: на полу по обе стороны
// прямо перед дверью — сосед нижней половины, дверь получает сигнал.
function ironButtons (B, x, y, z) {
  B.S(x, y, z + 1, st('stone_button', { face: 'floor', facing: 'north', powered: 'false' }))
  B.S(x, y, z - 1, st('stone_button', { face: 'floor', facing: 'north', powered: 'false' }))
}

function furnishPalace (ctx) {
  const { B } = ctx
  const { x0, x1, zN, zS, A, Bf, Cf } = PAL
  const iz0 = zN + 1; const iz1 = zS - 1 // 17..26
  const M = ctx.masonry
  const part = (x, y0, y1, doorZ) => {
    for (let z = iz0; z <= iz1; z++) for (let y = y0; y <= y1; y++) B.S(x, y, z, M(x, y, z))
    if (doorZ !== undefined) B.door(x, y0, doorZ, 'east', 'spruce_door')
  }
  // ---- Этаж A (16): кухня | кладовая | караульня (вход) | оружейная | амбар.
  part(-17, A, Bf - 2, 21); part(-9, A, Bf - 2, 21); part(3, A, Bf - 2, 21); part(13, A, Bf - 2, 21)
  // Кухня x −29..−18: очаг у западной стены, печи, коптильни, стол, бочки.
  for (let z = 19; z <= 24; z++) { B.S(-29, A, z, 'bricks'); B.S(-29, A + 4, z, 'bricks') }
  for (let z = 20; z <= 23; z++) { B.S(-29, A, z, 'campfire[facing=east,lit=true,signal_fire=false,waterlogged=false]'); for (let y = A + 1; y <= A + 3; y++) B.S(-29, y, z, '') }
  for (let z = 19; z <= 24; z++) B.S(-28, A + 4, z, stairs('bricks', 'west', 'top'))
  for (let y = A; y <= Bf + 10; y++) for (let z = 20; z <= 23; z++) if (y > A + 4) B.S(-30, y, z, 'bricks')
  for (let x = -27; x <= -23; x++) { B.S(x, A, 17, st(x % 2 ? 'smoker' : 'furnace', { facing: 'south', lit: 'true' })) }
  for (let x = -27; x <= -23; x++) B.S(x, A + 1, 17, 'bricks')
  B.table(-26, 21, -21, 22, A, 'spruce_planks')
  for (let z = 23; z <= 26; z++) { B.barrel(-19, A, z); B.barrel(-19, A + 1, z) }
  B.S(-24, A, 26, st('water_cauldron', { level: '3' })); B.S(-23, A, 26, 'crafting_table'); B.S(-22, A, 26, st('decorated_pot', { facing: 'north', cracked: 'false', waterlogged: 'false' })) // (−25, 26) — дверь башни
  B.chandelier(-23, Bf - 2, 21, 1, false); B.lanternHang(-20, Bf - 2, 18)
  // Кладовая x −16..−10: сундуки рядами, бочки.
  for (let x = -15; x <= -11; x += 2) { B.chest2(x, A, 17, 'south'); B.chest2(x, A + 1, 17, 'south') } // пары (x, x − 1); x −17 — перегородка
  for (let x = -16; x <= -10; x++) { B.barrel(x, A, 26, 'north') }
  // Стеллаж посередине (x −15..−12): проходы к дверям x −17 и −9 (z 21) свободны.
  for (const x of [-14, -12]) B.chest2(x, A, 22, 'south')
  for (const x of [-15, -13]) B.chest2(x, A, 21, 'north')
  B.lanternHang(-13, Bf - 2, 19); B.lanternHang(-13, Bf - 2, 24)
  B.sign(-12, A + 2, 18, 'south', ['', 'Кладовая', '', ''])
  // Караульня x −8..2: столы, стойки, вход во дворец и к лестнице.
  B.table(-6, 20, -2, 20, A, 'spruce_planks'); B.bench(-6, 19, -2, 19, A, 'south'); B.bench(-6, 21, -2, 21, A, 'north')
  B.S(2, A, 17, 'cartography_table'); B.chest2(-7, A, 17, 'south')
  B.chandelier(-3, Bf - 2, 21, 1, true)
  // Двери в погреба (север, этаж A): темница и цистерна.
  // Железная дверь в темницу — в углу кладовой (x −10), мимо сундуков.
  B.door(-10, A, zN, 'north', 'iron_door'); B.S(-10, A + 2, zN, 'stone_bricks')
  for (let z = zN - 1; z >= 15; z--) for (let y = A; y <= A + 2; y++) B.S(-10, y, z, '')
  ironButtons(B, -10, A, zN)
  B.door(1, A, zN, 'north', 'spruce_door')
  for (let z = zN - 1; z >= 15; z--) for (let y = A; y <= A + 2; y++) B.S(1, y, z, '')
  // Оружейная x 4..12: стойки для брони (сущности — в списке), точило, наковальня.
  B.S(5, A, 17, 'smithing_table'); B.S(6, A, 17, st('grindstone', { face: 'floor', facing: 'south' })); B.S(7, A, 17, st('anvil', { facing: 'east' }))
  for (let x = 8; x <= 12; x += 2) B.chest2(x, A, 17, 'south')
  B.S(12, A, 26, 'fletching_table'); for (let x = 5; x <= 11; x++) B.S(x, A, 26, st('spruce_trapdoor', { facing: 'north', half: 'bottom', open: 'false', powered: 'false', waterlogged: 'false' }))
  B.chandelier(8, Bf - 2, 21, 1, true)
  ctx.armorStands = [[5, A, 24, 'north'], [7, A, 24, 'north'], [9, A, 24, 'north'], [11, A, 24, 'north']]
  // Амбар x 14..25: сено, мешки (бочки), компостер.
  for (let x = 20; x <= 25; x++) for (let z = 17; z <= 20; z++) for (let y = A; y <= A + ((x + z) % 3 === 0 ? 2 : 1); y++) B.S(x, y, z, 'hay_block')
  for (let x = 15; x <= 18; x++) { B.barrel(x, A, 17); B.barrel(x, A + 1, 17) }
  B.S(15, A, 25, st('composter', { level: '0' })); B.chest2(16, A, 26, 'north')
  B.lanternHang(19, Bf - 2, 22)

  // ---- Этаж B (23): гостевые | библиотека | горница | опочивальня.
  part(-17, Bf, Cf - 2, 21); part(-1, Bf, Cf - 2, 21); part(13, Bf, Cf - 2, 21)
  // Гостевые x −29..−18.
  B.bed(-28, Bf, 18, 'south', 'blue'); B.bed(-25, Bf, 18, 'south', 'green'); B.bed(-22, Bf, 18, 'south', 'yellow')
  for (const x of [-27, -24, -21]) B.chest(x, Bf, 17, 'south')
  B.carpet(-28, 22, -19, 25, Bf, 'light_gray')
  B.lanternHang(-24, Cf - 2, 22)
  // Библиотека x −16..−2: полки по стенам, кафедры, стол зачарования в нише.
  for (let x = -16; x <= -2; x++) for (let y = Bf; y <= Bf + 3; y++) { if (x % 5 !== 0 && Math.abs(x + 14) > 1) B.S(x, y, 17, (x + y) % 3 ? 'bookshelf' : st('chiseled_bookshelf', { facing: 'south', slot_0_occupied: 'true', slot_1_occupied: 'true', slot_2_occupied: 'false', slot_3_occupied: 'true', slot_4_occupied: 'false', slot_5_occupied: 'true' })) }
  // Ниша зачарования: стол, вокруг — 15 полок через один воздух.
  const ex = -9; const ez = 23
  B.S(ex, Bf, ez, 'enchanting_table')
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
    if (dz === 2 && Math.abs(dx) <= 1) continue // вход
    B.S(ex + dx, Bf, ez + dz, 'bookshelf'); if (dz === -2 || Math.abs(dx) === 2) B.S(ex + dx, Bf + 1, ez + dz, 'bookshelf')
  }
  for (const [lx, lz] of [[-14, 21], [-4, 21]]) B.S(lx, Bf, lz, st('lectern', { facing: 'south', has_book: 'false', powered: 'false' }))
  B.table(-15, 24, -13, 25, Bf, 'dark_oak_planks'); B.bench(-15, 26, -13, 26, Bf, 'north', 'dark_oak_planks')
  B.candles(-14, Bf + 1, 24, 3); B.candles(-4, Bf + 1, 24, 2)
  B.table(-4, 23, -2, 24, Bf, 'dark_oak_planks') // клетка (−5, 25) — выход с винтовой лестницы
  B.chandelier(-12, Cf - 2, 21, 1, true); B.chandelier(-5, Cf - 2, 21, 1, false)
  // Горница x 0..12: камин, ковёр, кресла, стол.
  // Камин x 8..12 (дверь в винный погреб — x 4, в стороне).
  for (let x = 8; x <= 12; x++) { B.S(x, Bf, 17, 'bricks'); B.S(x, Bf + 3, 17, 'bricks') }
  for (let x = 9; x <= 11; x++) { B.S(x, Bf, 17, 'campfire[facing=south,lit=true,signal_fire=false,waterlogged=false]'); B.S(x, Bf + 1, 17, ''); B.S(x, Bf + 2, 17, '') }
  for (let x = 8; x <= 12; x++) B.S(x, Bf + 3, 18, stairs('bricks', 'north', 'top'))
  B.carpet(3, 20, 11, 25, Bf, 'red')
  B.bench(8, 23, 8, 23, Bf, 'west', 'dark_oak_planks'); B.bench(12, 23, 12, 23, Bf, 'east', 'dark_oak_planks') // кресла у торцов стола; (12, 21) — дверь
  B.table(9, 23, 11, 23, Bf, 'dark_oak_planks'); B.candles(10, Bf + 1, 23, 3)
  B.chandelier(9, Cf - 2, 22, 1, true)
  // Опочивальня x 14..25: кровать с балдахином, сундуки, эндер-сундук.
  const bx = 19; const bz = 18
  B.bed(bx, Bf, bz + 1, 'north', 'red'); B.bed(bx + 1, Bf, bz + 1, 'north', 'red')
  for (const [px, pz] of [[bx - 1, bz], [bx + 2, bz], [bx - 1, bz + 2], [bx + 2, bz + 2]]) { B.S(px, Bf, pz, 'dark_oak_fence'); B.S(px, Bf + 1, pz, 'dark_oak_fence'); B.S(px, Bf + 2, pz, 'dark_oak_fence') }
  for (let x = bx - 1; x <= bx + 2; x++) for (let z = bz; z <= bz + 2; z++) B.S(x, Bf + 3, z, 'red_wool')
  B.chest2(17, Bf, 17, 'south'); B.chest2(15, Bf, 26, 'north'); B.S(24, Bf, 17, st('ender_chest', { facing: 'south', waterlogged: 'false' })) // x 15 — дверь в сокровищницу
  B.carpet(15, 21, 24, 25, Bf, 'purple')
  B.S(23, Bf, 17, 'crafting_table'); B.S(24, Bf, 23, st('lectern', { facing: 'west', has_book: 'false', powered: 'false' })) // (24, 25) — выход из башни
  B.chandelier(20, Cf - 2, 23, 1, true)
  // Двери в погреба (север, этаж B): склад, винный погреб, сокровищница.
  for (const [dx, mat] of [[-14, 'spruce_door'], [4, 'spruce_door'], [15, 'iron_door']]) {
    B.door(dx, Bf, zN, 'north', mat)
    for (let z = zN - 1; z >= 15; z--) for (let y = Bf; y <= Bf + 2; y++) B.S(dx, y, z, '')
    if (mat === 'iron_door') ironButtons(B, dx, Bf, zN)
  }

  // ---- Этаж C (30): совет/сокровищница-казна | большой зал.
  part(-13, Cf, PAL.top - 1, 21)
  // Совет x −29..−14: круглый стол, кресла, карты, флаги.
  B.table(-24, 20, -19, 23, Cf, 'dark_oak_planks')
  for (let x = -24; x <= -19; x++) { B.S(x, Cf, 19, stairs('dark_oak_planks', 'north')); B.S(x, Cf, 24, stairs('dark_oak_planks', 'south')) }
  B.S(-25, Cf, 21, stairs('dark_oak_planks', 'west')); B.S(-25, Cf, 22, stairs('dark_oak_planks', 'west'))
  B.S(-28, Cf, 17, 'cartography_table'); B.chest2(-17, Cf, 17, 'south')
  B.chandelier(-21, PAL.top - 1, 21, 3, true)
  for (const x of [-27, -23, -19, -15]) B.banner(x, Cf + 4, iz0, 'south', 'blue')
  // Большой зал x −12..25: помост с троном на востоке, длинные столы, камины, флаги.
  B.carpet(-11, 21, 20, 22, Cf, 'red')
  // Длинные столы вдоль стен; южный — с разрывом у двери винтовой лестницы (x −5).
  for (const zt of [18, 25]) {
    for (const [a, b] of zt === 25 ? [[-9, -7], [-3, 17]] : [[-9, 17]]) {
      B.table(a, zt, b, zt, Cf, 'dark_oak_planks')
      B.bench(a, zt + (zt === 18 ? 1 : -1), b, zt + (zt === 18 ? 1 : -1), Cf, zt === 18 ? 'south' : 'north', 'spruce_planks')
    }
    for (let x = -8; x <= 16; x += 4) if (x !== -4) B.candles(x, Cf + 1, zt, 3)
  }
  // Помост z 17..23; у южной стены (z 24..26) — проход к двери угловой башни.
  for (let x = 21; x <= 25; x++) for (let z = iz0; z <= 23; z++) B.S(x, Cf, z, x === 21 || z === 23 ? stairs('polished_andesite', x === 21 ? 'east' : 'north') : 'polished_andesite')
  B.table(23, 18, 23, 20, Cf + 1, 'dark_oak_planks')
  B.S(25, Cf + 1, 21, stairs('quartz_stairs', 'east')); B.S(25, Cf + 1, 22, stairs('quartz_stairs', 'east'))
  B.S(25, Cf + 2, 21, 'gold_block'); B.S(25, Cf + 2, 22, 'gold_block')
  for (const z of [18, 25]) B.banner(26 - 1, Cf + 4, z, 'west', 'red')
  // Камины у северной стены.
  for (const cx of [1, 10]) { // дверь на вершину — x −5 и 17, камины в стороне
    for (let x = cx - 2; x <= cx + 2; x++) { B.S(x, Cf, 17, 'bricks'); B.S(x, Cf + 4, 17, 'bricks'); B.S(x, Cf + 4, 18, stairs('bricks', 'north', 'top')) }
    for (let x = cx - 1; x <= cx + 1; x++) { B.S(x, Cf, 17, 'campfire[facing=south,lit=true,signal_fire=false,waterlogged=false]'); for (let y = Cf + 1; y <= Cf + 3; y++) B.S(x, y, 17, '') }
  }
  for (const x of [-10, 2, 8, 14, 20]) { B.banner(x, Cf + 5, iz1, 'north', 'red'); B.banner(x, Cf + 5, iz0, 'south', 'red') }
  for (const x of [-8, -1, 6, 13, 20]) B.chandelier(x, PAL.top - 1, 21, 3, true)
  // Сундуки стражи у входов.
  B.chest(-11, Cf, 17, 'south')
}

// ------------------------------------------------------ убранство погребов

function furnishCellars (ctx) {
  const { B } = ctx
  // Склад (x −25..−3, z 4..14, пол 23): ряды двойных сундуков по стенам и
  // стеллажи посередине, бочки, таблички по рядам.
  {
    const y = 23
    const rows = [['Зерно', 'и мука'], ['Инструменты', ''], ['Ткани', 'и шерсть'], ['Руда', 'и слитки'], ['Оружие', 'и стрелы'], ['Разное', '']]
    let k = 0
    for (let x = -24; x <= -5; x += 4) {
      // У северной стены — сундуки в два яруса лицом на юг.
      B.chest2(x, y, 4, 'south'); B.chest2(x, y + 1, 4, 'south')
      // У южной стены — лицом на север (кроме прохода к двери x −14).
      if (Math.abs(x - -14) > 1 && Math.abs(x + 1 - -14) > 1) { B.chest2(x + 1, y, 14, 'north'); B.chest2(x + 1, y + 1, 14, 'north') }
      const t = rows[k++ % rows.length]
      B.sign(x, y + 2, 5, 'south', ['', t[0], t[1], ''])
    }
    // Стеллажи посередине: бочки в два яруса с проходами.
    for (let x = -23; x <= -5; x++) {
      if ((x + 23) % 5 === 4) continue
      for (const z of [8, 10]) { B.barrel(x, y, z, z === 8 ? 'north' : 'south'); if ((x + z) % 2) B.barrel(x, y + 1, z, 'up') }
    }
    for (const x of [-22, -16, -10, -5]) B.lanternHang(x, 27, 9)
    B.lanternHang(-14, 27, 12); B.lanternHang(-20, 27, 6)
    B.S(-24, y, 12, 'crafting_table'); B.S(-24, y, 11, st('lectern', { facing: 'east', has_book: 'false', powered: 'false' }))
  }
  // Винный погреб (x −1..9, z 4..14): бочки на козлах вдоль стен, столик.
  {
    const y = 23
    for (let x = -1; x <= 9; x++) {
      B.barrel(x, y, 4, 'south'); B.barrel(x, y + 1, 4, 'south') // стеллаж в один ряд — до каждой бочки дотянуться
      if (Math.abs(x - 4) > 1) { B.barrel(x, y, 14, 'north'); B.barrel(x, y + 1, 14, 'north') }
    }
    B.table(1, 9, 3, 10, y, 'spruce_planks'); B.S(6, y, 10, st('brewing_stand', { has_bottle_0: 'true', has_bottle_1: 'false', has_bottle_2: 'true' }))
    B.S(7, y, 10, st('water_cauldron', { level: '3' }))
    B.candles(2, y + 1, 9, 3); B.lanternHang(4, 27, 8); B.lanternHang(4, 27, 12)
    B.sign(0, y + 2, 6, 'south', ['', 'Винный', 'погреб', ''])
  }
  // Сокровищница (x 11..19, z 7..14): за железной дверью — золото, сундуки.
  {
    const y = 23
    for (let x = 11; x <= 19; x++) { B.S(x, y, 7, 'gold_block'); if (x % 2) B.S(x, y + 1, 7, 'gold_block') }
    for (const x of [11, 19]) for (let z = 8; z <= 12; z++) { B.S(x, y, z, z % 2 ? 'emerald_block' : 'lapis_block') }
    B.chest2(13, y, 8, 'south'); B.chest2(16, y, 8, 'south')
    B.S(15, y, 11, st('ender_chest', { facing: 'south', waterlogged: 'false' }))
    B.carpet(12, 10, 18, 13, y, 'red')
    B.lanternHang(15, 26, 10)
    B.sign(14, y + 2, 8, 'south', ['', 'Казна', '', ''])
  }
  // Темница (x −25..−9, z 5..14, пол 16): камеры у северной стены за
  // решётками, коридор у южной; солома, цепи, факелы.
  {
    const y = 16
    for (let cx = -24; cx <= -12; cx += 4) {
      for (let z = 5; z <= 9; z++) for (const x of [cx - 1, cx + 3]) for (let yy = y; yy <= 20; yy++) if (x >= -25 && x <= -9) B.S(x, yy, z, 'stone_bricks')
      for (let x = cx; x <= cx + 2; x++) for (let yy = y; yy <= 20; yy++) B.S(x, yy, 10, yy === 20 ? 'stone_bricks' : 'iron_bars')
      B.door(cx + 1, y, 10, 'south', 'iron_door')
      B.S(cx + 1, y, 11, st('stone_button', { face: 'floor', facing: 'south', powered: 'false' })) // открыть — только из коридора
      B.S(cx, y, 5, 'hay_block'); B.S(cx + 2, y, 6, st('iron_chain', { axis: 'y', waterlogged: 'false' })); B.S(cx + 2, y + 1, 6, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
      B.S(cx + 1, y + 3, 5, st('wall_torch', { facing: 'south' }))
    }
    for (let x = -22; x <= -10; x += 4) B.S(x, y + 3, 14, st('wall_torch', { facing: 'north' }))
    B.S(-24, y, 13, 'barrel'); B.S(-23, y, 14, 'crafting_table')
  }
  // Цистерна (x −6..10, z 3..14, пол 16): бассейн с водой, обход по краю.
  {
    for (let x = -4; x <= 8; x++) {
      for (let z = 5; z <= 12; z++) {
        const pillar = (x === -2 || x === 3) && (z === 7 || z === 12)
        if (pillar) continue
        B.S(x, 15, z, 'water'); B.S(x, 14, z, 'water'); B.S(x, 13, z, 'stone_bricks')
      }
    }
    for (let x = -5; x <= 9; x++) for (const z of [4, 13]) B.S(x, 16, z, slab('stone_bricks'))
    for (let z = 4; z <= 13; z++) for (const x of [-5, 9]) B.S(x, 16, z, slab('stone_bricks'))
    B.lanternHang(1, 21, 8); B.lanternHang(6, 21, 8); B.lanternHang(-3, 21, 10)
    B.S(1, 16, 14, 'cauldron')
  }
}

// ---------------------------------------------------------- растительность

function vegetation (ctx, { H, Z, idx }) {
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

module.exports = { DEFAULTS, LV, ZC, DISK, model, commands, entityCommands, footprint, roundTower, PAL, CAT }
