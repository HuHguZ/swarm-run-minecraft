import test from 'node:test'
import assert from 'node:assert/strict'
import { bestWeapon } from '../src/items'
import { createEquipment } from '../src/pvp/equipment'

test('a mace-only combat kit keeps its real weapon after landing and retargeting', async () => {
  const item = { name: 'mace' }, calls = []
  const bot = { inventory: { items: () => [item] }, heldItem: item, equip: async () => calls.push('equip'), unequip: async () => calls.push('unequip') }
  const ctx: any = { bot, bestWeapon, chosenWeapon: null, heldName: () => bot.heldItem?.name, findItem: (_b, fn) => bot.inventory.items().find(fn), switched: () => {} }
  await createEquipment(ctx).holdWeapon()
  assert.equal(ctx.weapon, item)
  assert.deepEqual(calls, [])
  for (const name of ['trident', 'iron_spear']) assert.equal(bestWeapon({ inventory: { items: () => [{ name }] } }).name, name)
})

test('existing sword and axe priorities remain stable when a mace is also carried', () => {
  const items = [{ name: 'mace' }, { name: 'diamond_axe' }, { name: 'iron_sword' }]
  assert.equal(bestWeapon({ inventory: { items: () => items } }).name, 'iron_sword')
  assert.equal(bestWeapon({ inventory: { items: () => items.slice(0, 2) } }).name, 'diamond_axe')
})
