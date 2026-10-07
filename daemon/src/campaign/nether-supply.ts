export interface NetherSupplyState {
  dimension: string
  health: number
  inventory: Record<string, number>
  pickSwings: number
  /** Увиденные глазами стебли (nether-forest.js «стебли (ад)») в пределах хода — куда идти за деревом, если рядом не видно. */
  woodAt?: { x: number; y: number; z: number } | null
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

// Дерево в Аду — на палки к новым киркам (доска = 2 палки = кирка) и на стол. С верстаком хватает 4 досок, палки — по ½
// доски: ворота «8 досок» гоняли тело наверх ради двух досок (Full42 ≈35 игр. мин; Full45 06.10 — в 17 бл. от спавнера,
// 558 взмахов, 6 досок и лук из 2 досок). Без верстака — как раньше: 8 дерева, из них 4 доски на стол.
const RESERVE = 4
const woodWithSticks = (state: NetherSupplyState): number => wood(state) + Math.floor(quantity(state, /^stick$/) / 2)
// Дерево — запас на новые кирки, а не допуск: при двойном запасе взмахов (≥ 520) путь к спавнеру и обратно покрыт и без него;
// без верстака хватает стола (4 доски) + 2 досок-эквивалентов (4 палки = 2 кирки), палки в счёт (s1c-B-4 06.10: 10 жемчуга
// при нужных 10, 378/260 взмахов, «дерево 7/8» — путь к спавнеру отложен, поход домой за деревом съел 70 мин).
export function netherToolsReady(state: NetherSupplyState): boolean {
  if (!pick(state) || state.pickSwings < 260) return false
  if (state.pickSwings >= 520) return true
  return quantity(state, /^crafting_table$/) > 0 ? woodWithSticks(state) >= RESERVE : planks(state) >= 4 && woodWithSticks(state) >= 6
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
  port.log(`инструменты Ада: ${state.pickSwings}/260 взмахов, дерево ${woodWithSticks(state)}/${quantity(state, /^crafting_table$/) ? 4 : 8} досок; бюджет 240 с`)
  if (!quantity(state, /^crafting_table$/)) {
    await act('mine', { block: 'crafting_table', count: 1, radius: 3, fair: true, dry: true, timeoutSeconds: 15 })
    if (!safe()) return result('возврат верстака прерван')
  }

  const ensureWood = async (required: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 2 && safe() && wood(state) < required; attempt++) {
      await act('mine', { block: 'crimson_stem,warped_stem', count: Math.ceil((required - wood(state)) / 4), radius: 32, dry: true, timeoutSeconds: 45 })
      if (wood(state) >= required || !safe()) break
      // S1e: стебли, увиденные по пути, — к ним (раньше — только обзор 45 с вокруг: s1e-B0-3 «нет безопасного дерева» и 70 мин стоянки).
      if (attempt === 0 && state.woodAt) await act('goto', { x: state.woodAt.x, y: state.woodAt.y, z: state.woodAt.z, range: 3, timeoutSeconds: 120 })
      else if (attempt === 0) await act('explore', { block: 'crimson_stem,warped_stem', radius: 32, stepDistance: 40, timeoutSeconds: 45, dry: true })
    }
    for (const [item, count] of Object.entries(state.inventory)) {
      if (/_(log|stem)$/.test(item) && count > 0 && !(await craft(item.replace(/_(log|stem)$/, '_planks'), count * 4))) break
    }
    return safe() && planks(state) >= required
  }
  const ironAvailable = quantity(state, /^iron_ingot$/) + Math.floor(quantity(state, /^iron_nugget$/) / 9) + 9 * quantity(state, /^iron_block$/)
  const woodenPickNeeded = !quantity(state, /_pickaxe$/) && stone(state) < 3 && ironAvailable < 3
  const firstWood = RESERVE + (quantity(state, /^crafting_table$/) ? 0 : 4) + (quantity(state, /^stick$/) >= 2 ? 0 : 2) + (woodenPickNeeded ? 3 : 0)
  if (!(await ensureWood(firstWood))) return result(`нет безопасного дерева на ближайший крафт (${firstWood} досок)`)
  if (!quantity(state, /^crafting_table$/) && !(await craft('crafting_table'))) return result('не удалось восстановить верстак')
  for (let attempt = 0; attempt < 4 && safe() && (!pick(state) || state.pickSwings < 260); attempt++) {
    if (quantity(state, /^stick$/) < 2 && (!(await ensureWood(RESERVE + 2)) || !(await craft('stick', 4)))) break
    if (quantity(state, /^iron_ingot$/) < 3 &&
      (!quantity(state, /^(iron|diamond|netherite)_pickaxe$/) || stone(state) < 3)) {
      const missing = 3 - quantity(state, /^iron_ingot$/)
      const nuggetIngots = Math.floor(quantity(state, /^iron_nugget$/) / 9)
      const convert = nuggetIngots >= missing ? missing : quantity(state, /^iron_block$/) > 0 ? 9 : 0
      // Переплавка самородков не вышла (s1-full48 06.10: «серверный рецепт для iron_ingot не совпал» ×4, 0/260 взмахов при
      // 64 cobbled_deepslate — 20+ мин «пауза») — каменная кирка из того, что есть, а не конец пополнения.
      if (convert && (!(await craft('iron_ingot', convert)) || quantity(state, /^iron_ingot$/) < 3) && stone(state) < 3) break
    }
    if (!quantity(state, /^(iron|diamond|netherite)_pickaxe$/) && quantity(state, /^iron_ingot$/) >= 3) {
      if (!(await craft('iron_pickaxe'))) break
    } else if (stone(state) >= 3) {
      if (!(await craft('stone_pickaxe'))) break
    } else if (quantity(state, /^iron_ingot$/) >= 3) {
      if (!(await craft('iron_pickaxe'))) break
    } else {
      if (!quantity(state, /_pickaxe$/) && (!(await ensureWood(RESERVE + 3)) || !(await craft('wooden_pickaxe')))) break
      const previous = stone(state)
      await act('mine', { block: 'blackstone', count: 6, radius: 24, dry: true, timeoutSeconds: 35 })
      if (stone(state) <= previous) break
    }
  }
  if (netherToolsReady(state)) return result()
  return result(safe() ? 'инструменты не пополнены: безопасного дерева или материала кирки нет' : 'пополнение прервано или исчерпало бюджет')
}
