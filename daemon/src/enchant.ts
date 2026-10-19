'use strict'
import * as gameClock from './game-clock'
// Зачарование: стол, книжные полки, лазурит, уровни опыта — и главное, ЧТО
// зачаровывать и ЗАЧЕМ. Все числа — из самой игры (paper-1.21.11, байткод и
// data/minecraft/enchantment/*.json), см. SPEEDRUN.md «Зачарование».
//
//   EnchantingTableBlock.BOOKSHELF_OFFSETS — клетки x,z в [-2..2], y 0..1, где
//     |x|==2 или |z|==2 (кольцо в двух слоях, 32 клетки). Полка засчитывается,
//     только если клетка МЕЖДУ ней и столом (x/2, y, z/2, деление к нулю) —
//     #replaceable (воздух, трава, снег). Считается максимум 15.
//   EnchantmentHelper.getEnchantmentCost: c = rnd(8)+1 + полки/2 + rnd(полки+1);
//     строка 1 = max(c/3,1), строка 2 = c*2/3+1, строка 3 = max(c, полки*2).
//     15 полок → третья строка до 30.
//   EnchantmentMenu.clickMenuButton: строка i стоит i+1 лазурита и i+1 уровень,
//     а доступна при уровне ≥ цены строки. Любое зачарование меняет «семя» —
//     предложения перетасовываются (дешёвый переброс книгой).
//   AnvilMenu: 40 и дороже — «слишком дорого»; книга стоит anvil_cost/2 за
//     уровень; каждая работа удваивает штраф предмета (cost*2+1).
//
// Подсказка стола показывает ОДНО из зачарований строки; на дорогой строке их
// часто два-три. Выбор здесь — по подсказке, с поправкой на цену строки.

const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from './movement'
import { withTimeout, placeBlockAt } from './build'
import actions = require('./actions')
import { countOf, equipBestTool } from './items'

// ------------------------------------------------------------ факты игры

