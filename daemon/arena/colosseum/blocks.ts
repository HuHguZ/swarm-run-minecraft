'use strict'
// Колизей (часть colosseum.ts): стороны света; блоки — разбор состояний, ступени и плиты, полные кубы, октанты,
// «прочные» грани для соединений стен, заборов и решёток.

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

export {
  WALL_TEST, DIR, OPP, CCW, CW, HOR, axisOf, dir4, st, parse, isStairs, isSlab, isWall, isFence, isBars, stairs, slab,
  isFullCube, octMask, faceBits, sturdyFace, isExceptionForConnection
}
