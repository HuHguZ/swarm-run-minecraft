'use strict'
// Колизей вокруг арены (просьба 2026-09-26: «арену красивую в стиле Рима, как
// Колизей; освещение, чтобы мобы не спавнились; можно открытой»).
//
// Чистая функция: (центр, R, параметры) → воксельная модель (блок + состояния)
// → список команд (/fill жадными параллелепипедами одного блока, /setblock
// одиночным). Модель в координатах относительно центра арены: dx, dz — от
// центрального блока поля (геометрический центр эллипсов — центр этого
// блока), dy — от уровня, на котором стоят (пол поля на dy = −1).
//
// Устройство (по сечению от поля наружу; n — расстояние по нормали от эллипса
// арены, «кольцо k» = клетки с floor(n) = k — полоса постоянной ширины):
//   поле R×R (обсидиан, его ведёт arena.js) → барьерная стена на R+1 (пол
//   щели — плачущий обсидиан) → бордюр кварца на R+2 → песок арены с линиями
//   света до подиума (эллипс A1×B1) → подиум 4 выс. с балюстрадой и фонарями,
//   терраса → maenianum I (4 ряда ступеней) → praecinctio → II (5 рядов) →
//   praecinctio → III (5 рядов) → портик с колоннадой наверху → внешняя стена:
//   три яруса аркад (тосканский, ионический, коринфский ордер полуколонн),
//   аттик с пилястрами, окнами, консолями, карнизом и мачтами веллария.
//   Под рядами — сплошная засыпка; за аркадами — кольцевые галереи трёх
//   ярусов; вомитории — проходы с поясов в галереи; на большой оси — ворота
//   с тоннелем с поля наружу; на малой — пульвинар (ложа, место зрителя) и
//   ложа напротив.
//
// Свет рассчитан так, чтобы мобы не спавнились нигде: сиденья — ступени (на
// них не спавнятся), верхние поверхности карнизов и стен — нижние плиты, а
// ровные полы (песок, терраса, пояса, галереи, портик, ложи, тоннели) —
// освещены; lightCheck ниже считает BFS блочного света по модели и ищет
// клетки, где моб может встать при блочном свете 0.
//
// Взрывы на поле (кристаллы, вагонетки с динамитом до силы 6): сдерживание
// поля — только барьер, от слоя пола (dy −1) до потолка сплошняком; снизу
// щель закрыта плачущим обсидианом (dy −2), весь фундамент постройки (dy −2)
// — обсидиан: лучи взрыва снизу (сквозь дыры) его не берут.

const WALL_TEST = { // WallBlock: *_TEST в 1/16 блока, проекция на xz
  north: [7, 0, 9, 9], south: [7, 7, 9, 16], west: [0, 7, 9, 9], east: [7, 7, 16, 9], post: [7, 7, 9, 9]
}

const DIR = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
const OPP = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' }
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const HOR = ['north', 'east', 'south', 'west']
const axisOf = d => (d === 'north' || d === 'south') ? 'z' : 'x'

// Сторона света по вектору (x — восток, z — юг): доминирующая ось. На ровно
// 45° — ось x (детерминированно и симметрично).
function dir4 (vx, vz) {
  if (Math.abs(vx) >= Math.abs(vz) - 1e-9) return vx >= 0 ? 'east' : 'west'
  return vz >= 0 ? 'south' : 'north'
}

// ---------------------------------------------------------------- параметры

const DEFAULTS = {
  R: 24, // полуширина поля (ARENA_R)
  bays: 80, // арок по кругу (кратно 4: оси — центры арок)
  bExtra: 11, // малая полуось арены = R + bExtra
  cornerGap: 4, // угол бордюра поля (R+2) отстоит от подиума внутрь эллипса
  ceilH: 16, // потолок-барьер над полем (dy), ARENA_CEIL_H
  masts: 2, // мачта веллария на каждой 2-й пилястре
  banner: 'red', // флаги на мачтах
  version: 1
}

function params (opts: any = {} as Record<string, any>) {
  const p: Record<string, any> = { ...DEFAULTS, ...opts }
  p.R = Math.round(p.R)
  p.B1 = p.R + p.bExtra
  const c = p.R + p.cornerGap
  p.A1 = Math.ceil(Math.sqrt(c * c / (1 - (c * c) / (p.B1 * p.B1))))
  // Кольца (floor(n) от внутренней грани подиума).
  p.K = {
    parapet: 0, terrace: [1, 3], m1: [4, 7], p1: [8, 9], m2: [10, 14], p2: [15, 16], m3: [17, 21],
    gallery: [22, 24], wall: [25, 26], relief: 27, step1: 28, step2: 29
  }
  p.F = 27 // внешняя грань стены (n)
  p.outA = p.A1 + 30
  p.outB = p.B1 + 30
  return p
}

// ------------------------------------------------------- геометрия эллипса

// Ближайшая точка эллипса (a·cos t, b·sin t) к (x, z): t, знаковое расстояние
// n (+ снаружи), нормаль и касательная. Первая четверть — Ньютон со страховкой
// бисекцией (g(0) ≤ 0 ≤ g(π/2) для любой точки четверти).
function foot (a, b, x, z) {
  const px = Math.abs(x); const pz = Math.abs(z)
  const g = t => px * a * Math.sin(t) - pz * b * Math.cos(t) + (b * b - a * a) * Math.sin(t) * Math.cos(t)
  let lo = 0; let hi = Math.PI / 2
  let t = Math.atan2(a * pz, b * px)
  for (let i = 0; i < 60; i++) {
    const s = Math.sin(t); const c = Math.cos(t)
    const gv = px * a * s - pz * b * c + (b * b - a * a) * s * c
    if (gv > 0) hi = t; else lo = t
    const dg = px * a * c + pz * b * s + (b * b - a * a) * (c * c - s * s)
    let nt = dg > 1e-12 ? t - gv / dg : (lo + hi) / 2
    if (!(nt > lo && nt < hi)) nt = (lo + hi) / 2
    if (Math.abs(nt - t) < 1e-13) { t = nt; break }
    t = nt
  }
  if (g(0) === 0 && pz === 0) t = 0
  const ex = a * Math.cos(t); const ez = b * Math.sin(t)
  let n = Math.hypot(px - ex, pz - ez)
  if ((px * px) / (a * a) + (pz * pz) / (b * b) < 1) n = -n
  // В полный круг.
  let T = t
  if (x < 0 && z >= 0) T = Math.PI - t
  else if (x < 0 && z < 0) T = Math.PI + t
  else if (x >= 0 && z < 0) T = 2 * Math.PI - t
  if (T >= 2 * Math.PI) T -= 2 * Math.PI
  const nx0 = b * Math.cos(T); const nz0 = a * Math.sin(T); const nl = Math.hypot(nx0, nz0)
  const tx0 = -a * Math.sin(T); const tz0 = b * Math.cos(T); const tl = Math.hypot(tx0, tz0)
  return { t: T, n, N: [nx0 / nl, nz0 / nl], T: [tx0 / tl, tz0 / tl] }
}

