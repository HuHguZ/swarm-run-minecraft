import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSkillSample } from '../../farm/strategy-costs'
import { applyCosts, learnCosts, modelFor, type CostModel } from '../src/core/cost-model'
import { speedrunRegistry, travelTicks, dragonGoal } from '../src/core/speedrun'
import { plan, StrategicDirector, StrategyRegistry, type Strategy } from '../src/core/strategy'
import { amount, emptyWorld, fact, knows, type WorldState } from '../src/core/world-state'
import { attemptModel, measuredPartial, partialEffect, SimEnvironment } from '../src/environments/sim'
import { simulate, resetPolicy } from '../sim'

function nether(extra: Partial<WorldState> = {}): WorldState {
  const s = emptyWorld()
  s.dimension = 'the_nether'
  s.position = { x: 0, y: 64, z: 0 }
  s.resources = { food: 6, stone_tool: 1, iron_pick: 1 }
  s.facts.bastion = fact(true, 'map', 0)
  s.facts.blaze_allowed = fact(false, 'observed', 0)
  return { ...s, ...extra }
}
const pearlGoal = (s: WorldState) => amount(s, 'pearls') + amount(s, 'eyes') >= 12

test('economy: gold is mined in the batch the barter model asks for, then traded; the monolithic bastion skill is gone', () => {
  const registry = speedrunRegistry({ economy: true })
  assert.equal(registry.get('BastionBarter'), undefined)
  const route = plan(registry, nether(), pearlGoal)
  assert.equal(route.reason, 'goal')
  assert.deepEqual(route.steps.slice(0, 2).map(s => s.id), ['AcquireGold', 'PiglinBarter'])
  const batch = registry.get('AcquireGold')!.command!(nether()).params!.ingots as number
  assert.ok(batch >= 27 && batch <= 153 && batch % 9 === 0, `batch ${batch}`)
})

test('economy: a spent bastion moves to the known next one, or searches once when the copy knows none', () => {
  const registry = speedrunRegistry({ economy: true })
  const spent = nether()
  spent.facts.bastion_gold_left = fact(0, 'observed', 0)
  spent.facts.bastions_left = fact(1, 'map', 0)
  spent.facts.next_bastion_distance = fact(400, 'map', 0)
  assert.equal(plan(registry, spent, pearlGoal).steps[0]?.id, 'MoveToNextBastion')
  spent.facts.bastions_left = fact(0, 'map', 0)
  assert.equal(plan(registry, spent, pearlGoal).steps[0]?.id, 'SearchNextBastion')
  spent.facts.bastion_searches = fact(1, 'observed', 0)
  assert.equal(plan(registry, spent, pearlGoal).reason, 'unreachable', 'endermen not allowed and nothing left: a ResetRun situation')
  spent.facts.endermen_allowed = fact(true, 'observed', 0)
  assert.equal(plan(registry, spent, pearlGoal).steps[0]?.id, 'HuntEndermen')
})

test('economy: sampled barter trades ingot by ingot and stops at the required pearls', () => {
  const barter = speedrunRegistry({ economy: true }).get('PiglinBarter')!
  const s = nether({ resources: { gold: 90, pearls: 6 } })
  const always = barter.sampleEffects!(s, () => 0)
  assert.deepEqual(always.resources, { gold: -3, pearls: 6 }, 'r = 0 draws a 2-pearl stack every ingot: 3 ingots reach 12')
  const never = barter.sampleEffects!(s, () => 0.999)
  assert.deepEqual(never.resources, { gold: -90, pearls: 0 })
})

test('economy: trading that keeps failing returns after the game-time backoff or at the next site', async () => {
  const registry = speedrunRegistry({ economy: true })
  const state = nether({ resources: { gold: 90, food: 6, stone_tool: 1 } })
  state.facts.bastions_left = fact(1, 'map', 0)
  const environment = { observe: async () => state, execute: async () => ({ outcome: 'FAILURE' as const, events: [] }), cancel: async () => {},
    now: () => state.elapsedMs, sleep: async (ms: number) => { state.elapsedMs += ms } }
  const director = new StrategicDirector(registry, environment, { goal: pearlGoal, retryAfterMs: 60000 })
  const barter = registry.get('PiglinBarter')!
  await director.run(barter); await director.run(barter)
  assert.deepEqual(director.exhaustedStrategies(), ['PiglinBarter'])
  assert.equal(director.decide(state).steps[0]?.id, 'MoveToNextBastion', 'carried gold no longer blocks a move')
  assert.equal(director.nextRetryAt(), 60000)
  state.facts.bastion_site = fact(1, 'observed', 1)
  assert.equal(director.decide(state).steps[0]?.id, 'PiglinBarter', 'a new site re-admits trading')
  await director.run(barter); await director.run(barter)
  state.elapsedMs += 120000
  assert.equal(director.decide(state).steps[0]?.id, 'PiglinBarter', 'piglins wander back: time re-admits it too')
})

