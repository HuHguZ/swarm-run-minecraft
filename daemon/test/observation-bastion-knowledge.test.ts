import test from 'node:test'
import assert from 'node:assert/strict'
import { worldFromObservation } from '../src/environments/mineflayer'
import { fact, knows } from '../src/core/world-state'

test('an empty recalled bastion list does not invent a map fact in RSG', () => {
  const world = worldFromObservation({ state: { dimension: 'overworld', health: 20, inventory: {} },
    known: { bastion: null, bastions: [] }, map: null }, 10)
  assert.equal(knows(world, 'bastion'), false)
  assert.equal(world.facts.bastion_position, undefined)
})

test('an actually recalled bastion is observed knowledge without invented coordinates', () => {
  for (const known of [{ bastion: { x: 14, y: 60, z: 21 } }, { bastion: null, bastions: [{ x: 14, y: 60, z: 21 }] }]) {
    const world = worldFromObservation({ state: { dimension: 'the_nether', health: 20, inventory: {} }, known, map: null }, 10)
    assert.equal(knows(world, 'bastion'), true)
    assert.equal(world.facts.bastion.source, 'observed')
    assert.equal(world.facts.bastion_position, undefined)
  }
})

test('empty memory preserves an explicitly supplied fact and its provenance', () => {
  for (const existing of [fact(false, 'observed', 3), fact(true, 'map', 3)]) {
    const world = worldFromObservation({ state: { dimension: 'overworld', health: 20, inventory: {} },
      known: { bastion: null, bastions: [] }, map: null, facts: { bastion: existing } }, 10)
    assert.deepEqual(world.facts.bastion, existing)
  }
})
