import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaignIntelligence, type CampaignPort, type CampaignStage } from '../src/campaign/intelligence'
import type { Observation } from '../src/environments/mineflayer'
import type { DecisionRecord } from '../src/core/strategy'
import { scoutStructures, type StructureSearchPort } from '../src/campaign/structure-search'
import { fact } from '../src/core/world-state'

function campaignFixture(mode: 'complete' | 'unchanged' | 'interrupted' = 'complete') {
  const observation: Observation = { state: { dimension: 'overworld', health: 20, food: 20, inventory: {}, replanRevision: 0 },
    facts: { endermen_allowed: { status: 'known', value: true, source: 'observed', at: 0, confidence: 1 } } }
  const calls: string[] = []
  const decisions: DecisionRecord[] = []
  let observed = 0
  let reportedReady = false
  const stage: CampaignStage = { name: 'route', needed: () => observation.state.dimension === 'overworld', ready: () => true, defer: () => false,
    done: () => reportedReady, async run() { reportedReady = true; if (mode !== 'unchanged') observation.state.dimension = 'the_nether' } }
  const port: CampaignPort = { eyes: 12, beds: 7, now: () => 0, sleep: async () => {}, record: row => decisions.push(row),
    observe: async () => { observed++; return observation }, call: async () => ({ status: 'done' }),
    execute: async command => {
      calls.push(command.skill)
      assert.equal(command.skill, 'route')
      await stage.run()
      if (mode === 'interrupted') observation.state.replanRevision = 1
      return { outcome: 'SUCCESS', events: mode === 'interrupted' ? [{ type: 'tactical_released' }] : [] }
    } }
  const intelligence = createCampaignIntelligence(port)
  const mapped = intelligence.registry.get('MappedOverworldRoute')!
  mapped.estimateCost = () => 1
  mapped.estimateRisk = () => 0
  return { intelligence, stage, calls, decisions, observation, observed: () => observed }
}

test('mapped route is a competing registered graph edge and runs through verified environment execution', async () => {
  const f = campaignFixture()
  const selected = await f.intelligence.select([f.stage], () => false)
  assert.equal(selected?.strategy?.id, 'MappedOverworldRoute')
  await selected!.stage.run()
  assert.deepEqual(f.calls, ['route'])
  assert.equal(selected!.stage.done(), true)
  assert.equal(selected!.stage.progressed?.(), true)
  assert.ok(f.observed() >= 3)
  assert.equal(f.decisions.find(row => row.level === 'strategy')?.outcome, 'SUCCESS')
  // Конкуренция по цене — без «маршрут по карте первым» (S8 07.10: ND_ROUTE_FIRST по умолчанию вкл.).
  const oldFirst = process.env.ND_ROUTE_FIRST
  process.env.ND_ROUTE_FIRST = '0'
  try {
    const highCost = campaignFixture()
    highCost.intelligence.registry.get('MappedOverworldRoute')!.estimateCost = () => 1e9
    assert.notEqual((await highCost.intelligence.select([highCost.stage], () => false))?.strategy?.id, 'MappedOverworldRoute')
  } finally { if (oldFirst === undefined) delete process.env.ND_ROUTE_FIRST; else process.env.ND_ROUTE_FIRST = oldFirst }
})

test('mapped route RPC success cannot manufacture a completed nether milestone', async () => {
  const f = campaignFixture('unchanged')
  const selected = await f.intelligence.select([f.stage], () => false)
  await selected!.stage.run()
  assert.equal(selected!.stage.done(), false)
  assert.equal(selected!.stage.progressed?.(), false)
  assert.equal(f.decisions.find(row => row.level === 'strategy')?.outcome, 'FAILURE')
})

test('tactical release invalidates a mapped route result even after apparent nether arrival', async () => {
  const f = campaignFixture('interrupted')
  const selected = await f.intelligence.select([f.stage], () => false)
  await selected!.stage.run()
  assert.equal(selected!.stage.interrupted?.(), true)
  assert.equal(selected!.stage.done(), false)
  assert.equal(f.decisions.find(row => row.level === 'strategy')?.outcome, 'INTERRUPTED')
  assert.equal(f.intelligence.registry.get('MappedOverworldRoute')!.preconditions((await f.intelligence.environment.observe())), false)
})

test('tactical control blocks both selection and a strategic action selected before the interruption', async () => {
  const f = campaignFixture()
  const selected = await f.intelligence.select([f.stage], () => false)
  f.observation.state.tactics = { threatLevel: 2 }
  assert.equal(await f.intelligence.select([f.stage], () => false), null)
  await selected!.stage.run()
  assert.deepEqual(f.calls, [])
  assert.equal(selected!.stage.interrupted?.(), true)
  await f.intelligence.wrap(f.stage).run()
  assert.deepEqual(f.calls, [])
})

