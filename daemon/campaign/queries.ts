'use strict'
// Чистые чтения состояния: рюкзак, высота, мир, время суток, запасы.
import { state, sit, known } from './state'
function bag () {
  const inv = state.inventory || {}
  return Object.entries(inv).map(([k, v]) => `${k}×${v}`).join(' ') || 'пусто'
}
const have = (re) => {
  const inv = state.inventory || {}
  let n: any = 0
  for (const [k, v] of Object.entries(inv)) if (typeof re === 'string' ? k === re : re.test(k)) n += v
  return n
}
const y = () => (state.pos ? state.pos.y : 64)
const dim = () => state.dimension || 'overworld'

const LOGS = /_(log|stem)$/
const COBBLE = /^(cobblestone|cobbled_deepslate|blackstone)$/
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const FOOD = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
const { foodUnits: unitsOfFood, foodPoints: pointsOfFood } = require('../src/play-policy')
const foodUnits = () => unitsOfFood(state.inventory)
// Запас на Ад — по сытости, а не по числу штук: жареная свинина 8, а порция — 6 (kd2-7-102 16.10: портал горит на 3-й мин,
// 5 свиных котлет = 40 сытости, «еды 5 из 6» — охота за 90 бл. и 25 мин без входа). ND_NETHER_FOOD_POINTS=0 — прежний счёт штук.
const netherFoodHave = () => process.env.ND_NETHER_FOOD_POINTS === '0' ? foodUnits() : Math.max(foodUnits(), Math.round(pointsOfFood(state.inventory) / 6 * 100) / 100)
const PICK_STONE = /^(stone|iron|diamond|netherite)_pickaxe$/
const PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/
const PICK_DIAMOND = /^(diamond|netherite)_pickaxe$/

function planksFor () {
  const inv = state.inventory || {}
  const log = Object.keys(inv).find(k => LOGS.test(k) && !/^stripped_/.test(k)) || Object.keys(inv).find(k => LOGS.test(k))
  if (!log) return null
  return log.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')
}
const portalFar = () => (known.portal && state.pos && dim() === 'overworld') ? Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) : 0
const fillersNow = () => have(/^(netherrack|dirt|basalt|blackstone|stone|andesite|diorite|granite|tuff|cobbled_deepslate|cobblestone|deepslate|polished_blackstone_bricks|cracked_polished_blackstone_bricks|polished_blackstone|end_stone|mossy_cobblestone|soul_soil|warped_wart_block|nether_wart_block|soul_sand)$/)
const nearBastion = (p, r = 100) => !!p && (known.bastions || []).some(b => Math.hypot(b.x - p.x, b.z - p.z) < r)

const woodNow = () => have(LOGS) + Math.floor(have(/_planks$/) / 4)

const portalBuckets = () => process.env.ND_ROUTE_ONE === '0' ? 2 : 1
const ARMOR_POINTS: any = { iron_chestplate: 6, iron_leggings: 5, iron_helmet: 2, iron_boots: 2,
  golden_chestplate: 5, golden_leggings: 3, golden_helmet: 2, golden_boots: 1,
  diamond_chestplate: 8, diamond_leggings: 6, diamond_helmet: 3, diamond_boots: 3,
  leather_chestplate: 3, leather_leggings: 2, leather_helmet: 1, leather_boots: 1,
  chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_helmet: 2, chainmail_boots: 1 }
function armorPointsNow () {
  let n = 0
  for (const v of Object.values(state.armor || {})) if (v) n += ARMOR_POINTS[String(v).replace(/^minecraft:/, '')] || 0
  return n
}
const fillerCount = () => have(/^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt|sandstone|red_sandstone)$/)
const todNow = () => (Number.isFinite(sit.tod) ? sit.tod : null)
const nightNow = () => { const t = todNow(); return t === null ? !!sit.night : (t >= 12542 && t <= 23459) }

const rodsNow = () => have('blaze_rod') + Math.floor(have('blaze_powder') / 2) + Math.floor(have('ender_eye') / 2)
const goldOn = () => /golden_(helmet|chestplate|leggings|boots)/.test(JSON.stringify(state.armor || {}))
const shieldOn = () => have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
const shieldLow = () => { const o = state.offHand; return !!o && /shield/.test(o.item || '') && (o.durability ?? 100) < 35 }
const spawnAtPortal = () => !!(known.spawnBed && known.portal && Math.hypot(known.spawnBed.x - known.portal.x, known.spawnBed.z - known.portal.z) <= 48)
const lighter = () => have('flint_and_steel') > 0 || have('fire_charge') > 0

const fireResNow = () => { const p = state.potions || {}; return Object.entries(p).filter(([k]) => /fire_resistance$/.test(k)).reduce((n: any, [, v]) => n + v, 0) }
const fireResReady = () => fireResNow() > 0 || state.fireResistance === true || state.tactics?.state?.fireResistance === true
const pearlsNow = () => have('ender_pearl') + have('ender_eye')
const arrowsNow = () => have('arrow') + have('spectral_arrow')

export { bag, have, y, dim, LOGS, COBBLE, RAW, FOOD, foodUnits, netherFoodHave, PICK_STONE, PICK_IRON, PICK_DIAMOND,
  planksFor, portalFar, fillersNow, nearBastion, woodNow, portalBuckets, ARMOR_POINTS, armorPointsNow, fillerCount,
  todNow, nightNow, rodsNow, goldOn, shieldOn, shieldLow, spawnAtPortal, lighter, fireResNow, fireResReady, pearlsNow,
  arrowsNow }
