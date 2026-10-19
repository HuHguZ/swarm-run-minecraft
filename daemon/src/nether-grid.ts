'use strict'
// Сетка Ада «из копии этого же мира» (поток nether, 03.10): класс каждой клетки в коридорах портал → бастион →
// крепость → выход у крепости Края. Снимает сцена (try-lab-ne-map.js netherGrid: регионы копии мира), читает тело
// (nether-route.js: план хода по Аду без обрывов и лавы, штрек там, где открыто). Знание карты из копии мира —
// AGENTS.md (лава по скану копии — главная метрика); вслепую сетки нет, и маршрут падает на прежний штрек.
//
// Файл: <memoryDir>/nether-grid.bin (1 байт на клетку, x быстрее всех, потом z, потом y) + nether-grid.json
// { x0, y0, z0, sx, sy, sz, at, cols }. Клетки вне коробки — UNKNOWN.
import * as fs from 'fs'
import path = require('path')

const C = {
  AIR: 0, // воздух
  PASS: 1, // проходимое не-воздух: корни, ростки, лозы, факелы
  SOFT: 2, // незерак, нилий, светокамень — быстро
  STONE: 3, // чернокамень, базальт, кирпич, кварц, почва душ — каменной киркой ~0.75 с
  SLOW: 4, // стебли, бородавочные блоки, грибосвет, доски — без своего инструмента долго
  SOULSAND: 5, // песок душ: пол (вязнет), копать ~1 с
  FALL: 6, // гравий, песок — сыплется
  MAGMA: 7, // магма: стена — да, пол — нет (жжёт без огнестойкости)
  PARTIAL: 8, // забор, плита, ступени, цепь, решётка — копать можно, стоять на ступенях/плитах можно
  LAVA: 9,
  HOT: 10, // огонь, костёр
  HARD: 11, // коренная порода, обсидиан, спавнер, обломки — не копать
  GUARD: 12, // золото, сундуки, позолоченный чернокамень — злят пиглинов; в маршруте не копать
  UNKNOWN: 13,
  BLOCK: 14 // своя пометка «туда не шагнуть» (тело не прошло): не пол, не копать, не проход
}
const NAMES = Object.keys(C)

const RE = {
  AIR: /^(air|cave_air|void_air)$/,
  PASS: /^(crimson_roots|warped_roots|nether_sprouts|crimson_fungus|warped_fungus|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|nether_wart|torch|wall_torch|soul_torch|soul_wall_torch|redstone_wire|[a-z_]*button|[a-z_]*pressure_plate|lever|[a-z_]*carpet|light|structure_void|[a-z_]*sign|[a-z_]*banner|tripwire|tripwire_hook|dead_bush|fire_coral|brown_mushroom|red_mushroom|cobweb)$/,
  LAVA: /^lava$/,
  HOT: /^(fire|soul_fire|campfire|soul_campfire)$/,
  MAGMA: /^magma_block$/,
  FALL: /^(gravel|sand|red_sand|suspicious_gravel|suspicious_sand|[a-z_]*concrete_powder)$/,
  SOULSAND: /^soul_sand$/,
  HARD: /^(bedrock|obsidian|crying_obsidian|spawner|trial_spawner|ancient_debris|respawn_anchor|lodestone|barrier|end_portal_frame|reinforced_deepslate|netherite_block|enchanting_table|beacon|nether_portal|end_portal|end_gateway)$/,
  GUARD: /^(gold_block|raw_gold_block|gilded_blackstone|chest|trapped_chest|barrel|ender_chest|nether_gold_ore|gold_ore|deepslate_gold_ore|[a-z_]*shulker_box)$/,
  PARTIAL: /(fence|fence_gate|_slab|_stairs|_wall|^chain$|iron_bars|lantern|ladder|scaffolding|^bell$|anvil|_pane$|cauldron|hopper|lectern|_trapdoor|_door$|flower_pot|candle|skull|_head$|pointed_dripstone|^chain|_rod$|^grindstone$|^stonecutter$|^brewing_stand$|^composter$|^enchanting_table$)/,
  SLOW: /(_stem$|_hyphae$|^nether_wart_block$|^warped_wart_block$|^shroomlight$|_log$|_wood$|_planks$|^bookshelf$|^hay_block$|^target$|^crafting_table$|^note_block$|^jukebox$)/,
  SOFT: /^(netherrack|crimson_nylium|warped_nylium|glowstone)$/
}
const ORDER = ['AIR', 'LAVA', 'HOT', 'MAGMA', 'SOULSAND', 'FALL', 'HARD', 'GUARD', 'PASS', 'SOFT', 'SLOW', 'PARTIAL']
const cache = new Map()
function classOfName (name) {
  const n = String(name || '').replace(/^minecraft:/, '')
  let c = cache.get(n)
  if (c !== undefined) return c
  c = C.STONE
  for (const k of ORDER) if (RE[k].test(n)) { c = C[k]; break }
  cache.set(n, c)
  return c
}

