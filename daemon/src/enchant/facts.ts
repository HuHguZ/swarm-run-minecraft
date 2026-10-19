'use strict'
// Зачарование: числа игры (уровни, полки, несовместимые), что и зачем зачаровывать, чтение предметов, сила полок.
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { countOf } from '../items'

// ------------------------------------------------------------ факты игры

// [max_level, anvil_cost, exclusive_set] — data/minecraft/enchantment/*.json.
export const ENCH = {
  protection: [4, 1, 'armor'], fire_protection: [4, 2, 'armor'], blast_protection: [4, 4, 'armor'],
  projectile_protection: [4, 2, 'armor'], feather_falling: [4, 2], respiration: [3, 4], aqua_affinity: [1, 4],
  thorns: [3, 8], depth_strider: [3, 4, 'boots'], frost_walker: [2, 4, 'boots'], soul_speed: [3, 8], swift_sneak: [3, 8],
  sharpness: [5, 1, 'damage'], smite: [5, 2, 'damage'], bane_of_arthropods: [5, 2, 'damage'], knockback: [2, 2],
  fire_aspect: [2, 4], looting: [3, 4], sweeping_edge: [3, 4], efficiency: [5, 1], silk_touch: [1, 8, 'mining'],
  fortune: [3, 4, 'mining'], unbreaking: [3, 2], mending: [1, 4], power: [5, 1], punch: [2, 4], flame: [1, 4],
  infinity: [1, 8, 'bow'], multishot: [1, 4, 'crossbow'], piercing: [4, 1, 'crossbow'], quick_charge: [3, 2],
  loyalty: [3, 2], channeling: [1, 8], riptide: [3, 4, 'riptide'], impaling: [5, 4, 'damage'],
  luck_of_the_sea: [3, 4], lure: [3, 4], binding_curse: [1, 8], vanishing_curse: [1, 8],
  density: [5, 2, 'damage'], breach: [4, 4, 'damage'], wind_burst: [3, 4], lunge: [3, 2]
}
// data/minecraft/tags/enchantment/exclusive_set/*.json
const EXCLUSIVE = {
  armor: ['protection', 'blast_protection', 'fire_protection', 'projectile_protection'],
  damage: ['sharpness', 'smite', 'bane_of_arthropods', 'impaling', 'density', 'breach'],
  mining: ['fortune', 'silk_touch'],
  boots: ['frost_walker', 'depth_strider'],
  bow: ['infinity', 'mending'],
  crossbow: ['multishot', 'piercing'],
  riptide: ['loyalty', 'channeling']
}
export function conflicts (a, b) {
  if (a === b) return false
  const sa = ENCH[a] && EXCLUSIVE[ENCH[a][2]]
  const sb = ENCH[b] && EXCLUSIVE[ENCH[b][2]]
  return !!((sa && sa.includes(b)) || (sb && sb.includes(a)))
}

// Player.getXpNeededForNextLevel: <15 → 7+2L; 15..29 → 37+5(L-15); ≥30 → 112+9(L-30).
export function xpForNext (l) { return l >= 30 ? 112 + (l - 30) * 9 : l >= 15 ? 37 + (l - 15) * 5 : 7 + 2 * l }
export function pointsBetween (from, to) { let s = 0; for (let l = from; l < to; l++) s += xpForNext(l); return s }

export const MAX_SHELVES = 15

// ------------------------------------------------------------ что и зачем

