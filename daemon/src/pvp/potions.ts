'use strict'
// Зелья и предметы (pvp.ts): какое зелье по содержимому, его роль, поиск и остатки после боя.

// Порядок реестра зелий 1.21 (Potions.java регистрирует их в этом порядке, а
const POTIONS = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision',
  'invisibility', 'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness',
  'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing',
  'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming',
  'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration',
  'strong_regeneration', 'strength', 'long_strength', 'strong_strength',
  'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested'
]

function potionOf (item) {
  if (!item || !/potion$/.test(item.name)) return null
  const c = item.componentMap && item.componentMap.get('potion_contents')
  const d = c && c.data
  if (!d) return null
  const raw = d.potionId ?? d.potion ?? d.id
  if (typeof raw === 'number') return POTIONS[raw] || null
  if (typeof raw === 'string') return raw.replace(/^minecraft:/, '')
  const s = JSON.stringify(d)
  const hit = POTIONS.slice().sort((a, b) => b.length - a.length).find(p => s.includes(p))
  return hit || null
}

function potionRole (name) {
  if (!name) return null
  const base = name.replace(/^(long|strong)_/, '')
  if (base === 'healing') return 'heal'
  if (base === 'regeneration') return 'regen'
  if (['strength', 'swiftness', 'fire_resistance', 'turtle_master', 'invisibility'].includes(base)) return 'buff'
  if (['harming', 'poison', 'slowness', 'weakness'].includes(base)) return 'debuff'
  return null
}

function findItem (bot, test) {
  return bot.inventory.items().find(test) || null
}

function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}

function findPotion (bot, kind, role) {
  return findItem(bot, i => i.name === kind && potionRole(potionOf(i)) === role)
}

function leftovers (bot) {
  const out = {}
  for (const i of bot.inventory.items()) {
    let key = null
    if (/golden_apple$/.test(i.name)) key = i.name
    else if (i.name === 'ender_pearl' || i.name === 'totem_of_undying' || i.name === 'cobweb' || /arrow$/.test(i.name)) key = i.name
    else if (/potion$/.test(i.name)) key = `${i.name}:${potionOf(i) || '?'}`
    if (key) out[key] = (out[key] || 0) + i.count
  }
  return Object.keys(out).length ? out : undefined
}

export { POTIONS, potionOf, potionRole, findItem, countOf, findPotion, leftovers }
