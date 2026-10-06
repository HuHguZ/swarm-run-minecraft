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
  timeoutMs: number
  execute?(environment: Environment, state: WorldState, signal: AbortSignal): Promise<ExecutionResult>
  successCondition(before: WorldState, after: WorldState): boolean
  progressCondition?(before: WorldState, after: WorldState): boolean
  retryCondition?(failed: WorldState, current: WorldState): boolean
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
}
export interface DirectorOptions extends PlanOptions { goal: (state: WorldState) => boolean; maxFailures?: number; watchdogMs?: number; record?: (record: DecisionRecord) => void }
export class StrategicDirector {
  private readonly failures = new Map<string, number>()
  private readonly penalties = new Map<string, number>()
  private readonly failedAt = new Map<string, WorldState>()
  private lastProgressAt: number
  private lastKey = ''
  private active: AbortController | null = null
  constructor(readonly registry: StrategyRegistry, readonly environment: Environment, readonly options: DirectorOptions) {
    this.lastProgressAt = environment.now()
  }
  interrupt(reason = 'tactical interruption'): void { this.active?.abort(reason) }
  private exhausted(id: string): boolean { return (this.failures.get(id) ?? 0) >= (this.options.maxFailures ?? 2) }
  canRun(strategy: Strategy, state: WorldState): boolean {
    return !this.exhausted(strategy.id) && strategy.preconditions(state) && !strategy.failureCondition?.(state)
  }
  decide(state: WorldState, allowed?: ReadonlySet<string>): Plan {
    for (const [id, failed] of this.failedAt) {
      if (!this.registry.get(id)?.retryCondition?.(failed, state)) continue
      this.failures.delete(id); this.penalties.delete(id); this.failedAt.delete(id)
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
    this.options.record?.({ level: 'strategy', strategy: strategy.id, skill: strategy.skill, reason: result.reason ?? outcome, before: observed,
      after, outcome, seconds: (this.environment.now() - start) / 1000 })
    return { after, result, outcome }
  }
  verify(strategy: Strategy, before: WorldState, after: WorldState, result: ExecutionResult, timeout = false): SkillOutcome {
    const changedByTactics = after.revision !== before.revision || result.events.some(e => /tactical|emergency|death/.test(e.type))
    const outcome: SkillOutcome = !after.alive ? 'FAILURE' : timeout ? 'TIMEOUT' : changedByTactics || result.outcome === 'INTERRUPTED' ? 'INTERRUPTED' :
      strategy.successCondition(before, after) ? 'SUCCESS' : (strategy.progressCondition ?? usefulProgress)(before, after) ? 'PARTIAL' : result.outcome === 'TIMEOUT' ? 'TIMEOUT' : 'FAILURE'
    const key = stateKey(after)
    if (outcome === 'SUCCESS' || outcome === 'PARTIAL') {
      this.failures.delete(strategy.id)
      this.penalties.delete(strategy.id)
      this.failedAt.delete(strategy.id)
      if (key !== this.lastKey) { this.lastProgressAt = this.environment.now(); this.lastKey = key }
    } else if (outcome !== 'INTERRUPTED') {
      this.failures.set(strategy.id, (this.failures.get(strategy.id) ?? 0) + 1)
      this.failedAt.set(strategy.id, cloneWorld(strategy.retryCondition?.(before, after) ? before : after))
      this.penalties.set(strategy.id, (this.penalties.get(strategy.id) ?? 0) + Math.max(1200, strategy.estimateCost(before)))
    }
    return outcome
  }
}