// Длина дуги кривой, параллельной эллипсу на расстоянии d: s_d(t) = s(t) + d·φ(t),
// φ — угол нормали (∫κ ds = поворот нормали). Таблица по t.
function arcTable (a, b, M = 20000) {
  const s = new Float64Array(M + 1); const phi = new Float64Array(M + 1)
  const sp = t => Math.hypot(a * Math.sin(t), b * Math.cos(t))
  const h = 2 * Math.PI / M
  let prev = 0
  for (let i = 0; i <= M; i++) {
    const t = i * h
    if (i > 0) s[i] = s[i - 1] + h * (sp(t - h) + 4 * sp(t - h / 2) + sp(t)) / 6
    let f = Math.atan2(a * Math.sin(t), b * Math.cos(t))
    while (f < prev - Math.PI) f += 2 * Math.PI
    phi[i] = f; prev = f
  }
  const at = (arr, t) => {
    let tt = t % (2 * Math.PI); if (tt < 0) tt += 2 * Math.PI
    const x = tt / h; const i = Math.min(M - 1, Math.floor(x)); const f = x - i
    return arr[i] * (1 - f) + arr[i + 1] * f
  }
  const P0 = s[M]
  return {
    P: d => P0 + 2 * Math.PI * d,
    // s_d(t) от t = 0 (восток)
    u: (t, d) => at(s, t) + d * at(phi, t),
    // t по длине дуги на расстоянии d (бинпоиск)
    tAt: (u, d) => {
      const P = P0 + 2 * Math.PI * d
      let uu = u % P; if (uu < 0) uu += P
      let lo = 0; let hi = 2 * Math.PI
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(s, m) + d * at(phi, m) < uu) lo = m; else hi = m }
      return (lo + hi) / 2
    }
  }
}

// ---------------------------------------------------------------- блоки

function st (name, props) {
  if (!props) return name
  const keys = Object.keys(props).sort()
  if (!keys.length) return name
  return `${name}[${keys.map(k => `${k}=${props[k]}`).join(',')}]`
}
const parseCache = new Map()
function parse (s) {
  let r = parseCache.get(s)
  if (r) return r
  const m = s.match(/^([a-z0-9_:]+)(?:\[(.*)\])?$/)
  const props: Record<string, any> = {} as Record<string, any>
  if (m && m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k] = v }
  r = { name: m ? m[1] : s, props }
  parseCache.set(s, r)
  return r
}
const isStairs = s => !!s && parse(s).name.endsWith('_stairs')
const isSlab = s => !!s && parse(s).name.endsWith('_slab')
const isWall = s => !!s && parse(s).name.endsWith('_wall') && !parse(s).name.endsWith('_banner')
const isFence = s => !!s && /_fence$/.test(parse(s).name)
const isBars = s => !!s && (parse(s).name === 'iron_bars' || /glass_pane$/.test(parse(s).name))
const stairs = (mat, facing, half = 'bottom') => st(mat, { facing, half, shape: 'straight' })
const slab = (mat, type = 'bottom') => st(mat, { type })

