'use strict'
import * as pack from '../pack'
import { count } from './common'

// ------------------------------------------------------------------ ценность

// Что брать из сундука и зачем — для победы в игре, а не «всё подряд».
const WANT = [
  [/^enchanted_golden_apple$/, 10, 'зачарованное золотое яблоко: сопротивление и поглощение — переживёт дракона'],
  [/^golden_apple$/, 9, 'золотое яблоко: реген и поглощение — спасает в бою и в лаве'],
  [/^totem_of_undying$/, 10, 'тотем: одна смерть отменяется'],
  [/^(diamond|diamond_block)$/, 9, 'алмазы: кирка на обсидиан, меч, броня'],
  [/^obsidian$/, 9, 'обсидиан: рамка портала в Ад (10 штук)'],
  [/^(flint_and_steel|fire_charge)$/, 9, 'зажечь портал в Ад'],
  [/^(ender_pearl|ender_eye)$/, 9, 'жемчуг: глаза Края — найти крепость и портал'],
  [/^(blaze_rod|blaze_powder)$/, 9, 'огненный порошок: глаза Края'],
  [/^elytra$/, 9, 'элитры'],
  [/^(bucket|water_bucket|lava_bucket)$/, 8, 'ведро: вода от падения и лавы, обсидиан из лавы'],
  [/^enchanted_book$/, 8, 'книга с чарами: на наковальне — защита, острота, эффективность'],
  [/^(iron_ingot|iron_block|raw_iron|iron_nugget)$/, 8, 'железо: ведро, щит, броня, кирка'],
  [/^(gold_ingot|gold_block|raw_gold|gold_nugget)$/, 7, 'золото: бартер с пиглинами (жемчуг), золотой шлем от пиглинов'],
  [/^(netherite_ingot|netherite_scrap|ancient_debris|netherite_upgrade_smithing_template)$/, 7, 'незерит — лучшая броня'],
  [/^(arrow|spectral_arrow|tipped_arrow)$/, 7, 'стрелы: кристаллы Края и дракон'],
  [/^(tnt|gunpowder)$/, 6, 'взрывчатка; порох — фейерверки для элитр'],
  [/^saddle$/, 6, 'седло: лошадь — втрое быстрее по миру'],
  [/^(emerald|emerald_block)$/, 6, 'изумруды: торговля с жителями (стрелы, броня, книги)'],
  [/^experience_bottle$/, 6, 'опыт на зачарование'],
  [/^magma_cream$/, 6, 'огнестойкость: Ад и лава'],
  [/^(golden_carrot|glistering_melon_slice)$/, 6, 'лучшая еда / зелье лечения'],
  [/^lapis_lazuli$/, 5, 'лазурит: стол зачарований'],
  [/^nether_wart$/, 5, 'нарост: основа зелий'],
  [/^(bread|cooked_[a-z_]+|baked_potato|apple|carrot|potato|beetroot|melon_slice|glow_berries|sweet_berries|pumpkin_pie|cookie|dried_kelp|mushroom_stew|beetroot_soup|rabbit_stew|wheat|hay_block|suspicious_stew)$/, 5, 'еда'],
  [/^(coal|charcoal|coal_block)$/, 4, 'уголь: факелы и печь'],
  [/^(crying_obsidian)$/, 3, 'якорь возрождения в Аду (для рамки портала не годится)'],
  [/^(filled_map)$/, 5, 'карта: крестик — клад (железо, TNT, изумруды)'],
  [/^(compass)$/, 3, 'компас'],
  [/^(string)$/, 3, 'нитки: лук, шерсть на кровать'],
  [/^(name_tag)$/, 2, 'бирка — слот дешёвый'],
  [/^(flint|feather)$/, 2, 'стрелы'],
  [/^(redstone|quartz|glowstone_dust|amethyst_shard)$/, 2, 'материал']
]
const LEAVE = /^(rotten_flesh|bone|bone_block|spider_eye|poisonous_potato|[a-z_]*_seeds|sand|red_sand|gravel|paper|book|moss_block|bamboo|pumpkin|music_disc_[a-z0-9_]+|disc_fragment_5|[a-z_]*horse_armor|[a-z_]*nautilus_armor|[a-z_]*_armor_trim_smithing_template|[a-z_]*banner_pattern|lodestone|bell|light_weighted_pressure_plate|clock|candle|sculk[a-z_]*|leather|lead|goat_horn|dark_oak_log|tripwire_hook|iron_chain|chain|echo_shard|soul_torch|resin_clump|bundle|[a-z_]*_sapling|stick|gilded_blackstone|rail|powered_rail|detector_rail|activator_rail|torch|prismarine_crystals|heart_of_the_sea|piglin_banner_pattern|potion)$/

const TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 }
const ARMOR_TIER = { leather: 1, golden: 2, copper: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }

