'use strict'
import { GROUPS, countOf } from '../items'

// ---------------------------------------------------------------- tables

const SMELTS = (require('../conversions/registry') as typeof import('../conversions/registry')).smeltOutputs()

// Any log burns down to charcoal, and there are 45 log-shaped item names on
// 1.21.11 — a regex beats 45 more table rows. Nether wood is the exception:
// crimson and warped do not burn at all, neither into charcoal nor as fuel.
const WOOD = /_log$|_wood$|_stem$|_hyphae$/
const isFirewood = name => WOOD.test(name) && !/crimson|warped/.test(name)

const smeltOutput = name => SMELTS[name] || (isFirewood(name) ? 'charcoal' : null)

// A blast furnace only accepts ore and raw metal, a smoker only meat and
// vegetables; both cook twice as fast. A plain furnace accepts everything,
// which is why it is the fallback and the only thing we ever build ourselves.
const ORE_LIKE = /_ore$|^raw_(iron|gold|copper)$|^ancient_debris$/
const FOOD_LIKE = /^(porkchop|beef|chicken|mutton|rabbit|cod|salmon|potato)$/
const KINDS = {
  furnace: { ms: 10000, takes: () => true },
  blast_furnace: { ms: 5000, takes: n => ORE_LIKE.test(n) },
  smoker: { ms: 5000, takes: n => FOOD_LIKE.test(n) }
}

// Items smelted per unit of fuel, ordered the way a player reaches into the
// bag rather than by raw burn value: coal is dug for exactly this job, planks
// and logs are the wood the tools are made of, a blaze rod is brewing stock.
// `keep` is the reserve we refuse to burn, so smelting can never eat the last
// of a crafting material — and nothing here is a tool, a bed or armour.
const FUELS = [
  { name: 'coal', items: 8 },
  { name: 'charcoal', items: 8 },
  { name: 'coal_block', items: 80 },
  { name: 'dried_kelp_block', items: 20 },
  { group: 'any_planks', items: 1.5, keep: 24 },
  { group: 'any_wood', items: 1.5, keep: 8 },
  { name: 'stick', items: 0.5, keep: 16 },
  { name: 'bamboo', items: 0.25 },
  { name: 'blaze_rod', items: 12, keep: 2 },
  // 100 items per bucket and we still never reach for it unasked: the empty
  // bucket stays behind in the fuel slot and jams the next load.
  { name: 'lava_bucket', items: 100, onlyIfAsked: true }
]

// ---------------------------------------------------------------- smelt

// The brain says "iron_ingot" about as often as "raw_iron", so accept both ends
// of the recipe. Naming the output picks whichever input we are actually
// carrying the most of, which is what a player would grab.
function resolveSmelt (bot, want) {
  const asked = String(want || '').trim()
  if (!asked) throw new Error('не сказано, что плавить')

  const direct = smeltOutput(asked)
  // "stone" is both an input and an output. Reading it as an input first is
  // right when the bag holds stone, but "выплавь stone" from someone carrying
  // cobblestone means the recipe, not smooth_stone.
  if (direct && countOf(bot, asked)) return { from: asked, into: direct }

  const inputs = [...new Set(Object.keys(SMELTS).filter(k => SMELTS[k] === asked))]
  if (asked === 'charcoal') {
    for (const i of bot.inventory.items()) if (isFirewood(i.name) && !inputs.includes(i.name)) inputs.push(i.name)
  }
  if (!inputs.length) {
    if (direct) return { from: asked, into: direct }
    // Charcoal is a recipe we know perfectly well; what is missing is the wood.
    if (asked === 'charcoal') throw new Error('нет брёвен на уголь (адское дерево не горит)')
    throw new Error(`не знаю, как выплавить ${asked}`)
  }

  inputs.sort((a, b) => countOf(bot, b) - countOf(bot, a))
  if (!countOf(bot, inputs[0])) {
    throw new Error(`не из чего плавить ${asked}: нужен ${inputs.slice(0, 3).join(' или ')}`)
  }
  return { from: inputs[0], into: asked }
}

// How much of one fuel we are willing to burn, and which exact item name it is
// (the biggest pile — one fuel slot holds one kind, so burn the spruce planks
// rather than the single cherry one).
function fuelOption (bot, entry) {
  let names = []
  if (entry.name) {
    if (countOf(bot, entry.name)) names = [entry.name]
  } else {
    const re = GROUPS[entry.group]
    const piles = {}
    for (const i of bot.inventory.items()) {
      if (!re.test(i.name)) continue
      if (entry.group === 'any_wood' && !isFirewood(i.name)) continue
      piles[i.name] = (piles[i.name] || 0) + i.count
    }
    names = Object.keys(piles).sort((a, b) => piles[b] - piles[a])
  }
  if (!names.length) return null

  const total = names.reduce((n, name) => n + countOf(bot, name), 0)
  const spare = Math.min(total - (entry.keep || 0), countOf(bot, names[0]))
  if (spare < 1 || Math.floor(spare * entry.items) < 1) return null
  return { name: names[0], items: entry.items, spare }
}

function pickFuel (bot, need, asked) {
  if (asked) {
    // A group alias is the same vocabulary mine() and chestPut() take, so it
    // has to work here too — with the reserve dropped, which is the whole
    // point of naming the fuel by hand.
    const byGroup = FUELS.find(f => f.group === asked)
    if (byGroup) {
      const option = fuelOption(bot, { group: byGroup.group, items: byGroup.items })
      if (!option) throw new Error(`нет ${asked} в инвентаре`)
      return option
    }
    const entry = FUELS.find(f => f.name === asked) ||
      FUELS.find(f => f.group && GROUPS[f.group].test(asked))
    if (!entry) throw new Error(`не знаю, сколько горит ${asked}`)
    // Crimson and warped are wood-shaped and burn in nothing. Loading them
    // leaves a furnace that never lights, which reads as "печка погасла" ten
    // seconds later instead of as the flat refusal it is.
    if (entry.group === 'any_wood' && !isFirewood(asked)) throw new Error(`${asked} не горит`)
    const have = countOf(bot, asked)
    if (!have) throw new Error(`нет ${asked} в инвентаре`)
    return { name: asked, items: entry.items, spare: have }
  }

  const options = FUELS.filter(f => !f.onlyIfAsked).map(f => fuelOption(bot, f)).filter(Boolean)
  if (!options.length) return null
  for (const o of options) if (o.spare >= Math.ceil(need / o.items)) return o
  // Nothing covers the whole batch. Burn whatever yields the most and report a
  // short run — three ingots out of eight still beat refusing to start.
  return options.reduce((a, b) => (b.spare * b.items > a.spare * a.items ? b : a))
}

const conversionFuels = bot => FUELS.filter(f => !f.onlyIfAsked).map(f => fuelOption(bot, f)).filter(Boolean).map(f => ({ item: f.name, items: f.items, spare: f.spare }))

export { KINDS, resolveSmelt, pickFuel, conversionFuels }