// Полные непрозрачные кубы палитры (для граней «прочно ли» и света).
const PARTIAL = /(_stairs|_slab|_wall|_fence|_fence_gate|lantern|_banner|carpet|iron_bars|glass_pane|iron_chain|^chain$|torch|end_rod|campfire|^light$)$/
// Неполные формы, которых нет в Колизее (двери, кровати, мебель, растения —
// для других построек, castle.js): форма не куб — грань не «прочная».
const PARTIAL2 = /(_door|_trapdoor|_bed|chest|_sign|^ladder|vine|candle|flower_pot|^potted_.*|_button|_pressure_plate|anvil|^lectern|^brewing_stand|cauldron|^grindstone|^bell|_head|_skull|lightning_rod|^decorated_pot|^composter|^enchanting_table|^stonecutter|^farmland|^dirt_path|^hopper|daylight_detector|^scaffolding|^cake|lily_pad|sea_pickle|^water|^lava|^air)$/
let emptyBox = null // имена с пустой коллизией (цветы, трава, посевы) — из minecraft-data, лениво
const isEmptyBox = name => {
  if (!emptyBox) {
    emptyBox = new Set()
    try { for (const b of (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11').blocksArray) if (b.boundingBox === 'empty') emptyBox.add(b.name) } catch {}
  }
  return emptyBox.has(name)
}
const isFullCube = s => { if (!s) return false; const { name } = parse(s); return !PARTIAL.test(name) && !PARTIAL2.test(name) && !isEmptyBox(name) }

// Октанты 2×2×2 ступени/плиты: бит (ix + 2·iz + 4·iy), ix=1 восток, iz=1 юг,
// iy=1 верх. Раскладка — как у моделей игры (outer_right у facing=east —
// восточно-южный октант; inner_* — половина по facing + половина сбоку).
function sideSet (dir) {
  const out = []
  for (let ix = 0; ix < 2; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      if ((dir === 'east' && ix === 1) || (dir === 'west' && ix === 0) || (dir === 'south' && iz === 1) || (dir === 'north' && iz === 0)) out.push([ix, iz])
    }
  }
  return out
}
function octMask (s) {
  const { name, props } = parse(s)
  if (name.endsWith('_slab')) {
    if (props.type === 'double') return 255
    return props.type === 'top' ? 0xF0 : 0x0F
  }
  if (!name.endsWith('_stairs')) return isFullCube(s) ? 255 : 0
  const F = props.facing; const sh = props.shape || 'straight'
  const full = props.half === 'top' ? 1 : 0
  let m = 0
  for (let ix = 0; ix < 2; ix++) for (let iz = 0; iz < 2; iz++) m |= 1 << (ix + 2 * iz + 4 * full)
  const key = new Set()
  const add = arr => arr.forEach(([ix, iz]: any) => key.add(ix + 2 * iz))
  const inter = (A, B) => A.filter(([x1, z1]: any) => B.some(([x2, z2]: any) => x1 === x2 && z1 === z2))
  if (sh === 'straight') add(sideSet(F))
  else if (sh === 'outer_left') add(inter(sideSet(F), sideSet(CCW[F])))
  else if (sh === 'outer_right') add(inter(sideSet(F), sideSet(CW[F])))
  else if (sh === 'inner_left') { add(sideSet(F)); add(sideSet(CCW[F])) }
  else if (sh === 'inner_right') { add(sideSet(F)); add(sideSet(CW[F])) }
  for (const k of (key as Iterable<any>)) m |= 1 << (k + 4 * (1 - full))
  return m
}
// Грань октантной маски в направлении dir → 4 бита (полная = 15).
function faceBits (mask, dir) {
  let f = 0; let i = 0
  for (let a = 0; a < 2; a++) {
    for (let b2 = 0; b2 < 2; b2++) {
      let ix, iy, iz
      if (dir === 'up' || dir === 'down') { iy = dir === 'up' ? 1 : 0; ix = a; iz = b2 } else if (dir === 'east' || dir === 'west') { ix = dir === 'east' ? 1 : 0; iy = a; iz = b2 } else { iz = dir === 'south' ? 1 : 0; ix = a; iy = b2 }
      if (mask & (1 << (ix + 2 * iz + 4 * iy))) f |= 1 << i
      i++
    }
  }
  return f
}
// «Прочная» грань (isFaceSturdy FULL) — для соединений стен/заборов/решёток.
function sturdyFace (s, dir) {
  if (!s) return false
  const { name } = parse(s)
  if (name.endsWith('_stairs') || name.endsWith('_slab')) return faceBits(octMask(s), dir) === 15
  return isFullCube(s)
}
const isExceptionForConnection = s => !!s && /(_leaves|^barrier$|^carved_pumpkin$|^jack_o_lantern$|^melon$|^pumpkin$|shulker_box$)/.test(parse(s).name)

// ---------------------------------------------------------------- сетка

class Grid {
  declare x0: number
  declare x1: number
  declare y0: number
  declare y1: number
  declare z0: number
  declare z1: number
  declare sx: any
  declare sy: any
  declare sz: any
  declare data: any
  declare pal: any
  declare palIdx: any
  declare nbt: any

  constructor (x0, x1, y0, y1, z0, z1) {
    Object.assign(this, { x0, x1, y0, y1, z0, z1 })
    this.sx = x1 - x0 + 1; this.sy = y1 - y0 + 1; this.sz = z1 - z0 + 1
    this.data = new Uint16Array(this.sx * this.sy * this.sz)
    this.pal = ['']; this.palIdx = new Map([['', 0]])
    this.nbt = new Map() // i → NBT блока (флаги)
  }

  in (x, y, z) { return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1 && z >= this.z0 && z <= this.z1 }
  i (x, y, z) { return ((y - this.y0) * this.sz + (z - this.z0)) * this.sx + (x - this.x0) }
  get (x, y, z) { return this.in(x, y, z) ? this.pal[this.data[this.i(x, y, z)]] : '' }
  id (s) {
    let k = this.palIdx.get(s)
    if (k === undefined) { k = this.pal.length; this.pal.push(s); this.palIdx.set(s, k) }
    return k
  }

  set (x, y, z, s) { if (this.in(x, y, z)) this.data[this.i(x, y, z)] = this.id(s || '') }
}

// ---------------------------------------------------------------- модель

// Материалы. Травертин — песчаник (гладкий, резной, обычный), мрамор колонн и
// карнизов — кварц.
const MAT = {
  base: 'obsidian', // фундамент dy −2 внутри постройки: лучи взрыва снизу не берут
  sand: 'sand',
  kerb: 'smooth_quartz',
  groove: 'crying_obsidian',
  lineZ: 'crying_obsidian', // линии вдоль z (x = const) — свет 10, взрывом не выбить
  lineX: 'glowstone', // линии вдоль x (z = const)
  rim: 'glowstone', // обод у подножия подиума
  via: 'smooth_quartz', // триумфальная дорога
  fill: 'smooth_sandstone',
  podium: 'smooth_quartz',
  terrace: 'smooth_quartz',
  parapet: 'diorite_wall',
  seat: 'smooth_sandstone_stairs',
  aisle: 'quartz_stairs',
  walk: 'cut_sandstone',
  balteus: 'cut_sandstone',
  wall: 'smooth_sandstone',
  band: 'cut_sandstone',
  keystone: 'chiseled_quartz_block',
  haunch: 'smooth_quartz_stairs',
  archivolt: 'smooth_quartz',
  galleryFloor: 'smooth_sandstone',
  plinth: 'smooth_sandstone_slab',
  colBase: 'smooth_quartz',
  architrave: 'cut_sandstone',
  cornice: 'smooth_quartz_stairs',
  corniceSlab: 'smooth_quartz_slab',
  coping: 'smooth_sandstone_slab',
  stylobate: 'sandstone',
  stepStairs: 'sandstone_stairs',
  lamp: 'shroomlight',
  mast: 'spruce_fence'
}
// Ордера ярусов: [ствол, капитель] (тосканский — гладкий, ионический и
// коринфский — каннелюры quartz_pillar; коринфская капитель в два блока).
const ORDER = [
  { shaft: 'smooth_quartz', cap: ['quartz_block'] },
  { shaft: 'quartz_pillar[axis=y]', cap: ['chiseled_quartz_block'] },
  { shaft: 'quartz_pillar[axis=y]', cap: ['chiseled_quartz_block', 'chiseled_quartz_block'] }
]

function model (opts: any = {} as Record<string, any>) {
  const p = params(opts)
  const { R, A1, B1, K } = p
  const tab = arcTable(A1, B1)
  const Fd = p.F // длина дуги пролётов меряется по внешней грани стены
  const PF = tab.P(Fd)
  const L = PF / p.bays
  const u0 = tab.u(Math.PI / 2, Fd) // арка 0 — юг (малая ось, пульвинар)
  const uF = t => tab.u(t, Fd) - u0
  const tBay = b => tab.tAt(u0 + b * L, Fd) // центр пролёта b
  const tEdge = b => tab.tAt(u0 + (b + 0.5) * L, Fd) // граница b | b+1 (колонна)
  const bayT = []; const edgeT = []
  for (let b = 0; b < p.bays; b++) { bayT.push(tBay(b)); edgeT.push(tEdge(b)) }
  // Знаковая дуга от t1 к t2 по кривой на расстоянии d (кратчайшая).
  const arc = (t1, t2, d) => {
    const P = tab.P(d)
    let v = tab.u(t2, d) - tab.u(t1, d)
    v -= Math.round(v / P) * P
    return v
  }

  const X0 = -(p.outA + 3); const Z0 = -(p.outB + 3)
  const DY0 = -3; const DY1 = Math.max(42, p.ceilH + 2)
  const g: any = new Grid(X0, -X0, DY0, DY1, Z0, -Z0)

  // Колонки: геометрия на центр клетки.
  const cols = new Map() // key → { x, z, t, n, N, T, k, b, v }
  const key = (x, z) => x * 4096 + z
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const f = foot(A1, B1, x, z)
      if (f.n > p.F + 4) continue
      const k = Math.floor(f.n)
      const ub = uF(f.t)
      let b = Math.round(ub / L) % p.bays; if (b < 0) b += p.bays
      const d = Math.max(0, f.n)
      const v = arc(bayT[b], f.t, d)
      cols.set(key(x, z), { x, z, t: f.t, n: f.n, N: f.N, T: f.T, k, b, v })
    }
  }
  const ring = k => [...cols.values()].filter(c => c.k === k)
  // Клетки вдоль нормали эллипса в точке t от n0 до n1 (4-связная цепочка).
  const radial = (t, n0, n1) => {
    const ex = A1 * Math.cos(t); const ez = B1 * Math.sin(t)
    const nx0 = B1 * Math.cos(t); const nz0 = A1 * Math.sin(t); const nl = Math.hypot(nx0, nz0)
    const out = new Set(); let px = null; let pz = null
    for (let d = n0; d <= n1; d += 0.05) {
      const x = Math.round(ex + d * nx0 / nl); const z = Math.round(ez + d * nz0 / nl)
      if (px !== null && x !== px && z !== pz) out.add(key(x, pz))
      out.add(key(x, z)); px = x; pz = z
    }
    return out
  }
  // Ближайшая к радиальной линии t клетка кольца k (одна на цель — колонна,
  // фонарь, окно не пропадают на диагоналях).
  const nearestIn = (list, t, d) => {
    let best = null; let bd = Infinity
    for (const c of list) { const v = Math.abs(arc(t, c.t, d)); if (v < bd) { bd = v; best = c } }
    return best
  }
  const pick = (k, ts) => { const list = ring(k); return ts.map(t => nearestIn(list, t, k + 0.5)) }

  const S = (x, y, z, s) => g.set(x, y, z, s)
  const inField = (x, z) => Math.abs(x) <= R && Math.abs(z) <= R
  const cheb = (x, z) => Math.max(Math.abs(x), Math.abs(z))
  const onLine = v => ((Math.abs(v) % 8) + 8) % 8 === 4

  // Особые места: ворота (большая ось, пролёты bays/4 и 3·bays/4), ложи
  // (малая ось: юг — пульвинар, север — ложа напротив).
  const Q = p.bays / 4
  const gateBays = new Set([Q, 3 * Q])
  const isGate = c => Math.abs(c.z) <= 1 && Math.abs(c.x) > R + 2 && c.k <= K.m3[1]
  const boxHalf = 6 // ложи: |dx| ≤ 6
  const inBox = c => Math.abs(c.x) <= boxHalf && c.k >= -2 && c.k <= K.m1[1]

  const stats: Record<string, any> = { bays: p.bays, L: +L.toFixed(3) }

  // ---- 1. Поле, щель, бордюр, песок, линии, фундамент
  for (const c of cols.values()) {
    const { x, z } = c
    if (inField(x, z)) continue
    const ch = cheb(x, z)
    if (ch === R + 1) { S(x, -2, z, MAT.groove); continue } // над ним барьер (arena.js)
    if (c.n < 0) {
      S(x, -2, z, MAT.base)
      // Песок без разметки; у подножия подиума — светящийся обод.
      let top = MAT.sand
      if (ch === R + 2) top = MAT.kerb
      else if (c.k === -1) top = MAT.rim
      S(x, -1, z, top)
      // Карниз подиума к арене: перевёрнутая ступень ступенькой к стене.
      if (c.k === -1) S(x, 3, z, stairs(MAT.cornice, dir4(c.N[0], c.N[1]), 'top'))
    }
  }

  // Балюстрада без щелей (2026-09-26, пользователь: «заборчик кривоват, стыки
  // неидеальные»): на кривой кольцо подиума местами касается себя только
  // углом, а стенки (diorite_wall) соединяются лишь по сторонам — щель и зуб.
  // В такой угол — перемычка: соседняя по стороне клетка снаружи (больше n,
  // дальше от поля) становится подиумом.
  {
    const par = new Set([...cols.values()].filter(c => c.k === K.parapet && c.n >= 0).map(c => key(c.x, c.z)))
    const promote = new Set()
    for (const c of cols.values()) {
      if (c.k !== K.parapet || c.n < 0) continue
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!par.has(key(c.x + dx, c.z + dz))) continue
        if (par.has(key(c.x + dx, c.z)) || par.has(key(c.x, c.z + dz))) continue
        const cand = [cols.get(key(c.x + dx, c.z)), cols.get(key(c.x, c.z + dz))].filter(q => q && q.n >= 0).sort((q, r) => r.n - q.n)[0]
        if (cand) promote.add(cand)
      }
    }
    for (const c of (promote as Iterable<any>)) { c.k = K.parapet; par.add(key(c.x, c.z)) }
  }

  // ---- 2. Кавея: подиум, терраса, ряды, пояса, засыпка
  const colFill = (x, z, y0, y1, s) => { for (let y = y0; y <= y1; y++) S(x, y, z, s) }
  for (const c of cols.values()) {
    const { x, z, k } = c
    if (c.n < 0 || k > K.relief + 2) continue
    const out = dir4(c.N[0], c.N[1])
    const aisle = c.b % 4 === 0 && Math.abs(c.v) < 1.0
    if (k <= K.gallery[1]) S(x, -2, z, MAT.base)
    if (k === K.parapet) { colFill(x, z, -1, 3, MAT.podium); S(x, 4, z, MAT.parapet) } else if (k >= K.terrace[0] && k <= K.terrace[1]) { colFill(x, z, -1, 2, MAT.fill); S(x, 3, z, MAT.terrace) } else if (k >= K.m1[0] && k <= K.m1[1]) {
      const i = k - K.m1[0]
      colFill(x, z, -1, 3 + i, MAT.fill)
      S(x, 4 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    } else if (k >= K.p1[0] && k <= K.p1[1]) { colFill(x, z, -1, 6, MAT.fill); S(x, 7, z, MAT.walk) } else if (k >= K.m2[0] && k <= K.m2[1]) {
      const i = k - K.m2[0]
      colFill(x, z, -1, 10 + i, MAT.fill)
      if (i === 0) { colFill(x, z, 8, 10, MAT.balteus); if (aisle) S(x, 9, z, MAT.lamp) }
      S(x, 11 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    } else if (k >= K.p2[0] && k <= K.p2[1]) { colFill(x, z, -1, 14, MAT.fill); S(x, 15, z, MAT.walk) } else if (k >= K.m3[0] && k <= K.m3[1]) {
      const i = k - K.m3[0]
      colFill(x, z, -1, 18 + i, MAT.fill)
      if (i === 0) { colFill(x, z, 16, 18, MAT.balteus); if (aisle) S(x, 17, z, MAT.lamp) }
      S(x, 19 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    }
  }

  // ---- 3. Галереи, портик, стена фасада, рельеф, стилобат
  const reliefRing = ring(K.relief)
  const colT = edgeT // колонны на границах пролётов
  const colAt = new Map() // key → номер границы
  pick(K.relief, colT).forEach((c, i) => { if (c) colAt.set(key(c.x, c.z), i) })
  // Окна аттика: клетки вдоль радиального отрезка сквозь обе полосы стены,
  // 4-связно (на диагоналях стена в две клетки по нормали — «ближайшие»
  // клетки полос давали глухую нишу, где темно и может встать моб).
  const winAt = new Map()
  bayT.forEach((t, b) => { for (const kk of radial(t, K.wall[0] - 0.5, K.wall[1] + 1.5)) winAt.set(kk, b) })
  const porticoCol = new Set(pick(K.gallery[0], colT).filter(Boolean).map(c => key(c.x, c.z)))
  const porticoLamp = new Set(pick(K.gallery[0] + 1, bayT).filter(Boolean).map(c => key(c.x, c.z)))
  const archLamp = new Set(pick(K.wall[0], bayT).filter(Boolean).map(c => key(c.x, c.z)))
  // Центр арки в каждой из двух полос стены — ровно одна клетка на пролёт.
  const archCenter = new Set()
  for (const k of K.wall) pick(k, bayT).forEach(c => { if (c) archCenter.add(key(c.x, c.z)) })
  const attached = [] // висячие/стоящие на чём-то — в конце
  for (const c of cols.values()) {
    const { x, z, k } = c
    const inward = dir4(-c.N[0], -c.N[1])
    const kk = key(x, z)
    if (k >= K.gallery[0] && k <= K.gallery[1]) {
      S(x, -1, z, MAT.galleryFloor)
      for (let s = 0; s < 3; s++) {
        S(x, 8 * s + 6, z, MAT.wall) // потолок
        if (s < 2) S(x, 8 * s + 7, z, MAT.galleryFloor) // пол следующего яруса
      }
      S(x, 23, z, MAT.walk) // пол портика
      S(x, 29, z, MAT.wall) // кровля портика
      S(x, 30, z, slab(MAT.coping))
      if (k === K.gallery[0] && porticoCol.has(kk)) {
        colFill(x, z, 24, 27, 'quartz_pillar[axis=y]'); S(x, 28, z, 'chiseled_quartz_block')
      }
      if (k === K.gallery[0] + 1 && porticoLamp.has(kk)) attached.push([x, 28, z, st('lantern', { hanging: 'true', waterlogged: 'false' })])
    }
    if (k === K.m3[1]) { // свес кровли портика к арене
      S(x, 29, z, stairs(MAT.cornice, dir4(c.N[0], c.N[1]), 'top'))
      S(x, 30, z, slab(MAT.coping))
    }
    // Близко к 45° ступени по касательной/нормали ложатся углами «пилой» —
    // там пяты арок из полных блоков, карнизы из верхних плит.
    const diag = Math.min(Math.abs(c.N[0]), Math.abs(c.N[1])) / Math.max(Math.abs(c.N[0]), Math.abs(c.N[1])) > 0.5
    if (k >= K.wall[0] && k <= K.wall[1]) {
      S(x, -2, z, MAT.stylobate)
      S(x, -1, z, MAT.galleryFloor)
      for (let s = 0; s < 3; s++) {
        const y0 = 8 * s
        const open = Math.abs(c.v) < 1.5
        const center = archCenter.has(kk)
        // Ярус 8 рядов: r0–3 проём во всю ширину, r4 — пяты арки (перевёрнутые
        // ступени ступенькой к опоре, по касательной) и центр, r5 — замок и
        // белый обвод над проёмом, r6 — за антаблементом, r7 — пол галереи.
        for (let r = 0; r < 8; r++) {
          const y = y0 + r
          let b = MAT.wall
          if (r <= 3) b = open ? '' : MAT.wall
          else if (r === 4) b = center ? '' : open ? (diag ? MAT.archivolt : stairs(MAT.haunch, dir4(Math.sign(c.v) * c.T[0], Math.sign(c.v) * c.T[1]), 'top')) : MAT.wall
          else if (r === 5) b = k === K.wall[1] && open ? (center ? MAT.keystone : MAT.archivolt) : MAT.wall
          S(x, y, z, b)
        }
        if (center && k === K.wall[0] && archLamp.has(kk)) attached.push([x, y0 + 4, z, st('lantern', { hanging: 'true', waterlogged: 'false' })])
      }
      // Аттик: стена с окнами через пролёт, копинг.
      for (let y = 24; y <= 32; y++) S(x, y, z, MAT.wall)
      const wb = winAt.get(kk)
      if (wb !== undefined && wb % 2 === 0) { S(x, 27, z, ''); S(x, 28, z, '') }
      S(x, 33, z, slab(MAT.coping))
    }
    if (k === K.relief) {
      S(x, -2, z, MAT.stylobate); S(x, -1, z, MAT.stylobate)
      const ci = colAt.get(kk)
      for (let s = 0; s < 3; s++) {
        const y0 = 8 * s
        const ord = ORDER[s]
        // Полуколонна: база r0, ствол, капитель под антаблементом r6
        // (резной песчаник), карниз r7 — белые перевёрнутые ступени.
        S(x, y0, z, ci !== undefined ? MAT.colBase : (s === 0 ? '' : slab(MAT.plinth)))
        if (ci !== undefined) {
          const capH = ord.cap.length
          for (let r = 1; r <= 5 - capH; r++) S(x, y0 + r, z, ord.shaft)
          ord.cap.forEach((cb, j) => S(x, y0 + 6 - capH + j, z, cb))
        }
        S(x, y0 + 6, z, MAT.architrave)
        S(x, y0 + 7, z, diag ? slab(MAT.corniceSlab, 'top') : stairs(MAT.cornice, inward, 'top'))
      }
      // Аттик: пилястры, консоли, венчающий карниз, копинг, мачты.
      S(x, 24, z, ci !== undefined ? MAT.colBase : slab(MAT.plinth))
      if (ci !== undefined) {
        for (let y = 25; y <= 29; y++) S(x, y, z, 'smooth_quartz')
        S(x, 30, z, 'chiseled_quartz_block')
        S(x, 31, z, stairs(MAT.cornice, inward, 'top'))
      }
      S(x, 32, z, stairs(MAT.cornice, inward, 'top'))
      const mast = ci !== undefined && ci % p.masts === 0
      if (mast) {
        for (let y = 33; y <= 38; y++) S(x, y, z, MAT.mast)
        const rot = Math.round(((Math.atan2(-c.N[0], c.N[1]) * 180 / Math.PI) + 360) / 22.5) % 16
        attached.push([x, 39, z, st(`${p.banner}_banner`, { rotation: rot }), '{patterns:[{color:"yellow",pattern:"minecraft:border"},{color:"yellow",pattern:"minecraft:stripe_middle"}]}'])
      } else S(x, 33, z, slab(MAT.coping))
    }
    if (k === K.step1) { S(x, -2, z, MAT.stylobate); S(x, -1, z, stairs(MAT.stepStairs, inward)) }
    if (k === K.step2) S(x, -2, z, stairs(MAT.stepStairs, inward))
  }

  // ---- 4. Балюстрада: фонари на столбиках через пролёт.
  const parLamp = pick(K.parapet, colT.filter((_, i) => i % 2 === 1))
  for (const c of parLamp) if (c) attached.push([c.x, 5, c.z, st('lantern', { hanging: 'false', waterlogged: 'false' })])

  // ---- 5. Вомитории (пролёты ≡ 2 mod 4): с поясов в галереи; свет в потолке.
  for (const c of cols.values()) {
    const { x, z, k } = c
    if (c.b % 4 !== 2 || Math.abs(c.v) >= 1.0) continue
    if (k >= K.m2[0] && k <= K.m3[1]) { S(x, 8, z, ''); S(x, 9, z, ''); S(x, 10, z, k === K.m2[0] + 1 || k === K.m3[0] ? MAT.lamp : (k === K.m2[0] ? MAT.keystone : g.get(x, 10, z))) }
    if (k >= K.m3[0] && k <= K.m3[1]) { S(x, 16, z, ''); S(x, 17, z, ''); S(x, 18, z, k === K.m3[0] + 1 ? MAT.lamp : (k === K.m3[0] ? MAT.keystone : g.get(x, 18, z))) }
  }

  // ---- 6. Ворота на большой оси: тоннель с поля к галерее первого яруса.
  for (const c of cols.values()) {
    if (!isGate(c)) continue
    const { x, z, k } = c
    if (c.n < -1) continue
    for (let y = 0; y <= 2; y++) S(x, y, z, '')
    if (k >= 0) S(x, -1, z, MAT.walk)
    if (k >= 0) S(x, 3, z, (z === 0 && k % 5 === 2) ? MAT.lamp : (k === 0 ? 'chiseled_quartz_block' : g.get(x, 3, z)))
  }
  // Триумфальная дорога: мощение по большой оси от бордюра к воротам и
  // фонари на столбиках по сторонам — свет в середину песка у торцов.
  for (const sx of [1, -1]) {
    for (let ax = R + 3; ax <= A1 + 1; ax++) {
      const x = sx * ax
      for (let z = -1; z <= 1; z++) { const c = cols.get(key(x, z)); if (c && c.n < 0) S(x, -1, z, MAT.via) }
      if ((ax - (R + 3)) % 5 === 2 && ax < A1 - 2) {
        for (const z of [-3, 3]) { S(x, 0, z, 'quartz_pillar[axis=y]'); S(x, 1, z, 'chiseled_quartz_block'); attached.push([x, 2, z, st('lantern', { hanging: 'false', waterlogged: 'false' })]) }
      }
    }
  }
  for (const c of cols.values()) { // обрамление ворот на подиуме
    if (c.k !== K.parapet || Math.abs(c.z) !== 2 || Math.abs(c.x) < R) continue
    for (let y = 0; y <= 3; y++) S(c.x, y, c.z, 'quartz_pillar[axis=y]')
  }

  // ---- 7. Ложи на малой оси: юг — пульвинар (место зрителя), север — напротив.
  const boxes = []
  for (const sgn of [1, -1]) {
    const f = sgn > 0 ? 'south' : 'north'; const bk = OPP[f]
    const Z = xz => xz * sgn
    // Край эллипса у оси ~ B1; ложа: кольца −2..7 при |dx| ≤ 6.
    const zAt = k => Z(Math.round(B1 + k))
    const kFront = -2; const kBack = K.m1[1]
    for (let x = -boxHalf; x <= boxHalf; x++) {
      for (let k = kFront; k <= kBack; k++) {
        const z = zAt(k)
        for (let y = 4; y <= 20; y++) S(x, y, z, '')
        S(x, -2, z, k < 0 ? MAT.base : MAT.base)
        if (k < 0) { S(x, -1, z, g.get(x, -1, z) || MAT.sand); S(x, 3, z, stairs(MAT.cornice, f, 'top')) } else colFill(x, z, -1, 3, MAT.fill)
        S(x, 4, z, MAT.terrace) // пол ложи: поверхность dy 5
        const edge = Math.abs(x) === boxHalf
        if (edge && k >= 0) colFill(x, z, 5, 8, MAT.podium) // бока у рядов
        if (k === kBack) colFill(x, z, 5, 8, MAT.podium) // задняя стена
        S(x, 9, z, 'smooth_quartz')
        // Двускатная кровля 1:2 полублоками, конёк по оси ложи.
        const h2 = boxHalf - Math.abs(x)
        for (let j = 0; j < (h2 >> 1); j++) S(x, 10 + j, z, 'smooth_quartz')
        if (h2 & 1) S(x, 10 + (h2 >> 1), z, slab('smooth_quartz_slab'))
      }
      // Фронт: балюстрада, колонны с золотыми капителями (у пульвинара).
      const z = zAt(kFront)
      const col = [-6, -2, 2, 6].includes(x)
      if (col) { colFill(x, z, 5, 7, 'quartz_pillar[axis=y]'); S(x, 8, z, sgn > 0 ? 'gold_block' : 'chiseled_quartz_block') } else S(x, 5, z, MAT.parapet)
    }
    // Красная дорожка и трон.
    for (let x = -2; x <= 2; x++) for (let k = -1; k <= kBack - 1; k++) S(x, 5, zAt(k), 'red_carpet')
    S(0, 5, zAt(kBack - 1), stairs('quartz_stairs', bk === 'south' ? 'south' : 'north'))
    for (const x of [-1, 1]) S(x, 5, zAt(kBack - 1), sgn > 0 ? 'gold_block' : 'smooth_quartz')
    for (const x of [-3, 3]) attached.push([x, 8, zAt(2), st('lantern', { hanging: 'true', waterlogged: 'false' })])
    // Акротерии: фонари на коньке и углах фронтона.
    attached.push([0, 13, zAt(kFront), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    attached.push([0, 13, zAt(kBack), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    for (const x of [-6, 6]) attached.push([x, 11, zAt(kFront), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    boxes.push({ side: f, spot: { dx: 0, dy: 5, dz: zAt(-1) }, yaw: sgn > 0 ? 180 : 0 })
  }

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

// ------------------------------------------------ формы по правилам игры

// Ступени (StairBlock.getStairsShape), стены (WallBlock), заборы (FenceBlock),
// решётки/панели — как посчитает сервер после установки всего, чтобы модель
// совпала с миром.
function finishShapes (g) {
  const at = (x, y, z) => g.get(x, y, z)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = g.y0; y <= g.y1; y++) {
      for (let z = g.z0; z <= g.z1; z++) {
        for (let x = g.x0; x <= g.x1; x++) {
          const s = g.pal[g.data[g.i(x, y, z)]]
          if (!s) continue
          if (isStairs(s)) {
            const { name, props } = parse(s)
            const F = props.facing; const H = props.half
            const [fx, fz] = DIR[F]
            let shape = 'straight'
            const front = at(x + fx, y, z + fz)
            const canTake = face => { const [ax, az] = DIR[face]; const n = at(x + ax, y, z + az); return !isStairs(n) || parse(n).props.facing !== F || parse(n).props.half !== H }
            if (isStairs(front) && parse(front).props.half === H) {
              const F2 = parse(front).props.facing
              if (axisOf(F2) !== axisOf(F) && canTake(OPP[F2])) shape = F2 === CCW[F] ? 'outer_left' : 'outer_right'
            }
            if (shape === 'straight') {
              const back = at(x - fx, y, z - fz)
              if (isStairs(back) && parse(back).props.half === H) {
                const F3 = parse(back).props.facing
                if (axisOf(F3) !== axisOf(F) && canTake(F3)) shape = F3 === CCW[F] ? 'inner_left' : 'inner_right'
              }
            }
            if (shape !== props.shape) g.set(x, y, z, st(name, { ...props, shape }))
          } else if (isWall(s) || isFence(s) || isBars(s)) {
            const { name, props } = parse(s)
            const np: Record<string, any> = { ...props }
            const con: Record<string, any> = {} as Record<string, any>
            for (const d of HOR) {
              const [dx, dz] = DIR[d]
              const nb = at(x + dx, y, z + dz)
              const solid = sturdyFace(nb, OPP[d]) && !isExceptionForConnection(nb)
              if (isWall(s)) con[d] = isWall(nb) || solid || isBars(nb)
              else if (isFence(s)) con[d] = solid || (isFence(nb) && /(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_fence$/.test(parse(nb).name))
              else con[d] = solid || isBars(nb) || isWall(nb)
            }
            if (isWall(s)) {
              const above = at(x, y + 1, z)
              const cover = test => coversDown(above, test)
              for (const d of HOR) np[d] = con[d] ? (cover(WALL_TEST[d]) ? 'tall' : 'low') : 'none'
              np.up = String(raisePost(np, above))
            } else for (const d of HOR) np[d] = String(con[d])
            np.waterlogged = 'false'
            const ns = st(name, np)
            if (ns !== s) g.set(x, y, z, ns)
          }
        }
      }
    }
  }
}
// Нижняя грань блока сверху (коллизия) покрывает ли тест [x0,z0,x1,z1]/16.
function coversDown (above, test) {
  if (!above) return false
  if (isFullCube(above)) return true
  const { name, props } = parse(above)
  if (name.endsWith('_slab')) return props.type !== 'top'
  if (name.endsWith('_stairs')) {
    const m = octMask(above); const f = faceBits(m, 'down') // биты: (ix, iz) → a=ix, b=iz
    const [x0, z0, x1, z1] = test
    for (let ix = 0; ix < 2; ix++) {
      for (let iz = 0; iz < 2; iz++) {
        const ox0 = ix * 8; const ox1 = ox0 + 8; const oz0 = iz * 8; const oz1 = oz0 + 8
        const touches = x0 < ox1 && x1 > ox0 && z0 < oz1 && z1 > oz0
        if (touches && !(f & (1 << (ix * 2 + iz)))) return false
      }
    }
    return true
  }
  if (name === 'lantern') { // [5..11]×[5..11], стоячий касается низа
    if (props.hanging === 'true') return false
    const [x0, z0, x1, z1] = test
    return x0 >= 5 && x1 <= 11 && z0 >= 5 && z1 <= 11
  }
  return false
}
function raisePost (np, above) {
  if (isWall(above) && parse(above).props.up === 'true') return true
  const n = np.north === 'none'; const s = np.south === 'none'; const e = np.east === 'none'; const w = np.west === 'none'
  if ((n && s && e && w) || n !== s || e !== w) return true
  if ((np.north === 'tall' && np.south === 'tall') || (np.east === 'tall' && np.west === 'tall')) return false
  if (above && /(_banner|torch|_sign|pressure_plate)$/.test(parse(above).name)) return true
  return coversDown(above, WALL_TEST.post)
}

// ---------------------------------------------------------------- команды

// Жадные параллелепипеды одного состояния (x → z → y), не больше 32768.
function greedy (g, want, order = 'xzy') {
  const done = new Uint8Array(g.data.length)
  const boxes = []
  const { x0, x1, y0, y1, z0, z1 } = g
  const same = (i, v) => g.data[i] === v && !done[i]
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = g.i(x, y, z)
        const v = g.data[i]
        if (!v || done[i] || !want(v, i)) continue
        let xa = x; let za = z
        if (order === 'xzy') {
          while (xa < x1 && same(g.i(xa + 1, y, z), v)) xa++
          grow: while (za < z1) { for (let xx = x; xx <= xa; xx++) if (!same(g.i(xx, y, za + 1), v)) break grow; za++ }
        } else {
          while (za < z1 && same(g.i(x, y, za + 1), v)) za++
          grow2: while (xa < x1) { for (let zz = z; zz <= za; zz++) if (!same(g.i(xa + 1, y, zz), v)) break grow2; xa++ }
        }
        let ya = y
        const area = (xa - x + 1) * (za - z + 1)
        growY: while (ya < y1 && area * (ya - y + 2) <= 32768) {
          for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) if (!same(g.i(xx, ya + 1, zz), v)) break growY
          ya++
        }
        for (let yy = y; yy <= ya; yy++) for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) done[g.i(xx, yy, zz)] = 1
        boxes.push({ x, y, z, x2: xa, y2: ya, z2: za, v })
      }
    }
  }
  return boxes
}

// «Малярный» порядок: материалы ставятся слоями, и параллелепипед раннего
// материала может захватывать клетки, которые потом перекроет более поздний
// (но не воздух и не уже поставленное). Засыпка кавеи и стены — крупными
// блоками сквозь пояса, ступени и карнизы; детали — поверх.
function painter (g, order) {
  const rank = new Int32Array(g.pal.length).fill(-1)
  order.forEach((v, r) => { rank[v] = r })
  const covered = new Uint8Array(g.data.length)
  const boxes = []
  const { x0, x1, y0, y1, z0, z1 } = g
  for (let r = 0; r < order.length; r++) {
    const v = order[r]
    const ok = i => { const w = g.data[i]; return w === v || (w && rank[w] > r) }
    const run = (mode) => {
      const out = []
      const cov = new Uint8Array(0)
      const done = new Uint8Array(g.data.length)
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const i = g.i(x, y, z)
            if (g.data[i] !== v || done[i]) continue
            let xa = x; let za = z
            if (mode === 'xzy') {
              while (xa < x1 && ok(g.i(xa + 1, y, z))) xa++
              grow: while (za < z1) { for (let xx = x; xx <= xa; xx++) if (!ok(g.i(xx, y, za + 1))) break grow; za++ }
            } else {
              while (za < z1 && ok(g.i(x, y, za + 1))) za++
              grow2: while (xa < x1) { for (let zz = z; zz <= za; zz++) if (!ok(g.i(xa + 1, y, zz))) break grow2; xa++ }
            }
            // Обрезать края, где нет ни одной своей клетки (лишний захват не нужен).
            let ya = y
            const area = (xa - x + 1) * (za - z + 1)
            growY: while (ya < y1 && area * (ya - y + 2) <= 32768) {
              for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) if (!ok(g.i(xx, ya + 1, zz))) break growY
              ya++
            }
            for (let yy = y; yy <= ya; yy++) for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) { const j = g.i(xx, yy, zz); if (g.data[j] === v) done[j] = 1 }
            out.push({ x, y, z, x2: xa, y2: ya, z2: za, v })
          }
        }
      }
      void cov
      return out
    }
    const a = run('xzy'); const b = run('zxy')
    const best = a.length <= b.length ? a : b
    for (const bx of best) {
      for (let yy = bx.y; yy <= bx.y2; yy++) for (let zz = bx.z; zz <= bx.z2; zz++) for (let xx = bx.x; xx <= bx.x2; xx++) covered[g.i(xx, yy, zz)] = 1
      boxes.push(bx)
    }
  }
  return boxes
}

