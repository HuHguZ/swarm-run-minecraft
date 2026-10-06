import test from 'node:test'
import assert from 'node:assert/strict'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState)

test('landing rules follow 1.21.11 fallOn: bed halves distance, honey and hay scale damage, powder snow and slime are harmless', () => {
  const { landingDamage, hasFallMitigation } = require('../src/navigation/landing')
  assert.equal(landingDamage(block('stone'), 10), 7)
  assert.equal(landingDamage(block('red_bed'), 10), 2, 'BedBlock.fallOn passes distance*0.5 to Block.fallOn (multiplier 1)')
  assert.equal(landingDamage(block('red_bed'), 7), 0)
  assert.equal(landingDamage(block('honey_block'), 10), 1, 'HoneyBlock.fallOn: causeFallDamage(distance, 0.2f)')
  assert.equal(landingDamage(block('hay_block'), 10), 1)
  assert.equal(landingDamage(block('powder_snow'), 40), 0)
  assert.equal(landingDamage(block('slime_block'), 40), 0)
  assert.equal(hasFallMitigation(block('honey_block')), true)
  assert.equal(hasFallMitigation(block('red_bed')), false, 'native physics has no bed bounce; planners may not land on it yet')
  assert.equal(hasFallMitigation(block('stone')), false)
})
