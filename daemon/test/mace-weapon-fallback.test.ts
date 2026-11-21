import test from 'node:test'
import assert from 'node:assert/strict'
import { bestWeapon } from '../src/items'
import { createEquipment } from '../src/pvp/equipment'
import { assessSwarmFight } from '../src/swarm/fight'
import type { SwarmMember } from '../src/swarm/types'

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

test('melee equips a weapon from the offhand of a normal player inventory', async () => {
  const version = '1.21.11'
  const registry = require('minecraft-data')(version)
  const Item = require('prismarine-item')(version)
  const inv = require('prismarine-windows')(version).createWindow(0, 'minecraft:inventory', '')
  const bot: any = {
    inventory: inv, quickBarSlot: 0, supportFeature: (key: string) => registry.supportFeature(key),
    get heldItem() { return inv.slots[36 + this.quickBarSlot] },
    async moveSlotItem(from: number, to: number) {
      const source = inv.slots[from]
      inv.updateSlot(from, inv.slots[to])
      inv.updateSlot(to, source)
    }
  }
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  const ctx: any = { bot, bestWeapon, heldName: () => bot.heldItem?.name, switched: () => {} }
  const equipment = createEquipment(ctx)
  const put = (slot: number, name: string) => inv.updateSlot(slot, new Item(registry.itemsByName[name].id, 1))
  put(45, 'shield')
  await equipment.holdWeapon()
  assert.equal(bot.heldItem, null)
  assert.equal(inv.slots[45].name, 'shield')

  put(45, 'iron_sword')
  assert.deepEqual(inv.items(), [])
  await equipment.holdWeapon()
  assert.equal(bot.heldItem?.name, 'iron_sword')
  assert.equal(inv.slots[45], null)
})

test('melee can use a carried copper weapon above a wooden one', () => {
  for (const kind of ['sword', 'axe']) {
    const item = { name: 'copper_' + kind }
    assert.equal(bestWeapon({ inventory: { items: () => [{ name: 'wooden_' + kind }, item] } }), item)
  }
})

test('swarm values an accessible offhand weapon like the same unenchanted weapon in the bag', () => {
  const member: SwarmMember = { id: 'a', team: 'blue', position: { x: 0, y: 64, z: 0 }, health: 20, strength: 1, role: 'fighter' }
  const foe = { id: 'foe', position: { x: 2, y: 64, z: 0 }, source: 'a', sources: ['a'], seenAt: 1000 }
  const kill = (m: SwarmMember) => assessSwarmFight(m, [foe], [m]).killSeconds
  const bag = kill({ ...member, inventory: { iron_sword: 1 } })
  assert.ok(bag < kill(member))
  assert.equal(kill({ ...member, offHand: 'iron_sword' }), bag)
  assert.equal(kill({ ...member, offHand: 'shield' }), kill(member))
})