const ATTACHED = /(lantern|_banner|torch)$/
function toCmd (b, s, X, Y, Z, nbt?: any) {
  const full = 'minecraft:' + s + (nbt || '')
  if (b.x === b.x2 && b.y === b.y2 && b.z === b.z2) return `/setblock ${X + b.x} ${Y + b.y} ${Z + b.z} ${full}`
  return `/fill ${X + b.x} ${Y + b.y} ${Z + b.z} ${X + b.x2} ${Y + b.y2} ${Z + b.z2} ${full}`
}

// Порядок материалов: сперва основание (обсидиан), потом массы по убыванию
// числа клеток, песок — после основания под ним, навесное (фонари, флаги) —
// в самом конце, когда держатели уже стоят.
function materialOrder (g) {
  const count = new Map()
  for (let i = 0; i < g.data.length; i++) { const v = g.data[i]; if (v) count.set(v, (count.get(v) || 0) + 1) }
  const name = v => parse(g.pal[v]).name
  const tier = v => {
    const n = name(v)
    if (ATTACHED.test(n)) return 4
    if (n === 'sand') return 3
    if (n === 'obsidian' || n === 'crying_obsidian') return 0
    return 1
  }
  return [...count.keys()].sort((a, b) => tier(a) - tier(b) || count.get(b) - count.get(a))
}

