export interface NetherSupplyState {
  dimension: string
  health: number
  inventory: Record<string, number>
  pickSwings: number
}
export interface NetherSupplyPort {
  observe(): Promise<NetherSupplyState>
  act(method: string, params: Record<string, unknown>): Promise<void>
  craft(item: string, count: number): Promise<boolean>
  now(): number
  interrupted(): boolean
  log(message: string): void
}
export interface NetherSupplyResult { ready: boolean; interrupted: boolean; reason?: string }

const quantity = (state: NetherSupplyState, pattern: RegExp): number => Object.entries(state.inventory)
  .reduce((total, [item, count]) => total + (pattern.test(item) ? count : 0), 0)
const planks = (state: NetherSupplyState): number => quantity(state, /_planks$/)
const wood = (state: NetherSupplyState): number => planks(state) + quantity(state, /_(log|stem)$/) * 4
const pick = (state: NetherSupplyState): boolean => quantity(state, /^(stone|iron|diamond|netherite)_pickaxe$/) > 0
const stone = (state: NetherSupplyState): number => quantity(state, /^(cobblestone|cobbled_deepslate|blackstone)$/)

export function netherToolsReady(state: NetherSupplyState): boolean {
  return pick(state) && state.pickSwings >= 260 && wood(state) >= 8 &&
    (quantity(state, /^crafting_table$/) > 0 || planks(state) >= 4)
}

export async function replenishNetherTools(port: NetherSupplyPort): Promise<NetherSupplyResult> {
  const deadline = port.now() + 240000
  let state = await port.observe()
  const safe = (): boolean => !port.interrupted() && port.now() < deadline && state.dimension === 'the_nether' && state.health >= 12
  const refresh = async (): Promise<void> => { state = await port.observe() }
  const act = async (method: string, params: Record<string, unknown>): Promise<void> => {
    if (safe()) { await port.act(method, params); await refresh() }
  }
  const craft = async (item: string, count = 1): Promise<boolean> => {
    if (!safe()) return false
    const made = await port.craft(item, count)
    await refresh()
    return made
  }
  const result = (reason?: string): NetherSupplyResult => ({ ready: netherToolsReady(state), interrupted: port.interrupted(), reason })
  if (!safe()) return result('пополнение инструментов сейчас небезопасно')
  if (netherToolsReady(state)) return result()
  port.log(`инструменты Ада: ${state.pickSwings}/260 взмахов, дерево ${wood(state)}/8 досок; бюджет 240 с`)
  if (!quantity(state, /^crafting_table$/)) {
    await act('mine', { block: 'crafting_table', count: 1, radius: 3, fair: true, dry: true, timeoutSeconds: 15 })
    if (!safe()) return result('возврат верстака прерван')
  }

  const ensureWood = async (required: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 2 && safe() && wood(state) < required; attempt++) {
      await act('mine', { block: 'crimson_stem,warped_stem', count: Math.ceil((required - wood(state)) / 4), radius: 32, dry: true, timeoutSeconds: 45 })
      if (wood(state) >= required || !safe()) break
      if (attempt === 0) await act('explore', { block: 'crimson_stem,warped_stem', radius: 32, stepDistance: 40, timeoutSeconds: 45, dry: true })
    }
    for (const [item, count] of Object.entries(state.inventory)) {
      if (/_(log|stem)$/.test(item) && count > 0 && !(await craft(item.replace(/_(log|stem)$/, '_planks'), count * 4))) break
    }
    return safe() && planks(state) >= required
  }
  const ironAvailable = quantity(state, /^iron_ingot$/) + Math.floor(quantity(state, /^iron_nugget$/) / 9) + 9 * quantity(state, /^iron_block$/)
  const woodenPickNeeded = !quantity(state, /_pickaxe$/) && stone(state) < 3 && ironAvailable < 3
  const firstWood = 8 + (quantity(state, /^crafting_table$/) ? 0 : 4) + (quantity(state, /^stick$/) >= 2 ? 0 : 2) + (woodenPickNeeded ? 3 : 0)
  if (!(await ensureWood(firstWood))) return result('нет безопасного дерева на ближайший крафт и резерв 8 досок')
  if (!quantity(state, /^crafting_table$/) && !(await craft('crafting_table'))) return result('не удалось восстановить верстак')
  for (let attempt = 0; attempt < 4 && safe() && (!pick(state) || state.pickSwings < 260); attempt++) {
    if (quantity(state, /^stick$/) < 2 && (!(await ensureWood(10)) || !(await craft('stick', 4)))) break
    if (quantity(state, /^iron_ingot$/) < 3 &&
      (!quantity(state, /^(iron|diamond|netherite)_pickaxe$/) || stone(state) < 3)) {
      const missing = 3 - quantity(state, /^iron_ingot$/)
      const nuggetIngots = Math.floor(quantity(state, /^iron_nugget$/) / 9)
      const convert = nuggetIngots >= missing ? missing : quantity(state, /^iron_block$/) > 0 ? 9 : 0
      if (convert && (!(await craft('iron_ingot', convert)) || quantity(state, /^iron_ingot$/) < 3)) break
    }
    if (!quantity(state, /^(iron|diamond|netherite)_pickaxe$/) && quantity(state, /^iron_ingot$/) >= 3) {
      if (!(await craft('iron_pickaxe'))) break
    } else if (stone(state) >= 3) {
      if (!(await craft('stone_pickaxe'))) break
    } else if (quantity(state, /^iron_ingot$/) >= 3) {
      if (!(await craft('iron_pickaxe'))) break
    } else {
      if (!quantity(state, /_pickaxe$/) && (!(await ensureWood(11)) || !(await craft('wooden_pickaxe')))) break
      const previous = stone(state)
      await act('mine', { block: 'blackstone', count: 6, radius: 24, dry: true, timeoutSeconds: 35 })
      if (stone(state) <= previous) break
    }
  }
  if (netherToolsReady(state)) return result()
  return result(safe() ? 'инструменты не пополнены: безопасного дерева или материала кирки нет' : 'пополнение прервано или исчерпало бюджет')
}
