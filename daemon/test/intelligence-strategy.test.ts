import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyWorld, fact, amount, knows, unknown, applyEffect, type WorldState } from '../src/core/world-state'
import { speedrunRegistry, dragonGoal } from '../src/core/speedrun'
import { plan, StrategyRegistry, StrategicDirector, type Strategy } from '../src/core/strategy'
import type { Environment, ExecutionResult, SkillCommand } from '../src/core/environment'
import { SimEnvironment, calibrate } from '../src/environments/sim'
import { worldFromObservation, executionFromRpc, MineflayerEnvironment } from '../src/environments/mineflayer'
import { applyCosts, type CostModel } from '../src/core/cost-model'

function milestone(id: string, cost: number): Strategy {
  return { id, skill: id, version: 1, preconditions: s => !knows(s, 'done'), expectedEffects: { facts: { done: true } }, estimateCost: () => cost,
    estimateRisk: () => 0, timeoutMs: 1000, successCondition: (_b, a) => knows(a, 'done') }
}
test('missing mining supplies can be replenished for remaining bastions after all rods are obtained', () => {
  const state = emptyWorld()
  state.dimension = 'the_nether'
  state.resources = { rods: 5, pearls: 2, food: 8 }
  state.facts = { bastion: fact(true, 'map', 0), nether_tools_ready: fact(false, 'observed', 0) }
  const registry = speedrunRegistry({ eyes: 10 })
  assert.equal(registry.get('AcquireNetherTools')!.preconditions(state), true)
  assert.deepEqual(plan(registry, state, s => amount(s, 'pearls') >= 10).steps.map(step => step.id), ['AcquireNetherTools', 'BastionBarter'])
  state.resources.gold = 8
  assert.equal(registry.get('AcquireNetherTools')!.preconditions(state), false)
  assert.equal(plan(registry, state, s => amount(s, 'pearls') >= 10).steps[0]?.id, 'PiglinBarter')
  state.resources.gold = 0
  state.facts.bastions_exhausted = fact(true, 'observed', 0)
  assert.equal(registry.get('AcquireNetherTools')!.preconditions(state), false)
})
test('usable barter gold blocks enderman hunting until trading is observably exhausted', () => {
  const hunt = speedrunRegistry().get('HuntEndermen')!
  const barter = speedrunRegistry().get('PiglinBarter')!
  const state = worldFromObservation({ state: { dimension: 'the_nether', health: 20, inventory: { gold_block: 9 } },
    facts: { bastions_exhausted: fact(true, 'observed', 0), endermen_allowed: fact(true, 'observed', 0) } }, 0)
  assert.equal(amount(state, 'gold'), 81)
  state.facts.bastion = fact(true, 'map', 0)
  delete state.facts.bastions_exhausted
  assert.equal(barter.preconditions(state), true, 'carried gold can be traded before mining the remaining bastion')
  assert.equal(plan(speedrunRegistry(), state, s => amount(s, 'pearls') >= 12).steps[0]?.id, 'PiglinBarter')
  state.facts.bastions_exhausted = fact(true, 'observed', 0)
  assert.equal(hunt.preconditions(state), false)
  state.facts.barter_exhausted = fact(true, 'observed', 0)
  assert.equal(hunt.preconditions(state), true)
  delete state.facts.barter_exhausted
  state.resources.gold = 0
  assert.equal(hunt.preconditions(state), true)
})
test('carried barter gold is used before replenishing the next mining reserve', () => {
  const registry = speedrunRegistry()
  const state = emptyWorld()
  state.dimension = 'the_nether'; state.resources = { gold: 62, food: 6 }
  state.facts.bastion = fact(true, 'map', 0)
  state.facts.nether_tools_ready = fact(false, 'observed', 0)
  const supply = registry.get('AcquireNetherTools')!
  assert.equal(supply.preconditions(state), false)
  assert.equal(plan(registry, state, s => amount(s, 'pearls') >= 12).steps[0]?.id, 'PiglinBarter')
  state.resources.gold = 7
  assert.equal(supply.preconditions(state), true, 'digging a new gold supply still needs the mining reserve')
  state.resources.gold = 62; state.resources.pearls = 12
  assert.equal(supply.preconditions(state), true, 'the fortress route retains its tool and wood requirements')
})
test('known missing mining supplies block bastion excavation while carried gold still reaches barter', () => {
  const registry = speedrunRegistry()
  const state = emptyWorld()
  state.dimension = 'the_nether'; state.resources = { pearls: 2, food: 6, gold: 0 }
  state.facts.bastion = fact(true, 'map', 0)
  state.facts.nether_tools_ready = fact(false, 'observed', 0)
  const bastion = registry.get('BastionBarter')!
  const goal = (world: WorldState) => amount(world, 'pearls') >= 12
  assert.equal(bastion.preconditions(state), false)
  assert.deepEqual(plan(registry, state, goal).steps.map(step => step.id), ['AcquireNetherTools', 'BastionBarter'])
  state.resources.gold = 62
  assert.equal(bastion.preconditions(state), true, 'existing nearby gold can be traded without the next excavation reserve')
  assert.equal(plan(registry, state, goal).steps[0]?.id, 'PiglinBarter')
  state.resources.gold = 0
  state.facts.nether_tools_ready = fact(true, 'observed', 1)
  assert.equal(bastion.preconditions(state), true)
})
class TestEnvironment implements Environment {
  state = emptyWorld()
  cancellations = 0
  constructor(private readonly action: (environment: TestEnvironment, command: SkillCommand) => ExecutionResult) {}
  async observe() { return this.state }
  async execute(command: SkillCommand) { return this.action(this, command) }
  async cancel() { this.cancellations++ }
  now() { return this.state.elapsedMs }
  async sleep(milliseconds: number) { this.state.elapsedMs += milliseconds }
}
test('barter retries after actual gold or pearl changes but remains bounded in unchanged context', async () => {
  const registry = speedrunRegistry()
  const environment = new TestEnvironment(() => ({ outcome: 'FAILURE', events: [] }))
  environment.state.dimension = 'the_nether'
  environment.state.resources = { gold: 36, food: 6 }
  environment.state.facts.bastion = fact(true, 'map', 0)
  const director = new StrategicDirector(registry, environment, { goal: s => amount(s, 'pearls') >= 12 })
  const barter = registry.get('PiglinBarter')!
  await director.run(barter); await director.run(barter)
  environment.state.resources.blocks = 300
  environment.state.health = 19
  assert.notEqual(director.decide(environment.state).steps[0]?.id, 'PiglinBarter')
  environment.state.resources.gold = 30
  assert.equal(director.decide(environment.state).steps[0]?.id, 'PiglinBarter')
  await director.run(barter); await director.run(barter)
  assert.notEqual(director.decide(environment.state).steps[0]?.id, 'PiglinBarter')
})
test('facts preserve unknown, observed absence and sourced map positions', () => {
  const world = worldFromObservation({ state: { health: 20, food: 18, dimension: 'overworld', inventory: { iron_ingot: 5 } },
    known: { fortress: null }, map: { village: { x: 3, z: 7 }, ship: null } }, 40)
  assert.equal(unknown(world, 'fortress'), true)
  assert.equal(world.facts.shipwreck.value, false)
  assert.equal(world.facts.village.source, 'map')
  assert.deepEqual(world.facts.village_position.value, { x: 3, y: 64, z: 7 })
  assert.equal(amount(world, 'iron'), 5)
})
test('quantitative effects consume resources and never mutate observed state', () => {
  const world = emptyWorld(); world.resources.iron = 7
  const next = applyEffect(world, { resources: { iron: -4 }, atLeast: { bucket: 1 } })
  assert.equal(amount(next, 'iron'), 3)
  assert.equal(amount(world, 'iron'), 7)
})
test('raw iron and incomplete nuggets cannot satisfy crafting preconditions', () => {
  const world = worldFromObservation({ state: { inventory: { raw_iron: 7, iron_nugget: 8 } } }, 0)
  assert.equal(amount(world, 'iron'), 0)
  assert.equal(amount(world, 'raw_iron'), 7)
  assert.equal(speedrunRegistry().get('CraftPortalKit')!.preconditions(world), false)
})
test('iron forks obey building-first search budget and replan to mining after exhaustion', () => {
  const registry = speedrunRegistry()
  const world = emptyWorld(); world.resources = { stone_tool: 1, food: 6 }
  for (const [key, value] of Object.entries({ village: true, shipwreck: false, treasure: false })) world.facts[key] = fact(value, 'map', 0)
  const goal = (s: WorldState) => amount(s, 'iron') >= 7
  const route = plan(registry, world, goal)
  assert.equal(route.steps[0].id, 'VillageIron')
  assert.equal(route.steps.at(-1)?.id, 'MineIron')
  world.structureSearchMs = 180000
  assert.equal(plan(registry, world, goal).steps[0].id, 'MineIron')
})
test('bounded scouting preserves known structures and spends only the remaining search budget', () => {
  const world = emptyWorld(); world.resources = { stone_tool: 1, food: 6 }; world.structureSearchMs = 120000
  const scout = speedrunRegistry().get('ScoutStructures')!
  assert.equal(scout.preconditions(world), true)
  const effect = typeof scout.expectedEffects === 'function' ? scout.expectedEffects(world) : scout.expectedEffects
  const after = applyEffect(world, effect)
  assert.equal(after.structureSearchMs, 180000)
  assert.equal(unknown(after, 'village'), true)
  assert.equal(scout.successCondition(world, after), true)
  world.facts.village = fact(true, 'map', 0)
  assert.equal(scout.preconditions(world), false)
})
test('portal graph selects available lava, ruins or carried obsidian', () => {
  const registry = speedrunRegistry()
  const world = emptyWorld(); world.resources = { stone_tool: 1, bucket: 1, lighter: 1, water: 1, food: 6 }
  world.facts.lava = fact(true, 'map', 0)
  assert.equal(plan(registry, world, s => knows(s, 'portal')).steps[0].id, 'LavaPoolPortal')
  world.facts.ruined_portal = fact(true, 'map', 0)
  assert.equal(plan(registry, world, s => knows(s, 'portal')).steps[0].id, 'RuinedPortal')
  world.resources.obsidian = 10
  assert.equal(plan(registry, world, s => knows(s, 'portal')).steps[0].id, 'ObsidianPortal')
})
test('a looted bucket without a lighter still allows acquiring the missing portal kit', () => {
  const world = emptyWorld()
  world.resources = { bucket: 1, stone_tool: 1, food: 6 }
  world.structureSearchMs = 180000
  for (const key of ['village', 'shipwreck', 'treasure']) world.facts[key] = fact(false, 'observed', 0)
  const route = plan(speedrunRegistry(), world, s => amount(s, 'bucket') >= 1 && amount(s, 'lighter') >= 1)
  assert.deepEqual(route.steps.map(step => step.id), ['MineIron', 'CraftPortalKit'])
})
test('pearls graph bars endermen until all bastions are exhausted', () => {
  const registry = speedrunRegistry(); const world = emptyWorld()
  world.dimension = 'the_nether'; world.resources.food = 6
  world.facts.bastion = fact(true, 'map', 0); world.facts.endermen_allowed = fact(true, 'observed', 0)
  const goal = (s: WorldState) => amount(s, 'pearls') >= 12
  assert.equal(plan(registry, world, goal).steps[0].id, 'BastionBarter')
  world.facts.bastions_exhausted = fact(true, 'observed', 0)
  assert.equal(plan(registry, world, goal).steps[0].id, 'HuntEndermen')
  world.resources.gold = 16
  assert.equal(plan(registry, world, goal).steps[0].id, 'PiglinBarter')
})
test('unchanged SUCCESS RPC fails verification and chooses another route', async () => {
  const registry = new StrategyRegistry().register(milestone('cheap', 1)).register(milestone('alternative', 2))
  const environment = new TestEnvironment((env, command) => {
    if (command.strategy === 'alternative') env.state.facts.done = fact(true, 'observed', 0)
    return { outcome: 'SUCCESS', events: [] }
  })
  const director = new StrategicDirector(registry, environment, { goal: s => knows(s, 'done') })
  assert.equal((await director.tick()).outcome, 'FAILURE')
  const second = await director.tick()
  assert.equal(second.strategy?.id, 'alternative')
  assert.equal(second.outcome, 'SUCCESS')
})
test('Nether route replenishes a known worn toolkit before collecting blaze rods', () => {
  const world = emptyWorld(); world.dimension = 'the_nether'; world.resources = { food: 6, pearls: 12 }
  world.facts.fortress = fact(true, 'map', 0)
  world.facts.nether_tools_ready = fact(false, 'observed', 0)
  const registry = speedrunRegistry()
  const goal = (s: WorldState) => amount(s, 'rods') >= 6
  assert.deepEqual(plan(registry, world, goal).steps.map(s => s.id), ['AcquireNetherTools', 'GetBlazeRods'])
  world.facts.nether_tools_ready = fact(null, 'observed', 0)
  assert.equal(plan(registry, world, goal).steps[0]?.id, 'GetBlazeRods')
  world.resources.eyes = 12
  world.facts.nether_tools_ready = fact(false, 'observed', 0)
  assert.equal(registry.get('AcquireNetherTools')!.preconditions(world), false)
})
test('known unexhausted bastions precede blaze farming until pearls or fire resistance permit it', () => {
  const world = emptyWorld(); world.dimension = 'the_nether'; world.resources.food = 6
  world.facts.fortress = fact(true, 'map', 0); world.facts.bastion = fact(true, 'map', 0)
  const registry = speedrunRegistry()
  assert.equal(registry.get('GetBlazeRods')!.preconditions(world), false)
  const route = plan(registry, world, s => amount(s, 'pearls') >= 12 && amount(s, 'rods') >= 6)
  assert.deepEqual(route.steps.map(s => s.id), ['BastionBarter', 'GetBlazeRods'])
  world.facts.blaze_allowed = fact(true, 'observed', 0)
  assert.equal(registry.get('GetBlazeRods')!.preconditions(world), true)
})
test('tactical revision discards apparent strategy success and observes before replanning', async () => {
  const registry = new StrategyRegistry().register(milestone('finish', 1))
  const environment = new TestEnvironment(env => { env.state = applyEffect(env.state, { facts: { done: true } }); env.state.revision++; return { outcome: 'SUCCESS', events: [] } })
  const director = new StrategicDirector(registry, environment, { goal: s => knows(s, 'done') })
  assert.equal((await director.tick()).outcome, 'INTERRUPTED')
  assert.equal((await director.tick()).stopped, 'goal')
})