// [max_level, anvil_cost, exclusive_set] — data/minecraft/enchantment/*.json.
const ENCH = {
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
function conflicts (a, b) {
  if (a === b) return false
  const sa = ENCH[a] && EXCLUSIVE[ENCH[a][2]]
  const sb = ENCH[b] && EXCLUSIVE[ENCH[b][2]]
  return !!((sa && sa.includes(b)) || (sb && sb.includes(a)))
}

// Player.getXpNeededForNextLevel: <15 → 7+2L; 15..29 → 37+5(L-15); ≥30 → 112+9(L-30).
function xpForNext (l) { return l >= 30 ? 112 + (l - 30) * 9 : l >= 15 ? 37 + (l - 15) * 5 : 7 + 2 * l }
function pointsBetween (from, to) { let s = 0; for (let l = from; l < to; l++) s += xpForNext(l); return s }

const MAX_SHELVES = 15

// ------------------------------------------------------------ что и зачем

// Вес 0..10 за максимальный уровень и слово «зачем». Меньше 2 — мусор: на него
// уровни не тратим, если есть выбор (переброс книгой дешевле).
const W = (w, why) => ({ w, why })
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
const WANT = {
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
function worthFor (kind, name) {
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

const KIND_RU = {
  sword: 'меч', axe: 'топор', pickaxe: 'кирка', shovel: 'лопата', hoe: 'мотыга', bow: 'лук', crossbow: 'арбалет',
  helmet: 'шлем', chestplate: 'нагрудник', leggings: 'поножи', boots: 'ботинки', book: 'книга', trident: 'трезубец', fishing_rod: 'удочка'
}

// Что вообще кладётся в стол (компонент enchantable у предмета).
function kindOf (name) {
  if (!name) return null
  if (name === 'book') return 'book'
  if (name === 'turtle_helmet') return 'helmet'
  const m = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/.exec(name)
  if (m) return m[1]
  if (['bow', 'crossbow', 'trident', 'fishing_rod'].includes(name)) return name
  return null
}
const TIER = { netherite: 5, diamond: 4, iron: 3, chainmail: 2.5, turtle: 2.5, stone: 1, leather: 1, golden: 0.7, wooden: 0.5 }
function tierOf (name) {
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
function orderOf (kind, goal) {
  const o = (ORDER[goal] && ORDER[goal][kind])
  return o !== undefined ? o : (ORDER.default[kind] || 0)
}

// ------------------------------------------------------------ чтение предметов

function enchantName (bot, id) {
  if (typeof id === 'string') return id.replace(/^minecraft:/, '')
  // Реестр чар — алфавитный (проверено registry_data paper-1.21.11: 0 aqua_affinity,
  // 33 sharpness, 40 unbreaking), и minecraft-data 1.21.11 идёт в том же порядке.
  const e = bot.registry.enchantments && bot.registry.enchantments[id]
  return e ? e.name : `#${id}`
}

// Компоненты 1.21: enchantments / stored_enchantments = {enchantments:[{id,level}]}.
function enchantsOf (bot, item) {
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
function repairCostOf (item) {
  const c = item && item.componentMap && item.componentMap.get('repair_cost')
  return (c && typeof c.data === 'number') ? c.data : 0
}
const fmtEnch = list => list.map(e => `${e.name} ${e.level}`).join(', ') || 'ничего'

function lapisOf (bot) { return countOf(bot, 'lapis_lazuli') }
function levelOf (bot) { return (bot.experience && bot.experience.level) || 0 }

// ------------------------------------------------------------ полки

function shelfCells (c) {
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
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|seagrass|tall_seagrass|fire|soul_fire|snow|vine|glow_lichen|resin_clump|light|structure_void|leaf_litter)$/

// Сколько полок стол реально видит — ровно по правилу isValidBookShelf.
function shelfPower (bot, tablePos) {
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
function costRange (shelves) {
  const n = Math.min(MAX_SHELVES, shelves)
  const lo = 1 + (n >> 1)
  const hi = 8 + (n >> 1) + n
  return {
    top: [Math.max(lo, n * 2), Math.max(hi, n * 2)],
    mid: [Math.floor(lo * 2 / 3) + 1, Math.floor(hi * 2 / 3) + 1],
    low: [Math.max(Math.floor(lo / 3), 1), Math.max(Math.floor(hi / 3), 1)]
  }
}

// ------------------------------------------------------------ окна

async function closeAny (bot) {
  const w = bot.currentWindow
  if (!w) return
  try { if (typeof w.close === 'function') w.close(); else bot.closeWindow(w) } catch {}
  await sleep(250)
}

// Окно на 1.21.11 открывается не с первого раза (containers.js raceOpen) —
// три попытки, опоздавшее окно закрываем сами.
async function openBlockWindow (bot, block, what) {
  let last = null
  for (let i = 0; i < 3; i++) {
    await closeAny(bot)
    let gaveUp = false
    const opening = bot.openBlock(block)
    opening.then(w => { if (gaveUp && bot.currentWindow === w) { try { w.close() } catch {} } }, () => {})
    try {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      return await withTimeout(opening, 6000, `${what} не открылся`)
    } catch (e) {
      gaveUp = true
      last = e
      await sleep(400)
    }
  }
  throw last || new Error(`${what} не открылся`)
}

// Положить РОВНО один предмет (правый клик) — стол и стойка берут по одному.
// Номер клетки читаем ДО кликов: prismarine-windows переписывает item.slot у
// того же объекта, когда он переезжает (проба 2026-09-25 — второй клик ушёл
// не туда).
async function putOne (bot, win, item, dest) {
  const src = item.slot
  await bot.clickWindow(src, 0, 0)
  await bot.clickWindow(dest, 1, 0)
  if (win.selectedItem) await bot.clickWindow(src, 0, 0)
  await sleep(120)
}
async function putAll (bot, win, item, dest) {
  const src = item.slot
  await bot.clickWindow(src, 0, 0)
  await bot.clickWindow(dest, 0, 0)
  if (win.selectedItem) await bot.clickWindow(src, 0, 0)
  await sleep(120)
}
async function takeOut (bot, win, slot) {
  if (!win.slots[slot]) return false
  try { await bot.putAway(slot); return true } catch { return false }
}

// Свойства окна (craft_progress_bar = container_set_data) с отметкой времени.
function watchProps (bot, win) {
  const st: any = { props: {}, at: 0 }
  const on = p => { if (p.windowId !== win.id) return; st.props[p.property] = p.value; st.at = gameClock.now() }
  bot._client.on('craft_progress_bar', on)
  st.stop = () => bot._client.removeListener('craft_progress_bar', on)
  return st
}
async function freshProps (st, since, ms = 3000) {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < ms && st.at <= since) await sleep(50)
  await sleep(250)
  return st.at > since
}

// ------------------------------------------------------------ выбор

function offersOf (bot, st) {
  const p = st.props
  return [0, 1, 2].map(i => {
    const clue = p[4 + i] ?? -1
    return {
      slot: i,
      cost: p[i] || 0,
      clue: clue >= 0 ? enchantName(bot, clue) : null,
      clueLevel: p[7 + i] ?? -1
    }
  })
}

function worthOfOffer (kind, o) {
  if (!o.clue) return 0
  const w = worthFor(kind, o.clue)
  const max = (ENCH[o.clue] && ENCH[o.clue][0]) || 1
  return w.w * (0.4 + 0.6 * Math.min(1, Math.max(1, o.clueLevel) / max))
}

// Лучшая строка: ценность подсказки + доля за цену (дорогая строка часто даёт
// два-три зачарования) − уровни, которые уйдут. Доля за цену мала нарочно:
// сила II за 2 уровня луку полезнее прочности III за 3 (прогон try-enchant).
function rankOffers (kind, offers, { level, lapis }: any) {
  return offers
    .filter(o => o.cost > 0)
    .map(o => {
      const worth = worthOfOffer(kind, o)
      const w = o.clue ? worthFor(kind, o.clue) : null
      return {
        ...o,
        worth: Math.round(worth * 10) / 10,
        score: worth + o.cost * 0.1 - (o.slot + 1) * 0.4,
        junk: !!(w && w.w < 2),
        why: w ? w.why : null,
        affordable: level >= o.cost && level >= o.slot + 1 && lapis >= o.slot + 1
      }
    })
    .sort((a, b) => b.score - a.score)
}

// Что зачаровать первым: лучшая незачарованная вещь по пользе и материалу.
function chooseTargets (bot, { goal = 'default', count = 1, allowCheap = false }: any = {}) {
  const seen = new Set()
  const cand = []
  for (const it of bot.inventory.items()) {
    const kind = kindOf(it.name)
    if (!kind || kind === 'book') continue
    if (enchantsOf(bot, it).length) continue
    const tier = tierOf(it.name)
    if (!allowCheap && tier < 1) continue
    if (seen.has(it.name)) continue
    seen.add(it.name)
    cand.push({ item: it, kind, score: orderOf(kind, goal) * (0.6 + 0.1 * tier) })
  }
  // Надетое тоже в счёт: броню снимать не надо — стол берёт её из рюкзака, а
  // надетую сначала снимем (см. run).
  for (const slot of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[slot]
    if (!it) continue
    const kind = kindOf(it.name)
    if (!kind || enchantsOf(bot, it).length || seen.has(it.name)) continue
    if (!allowCheap && tierOf(it.name) < 1) continue
    seen.add(it.name)
    cand.push({ item: it, kind, worn: true, score: orderOf(kind, goal) * (0.6 + 0.1 * tierOf(it.name)) })
  }
  cand.sort((a, b) => b.score - a.score)
  return cand.slice(0, count)
}

// ------------------------------------------------------------ стол

function findTable (bot, mcData, r = 16) {
  const id = mcData.blocksByName.enchanting_table.id
  return bot.findBlock({ matching: id, maxDistance: r })
}

// Площадка 5x5 под стол с кольцом полок: пол сплошной, два слоя свободны.
function siteCost (bot, c) {
  let dig = 0
  let fill = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const floor = bot.blockAt(c.offset(dx, -1, dz))
      if (!floor) return null
      if (/water|lava/.test(floor.name)) return null
      if (floor.boundingBox !== 'block') fill++
      for (let dy = 0; dy <= 1; dy++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (!b || /water|lava/.test(b.name)) return null
        if (b.boundingBox === 'block' && !REPLACEABLE.test(b.name)) dig++
      }
    }
  }
  return { dig, fill, cost: dig * 2 + fill * 3 }
}
function pickSite (bot) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = me.offset(dx, dy, dz)
        const s = siteCost(bot, c)
        if (!s) continue
        const cost = s.cost + Math.abs(dx) * 0.3 + Math.abs(dz) * 0.3 + Math.abs(dy)
        if (!best || cost < best.cost) best = { c, ...s, cost }
      }
    }
  }
  return best
}

