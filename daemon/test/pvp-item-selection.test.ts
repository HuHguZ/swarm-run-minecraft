import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'

const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const locks = require('../src/reflex-lock')
const { createEquipment } = require('../src/pvp/equipment')
const { potionOf } = require('../src/pvp')

function item(name: string, slot: number, components: any[] = []) {
  const out = new Item(registry.itemsByName[name].id, 1)
  out.slot = slot
  out.components = components
  out.componentMap = new Map(components.map(c => [c.type, c]))
  return out
}
const potion = (slot: number, name: string) => item('splash_potion', slot, [{ type: 'potion_contents', data: { potionId: name } }])

function fixture(items: any[], wrapped = false) {
  const bot: any = new EventEmitter()
  const equipped: any[] = []; const used: string[] = []
  bot.registry = registry
  bot.inventory = require('prismarine-windows')('1.21.11').createWindow(0, 'minecraft:inventory', 'Inventory')
  for (const it of items) bot.inventory.updateSlot(it.slot, it)
  bot.heldItem = items[0]
  bot.equip = async (chosen, hand) => { equipped.push({ item: chosen, hand }); bot.heldItem = chosen }
  bot.look = async () => {}
  bot.activateItem = () => used.push(potionOf(bot.heldItem) || bot.heldItem.name)
  bot.deactivateItem = () => {}
  const ctx: any = { bot, heldName: () => bot.heldItem?.name, switched: () => {}, sleep: async () => {} }
  if (wrapped) locks.install({ bot, current: null, reflex: null })
  return { bot, ctx, eq: createEquipment(ctx), equipped, used }
}

test('equip under reflex lock keeps the requested healing potion when harming of the same type is first', async () => {
  const harm = potion(36, 'strong_harming'); const heal = potion(37, 'strong_healing')
  const f = fixture([harm, heal], true)
  assert.equal(await f.eq.holdItem(heal), true)
  assert.equal(f.bot.heldItem, heal)
  assert.equal(f.equipped[0].item, heal)
})

test('equip refresh finds the same potion in its new slot and refuses a vanished selection', async () => {
  const stale = potion(37, 'strong_healing'); const moved = potion(40, 'strong_healing')
  const harm = potion(37, 'strong_harming')
  const f = fixture([harm, moved], true)
  await f.bot.equip(stale, 'hand')
  assert.equal(f.bot.heldItem, moved)
  const missing = fixture([harm], true)
  await assert.rejects(missing.bot.equip(stale, 'hand'), { code: 'REFLEX_ITEM_GONE' })
  assert.equal(missing.equipped.length, 0, 'do not use the old slot after the requested stack vanished')
})

test('equip preserves the chosen enchanted weapon and the chosen totem slot and hand', async () => {
  const plain = item('diamond_sword', 36)
  const sharp = item('diamond_sword', 38, [{ type: 'enchantments', data: { enchantments: [{ id: 16, level: 5 }] } }])
  const firstTotem = item('totem_of_undying', 39); const chosenTotem = item('totem_of_undying', 40)
  const f = fixture([plain, sharp, firstTotem, chosenTotem], true)
  await f.bot.equip(sharp, 'hand')
  await f.bot.equip(chosenTotem, 'off-hand')
  assert.deepEqual(f.equipped, [{ item: sharp, hand: 'hand' }, { item: chosenTotem, hand: 'off-hand' }])
})

test('equip accepts the actual selected offhand or armor slot outside inventory.items()', async () => {
  const shield = item('shield', 45); const chestplate = item('diamond_chestplate', 6)
  const f = fixture([shield, chestplate], true)
  assert.deepEqual(f.bot.inventory.items(), [], 'Prismarine inventory.items() lists only slots 9..44')
  await f.bot.equip(shield, 'hand')
  await f.bot.equip(chestplate, 'hand')
  assert.deepEqual(f.equipped, [{ item: shield, hand: 'hand' }, { item: chestplate, hand: 'hand' }])
})

test('self splash refuses a harmful potion that replaced healing while the aim was awaiting', async () => {
  const harm = potion(36, 'strong_harming'); const heal = potion(37, 'strong_healing')
  const f = fixture([harm, heal])
  assert.equal(await f.eq.holdItem(heal), true)
  f.ctx.sleep = async () => { f.bot.heldItem = harm }
  const ok = await f.eq.useAt(0, -Math.PI / 2, { item: heal })
  assert.deepEqual(f.used, [], 'no use_item for harmful contents under our feet')
  assert.equal(ok, false)
  assert.equal(f.ctx.aim, 'target')
})

test('self splash snapshots contents before awaiting, even when the selected Item object changes', async () => {
  const heal = potion(37, 'strong_healing')
  const f = fixture([heal])
  f.bot.look = async () => { heal.components[0].data.potionId = 'strong_harming' }
  const ok = await f.eq.useAt(0, -Math.PI / 2, { item: heal })
  assert.deepEqual(f.used, [])
  assert.equal(ok, false)
})

test('self splash uses an unchanged healing stack and reports that the use was sent', async () => {
  const heal = potion(37, 'strong_healing')
  const f = fixture([heal], true)
  assert.equal(await f.eq.holdItem(heal), true)
  assert.equal(await f.eq.useAt(0, -Math.PI / 2, { item: heal }), true)
  assert.deepEqual(f.used, ['strong_healing'])
  assert.equal(f.ctx.aim, 'target')
})
