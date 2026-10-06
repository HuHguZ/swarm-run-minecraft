import type { Environment, ExecutionResult, SkillCommand, SkillOutcome } from './environment'
import { applyEffect, cloneWorld, stateKey, usefulProgress, type Effect, type WorldState } from './world-state'

export interface Strategy {
  id: string
  version: number
  skill: string
  preconditions(state: WorldState): boolean
  expectedEffects: Effect | ((state: WorldState) => Effect)
  /** Expected cost in game ticks (20 ticks per game second). */
  estimateCost(state: WorldState): number
  estimateRisk(state: WorldState): number
  /** Part of estimateCost spent travelling to a known target; kept out of the telemetry blend. */
  travelTicks?(state: WorldState): number
  /** The cost comes from a mechanistic model (barter): telemetry medians must not override it. */
  modelCost?: boolean
  /** Prior P(SUCCESS) of one attempt for the simulator; default 1 − risk. */
  successChance?(state: WorldState): number
  /** Simulator only: one random draw of the effect of a completed attempt (e.g. pearls from n bartered ingots). */
  sampleEffects?(state: WorldState, random: () => number): Effect
  timeoutMs: number
  execute?(environment: Environment, state: WorldState, signal: AbortSignal): Promise<ExecutionResult>
  successCondition(before: WorldState, after: WorldState): boolean
  progressCondition?(before: WorldState, after: WorldState): boolean
  retryCondition?(failed: WorldState, current: WorldState): boolean
  /** With a retryCondition: the generic game-time backoff re-admits it too (piglins wander back; a site stays stalled). */
  timeRetry?: boolean
  failureCondition?(state: WorldState): string | null
  command?(state: WorldState): SkillCommand
}
export class StrategyRegistry {
  private readonly entries = new Map<string, Strategy>()
  register(strategy: Strategy): this {
    if (this.entries.has(strategy.id)) throw new Error(`Duplicate strategy: ${strategy.id}`)
    if (!(strategy.timeoutMs > 0)) throw new Error(`Invalid timeout: ${strategy.id}`)
    this.entries.set(strategy.id, { ...strategy, failureCondition: strategy.failureCondition ?? (state => state.alive ? null : 'death'),
      execute: strategy.execute ?? ((environment, state, signal) => environment.execute(strategy.command?.(state) ?? { skill: strategy.skill, strategy: strategy.id }, signal)) })
    return this
  }
  get(id: string): Strategy | undefined { return this.entries.get(id) }
  all(): Strategy[] { return [...this.entries.values()] }
}
export interface Plan { steps: Strategy[]; cost: number; expanded: number; reason: 'goal' | 'bounded' | 'unreachable' }
export interface PlanOptions { maxStates?: number; maxDepth?: number; riskPenalty?: number; excluded?: ReadonlySet<string>; penalties?: ReadonlyMap<string, number>; retryStates?: ReadonlyMap<string, WorldState> }
export function plan(registry: StrategyRegistry, start: WorldState, goal: (state: WorldState) => boolean, options: PlanOptions = {}): Plan {
  const maxStates = options.maxStates ?? 6000
  const maxDepth = options.maxDepth ?? 32
  const queue: Array<{ state: WorldState; steps: Strategy[]; cost: number }> = [{ state: start, steps: [], cost: 0 }]
  const visited = new Map<string, number>([[stateKey(start), 0]])
  let expanded = 0
  // ponytail: a sorted frontier suffices for the small milestone graph; use a heap if the measured frontier grows.
  while (queue.length && expanded < maxStates) {
    queue.sort((a, b) => a.cost - b.cost)
    const current = queue.shift()!
    if (current.cost > (visited.get(stateKey(current.state)) ?? Infinity)) continue
    if (goal(current.state)) return { steps: current.steps, cost: current.cost, expanded, reason: 'goal' }
    expanded++
    if (current.steps.length >= maxDepth) continue
    for (const strategy of registry.all()) {
      if (options.excluded?.has(strategy.id)) {
        const failed = options.retryStates?.get(strategy.id)
        if (!failed || !strategy.retryCondition?.(failed, current.state)) continue
      }
      if (!strategy.preconditions(current.state) || strategy.failureCondition?.(current.state)) continue
      const effect = typeof strategy.expectedEffects === 'function' ? strategy.expectedEffects(current.state) : strategy.expectedEffects
      const next = applyEffect(current.state, effect)
      const key = stateKey(next)
      if (key === stateKey(current.state)) continue
      const estimate = strategy.estimateCost(current.state)
      const risk = strategy.estimateRisk(current.state)
      if (!Number.isFinite(estimate) || estimate < 0 || !Number.isFinite(risk) || risk < 0 || risk > 1) continue
      const cost = current.cost + estimate + risk * (options.riskPenalty ?? 72000) + (options.penalties?.get(strategy.id) ?? 0)
      if (cost >= (visited.get(key) ?? Infinity)) continue
      visited.set(key, cost)
      queue.push({ state: next, steps: [...current.steps, strategy], cost })
    }
  }
  return { steps: [], cost: Infinity, expanded, reason: queue.length ? 'bounded' : 'unreachable' }
}
export interface DecisionRecord {
  level: 'decision' | 'strategy'
  strategy?: string
  skill?: string
  reason: string
  plan?: string[]
  alternatives?: Array<{ id: string; cost: number; risk: number }>
  before: WorldState
  after?: WorldState
  outcome?: SkillOutcome
  seconds?: number
  death?: boolean
}
export interface DirectorOptions extends PlanOptions {
  goal: (state: WorldState) => boolean
  maxFailures?: number
  watchdogMs?: number
  record?: (record: DecisionRecord) => void
  /** Game ms before an exhausted strategy without its own retryCondition is offered again; doubles every round. */
  retryAfterMs?: number
  /** Consecutive INTERRUPTED outcomes without progress that count as one FAILURE (tactics keep stopping the skill). */
  maxInterrupts?: number
}
export class StrategicDirector {
  private readonly failures = new Map<string, number>()
  private readonly penalties = new Map<string, number>()
  private readonly failedAt = new Map<string, WorldState>()
  /** Exhaustion bookkeeping for re-admission: game time, progress counter and how many times it was exhausted. */
  private readonly exhaustedAt = new Map<string, { at: number; progress: number; rounds: number }>()
  private readonly interrupts = new Map<string, number>()
  private progressCount = 0
  private lastReason = ''
  private lastProgressAt: number
  private lastKey = ''
  private active: AbortController | null = null
  constructor(readonly registry: StrategyRegistry, readonly environment: Environment, readonly options: DirectorOptions) {
    this.lastProgressAt = environment.now()
  }
  interrupt(reason = 'tactical interruption'): void { this.active?.abort(reason) }
  private exhausted(id: string): boolean { return (this.failures.get(id) ?? 0) >= (this.options.maxFailures ?? 2) }
  /** Generic re-admission: game-time backoff (5, 10, 20… min) or, in the first two rounds, progress by any strategy. */
  private cooledDown(id: string): boolean {
    const mark = this.exhaustedAt.get(id)
    if (!mark || !this.exhausted(id)) return false
    return this.environment.now() - mark.at >= (this.options.retryAfterMs ?? 300000) * 2 ** (mark.rounds - 1) ||
      (mark.rounds < 3 && this.progressCount > mark.progress)
  }
  /** Earliest game time at which a time-based re-admission can change an unreachable plan (null: none pending). */
  nextRetryAt(): number | null {
    let wake: number | null = null
    for (const [id, mark] of this.exhaustedAt) {
      const strategy = this.registry.get(id)
      if (!this.exhausted(id) || (strategy?.retryCondition && !strategy.timeRetry)) continue
      const at = mark.at + (this.options.retryAfterMs ?? 300000) * 2 ** (mark.rounds - 1)
      wake = wake === null ? at : Math.min(wake, at)
    }
    return wake
  }
  private fail(strategy: Strategy, before: WorldState, after: WorldState): void {
    const failures = (this.failures.get(strategy.id) ?? 0) + 1
    this.failures.set(strategy.id, failures)
    this.failedAt.set(strategy.id, cloneWorld(strategy.retryCondition?.(before, after) ? before : after))
    this.penalties.set(strategy.id, (this.penalties.get(strategy.id) ?? 0) + Math.max(1200, strategy.estimateCost(before)))
    if (failures === (this.options.maxFailures ?? 2)) this.exhaustedAt.set(strategy.id,
      { at: this.environment.now(), progress: this.progressCount, rounds: (this.exhaustedAt.get(strategy.id)?.rounds ?? 0) + 1 })
  }
  /** Strategies currently excluded after maxFailures (for telemetry and the simulator's dead-end report). */
  exhaustedStrategies(): string[] { return [...this.failures.keys()].filter(id => this.exhausted(id)) }
  canRun(strategy: Strategy, state: WorldState): boolean {
    return !this.exhausted(strategy.id) && strategy.preconditions(state) && !strategy.failureCondition?.(state)
  }
  decide(state: WorldState, allowed?: ReadonlySet<string>): Plan {
    for (const [id, failed] of this.failedAt) {
      const strategy = this.registry.get(id)
      if (!strategy) continue
      if (strategy.retryCondition?.(failed, state)) {
        // An explicit retryCondition is domain knowledge (a new bastion site, more gold): a clean slate.
        this.failures.delete(id); this.penalties.delete(id); this.failedAt.delete(id); this.exhaustedAt.delete(id)
      } else if ((!strategy.retryCondition || strategy.timeRetry) && this.cooledDown(id)) {
        // Penalties stay: alternatives remain preferred, but a lone path is no longer lost for the whole run.
        this.failures.delete(id); this.failedAt.delete(id)
      }
    }
    const excluded = new Set([...(this.options.excluded ?? []), ...this.registry.all().filter(s => this.exhausted(s.id) || (allowed && !allowed.has(s.id))).map(s => s.id)])
    const retryStates = new Map([...this.failedAt].filter(([id]) => !this.options.excluded?.has(id) && (!allowed || allowed.has(id))))
    const selected = plan(this.registry, state, this.options.goal, { ...this.options, excluded, retryStates, penalties: this.penalties })
    this.options.record?.({ level: 'decision', reason: selected.reason, before: state, plan: selected.steps.map(s => s.id),
      alternatives: this.registry.all().filter(s => s.preconditions(state) && !excluded.has(s.id)).map(s => ({ id: s.id, cost: s.estimateCost(state), risk: s.estimateRisk(state) })) })
    return selected
  }
  async tick(): Promise<{ state: WorldState; strategy?: Strategy; result?: ExecutionResult; outcome?: SkillOutcome; stopped?: string }> {
    const before = cloneWorld(await this.environment.observe())
    if (!before.alive) return { state: before, stopped: 'death' }
    if (this.options.goal(before)) return { state: before, stopped: 'goal' }
    if (before.threatLevel >= 2) return { state: before, stopped: 'tactical' }
    if (this.environment.now() - this.lastProgressAt > (this.options.watchdogMs ?? 15 * 60000)) return { state: before, stopped: 'watchdog' }
    const selected = this.decide(before)
    const strategy = selected.steps[0]
    if (!strategy) return { state: before, stopped: selected.reason }
    const result = await this.run(strategy, before)
    return { state: result.after, strategy, result: result.result, outcome: result.outcome }
  }
  async run(strategy: Strategy, before?: WorldState): Promise<{ after: WorldState; result: ExecutionResult; outcome: SkillOutcome }> {
    const observed = cloneWorld(before ?? await this.environment.observe())
    if (!strategy.preconditions(observed)) throw new Error(`Preconditions changed: ${strategy.id}`)
    const controller = new AbortController()
    this.active = controller
    const start = this.environment.now()
    let timer: ReturnType<typeof setInterval> | undefined
    let onAbort: () => void = () => undefined
    const interrupted = new Promise<ExecutionResult>(resolve => {
      onAbort = () => {
        const reason = String(controller.signal.reason)
        void this.environment.cancel(reason).catch(() => undefined).then(() => resolve({ outcome: reason === 'strategy timeout' ? 'TIMEOUT' : 'INTERRUPTED', reason, events: [] }))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setInterval(() => {
        if (this.environment.now() - start < strategy.timeoutMs || controller.signal.aborted) return
        controller.abort('strategy timeout')
      }, 25)
    })
    let result: ExecutionResult
    try { result = await Promise.race([strategy.execute ? strategy.execute(this.environment, observed, controller.signal) : this.environment.execute(strategy.command?.(observed) ?? { skill: strategy.skill, strategy: strategy.id }, controller.signal), interrupted]) }
    catch (error) { result = { outcome: controller.signal.aborted ? 'INTERRUPTED' : 'FAILURE', reason: error instanceof Error ? error.message : String(error), events: [] } }
    finally { if (timer) clearInterval(timer); controller.signal.removeEventListener('abort', onAbort); this.active = null }
    const after = await this.environment.observe()
    const outcome = this.verify(strategy, observed, after, result, (controller.signal.aborted && controller.signal.reason === 'strategy timeout') || this.environment.now() - start >= strategy.timeoutMs)
    this.options.record?.({ level: 'strategy', strategy: strategy.id, skill: strategy.skill, reason: this.lastReason || (result.reason ?? outcome), before: observed,
      after, outcome, seconds: (this.environment.now() - start) / 1000, death: !after.alive })
    return { after, result, outcome }
  }
  verify(strategy: Strategy, before: WorldState, after: WorldState, result: ExecutionResult, timeout = false): SkillOutcome {
    const changedByTactics = after.revision !== before.revision || result.events.some(e => /tactical|emergency|death/.test(e.type))
    const succeeded = strategy.successCondition(before, after)
    const progressed = succeeded || (strategy.progressCondition ?? usefulProgress)(before, after)
    let outcome: SkillOutcome = !after.alive ? 'FAILURE' : timeout ? 'TIMEOUT' : changedByTactics || result.outcome === 'INTERRUPTED' ? 'INTERRUPTED' :
      succeeded ? 'SUCCESS' : progressed ? 'PARTIAL' : result.outcome === 'TIMEOUT' ? 'TIMEOUT' : 'FAILURE'
    this.lastReason = ''
    const key = stateKey(after)
    if (outcome === 'SUCCESS' || outcome === 'PARTIAL') {
      this.failures.delete(strategy.id)
      this.penalties.delete(strategy.id)
      this.failedAt.delete(strategy.id)
      this.exhaustedAt.delete(strategy.id)
      this.interrupts.delete(strategy.id)
      if (key !== this.lastKey) { this.lastProgressAt = this.environment.now(); this.lastKey = key; this.progressCount++ }
    } else if (outcome === 'INTERRUPTED') {
      // Tactics may stop a skill, but one they stop every time without progress must not restart forever.
      const count = progressed ? 0 : (this.interrupts.get(strategy.id) ?? 0) + 1
      if (count >= (this.options.maxInterrupts ?? 3)) {
        this.interrupts.delete(strategy.id)
        this.lastReason = `interrupted ${count} times without progress`
        outcome = 'FAILURE'
        this.fail(strategy, before, after)
      } else this.interrupts.set(strategy.id, count)
    } else this.fail(strategy, before, after)
    return outcome
  }
}