async function walkNear (bot, pos, range, ms = 12000) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), ms, 'не дошёл')
  } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 1.5
}
async function standAt (bot, cell, ms = 10000) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(cell.x, cell.y, cell.z)), ms, 'не встал')
  } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
  return bot.entity.position.floored().equals(cell)
}

// Площадку ровняем сами: копаем лишнее, досыпаем пол. Недорого на ровном.
async function clearSite (session, ctl, c) {
  const bot = session.bot
  let dug = 0
  let filled = 0
  for (let dy = 1; dy >= 0; dy--) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (ctl.aborted) return { dug, filled }
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.boundingBox !== 'block' || REPLACEABLE.test(b.name)) continue
        if (bot.entity.position.distanceTo(p) > 4) await walkNear(bot, p, 2, 6000)
        try { await equipBestTool(bot, b); await withTimeout(bot.dig(b, true), 8000, 'не копается'); dug++ } catch {}
      }
    }
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (ctl.aborted) return { dug, filled }
      const p = c.offset(dx, -1, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox === 'block') continue
      if (bot.entity.position.distanceTo(p) > 4) await walkNear(bot, p, 2, 6000)
      const r = await placeBlockAt(bot, p, { timeoutMs: 1500 })
      if (r.ok) filled++
    }
  }
  return { dug, filled }
}

// Скрафтить, если чего-то не хватает, через обычный крафт (actions.craft — он
// сам ставит и забирает верстак). Возвращает, сколько теперь есть.
// Большой заказ (135 бумаги) mineflayer за один bot.craft не доводит — на
// 1.21.11 длинная серия кликов в окне верстака рвётся на середине (прогон
// try-enchant: из 45 заходов прошло 29). Поэтому порциями и до упора, пока
// растёт.
async function craftUpTo (session, ctl, name, want) {
  const bot = session.bot
  const start = countOf(bot, name)
  let error = null
  for (let i = 0; i < 12 && !ctl.aborted; i++) {
    const have = countOf(bot, name)
    if (have >= want) break
    try {
      await actions.craft(session, ctl, { item: name, count: Math.min(want - have, 24), spendReserve: true })
      error = null
    } catch (e) { error = e.message }
    await sleep(700) // invsync: полная копия рюкзака приходит после закрытия окна
    if (countOf(bot, name) <= have) break
  }
  const have = countOf(bot, name)
  return { have, crafted: have - start, error: have >= want ? undefined : error || undefined }
}

// Книги → полки: бумага из тростника, книга = 3 бумаги + кожа.
async function makeShelves (session, ctl, want, lines) {
  const bot = session.bot
  let shelves = countOf(bot, 'bookshelf')
  if (shelves >= want) return shelves
  const need = want - shelves
  const books = countOf(bot, 'book')
  if (books < need * 3) {
    const paperNeed = (need * 3 - books) * 3
    if (countOf(bot, 'paper') < paperNeed && countOf(bot, 'sugar_cane') >= 3) {
      await craftUpTo(session, ctl, 'paper', Math.min(paperNeed, countOf(bot, 'paper') + Math.floor(countOf(bot, 'sugar_cane') / 3) * 3))
    }
    const canBooks = Math.min(Math.floor(countOf(bot, 'paper') / 3), countOf(bot, 'leather'))
    if (canBooks > 0) await craftUpTo(session, ctl, 'book', books + Math.min(canBooks, need * 3 - books))
  }
  const canShelves = Math.min(need, Math.floor(countOf(bot, 'book') / 3))
  if (canShelves > 0) {
    const r = await craftUpTo(session, ctl, 'bookshelf', shelves + canShelves)
    if (r.error) lines.push(`⚠ полки не скрафтил: ${r.error}`)
  }
  shelves = countOf(bot, 'bookshelf')
  return shelves
}

