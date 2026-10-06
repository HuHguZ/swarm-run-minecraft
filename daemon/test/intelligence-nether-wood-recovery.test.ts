import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import { fact } from '../src/core/world-state'
import type { Observation } from '../src/environments/mineflayer'

test('Full38 can recover wood with three adequate picks after exhausted Nether supply', async () => {
  const observation: Observation = { state: { dimension: 'the_nether', health: 20, food: 20,
    inventory: { oak_planks: 2, crafting_table: 1, stone_pickaxe: 2, iron_pickaxe: 1, cooked_beef: 12, ender_pearl: 2 },
    replanRevision: 0 }, facts: { portal: fact(true, 'observed', 0), nether_ready: fact(true, 'observed', 0),
      nether_tools_ready: fact(false, 'observed', 0), nether_pick_swings: fact(355, 'observed', 0),
      bastion: fact(true, 'map', 0), bastions_exhausted: fact(false, 'observed', 0),
      fortress: fact(true, 'map', 0), blaze_allowed: fact(false, 'observed', 0), endermen_allowed: fact(true, 'observed', 0) } }
  const calls: string[] = []
  let recovered = false
  const intelligence = createCampaignIntelligence({ eyes: 10, beds: 1, now: () => 0,
    observe: async () => observation, call: async () => ({}), sleep: async () => {}, record() {},
    execute: async command => {
      calls.push(command.skill)
      if (command.skill === 'wood' && recovered) {
        (observation.state.inventory as Record<string, number>).oak_log = 2
        observation.facts!.nether_tools_ready = fact(true, 'observed', 1)
      }
      return { outcome: command.skill === 'wood' ? 'SUCCESS' : 'FAILURE', events: [] }
    } })
  const supply = intelligence.registry.get('AcquireNetherTools')!
  await intelligence.director.run(supply); await intelligence.director.run(supply)
  observation.state.dimension = 'overworld'
  const repair = await intelligence.select([], () => false)
  assert.equal(repair?.strategy?.id, 'RecoverNetherWood')
  await repair!.stage.run()
  assert.equal(repair!.stage.done(), false, 'RPC success cannot invent wood or a ready toolkit')
  recovered = true
  const retry = await intelligence.select([], () => false)
  assert.equal(retry?.strategy?.id, 'RecoverNetherWood')
  await retry!.stage.run()
  assert.equal(retry!.stage.done(), true)
  assert.deepEqual(calls, ['netherTools', 'netherTools', 'wood', 'wood'])
  const next = intelligence.director.decide(await intelligence.environment.observe())
  assert.equal(next.reason, 'goal')
  assert.deepEqual(next.steps.slice(0, 2).map(step => step.id), ['EnterNether', 'BastionBarter'])
  const state = await intelligence.environment.observe()
  const wood = intelligence.registry.get('RecoverNetherWood')!
  assert.equal(wood.preconditions(state), false)
  state.facts.nether_tools_ready = fact(false, 'observed', 2)
  state.inventory.oak_log = 0
  state.facts.nether_pick_swings = fact(259, 'observed', 2)
  assert.equal(wood.preconditions(state), true, 'wood recovery remains available when the picks also need replenishment')
  state.facts.nether_pick_swings = fact(355, 'observed', 2)
  state.inventory.crafting_table = 0
  assert.equal(wood.preconditions(state), false, 'unrecovered table still needs its own producer')
})

test('Full42 recovers missing wood before replenishing worn picks instead of waiting in Overworld', async () => {
  const observation: Observation = { state: { dimension: 'the_nether', health: 20, food: 20,
    inventory: { spruce_planks: 6, crafting_table: 1, stone_pickaxe: 2, iron_pickaxe: 1, blackstone: 32, cooked_beef: 5 },
    replanRevision: 0 }, facts: { portal: fact(true, 'observed', 0), nether_ready: fact(true, 'observed', 0),
      nether_tools_ready: fact(false, 'observed', 0), nether_pick_swings: fact(223, 'observed', 0),
      bastion: fact(true, 'map', 0), bastions_exhausted: fact(false, 'observed', 0),
      fortress: fact(true, 'map', 0), blaze_allowed: fact(false, 'observed', 0) } }
  const intelligence = createCampaignIntelligence({ eyes: 10, beds: 1, now: () => 0,
    observe: async () => observation, call: async () => ({}), sleep: async () => {}, record() {},
    execute: async command => {
      if (command.skill === 'wood') (observation.state.inventory as Record<string, number>).spruce_log = 1
      return { outcome: command.skill === 'wood' ? 'SUCCESS' : 'FAILURE', events: [] }
    } })
  const supply = intelligence.registry.get('AcquireNetherTools')!
  await intelligence.director.run(supply); await intelligence.director.run(supply)
  observation.state.dimension = 'overworld'
  const before = await intelligence.environment.observe()
  assert.deepEqual(intelligence.director.decide(before).steps.slice(0, 4).map(step => step.id),
    ['RecoverNetherWood', 'EnterNether', 'AcquireNetherTools', 'BastionBarter'])
  assert.equal(intelligence.director.canRun(supply, before), false, 'a planned log does not reset the live failure budget')
  const allowed = new Set(intelligence.registry.all().filter(strategy => strategy.id !== supply.id).map(strategy => strategy.id))
  assert.equal(intelligence.director.decide(before, allowed).reason, 'unreachable', 'prerequisite planning cannot override an explicit exclusion')
  const repair = await intelligence.select([], () => false)
  assert.equal(repair?.strategy?.id, 'RecoverNetherWood')
  await repair!.stage.run()
  assert.equal(repair!.stage.done(), true)
  assert.equal(observation.facts!.nether_tools_ready.value, false, 'collecting a log does not repair a worn pick')
  assert.deepEqual(intelligence.director.decide(await intelligence.environment.observe()).steps.slice(0, 3).map(step => step.id),
    ['EnterNether', 'AcquireNetherTools', 'BastionBarter'])
})
