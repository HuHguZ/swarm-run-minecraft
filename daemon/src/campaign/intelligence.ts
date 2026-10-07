import type { ExecutionResult, SkillCommand, SkillOutcome } from '../core/environment'
import { fact, type WorldState } from '../core/world-state'
import { StrategicDirector, type DecisionRecord, type Strategy } from '../core/strategy'
import { dragonGoal, speedrunRegistry } from '../core/speedrun'
import { applyCosts } from '../core/cost-model'
import { MineflayerEnvironment, type Observation } from '../environments/mineflayer'
import { loadCosts } from '../environments/cost-data'
import { netherStageProgress, netherSupplyProgress } from './nether-progress'

export interface CampaignStage {
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
}
export function createCampaignIntelligence(port: CampaignPort) {
  // Flags from the S3 simulator search (06.10), off by default — нужна ферма: ND_GRAPH_ECONOMY=1 needs the skills
  // bastionGold {ingots} and bastionMove in the campaign (S1); ND_GRAPH_RETRY_S — timed re-admission backoff (sim: 60–120 s beat 300 s).
  const registry = speedrunRegistry({ eyes: port.eyes, beds: port.beds, economy: process.env.ND_GRAPH_ECONOMY === '1' })
  const progressFor = (skill: string): Strategy['progressCondition'] => skill === 'netherTools' ? netherSupplyProgress : ['bastion', 'bastionSupply', 'piglinBarter', 'nether'].includes(skill)
    ? (before, after) => netherStageProgress(skill === 'nether' ? 'nether' : 'bastion', before, after) : undefined
  for (const strategy of registry.all()) {
    const progress = progressFor(strategy.skill)
    if (progress) strategy.progressCondition = progress
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
    retryAfterMs: Number(process.env.ND_GRAPH_RETRY_S) > 0 ? Number(process.env.ND_GRAPH_RETRY_S) * 1000 : undefined })
  const stageBySkill: Record<string, string> = { enterNether: 'nether', enterEnd: 'dragon', leaveNether: 'eyes', findFortress: 'nether', findBastions: 'bastion',
    piglinBarter: 'bastion', ruinedPortal: 'cast', portalKit: 'iron', scoutStructures: 'iron', scoutLava: 'cast', heal: 'food', structureIron: 'iron' }
  function stageFor(strategy: Strategy): string { return stageBySkill[strategy.skill] ?? strategy.skill }
  function wrapStrategy(strategy: Strategy, stage?: CampaignStage): CampaignStage {
    let outcome: SkillOutcome | undefined
    return {
      name: stage?.name ?? strategy.id,
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
      estimateCost: () => 1200, estimateRisk: () => 0.02, timeoutMs: 900000, successCondition: () => stage.done(), progressCondition: progressFor(stage.name) })
    return wrapStrategy(registry.get(id)!, stage)
  }
  function recoveryAllowed(stage: CampaignStage, state: WorldState): boolean {
    if (stage.name !== 'iron' || state.dimension !== 'overworld' || state.facts.portal?.value === true) return true
    return !!registry.get('MineIron')?.preconditions(state) || !!registry.get('CraftPortalKit')?.preconditions(state)
  }
  return {
    registry, director, environment, stageFor, wrap: wrapRecovery,
    async select(stages: CampaignStage[], blocked: (stage: CampaignStage) => boolean): Promise<{ stage: CampaignStage; strategy?: Strategy; before: WorldState } | null> {
      const before = await environment.observe()
      if (!before.alive || before.threatLevel >= 2) return null
      const available = stages.filter(stage => !blocked(stage) && stage.ready() && !stage.defer())
      mapped.clear()
      for (const stage of available) if (stage.name === 'route' || stage.name === 'routeEnter') mapped.set(stage.name, stage)
      // Маршрут по карте и кусочные стратегии конкурируют по цене (S8b 07.10: флаг-приоритет ND_ROUTE_FIRST снят; корень —
      // цена RuinedPortal/LavaPoolPortal в cost-model.ts по их фактическому этапу cast, а не по шагу ruin «только сундук»).
      const desired = director.decide(before)
      const strategy = desired.steps[0]
      if (strategy) {
        const stage = available.find(stage => stage.name === stageFor(strategy))
        if (stage) return { stage: wrapStrategy(strategy, stage), strategy, before }
        const special = ['wood', 'iron', 'structureIron', 'scoutStructures', 'scoutLava', 'portalKit', 'ruinedPortal', 'enterNether', 'findFortress', 'findBastions', 'piglinBarter', 'leaveNether', 'enterEnd', 'heal', 'netherTools', 'bastionSupply', 'pearls', 'bastion', 'nether', 'endkit', 'bastionGold', 'bastionMove']
        if (special.includes(strategy.skill)) {
          return { stage: wrapStrategy(strategy), strategy, before }
        }
      }
      // The graph wraps mature skills incrementally; a ready legacy recovery can repair an unmodelled worn toolkit.
      const recovery = available.find(stage => {
        if (!recoveryAllowed(stage, before)) return false
        const strategy = registry.get(`Recovery_${stage.name}`)
        return !strategy || director.canRun(strategy, before)
      })
      if (recovery) port.record({ level: 'decision', reason: `legacy recovery: ${desired.reason}`, before, plan: [recovery.name] })
      return recovery ? { stage: wrapRecovery(recovery), before } : null
    },
    markFact(state: WorldState, name: string, value: boolean): void { state.facts[name] = fact(value, 'observed', port.now()) }
  }
}
