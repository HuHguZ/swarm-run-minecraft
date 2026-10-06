export interface ConversionRecipe {
  id: string
  mechanism: string
  executable: boolean
  ingredients: string[][]
  result: { item: string; count: number }
  table: boolean
  ticks?: number
}
export interface ConversionTool { item: string; enchantments?: Record<string, number>; durabilityLeft?: number }
export interface GuaranteedDrop { item: string; count: number }
interface VanillaData {
  version: string
  jarSha256: string
  recipes: Record<string, unknown>
  blockLoot: Record<string, unknown>
  itemTags: Record<string, unknown>
}
const data = require('../../data/conversions-1.21.11.json') as VanillaData
export const conversionProvenance = { version: data.version, jarSha256: data.jarSha256 }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const name = (value: string) => value.replace(/^minecraft:/, '')
const tags = new Map<string, string[]>()
export function ingredientItems(value: unknown, visited = new Set<string>()): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(v => ingredientItems(v, visited)))]
  if (typeof value !== 'string') { const item = object(value); return ingredientItems(item.item ?? (item.tag ? '#' + item.tag : item.items), visited) }
  if (!value.startsWith('#')) return [name(value)]
  const key = name(value.slice(1))
  if (tags.has(key)) return tags.get(key)!
  if (visited.has(key)) return []
  const next = new Set(visited).add(key)
  const entries = list(object(data.itemTags[key]).values)
  const resolved = [...new Set(entries.flatMap(entry => ingredientItems(typeof entry === 'string' ? entry : object(entry).id, next)))]
  tags.set(key, resolved)
  return resolved
}
export const conversionRecipes: ConversionRecipe[] = Object.entries(data.recipes).flatMap(([id, value]) => {
  const recipe = object(value)
  const mechanism = typeof recipe.type === 'string' ? name(recipe.type) : 'unknown'
  const result = object(recipe.result)
  const output = typeof result.id === 'string' ? name(result.id) : null
  if (!output) return []
  let ingredients: string[][] = []
  let table = false
  if (mechanism === 'crafting_shaped') {
    const pattern = list(recipe.pattern).filter((row): row is string => typeof row === 'string')
    const key = object(recipe.key)
    ingredients = pattern.flatMap(row => [...row].filter(c => c !== ' ').map(c => ingredientItems(key[c])))
    table = pattern.length > 2 || pattern.some(row => row.length > 2)
  } else if (mechanism === 'crafting_shapeless') {
    ingredients = list(recipe.ingredients).map(v => ingredientItems(v))
    table = ingredients.length > 4
  } else if (recipe.ingredient) ingredients = [ingredientItems(recipe.ingredient)]
  else ingredients = [recipe.template, recipe.base, recipe.addition, recipe.input, recipe.material].filter(Boolean).map(v => ingredientItems(v))
  const executable = ['crafting_shaped', 'crafting_shapeless', 'smelting'].includes(mechanism) && ingredients.length > 0 && ingredients.every(i => i.length > 0)
  return [{ id, mechanism, executable, ingredients, table, result: { item: output, count: typeof result.count === 'number' ? result.count : 1 },
    ...(typeof recipe.cookingtime === 'number' ? { ticks: recipe.cookingtime } : {}) }]
})
export const unsupportedRecipeMechanisms = [...new Set(Object.values(data.recipes).map(recipe => name(String(object(recipe).type))))]
  .filter(type => !['crafting_shaped', 'crafting_shapeless', 'smelting'].includes(type))

export function smeltOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {}
  for (const recipe of conversionRecipes) if (recipe.mechanism === 'smelting') for (const item of recipe.ingredients[0]) outputs[item] = recipe.result.item
  return outputs
}

function condition(value: unknown, tool: ConversionTool | null): boolean | null {
  const c = object(value)
  switch (name(String(c.condition))) {
    case 'survives_explosion': return true
    case 'inverted': { const result = condition(c.term, tool); return result === null ? null : !result }
    case 'any_of': { const values = list(c.terms).map(v => condition(v, tool)); return values.includes(true) ? true : values.includes(null) ? null : false }
    case 'all_of': { const values = list(c.terms).map(v => condition(v, tool)); return values.includes(false) ? false : values.includes(null) ? null : true }
    case 'match_tool': {
      const predicate = object(c.predicate)
      if (predicate.items && (!tool || !ingredientItems(predicate.items).includes(tool.item))) return false
      const components = object(predicate.predicates)
      if (Object.keys(components).some(key => key !== 'minecraft:enchantments')) return null
      for (const entry of list(components['minecraft:enchantments'])) {
        const enchantment = object(entry)
        if (typeof enchantment.enchantments !== 'string') return null
        const level = tool?.enchantments?.[name(enchantment.enchantments)] ?? 0
        const levels = object(enchantment.levels)
        if (typeof levels.min === 'number' && level < levels.min) return false
        if (typeof levels.max === 'number' && level > levels.max) return false
      }
      return true
    }
    default: return null
  }
}
function conditions(values: unknown, tool: ConversionTool | null) {
  const tested = list(values).map(c => condition(c, tool))
  return tested.includes(false) ? false : tested.includes(null) ? null : true
}
function functions(values: unknown, initial: number): number | null {
  let count = initial
  for (const value of list(values)) {
    const fn = object(value)
    if (list(fn.conditions).length) return null
    switch (name(String(fn.function))) {
      case 'set_count': {
        const amount = typeof fn.count === 'number' ? fn.count : object(fn.count).value
        if (typeof amount !== 'number') return null
        count = fn.add ? count + amount : amount
        break
      }
      case 'explosion_decay': case 'copy_components': case 'copy_state': break
      default: return null
    }
  }
  return count > 0 && Number.isInteger(count) ? count : null
}
function lootEntry(value: unknown, tool: ConversionTool | null): GuaranteedDrop[] | null {
  const entry = object(value)
  const accepted = conditions(entry.conditions, tool)
  if (accepted === false) return []
  if (accepted === null) return null
  switch (name(String(entry.type))) {
    case 'empty': return []
    case 'item': {
      const count = functions(entry.functions, 1)
      return typeof entry.name === 'string' && count !== null ? [{ item: name(entry.name), count }] : null
    }
    case 'alternatives':
      for (const child of list(entry.children)) { const result = lootEntry(child, tool); if (result === null || result.length) return result }
      return []
    case 'group': {
      const result: GuaranteedDrop[] = []
      for (const child of list(entry.children)) { const drops = lootEntry(child, tool); if (drops === null) return null; result.push(...drops) }
      return result
    }
    default: return null
  }
}
export function guaranteedDrops(block: string, tool: ConversionTool | null): GuaranteedDrop[] | null {
  const table = object(data.blockLoot[block])
  if (!Object.keys(table).length || conditions(table.conditions, tool) !== true) return null
  const result: GuaranteedDrop[] = []
  for (const value of list(table.pools)) {
    const pool = object(value)
    if (conditions(pool.conditions, tool) !== true || pool.rolls !== 1 || list(pool.entries).length !== 1) return null
    const entries = lootEntry(list(pool.entries)[0], tool)
    if (entries === null) return null
    for (const entry of entries) { const count = functions(pool.functions, entry.count); if (count === null) return null; result.push({ ...entry, count }) }
  }
  return result
}
export const lootBlockNames = Object.keys(data.blockLoot)
