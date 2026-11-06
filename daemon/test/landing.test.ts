import test from 'node:test'
import assert from 'node:assert/strict'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState)

test('landing rules follow 1.21.11 fallOn: bed halves distance, honey and hay scale damage, powder snow and slime are harmless', () => {
  const { landingDamage, hasFallMitigation }: typeof import('../src/navigation/landing') = require('../src/navigation/landing')
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

test('wind fall damage uses the victim impact height and the native support rule', () => {
  const { windFallDamage }: typeof import('../src/navigation/landing') = require('../src/navigation/landing')
  const plain = { equipment: [], unknownArmorSlots: 0, ordinaryFall: true }
  assert.deepEqual(windFallDamage(block('smooth_sandstone_slab'), 29.11813, 150.5, 165.37794555051443, plain), { lower: 11, upper: 11, visibleTotem: false })
  assert.deepEqual(windFallDamage(block('stone'), 50, 120, 120, plain), { lower: 0, upper: 0, visibleTotem: false })
  assert.equal(windFallDamage(block('red_bed'), 100, 120, 130, plain)?.upper, 7, 'BedBlock scales fall distance before Player caps it to the wind impact height')
  assert.equal(windFallDamage(block('hay_block'), 100, 120, 173, plain)?.upper, 10)
  assert.equal(windFallDamage(null, 100, 120, 173, plain), null)
})

test('wind fall estimate prices only public equipment and leaves an uncertain save possible', () => {
  const { windFallDamage }: typeof import('../src/navigation/landing') = require('../src/navigation/landing')
  const armor = ['boots', 'leggings', 'chestplate', 'helmet'].map(slot => ({ name: 'netherite_' + slot, enchanted: true }))
  const view = { equipment: [null, { name: 'totem_of_undying', enchanted: false }, ...armor], unknownArmorSlots: 0, ordinaryFall: true }
  for (const key of ['health', 'hp', 'attributes']) Object.defineProperty(view, key, { get() { throw Error('private player data') } })
  const estimate = windFallDamage(block('stone'), 30, 120, 133, view)!
  assert.equal(estimate.upper, 10)
  assert.ok(Math.abs(estimate.lower - 2) < 1e-6, 'possible Feather Falling and Protection cap at 20 EPF')
  assert.equal(estimate.visibleTotem, true)
  const withoutImpact = windFallDamage(block('stone'), 30, 120, undefined, view)
  assert.equal(withoutImpact?.upper, 27, 'a fall without a new wind impact has no cap from that shot')
  assert.ok(withoutImpact.lower < 6, 'ordinary falls must use the same visible protection as a wind-assisted fall')
  assert.equal(withoutImpact.visibleTotem, true)
  assert.equal(windFallDamage(block('stone'), 30, 120, 133, { ...view, gliding: true })?.lower, 0)
  assert.equal(windFallDamage(block('stone'), 30, 120, 133, { ...view, ordinaryFall: false })?.lower, 0)
  const equipment = [...view.equipment]; equipment[4] = null
  assert.equal(windFallDamage(block('stone'), 30, 120, 133, { ...view, equipment, unknownArmorSlots: 1 })?.lower, 0, 'an unseen chest slot can hide elytra')
  equipment[4] = { name: 'elytra', enchanted: false }
  assert.equal(windFallDamage(block('stone'), 30, 120, 133, { ...view, equipment })?.lower, 0)
})
