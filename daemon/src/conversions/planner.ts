import { conversionRecipes, guaranteedDrops, lootBlockNames, unsupportedRecipeMechanisms, type ConversionTool } from './registry'

export interface ConversionStep {
  id: string
  mechanism: 'craft' | 'smelt' | 'place-dig'
  inputs: Record<string, number>
  output: { item: string; count: number }
  times: number
  tool?: string
  block?: string
  fuel?: string
  station?: 'furnace'
}
export interface ConversionOptions {
  table?: boolean
  furnace?: boolean
  tools?: ConversionTool[]
  harvestTools?: Record<string, string[]>
  fuels?: { item: string; items: number; spare: number }[]
  maxDepth?: number
  maxBranches?: number
  maxSteps?: number
}
export interface ConversionPlan {
  ok: boolean
  steps: ConversionStep[]
  inventory: Record<string, number>
  missing: string[]
  unsupported: string[]
  expanded: number
}
interface State { inventory: Record<string, number>; steps: ConversionStep[]; table: boolean; furnace: boolean; cost: number }
const copy = (s: State): State => ({ ...s, inventory: { ...s.inventory }, steps: [...s.steps] })
const recipes = new Map<string, typeof conversionRecipes>()
for (const recipe of conversionRecipes) { const list = recipes.get(recipe.result.item) ?? []; list.push(recipe); recipes.set(recipe.result.item, list) }