test('fire resistance prices the blaze fight instead of gating it; its supply is an option with verified protection', () => {
  const world = emptyWorld(); world.dimension = 'the_nether'; world.resources.pearls = 12; world.resources.food = 6; world.resources.shield = 1
  world.facts.fortress = fact(true, 'map', 0); world.facts.bastion = fact(true, 'map', 0)
  world.facts.blaze_allowed = fact(true, 'observed', 0); world.facts.fire_resistance_count = fact(0, 'observed', 0)
  const registry = speedrunRegistry()
  const rods = registry.get('GetBlazeRods')!
  assert.equal(rods.preconditions(world), true, 'no FR potion does not forbid the spawner')
  // Calibrated risks (s1c: 0.35 with FR, 0.7 without): a reachable bastion makes the FR trip worth its 600 s; with no FR source the
  // fight goes on without it — FR is a price, never a gate.
  assert.deepEqual(plan(registry, world, s => amount(s, 'rods') >= 6).steps.map(s => s.id), ['AcquireFireResistance', 'GetBlazeRods'])
  const noSource = { ...world, facts: { ...world.facts, bastions_exhausted: fact(true, 'observed', 0) } }
  assert.deepEqual(plan(registry, noSource, s => amount(s, 'rods') >= 6).steps.map(s => s.id), ['GetBlazeRods'], 'no FR source — fight without it')
  const withFr = { ...world, facts: { ...world.facts, fire_resistance_count: fact(2, 'observed', 0) } }
  assert.ok(rods.estimateRisk(world) > rods.estimateRisk(withFr), 'FR lowers the priced risk')
  assert.ok(rods.estimateRisk({ ...world, resources: { ...world.resources, shield: 0 } }) > rods.estimateRisk(world), 'no shield raises it')
  const supply = registry.get('AcquireFireResistance')!
  assert.equal(supply.preconditions(world), true)
  assert.equal(supply.preconditions(withFr), false, 'FR already held')
  assert.equal(supply.successCondition(world, { ...world, facts: { ...world.facts, blaze_allowed: fact(true, 'observed', 0) } }), false)
  assert.equal(supply.successCondition(world, { ...world, facts: { ...world.facts, fire_resistance_active: fact(true, 'observed', 0) } }), true)
  world.facts.bastions_exhausted = fact(true, 'observed', 0)
  assert.equal(supply.preconditions(world), false)
  world.resources.gold = 8
  assert.equal(supply.preconditions(world), true)
})
test('bounded planner rejects unchanged loops and finite failure exhaustion stops retrying', async () => {
  const registry = new StrategyRegistry().register({ ...milestone('noop', 0), expectedEffects: {} })
  assert.equal(plan(registry, emptyWorld(), s => knows(s, 'done'), { maxStates: 3 }).reason, 'unreachable')
  const failures = new StrategyRegistry().register(milestone('fail', 1))
  const environment = new TestEnvironment(() => ({ outcome: 'FAILURE', events: [] }))
  const director = new StrategicDirector(failures, environment, { goal: s => knows(s, 'done'), maxFailures: 2 })
  await director.tick(); await director.tick()
  assert.equal((await director.tick()).stopped, 'unreachable')
})
test('incidental mined blocks cannot keep an unsuccessful barter strategy alive', async () => {
  const registry = new StrategyRegistry().register({ ...milestone('barter', 1), progressCondition: (b, a) => amount(a, 'pearls') > amount(b, 'pearls') })
  const environment = new TestEnvironment(env => { env.state.resources.blocks = amount(env.state, 'blocks') + 1; return { outcome: 'SUCCESS', events: [] } })
  const director = new StrategicDirector(registry, environment, { goal: s => knows(s, 'done'), maxFailures: 2 })
  assert.equal((await director.tick()).outcome, 'FAILURE')
  assert.equal((await director.tick()).outcome, 'FAILURE')
  assert.equal((await director.tick()).stopped, 'unreachable')
})
test('elapsed environment ticks enforce strategy timeout even when RPC says success', async () => {
  const registry = new StrategyRegistry().register(milestone('slow', 1))
  const environment = new TestEnvironment(env => { env.state.elapsedMs += 2000; env.state.facts.done = fact(true, 'observed', 2000); return { outcome: 'SUCCESS', events: [] } })
  assert.equal((await new StrategicDirector(registry, environment, { goal: s => knows(s, 'done') }).tick()).outcome, 'TIMEOUT')
})