test('distance to a known target is part of the price and stays outside the telemetry blend', () => {
  const s = nether()
  s.facts.fortress = fact(true, 'observed', 0)
  s.facts.fortress_position = fact({ x: 300, y: 70, z: 400 }, 'observed', 0)
  assert.equal(travelTicks(s, 'GetBlazeRods'), 500 / 2.5 * 20)
  const model: CostModel = { key: 'GetBlazeRods', samples: 95, successes: 95, deaths: 0, medianTicks: 2000, p90Ticks: 3000 }
  const registry = speedrunRegistry({ costs: [model] })
  const near = { ...s, facts: { ...s.facts, fortress_position: fact({ x: 0, y: 70, z: 0 }, 'observed', 0) } }
  const rods = registry.get('GetBlazeRods')!
  assert.ok(Math.abs(rods.estimateCost(s) - rods.estimateCost(near) - 4000) < 1e-6, 'the full trip is added, not shrunk toward the median')
})

test('cost import: graph records give WorldState context, deaths, partials and interruptions; rods are not the old nether stage', () => {
  const record = { level: 'strategy', strategy: 'GetBlazeRods', ticks: 4000, clock: 'game', outcome: 'PARTIAL',
    before: { dimension: 'the_nether', health: 6 }, after: { alive: true } }
  const sample = normalizeSkillSample(record)!
  assert.deepEqual(sample.before, { dim: 'the_nether', hp: 6 })
  assert.equal(sample.death, false)
  assert.equal(normalizeSkillSample({ ...record, after: { alive: false } })!.death, true)
  const models = learnCosts([sample, { ...sample, outcome: 'INTERRUPTED' }, { ...sample, outcome: 'SUCCESS' }])
  const context = models.find(m => m.key === 'GetBlazeRods@the_nether@wounded')!
  assert.deepEqual([context.samples, context.successes, context.partials, context.interrupts], [3, 1, 1, 1])
  const legacy: CostModel = { key: 'nether', samples: 68, successes: 0, deaths: 0, medianTicks: 40, p90Ticks: 1860 }
  assert.equal(modelFor(speedrunRegistry().get('GetBlazeRods')!, nether(), new Map([['nether', legacy]])), undefined)
})

test('sim: telemetry interruptions reach the director, whose guard turns a stuck loop into one failure', async () => {
  const registry = new StrategyRegistry().register({ id: 'loop', skill: 'loop', version: 1, preconditions: s => !knows(s, 'done'),
    expectedEffects: { facts: { done: true } }, estimateCost: () => 200, estimateRisk: () => 0, timeoutMs: 600000, successCondition: (_b, a) => knows(a, 'done') } as Strategy)
  const costs: CostModel[] = [{ key: 'loop', samples: 1000, successes: 0, deaths: 0, deathSamples: 1000, interrupts: 1000, medianTicks: 200, p90Ticks: 200 }]
  applyCosts(registry, costs)
  const environment = new SimEnvironment(registry, { costs, seed: 7 })
  const reasons: string[] = []
  const director = new StrategicDirector(registry, environment, { goal: s => knows(s, 'done'), record: r => { if (r.level === 'strategy') reasons.push(`${r.outcome} ${r.reason}`) } })
  for (let i = 0; i < 3; i++) await director.tick()
  assert.deepEqual(reasons.map(r => r.split(' ')[0]), ['INTERRUPTED', 'INTERRUPTED', 'FAILURE'])
  assert.match(reasons[2]!, /interrupted 3 times without progress/)
  assert.equal(environment.incidents.filter(i => i.type === 'interrupt').length, 3)
})

test('sim: PARTIAL moves quantities half-way, facts stay unreached; a measured model keeps prior weight 5', () => {
  const s = nether({ resources: { rods: 2 } })
  assert.deepEqual(partialEffect(s, { atLeast: { rods: 6 }, resources: { gold: 9, iron: -3 }, facts: { done: true } }),
    { atLeast: { rods: 4 }, resources: { gold: 4, iron: -3 } })
  const registry = speedrunRegistry()
  const costs: CostModel[] = [{ key: 'GetBlazeRods', samples: 5, successes: 0, partials: 1, interrupts: 0, deaths: 0, deathSamples: 5, medianTicks: 10880, p90Ticks: 10880 }]
  applyCosts(registry, costs)
  const state = nether({ resources: { food: 6 } })
  state.facts.fortress = fact(true, 'observed', 0)
  state.facts.blaze_allowed = fact(true, 'observed', 0)
  const model = attemptModel(registry.get('GetBlazeRods')!, state, new Map(costs.map(c => [c.key, c])))
  assert.equal(model.source, 'measured')
  assert.ok(Math.abs(model.success - 5 * (1 - model.death) / 10) < 1e-9, '0 of 5 measured is not 0: five prior attempts at 1 − risk')
  assert.equal(model.partial, 0.1)
})