export function planConversion(inventory: Record<string, number>, item: string, count = 1, options: ConversionOptions = {}): ConversionPlan {
  const missing = new Set<string>()
  const unsupported = new Set<string>()
  let expanded = 0
  const maxBranches = options.maxBranches ?? 600
  const maxDepth = options.maxDepth ?? 12
  const maxSteps = options.maxSteps ?? 64
  const toolFacts = new Map((options.tools ?? []).map(tool => [tool.item, tool]))
  const dropIndex = new Map<string, { block: string; tool: string | null; count: number }[]>()
  for (const block of lootBlockNames) {
    if (!options.harvestTools || !(block in options.harvestTools)) continue
    const allowed = options.harvestTools?.[block]
    const tools: (string | null)[] = allowed?.length ? allowed : [null, ...toolFacts.keys()]
    for (const tool of tools) {
      const drops = guaranteedDrops(block, tool ? toolFacts.get(tool) ?? { item: tool } : null)
      if (!drops) continue
      for (const drop of drops) if (drop.item !== block) {
        const edges = dropIndex.get(drop.item) ?? []
        edges.push({ block, tool, count: drop.count })
        dropIndex.set(drop.item, edges)
      }
    }
  }
  const initial: State = { inventory: { ...inventory }, steps: [], table: !!options.table || (inventory.crafting_table ?? 0) > 0,
    furnace: !!options.furnace, cost: 0 }
  const nearSupply = (candidate: string, state: State) => (state.inventory[candidate] ?? 0) > 0 ? 100 :
    (recipes.get(candidate) ?? []).some(r => r.executable && r.ingredients.every(group => group.some(n => (state.inventory[n] ?? 0) > 0))) ? 10 : 0
  const satisfy = (target: string, want: number, state: State, visited: Set<string>, depth: number): State | null => {
    if ((state.inventory[target] ?? 0) >= want) return state
    if (depth > maxDepth || visited.has(target) || state.steps.length >= maxSteps || expanded >= maxBranches) return null
    const next = new Set(visited).add(target)
    let best: State | null = null
    const accept = (candidate: State) => { if (candidate.steps.length <= maxSteps && (!best || candidate.cost < best.cost)) best = candidate }
    const alternatives = (recipes.get(target) ?? []).slice().sort((a, b) =>
      b.ingredients.reduce((sum, group) => sum + Math.max(...group.map(i => nearSupply(i, state))), 0) -
      a.ingredients.reduce((sum, group) => sum + Math.max(...group.map(i => nearSupply(i, state))), 0))
    for (const recipe of alternatives) {
      if (!recipe.executable) { unsupported.add(recipe.mechanism); continue }
      if (expanded >= maxBranches) break
      expanded++
      let candidate = copy(state)
      let station: 'furnace' | undefined
      const times = Math.ceil((want - (candidate.inventory[target] ?? 0)) / recipe.result.count)
      if (recipe.table && !candidate.table) {
        const table = satisfy('crafting_table', 1, candidate, next, depth + 1)
        if (!table) continue
        candidate = table; candidate.table = true
      }
      if (recipe.mechanism === 'smelting' && !candidate.furnace) {
        const furnace = satisfy('furnace', 1, candidate, next, depth + 1)
        if (!furnace) continue
        candidate = furnace; candidate.furnace = true
        candidate.inventory.furnace--
        station = 'furnace'
      }
      const inputs: Record<string, number> = {}
      const grouped = new Map<string, { options: string[]; count: number }>()
      for (const group of recipe.ingredients) { const key = group.join('|'); const current = grouped.get(key) ?? { options: group, count: 0 }; current.count += times; grouped.set(key, current) }
      let ready = true
      for (const group of grouped.values()) {
        let selected: State | null = null
        let selectedItem = ''
        const names = [...group.options].sort((a, b) => nearSupply(b, candidate) - nearSupply(a, candidate))
        for (const name of names) {
          const current = satisfy(name, group.count, copy(candidate), next, depth + 1)
          if (current && (!selected || current.cost < selected.cost)) { selected = current; selectedItem = name }
          if (selected && (candidate.inventory[name] ?? 0) >= group.count) break
        }
        if (!selected) { ready = false; break }
        candidate = selected
        candidate.inventory[selectedItem] -= group.count
        inputs[selectedItem] = (inputs[selectedItem] ?? 0) + group.count
      }
      if (!ready) continue
      let fuel: string | undefined
      if (recipe.mechanism === 'smelting') {
        const chosen = (options.fuels ?? []).find(f => Math.min(candidate.inventory[f.item] ?? 0, f.spare) * f.items >= times)
        if (!chosen) { missing.add('fuel'); continue }
        const units = Math.ceil(times / chosen.items)
        candidate.inventory[chosen.item] -= units
        inputs[chosen.item] = (inputs[chosen.item] ?? 0) + units
        fuel = chosen.item
      }
      const produced = times * recipe.result.count
      candidate.inventory[target] = (candidate.inventory[target] ?? 0) + produced
      candidate.steps.push({ id: recipe.id, mechanism: recipe.mechanism === 'smelting' ? 'smelt' : 'craft', inputs,
        output: { item: target, count: produced }, times, ...(fuel ? { fuel } : {}), ...(station ? { station } : {}) })
      candidate.cost += recipe.mechanism === 'smelting' ? times * (recipe.ticks ?? 200) / 20 : times
      accept(candidate)
      if (best && best.cost <= state.cost + 1) break
    }
    const drops = (dropIndex.get(target) ?? []).slice().sort((a, b) =>
      Number(!b.tool || (state.inventory[b.tool] ?? 0) > 0) - Number(!a.tool || (state.inventory[a.tool] ?? 0) > 0))
    for (const edge of drops) {
      if (expanded >= maxBranches) break
      expanded++
      if (!state.inventory[edge.block] && !(recipes.get(edge.block) ?? []).some(r => r.executable)) continue
      let candidate = copy(state)
      const times = Math.ceil((want - (candidate.inventory[target] ?? 0)) / edge.count)
      if (edge.tool && (toolFacts.get(edge.tool)?.durabilityLeft ?? Infinity) < times) continue
      const blocks = satisfy(edge.block, times, candidate, next, depth + 1)
      if (!blocks) continue
      candidate = blocks
      if (edge.tool && !(candidate.inventory[edge.tool] > 0)) {
        const tool = satisfy(edge.tool, 1, candidate, next, depth + 1)
        if (!tool) continue
        candidate = tool
      }
      candidate.inventory[edge.block] -= times
      const produced = times * edge.count
      candidate.inventory[target] = (candidate.inventory[target] ?? 0) + produced
      candidate.steps.push({ id: `blocks/${edge.block}`, mechanism: 'place-dig', block: edge.block, inputs: { [edge.block]: times },
        output: { item: target, count: produced }, times, ...(edge.tool ? { tool: edge.tool } : {}) })
      candidate.cost += times * 3
      accept(candidate)
      if ((state.inventory[edge.block] ?? 0) >= times && (!edge.tool || (state.inventory[edge.tool] ?? 0) > 0)) break
    }
    if (!best) missing.add(target)
    return best
  }
  const goal = (inventory[item] ?? 0) + Math.max(1, Math.min(1024, Math.floor(count)))
  const result = satisfy(item, goal, initial, new Set(), 0)
  return { ok: !!result, steps: result?.steps ?? [], inventory: result?.inventory ?? { ...inventory }, missing: result ? [] : [...missing],
    unsupported: result ? [] : [...unsupported], expanded }
}

export const conversionCapabilities = { executable: ['crafting_shaped', 'crafting_shapeless', 'smelting', 'guaranteed_block_drop'],
  unsupported: unsupportedRecipeMechanisms, bounded: { depth: 12, branches: 600, steps: 64 } }
