import test from 'node:test'
import assert from 'node:assert/strict'
import { speedrunRegistry } from '../src/core/speedrun'
import { StrategicDirector } from '../src/core/strategy'
import { amount, emptyWorld, fact } from '../src/core/world-state'
import { netherStageProgress } from '../src/campaign/nether-progress'
import type { Environment, ExecutionResult } from '../src/core/environment'

function fixture(changeDuringSecondAttempt: boolean) {
  const state = emptyWorld()
  state.dimension = 'the_nether'
  state.position = { x: 96, y: 49, z: 143 }
  state.inventory = { oak_planks: 8, crafting_table: 1, iron_pickaxe: 1, stone_pickaxe: 2 }
  state.resources = { pearls: 2, food: 12, wood: 8, stone_tool: 3 }
  state.facts = { bastion: fact(true, 'map', 0), bastions_exhausted: fact(false, 'observed', 0),
    bastion_position: fact({ x: 87, y: 35, z: 139 }, 'map', 0),
    nether_tools_ready: fact(true, 'observed', 0), nether_pick_swings: fact(413, 'observed', 0) }
  let attempts = 0
  const environment: Environment = { observe: async () => state,
    execute: async (): Promise<ExecutionResult> => {
      attempts++
      if (changeDuringSecondAttempt && attempts === 2) state.facts.bastion_position = fact({ x: 545, y: 48, z: -99 }, 'map', 1)
      return { outcome: 'FAILURE', events: [] }
    },
    cancel: async () => undefined, now: () => state.elapsedMs, sleep: async milliseconds => { state.elapsedMs += milliseconds } }
  const registry = speedrunRegistry({ eyes: 10 })
  const bastion = registry.get('BastionBarter')!
  bastion.progressCondition = (before, after) => netherStageProgress('bastion', before, after)
  const director = new StrategicDirector(registry, environment, { goal: current => amount(current, 'pearls') >= 10 })
  return { state, bastion, director }
}

test('a failed B1 attempt that selects B2 reopens the existing strategy for its actual new site', async () => {
  const f = fixture(true)
  assert.equal((await f.director.run(f.bastion)).outcome, 'FAILURE')
  assert.equal((await f.director.run(f.bastion)).outcome, 'FAILURE', 'site selection is not a fabricated resource gain')
  const next = f.director.decide(f.state)
  assert.equal(next.reason, 'goal')
  assert.equal(next.steps[0]?.id, 'BastionBarter')
  assert.equal(f.state.facts.bastions_exhausted.value, false)
  await f.director.run(f.bastion); await f.director.run(f.bastion)
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'the same second site still gets only two failed attempts')
})

test('healing, time, incidental stock and vertical target refinement cannot reset a stalled bastion', async () => {
  const f = fixture(false)
  await f.director.run(f.bastion); await f.director.run(f.bastion)
  f.state.elapsedMs += 3600000
  f.state.health = 19; f.state.hunger = 18
  f.state.inventory.blackstone = 64; f.state.inventory.enchanted_book = 1
  f.state.resources.blocks = 128
  f.state.facts.bastion_position = fact({ x: 87, y: 50, z: 139 }, 'map', 999)
  assert.equal(f.director.decide(f.state).reason, 'unreachable')
  f.state.facts.bastion_position = fact(null, 'map', 1000)
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'losing the known site is not a new observed alternative')
})

test('the real next bastion reopens tool replenishment before travel after a depleted B1 attempt', async () => {
  const f = fixture(false)
  await f.director.run(f.bastion); await f.director.run(f.bastion)
  f.state.facts.nether_tools_ready = fact(false, 'observed', 1)
  f.state.facts.nether_pick_swings = fact(234, 'observed', 1)
  assert.equal(f.director.decide(f.state).reason, 'unreachable', 'a worn pick alone cannot reset a failed site')
  f.state.facts.bastion_position = fact({ x: 545, y: 48, z: -99 }, 'map', 1)
  const next = f.director.decide(f.state)
  assert.equal(next.reason, 'goal')
  assert.deepEqual(next.steps.slice(0, 2).map(step => step.id), ['AcquireNetherTools', 'BastionBarter'])
  assert.equal(f.state.facts.bastions_exhausted.value, false)
})