// Поставить стол (и полки вокруг, если есть). Возвращает блок стола.
async function setupTable (session, ctl, { shelves: wantShelves = MAX_SHELVES, lines = [] }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  let table = findTable(bot, mcData, 16)
  const report: any = { placedTable: false, placedShelves: 0 }

  if (!table) {
    if (!countOf(bot, 'enchanting_table')) {
      if (!countOf(bot, 'book') && countOf(bot, 'paper') < 3 && countOf(bot, 'sugar_cane') >= 3) await craftUpTo(session, ctl, 'paper', 3)
      if (!countOf(bot, 'book')) await craftUpTo(session, ctl, 'book', 1)
      const r = await craftUpTo(session, ctl, 'enchanting_table', 1)
      if (!r.have) {
        throw new Error('стола нет и не из чего: стол = книга + 2 алмаза + 4 обсидиана (книга = 3 бумаги + кожа, бумага = 3 тростника)' +
          (r.error ? ` — ${r.error}` : ''))
      }
    }
    if (ctl.aborted) throw new Error('прервано')
    const site = pickSite(bot)
    if (!site) throw new Error('рядом нет площадки 5x5 под стол с полками (вода/лава или мир не прогружен)')
    const c = site.c
    await walkNear(bot, c, 2)
    if (site.dig || site.fill) {
      const cl = await clearSite(session, ctl, c)
      if (cl.dug || cl.filled) lines.push(`▸ площадка: выкопал ${cl.dug}, досыпал пол ${cl.filled}`)
    }
    // Встать в кольцо 1 (оно и есть зазор под правило полок), стол — в центр.
    await standAt(bot, c.offset(1, 0, 0))
    const r = await placeBlockAt(bot, c, { item: 'enchanting_table', timeoutMs: 3000 })
    await sleep(200)
    table = bot.blockAt(c)
    if (!table || table.name !== 'enchanting_table') throw new Error(`стол не встал: ${r.reason || 'не знаю почему'}`)
    report.placedTable = true
    report.table = xyz(c)
  }
  report.table = xyz(table.position)

  // Полки: нижний слой кольца 2, дверь — клетка (0,0,-2). 15 = потолок игры.
  const power0 = shelfPower(bot, table.position)
  const want = Math.min(MAX_SHELVES, wantShelves)
  if (power0.counted < want) {
    const have = await makeShelves(session, ctl, want - power0.counted, lines)
    if (have > 0) {
      const c = table.position
      const door = c.offset(0, 0, -2)
      const slots = shelfCells(c).map(s => c.plus(s.off)).filter(p => !p.equals(door))
        // нижний слой сперва: его видно и ставится он на пол
        .sort((a, b) => a.y - b.y)
      // Зазор (кольцо 1) должен быть пуст — это правило стола, не наша прихоть.
      for (const s of shelfCells(c)) {
        const g = bot.blockAt(c.plus(s.gap))
        if (g && g.boundingBox === 'block' && !g.position.equals(c) && g.name !== 'bookshelf') {
          try { await equipBestTool(bot, g); await withTimeout(bot.dig(g, true), 8000, 'не копается') } catch {}
        }
      }
      if (!bot.entity.position.floored().equals(c.offset(1, 0, 0))) await standAt(bot, c.offset(1, 0, 0))
      let placed = 0
      for (const p of slots) {
        if (ctl.aborted || !countOf(bot, 'bookshelf')) break
        if (shelfPower(bot, c).counted >= want) break
        const b = bot.blockAt(p)
        if (!b || b.name === 'bookshelf') continue
        if (b.boundingBox === 'block' && !REPLACEABLE.test(b.name)) continue
        const r = await placeBlockAt(bot, p, { item: 'bookshelf', timeoutMs: 1500 })
        if (r.ok && !r.already) placed++
      }
      report.placedShelves = placed
    }
  }
  const power = shelfPower(bot, table.position)
  report.shelves = power.counted
  if (power.blocked) lines.push(`⚠ ${power.blocked} полок не считаются: между ними и столом не воздух`)
  return { table, report }
}

// ------------------------------------------------------------ зачарование

// Встать так, чтобы стол был под рукой (кольцо 1, если свободно).
async function approachTable (bot, table) {
  if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) <= 3.5) return
  const c = table.position
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    const cell = c.offset(dx, 0, dz)
    const b = bot.blockAt(cell)
    const h = bot.blockAt(cell.offset(0, 1, 0))
    if (b && h && b.boundingBox === 'empty' && h.boundingBox === 'empty') {
      if (await standAt(bot, cell, 8000)) return
    }
  }
  await walkNear(bot, c, 2)
}

