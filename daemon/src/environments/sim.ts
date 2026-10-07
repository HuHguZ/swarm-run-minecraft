import type { Environment, ExecutionResult, SkillCommand } from '../core/environment'
import { applyEffect, cloneWorld, emptyWorld, fact, stateKey, type Effect, type WorldState } from '../core/world-state'
import type { Strategy, StrategyRegistry } from '../core/strategy'
import { modelFor, type CostModel } from '../core/cost-model'

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
/** Per-attempt outcome chances and time of one strategy in the current state. */
export interface AttemptModel { seconds: number; sigma: number; death: number; success: number; partial: number; interrupt: number; source: 'legacy' | 'measured' | 'prior'
  /** Measured mean resource change of a PARTIAL attempt (replaces the half-way guess). */
  partialGain?: Record<string, number> }
/** Weight of the prior success chance in attempts, the same 5 as applyCosts. */
const PRIOR_WEIGHT = 5
/** Log-normal spread when no p90 is measured (p90 ≈ 1.6 × median). */
const DEFAULT_SIGMA = 0.35
export function attemptModel(strategy: Strategy, state: WorldState, costs: ReadonlyMap<string, CostModel>, legacy?: SkillModel): AttemptModel {
  const risk = strategy.estimateRisk(state)
  if (legacy) return { seconds: legacy.seconds, sigma: DEFAULT_SIGMA, death: legacy.death, success: legacy.success, partial: 0, interrupt: 0, source: 'legacy' }
  const prior = Math.max(0, Math.min(1, strategy.successChance?.(state) ?? 1 - risk))
  const measured = modelFor(strategy, state, costs)
  if (!measured) return { seconds: strategy.estimateCost(state) / 20, sigma: DEFAULT_SIGMA, death: risk, success: prior, partial: 0, interrupt: 0, source: 'prior' }
  // Deaths: the same risk the planner prices (applyCosts blends measured deaths into it); outcomes below are conditional on surviving.
  const n = measured.samples + PRIOR_WEIGHT
  const sigma = measured.p90Ticks > measured.medianTicks ? Math.min(1.2, Math.max(0.1, Math.log(measured.p90Ticks / measured.medianTicks) / 1.2816)) : DEFAULT_SIGMA
  return { seconds: measured.medianTicks / 20 + (strategy.travelTicks?.(state) ?? 0) / 20, sigma, death: risk,
    success: (measured.successes + PRIOR_WEIGHT * prior) / n, partial: (measured.partials ?? 0) / n, interrupt: (measured.interrupts ?? 0) / n, source: 'measured',
    // Five measured partials before their mean replaces the half-way prior (the same floor as modelFor).
    ...(measured.partialGain && (measured.partials ?? 0) >= 5 ? { partialGain: measured.partialGain } : {}) }
}
/** Half of every gain of the effect: the generic PARTIAL of a quantity strategy; facts and dimension stay unreached. */
/** Measured PARTIAL: the mean change of the effect's own resources (and gold, the barter currency), drawn as whole items. */
export function measuredPartial(effect: Effect, gain: Record<string, number>, random: () => number): Effect {
  const keys = new Set([...Object.keys(effect.resources ?? {}), ...Object.keys(effect.atLeast ?? {}), 'gold'])
  const resources: Record<string, number> = {}
  for (const [key, mean] of Object.entries(gain)) {
    if (!keys.has(key)) continue
    const size = Math.abs(mean), whole = Math.floor(size) + (random() < size - Math.floor(size) ? 1 : 0)
    if (whole) resources[key] = Math.sign(mean) * whole
  }
  return { resources }
}
export function partialEffect(state: WorldState, effect: Effect): Effect {
  const resources: Record<string, number> = {}
  for (const [key, delta] of Object.entries(effect.resources ?? {})) resources[key] = delta > 0 ? Math.floor(delta / 2) : delta
  const atLeast: Record<string, number> = {}
  for (const [key, target] of Object.entries(effect.atLeast ?? {})) {
    const have = state.resources[key] ?? 0
    if (target > have) atLeast[key] = have + Math.ceil((target - have) / 2)
  }
  return { resources, atLeast }
}
export interface SimIncident { type: 'interrupt' | 'death' | 'timeout'; strategy: string; atMs: number }
export interface SimOptions {
  seed?: number; state?: WorldState; models?: ReadonlyMap<string, SkillModel>; costs?: CostModel[]; deterministic?: boolean
  /** Draw attempt times from a log-normal (median, p90) instead of the median. */
  spread?: boolean
}
export class SimEnvironment implements Environment {
  private state: WorldState
  private randomState: number
  readonly models: ReadonlyMap<string, SkillModel>
  private readonly costs: ReadonlyMap<string, CostModel>
  /** Interruptions, deaths and timeouts drawn so far (frequencies from telemetry). */
  readonly incidents: SimIncident[] = []
  constructor(readonly registry: StrategyRegistry, private readonly options: SimOptions = {}) {
    this.state = cloneWorld(options.state ?? emptyWorld())
    // Mix the seed (murmur3 finalizer): consecutive seeds of an LCG start on a lattice and bias the first draws.
    let h = (options.seed ?? 1) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
    this.randomState = (h ^ (h >>> 16)) >>> 0
    this.models = options.models ?? new Map()
    this.costs = new Map((options.costs ?? []).map(model => [model.key, model]))
  }
  random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 0x100000000
  }
  private normal(): number { return Math.sqrt(-2 * Math.log(1 - this.random())) * Math.cos(2 * Math.PI * this.random()) }
  async observe(): Promise<WorldState> { return cloneWorld(this.state) }
  async execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult> {
    if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
    const strategy = command.strategy ? this.registry.get(command.strategy) : this.registry.all().find(s => s.skill === command.skill && s.preconditions(this.state))
    if (!strategy || !strategy.preconditions(this.state)) return { outcome: 'FAILURE', reason: 'preconditions', events: [] }
    // Обе стратегии портала исполняют этап cast (как core/cost-model.ts, S8b/S8c 07.10): «ruin» — лишь сундук шага маршрута.
    const aliases: Record<string, string> = { VillageIron: 'village', ShipwreckIron: 'ship', TreasureIron: 'treasure', LavaPoolPortal: 'cast', RuinedPortal: 'cast',
      AcquireWood: 'wood', AcquireStoneTools: 'stone', MineIron: 'iron', BastionBarter: 'bastion' }
    const legacy = this.models.get(strategy.id) ?? this.models.get(strategy.skill) ?? this.models.get(aliases[strategy.id] ?? '')
    const model = attemptModel(strategy, this.state, this.costs, legacy)
    const effect = () => typeof strategy.expectedEffects === 'function' ? strategy.expectedEffects(this.state) : strategy.expectedEffects
    let seconds = this.options.spread && !this.options.deterministic ? model.seconds * Math.exp(model.sigma * this.normal()) : model.seconds
    if (this.options.deterministic) {
      this.state.elapsedMs += seconds * 1000
      this.state = applyEffect(this.state, effect(), 'simulated')
      return { outcome: 'SUCCESS', events: [] }
    }
    const roll = this.random()
    if (roll < model.death) {
      this.state.elapsedMs += Math.min(seconds, strategy.timeoutMs / 1000) * 1000
      this.state.alive = false; this.state.health = 0; this.state.inventory = {}; this.state.resources = {}
      this.incidents.push({ type: 'death', strategy: strategy.id, atMs: this.state.elapsedMs })
      return { outcome: 'FAILURE', reason: 'simulated death', events: [{ type: 'death' }] }
    }
    const rest = (roll - model.death) / Math.max(1e-9, 1 - model.death)
    if (rest < model.interrupt) {
      // Tactics took over part-way: time is lost, the strategy's state is unchanged (telemetry: ~0 hp lost on average).
      this.state.elapsedMs += seconds * 1000 * (0.1 + 0.5 * this.random())
      this.state.revision++
      this.incidents.push({ type: 'interrupt', strategy: strategy.id, atMs: this.state.elapsedMs })
      return { outcome: 'INTERRUPTED', reason: 'simulated tactical interruption', events: [{ type: 'tactical' }] }
    }
    if (seconds >= strategy.timeoutMs / 1000) {
      // The director cancels at its deadline; half the work is done by then.
      this.state.elapsedMs += strategy.timeoutMs
      this.state = applyEffect(this.state, partialEffect(this.state, effect()), 'simulated')
      this.incidents.push({ type: 'timeout', strategy: strategy.id, atMs: this.state.elapsedMs })
      return { outcome: 'TIMEOUT', reason: 'simulated strategy timeout', events: [] }
    }
    this.state.elapsedMs += seconds * 1000
    const u = rest - model.interrupt
    if (strategy.sampleEffects && u < model.success + model.partial) {
      // A mechanistic draw (barter loot) decides between success and partial progress itself.
      this.state = applyEffect(this.state, strategy.sampleEffects(this.state, () => this.random()), 'simulated')
      return { outcome: 'SUCCESS', events: [] }
    }
    if (u < model.success) {
      this.state = applyEffect(this.state, effect(), 'simulated')
      return { outcome: 'SUCCESS', events: [] }
    }
    if (u < model.success + model.partial) {
      const next = applyEffect(this.state, model.partialGain ? measuredPartial(effect(), model.partialGain, () => this.random()) : partialEffect(this.state, effect()), 'simulated')
      if (stateKey(next) !== stateKey(this.state)) {
        this.state = next
        return { outcome: 'PARTIAL', events: [] }
      }
    }
    return { outcome: 'FAILURE', reason: 'sampled skill failure', events: [] }
  }
  async cancel(_reason: string): Promise<void> {}
  now(): number { return this.state.elapsedMs }
  async sleep(milliseconds: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); this.state.elapsedMs += milliseconds }
  setFact(name: string, value: boolean): void { this.state.facts[name] = fact(value, 'simulated', this.now()) }
  /** Start a fresh world (ResetRun): the clock keeps running, everything else is the initial state. */
  reset(state: WorldState = emptyWorld()): void {
    const elapsed = this.state.elapsedMs
    this.state = cloneWorld(state)
    this.state.elapsedMs = elapsed
  }
}
