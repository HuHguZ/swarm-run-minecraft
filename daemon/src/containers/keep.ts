'use strict'
import { countItems } from '../items'

// ---------------------------------------------------------------- surplus

// What never goes in the chest, and why. A bot that walks into a mine without
// a pickaxe, a torch and a steak is a bot that dies in it: measured here,
// forty staircase steps cost ~166 pickaxe uses, and the run that reached y=-58
// was doomed by having nothing left to dig with. `Infinity` means "this is
// equipment, not loot".
const KEEP = [
  { re: /_(pickaxe|axe|shovel|sword|hoe)$/, keep: Infinity },
  { re: /_(helmet|chestplate|leggings|boots)$/, keep: Infinity },
  { re: /^(shield|elytra|totem_of_undying|flint_and_steel|clock|compass|map)$/, keep: Infinity },
  // The EMPTY bucket is `bucket`, with no underscore: /_bucket$/ matched
  // water_bucket and lava_bucket and handed the empty one to the chest as loot,
  // which is the one of the three the bot actually carries down a shaft.
  { re: /^bucket$|_bucket$/, keep: Infinity },
  { re: /_bed$/, keep: 1 },
  { re: /^cooked_\w+$/, keep: 16 },
  { re: /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/, keep: 16 },
  { re: /^(bread|apple|golden_apple|enchanted_golden_apple|carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|dried_kelp|pumpkin_pie|cookie|rabbit_stew|mushroom_stew|beetroot_soup|suspicious_stew|honey_bottle)$/, keep: 16 },
  { name: 'torch', keep: 32 },
  { name: 'coal', keep: 16 },
  { name: 'charcoal', keep: 16 },
  { name: 'cobblestone', keep: 64 },
  { name: 'cobbled_deepslate', keep: 64 },
  { name: 'stick', keep: 8 },
  { re: /_planks$/, keep: 16 },
  { name: 'crafting_table', keep: 1 },
  { name: 'furnace', keep: 1 },
  { name: 'chest', keep: 1 },
  // Прохождение: то, без чего дракона не убить, из рюкзака не выкидывается ради
  // места никогда. Раньше keepFor давал им 0, и makeRoom под подобранный меч
  // (worth 9) мог выбросить жемчуг или стержни (worth 3).
  { re: /^(ender_pearl|ender_eye|blaze_rod|blaze_powder|obsidian|gold_ingot|gold_block|gold_nugget|potion|splash_potion|string|white_wool|fire_charge|magma_cream|nether_wart|arrow|spectral_arrow|golden_carrot|book|leather|paper|diamond)$/, keep: Infinity }
]

function keepFor (name, override?) {
  if (override && override[name] !== undefined) return override[name]
  for (const rule of KEEP) {
    if (rule.name ? rule.name === name : rule.re.test(name)) return rule.keep
  }
  return 0
}

// "cobblestone:0, torch:64" — a string, not an object, because that is what a
// tool schema carries without turning into a second-class API.
function parseKeep (text) {
  const out: Record<string, number> = {}
  for (const part of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, n] = part.split(':').map(s => s.trim())
    const k = n === undefined || n === '' ? Infinity : Number(n)
    if (!name || !(k === Infinity || (Number.isFinite(k) && k >= 0))) {
      throw new Error(`не понял keep: ${part} (надо имя:число, например cobblestone:0)`)
    }
    out[name] = k
  }
  return out
}

function surplusPlan (bot, override?) {
  const plan: Record<string, number> = {}
  const kept: Record<string, number> = {}
  for (const [name, have] of ((Object.entries(countItems(bot)) as [string, any][]) as any)) {
    const cap = keepFor(name, override)
    const spare = cap === Infinity ? 0 : Math.max(0, have - cap)
    if (spare > 0) plan[name] = spare
    if (have - spare > 0) kept[name] = have - spare
  }
  return { plan, kept }
}

export { keepFor, parseKeep, surplusPlan }
