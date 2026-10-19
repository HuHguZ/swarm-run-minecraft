'use strict'
// Правила боя (pvp.ts): дальности, тайминги, перезарядка удара, профили мобов, кто враг.

const TICK_MS = 50
const HIT_REACH = 2.9
const THEIR_REACH = 3.4
const FAR = 7
const EYE = 1.62
const COVER_MS = 500
const COVER_WIDE_MS = 1500
const REACH_MARGIN = 0.7
const CRIT_ANY_RISE = process.env.ND_CRIT_ANY_RISE !== '0'
const FIX = process.env.ND_FIGHTFIX !== '0'
const BOX_MS = 2500
const BOX_FRONT_MS = 1300
const PILLAR_MS = 400
function ticksToFall (vy) {
  let n = 1
  let v = vy
  while (v >= -1e-3 && n < 30) { v = (v - 0.08) * 0.98; n++ }
  return n
}

const LAG_MS = 50
function cooldownMs (item) {
  return baseCooldownMs(item) + LAG_MS
}
function baseCooldownMs (item) {
  if (!item) return 500
  const n = item.name
  if (/_sword$/.test(n)) return 625 // 1.6
  if (/^(wooden|stone)_axe$/.test(n)) return 1250 // 0.8
  if (n === 'iron_axe') return 1111 // 0.9
  if (/_axe$/.test(n)) return 1000 // золото, алмаз, незерит: 1.0
  if (/_pickaxe$/.test(n)) return 833 // 1.2
  if (/_shovel$/.test(n)) return 1000
  if (n === 'wooden_hoe' || n === 'golden_hoe') return 1000
  if (n === 'stone_hoe') return 500
  if (n === 'iron_hoe') return 333
  if (/_hoe$/.test(n)) return 500
  if (n === 'trident') return 909
  if (n === 'mace') return 1667
  return 500
}

const EDIBLE = /apple|beef|pork|chicken|mutton|rabbit|cod|salmon|bread|potato|carrot|stew|soup|cookie|melon|berries|pie|potion|honey|kelp|chorus/

const UNDEAD = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
  'wither_skeleton', 'zombified_piglin', 'zoglin', 'phantom', 'skeleton_horse', 'zombie_horse', 'wither'])
const FIRE_IMMUNE = new Set(['blaze', 'magma_cube', 'wither_skeleton', 'ghast', 'strider', 'zombified_piglin',
  'zoglin', 'hoglin', 'piglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon'])
const WEB_IMMUNE = new Set(['spider', 'cave_spider'])
const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'drowned',
  'breeze', 'shulker', 'evoker', 'guardian', 'elder_guardian', 'piglin'])
const MOB_REACH = {
  zombie: 2.2, husk: 2.2, drowned: 2.2, zombie_villager: 2.2, zombified_piglin: 2.2,
  skeleton: 2.2, stray: 2.2, bogged: 2.2, wither_skeleton: 2.6,
  spider: 2.6, cave_spider: 2.0, enderman: 2.8, vindicator: 2.4, piglin_brute: 2.4,
  hoglin: 2.8, zoglin: 2.8, ravager: 3.4, iron_golem: 3.2, slime: 2.6, magma_cube: 2.6,
  silverfish: 1.6, endermite: 1.6, witch: 2.0, creeper: 3.2
}

function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }

function profileOf (e) {
  if (isPlayer(e)) return { player: true, theirReach: THEIR_REACH }
  const n = e.name
  return {
    player: false,
    theirReach: MOB_REACH[n] ?? 2.4,
    undead: UNDEAD.has(n),
    fireImmune: FIRE_IMMUNE.has(n),
    webImmune: WEB_IMMUNE.has(n),
    ranged: RANGED_MOBS.has(n),
    creeper: n === 'creeper',
    flying: FLYERS.has(n)
  }
}
const FLYERS = new Set(['ghast', 'phantom', 'vex', 'blaze', 'allay', 'bee', 'wither', 'ender_dragon'])

const FOES = new Set([...Object.keys(MOB_REACH), 'blaze', 'ghast', 'pillager', 'evoker', 'vex', 'breeze',
  'guardian', 'phantom', 'warden', 'shulker', 'piglin', 'creaking'])

const HOSTILE_MOB = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|wither_skeleton|spider|cave_spider|creeper|witch|slime|magma_cube|silverfish|endermite|phantom|pillager|vindicator|evoker|vex|ravager|piglin_brute|hoglin|zoglin|blaze|breeze|guardian|shulker)$/
const ANGRY_IF_HIT = /^(enderman|zombified_piglin|piglin|polar_bear|wolf|bee)$/

export {
  TICK_MS, HIT_REACH, THEIR_REACH, FAR, EYE, COVER_MS, COVER_WIDE_MS, REACH_MARGIN, CRIT_ANY_RISE, FIX, BOX_MS, BOX_FRONT_MS, PILLAR_MS, ticksToFall, LAG_MS, cooldownMs, baseCooldownMs, EDIBLE, UNDEAD, FIRE_IMMUNE, WEB_IMMUNE, RANGED_MOBS, MOB_REACH, isPlayer, profileOf, FLYERS, FOES, HOSTILE_MOB, ANGRY_IF_HIT
}