// Для команд: форму ступеней и соединения стен/заборов/решёток игра считает
// сама при установке (/fill без strict: BlockInput.place → updateFromNeighbourShapes)
// и при каждой смене соседа — в команде они не важны, а разные формы рвали
// бы параллелепипеды. Модель (g) хранит итог — для проверки мира и рендера.
function placeGrid (g) {
  const q = new Grid(g.x0, g.x1, g.y0, g.y1, g.z0, g.z1)
  const map = new Uint16Array(g.pal.length)
  for (let v = 1; v < g.pal.length; v++) {
    const { name, props } = parse(g.pal[v])
    let ns = g.pal[v]
    if (name.endsWith('_stairs')) ns = st(name, { facing: props.facing, half: props.half })
    else if (isWall(g.pal[v]) || isFence(g.pal[v]) || isBars(g.pal[v])) ns = name
    map[v] = q.id(ns)
  }
  for (let i = 0; i < g.data.length; i++) q.data[i] = map[g.data[i]]
  q.nbt = g.nbt
  return q
}

function commands (m, { X, Y, Z }: any) {
  const g: any = placeGrid(m.g)
  const order = materialOrder(g)
  const att = v => ATTACHED.test(parse(g.pal[v]).name)
  const main = painter(g, order.filter(v => !att(v)))
  const tail = []
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i]
    if (!v || !att(v)) continue
    const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
    tail.push({ x, y, z, x2: x, y2: y, z2: z, v, nbt: g.nbt.get(i) })
  }
  const out = [...main, ...tail].map(b => toCmd(b, g.pal[b.v], X, Y, Z, b.nbt))
  for (const c of out) if (c.length > 250) throw new Error('команда длиннее 250: ' + c)
  return out
}