test('graph still executes a known Bastion after the legacy dry counter removed it from needed stages', async () => {
  const observation: Observation = { state: { dimension: 'the_nether', health: 20, food: 20,
    pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 2, iron_pickaxe: 1, cooked_beef: 12 }, replanRevision: 0 },
    known: { fortress: { x: -326, y: 69, z: 101 } }, facts: { bastion: fact(true, 'map', 0), bastions_exhausted: fact(false, 'observed', 0),
      blaze_allowed: fact(false, 'observed', 0), nether_tools_ready: fact(true, 'observed', 0), endermen_allowed: fact(true, 'observed', 0),
      bastion_position: fact({ x: 87, y: 35, z: 139 }, 'map', 0) } }
  const calls: string[] = []
  const decisions: DecisionRecord[] = []
  let minedOnly = true
  const intelligence = createCampaignIntelligence({ eyes: 12, beds: 7, now: () => 0, sleep: async () => {}, record: row => decisions.push(row),
    observe: async () => observation, call: async () => ({}), execute: async command => {
      calls.push(command.skill)
      if (minedOnly) observation.state.inventory = { ...observation.state.inventory as Record<string, number>, netherrack: 1 }
      else observation.state.inventory = { ...observation.state.inventory as Record<string, number>, ender_pearl: 12 }
      return { outcome: 'SUCCESS', events: [] }
    } })
  const selected = await intelligence.select([], () => false)
  assert.equal(selected?.strategy?.id, 'BastionBarter')
  await selected!.stage.run()
  assert.equal(selected!.stage.done(), false)
  assert.equal(selected!.stage.progressed?.(), false)
  assert.equal(decisions.at(-1)?.outcome, 'FAILURE')
  minedOnly = false
  const retry = await intelligence.select([], () => false)
  assert.equal(retry?.strategy?.id, 'BastionBarter')
  await retry!.stage.run()
  assert.equal(retry!.stage.done(), true)
  assert.deepEqual(calls, ['bastion', 'bastion'])
  assert.equal(decisions.at(-1)?.outcome, 'SUCCESS')
})

test('pearls complete, no fire resistance and no source of it: the graph goes to the spawner (FR is a price, not a gate)', async () => {
  const observation: Observation = { state: { dimension: 'the_nether', health: 20, food: 20,
    inventory: { stone_pickaxe: 2, cooked_beef: 12, ender_pearl: 12, shield: 1 }, replanRevision: 0 },
    known: { fortress: { x: -326, y: 69, z: 101 } }, facts: { bastion: fact(true, 'map', 0),
      bastions_exhausted: fact(true, 'observed', 0), blaze_allowed: fact(true, 'observed', 0),
      nether_tools_ready: fact(true, 'observed', 0), fire_resistance_count: fact(0, 'observed', 0),
      fire_resistance_active: fact(false, 'observed', 0), endermen_allowed: fact(true, 'observed', 0) } }
  const calls: string[] = []
  const intelligence = createCampaignIntelligence({ eyes: 12, beds: 7, now: () => 0, sleep: async () => {}, record() {},
    observe: async () => observation, call: async () => ({}), execute: async command => { calls.push(command.skill); return { outcome: 'SUCCESS', events: [] } } })
  const selected = await intelligence.select([], () => false)
  assert.equal(selected?.strategy?.id, 'GetBlazeRods')
  await selected!.stage.run()
  assert.deepEqual(calls, ['nether'])
})

test('actual registered NetherTools skill rejects incidental digging and accepts useful wood', async () => {
  const observation: Observation = { state: { dimension: 'the_nether', health: 20, food: 20,
    inventory: { iron_pickaxe: 1, oak_planks: 6, crafting_table: 1, cooked_beef: 12, ender_pearl: 12 } },
    facts: { nether_tools_ready: fact(false, 'observed', 0), nether_pick_swings: fact(300, 'observed', 0) } }
  let useful = false
  const intelligence = createCampaignIntelligence({ eyes: 12, beds: 7, now: () => 0, sleep: async () => {}, record() {},
    observe: async () => observation, call: async () => ({}), execute: async command => {
      assert.equal(command.skill, 'netherTools')
      observation.state.inventory = { ...observation.state.inventory as Record<string, number>,
        ...(useful ? { crimson_stem: 1 } : { netherrack: 128 }) }
      return { outcome: 'FAILURE', reason: 'supply remains incomplete', events: [] }
    } })
  const strategy = intelligence.registry.get('AcquireNetherTools')!
  assert.equal((await intelligence.director.run(strategy, await intelligence.environment.observe())).outcome, 'FAILURE')
  useful = true
  assert.equal((await intelligence.director.run(strategy, await intelligence.environment.observe())).outcome, 'PARTIAL')
})

function searchFixture(foundAt: number, blocked = false) {
  let now = 0
  const facts: Record<string, unknown> = {}
  const legs: number[] = []
  const port: StructureSearchPort = { now: () => now, position: () => ({ x: 0, z: 0 }), interrupted: () => false,
    scan: async () => {}, list: async () => now >= foundAt ? [{ kind: 'village', at: { x: 90, z: 15 } }] : [],
    async explore(_direction, seconds) { legs.push(seconds); if (!blocked) now += seconds * 1000 },
    async move(_at, seconds) { if (!blocked) now += seconds * 1000 }, fact: (name, value) => { facts[name] = value }, log() {} }
  return { port, facts, legs }
}
test('building search actually spends remaining game time and preserves unknown global absence', async () => {
  const f = searchFixture(Infinity)
  const result = await scoutStructures(f.port, 120000)
  assert.deepEqual(result, { spentMs: 180000, found: false, blocked: false })
  assert.deepEqual(f.legs, [30, 30])
  assert.equal('village' in f.facts, false)
  assert.equal('shipwreck' in f.facts, false)
  const found = searchFixture(30000)
  assert.equal((await scoutStructures(found.port, 0)).found, true)
  assert.equal(found.facts.village, true)
  assert.deepEqual(found.facts.village_position, { x: 90, z: 15 })
  const stuck = searchFixture(Infinity, true)
  assert.deepEqual(await scoutStructures(stuck.port, 0), { spentMs: 0, found: false, blocked: true })
  assert.equal(stuck.facts.structure_search_blocked, true)
})
