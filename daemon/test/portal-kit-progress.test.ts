import test from 'node:test'
import assert from 'node:assert/strict'
import { speedrunRegistry } from '../src/core/speedrun'
import { StrategicDirector } from '../src/core/strategy'
import { emptyWorld, cloneWorld, fact } from '../src/core/world-state'

function fixture() {
  const registry = speedrunRegistry()
  const strategy = registry.get('CraftPortalKit')!
  const before = emptyWorld()
  before.position = { x: 60, y: 17, z: -19 }
  before.inventory = { iron_ingot: 3, bucket: 1, stone_pickaxe: 4, oak_planks: 1, cobblestone: 324 }
  before.resources = { iron: 3, bucket: 1, lighter: 0, blocks: 366 }
  const director = new StrategicDirector(registry, { now: () => 0 } as any, { goal: () => false })
  return { before, strategy, director }
}

test('portal kit does not reset failures for tunnel cobble or unrelated discoveries', () => {
  const { before, strategy, director } = fixture()
  const after = cloneWorld(before)
  after.position = { x: 60, y: 17, z: -2 }
  after.inventory.cobblestone += 36
  after.resources.blocks += 36
  after.facts.night = fact(true, 'observed', 1)
  assert.equal(director.verify(strategy, before, after, { outcome: 'FAILURE', events: [] }), 'FAILURE')
  assert.equal(director.verify(strategy, before, after, { outcome: 'FAILURE', events: [] }), 'FAILURE')
  assert.deepEqual(director.exhaustedStrategies(), ['CraftPortalKit'])
})

test('actual gravel or flint acquisition is partial portal kit progress', () => {
  for (const item of ['gravel', 'flint']) {
    const { before, strategy, director } = fixture()
    const after = cloneWorld(before)
    after.inventory[item] = 1
    assert.equal(director.verify(strategy, before, after, { outcome: 'FAILURE', events: [] }), 'PARTIAL', item)
  }
})

test('a new observed flint search view is partial kit progress, while elapsed time and the same view are failures', () => {
  const { before, strategy, director } = fixture()
  before.facts.flint_search_views = fact(1, 'observed', 0)
  const after = cloneWorld(before)
  after.position = { x: 106, y: 68, z: 51 }
  after.elapsedMs += 62000
  after.facts.flint_search_views = fact(2, 'observed', 62000)
  assert.equal(director.verify(strategy, before, after, { outcome: 'FAILURE', events: [] }), 'PARTIAL')
  assert.equal(after.resources.lighter, 0)
  const stale = cloneWorld(after)
  stale.elapsedMs += 62000
  stale.position.x += 64
  assert.equal(director.verify(strategy, after, stale, { outcome: 'FAILURE', events: [] }), 'FAILURE')
  assert.equal(director.verify(strategy, after, stale, { outcome: 'FAILURE', events: [] }), 'FAILURE')
  assert.deepEqual(director.exhaustedStrategies(), ['CraftPortalKit'])
})

test('bucket crafting and conversion to spendable ingots are partial portal kit progress', () => {
  for (const item of ['bucket', 'iron_ingot']) {
    const { before, strategy, director } = fixture()
    before.inventory.bucket = 0
    before.inventory.iron_ingot = 0
    before.inventory.iron_nugget = 36
    before.resources.bucket = 0
    before.resources.iron = 4
    const after = cloneWorld(before)
    after.inventory[item] = item === 'bucket' ? 1 : 4
    if (item === 'bucket') after.resources.bucket = 1
    assert.equal(director.verify(strategy, before, after, { outcome: 'FAILURE', events: [] }), 'PARTIAL', item)
  }
})

test('repeated surplus material is not kit progress and a complete kit succeeds', () => {
  const { before, strategy, director } = fixture()
  before.inventory.gravel = 8
  const surplus = cloneWorld(before)
  surplus.inventory.gravel += 8
  assert.equal(director.verify(strategy, before, surplus, { outcome: 'FAILURE', events: [] }), 'FAILURE')
  const ready = cloneWorld(before)
  ready.resources.lighter = 1
  ready.inventory.flint_and_steel = 1
  assert.equal(director.verify(strategy, before, ready, { outcome: 'FAILURE', events: [] }), 'SUCCESS')
})
