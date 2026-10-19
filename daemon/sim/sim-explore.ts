// Strategy search on the abstract graph (no Minecraft): the same worlds (common random numbers) under graph variants.
// node dist/daemon/sim/sim-explore.js [runs=1000] [--prior] [--json out.json]. Numbers are simulator estimates from telemetry-calibrated
// outcomes (daemon/strategy-costs.json) and priors; every proposal still needs farm runs.
import fs from 'node:fs'
import { simulate, resetPolicy, type SimulateOptions, type WorldTrace } from './sim'
import { emptyWorld, fact, type WorldState } from '../src/core/world-state'

interface Variant { id: string; what: string; options: SimulateOptions }
/** Entering the Nether with the usual kit: what the overworld route delivers (route stage telemetry). */
export function netherEntry(facts: Record<string, boolean | number> = {}): WorldState {
  const s = emptyWorld()
  s.dimension = 'the_nether'
  s.position = { x: 0, y: 64, z: 0 }
  s.resources = { food: 6, stone_tool: 1, iron_pick: 1, iron: 3, bucket: 1, lighter: 1, water: 1, blocks: 64 }
  for (const [name, value] of Object.entries({ portal: true, nether_ready: true, entered_nether: true, ...facts })) s.facts[name] = fact(value, 'map', 0)
  return s
}
const quantile = (values: number[], q: number) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!) : null
function row(variant: Variant, result: Awaited<ReturnType<typeof simulate>>) {
  const { traces } = result
  const left = traces.filter(t => t.leftNether !== undefined).map(t => t.leftNether! - (t.nether ?? 0))
  const policy = resetPolicy(traces)
  const deadEnds = Object.entries(result.deadEnds as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const after = Object.entries(result.blockedAfter as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3)
  return { id: variant.id, what: variant.what, runs: result.runs, won: result.won, died: result.died, blocked: result.blocked,
    pWin: result.won / result.runs, winP50: (result.winSeconds as { p50: number | null }).p50,
    netherExitP50: quantile(left, 0.5), netherExitShare: left.length / result.runs,
    expectedToWin: policy.expectedToWin && Math.round(policy.expectedToWin), incidents: result.incidents, deadEnds, blockedAfter: after }
}
export async function explore(runs = 1000, seed = 1, prior = false): Promise<{ rows: ReturnType<typeof row>[]; resets: Record<string, unknown>[] }> {
  const variants: Variant[] = [
    { id: 'A0', what: 'campaign graph today, from the overworld start', options: {} },
    { id: 'A1', what: 'graph economy (gold as a resource, adaptive batch, one bastion search), from the start', options: { registry: { economy: true } } },
    { id: 'N0', what: 'Nether entry: campaign graph today', options: { state: netherEntry() } },
    { id: 'N1', what: 'Nether entry: economy, one search for a second bastion', options: { registry: { economy: true }, state: netherEntry() } },
    { id: 'N2', what: 'Nether entry: economy + second bastion from the copy map (300 blocks)',
      options: { registry: { economy: true }, state: netherEntry({ bastions_left: 1, next_bastion_distance: 300 }) } },
    { id: 'N3', what: 'Nether entry: economy + endermen allowed as a fallback (no second bastion known)',
      options: { registry: { economy: true }, state: netherEntry({ endermen_allowed: true }) } },
    { id: 'N4', what: 'Nether entry: economy + second bastion + endermen',
      options: { registry: { economy: true }, state: netherEntry({ bastions_left: 1, next_bastion_distance: 300, endermen_allowed: true }) } },
    { id: 'N5', what: 'Nether entry: today + blazes first (blaze_allowed before pearls)', options: { state: netherEntry({ blaze_allowed: true }) } },
    { id: 'N6', what: 'Nether entry: economy + blazes first', options: { registry: { economy: true }, state: netherEntry({ blaze_allowed: true }) } },
    { id: 'E14', what: 'Nether entry: economy, 14 eyes (12 + 2 spare when the portal room is unknown)', options: { registry: { economy: true, eyes: 14 }, state: netherEntry() } },
    { id: 'E11', what: 'Nether entry: economy, 11 eyes (one frame pre-filled, copy of the world)', options: { registry: { economy: true, eyes: 11 }, state: netherEntry() } },
    { id: 'E10', what: 'Nether entry: economy, 10 eyes (two frames pre-filled)', options: { registry: { economy: true, eyes: 10 }, state: netherEntry() } }
  ]
  const rows: ReturnType<typeof row>[] = []
  const traces = new Map<string, WorldTrace[]>()
  for (const variant of variants) {
    const result = await simulate(runs, seed, [], { sampled: true, ...(prior ? { costs: [] } : {}), ...variant.options })
    traces.set(variant.id, result.traces)
    rows.push(row(variant, result))
  }
  // ResetRun policy on the full-run variants: reset any world not in the Nether by T game seconds.
  const resets = ['A0', 'A1'].flatMap(id => [600, 900, 1200, 1500, 1800, 2400, Infinity].map(netherBy => {
    const policy = resetPolicy(traces.get(id)!, netherBy)
    return { id, netherBy, pWin: Number(policy.pWin.toFixed(3)), expectedToWin: policy.expectedToWin && Math.round(policy.expectedToWin) }
  }))
  return { rows, resets }
}
if (require.main === module) {
  const args = process.argv.slice(2)
  const jsonAt = args.indexOf('--json')
  const runs = Math.max(10, Number(args.find(a => /^\d+$/.test(a))) || 1000)
  // --prior: skills at their modelled priors (no telemetry), i.e. what the graph would do once the skills work as designed.
  explore(runs, Number(process.env.ND_SIM_SEED) || 1, args.includes('--prior')).then(result => {
    for (const r of result.rows) console.log([r.id.padEnd(4), `win ${(100 * r.pWin).toFixed(1)}%`.padEnd(11), `died ${r.died}`.padEnd(9), `stuck ${r.blocked}`.padEnd(10),
      `win p50 ${r.winP50 ?? '-'} s`.padEnd(15), `Nether exit p50 ${r.netherExitP50 ?? '-'} s (${(100 * r.netherExitShare).toFixed(0)}%)`.padEnd(32),
      `E[to win | reset] ${r.expectedToWin ?? '-'} s`.padEnd(26), r.what].join(' '))
    for (const r of result.resets) console.log(`reset ${r.id} not in Nether by ${r.netherBy} s: P(win) ${r.pWin}, E[to win] ${r.expectedToWin ?? '-'} s`)
    if (jsonAt >= 0 && args[jsonAt + 1]) fs.writeFileSync(args[jsonAt + 1]!, JSON.stringify(result, null, 2))
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
