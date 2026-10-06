import fs from 'node:fs'
import { speedrunRegistry, dragonGoal, type SpeedrunOptions } from './src/core/speedrun'
import { StrategicDirector, type DecisionRecord, type DirectorOptions } from './src/core/strategy'
import { calibrate, SimEnvironment, type TelemetrySample } from './src/environments/sim'
import { loadCosts } from './src/environments/cost-data'
import { modelFor, type CostModel } from './src/core/cost-model'
import { cloneWorld, emptyWorld, stateKey, type WorldState } from './src/core/world-state'

export interface SimulateOptions {
  sampled?: boolean; costs?: CostModel[]
  /** Registry variant (economy, eyes, beds…) and the starting world (facts from the copy of the world). */
  registry?: SpeedrunOptions; state?: WorldState
  /** Same watchdog as the campaign (ND_WATCHDOG_MIN, 45 min of game time without progress). */
  watchdogMs?: number
  /** Director overrides (retryAfterMs, maxInterrupts, maxFailures…) for what-if runs. */
  director?: Partial<DirectorOptions>
  maxSteps?: number
}
/** One simulated world: how it ended and when the milestones were reached (game seconds). */
export interface WorldTrace { end: 'goal' | 'death' | string; seconds: number; nether?: number; leftNether?: number; end_dim?: number; strategies: string[] }
const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!)
}
const bump = (map: Record<string, number>, key: string, n = 1) => { map[key] = (map[key] ?? 0) + n }
function brief(state: WorldState): string {
  const r = state.resources
  const keys = ['iron', 'gold', 'pearls', 'rods', 'eyes'].filter(k => (r[k] ?? 0) > 0).map(k => `${k} ${Math.round(r[k]!)}`)
  return `${state.dimension}${keys.length ? ': ' + keys.join(', ') : ''}`
}
export async function simulate(runs: number, seed = 1, files: string[] = [], options: SimulateOptions = {}) {
  const samples: TelemetrySample[] = []
  for (const filename of files) for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { samples.push(JSON.parse(line) as TelemetrySample) } catch {}
  }
  const models = calibrate(samples)
  const costs = options.costs ?? loadCosts()
  const deterministic = !options.sampled && files.length === 0
  const registry = speedrunRegistry({ ...options.registry, costs })
  const measured = new Map(costs.map(model => [model.key, model]))
  const strategyCoverage = registry.all().filter(strategy => ['overworld', 'the_nether', 'the_end'].some(dimension =>
    !!modelFor(strategy, { ...emptyWorld(), dimension: dimension as 'overworld' | 'the_nether' | 'the_end' }, measured))).length
  const summary = { runs, won: 0, died: 0, blocked: 0, strategies: 0, gameSeconds: 0, calibratedSkills: models.size,
    calibratedCosts: costs.length, strategyCoverage, registeredStrategies: registry.all().length, deterministic, physicalValidation: false,
    winSeconds: { p10: null as number | null, p50: null as number | null, p90: null as number | null },
    blockedBy: {} as Record<string, number>, blockedAfter: {} as Record<string, number>, restartLoopsIn: {} as Record<string, number>, deathsIn: {} as Record<string, number>, deadEnds: {} as Record<string, number>,
    attempts: {} as Record<string, Record<string, number>>,
    incidents: { interrupts: 0, timeouts: 0, loopGuards: 0, restartLoops: 0, infiniteRestarts: 0, retryWaits: 0, retryWaitSeconds: 0, stuckWithoutReset: 0 },
    traces: [] as WorldTrace[] }
  const wins: number[] = []
  for (let index = 0; index < runs; index++) {
    const start = cloneWorld(options.state ?? emptyWorld())
    const environment = new SimEnvironment(registry, { seed: seed + index, models, costs, deterministic, state: start, spread: !deterministic })
    let guards = 0
    const record = (r: DecisionRecord) => {
      if (r.level !== 'strategy' || !r.strategy || !r.outcome) return
      bump(summary.attempts[r.strategy] ??= {}, r.outcome)
      if (/^interrupted \d+ times/.test(r.reason)) guards++
    }
    const director = new StrategicDirector(registry, environment, { goal: dragonGoal, record, watchdogMs: options.watchdogMs ?? 45 * 60000, ...options.director })
    const trace: WorldTrace = { end: 'steps', seconds: 0, strategies: [] }
    let same = 0, lastId = '', lastKey = ''
    // The shipped guards (maxFailures 2 × maxInterrupts 3) allow at most 6 starts in a row from one state between waits.
    const bound = 6
    for (let step = 0; step < (options.maxSteps ?? 400); step++) {
      const turn = await director.tick()
      const state = turn.state
      if (state.dimension === 'the_nether' && trace.nether === undefined) trace.nether = state.elapsedMs / 1000
      if (state.dimension === 'the_end' && trace.end_dim === undefined) trace.end_dim = state.elapsedMs / 1000
      if (state.dimension === 'overworld' && trace.nether !== undefined && trace.leftNether === undefined) trace.leftNether = state.elapsedMs / 1000
      if (turn.strategy) {
        summary.strategies++
        trace.strategies.push(turn.strategy.id)
        if (state.dimension === 'the_nether' && trace.nether === undefined) trace.nether = state.elapsedMs / 1000
        // The same strategy started again and again from an unchanged state is a restart loop, guarded or not.
        const key = stateKey(turn.state)
        same = turn.strategy.id === lastId && key === lastKey ? same + 1 : 0
        if (same === 3) { summary.incidents.restartLoops++; bump(summary.restartLoopsIn, turn.strategy.id) }
        // A 7th start is beyond what the shipped guards allow: an unbounded restart.
        if (same === bound) summary.incidents.infiniteRestarts++
        lastId = turn.strategy.id; lastKey = key
        if (turn.outcome === 'FAILURE' && !turn.state.alive) bump(summary.deathsIn, turn.strategy.id)
      }
      if (!turn.stopped) continue
      if ((turn.stopped === 'unreachable' || turn.stopped === 'bounded')) {
        const wake = director.nextRetryAt()
        if (wake !== null && wake > environment.now()) {
          // A time-based re-admission is pending: the campaign would wait (or do something else) until then.
          summary.incidents.retryWaits++
          summary.incidents.retryWaitSeconds += (wake - environment.now()) / 1000
          await environment.sleep(wake - environment.now())
          lastId = '' // a timed re-admission starts a new chain
          continue
        }
      }
      trace.end = turn.stopped
      break
    }
    const final = await environment.observe()
    trace.seconds = final.elapsedMs / 1000
    summary.gameSeconds += trace.seconds
    summary.incidents.interrupts += environment.incidents.filter(i => i.type === 'interrupt').length
    summary.incidents.timeouts += environment.incidents.filter(i => i.type === 'timeout').length
    summary.incidents.loopGuards += guards
    if (trace.end === 'goal') { summary.won++; wins.push(trace.seconds) }
    else if (trace.end === 'death') summary.died++
    else {
      summary.blocked++
      bump(summary.blockedBy, trace.end)
      bump(summary.deadEnds, brief(final))
      bump(summary.blockedAfter, director.exhaustedStrategies().sort().join('+') || '(none exhausted)')
      // Nothing in the graph ends a hopeless world: a ResetRun decision would be the only way forward.
      summary.incidents.stuckWithoutReset++
    }
    summary.traces.push(trace)
  }
  summary.winSeconds = { p10: quantile(wins, 0.1), p50: quantile(wins, 0.5), p90: quantile(wins, 0.9) }
  return summary
}
/** Expected game seconds to the first win when every world that is not in the Nether by `netherBy` (or dies, or sticks) is reset. */
export function resetPolicy(traces: WorldTrace[], netherBy = Infinity): { pWin: number; secondsPerWorld: number; expectedToWin: number | null } {
  let spent = 0, wins = 0
  for (const trace of traces) {
    const late = (trace.nether ?? Infinity) > netherBy
    if (late) { spent += Math.min(trace.seconds, netherBy); continue }
    spent += trace.seconds
    if (trace.end === 'goal') wins++
  }
  const pWin = traces.length ? wins / traces.length : 0
  return { pWin, secondsPerWorld: traces.length ? spent / traces.length : 0, expectedToWin: wins ? spent / wins : null }
}
if (require.main === module) {
  const args = process.argv.slice(2)
  const sampled = args.includes('--sampled')
  const economy = args.includes('--economy')
  const positional = args.filter(argument => !argument.startsWith('--'))
  const runs = Math.max(1, Math.min(100000, Number(positional[0]) || 100))
  simulate(runs, Number(process.env.ND_SIM_SEED) || 1, positional.slice(1), { sampled, registry: { economy } })
    .then(({ traces, ...result }) => console.log(JSON.stringify({ ...result, resetWhenStuck: resetPolicy(traces) }, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