// Разбор: воздух на всё, что ставит модель (сверху вниз — песок не сыплется).
function undoCommands (m, { X, Y, Z }: any) {
  const { g } = m
  const mask = new Grid(g.x0, g.x1, g.y0, g.y1, g.z0, g.z1)
  const one = mask.id('air')
  for (let i = 0; i < g.data.length; i++) if (g.data[i]) mask.data[i] = one
  const a = greedy(mask, () => true, 'xzy'); const b = greedy(mask, () => true, 'zxy')
  return (a.length <= b.length ? a : b).sort((p, q) => q.y2 - p.y2).map(bx => toCmd(bx, 'air', X, Y, Z))
}

// Сдерживание поля (ведёт arena.js, ставит и сборщик): сплошной барьер от слоя
// пола (dy −1) до потолка по всему периметру R+1 и потолок; дно щели —
// плачущий обсидиан (есть и в модели). Всё — взрывостойкое.
function fieldCommands ({ X, Y, Z, R, ceilH, ceiling = true }: any) {
  const r = R + 1; const top = Y + ceilH - 1
  const out = []
  const fill = (x1, y1, z1, x2, y2, z2, b) => {
    const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
    const step = Math.max(1, Math.floor(32768 / area))
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += step) out.push(`/fill ${x1} ${y} ${z1} ${x2} ${Math.min(Math.max(y1, y2), y + step - 1)} ${z2} ${b}`)
  }
  fill(X - r, Y - 2, Z - r, X + r, Y - 2, Z - r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 2, Z + r, X + r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 2, Z - r, X - r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X + r, Y - 2, Z - r, X + r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 1, Z - r, X + r, top, Z - r, 'minecraft:barrier')
  fill(X - r, Y - 1, Z + r, X + r, top, Z + r, 'minecraft:barrier')
  fill(X - r, Y - 1, Z - r, X - r, top, Z + r, 'minecraft:barrier')
  fill(X + r, Y - 1, Z - r, X + r, top, Z + r, 'minecraft:barrier')
  if (ceiling) fill(X - r, Y + ceilH, Z - r, X + r, Y + ceilH, Z + r, 'minecraft:barrier')
  return out
}

