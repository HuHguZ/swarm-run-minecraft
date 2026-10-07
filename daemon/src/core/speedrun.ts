import { amount, knows, unknown, type Dimension, type Effect, type WorldState } from './world-state'
import { StrategyRegistry, type Strategy } from './strategy'
import { applyCosts, type CostModel } from './cost-model'
import { barterPlan, chanceAll, DEFAULT_TIMING, expectedIngots, meanPerIngot, perIngot, type BarterDecision, type BarterState } from './barter-model'

export interface SpeedrunOptions {
  eyes?: number; beds?: number; iron?: number; structureBudgetMs?: number; costs?: CostModel[]
  /** Barter economy: gold as a resource (AcquireGold), next bastion, partial barter effects.
   *  Off by default, нужна ферма: the campaign enables it with ND_GRAPH_ECONOMY=1 once S1 wires the skills bastionGold/bastionMove.
   *  Simulator (sim-explore, 1000 worlds, telemetry-calibrated): win from Nether entry 7.4 % → 37.4 % (log 06.10 20:15, research/claude-1006/s3-strategist-log.md). */
  economy?: boolean
  /** KillDragon as a fork of fighting styles (placeholder until S5 measures them at 750 TPS); off by default. */
  dragonVariants?: boolean
}
/** Blocks per game second over terrain, the same constant as src/route.ts. */
const SPEED = 2.5
/** Ingots in the walls of one housing bastion (17 gold blocks), barter-piglins.md 4.2; used while the copy gives none. */
export const BASTION_GOLD = 153
const TARGETS: Record<string, [string, Dimension]> = {
  VillageIron: ['village', 'overworld'], ShipwreckIron: ['shipwreck', 'overworld'], TreasureIron: ['treasure', 'overworld'],
  RuinedPortal: ['ruined_portal', 'overworld'], LavaPoolPortal: ['lava', 'overworld'], FindStronghold: ['stronghold', 'overworld'],
  BastionBarter: ['bastion', 'the_nether'], AcquireGold: ['bastion', 'the_nether'], AcquireFireResistance: ['bastion', 'the_nether'],
  GetBlazeRods: ['fortress', 'the_nether']
}
/** Travel to the strategy's known target in the current dimension, in ticks. */
export function travelTicks(s: WorldState, id: string): number {
  const target = TARGETS[id]
  const at = target && s.facts[`${target[0]}_position`]
  if (!target || !at || s.dimension !== target[1] || !s.position || at.status !== 'known' || !at.value || typeof at.value !== 'object') return 0
  return Math.hypot(at.value.x - s.position.x, at.value.z - s.position.z) / SPEED * 20
}
/** A target believed with confidence c costs (1 − c) of a fresh search on top (map facts are 1, inferred ones less). */
function doubtTicks(s: WorldState, id: string, searchSeconds = 120): number {
  const fact = TARGETS[id] && s.facts[TARGETS[id][0]]
  return fact?.status === 'known' && fact.value === true ? (1 - fact.confidence) * searchSeconds * 20 : 0
}
const numberFact = (s: WorldState, name: string, fallback: number): number => {
  const value = s.facts[name]
  return value?.status === 'known' && Number.isFinite(Number(value.value)) ? Number(value.value) : fallback
}
/** Barter situation of the graph state: bastion gold from facts (copy of the world) or the housing-bastion default. */
export function barterSituation(s: WorldState, eyes: number): BarterState {
  const here = knows(s, 'bastion') && !knows(s, 'bastions_exhausted')
  const others = numberFact(s, 'bastions_left', 0)
  return { pearls: amount(s, 'pearls') + amount(s, 'eyes'), required: eyes, gold: amount(s, 'gold'),
    here: here ? { gold: Math.max(0, numberFact(s, 'bastion_gold_left', BASTION_GOLD)), travelSeconds: 0 } : null,
    next: others > 0 ? [{ gold: numberFact(s, 'next_bastion_gold', BASTION_GOLD), travelSeconds: numberFact(s, 'next_bastion_distance', 300) / SPEED }] : [],
    delivery: numberFact(s, 'barter_delivery', 0.85),
    timing: { mineSecondsPerIngot: numberFact(s, 'barter_mine_seconds', DEFAULT_TIMING.mineSecondsPerIngot),
      tradeSecondsPerIngot: numberFact(s, 'barter_trade_seconds', DEFAULT_TIMING.tradeSecondsPerIngot), switchSeconds: DEFAULT_TIMING.switchSeconds },
    endermenSecondsPerPearl: knows(s, 'endermen_allowed') ? numberFact(s, 'endermen_seconds_per_pearl', 240) : undefined }
}
const plans = new Map<string, BarterDecision>()
/** barterPlan memoized on the numbers it reads: the planner asks the same situation thousands of times. */
export function cachedBarterPlan(situation: BarterState): BarterDecision {
  const key = JSON.stringify(situation)
  let decision = plans.get(key)
  if (!decision) {
    if (plans.size > 20000) plans.clear()
    decision = barterPlan(situation)
    plans.set(key, decision)
  }
  return decision
}
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
  if (before !== null && after !== null) return before !== after
  // Graph economy without positions: a site counter set by MoveToNextBastion/SearchNextBastion (absent counter = site 0).
  const counter = (state: WorldState) => state.facts.bastion_site?.status === 'known' ? Number(state.facts.bastion_site.value) : null
  return current.dimension === 'the_nether' && counter(current) !== null && counter(current) !== (counter(failed) ?? 0)
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
  /** A new portal is worth building only while the Nether still owes eyes (COORD 00:55 S5c: after the Nether the paused
   *  FindStronghold let the planner pick LavaPoolPortal/AcquireDiamondPick — 15–20 min of logs and diamonds for nothing). */
  const eyesOwed = (s: WorldState) => amount(s, 'eyes') < eyes
  const toolsUnavailable = (s: WorldState) => s.facts.nether_tools_ready?.status === 'known' && s.facts.nether_tools_ready.value === false
  // blaze_allowed is the campaign's order «pearls of the active bastion first», not a fire-resistance permit: fire resistance
  // prices the fight (blazeRisk), it does not gate it (user decision 06.10 22:33, AGENTS.md «Гибкость вместо жёстких правил»).
  const blazeAllowed = (s: WorldState) => !toolsUnavailable(s) && (s.facts.blaze_allowed?.status === 'known'
    ? s.facts.blaze_allowed.value === true : !(pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted')))
  const fireResHeld = (s: WorldState) => knows(s, 'fire_resistance_active') || Number(s.facts.fire_resistance_count?.value ?? 0) >= 1
  /** Death risk of the spawner fight from the state. Fireballs and burning are #is_fire: under fire resistance only the touch
   *  attack hurts. Calibrated on the s1c farm series (06.10, 40 runs that reached the spawner, lockstep/750): death in the blaze
   *  stage 10/27 with FR at the first call, 9/13 without — 0.35 / 0.7; no shield +0.04; under 10 hp ×2. */
  const blazeRisk = (s: WorldState) => Math.min(1, ((fireResHeld(s) ? 0.35 : 0.7) + (amount(s, 'shield') >= 1 ? 0 : 0.04)) * (s.health < 10 ? 2 : 1))
  const barsNeeded = (s: WorldState) => ow(s) && !knows(s, 'portal') && amount(s, 'iron') < iron &&
    (amount(s, 'bucket') < 1 || amount(s, 'lighter') < 1) && amount(s, 'stone_tool') >= 1
  const structureAvailable = (s: WorldState, name: string) => knows(s, name) && !knows(s, `${name}_exhausted`) && s.structureSearchMs < structureBudgetMs
  const add = (id: string, skill: string, preconditions: Strategy['preconditions'], expectedEffects: Strategy['expectedEffects'], seconds: number,
    successCondition: Strategy['successCondition'], risk = 0.01, extra: Partial<Strategy> = {}) => registry.register({ id, skill, version: 1, preconditions,
      expectedEffects, estimateCost: s => seconds * 20 + travelTicks(s, id) + doubtTicks(s, id), travelTicks: s => travelTicks(s, id),
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
  add('ScoutLava', 'scoutLava', s => readyToBuild(s) && eyesOwed(s) && amount(s, 'water') >= 1 && unknown(s, 'lava'), { facts: { lava: true } }, 60, achieved('lava'), 0.02)
  add('LavaPoolPortal', 'cast', s => readyToBuild(s) && eyesOwed(s) && amount(s, 'water') >= 1 && knows(s, 'lava'), { facts: { portal: true } }, 120, achieved('portal'), 0.04)
  add('RuinedPortal', 'ruinedPortal', s => ow(s) && !knows(s, 'portal') && structureAvailable(s, 'ruined_portal') && amount(s, 'stone_tool') >= 1,
    { facts: { portal: true, ruined_portal_exhausted: true } }, 100, achieved('portal'), 0.025)
  add('AcquireDiamondPick', 'diamond', s => ow(s) && !knows(s, 'portal') && eyesOwed(s) && amount(s, 'iron') >= 3 && !amount(s, 'diamond_pick'),
    { resources: { iron: -3 }, atLeast: { diamond_pick: 1 } }, 600, has('diamond_pick'), 0.05)
  add('MineObsidian', 'obsidian', s => ow(s) && !knows(s, 'portal') && amount(s, 'diamond_pick') >= 1 && amount(s, 'water') >= 1 && amount(s, 'obsidian') < 10,
    { atLeast: { obsidian: 10 } }, 200, has('obsidian', 10), 0.035)
  add('ObsidianPortal', 'portal', s => ow(s) && !knows(s, 'portal') && amount(s, 'obsidian') >= 10 && amount(s, 'lighter') >= 1,
    { resources: { obsidian: -10 }, facts: { portal: true } }, 45, achieved('portal'), 0.01)
  add('PrepareNether', 'prep', s => ow(s) && knows(s, 'portal') && !knows(s, 'nether_ready'), { facts: { nether_ready: true }, atLeast: { food: 6, iron_pick: 1 } },
    90, achieved('nether_ready'), 0.01)
  add('EnterNether', 'enterNether', s => ow(s) && knows(s, 'portal') && knows(s, 'nether_ready') && (pearlsNeeded(s) || amount(s, 'rods') * 2 + amount(s, 'powder') + amount(s, 'eyes') < eyes),
    { dimension: 'the_nether', facts: { entered_nether: true } }, 30, (_b, a) => a.dimension === 'the_nether', 0.01)
  const economy = options.economy === true
  const barter = (s: WorldState) => cachedBarterPlan(barterSituation(s, eyes))
  const goldLeft = (s: WorldState) => barterSituation(s, eyes).here?.gold ?? 0
  const othersLeft = (s: WorldState) => numberFact(s, 'bastions_left', 0)
  const searches = (s: WorldState) => numberFact(s, 'bastion_searches', 0)
  // Economy: the current bastion is spent when its known gold is gone; all are spent when none is known or findable.
  const bastionsDone = (s: WorldState) => knows(s, 'bastions_exhausted') || (economy && goldLeft(s) <= 0 && othersLeft(s) <= 0 && searches(s) >= 1)
  const pearlsHeld = (s: WorldState) => amount(s, 'pearls') + amount(s, 'eyes')
  const tradeIngots = new Map<string, number>()
  /** Ingots a trade of the carried gold uses on average: all of it, or E[ingots to the deficit] when that is less. */
  const tradeUse = (s: WorldState) => {
    const situation = barterSituation(s, eyes)
    const deficit = Math.max(0, Math.ceil(eyes - situation.pearls))
    const key = `${deficit}/${situation.delivery}`
    if (!tradeIngots.has(key)) tradeIngots.set(key, expectedIngots({ ender_pearl: deficit }, situation.delivery))
    return Math.min(amount(s, 'gold'), tradeIngots.get(key)!)
  }
  const pearlsDone = (_b: WorldState, a: WorldState) => pearlsHeld(a) >= eyes
  const chances = new Map<string, number>()
  /** P(the pearls still missing come from these ingots), 1.21.11 table and the delivery fact. */
  const barterChance = (s: WorldState, ingots: number) => {
    const deficit = Math.max(0, Math.ceil(eyes - pearlsHeld(s))), delivery = barterSituation(s, eyes).delivery
    const key = [ingots, deficit, delivery].join('/')
    if (!chances.has(key)) chances.set(key, chanceAll(ingots, { ender_pearl: deficit }, delivery))
    return chances.get(key)!
  }
  /** No gold is left to mine, move to or search for, and endermen are not allowed: the carried gold is the last chance. */
  const lastGold = (s: WorldState) => economy && goldLeft(s) <= 0 && othersLeft(s) <= 0 && searches(s) >= 1 && !knows(s, 'endermen_allowed')
  const shortfall = new Map<string, number>()
  /** (1 − P(≥ deficit pearls | carried gold)) × one hour (the planner's price of a death): a lost run either way. */
  const shortfallTicks = (s: WorldState) => {
    const situation = barterSituation(s, eyes)
    const key = `${amount(s, 'gold')}/${Math.ceil(eyes - situation.pearls)}/${situation.delivery}`
    if (!shortfall.has(key)) shortfall.set(key, (1 - chanceAll(amount(s, 'gold'), { ender_pearl: Math.ceil(eyes - situation.pearls) }, situation.delivery)) * 72000)
    return shortfall.get(key)!
  }
  add('FindBastions', 'findBastions', s => nether(s) && pearlsNeeded(s) && unknown(s, 'bastion'), { facts: { bastion: true } }, 90, (_b, a) => !unknown(a, 'bastion'), 0.035)
  // Economy decomposes the monolithic bastion skill into AcquireGold + PiglinBarter (+ MoveToNextBastion/SearchNextBastion).
  if (!economy) add('BastionBarter', 'bastion', s => nether(s) && pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted') &&
    (amount(s, 'gold') >= 8 || !toolsUnavailable(s)),
    { atLeast: { pearls: eyes }, facts: { bastions_exhausted: true, blaze_allowed: true } }, 180, pearlsDone, 0.08,
    // Simulator prior: one bastion's walls plus the carried gold reach the pearls only with the 1.21.11 table's chance.
    { retryCondition: bastionSiteChanged, successChance: s => barterChance(s, amount(s, 'gold') + goldLeft(s)) })
  add('PiglinBarter', 'piglinBarter', s => nether(s) && pearlsNeeded(s) && amount(s, 'gold') >= 8 && (knows(s, 'bastion') || knows(s, 'bastions_exhausted')),
    economy ? (s: WorldState) => {
      const used = tradeUse(s)
      // The last gold anywhere is traded for its chance, not its mean: the shortfall risk is priced in estimateCost.
      const reached = used < amount(s, 'gold') || pearlsHeld(s) + used * meanPerIngot('ender_pearl', barterSituation(s, eyes).delivery) >= eyes || lastGold(s)
      return { resources: { gold: -used, pearls: used * meanPerIngot('ender_pearl', barterSituation(s, eyes).delivery) },
        ...(reached ? { atLeast: { pearls: eyes - amount(s, 'eyes') } } : {}), facts: { blaze_allowed: true } }
    } : { resources: { gold: -8 }, atLeast: { pearls: eyes }, facts: { blaze_allowed: true } }, 150, pearlsDone, 0.025,
    { retryCondition: (failed, current) => ['gold', 'pearls', 'eyes'].some(key => amount(failed, key) !== amount(current, key)) || bastionSiteChanged(failed, current),
      ...(economy ? {} : { successChance: (s: WorldState) => barterChance(s, amount(s, 'gold')) }),
      ...(economy ? { estimateCost: (s: WorldState) => tradeUse(s) * barterSituation(s, eyes).timing.tradeSecondsPerIngot * 20 + (lastGold(s) ? shortfallTicks(s) : 0), modelCost: true, timeRetry: true,
        sampleEffects: (s: WorldState, random: () => number) => {
          // Ingot by ingot with the 1.21.11 table until the pearls are held or the gold is gone (the skill's own stop).
          const chances = perIngot('ender_pearl', barterSituation(s, eyes).delivery)
          let gold = amount(s, 'gold'), pearls = 0
          while (gold > 0 && pearlsHeld(s) + pearls < eyes) {
            gold--
            let r = random()
            for (let c = 1; c < chances.length; c++) { r -= chances[c]!; if (r < 0) { pearls += c; break } }
          }
          return { resources: { gold: gold - amount(s, 'gold'), pearls }, facts: { blaze_allowed: true } }
        } } : {}) })
  add('HuntEndermen', 'pearls', s => nether(s) && pearlsNeeded(s) && (economy ? bastionsDone(s) : knows(s, 'bastions_exhausted')) && knows(s, 'endermen_allowed') &&
    (amount(s, 'gold') < 8 || knows(s, 'barter_exhausted')),
    { atLeast: { pearls: eyes } }, 600, pearlsDone, 0.07,
    economy ? { estimateCost: s => Math.max(0, eyes - pearlsHeld(s)) * numberFact(s, 'endermen_seconds_per_pearl', 240) * 20, modelCost: true } : {})
  if (economy) {
    // Gold is a resource: mine the batch the barter model asks for, then trade it (PiglinBarter); stop and move by the same model.
    const batch = (s: WorldState) => Math.min(goldLeft(s), barter({ ...s, resources: { ...s.resources, gold: 0 } }).options.find(o => o.action === 'mine')?.batch || 27)
    add('AcquireGold', 'bastionGold', s => nether(s) && pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted') &&
      !toolsUnavailable(s) && goldLeft(s) > 0 && amount(s, 'gold') < 8,
      s => ({ resources: { gold: batch(s) }, facts: { bastion_gold_left: goldLeft(s) - batch(s) } }), 0,
      // Risk: the bastion skill that mines this gold died 0 times in 165 graph attempts (graph-ne-*, 05–06.10); 0.01 until AcquireGold has its own.
      (b, a) => amount(a, 'gold') > amount(b, 'gold'), 0.01,
      { estimateCost: s => (batch(s) * barterSituation(s, eyes).timing.mineSecondsPerIngot + DEFAULT_TIMING.switchSeconds) * 20 + travelTicks(s, 'AcquireGold'),
        modelCost: true, timeoutMs: 900000, command: s => ({ skill: 'bastionGold', strategy: 'AcquireGold', params: { ingots: batch(s) } }) })
    // Carried gold does not block a move: when trading here keeps failing, the next site's piglins re-admit PiglinBarter.
    const site = (s: WorldState) => numberFact(s, 'bastion_site', 0) + 1
    add('MoveToNextBastion', 'bastionMove', s => nether(s) && pearlsNeeded(s) && othersLeft(s) >= 1 && (goldLeft(s) < 27 || amount(s, 'gold') >= 8),
      s => ({ facts: { bastion: true, bastions_exhausted: false, bastion_gold_left: numberFact(s, 'next_bastion_gold', BASTION_GOLD), bastions_left: othersLeft(s) - 1, bastion_site: site(s) } }),
      0, bastionSiteChanged, 0.04,
      { estimateCost: s => (numberFact(s, 'next_bastion_distance', 300) / SPEED + DEFAULT_TIMING.switchSeconds) * 20, modelCost: true, timeoutMs: 900000 })
    add('SearchNextBastion', 'findBastions', s => nether(s) && pearlsNeeded(s) && goldLeft(s) <= 0 && othersLeft(s) <= 0 && searches(s) < 1,
      s => ({ facts: { bastion: true, bastions_exhausted: false, bastion_gold_left: BASTION_GOLD, bastion_searches: searches(s) + 1, bastion_site: site(s) } }),
      300, (b, a) => bastionSiteChanged(b, a) || goldLeft(a) > goldLeft(b), 0.05)
  }
  add('AcquireNetherTools', 'netherTools', s => nether(s) &&
    (rodsNeeded(s) || pearlsNeeded(s) && knows(s, 'bastion') && !knows(s, 'bastions_exhausted')) && toolsUnavailable(s) && s.health >= 12 &&
    !(pearlsNeeded(s) && amount(s, 'gold') >= 8),
    { facts: { nether_tools_ready: true }, atLeast: { stone_tool: 1 } }, 180, achieved('nether_tools_ready'), 0.03,
    { timeoutMs: 300000, retryCondition: netherSupplyImproved })
  // Fire resistance is an option, not a gate: the planner buys it only when its trip (travel + 180 s + risk) costs less than the
  // risk it removes from GetBlazeRods (blazeRisk with vs without FR).
  add('AcquireFireResistance', 'bastionSupply', s => nether(s) && rodsNeeded(s) && !pearlsNeeded(s) && s.health >= 12 && !fireResHeld(s) &&
    ((knows(s, 'bastion') && !knows(s, 'bastions_exhausted')) || amount(s, 'gold') >= 8),
    // 600 s: the measured trip (SC-1 06.10: 29 min with interruptions; s1c barter calls 4–10 min) rather than an ideal 180 s.
    { facts: { fire_resistance_count: 1 } }, 600,
    (_b, a) => knows(a, 'fire_resistance_active') || (a.facts.fire_resistance_count?.status === 'known' && Number(a.facts.fire_resistance_count.value) >= 1),
    0.04, { timeoutMs: 900000 })
  add('FindFortress', 'findFortress', s => nether(s) && blazeAllowed(s) && unknown(s, 'fortress') && rodsNeeded(s),
    { facts: { fortress: true } }, 90, (_b, a) => !unknown(a, 'fortress'), 0.04)
  add('GetBlazeRods', 'nether', s => nether(s) && blazeAllowed(s) && knows(s, 'fortress') && rodsNeeded(s),
    { atLeast: { rods: Math.ceil(eyes / 2) } }, 240, (_b, a) => amount(a, 'rods') * 2 + amount(a, 'powder') + amount(a, 'eyes') >= eyes, 0.06,
    { estimateRisk: blazeRisk })
  add('CraftEyes', 'eyes', s => amount(s, 'eyes') < eyes && amount(s, 'pearls') >= eyes - amount(s, 'eyes') && amount(s, 'rods') * 2 + amount(s, 'powder') >= eyes - amount(s, 'eyes'),
    s => ({ resources: { pearls: -(eyes - amount(s, 'eyes')), rods: -Math.ceil(Math.max(0, eyes - amount(s, 'eyes') - amount(s, 'powder')) / 2) }, atLeast: { eyes } }), 10, has('eyes', eyes), 0)
  add('LeaveNether', 'leaveNether', s => nether(s) && amount(s, 'eyes') >= eyes, { dimension: 'overworld' }, 60, (_b, a) => a.dimension === 'overworld', 0.015)
  add('PrepareEnd', 'endkit', s => ow(s) && amount(s, 'eyes') >= eyes && !knows(s, 'end_ready'), { atLeast: { beds, water: 1, blocks: 128 }, facts: { end_ready: true } },
    120, achieved('end_ready'), 0.02)
  add('FindStronghold', 'stronghold', s => ow(s) && amount(s, 'eyes') >= eyes && knows(s, 'end_ready') && !knows(s, 'end_portal'),
    { facts: { stronghold: true, end_portal: true } }, 300, achieved('end_portal'), 0.03)
  add('EnterEnd', 'enterEnd', s => ow(s) && knows(s, 'end_portal') && knows(s, 'end_ready'), { dimension: 'the_end', resources: { eyes: -eyes } },
    30, (_b, a) => a.dimension === 'the_end', 0.01)
  // S5c (COORD 01:20): 31 fights at 750 + precision window, keep_inventory=false — kills 25/31 = 0.81, deaths 2/31 (95 % bound 0.19),
  // platform→kill p50 ~200 s. Risk 0.12 between the point estimate and the bound.
  if (!options.dragonVariants) add('KillDragon', 'dragon', s => s.dimension === 'the_end' && !knows(s, 'dragon_dead'), { facts: { dragon_dead: true } }, 200, achieved('dragon_dead'), 0.12,
    { successChance: () => 0.8 })
  else {
    // Fork placeholder (prices to come from S5): one-cycle beds vs no beds. Bed numbers: dev-C ca3/xda1 18/21 wins, 0 deaths,
    // p50 144 s at 20 TPS with ≥4 beds; without crystals 13–14/20 (end-dragon.md). At 750 TPS S5 had 0/11 on 06.10 19:10–19:27
    // (s5-b2, s5-c1) while fixing tick timing: these chances are 20 TPS priors, not 750 TPS facts.
    add('KillDragonBeds', 'dragon', s => s.dimension === 'the_end' && !knows(s, 'dragon_dead') && amount(s, 'beds') >= 4,
      { facts: { dragon_dead: true } }, 144, achieved('dragon_dead'), 0.05,
      { version: 0, successChance: s => Math.min(0.9, 0.55 + 0.08 * amount(s, 'beds')), command: () => ({ skill: 'dragon', strategy: 'KillDragonBeds', params: { mode: 'beds' } }) })
    add('KillDragonMelee', 'dragon', s => s.dimension === 'the_end' && !knows(s, 'dragon_dead'),
      { facts: { dragon_dead: true } }, 420, achieved('dragon_dead'), 0.2,
      { version: 0, successChance: () => 0.5, command: () => ({ skill: 'dragon', strategy: 'KillDragonMelee', params: { mode: 'melee' } }) })
  }
  if (options.costs) applyCosts(registry, options.costs)
  return registry
}
export const dragonGoal = (state: WorldState): boolean => knows(state, 'dragon_dead')