test('sim: sampled worlds win, die and stick with a time distribution; reset policy prices the stuck worlds', async () => {
  const result = await simulate(60, 1, [], { sampled: true, costs: [], registry: { economy: true } })
  assert.equal(result.won + result.died + result.blocked, 60)
  assert.ok(result.won > 12, `won ${result.won}`)
  const wins = result.winSeconds as { p10: number; p50: number; p90: number }
  assert.ok(wins.p10 <= wins.p50 && wins.p50 <= wins.p90 && wins.p10 < wins.p90, JSON.stringify(wins))
  const policy = resetPolicy(result.traces)
  assert.ok(Math.abs(policy.pWin - result.won / 60) < 1e-9)
  assert.ok(policy.expectedToWin! >= wins.p10)
  const strict = resetPolicy(result.traces, 1)
  assert.equal(strict.pWin, 0, 'nobody is in the Nether within one game second')
  const fresh = new SimEnvironment(speedrunRegistry(), { deterministic: true })
  await fresh.sleep(5000)
  fresh.reset()
  assert.equal(fresh.now(), 5000, 'ResetRun keeps the clock running')
  assert.equal(dragonGoal(await fresh.observe()), false)
})

test('a target believed with confidence c costs (1 − c) of a fresh 120 s search on top: map facts 1, inferred ones less', () => {
  const rods = speedrunRegistry().get('GetBlazeRods')!
  const s = nether()
  s.facts.blaze_allowed = fact(true, 'observed', 0)
  s.facts.fortress = fact(true, 'map', 0, 1)
  const sure = rods.estimateCost(s)
  s.facts.fortress = fact(true, 'inferred', 0, 0.5)
  assert.equal(rods.estimateCost(s) - sure, 0.5 * 120 * 20)
})

test('cost import counts a graph attempt once: the stage record named after the strategy repeats its strategy record', () => {
  const strategyRecord = { level: 'strategy', strategy: 'BastionBarter', ticks: 4000, clock: 'game', outcome: 'PARTIAL', after: { alive: true } }
  const stageRecord = { level: 'stage', stage: 'BastionBarter', sec: 200, clock: 'game', ok: false }
  const legacyStage = { level: 'stage', stage: 'bastion', sec: 200, clock: 'game', ok: false }
  assert.equal(normalizeSkillSample(stageRecord), null)
  assert.ok(normalizeSkillSample(legacyStage))
  const models = learnCosts([strategyRecord, stageRecord, legacyStage].map(r => normalizeSkillSample(r)).filter(s => s !== null))
  assert.equal(models.find(m => m.key === 'BastionBarter')!.samples, 1)
})

test('sim flags an unbounded restart when the director guard is off, and none with the guard', async () => {
  // Tactics stop every wood attempt (an incident rate of 100 %): the guard turns 3 into a failure, without it they never end.
  const costs: CostModel[] = [{ key: 'AcquireWood', samples: 1000, successes: 0, deaths: 0, deathSamples: 1000, interrupts: 1000, medianTicks: 1500, p90Ticks: 2000 }]
  const guarded = await simulate(5, 3, [], { sampled: true, costs })
  assert.equal(guarded.incidents.infiniteRestarts, 0, JSON.stringify(guarded.incidents))
  assert.ok(guarded.incidents.loopGuards > 0)
  const unguarded = await simulate(5, 3, [], { sampled: true, costs, director: { maxInterrupts: 1000 } })
  assert.ok(unguarded.incidents.infiniteRestarts > 0, JSON.stringify(unguarded.incidents))
})

test('dragon fork is its own placeholder flag, independent of the barter economy', () => {
  assert.ok(speedrunRegistry({ economy: true }).get('KillDragon'))
  const fork = speedrunRegistry({ dragonVariants: true })
  assert.equal(fork.get('KillDragon'), undefined)
  assert.ok(fork.get('KillDragonBeds') && fork.get('KillDragonMelee'))
})

test('measured PARTIAL buys what telemetry saw (bastion: gold, a tenth of a pearl), not half of the goal', () => {
  const sample = normalizeSkillSample({ level: 'strategy', strategy: 'BastionBarter', ticks: 9000, clock: 'game', outcome: 'PARTIAL',
    before: { dimension: 'the_nether', health: 20, resources: { gold: 0, pearls: 2, blocks: 40 } }, after: { alive: true, resources: { gold: 18, pearls: 2, blocks: 30 } } })!
  assert.deepEqual(sample.gained, { gold: 18, blocks: -10 })
  const models = learnCosts(Array.from({ length: 5 }, () => sample))
  assert.deepEqual(models.find(m => m.key === 'BastionBarter')!.partialGain, { gold: 18, blocks: -10 })
  const bastion = speedrunRegistry().get('BastionBarter')!
  const effect = typeof bastion.expectedEffects === 'function' ? bastion.expectedEffects(nether()) : bastion.expectedEffects
  assert.deepEqual(measuredPartial(effect, { gold: 10, pearls: 0.11, blocks: -3 }, () => 0.5), { resources: { gold: 10 } }, 'blocks are not the bastion effect')
  assert.deepEqual(measuredPartial(effect, { gold: 10, pearls: 0.11 }, () => 0.05), { resources: { gold: 10, pearls: 1 } })
})
