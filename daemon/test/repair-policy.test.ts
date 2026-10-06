import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseRepairPair, repairDamage, type RepairItem } from '../src/conversions/repair-policy'
const item = (slot: number, damage: number, enchanted = false): RepairItem => ({ slot, damage, enchanted, name: 'iron_sword', count: 1, maxDamage: 250 })

test('two damaged regular items restore exact vanilla 5% durability and one slot', () => {
  const pair = chooseRepairPair([item(9, 200), item(10, 180)])!
  assert.equal(pair.mechanism, 'craft')
  assert.equal(pair.expectedDamage, 118)
  assert.equal(repairDamage(item(9, 200), item(10, 180)), 118)
})
test('any enchantment including curse exclusively requires anvil', () => {
  assert.equal(chooseRepairPair([item(9, 200, true), item(10, 180)])?.mechanism, 'anvil')
  assert.equal(chooseRepairPair([item(9, 200), { ...item(10, 180), modified: true }]), null)
})
test('repair never consumes a pristine tool or wastes combined useful durability', () => {
  assert.equal(chooseRepairPair([item(9, 0), item(10, 200)]), null)
  assert.equal(chooseRepairPair([item(9, 10), item(10, 20)]), null)
  assert.equal(chooseRepairPair([item(9, 200), { ...item(10, 180), name: 'diamond_sword' }]), null)
})