// Снять надетое, если его зачаровываем (стол берёт вещь из рюкзака).
async function unwearIfNeeded (bot, target) {
  if (target.item.slot >= 5 && target.item.slot <= 8) {
    const dest = { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[target.item.slot]
    try { await bot.unequip(dest) } catch {}
    await sleep(300)
    target.rewear = dest
  }
}

async function enchantOne (session, ctl, table, target, { rerolls = 2, patient = true, lines }: any) {
  const bot = session.bot
  const kind = target.kind
  const name = target.item.name
  const out: any = { item: name, kind: KIND_RU[kind] || kind }

  await unwearIfNeeded(bot, target)
  const win = await openBlockWindow(bot, table, 'стол зачарования')
  const st: any = watchProps(bot, win)
  try {
    // Лазурит — стеком в клетку 1.
    const lap = win.items().find(i => i.name === 'lapis_lazuli')
    if (!lap) throw new Error('нет лазурита')
    await putAll(bot, win, lap, 1)

    const putTarget = async () => {
      const it = win.items().find(i => i.name === name && !enchantsOf(bot, i).length)
      if (!it) throw new Error(`${name} нет в рюкзаке`)
      const since = gameClock.now()
      await putOne(bot, win, it, 0)
      await freshProps(st, since)
    }
    await putTarget()

    let rolled = 0
    let pick = null
    for (;;) {
      const level = levelOf(bot)
      const lapis = (win.slots[1] && win.slots[1].count) || 0
      const offers = offersOf(bot, st)
      const ranked = rankOffers(kind, offers, { level, lapis })
      out.offers = ranked.map(o => `${o.slot + 1}: ${o.cost} ур. → ${o.clue || '?'} ${o.clueLevel > 0 ? o.clueLevel : ''}`.trim())
      if (!ranked.length) throw new Error(`${name} стол не принимает (не зачаровывается или уже зачарован)`)
      const affordable = ranked.filter(o => o.affordable)
      const best = affordable.find(o => !o.junk) || affordable[0] || null
      const top = ranked.reduce((a, b) => (b.cost > a.cost ? b : a), ranked[0])

      // Терпение: алмазную вещь не тратим на дешёвую строку, если верхняя
      // скоро по карману (копи уровни — это дешевле, чем потом переделывать).
      if (patient && tierOf(name) >= 4 && top && !top.affordable && top.cost >= 20) {
        out.skipped = `копи уровни: верхняя строка ${top.cost} ур., у меня ${level} — на ${name} дешёвую строку не трачу`
        out.need = { what: 'уровни опыта', count: top.cost, have: level, points: pointsBetween(level, top.cost) }
        return out
      }
      if (!best) {
        out.skipped = `не хватает: уровней ${level}, лазурита ${lapis} — самая дешёвая строка ${ranked[ranked.length - 1].cost} ур.`
        out.need = { what: 'уровни опыта', count: Math.min(...ranked.map(o => o.cost)), have: level }
        return out
      }

      // Переброс: зачаровать книгу первой строкой (1 уровень, 1 лазурит) — стол
      // перетасует предложения, а книга пойдёт на наковальню. Когда: всё
      // доступное — мусор; или верхняя строка слабая (smite вместо остроты), а
      // уровней хватит на неё и после переброса. Другую вещь для этого не
      // берём: зачарованную стол больше не примет.
      const spareBook = win.items().find(i => i.name === 'book')
      // «Слабо» — меньше 0.6 от главной чары вида: прочность III на меч (5
      // против остроты 10) — повод перебросить, на кирку (8 против 9) — нет.
      const kindTop = Math.max(...(Object.values(WANT[kind] || { x: W(5, '') }) as any[]).map((w : any) => w.w))
      const weakTop = top && top.cost >= 20 && worthOfOffer(kind, top) < 0.6 * kindTop && level >= top.cost + 1
      if ((best.junk || weakTop) && rolled < rerolls && spareBook && level >= 2 && lapis >= 2) {
        const tSlot = 0
        await takeOut(bot, win, tSlot)
        const since = gameClock.now()
        await putOne(bot, win, spareBook, 0)
        await freshProps(st, since)
        const before = win.slots[0]
        bot._client.write('enchant_item', { windowId: win.id, enchantment: 0 })
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 3000 && win.slots[0] === before) await sleep(50)
        await takeOut(bot, win, 0)
        rolled++
        lines.push(`▸ переброс: на ${name} стол давал ${best.junk ? best.clue + " (мусор)" : "наверху " + top.clue + " (слабо)"} — зачаровал книгу за 1 ур., смотрю заново`)
        await putTarget()
        continue
      }
      // Алмазная вещь зачаровывается один раз: дешёвая строка (острота I)
      // навсегда закрывает ей стол. Верхняя по карману — берём верхнюю (там
      // 2-3 чары), если она не мусор; мусор и перебросить нечем — ждём.
      if (tierOf(name) >= 4 && top && top.affordable && top.cost >= 20 && best !== top) {
        if (!top.junk) {
          lines.push(`▸ ${name}: беру верхнюю строку (${top.clue}), а не ${best.clue} за ${best.cost} — вещь зачаровывается один раз`)
          pick = top
          break
        }
        // Мусор в подсказке — это одна чара из 2-3. Беда, только если она
        // закрывает главную (smite/bane навсегда закрывают остроту).
        const main = (Object.entries(WANT[kind] || {}) as [string, any][]).sort((a: any, b: any) => b[1].w - a[1].w)[0]
        if (patient && main && conflicts(top.clue, main[0])) {
          out.skipped = `наверху ${top.clue} — навсегда закроет ${main[0]}; нужна книга на переброс (1 ур.)`
          out.need = { what: 'book', count: 1, have: 0 }
          out.rerolls = rolled || undefined
          return out
        }
        lines.push(`▸ ${name}: наверху ${top.clue} (в подсказке мусор), но строка 30 даёт 2-3 чары и ничего не закрывает — беру`)
        pick = top
        break
      }
      pick = best
      break
    }

    const levelBefore = levelOf(bot)
    const since = gameClock.now()
    bot._client.write('enchant_item', { windowId: win.id, enchantment: pick.slot })
    let got = []
    while (gameClock.now() - since < 4000) {
      got = enchantsOf(bot, win.slots[0])
      if (got.length) break
      await sleep(80)
    }
    if (!got.length) throw new Error(`стол не зачаровал ${name} (строка ${pick.slot + 1}, ${pick.cost} ур.)`)
    await takeOut(bot, win, 0)
    out.slot = pick.slot + 1
    out.cost = pick.cost
    out.spentLevels = pick.slot + 1
    out.got = got
    out.rerolls = rolled || undefined
    // Сначала то, ради чего брали; мусор, пришедший в нагрузку, — последним и с пометкой.
    out.why = got.slice().sort((a, b) => worthFor(kind, b.name).w - worthFor(kind, a.name).w)
      .map(e => `${e.name} ${e.level}: ${worthFor(kind, e.name).w < 2 ? "(в нагрузку) " : ""}${worthFor(kind, e.name).why}`)
    out.levelsLeft = levelOf(bot)
    if (out.levelsLeft === levelBefore) out.levelsLeft = levelBefore - (pick.slot + 1)
    return out
  } finally {
    st.stop()
    // Лазурит и всё, что осталось в столе, сервер вернёт при закрытии; забираем
    // сами, чтобы рюкзак клиента не разошёлся (invsync).
    try { if (bot.currentWindow === win) { await takeOut(bot, win, 0); await takeOut(bot, win, 1) } } catch {}
    try { win.close() } catch {}
    await sleep(600)
    if (target.rewear) {
      const back = bot.inventory.items().find(i => i.name === name)
      if (back) { try { await bot.equip(back, target.rewear) } catch {} }
    }
  }
}

