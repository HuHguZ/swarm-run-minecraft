// Stress stand from the command line (no Minecraft): named distractions or seeded random tapes against the real
// TacticalSystem, invariant violations by kind, and the minimal tape of each kind.
//   node daemon/src/tactics/sim-fuzz.js [--from 1] [--count 300] [--gen 1|2] [--observe mirror|minecraft] [--shrink] [--deaths] [--named] [--json out.json]
//   node daemon/src/tactics/sim-fuzz.js --tape '{"events":[{"at":20,"type":"tnt","distance":2,"fuse":40}]}'   (one tape, log)
// Deaths count only where one of the simple policies survived the same tape (sim-run.check).
import { check } from './sim-run'
import { SCENARIOS, randomScenario, randomScenario2, shrink } from './sim-scenarios'
import type { Scenario } from './sim-world'

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const observe = opt('--observe', 'mirror') as 'mirror' | 'minecraft'

async function main(): Promise<void> {
  const tape = opt('--tape', '')
  if (tape) {
    const result = await check({ name: 'tape', ...JSON.parse(tape) } as Scenario, { observe })
    console.log(result.log.join('\n'))
    console.log(JSON.stringify({ died: result.died, hp: result.hp, violations: result.violations, selections: result.selections }))
    return
  }
  const from = Number(opt('--from', '1')), count = Number(opt('--count', '300'))
  const generate = opt('--gen', '1') === '2' ? randomScenario2 : randomScenario
  const tapes = args.includes('--named') ? SCENARIOS : Array.from({ length: count }, (_, i) => generate(from + i))
  const byKind = new Map<string, Scenario[]>()
  const details: Array<{ name: string; kind: string; detail: string; died: string | null }> = []
  const started = Date.now()
  for (const scenario of tapes) {
    const result = await check(scenario, { observe })
    for (const violation of result.violations) {
      byKind.set(violation.kind, [...byKind.get(violation.kind) ?? [], scenario])
      details.push({ name: scenario.name, kind: violation.kind, detail: violation.detail, died: result.died })
    }
  }
  console.log(`${tapes.length} tapes, ${observe}, ${Date.now() - started} ms`)
  for (const [kind, list] of byKind) console.log(`${kind} ${list.length}: ${list.slice(0, 15).map(s => s.name).join(' ')}`)
  const out = opt('--json', '')
  if (out) require('fs').writeFileSync(out, JSON.stringify({ observe, gen: opt('--gen', '1'), from, count: tapes.length, ms: Date.now() - started, details }, null, 1))
  if (!args.includes('--shrink')) return
  for (const [kind, list] of byKind) {
    if (kind === 'death' && !args.includes('--deaths')) continue
    const fails = async (candidate: Scenario) => (await check(candidate, { observe })).violations.some(v => v.kind === kind)
    const minimal = await shrink(list[0], fails)
    const result = await check(minimal, { observe })
    console.log(`\n${kind} (${list[0].name}): ${JSON.stringify({ skill: minimal.skill, body: minimal.body, world: minimal.world, events: minimal.events })}`)
    console.log(`  ${result.violations.find(v => v.kind === kind)?.detail} | ${result.selections.slice(0, 14).map(s => `${s.tick}:${s.action}/${s.level}`).join(' ')}`)
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
