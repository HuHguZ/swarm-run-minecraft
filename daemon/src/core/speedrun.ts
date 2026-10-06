import { amount, knows, unknown, type Effect, type WorldState } from './world-state'
import { StrategyRegistry, type Strategy } from './strategy'
import { applyCosts, type CostModel } from './cost-model'

export interface SpeedrunOptions { eyes?: number; beds?: number; iron?: number; structureBudgetMs?: number; costs?: CostModel[] }
const woodPlanks = (state: WorldState): number => Math.max(amount(state, 'wood'), Object.entries(state.inventory).reduce((total, [name, count]) =>
  total + (/_planks$/.test(name) ? count : /_(?:log|wood|stem|hyphae)$/.test(name) ? count * 4 : 0), 0))
function netherSupplyImproved(failed: WorldState, current: WorldState): boolean {
  const quantity = (state: WorldState, pattern: RegExp) => Object.entries(state.inventory)
    .reduce((total, [name, count]) => total + (pattern.test(name) ? count : 0), 0)
  const iron = (state: WorldState) => quantity(state, /^iron_ingot$/) +
    Math.floor(quantity(state, /^iron_nugget$/) / 9) + 9 * quantity(state, /^iron_block$/)
  const swings = (state: WorldState) => state.facts.nether_pick_swings?.status === 'known'
    ? Number(state.facts.nether_pick_swings.value) || 0 : 0
  const improved = (before: number, after: number, required: number) => before < required && Math.min(required, after) > before
  if (improved(woodPlanks(failed), woodPlanks(current), 8) ||
      improved(failed.inventory.crafting_table ?? 0, current.inventory.crafting_table ?? 0, 1) ||
      improved(swings(failed), swings(current), 260)) return true
  if (swings(failed) >= 260) return false
  return improved(failed.inventory.stick ?? 0, current.inventory.stick ?? 0, 2) ||
    improved(quantity(failed, /^(?:cobblestone|cobbled_deepslate|blackstone)$/), quantity(current, /^(?:cobblestone|cobbled_deepslate|blackstone)$/), 3) ||
    (iron(failed) < 3 && iron(current) >= 3)
}
function bastionSiteChanged(failed: WorldState, current: WorldState): boolean {
  const site = (state: WorldState): string | null => {
    const target = state.facts.bastion_position
    if (state.dimension !== 'the_nether' || target?.status !== 'known' || !target.value || typeof target.value !== 'object') return null
    const { x, z } = target.value
    return Number.isFinite(x) && Number.isFinite(z) ? `${x}:${z}` : null
  }
  const before = site(failed), after = site(current)
  return before !== null && after !== null && before !== after
}
export function speedrunRegistry(options: SpeedrunOptions = {}): StrategyRegistry {
  const eyes = Math.max(1, options.eyes ?? 12)
  const beds = Math.max(1, options.beds ?? 7)
  const iron = Math.max(1, options.iron ?? 7)
  const structureBudgetMs = options.structureBudgetMs ?? 180000
  const registry = new StrategyRegistry()
  const ow = (s: WorldState) => s.dimension === 'overworld'
  const nether = (s: WorldState) => s.dimension === 'the_nether'
  const readyToBuild = (s: WorldState) => ow(s) && !knows(s, 'portal') && amount(s, 'bucket') >= 1 && amount(s, 'lighter') >= 1
  const pearlsNeeded = (s: WorldState) => amount(s, 'pearls') + amount(s, 'eyes') < eyes
  const rodsNeeded = (s: WorldState) => amount(s, 'rods') * 2 + amount(s, 'powder') + amount(s, 'eyes') < eyes
  const toolsUnavailable = (s: WorldState) => s.facts.nether_tools_ready?.status === 'known' && s.facts.nether_tools_ready.value === false
  const blazeAllowed = (s: WorldState) => !toolsUnavailable(s) && (s.facts.blaze_allowed?.status === 'known'
    ? s.facts.blaze_allowed.value === true : !(pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted')))
  const barsNeeded = (s: WorldState) => ow(s) && !knows(s, 'portal') && amount(s, 'iron') < iron &&
    (amount(s, 'bucket') < 1 || amount(s, 'lighter') < 1) && amount(s, 'stone_tool') >= 1
  const structureAvailable = (s: WorldState, name: string) => knows(s, name) && !knows(s, `${name}_exhausted`) && s.structureSearchMs < structureBudgetMs
  const add = (id: string, skill: string, preconditions: Strategy['preconditions'], expectedEffects: Strategy['expectedEffects'], seconds: number,
    successCondition: Strategy['successCondition'], risk = 0.01, extra: Partial<Strategy> = {}) => registry.register({ id, skill, version: 1, preconditions,
      expectedEffects, estimateCost: s => (seconds + Number(s.facts[`${id}_distance`]?.value ?? 0) / 2.5) * 20,
      estimateRisk: s => Math.min(1, risk * (s.health < 10 ? 3 : 1)), timeoutMs: Math.max(120000, seconds * 4000), successCondition, ...extra })
  const has = (key: string, n = 1) => (_before: WorldState, after: WorldState) => amount(after, key) >= n
  const achieved = (key: string) => (_before: WorldState, after: WorldState) => knows(after, key)
  add('AcquireWood', 'wood', s => ow(s) && !amount(s, 'stone_tool') && !amount(s, 'wood'), { atLeast: { wood: 5 } }, 90, has('wood', 5))
  add('RecoverNetherWood', 'wood', s => ow(s) && knows(s, 'portal') && toolsUnavailable(s) && woodPlanks(s) < 8 &&
    (s.inventory.crafting_table ?? 0) >= 1 && s.facts.nether_pick_swings?.status === 'known' &&
    (pearlsNeeded(s) || rodsNeeded(s)), s => ({ atLeast: { wood: 8 },
      ...(Number(s.facts.nether_pick_swings?.value) >= 260 ? { facts: { nether_tools_ready: true } } : {}) }), 90,
    (before, after) => woodPlanks(after) >= 8 &&
      (Number(before.facts.nether_pick_swings?.value) < 260 || knows(after, 'nether_tools_ready')), 0.01)
  add('AcquireStoneTools', 'stone', s => ow(s) && amount(s, 'wood') >= 1 && !amount(s, 'stone_tool'), { atLeast: { stone_tool: 1, blocks: 24 } }, 90, has('stone_tool'))
  add('FindFood', 'food', s => s.dimension !== 'the_end' && amount(s, 'food') < 3 && !knows(s, 'end_ready'), { atLeast: { food: 6 } }, 90, has('food', 3), 0.025)
  add('Heal', 'heal', s => s.health < 12 && amount(s, 'food') >= 1, { health: 18, hunger: 20 }, 40, (_b, a) => a.health >= 12, 0)
  add('ScoutStructures', 'scoutStructures', s => barsNeeded(s) && s.structureSearchMs < structureBudgetMs &&
    !['village', 'shipwreck', 'treasure'].some(name => structureAvailable(s, name)) &&
    ['village', 'shipwreck', 'treasure'].some(name => unknown(s, name)),
    s => ({ structureSearchMs: Math.max(0, structureBudgetMs - s.structureSearchMs) }),
    180, (_b, a) => a.structureSearchMs >= structureBudgetMs || ['village', 'shipwreck', 'treasure'].some(name => structureAvailable(a, name)), 0.01)
  const loot: Array<[string, string, number, number]> = [['VillageIron', 'village', 4, 80], ['ShipwreckIron', 'shipwreck', 5, 150], ['TreasureIron', 'treasure', 9, 120]]
  for (const [id, place, bars, seconds] of loot) add(id, 'structureIron', s => barsNeeded(s) && structureAvailable(s, place),
    s => ({ resources: { iron: bars }, facts: { [`${place}_exhausted`]: true }, structureSearchMs: Math.min(structureBudgetMs - s.structureSearchMs, seconds * 1000) }), seconds,
    (b, a) => amount(a, 'iron') > amount(b, 'iron'), 0.02, { command: () => ({ skill: 'structureIron', strategy: id, params: { kind: place, budgetSeconds: structureBudgetMs / 1000 } }) })
  add('MineIron', 'iron', s => barsNeeded(s) && (s.structureSearchMs >= structureBudgetMs ||
    ['village', 'shipwreck', 'treasure'].every(name => !structureAvailable(s, name) && !unknown(s, name))), { atLeast: { iron } }, 180, has('iron', iron), 0.04)
  add('CraftPortalKit', 'portalKit', s => ow(s) && !knows(s, 'portal') && amount(s, 'iron') >= iron && (!amount(s, 'bucket') || !amount(s, 'lighter')),
    { resources: { iron: -4 }, atLeast: { bucket: 1, lighter: 1 } }, 20, (_b, a) => amount(a, 'bucket') >= 1 && amount(a, 'lighter') >= 1, 0)
  add('GetWater', 'water', s => readyToBuild(s) && !amount(s, 'water') && amount(s, 'obsidian') < 10, { atLeast: { water: 1 } }, 40, has('water'), 0.015)
  add('ScoutLava', 'scoutLava', s => readyToBuild(s) && amount(s, 'water') >= 1 && unknown(s, 'lava'), { facts: { lava: true } }, 60, achieved('lava'), 0.02)
  add('LavaPoolPortal', 'cast', s => readyToBuild(s) && amount(s, 'water') >= 1 && knows(s, 'lava'), { facts: { portal: true } }, 120, achieved('portal'), 0.04)
  add('RuinedPortal', 'ruinedPortal', s => ow(s) && !knows(s, 'portal') && structureAvailable(s, 'ruined_portal') && amount(s, 'stone_tool') >= 1,
    { facts: { portal: true, ruined_portal_exhausted: true } }, 100, achieved('portal'), 0.025)
  add('AcquireDiamondPick', 'diamond', s => ow(s) && !knows(s, 'portal') && amount(s, 'iron') >= 3 && !amount(s, 'diamond_pick'),
    { resources: { iron: -3 }, atLeast: { diamond_pick: 1 } }, 600, has('diamond_pick'), 0.05)
  add('MineObsidian', 'obsidian', s => ow(s) && !knows(s, 'portal') && amount(s, 'diamond_pick') >= 1 && amount(s, 'water') >= 1 && amount(s, 'obsidian') < 10,
    { atLeast: { obsidian: 10 } }, 200, has('obsidian', 10), 0.035)
  add('ObsidianPortal', 'portal', s => ow(s) && !knows(s, 'portal') && amount(s, 'obsidian') >= 10 && amount(s, 'lighter') >= 1,
    { resources: { obsidian: -10 }, facts: { portal: true } }, 45, achieved('portal'), 0.01)
  add('PrepareNether', 'prep', s => ow(s) && knows(s, 'portal') && !knows(s, 'nether_ready'), { facts: { nether_ready: true }, atLeast: { food: 6, iron_pick: 1 } },
    90, achieved('nether_ready'), 0.01)
  add('EnterNether', 'enterNether', s => ow(s) && knows(s, 'portal') && knows(s, 'nether_ready') && (pearlsNeeded(s) || amount(s, 'rods') * 2 + amount(s, 'powder') + amount(s, 'eyes') < eyes),
    { dimension: 'the_nether', facts: { entered_nether: true } }, 30, (_b, a) => a.dimension === 'the_nether', 0.01)
  add('FindBastions', 'findBastions', s => nether(s) && pearlsNeeded(s) && unknown(s, 'bastion'), { facts: { bastion: true } }, 90, (_b, a) => !unknown(a, 'bastion'), 0.035)
  add('BastionBarter', 'bastion', s => nether(s) && pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted') &&
    (amount(s, 'gold') >= 8 || !toolsUnavailable(s)),
    { atLeast: { pearls: eyes }, facts: { bastions_exhausted: true, blaze_allowed: true } }, 180, (_b, a) => amount(a, 'pearls') + amount(a, 'eyes') >= eyes, 0.08,
    { retryCondition: bastionSiteChanged })
  add('PiglinBarter', 'piglinBarter', s => nether(s) && pearlsNeeded(s) && amount(s, 'gold') >= 8 && (knows(s, 'bastion') || knows(s, 'bastions_exhausted')),
    { resources: { gold: -8 }, atLeast: { pearls: eyes }, facts: { blaze_allowed: true } }, 150, (_b, a) => amount(a, 'pearls') + amount(a, 'eyes') >= eyes, 0.025,
    { retryCondition: (failed, current) => ['gold', 'pearls', 'eyes'].some(key => amount(failed, key) !== amount(current, key)) })
  add('HuntEndermen', 'pearls', s => nether(s) && pearlsNeeded(s) && knows(s, 'bastions_exhausted') && knows(s, 'endermen_allowed') &&
    (amount(s, 'gold') < 8 || knows(s, 'barter_exhausted')),
    { atLeast: { pearls: eyes } }, 600, (_b, a) => amount(a, 'pearls') + amount(a, 'eyes') >= eyes, 0.07)
  add('AcquireNetherTools', 'netherTools', s => nether(s) &&
    (rodsNeeded(s) || pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted')) && toolsUnavailable(s) && s.health >= 12 &&
    !(pearlsNeeded(s) && amount(s, 'gold') >= 8),
    { facts: { nether_tools_ready: true }, atLeast: { stone_tool: 1 } }, 180, achieved('nether_tools_ready'), 0.03,
    { timeoutMs: 300000, retryCondition: netherSupplyImproved })
  add('AcquireFireResistance', 'bastionSupply', s => nether(s) && rodsNeeded(s) && !pearlsNeeded(s) && s.health >= 12 &&
    s.facts.blaze_allowed?.status === 'known' && s.facts.blaze_allowed.value === false &&
    !knows(s, 'fire_resistance_active') && Number(s.facts.fire_resistance_count?.value ?? 0) < 1 &&
    ((knows(s, 'bastion') && !knows(s, 'bastions_exhausted')) || amount(s, 'gold') >= 8),
    { facts: { fire_resistance_count: 1, blaze_allowed: true } }, 180,
    (_b, a) => knows(a, 'fire_resistance_active') || (a.facts.fire_resistance_count?.status === 'known' && Number(a.facts.fire_resistance_count.value) >= 1),
    0.08, { timeoutMs: 900000 })
  add('FindFortress', 'findFortress', s => nether(s) && blazeAllowed(s) && unknown(s, 'fortress') && rodsNeeded(s),
    { facts: { fortress: true } }, 90, (_b, a) => !unknown(a, 'fortress'), 0.04)
  add('GetBlazeRods', 'nether', s => nether(s) && blazeAllowed(s) && knows(s, 'fortress') && rodsNeeded(s),
    { atLeast: { rods: Math.ceil(eyes / 2) } }, 240, (_b, a) => amount(a, 'rods') * 2 + amount(a, 'powder') + amount(a, 'eyes') >= eyes, 0.06)
  add('CraftEyes', 'eyes', s => amount(s, 'eyes') < eyes && amount(s, 'pearls') >= eyes - amount(s, 'eyes') && amount(s, 'rods') * 2 + amount(s, 'powder') >= eyes - amount(s, 'eyes'),
    s => ({ resources: { pearls: -(eyes - amount(s, 'eyes')), rods: -Math.ceil(Math.max(0, eyes - amount(s, 'eyes') - amount(s, 'powder')) / 2) }, atLeast: { eyes } }), 10, has('eyes', eyes), 0)
  add('LeaveNether', 'leaveNether', s => nether(s) && amount(s, 'eyes') >= eyes, { dimension: 'overworld' }, 60, (_b, a) => a.dimension === 'overworld', 0.015)
  add('PrepareEnd', 'endkit', s => ow(s) && amount(s, 'eyes') >= eyes && !knows(s, 'end_ready'), { atLeast: { beds, water: 1, blocks: 128 }, facts: { end_ready: true } },
    120, achieved('end_ready'), 0.02)
  add('FindStronghold', 'stronghold', s => ow(s) && amount(s, 'eyes') >= eyes && knows(s, 'end_ready') && !knows(s, 'end_portal'),
    { facts: { stronghold: true, end_portal: true } }, 300, achieved('end_portal'), 0.03)
  add('EnterEnd', 'enterEnd', s => ow(s) && knows(s, 'end_portal') && knows(s, 'end_ready'), { dimension: 'the_end', resources: { eyes: -eyes } },
    30, (_b, a) => a.dimension === 'the_end', 0.01)
  add('KillDragon', 'dragon', s => s.dimension === 'the_end' && !knows(s, 'dragon_dead'), { facts: { dragon_dead: true } }, 180, achieved('dragon_dead'), 0.08)
  if (options.costs) applyCosts(registry, options.costs)
  return registry
}
export const dragonGoal = (state: WorldState): boolean => knows(state, 'dragon_dead')
