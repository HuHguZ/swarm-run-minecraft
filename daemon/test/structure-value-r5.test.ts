import test from 'node:test'
import assert from 'node:assert/strict'
import { structureWorth, describeWorth, withNight } from '../src/campaign/structure-value'

const needs = (extra: any = {}) => ({ iron: 8, lighter: true, food: 8, portal: false, diamondPick: true, beds: 5, gold: 4, ...extra })
function flags(env: Record<string, string>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  try { Object.assign(process.env, env); run() } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value }
}

test('R5 dekk1: default still prices the map at 265 seconds and goes to the ruin', () => {
  flags({ ND_STRUCT_MAP_RECEIPTS: '0', ND_STRUCT_GOLD_RECEIPTS: '0', ND_STRUCT_WATER_RISK: '0' }, () => {
    const w = structureWorth('ocean_ruin', 84, needs())!
    assert.equal(Math.round(w.chain!), 265)
    assert.equal(Math.round(w.value), 278)
    assert.ok(w.net > 0)
  })
})
test('R5: no completed ocean-map chain is prepaid; a known treasure and shipwreck retain their price', () => {
  flags({ ND_STRUCT_MAP_RECEIPTS: '1' }, () => {
    const w = structureWorth('ocean_ruin', 84, needs())!
    assert.equal(w.chain, 0); assert.ok(w.net < 0)
    assert.ok(structureWorth('buried_treasure', 20, needs())!.net > 0)
    assert.ok(structureWorth('shipwreck', 20, needs(), [{ table: 'shipwreck_map', p: 1 }])!.chain! > 0)
  })
})
test('R5: the unobserved protection premium drops from 409 seconds; actual gold keeps its resource value', () => {
  flags({ ND_STRUCT_GOLD_RECEIPTS: '1' }, () => {
    const w = structureWorth('ruined_portal', 146, needs({ iron: 0, lighter: false, food: 0 }))!
    assert.ok(w.net < 0)
    assert.ok(Math.abs(w.items.find(row => row[0] === 'gold')![2] - .93 * 2) < 1e-9)
    assert.ok(w.items.find(row => row[0] === 'golden_armor')![2] > 0)
    assert.ok(structureWorth('ruined_portal', 20, needs())!.net > 0, 'a useful nearby ignition chest remains an option')
  })
})
test('R5 water risk: six deaths in 27 exposure episodes cost 800 seconds at the graph death price', () => {
  flags({ ND_STRUCT_WATER_RISK: '1', ND_DEATH_COST_MIN: '60' }, () => {
    const w = structureWorth('ocean_ruin', 84, needs())!
    assert.ok(Math.abs(w.waterRisk! - 800) < 1e-9); assert.ok(w.net < 0)
    assert.match(describeWorth(w), /подводный риск −800 с/)
    assert.ok(w.cost < 120, 'mortality price must not inflate physical ETA or RPC timeout')
    assert.equal(withNight(w, 120).night, undefined, 'a daytime arrival does not become night because risk has a time price')
    assert.ok(withNight(w, 0).night! > 0)
  })
})
test('R5: shipwrecks and a dry fitted ruin do not inherit the ocean-ruin mortality prior', () => {
  flags({ ND_STRUCT_WATER_RISK: '1' }, () => {
    assert.equal(structureWorth('shipwreck', 20, needs())!.waterRisk, 0)
    assert.equal(structureWorth('ocean_ruin', 20, needs(), [{ table: 'underwater_ruin_small', p: 1, wet: false }])!.waterRisk, 0)
  })
})
test('R5: underwater risk follows the existing death-cost setting', () => {
  flags({ ND_STRUCT_WATER_RISK: '1', ND_DEATH_COST_MIN: '6' }, () => assert.equal(structureWorth('ocean_ruin', 84, needs())!.waterRisk, 80))
})
