import type { Environment, ExecutionResult, SkillCommand } from '../core/environment'
import { applyEffect, cloneWorld, emptyWorld, fact, type WorldState } from '../core/world-state'
import type { StrategyRegistry } from '../core/strategy'
import { modelFor, mortalitySamples, type CostModel } from '../core/cost-model'

export interface SkillModel { seconds: number; success: number; death: number; samples?: number }
export interface TelemetrySample { level?: string; strategy?: string; skill?: string; stage?: string; kind?: string; sec?: number; seconds?: number; ok?: boolean; outcome?: string; death?: boolean }
export function calibrate(samples: Iterable<TelemetrySample>): Map<string, SkillModel> {
  const groups = new Map<string, { seconds: number[]; success: number; death: number; total: number }>()
  for (const sample of samples) {
    const key = sample.strategy ?? (sample.level === 'stage' ? sample.stage : sample.level === 'step' ? sample.kind : sample.skill)
    const seconds = sample.sec ?? sample.seconds
    if (!key || !Number.isFinite(seconds) || seconds! < 0) continue
    const group = groups.get(key) ?? { seconds: [], success: 0, death: 0, total: 0 }
    group.seconds.push(seconds!)
    group.success += sample.ok || sample.outcome === 'SUCCESS' ? 1 : 0
    group.death += sample.death ? 1 : 0
    group.total++
    groups.set(key, group)
  }
  return new Map([...groups].map(([key, group]) => {
    const sorted = group.seconds.sort((a, b) => a - b)
    return [key, { seconds: sorted[Math.floor(sorted.length / 2)]!, success: group.success / group.total, death: group.death / group.total, samples: group.total }]
  }))
}
export interface SimOptions { seed?: number; state?: WorldState; models?: ReadonlyMap<string, SkillModel>; costs?: CostModel[]; deterministic?: boolean }
export class SimEnvironment implements Environment {
  private state: WorldState
  private randomState: number
  readonly models: ReadonlyMap<string, SkillModel>
  private readonly costs: ReadonlyMap<string, CostModel>
  constructor(readonly registry: StrategyRegistry, private readonly options: SimOptions = {}) {
    this.state = cloneWorld(options.state ?? emptyWorld())
    this.randomState = options.seed ?? 1
    this.models = options.models ?? new Map()
    this.costs = new Map((options.costs ?? []).map(model => [model.key, model]))
  }
  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 0x100000000
  }
  async observe(): Promise<WorldState> { return cloneWorld(this.state) }
  async execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult> {
    if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
    const strategy = command.strategy ? this.registry.get(command.strategy) : this.registry.all().find(s => s.skill === command.skill && s.preconditions(this.state))
    if (!strategy || !strategy.preconditions(this.state)) return { outcome: 'FAILURE', reason: 'preconditions', events: [] }
    const aliases: Record<string, string> = { VillageIron: 'village', ShipwreckIron: 'ship', TreasureIron: 'treasure', LavaPoolPortal: 'castSky', RuinedPortal: 'ruin',
      AcquireWood: 'wood', AcquireStoneTools: 'stone', MineIron: 'iron', BastionBarter: 'bastion', GetBlazeRods: 'nether' }
    const risk = strategy.estimateRisk(this.state)
    const measured = modelFor(strategy, this.state, this.costs)
    const deathCount = measured ? mortalitySamples(measured) : 0
    const calibrated = measured ? { seconds: measured.medianTicks / 20,
      success: measured.successes / measured.samples * (deathCount ? 1 : 1 - risk),
      death: deathCount ? measured.deaths / deathCount : risk } : undefined
    const model = this.models.get(strategy.id) ?? this.models.get(strategy.skill) ?? this.models.get(aliases[strategy.id] ?? '') ?? calibrated ?? { seconds: strategy.estimateCost(this.state) / 20, success: 1 - risk, death: risk }
    this.state.elapsedMs += model.seconds * 1000
    const outcome = this.random()
    if (!this.options.deterministic && outcome < model.death) {
      this.state.alive = false; this.state.health = 0; this.state.inventory = {}; this.state.resources = {}
      return { outcome: 'FAILURE', reason: 'simulated death', events: [{ type: 'death' }] }
    }
    if (!this.options.deterministic && outcome >= Math.min(1, model.death + model.success)) return { outcome: 'FAILURE', reason: 'sampled skill failure', events: [] }
    const effect = typeof strategy.expectedEffects === 'function' ? strategy.expectedEffects(this.state) : strategy.expectedEffects
    this.state = applyEffect(this.state, effect, 'simulated')
    return { outcome: 'SUCCESS', events: [] }
  }
  async cancel(_reason: string): Promise<void> {}
  now(): number { return this.state.elapsedMs }
  async sleep(milliseconds: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); this.state.elapsedMs += milliseconds }
  setFact(name: string, value: boolean): void { this.state.facts[name] = fact(value, 'simulated', this.now()) }
}