// Секунды копки каменной киркой с задержкой 5 тиков между блоками (Infinity — не копать).
const DIG = new Float32Array(16).fill(Infinity)
// Замер 03.10 (neF-B1f22-1): 240 ходов и 378 копок незерака за 157 с — ~0.22 с на копку, ~0.3 с на шаг.
DIG[C.AIR] = 0; DIG[C.PASS] = 0.05; DIG[C.SOFT] = 0.3; DIG[C.STONE] = 0.6; DIG[C.SLOW] = 3.0; DIG[C.SOULSAND] = 0.8
DIG[C.FALL] = 0.95; DIG[C.MAGMA] = 0.5; DIG[C.PARTIAL] = 0.8
const passable = c => c === C.AIR || c === C.PASS
const floorOk = c => c === C.SOFT || c === C.STONE || c === C.SLOW || c === C.SOULSAND || c === C.FALL || c === C.PARTIAL || c === C.HARD || c === C.GUARD

class Grid {
  declare data: any
  declare x0: any
  declare y0: any
  declare z0: any
  declare sx: any
  declare sy: any
  declare sz: any
  declare lavaMemo: any

  constructor (h, data?) {
    Object.assign(this, { x0: h.x0, y0: h.y0, z0: h.z0, sx: h.sx, sy: h.sy, sz: h.sz })
    this.data = data || new Uint8Array(h.sx * h.sy * h.sz).fill(C.UNKNOWN)
  }
  inside (x, y, z) { return x >= this.x0 && y >= this.y0 && z >= this.z0 && x < this.x0 + this.sx && y < this.y0 + this.sy && z < this.z0 + this.sz }
  idx (x, y, z) { return ((y - this.y0) * this.sz + (z - this.z0)) * this.sx + (x - this.x0) }
  get (x, y, z) {
    if (y < 0 || y > 127) return C.HARD
    return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : C.UNKNOWN
  }
  setRaw (x, y, z, c) { if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = c }
  // Живая поправка тела (своя копка, лава, которой не было в копии) — прямо в сетку; память «лава рядом» вокруг — сброс.
  mark (x, y, z, c) {
    if (!this.inside(x, y, z)) return
    this.data[this.idx(x, y, z)] = c
    if (this.lavaMemo) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (this.inside(x + dx, y + dy, z + dz)) this.lavaMemo[this.idx(x + dx, y + dy, z + dz)] = 0
  }
}

function headerOf (box) {
  const [x1, y1, z1, x2, y2, z2] = box
  return { x0: x1, y0: y1, z0: z1, sx: x2 - x1 + 1, sy: y2 - y1 + 1, sz: z2 - z1 + 1 }
}

function save (dir, grid, extra: any = {}) {
  const h = { x0: grid.x0, y0: grid.y0, z0: grid.z0, sx: grid.sx, sy: grid.sy, sz: grid.sz, at: new Date().toISOString(), ...extra }
  fs.writeFileSync(path.join(dir, 'nether-grid.bin'), Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength))
  fs.writeFileSync(path.join(dir, 'nether-grid.json'), JSON.stringify(h))
  return h
}

function load (dir) {
  try {
    const h = JSON.parse(fs.readFileSync(path.join(dir, 'nether-grid.json'), 'utf8'))
    const b = fs.readFileSync(path.join(dir, 'nether-grid.bin'))
    if (b.length !== h.sx * h.sy * h.sz) return null
    const g: any = new Grid(h, new Uint8Array(b.buffer, b.byteOffset, b.length))
    g.meta = h
    return g
  } catch { return null }
}

// Секция чанка 1.18+ (block_states: palette + упакованные long — пары [hi, lo] после prismarine-nbt simplify) →
// fill(x, y, z, класс) для 16×16×16 клеток. Без data — вся секция одного блока palette[0].
function decodeSection (sec, fill) {
  const bs = sec && sec.block_states
  if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) return
  const pal = bs.palette.map(p => classOfName(p.Name))
  if (pal.length === 1 || !bs.data) { const c = pal[0]; for (let i = 0; i < 4096; i++) fill(i & 15, i >> 8, (i >> 4) & 15, c); return }
  const bits = Math.max(4, Math.ceil(Math.log2(pal.length)))
  const per = Math.floor(64 / bits)
  const mask = (1 << bits) - 1
  const d = bs.data
  for (let i = 0; i < 4096; i++) {
    const li = Math.floor(i / per)
    const off = (i % per) * bits
    const pair = d[li]
    if (!pair) continue
    const hi = pair[0] >>> 0; const lo = pair[1] >>> 0
    let v
    if (off + bits <= 32) v = (lo >>> off) & mask
    else if (off >= 32) v = (hi >>> (off - 32)) & mask
    else v = ((lo >>> off) | (hi << (32 - off))) & mask
    fill(i & 15, i >> 8, (i >> 4) & 15, pal[v] ?? C.STONE)
  }
}

export { C, NAMES, Grid, classOfName, DIG, passable, floorOk, headerOf, save, load, decodeSection }
