import type { ExecutionResult, SkillCommand, SkillOutcome } from '../core/environment'
import { amount, fact, type WorldState } from '../core/world-state'
import { plan, StrategicDirector, type DecisionRecord, type Strategy } from '../core/strategy'
import { dragonGoal, speedrunRegistry } from '../core/speedrun'
import { applyCosts } from '../core/cost-model'
import { MineflayerEnvironment, type Observation } from '../environments/mineflayer'
import { loadCosts } from '../environments/cost-data'
import { netherStageProgress, netherSupplyProgress } from './nether-progress'

export interface CampaignStage {
  pauseKey?: string
  name: string; needed(): boolean; ready(): boolean; defer(): boolean; done(): boolean; run(): Promise<void>
  progressed?(): boolean
  interrupted?(): boolean
}
export interface CampaignPort {
  observe(): Promise<Observation>
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult>
  now(): number
  sleep(milliseconds: number): Promise<void>
  record(record: DecisionRecord): void
  eyes: number
  beds: number
  endPrepPrice?: boolean
}
export function createCampaignIntelligence(port: CampaignPort) {
  const noGiveup = process.env.ND_NE_NO_GIVEUP === '1'
  const recoveryEnabled = process.env.ND_NE_RECOVER === '1' || noGiveup
  // Flags from the S3 simulator search (06.10), off by default — нужна ферма: ND_GRAPH_ECONOMY=1 needs the skills
  // bastionGold {ingots} and bastionMove in the campaign (S1); ND_GRAPH_RETRY_S — timed re-admission backoff (sim: 60–120 s beat 300 s).
  const registry = speedrunRegistry({ eyes: port.eyes, beds: port.beds, economy: process.env.ND_GRAPH_ECONOMY === '1',
    portalBuckets: process.env.ND_ROUTE_ONE === '0' ? 2 : 1, endPrepPrice: port.endPrepPrice, deepLava: process.env.ND_OW_DEEP_LAVA === '1',
    // ND_OW_SCOUT_MS — бюджет слепой разведки построек (21.10: 16 из 16 разведок по 180 с — «бюджет исчерпан», ничего).
    scoutBudgetMs: process.env.ND_OW_SCOUT_MS ? Number(process.env.ND_OW_SCOUT_MS) : undefined })
  const progressFor = (skill: string): Strategy['progressCondition'] => skill === 'scoutLava'
    ? (before, after) => Number(after.facts.lava_scout_views?.value ?? 0) > Number(before.facts.lava_scout_views?.value ?? 0)
    : skill === 'netherTools' ? netherSupplyProgress : ['bastion', 'bastionSupply', 'piglinBarter', 'nether'].includes(skill)
    ? (before, after) => netherStageProgress(skill === 'nether' ? 'nether' : 'bastion', before, after) : undefined
  for (const strategy of registry.all()) {
    const progress = progressFor(strategy.skill)
    if (progress) strategy.progressCondition = progress
  }
  const physicalRetry = (before: WorldState, after: WorldState) => before.dimension === 'the_nether' && after.dimension === 'the_nether' &&
    (netherStageProgress('nether', before, after) ||
      (typeof before.facts.nether_search_state?.value === 'string' && typeof after.facts.nether_search_state?.value === 'string' && before.facts.nether_search_state.value !== after.facts.nether_search_state.value) ||
      (before.position && after.position && Math.hypot(after.position.x-before.position.x, after.position.y-before.position.y, after.position.z-before.position.z) >= 8) ||
      (before.facts.nether_tools_ready?.value !== true && after.facts.nether_tools_ready?.value === true) || before.threatLevel !== after.threatLevel)
  if (recoveryEnabled) for (const strategy of registry.all()) {
    if (!['findFortress', 'nether', 'findBastions', 'bastion', 'piglinBarter', 'bastionGold', 'bastionMove', 'pearls', ...(noGiveup ? ['netherTools', 'bastionSupply'] : [])].includes(strategy.skill)) continue
    const retry = strategy.retryCondition
    strategy.retryCondition = (before, after) => !!retry?.(before, after) || !!physicalRetry(before, after)
    strategy.timeRetry = false
  }
  const mapped = new Map<string, CampaignStage>()
  for (const [id, name, seconds] of [['MappedOverworldRoute', 'route', 900], ['MappedRouteEnter', 'routeEnter', 45]] as const) {
    registry.register({ id, skill: name, version: 1,
      preconditions: state => state.alive && state.dimension === 'overworld' && !!mapped.get(name)?.needed() && !!mapped.get(name)?.ready() && !mapped.get(name)?.defer(),
      expectedEffects: { dimension: 'the_nether', facts: { portal: true, entered_nether: true, nether_ready: true },
        atLeast: { stone_tool: 1, food: 2, bucket: 1, lighter: 1 } },
      estimateCost: () => seconds * 20, estimateRisk: () => 0.04, timeoutMs: name === 'route' ? 1800000 : 240000,
      successCondition: (_before, after) => after.dimension === 'the_nether' })
  }
  applyCosts(registry, loadCosts())
  const environment = new MineflayerEnvironment({ read: port.observe, call: port.call, executeSkill: port.execute, now: port.now, sleep: port.sleep })
  const director = new StrategicDirector(registry, environment, { goal: dragonGoal, record: port.record,
    retryCondition: process.env.ND_OW_PAUSE_CAUSE === '1' ? (failed, current) =>
      failed.dimension === 'overworld' && current.dimension === 'overworld' ?
        failed.retryContext !== current.retryContext || !!(failed.position && current.position &&
          (Math.hypot(failed.position.x - current.position.x, failed.position.z - current.position.z) >= 16 ||
           Math.abs(failed.position.y - current.position.y) >= 8)) : undefined : undefined,
    retryAfterMs: Number(process.env.ND_GRAPH_RETRY_S) > 0 ? Number(process.env.ND_GRAPH_RETRY_S) * 1000 : undefined })
  const stageBySkill: Record<string, string> = { enterNether: 'nether', enterEnd: 'dragon', leaveNether: 'eyes', findFortress: 'nether', findBastions: 'bastion',
    piglinBarter: 'bastion', ruinedPortal: 'cast', portalKit: 'iron', scoutStructures: 'iron', scoutLava: 'cast', deepLavaCast: 'cast', heal: 'food', eatFood: 'food', prepareBread: 'food', structureIron: 'iron' }
  function stageFor(strategy: Strategy): string { return stageBySkill[strategy.skill] ?? strategy.skill }
  function wrapStrategy(strategy: Strategy, stage?: CampaignStage): CampaignStage {
    let outcome: SkillOutcome | undefined
    return {
      name: stage?.name ?? strategy.id,
      ...(process.env.ND_OW_PAUSE_CAUSE === '1' ? { pauseKey: strategy.id } : {}),
      needed: stage?.needed ?? (() => outcome !== 'SUCCESS'), ready: stage?.ready ?? (() => true), defer: stage?.defer ?? (() => false),
      done: () => outcome === 'SUCCESS' && (stage ? stage.done() : true),
      progressed: () => outcome === 'SUCCESS' || outcome === 'PARTIAL', interrupted: () => outcome === 'INTERRUPTED',
      run: async () => {
        const observed = await environment.observe()
        if (!observed.alive || observed.threatLevel >= 2) {
          outcome = 'INTERRUPTED'
          port.record({ level: 'decision', reason: observed.alive ? 'tactical control' : 'death', before: observed, plan: [] })
          return
        }
        outcome = (await director.run(strategy, observed)).outcome
      }
    }
  }
  function wrapRecovery(stage: CampaignStage): CampaignStage {
    const id = `Recovery_${stage.name}`
    if (!registry.get(id)) registry.register({ id, skill: stage.name, version: 1,
      preconditions: state => state.alive && stage.ready() && !stage.defer() && recoveryAllowed(stage, state), expectedEffects: {},
      estimateCost: () => 1200, estimateRisk: () => 0.02, timeoutMs: 900000, successCondition: () => stage.done(), progressCondition: progressFor(stage.name),
      ...(recoveryEnabled && ['nether', 'bastion', 'pearls'].includes(stage.name) ? { retryCondition: physicalRetry } : {}) })
    return wrapStrategy(registry.get(id)!, stage)
  }
  function recoveryAllowed(stage: CampaignStage, state: WorldState): boolean {
    if (stage.name !== 'iron' || state.dimension !== 'overworld' || state.facts.portal?.value === true) return true
    return !!registry.get('MineIron')?.preconditions(state) || !!registry.get('CraftPortalKit')?.preconditions(state)
  }
  return {
    registry, director, environment, stageFor, wrap: wrapRecovery,
    async select(stages: CampaignStage[], blocked: (stage: CampaignStage) => boolean, strategyPaused: (id: string) => boolean = () => false): Promise<{ stage: CampaignStage; strategy?: Strategy; before: WorldState } | null> {
      const before = await environment.observe()
      if (!before.alive || before.threatLevel >= 2) return null
      const available = stages.filter(stage => !blocked(stage) && stage.ready() && !stage.defer())
      mapped.clear()
      for (const stage of available) if (stage.name === 'route' || stage.name === 'routeEnter') mapped.set(stage.name, stage)
      // Маршрут по карте и кусочные стратегии конкурируют по цене (S8b 07.10: флаг-приоритет ND_ROUTE_FIRST снят; корень —
      // цена RuinedPortal/LavaPoolPortal в cost-model.ts по их фактическому этапу cast, а не по шагу ruin «только сундук»).
      const activeRecovery = recoveryEnabled && before.dimension === 'the_nether'
      const blockedNames = new Set(activeRecovery ? stages.filter(stage => ['nether', 'bastion', 'pearls'].includes(stage.name) && blocked(stage)).map(stage => stage.name) : [])
      const group = (strategy: Strategy) => ['bastionGold', 'bastionMove', 'bastionSupply'].includes(strategy.skill) ? 'bastion' : stageFor(strategy)
      const owPause = process.env.ND_OW_PAUSE_CAUSE === '1' && before.dimension === 'overworld'
      const permitted = (candidate: Strategy) => !blockedNames.has(group(candidate)) && (!owPause || !strategyPaused(candidate.id))
      const allowed = blockedNames.size || owPause ? new Set(registry.all().filter(permitted).map(candidate => candidate.id)) : undefined
      const desired = director.decide(before, allowed)
      let strategy = desired.steps[0]
      if (!strategy && activeRecovery && blockedNames.size) {
        const excluded = new Set(registry.all().filter(candidate => !allowed!.has(candidate.id) || !director.canRun(candidate, before)).map(candidate => candidate.id))
        const alternative = plan(registry, before, state => netherStageProgress('nether', before, state) || netherStageProgress('bastion', before, state) ||
          netherSupplyProgress(before, state) || ['fortress', 'bastion'].some(name => state.facts[name]?.value === true && before.facts[name]?.value !== true),
          { excluded, maxDepth: 1 })
        strategy = alternative.steps[0]
        if (strategy) port.record({ level: 'decision', reason: 'Nether alternative after refusal', before, plan: [strategy.id],
          alternatives: registry.all().filter(candidate => !excluded.has(candidate.id)).map(candidate => ({ id: candidate.id, cost: candidate.estimateCost(before), risk: candidate.estimateRisk(before) })) })
      }
      if (!strategy && desired.reason !== 'goal' && ['overworld', 'the_nether'].includes(before.dimension)) {
        const excluded = new Set(registry.all().filter(candidate => !['food', 'eatFood', 'heal', 'prepareBread'].includes(candidate.skill) ||
          !permitted(candidate) || !director.canRun(candidate, before)).map(candidate => candidate.id))
        const recovery = plan(registry, before, state => state.health > before.health || state.hunger > before.hunger ||
          amount(state, 'food') > amount(before, 'food'), { excluded, maxDepth: 1 })
        strategy = recovery.steps[0]
        if (strategy) port.record({ level: 'decision', reason: `survival recovery: ${desired.reason}`, before, plan: [strategy.id] })
      }
      if (!strategy && owPause && desired.reason !== 'goal') {
        // The dragon path may need a paused producer. Compete useful one-step alternatives by the same cost/risk model.
        const excluded = new Set(registry.all().filter(candidate => !permitted(candidate) || !director.canRun(candidate, before)).map(candidate => candidate.id))
        const alternative = plan(registry, before, after => after.health > before.health || after.hunger > before.hunger ||
          Object.entries(after.resources).some(([name, count]) => count > amount(before, name)) ||
          Object.entries(after.facts).some(([name, value]) => value.value === true && before.facts[name]?.value !== true),
          { excluded, maxDepth: 1 })
        strategy = alternative.steps[0]
        if (strategy) port.record({ level: 'decision', reason: 'OW alternative after refusal', before, plan: [strategy.id] })
      }
      if (strategy) {
        const stage = available.find(stage => stage.name === stageFor(strategy))
        if (stage) return { stage: wrapStrategy(strategy, stage), strategy, before }
        const special = ['wood', 'food', 'iron', 'structureIron', 'scoutStructures', 'scoutLava', 'deepLavaCast', 'portalKit', 'ruinedPortal', 'enterNether', 'findFortress', 'findBastions', 'piglinBarter', 'leaveNether', 'enterEnd', 'heal', 'eatFood', 'prepareBread', 'netherTools', 'bastionSupply', 'pearls', 'bastion', 'nether', 'endkit', 'bastionGold', 'bastionMove']
        if (special.includes(strategy.skill)) {
          return { stage: wrapStrategy(strategy), strategy, before }
        }
      }
      // The graph wraps mature skills incrementally; a ready legacy recovery can repair an unmodelled worn toolkit.
      const recovery = available.find(stage => {
        if (!recoveryAllowed(stage, before)) return false
        // Legacy recovery calls the same stage body: it cannot bypass a refused graph producer under another ID.
        if (owPause && (strategyPaused(`Recovery_${stage.name}`) ||
          registry.all().some(candidate => group(candidate) === stage.name && strategyPaused(candidate.id)))) return false
        const strategy = registry.get(`Recovery_${stage.name}`)
        return !strategy || director.canRun(strategy, before)
      })
      if (recovery) port.record({ level: 'decision', reason: `legacy recovery: ${desired.reason}`, before, plan: [recovery.name] })
      return recovery ? { stage: wrapRecovery(recovery), before } : null
    },
    markFact(state: WorldState, name: string, value: boolean): void { state.facts[name] = fact(value, 'observed', port.now()) }
  }
}