function bestTier (bot, kind) {
  let t = 0
  const all = [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots[s]).filter(Boolean)]
  for (const it of all) {
    const m = it.name.match(/^([a-z]+)_([a-z]+)$/)
    if (!m || m[2] !== kind) continue
    t = Math.max(t, (kind === 'helmet' || kind === 'chestplate' || kind === 'leggings' || kind === 'boots' ? ARMOR_TIER : TIER)[m[1]] || 0)
  }
  return t
}

function enchantsOf (it) {
  try { return (it.enchants || []).map(e => `${e.name}${e.lvl > 1 ? ' ' + e.lvl : ''}`) } catch { return [] }
}

// Решение по одному предмету: { take, prio, why }.
function decide (bot, it, ctx: any = {}) {
  const name = it.name
  const ench = enchantsOf(it)
  // Инструменты, оружие, броня — только если лучше своего (или золото от пиглинов).
  const gear = name.match(/^([a-z]+)_(pickaxe|axe|shovel|sword|spear|helmet|chestplate|leggings|boots|hoe)$/)
  if (gear) {
    const [, mat, kind] = gear
    if (kind === 'hoe') return { take: false, prio: 0, why: 'мотыга не нужна' }
    const armor = ['helmet', 'chestplate', 'leggings', 'boots'].includes(kind)
    const tier = (armor ? ARMOR_TIER : TIER)[mat] || 0
    const have = bestTier(bot, kind === 'spear' ? 'sword' : kind)
    if (armor && mat === 'golden' && !ctx.gold && count(bot, /^golden_(helmet|chestplate|leggings|boots)$/) === 0) {
      ctx.gold = true
      return { take: true, prio: 7, why: `золотая броня${ench.length ? ' с чарами' : ''}: хоть одна часть — и пиглины не нападают (бартер за жемчуг)` }
    }
    if (tier > have) return { take: true, prio: armor ? 8 : 7, why: `${armor ? 'броня' : 'инструмент'} лучше моего (${mat} против ${have ? 'уровня ' + have : 'ничего'})${ench.length ? ', чары: ' + ench.join(', ') : ''}` }
    if (ench.length && tier >= 3) return { take: true, prio: 5, why: `с чарами: ${ench.join(', ')}` }
    return { take: false, prio: 0, why: `не лучше своего (${mat})` }
  }
  if (/^(bow|crossbow|trident|fishing_rod|shield)$/.test(name)) {
    const have = count(bot, name)
    if (!have || ench.length) return { take: true, prio: 7, why: name === 'bow' || name === 'crossbow' ? 'стрельба по кристаллам Края' : name === 'shield' ? 'щит' : 'пригодится' }
    return { take: false, prio: 0, why: 'такой уже есть' }
  }
  for (const [re, prio, why] of (WANT as any)) {
    if (re.test(name)) {
      if (name === 'enchanted_book' && ench.length) return { take: true, prio, why: `${why} (${ench.join(', ')})` }
      return { take: true, prio, why }
    }
  }
  if (LEAVE.test(name)) return { take: false, prio: 0, why: 'хлам для победы' }
  const w = pack.worth(name)
  if (w >= 2) return { take: true, prio: 3, why: 'материал' }
  if (w === 0) return { take: false, prio: 0, why: 'хлам' }
  return { take: bot.inventory.emptySlotCount() > 8, prio: 1, why: 'мелочь — если есть место' }
}

function merge (out, r) {
  for (const [k, v] of (Object.entries(r.took || {}) as [string, any][])) out.took[k] = (out.took[k] || 0) + v
  Object.assign(out.why, r.why || {})
  for (const [k, v] of (Object.entries(r.left || {}) as [string, any][])) out.left[k] = (out.left[k] || 0) + v
}

// Взятое за весь заход к сундуку — по рюкзаку: под водой первый нырок открывает и берёт, сторож воздуха рвёт его, и в итог
// последнего (сундук уже без ценного) это не попадало (ферма 14.10, корабль −1,53,13: железо 6 + 10 самородков и карта в
// рюкзаке, «взял: —»). Только то, что decide берёт (доски с копки — нет).
function bagCounts (bot) {
  const m = {}
  for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count
  return m
}
function bagGain (bot, before) {
  const gain = {}
  for (const [k, n] of (Object.entries(bagCounts(bot)) as [string, number][])) {
    const d = n - (before[k] || 0)
    if (d > 0 && decide(bot, { name: k, count: d }, {}).take) gain[k] = d
  }
  return gain
}
function withGain (bot, before, r) {
  const gain = bagGain(bot, before)
  return Object.keys(gain).length > Object.keys((r && r.took) || {}).length ? { ...r, took: gain } : r
}

export { decide, merge, bagCounts, bagGain, withGain }
