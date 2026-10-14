import test from 'node:test'
import assert from 'node:assert/strict'
const { structureWorth, describeWorth } = require('../src/campaign/structure-value')

const needs = (o: any = {}) => ({ iron: 8, lighter: true, food: 8, portal: false, diamondPick: true, beds: 5, ...o })

test('ruins in sight pay off while the lighter is missing, not when it is already there', () => {
  const missing = structureWorth('ruined_portal', 60, needs())
  assert.ok(missing.net > 0, describeWorth(missing))
  assert.match(describeWorth(missing), /lighter/)
  const carried = structureWorth('ruined_portal', 60, needs({ lighter: false, iron: 0 }))
  assert.ok(carried.net < 0, describeWorth(carried))
})

test('a far village is not worth the walk, a near one is', () => {
  assert.ok(structureWorth('village', 20, needs()).net > 0)
  assert.ok(structureWorth('village', 400, needs()).net < 0)
})

test('gold alone never pays for a detour (user 14.10: gold for armour and barter comes from the Nether)', () => {
  const w = structureWorth('jungle_pyramid', 40, needs({ iron: 0, lighter: false, food: 0, diamondPick: false, beds: 0 }))
  assert.ok(w.net < 0, describeWorth(w))
})

test('a shipwreck walk costs half again for the water', () => {
  assert.ok(structureWorth('shipwreck', 100, needs()).walk > structureWorth('village', 100, needs()).walk)
  assert.equal(structureWorth('outpost', 10, needs()), null)
})