// Свет поля в стиле «колизей»: линии вдоль x — светокамень (взрыв выбивает,
// дыр по ходу раунда больше), вдоль z — плачущий обсидиан (свет 10, не
// выбить: поле освещено, даже если светокамня не осталось). Пересечения —
// плачущий обсидиан (ставится вторым).
function fieldLightCommands ({ X, Y, Z, R }: any) {
  const out = []
  for (let d = -R + 4; d <= R - 4; d += 8) out.push(`/fill ${X - R} ${Y - 1} ${Z + d} ${X + R} ${Y - 1} ${Z + d} minecraft:glowstone`)
  for (let d = -R + 4; d <= R - 4; d += 8) out.push(`/fill ${X + d} ${Y - 1} ${Z - R} ${X + d} ${Y - 1} ${Z + R} minecraft:crying_obsidian`)
  return out
}

// Габарит постройки в мировых координатах (forceload, /kill мобов, отчёт).
function footprint (m, { X, Y, Z }: any) {
  const { g } = m
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity; let z0 = Infinity; let z1 = -Infinity
  for (let i = 0; i < g.data.length; i++) {
    if (!g.data[i]) continue
    const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  return { x0: X + x0, x1: X + x1, y0: Y + y0, y1: Y + y1, z0: Z + z0, z1: Z + z1 }
}

// Где ставить зрителя: пульвинар, лицом к полю.
function watchSpot (m, { X, Y, Z }: any) {
  const s = m.pulvinar.spot
  return { x: X + s.dx + 0.5, y: Y + s.dy, z: Z + s.dz + 0.5, yaw: m.pulvinar.yaw, pitch: 12 }
}

export {
  DEFAULTS, params, model, commands, undoCommands, fieldCommands, fieldLightCommands, footprint, watchSpot, foot, arcTable, parse, st, octMask, faceBits, isFullCube, MAT, Grid,
  // Воксельный инструментарий для других построек (castle.js).
  finishShapes, placeGrid, painter, materialOrder, greedy, toCmd, sturdyFace, isStairs, isSlab, isWall, isFence, isBars, stairs, slab, dir4, DIR, OPP, CW, CCW, HOR, ATTACHED
}