// Вес 0..10 за максимальный уровень и слово «зачем». Меньше 2 — мусор: на него
// уровни не тратим, если есть выбор (переброс книгой дешевле).
export const W = (w, why) => ({ w, why })
const ARMOR_COMMON = {
  protection: W(10, 'режет почти весь урон: мобы, падение, огонь, взрывы — лучшее на броню'),
  projectile_protection: W(5, 'стрелы скелетов и огненные шары — хуже общей защиты'),
  blast_protection: W(4, 'взрывы криперов и кровати в Энде; от остального не спасает'),
  fire_protection: W(4, 'огонь и лава в Аду; зелье огнестойкости надёжнее'),
  unbreaking: W(5, 'броня живёт дольше'),
  mending: W(7, 'чинится опытом — только наковальней с книгой'),
  thorns: W(1, 'жрёт прочность брони, урон копеечный'),
  binding_curse: W(0, 'проклятие'), vanishing_curse: W(0, 'проклятие')
}
export const WANT = {
  sword: {
    sharpness: W(10, 'урон по всем: дракон, эндермены, ифриты — главное на меч'),
    looting: W(7, 'больше жемчуга с эндерменов и стержней с ифритов'),
    unbreaking: W(5, 'меч не сломается в долгой драке'),
    mending: W(7, 'чинится опытом — только наковальней'),
    sweeping_edge: W(4, 'бьёт толпу рядом с целью'),
    fire_aspect: W(3, 'поджигает, но ифриты, дракон и адские мобы огнестойкие'),
    smite: W(3, 'только нежить; вместо остроты — хуже'),
    knockback: W(1, 'отталкивает моба из-под удара, на краю Энда подставляет'),
    bane_of_arthropods: W(0.5, 'только пауки — мусор')
  },
  axe: {
    sharpness: W(8, 'топор бьёт сильно, острота ещё сильнее'),
    efficiency: W(6, 'дерево вдвое быстрее; щит противника сбивает любой топор'),
    unbreaking: W(5, 'дольше живёт'),
    fortune: W(2, 'на топоре почти бесполезна'),
    silk_touch: W(1, 'не нужно для прохождения'),
    smite: W(2, 'только нежить'),
    bane_of_arthropods: W(0.5, 'мусор')
  },
  pickaxe: {
    efficiency: W(9, 'обсидиан и камень быстрее — время на портал и спуск'),
    fortune: W(8, 'больше алмазов, лазурита, редстоуна с руды'),
    unbreaking: W(8, 'кирка живёт в 2-4 раза дольше — не застрять внизу без кирки'),
    mending: W(7, 'чинится опытом с руды'),
    silk_touch: W(2, 'руда целиком — для прохождения не нужно, мешает удаче')
  },
  shovel: {
    efficiency: W(6, 'гравий и земля быстрее'),
    unbreaking: W(5, 'дольше живёт'),
    fortune: W(5, 'из гравия чаще кремень — стрелы и огниво'),
    silk_touch: W(1, 'не нужно')
  },
  hoe: { efficiency: W(1, 'мотыга — не то, на что тратят уровни'), unbreaking: W(1, 'мотыга'), fortune: W(1, 'урожай') },
  bow: {
    power: W(10, 'урон стрелы: кристаллы Энда и дракон в полёте'),
    infinity: W(8, 'одна стрела на весь бой — кристаллы без счёта стрел'),
    unbreaking: W(5, 'лук не сломается посреди Энда'),
    flame: W(3, 'поджигает; дракону и ифритам всё равно'),
    punch: W(2, 'отбрасывает; иногда сталкивает моба с края'),
    mending: W(5, 'чинится опытом, но несовместимо с бесконечностью')
  },
  crossbow: {
    quick_charge: W(7, 'заряжает быстрее'), piercing: W(5, 'стрела проходит насквозь'),
    multishot: W(6, 'три стрелы разом'), unbreaking: W(5, 'дольше живёт')
  },
  helmet: { ...ARMOR_COMMON, respiration: W(3, 'дольше под водой'), aqua_affinity: W(2, 'копать под водой') },
  chestplate: { ...ARMOR_COMMON },
  leggings: { ...ARMOR_COMMON, swift_sneak: W(1, 'быстрее красться') },
  boots: {
    ...ARMOR_COMMON,
    feather_falling: W(10, 'падения: жемчуг, дракон подбрасывает, спуск в Энде — спасает жизнь'),
    protection: W(9, 'общая защита'),
    depth_strider: W(3, 'быстрее в воде'),
    frost_walker: W(2, 'лёд по воде'), soul_speed: W(2, 'песок душ')
  },
  trident: { loyalty: W(6, 'возвращается'), impaling: W(4, 'урон в воде'), riptide: W(3, 'рывок в дождь'), channeling: W(2, 'молния'), unbreaking: W(5, 'дольше живёт') },
  fishing_rod: { luck_of_the_sea: W(2, 'удача'), lure: W(2, 'клюёт быстрее'), unbreaking: W(2, 'дольше') }
}
// Книга — «на потом»: берём лучшее, что пойдёт на что-нибудь.
export function worthFor (kind, name) {
  if (kind === 'book') {
    let best = null
    for (const k of ['sword', 'bow', 'boots', 'chestplate', 'pickaxe']) {
      const w = WANT[k][name]
      if (w && (!best || w.w > best.w)) best = { ...w, why: `${w.why} (${KIND_RU[k]})` }
    }
    return best || W(1, 'на книгу — годится разве что для обмена')
  }
  return (WANT[kind] && WANT[kind][name]) || W(1, 'на эту вещь почти ничего не даёт')
}

export const KIND_RU = {
  sword: 'меч', axe: 'топор', pickaxe: 'кирка', shovel: 'лопата', hoe: 'мотыга', bow: 'лук', crossbow: 'арбалет',
  helmet: 'шлем', chestplate: 'нагрудник', leggings: 'поножи', boots: 'ботинки', book: 'книга', trident: 'трезубец', fishing_rod: 'удочка'
}