// ------------------------------------------------------------ наковальня

// Что игра вообще примет на вещь этого вида (supported_items чар, по WANT +
// прочность/починка на всё с прочностью).
function supports (kind, name) {
  if (WANT[kind] && WANT[kind][name]) return true
  return kind !== 'book' && ['unbreaking', 'mending', 'vanishing_curse'].includes(name)
}

// Оценка цены по AnvilMenu.createResult: штрафы обоих + за каждое принятое
// зачарование anvil_cost (у книги /2, не меньше 1) × итоговый уровень;
// несовместимое или неподходящее — +1 и мимо. gain — польза: только то, что
// реально подняло уровень (сила 3 на лук с силой 4 — ноль, а уровни уйдут).
function anvilEstimate (bot, left, right) {
  const kind = kindOf(left.name)
  const isBook = right.name === 'enchanted_book'
  const have = enchantsOf(bot, left)
  const add = enchantsOf(bot, right)
  let cost = repairCostOf(left) + repairCostOf(right)
  const result = new Map(have.map(e => [e.name, e.level]))
  let applied = 0
  let gain = 0
  for (const e of add) {
    const cur = result.get(e.name) || 0
    if (!supports(kind, e.name) || have.some(h => conflicts(h.name, e.name))) { cost += 1; continue }
    const max = (ENCH[e.name] && ENCH[e.name][0]) || 1
    const lvl = Math.min(max, cur === e.level ? cur + 1 : Math.max(cur, e.level))
    let per = (ENCH[e.name] && ENCH[e.name][1]) || 1
    if (isBook) per = Math.max(1, Math.floor(per / 2))
    cost += per * lvl
    if (lvl > cur) { applied++; gain += worthFor(kind, e.name).w * (lvl - cur) / max }
    result.set(e.name, lvl)
  }
  return { cost, applied, gain: Math.round(gain * 10) / 10, result: [...result].map(([name, level]) => ({ name, level })) }
}

