import test from 'node:test'
import assert from 'node:assert/strict'
import { dragonGoal, speedrunRegistry } from '../src/core/speedrun'
import { StrategicDirector } from '../src/core/strategy'
import { amount, cloneWorld, emptyWorld, fact, type WorldState } from '../src/core/world-state'
import type { Environment, ExecutionResult } from '../src/core/environment'

function exhaustedSupply(goal: (current: WorldState) => boolean = current => amount(current, 'pearls') >= 10) {
  const state = emptyWorld()
  state.dimension = 'the_nether'
  state.inventory = { oak_planks: 4, crafting_table: 1, stone_pickaxe: 1, blackstone: 64 }
  state.resources = { pearls: 2, wood: 4, stone_tool: 1, food: 12 }
  state.facts = { bastion: fact(true, 'map', 0), portal: fact(true, 'observed', 0), nether_ready: fact(true, 'observed', 0),
    nether_tools_ready: fact(false, 'observed', 0), nether_pick_swings: fact(281, 'observed', 0) }
  const environment: Environment = { observe: async () => state, execute: async (): Promise<ExecutionResult> => ({ outcome: 'FAILURE', events: [] }),
    cancel: async () => undefined, now: () => state.elapsedMs, sleep: async milliseconds => { state.elapsedMs += milliseconds } }
  const registry = speedrunRegistry({ eyes: 10 })
  const director = new StrategicDirector(registry, environment, { goal })
  return { state, registry, director, supply: registry.get('AcquireNetherTools')! }
}

test('actual wood recovered in Overworld reopens exhausted Nether supply without an endless retry', async () => {
  const f = exhaustedSupply(dragonGoal)
  await f.director.run(f.supply); await f.director.run(f.supply)
  assert.equal(f.director.decide(f.state).reason, 'unreachable')
  f.state.dimension = 'overworld'
  f.state.inventory.oak_log = 3
  f.state.resources.wood = 7 // The observation counts three logs; supply can actually craft twelve planks.
  f.state.facts.nether_pick_swings = fact(174, 'observed', 1)
  const recovered = f.director.decide(f.state)
  assert.equal(recovered.reason, 'goal')
  assert.deepEqual(recovered.steps.slice(0, 3).map(step => step.id), ['EnterNether', 'AcquireNetherTools', 'BastionBarter'])
  f.state.dimension = 'the_nether'
  await f.director.run(f.supply); await f.director.run(f.supply)
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'unchanged recovered stock gets only the existing two attempts')
})

test('dimension, healing, time and unrelated stock cannot revive a failed wood prerequisite', async () => {
  const f = exhaustedSupply()
  await f.director.run(f.supply); await f.director.run(f.supply)
  f.state.dimension = 'overworld'; f.state.elapsedMs += 3600000; f.state.health = 19; f.state.hunger = 18
  f.state.resources.blocks = 500
  f.state.inventory.blackstone = 128; f.state.inventory.iron_ingot = 12; f.state.inventory.stone_pickaxe = 3
  assert.equal(f.director.decide(f.state).steps[0]?.id, 'RecoverNetherWood', 'Overworld can gather the missing wood without reviving the failed producer')
  assert.equal(f.director.canRun(f.supply, f.state), false)
  f.state.health = 20; f.state.hunger = 20; f.state.dimension = 'the_nether'
  assert.equal(f.director.decide(f.state).reason, 'unreachable')
})

test('supply retry recognizes newly usable pick ingredients only when the pick reserve was missing', () => {
  const f = exhaustedSupply()
  const failed = cloneWorld(f.state)
  failed.inventory.oak_planks = 16
  failed.facts.nether_pick_swings = fact(50, 'observed', 0)
  failed.inventory.blackstone = 0
  failed.inventory.stick = 2
  const current = cloneWorld(failed)
  current.inventory.blackstone = 3
  assert.equal(f.supply.retryCondition?.(failed, current), true)
  const supplied: WorldState = cloneWorld(failed)
  supplied.facts.nether_pick_swings = fact(281, 'observed', 0)
  assert.equal(f.supply.retryCondition?.(supplied, { ...current, facts: supplied.facts }), false)
})

test('a complete carried nugget recipe reopens exhausted pick supply and still bounds the same stock', async () => {
  const f = exhaustedSupply()
  f.state.inventory = { oak_planks: 16, crafting_table: 1, iron_pickaxe: 1, stick: 3, iron_ingot: 2, iron_nugget: 8 }
  f.state.resources.wood = 16
  f.state.facts.nether_pick_swings = fact(167, 'observed', 0)
  await f.director.run(f.supply); await f.director.run(f.supply)
  assert.equal(f.director.decide(f.state).reason, 'unreachable')
  f.state.inventory.iron_nugget = 64
  f.state.resources.iron = 9
  const next = f.director.decide(f.state)
  assert.equal(next.reason, 'goal')
  assert.equal(next.steps[0]?.id, 'AcquireNetherTools')
  await f.director.run(f.supply); await f.director.run(f.supply)
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'new material permits only the existing two attempts')
  f.state.inventory.iron_nugget = 80
  f.state.elapsedMs += 3600000; f.state.health = 19; f.state.inventory.enchanted_book = 1
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'excess recipe material and unrelated noise cannot restart the same failure')
})

test('pick-material retry counts only whole nugget groups and the actual block-to-nine-ingots recipe', () => {
  const f = exhaustedSupply()
  const before = cloneWorld(f.state)
  before.inventory = { oak_planks: 16, crafting_table: 1, iron_pickaxe: 1, stick: 3, iron_ingot: 0, iron_nugget: 26 }
  before.facts.nether_pick_swings = fact(167, 'observed', 0)
  const threeGroups = cloneWorld(before)
  threeGroups.inventory.iron_nugget = 27
  assert.equal(f.supply.retryCondition?.(before, threeGroups), true)
  const block = cloneWorld(before)
  block.inventory.iron_nugget = 8; block.inventory.iron_block = 1
  assert.equal(f.supply.retryCondition?.(before, block), true)
  const stillShort = cloneWorld(before)
  stillShort.inventory.iron_nugget = 8
  assert.equal(f.supply.retryCondition?.(stillShort, before), false, 'two whole ingots still cannot make the pick')
  const alreadyEnough = cloneWorld(threeGroups)
  alreadyEnough.inventory.iron_nugget = 35
  assert.equal(f.supply.retryCondition?.(threeGroups, alreadyEnough), false, 'the eight leftover nuggets do not change recipe availability')
  const supplied = cloneWorld(before)
  supplied.facts.nether_pick_swings = fact(281, 'observed', 0)
  assert.equal(f.supply.retryCondition?.(supplied, { ...block, facts: supplied.facts }), false)
  const noise = cloneWorld(before)
  noise.resources.iron = 99; noise.elapsedMs += 100000; noise.health = 19
  assert.equal(f.supply.retryCondition?.(before, noise), false, 'recipe eligibility uses actual inventory, not an unrelated aggregate change')
})