// Что вообще кладётся в стол (компонент enchantable у предмета).
export function kindOf (name) {
  if (!name) return null
  if (name === 'book') return 'book'
  if (name === 'turtle_helmet') return 'helmet'
  const m = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/.exec(name)
  if (m) return m[1]
  if (['bow', 'crossbow', 'trident', 'fishing_rod'].includes(name)) return name
  return null
}
const TIER = { netherite: 5, diamond: 4, iron: 3, chainmail: 2.5, turtle: 2.5, stone: 1, leather: 1, golden: 0.7, wooden: 0.5 }
export function tierOf (name) {
  const t = /^([a-z]+)_/.exec(name)
  if (t && TIER[t[1]] !== undefined) return TIER[t[1]]
  return ['bow', 'crossbow', 'trident'].includes(name) ? 3 : 1
}
// Порядок «что первым»: для победы над драконом — меч, лук, ботинки, броня.
const ORDER = {
  default: { sword: 10, bow: 9, boots: 8, chestplate: 7.5, leggings: 7, pickaxe: 6.5, helmet: 6, crossbow: 5, axe: 4, trident: 3, shovel: 2, book: 1, fishing_rod: 0.5, hoe: 0 },
  mining: { pickaxe: 11, shovel: 5 },
  dragon: { bow: 10.5, boots: 9.5, sword: 10 },
  nether: { chestplate: 9, leggings: 8.5, boots: 8 }
}
export function orderOf (kind, goal) {
  const o = (ORDER[goal] && ORDER[goal][kind])
  return o !== undefined ? o : (ORDER.default[kind] || 0)
}

// ------------------------------------------------------------ чтение предметов

export function enchantName (bot, id) {
  if (typeof id === 'string') return id.replace(/^minecraft:/, '')
  // Реестр чар — алфавитный (проверено registry_data paper-1.21.11: 0 aqua_affinity,
  // 33 sharpness, 40 unbreaking), и minecraft-data 1.21.11 идёт в том же порядке.
  const e = bot.registry.enchantments && bot.registry.enchantments[id]
  return e ? e.name : `#${id}`
}

// Компоненты 1.21: enchantments / stored_enchantments = {enchantments:[{id,level}]}.
export function enchantsOf (bot, item) {
  if (!item || !item.componentMap) return []
  const out = []
  for (const key of ['enchantments', 'stored_enchantments']) {
    const c = item.componentMap.get(key)
    const d = c && c.data
    const list = Array.isArray(d) ? d : (d && d.enchantments) || []
    for (const e of list) out.push({ name: enchantName(bot, e.id ?? e.enchantment), level: e.level ?? e.lvl ?? 1 })
  }
  return out
}
export function repairCostOf (item) {
  const c = item && item.componentMap && item.componentMap.get('repair_cost')
  return (c && typeof c.data === 'number') ? c.data : 0
}
export const fmtEnch = list => list.map(e => `${e.name} ${e.level}`).join(', ') || 'ничего'

export function lapisOf (bot) { return countOf(bot, 'lapis_lazuli') }
export function levelOf (bot) { return (bot.experience && bot.experience.level) || 0 }

// ------------------------------------------------------------ полки

export function shelfCells (c) {
  const out = []
  for (let y = 0; y <= 1; y++) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (Math.abs(x) === 2 || Math.abs(z) === 2) out.push({ off: new Vec3(x, y, z), gap: new Vec3(Math.trunc(x / 2), y, Math.trunc(z / 2)) })
      }
    }
  }
  return out
}
export const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|seagrass|tall_seagrass|fire|soul_fire|snow|vine|glow_lichen|resin_clump|light|structure_void|leaf_litter)$/

// Сколько полок стол реально видит — ровно по правилу isValidBookShelf.
export function shelfPower (bot, tablePos) {
  let n = 0
  let blocked = 0
  for (const s of shelfCells(tablePos)) {
    const b = bot.blockAt(tablePos.plus(s.off))
    if (!b || b.name !== 'bookshelf') continue
    const g = bot.blockAt(tablePos.plus(s.gap))
    if (g && REPLACEABLE.test(g.name)) n++
    else blocked++
  }
  return { counted: Math.min(MAX_SHELVES, n), raw: n, blocked }
}

// Цена строк при N полках — диапазоны из getEnchantmentCost (для плана).
export function costRange (shelves) {
  const n = Math.min(MAX_SHELVES, shelves)
  const lo = 1 + (n >> 1)
  const hi = 8 + (n >> 1) + n
  return {
    top: [Math.max(lo, n * 2), Math.max(hi, n * 2)],
    mid: [Math.floor(lo * 2 / 3) + 1, Math.floor(hi * 2 / 3) + 1],
    low: [Math.max(Math.floor(lo / 3), 1), Math.max(Math.floor(hi / 3), 1)]
  }
}