function findAnvil (bot, mcData, r = 16) {
  const ids = ['anvil', 'chipped_anvil', 'damaged_anvil'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(Boolean)
  return bot.findBlock({ matching: ids, maxDistance: r })
}

async function anvilRun (session, ctl, p, lines) {
  const bot = session.bot
  const mcData = session.mcData
  const books = bot.inventory.items().filter(i => i.name === 'enchanted_book')
  if (!books.length) throw new Error('нет зачарованной книги — наковальня переносит чары с книги на вещь')
  // Цель: названная, иначе лучшая вещь, которой подходит книга.
  const worn = [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean)
  const targets = [...bot.inventory.items(), ...worn].filter(i => kindOf(i.name) && kindOf(i.name) !== 'book' && (!p.item || i.name === p.item))
  let best = null
  for (const t of targets) {
    const kind = kindOf(t.name)
    for (const b of books) {
      if (p.book && !enchantsOf(bot, b).some(e => e.name === p.book)) continue
      const est = anvilEstimate(bot, t, b)
      if (!est.applied || est.cost >= 40 || est.gain < 1) continue
      // Незачарованную алмазную вещь слабой книгой не портим: после наковальни
      // стол её уже не примет, а там ждут 30 уровней с 2-3 чарами.
      if (!p.item && tierOf(t.name) >= 4 && !enchantsOf(bot, t).length && est.gain < 6) continue
      const score = est.gain * orderOf(kind, p.goal || 'default') * tierOf(t.name) - est.cost * 0.2
      if (!best || score > best.score) best = { t, b, est, score, kind }
    }
  }
  if (!best) throw new Error('нет пары «вещь + книга», где книга что-то даёт и дешевле 40 уровней')
  if (levelOf(bot) < best.est.cost) {
    return { skipped: `нужно ~${best.est.cost} ур., у меня ${levelOf(bot)}`, need: { what: 'уровни опыта', count: best.est.cost, have: levelOf(bot) } }
  }

  let anvil = findAnvil(bot, mcData, 16)
  if (!anvil) {
    if (!countOf(bot, 'anvil')) {
      if (countOf(bot, 'iron_block') < 3) await craftUpTo(session, ctl, 'iron_block', 3)
      const r = await craftUpTo(session, ctl, 'anvil', 1)
      if (!r.have) throw new Error('наковальни нет: 3 железных блока + 4 слитка (31 слиток)' + (r.error ? ` — ${r.error}` : ''))
    }
    await actions.place(session, ctl, { block: 'anvil' })
    await sleep(300)
    anvil = findAnvil(bot, mcData, 6)
    if (!anvil) throw new Error('наковальня не встала')
  }
  await walkNear(bot, anvil.position, 2)
  const bookEnch = enchantsOf(bot, best.b)
  const itemName = best.t.name
  const itemSig = JSON.stringify(enchantsOf(bot, best.t))
  // Надетое — снять (наковальня берёт из рюкзака), потом надеть обратно.
  const wornDest = best.t.slot >= 5 && best.t.slot <= 8 ? { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[best.t.slot] : null
  if (wornDest) { try { await bot.unequip(wornDest) } catch {} await sleep(300) }
  const win = await openBlockWindow(bot, anvil, 'наковальня')
  const st: any = watchProps(bot, win)
  try {
    // Окно открылось сразу после стола/снятия брони — копия рюкзака в нём
    // может прийти чуть позже (прогон try-enchant: «пропали» на первом заходе).
    const find = () => ({
      it: win.items().find(i => i.name === itemName && JSON.stringify(enchantsOf(bot, i)) === itemSig),
      bk: win.items().find(i => i.name === 'enchanted_book' && JSON.stringify(enchantsOf(bot, i)) === JSON.stringify(bookEnch))
    })
    let got = find()
    for (let i = 0; i < 15 && (!got.it || !got.bk); i++) { await sleep(200); got = find() }
    const { it, bk } = got
    if (!it || !bk) throw new Error('вещь или книга пропали из рюкзака')
    await putOne(bot, win, it, 0)
    const since = gameClock.now()
    await putOne(bot, win, bk, 1)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 3000 && !win.slots[2]) await sleep(50)
    await freshProps(st, since, 1500)
    const cost = st.props[0] ?? best.est.cost
    if (!win.slots[2]) throw new Error('наковальня не собрала результат')
    if (cost >= 40) throw new Error(`слишком дорого: ${cost} ур. (40 — потолок наковальни)`)
    if (levelOf(bot) < cost) throw new Error(`нужно ${cost} ур., у меня ${levelOf(bot)}`)
    const result = enchantsOf(bot, win.slots[2])
    await bot.putAway(2)
    await sleep(300)
    if (wornDest) {
      try { win.close() } catch {}
      await sleep(600)
      const back = bot.inventory.items().find(i => i.name === itemName)
      if (back) { try { await bot.equip(back, wornDest) } catch {} }
    }
    return {
      anvil: xyz(anvil.position),
      item: itemName,
      book: fmtEnch(bookEnch),
      cost,
      got: result,
      // Только то, что реально поднялось: чужая книге часть (сила на ботинках) — мимо.
      why: result.filter(r => { const b = bookEnch.find(e => e.name === r.name); const was = JSON.parse(itemSig).find(e => e.name === r.name); return b && (!was || r.level > was.level) })
        .map(e => `${e.name} ${e.level}: ${worthFor(best.kind, e.name).why}`),
      note: 'каждая работа на наковальне удваивает штраф вещи — самое ценное клади первым'
    }
  } finally {
    st.stop()
    try { if (bot.currentWindow === win) { await takeOut(bot, win, 0); await takeOut(bot, win, 1) } } catch {}
    try { win.close() } catch {}
    await sleep(500)
  }
}

// ------------------------------------------------------------ план

// Где взять опыт — одна строка, чтобы мозг знал, что делать при нехватке.
const XP_WAYS = 'опыт: плавка (слиток железа 0.7, золота 1.0, еда 0.35 — забрать из печи), руда (алмаз, лазурит, редстоун, кварц, уголь), мобы 5, ифрит 10, дракон 12000'

function plan (session, { goal = 'default' }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const lines = []
  const table = findTable(bot, mcData, 16)
  const power = table ? shelfPower(bot, table.position) : { counted: 0, raw: 0, blocked: 0 }
  const level = levelOf(bot)
  const lapis = lapisOf(bot)
  const shelvesBag = countOf(bot, 'bookshelf')
  const shelvesTotal = Math.min(MAX_SHELVES, power.counted + shelvesBag)
  const range = costRange(shelvesTotal)
  const targets = chooseTargets(bot, { goal, count: 4 })

  if (table) lines.push(`▸ стол на ${table.position.x},${table.position.y},${table.position.z}, полок видит ${power.counted}/15`)
  else if (countOf(bot, 'enchanting_table')) lines.push('▸ стол в рюкзаке — поставлю')
  else {
    const miss = []
    if (countOf(bot, 'obsidian') < 4) miss.push(`обсидиан ${countOf(bot, 'obsidian')}/4`)
    if (countOf(bot, 'diamond') < 2) miss.push(`алмазы ${countOf(bot, 'diamond')}/2`)
    if (!countOf(bot, 'book') && !(countOf(bot, 'leather') && (countOf(bot, 'paper') >= 3 || countOf(bot, 'sugar_cane') >= 3))) miss.push('книга (3 бумаги из тростника + кожа с коровы)')
    lines.push(miss.length ? `⚠ стола нет, не хватает: ${miss.join(', ')}` : '▸ стола нет, но всё на него есть — скрафчу')
  }
  if (shelvesTotal < MAX_SHELVES) {
    const need = MAX_SHELVES - shelvesTotal
    lines.push(`▸ полок ${shelvesTotal}/15: верхняя строка до ${range.top[1]} ур. На ещё ${need}: ${need * 3} книг = ${need * 3} кожи + ${need * 9} тростника, досок ${need * 6}`)
  }
  lines.push(`${lapis >= 3 ? '▸' : '⚠'} лазурит ${lapis} (строка 1/2/3 берёт 1/2/3; руда на y≈0, удача утраивает)`)
  const topCost = shelvesTotal >= MAX_SHELVES ? 30 : range.top[1]
  lines.push(`${level >= topCost ? '▸' : '⚠'} уровни ${level}; до ${topCost} — ещё ${pointsBetween(level, Math.max(level, topCost))} очков. ${XP_WAYS}`)
  for (const t of targets) {
    const want = (Object.entries(WANT[t.kind] || {}) as [string, any][]).sort((a: any, b: any) => b[1].w - a[1].w).slice(0, 3)
    lines.push(`▸ ${t.item.name}: ${want.map(([n, w]: any) => `${n} — ${w.why}`).join('; ')}`)
  }
  lines.push('▸ не трать уровни на: деревянное/каменное/золотое (заменишь), мусор вроде bane_of_arthropods/knockback/thorns — перебрось книгой за 1 ур.')
  return {
    table: table ? xyz(table.position) : null,
    shelves: power.counted,
    shelvesInBag: shelvesBag || undefined,
    level,
    lapis,
    topCost: range.top,
    targets: targets.map(t => ({ item: t.item.name, kind: KIND_RU[t.kind] })),
    lines
  }
}

// ------------------------------------------------------------ вход

// mode: plan — только план; setup — стол и полки; table (по умолчанию) —
// стол+зачарование; anvil — книга на вещь.
async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  const mode = p.mode || 'table'
  if (mode === 'plan') return plan(session, p)
  const lines = []
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })
  if (mode === 'anvil') {
    const r: any = await anvilRun(session, ctl, p, lines)
    if (lines.length) r.lines = lines
    return r
  }

  const { table, report } = await setupTable(session, ctl, { shelves: p.shelves ?? MAX_SHELVES, lines })
  if (mode === 'setup') return { ...report, level: levelOf(bot), lapis: lapisOf(bot), lines: lines.length ? lines : undefined }

  if (!lapisOf(bot)) throw new Error('нет лазурита — копай на y от -32 до 32, лучше около 0 (стол стоит, полок ' + report.shelves + ')')
  if (levelOf(bot) < 1) throw new Error(`нет уровней опыта. ${XP_WAYS}`)

  let targets
  if (p.item) {
    const look = () => bot.inventory.items().find(i => i.name === p.item && !enchantsOf(bot, i).length) ||
      [5, 6, 7, 8].map(s => bot.inventory.slots[s]).find(i => i && i.name === p.item && !enchantsOf(bot, i).length)
    let it = look()
    // Рюкзак мог разойтись с сервером после чужого окна (invsync) — сверить раз.
    if (!it) { try { (require('./invsync') as typeof import('./invsync')).resync(bot) } catch {} await sleep(700); it = look() }
    if (!it) throw new Error(`нет незачарованного ${p.item}`)
    if (!kindOf(it.name)) throw new Error(`${p.item} в стол не кладётся (щит, элитры, ножницы — только наковальней)`)
    targets = [{ item: it, kind: kindOf(it.name) }]
  } else {
    targets = chooseTargets(bot, { goal: p.goal || 'default', count: Math.max(1, Math.min(6, p.count || 1)) })
    if (!targets.length) throw new Error('нечего зачаровывать: нет незачарованного оружия/брони/инструмента не хуже камня')
  }

  await approachTable(bot, table)
  const results = []
  for (const t of targets) {
    if (ctl.aborted) break
    if (!lapisOf(bot) || levelOf(bot) < 1) break
    try {
      const r = await enchantOne(session, ctl, table, t, { rerolls: p.rerolls ?? 3, patient: p.now !== true, lines })
      results.push(r)
    } catch (e) {
      results.push({ item: t.item.name, error: e.message })
    }
  }
  for (const r of results) {
    if (r.got) lines.push(`▸ ${r.item}: ${fmtEnch(r.got)} за ${r.spentLevels} ур. (строка ${r.slot}, цена ${r.cost}) — ${r.why[0]}`)
    else if (r.skipped) lines.push(`⚠ ${r.item}: ${r.skipped}`)
    else if (r.error) lines.push(`⚠ ${r.item}: ${r.error}`)
  }
  const done = results.filter(r => r.got)
  const out: any = {
    ...report,
    enchanted: results,
    level: levelOf(bot),
    lapis: lapisOf(bot),
    lines
  }
  const skipped = results.find(r => r.need)
  if (skipped) out.need = skipped.need
  if (!done.length && results.length) out.stopped = results[0].skipped || results[0].error
  return out
}

export {
  run, plan, shelfPower, shelfCells, costRange, enchantsOf, kindOf, worthFor, rankOffers,
  chooseTargets, anvilEstimate, conflicts, pointsBetween, xpForNext, ENCH, WANT, XP_WAYS
}
