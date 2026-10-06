import fs from 'node:fs'
import { speedrunRegistry, dragonGoal } from './src/core/speedrun'
import { StrategicDirector } from './src/core/strategy'
import { calibrate, SimEnvironment, type TelemetrySample } from './src/environments/sim'
import { loadCosts } from './src/environments/cost-data'
import { modelFor, type CostModel } from './src/core/cost-model'
import { emptyWorld } from './src/core/world-state'

export async function simulate(runs: number, seed = 1, files: string[] = [], options: { sampled?: boolean; costs?: CostModel[] } = {}): Promise<Record<string, unknown>> {
  const samples: TelemetrySample[] = []
  for (const filename of files) for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { samples.push(JSON.parse(line) as TelemetrySample) } catch {}
  }
  const models = calibrate(samples)
  const costs = options.costs ?? loadCosts()
  const deterministic = !options.sampled && files.length === 0
  const registry = speedrunRegistry({ costs })
  const measured = new Map(costs.map(model => [model.key, model]))
  const strategyCoverage = registry.all().filter(strategy => ['overworld', 'the_nether', 'the_end'].some(dimension =>
    !!modelFor(strategy, { ...emptyWorld(), dimension: dimension as 'overworld' | 'the_nether' | 'the_end' }, measured))).length
  const summary = { runs, won: 0, died: 0, blocked: 0, strategies: 0, gameSeconds: 0, calibratedSkills: models.size,
    calibratedCosts: costs.length, strategyCoverage, registeredStrategies: registry.all().length, deterministic, physicalValidation: false }
  for (let index = 0; index < runs; index++) {
    const environment = new SimEnvironment(registry, { seed: seed + index, models, costs, deterministic })
    const director = new StrategicDirector(registry, environment, { goal: dragonGoal })
    for (let step = 0; step < 100; step++) {
      const turn = await director.tick()
      if (turn.strategy) summary.strategies++
      if (turn.stopped) {
        if (turn.stopped === 'goal') summary.won++
        else if (turn.stopped === 'death') summary.died++
        else summary.blocked++
        summary.gameSeconds += turn.state.elapsedMs / 1000
        break
      }
      if (step === 99) summary.blocked++
    }
  }
  return summary
}
if (require.main === module) {
  const args = process.argv.slice(2)
  const sampled = args.includes('--sampled')
  const positional = args.filter(argument => argument !== '--sampled')
  const runs = Math.max(1, Math.min(100000, Number(positional[0]) || 100))
  simulate(runs, Number(process.env.ND_SIM_SEED) || 1, positional.slice(1), { sampled }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
}