test('director interruption stops a skill that never settles and observes the released environment', async () => {
  const registry = new StrategyRegistry().register(milestone('pending', 1))
  const environment = new TestEnvironment(() => ({ outcome: 'SUCCESS', events: [] }))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  environment.execute = async () => { entered(); return new Promise<ExecutionResult>(() => {}) }
  const director = new StrategicDirector(registry, environment, { goal: s => knows(s, 'done') })
  const turn = director.tick()
  await started
  director.interrupt('danger')
  assert.equal((await turn).outcome, 'INTERRUPTED')
  assert.equal(environment.cancellations, 1)
})

test('partial healing is useful progress and retains a snapshot before mutable observation updates', async () => {
  const strategy = { ...milestone('heal', 1), expectedEffects: { health: 12 }, successCondition: (_before: WorldState, after: WorldState) => after.health >= 12 }
  const environment = new TestEnvironment(env => { env.state.health = 8; return { outcome: 'SUCCESS', events: [] } })
  environment.state.health = 4
  const director = new StrategicDirector(new StrategyRegistry().register(strategy), environment, { goal: s => s.health >= 12 })
  assert.equal((await director.tick()).outcome, 'PARTIAL')
})
test('same director completes a full abstract graph and telemetry calibrates sampled skill times', async () => {
  const models = calibrate([{ level: 'stage', stage: 'wood', sec: 10, ok: true }, { level: 'stage', stage: 'wood', sec: 20, ok: false, death: true }])
  assert.deepEqual(models.get('wood'), { seconds: 20, success: 0.5, death: 0.5, samples: 2 })
  const registry = speedrunRegistry()
  const environment = new SimEnvironment(registry, { deterministic: true })
  const director = new StrategicDirector(registry, environment, { goal: dragonGoal })
  let steps = 0
  while (steps++ < 40) { if ((await director.tick()).stopped === 'goal') break }
  assert.ok(steps < 40)
  assert.equal(dragonGoal(await environment.observe()), true)
})
test('sampled simulation uses measured ticks at vanilla20TPS and retains actual failures and deaths', async () => {
  // S3 06.10: deaths come from the planner's blended risk (applyCosts), success from measured attempts plus 5 prior ones.
  const registry = new StrategyRegistry().register({ ...milestone('measured', 1), timeoutMs: 3600000 })
  const costs: CostModel[] = [{ key: 'measured', samples: 20, successes: 5, deaths: 5, medianTicks: 15000, p90Ticks: 18000 }]
  applyCosts(registry, costs)
  const seen: Record<string, number> = {}
  for (let seed = 1; seed <= 3000; seed++) {
    const environment = new SimEnvironment(registry, { costs, seed })
    const result = await environment.execute({ skill: 'measured', strategy: 'measured' }, new AbortController().signal)
    seen[result.reason ?? result.outcome] = (seen[result.reason ?? result.outcome] ?? 0) + 1
    assert.equal(environment.now(), 750000, 'median ticks at 20 TPS without spread')
  }
  // P(death) = (5 + 5·0)/(20 + 5) = 0.2; P(success | alive) = (5 + 5·0.8)/25 = 0.36 → 0.288; the rest are failures.
  assert.ok(Math.abs(seen['simulated death']! / 3000 - 0.2) < 0.03, JSON.stringify(seen))
  assert.ok(Math.abs(seen.SUCCESS! / 3000 - 0.288) < 0.03, JSON.stringify(seen))
  assert.ok(Math.abs(seen['sampled skill failure']! / 3000 - 0.512) < 0.03, JSON.stringify(seen))
  const explicit = new SimEnvironment(registry, { costs, models: new Map([['measured', { seconds: 12, success: 1, death: 0 }]]) })
  assert.equal((await explicit.execute({ skill: 'measured', strategy: 'measured' }, new AbortController().signal)).outcome, 'SUCCESS')
  assert.equal(explicit.now(), 12000, 'explicit legacy model overrides imported costs')
})
test('Mineflayer environment rejects malformed status and preserves interrupted events', async () => {
  assert.throws(() => executionFromRpc({ status: 'invented' }), /Unknown RPC status/)
  assert.throws(() => executionFromRpc(null), /Malformed/)
  const environment = new MineflayerEnvironment({ read: async () => ({ state: { inventory: {}, dimension: 'overworld' } }),
    call: async () => ({ status: 'interrupted', events: [{ type: 'tactical_released' }] }), now: () => 0, sleep: async () => {} })
  const result = await environment.execute({ skill: 'mine' }, new AbortController().signal)
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.equal(result.events[0].type, 'tactical_released')
})
