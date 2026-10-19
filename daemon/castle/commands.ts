'use strict'
// Команды постройки замка: малярный порядок, /fill и /setblock, стойки с бронёй, габарит.

import * as C from '../arena/colosseum'

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
function commands (m, { X, Y, Z }: any) {
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
function entityCommands (m, { X, Y, Z }: any) {
  const yaw = { north: 180, south: 0, east: -90, west: 90 }
  const out = [`/kill @e[type=armor_stand,tag=castle_stand,x=${X - 80},y=${Y - 30},z=${Z - 80},dx=160,dy=160,dz=160]`]
  for (const [x, y, z, f] of m.armorStands) {
    out.push(`/summon armor_stand ${X + x + 0.5} ${Y + y} ${Z + z + 0.5} {Tags:["castle_stand"],ShowArms:1b,Rotation:[${yaw[f]}f,0f],equipment:{head:{id:"iron_helmet"},chest:{id:"iron_chestplate"},legs:{id:"iron_leggings"},feet:{id:"iron_boots"},mainhand:{id:"iron_sword"}}}`)
  }
  return out
}
// Габарит в мире.
function footprint (m, { X, Y, Z }: any) {
  const { g } = m
  return { x0: X + g.x0, x1: X + g.x1, y0: Y + g.y0, y1: Y + g.y1, z0: Z + g.z0, z1: Z + g.z1 }
}

export { TAIL, FALLING, castleOrder, commands, entityCommands, footprint }
