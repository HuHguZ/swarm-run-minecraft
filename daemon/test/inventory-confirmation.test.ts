import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { resync, refresh, confirmedClick, install } = require('../src/invsync')

test('inventory refresh cannot drop a cursor stack and waits for a real full-state packet', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.inventory = { selectedItem: { name: 'iron_ingot' } }
  const packets: unknown[] = []
  bot._client.write = (_name: string, packet: unknown) => packets.push(packet)
  assert.equal(resync(bot), false)
  assert.equal(await refresh(bot), false)
  assert.equal(packets.length, 0)
  bot.inventory.selectedItem = null; bot._ndCrafting = true
  assert.equal(resync(bot), false)
  const waiting = refresh(bot)
  assert.equal(packets.length, 1)
  bot._client.emit('window_items', { windowId: 2 })
  bot._client.emit('window_items', { windowId: 0 })
  assert.equal(await waiting, true)
  assert.equal(bot._client.listenerCount('window_items'), 1)
  assert.equal(bot.listenerCount('end'), 0)
})

test('craft preparation closes the inventory before refreshing a carried stack and confirms an empty grid', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  const Item = require('prismarine-item')(bot.registry)
  bot.inventory = require('prismarine-windows')(bot.registry).createWindow(0, 'minecraft:inventory', 'inventory')
  const ingot = new Item(bot.registry.itemsByName.iron_ingot.id, 3)
  const stick = new Item(bot.registry.itemsByName.stick.id, 2)
  bot.inventory.selectedItem = ingot
  bot.inventory.updateSlot(1, stick)
  const packets: string[] = []
  let carried = ingot
  const slots = [...bot.inventory.slots]
  bot._client.on('window_items', packet => packet.items?.forEach((value, slot) => bot.inventory.updateSlot(slot, Item.fromNotch(value))))
  bot._client.write = (name: string, packet: any) => {
    packets.push(name)
    if (name === 'close_window') {
      assert.equal(packet.windowId, 0)
      slots[9] = carried; carried = null
      slots[10] = slots[1]; slots[1] = null
    } else {
      assert.equal(name, 'window_click')
      assert.equal(carried, null, 'the outside click must never discard the real server cursor')
      assert.equal(packet.slot, -999)
    }
  }
  let complete = false
  const waiting = refresh(bot, 1000, true).then(ok => { complete = ok; return ok })
  assert.deepEqual(packets, ['close_window', 'window_click'])
  const contents = slots.map(item => Item.toNotch(item))
  const dirty = [...contents]; dirty[1] = Item.toNotch(stick)
  bot._client.emit('window_items', { windowId: 0, stateId: 1, items: dirty, carriedItem: Item.toNotch(null) })
  await Promise.resolve()
  assert.equal(complete, false, 'a full-state packet with a dirty grid is not a completed close')
  bot._client.emit('window_items', { windowId: 0, stateId: 2, items: contents, carriedItem: Item.toNotch(ingot) })
  await Promise.resolve()
  assert.equal(complete, false, 'an uncleared cursor is not a completed close')
  bot._client.emit('window_items', { windowId: 0, stateId: 3, items: contents, carriedItem: Item.toNotch(null) })
  assert.equal(await waiting, true)
  assert.equal(bot.inventory.slots[9].count, 3)
  assert.equal(bot.inventory.slots[10].count, 2)
  assert.equal(bot.inventory.selectedItem, null)
  assert.equal(bot._client.listenerCount('window_items'), 2)
  assert.equal(bot.listenerCount('end'), 0)
})

test('confirmed click waits for the server slots and carried stack without predicting a craft', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  const Item = require('prismarine-item')(bot.registry)
  const Window = require('prismarine-windows')(bot.registry)
  bot.inventory = Window.createWindow(0, 'minecraft:inventory', 'inventory')
  const ingot = new Item(bot.registry.itemsByName.iron_ingot.id, 9)
  bot.inventory.updateSlot(9, ingot)
  // Mineflayer handles ordinary slots, and invsync supplies the carried stack
  // that its modern packet handlers omit.
  bot._client.on('window_items', packet => packet.items.forEach((value, slot) => bot.inventory.updateSlot(slot, Item.fromNotch(value))))
  install(bot)
  let sent: any = null
  bot._client.write = (_name: string, packet: unknown) => { sent = packet }
  let complete = false
  const click = confirmedClick(bot, 9).then(() => { complete = true })
  assert.equal(sent.slot, 9)
  assert.equal(sent.stateId, -2)
  assert.equal(bot.inventory.slots[9].count, 9)
  assert.equal(bot.inventory.selectedItem, null)
  await Promise.resolve()
  assert.equal(complete, false)
  const items = bot.inventory.slots.map(item => Item.toNotch(item))
  bot._client.emit('window_items', { windowId: 0, stateId: 1, items, carriedItem: Item.toNotch(null) })
  await Promise.resolve()
  assert.equal(complete, false, 'a stale full state for the same window is not the click effect')
  items[9] = Item.toNotch(null)
  bot._client.emit('window_items', { windowId: 0, stateId: 2, items, carriedItem: Item.toNotch(ingot) })
  await click
  assert.equal(bot.inventory.slots[9], null)
  assert.equal(bot.inventory.selectedItem.count, 9)
  let stored = false
  const putAway = confirmedClick(bot, 10).then(() => { stored = true })
  bot._client.emit('window_items', { windowId: 0, stateId: 3, items, carriedItem: Item.toNotch(ingot) })
  await Promise.resolve()
  assert.equal(stored, false, 'the duplicate output-click state cannot confirm the next storage click')
  const storedItems = [...items]
  storedItems[10] = Item.toNotch(ingot)
  bot._client.emit('window_items', { windowId: 0, stateId: 4, items: storedItems, carriedItem: Item.toNotch(null) })
  await putAway
  assert.equal(bot.inventory.slots[10].count, 9)
  assert.equal(bot.inventory.selectedItem, null)
})

test('a click cannot report success from an unrelated window or leave listeners after timeout', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  bot.inventory = require('prismarine-windows')(bot.registry).createWindow(0, 'minecraft:inventory', 'inventory')
  bot.inventory.updateSlot(9, new (require('prismarine-item')(bot.registry))(bot.registry.itemsByName.iron_ingot.id, 1))
  bot._client.write = () => bot._client.emit('window_items', { windowId: 2, items: [] })
  const failure = confirmedClick(bot, 9, 0, 0, 10)
  await assert.rejects(failure, /did not confirm/)
  assert.equal(bot.listenerCount('end'), 0)
  assert.equal(bot.listenerCount('windowClose'), 1)
  assert.equal(bot._client.listenerCount('window_items'), 1)
})

test('pickup-filled crafting inventory keeps the material cursor and drops only expendable clutter after server confirmation', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  const Item = require('prismarine-item')(bot.registry)
  bot.inventory = require('prismarine-windows')(bot.registry).createWindow(0, 'minecraft:inventory', 'inventory')
  const stack = (name: string, count: number) => new Item(bot.registry.itemsByName[name].id, count)
  for (let slot = 9; slot < 45; slot++) bot.inventory.updateSlot(slot, stack('netherrack', 64))
  for (let slot = 1; slot <= 4; slot++) bot.inventory.updateSlot(slot, stack('oak_planks', 1))
  bot.inventory.updateSlot(0, stack('crafting_table', 1))
  bot.inventory.selectedItem = stack('oak_planks', 2)
  const slots = [...bot.inventory.slots]
  let carried = bot.inventory.selectedItem
  let stateId = 0
  const discarded: string[] = []
  bot._client.on('window_items', packet => packet.items.forEach((value, slot) => bot.inventory.updateSlot(slot, Item.fromNotch(value))))
  install(bot)
  bot._client.write = (_name: string, packet: any) => {
    if (packet.slot === -999) { discarded.push(carried.name); carried = null }
    else { const old = slots[packet.slot]; slots[packet.slot] = carried; carried = old }
    bot._client.emit('window_items', { windowId: 0, stateId: ++stateId, items: slots.map(Item.toNotch), carriedItem: Item.toNotch(carried) })
  }
  await require('../src/craft-confirmed').putCursorAway(bot, bot.inventory)
  assert.equal(bot.inventory.selectedItem, null)
  assert.equal(bot.inventory.items().find(item => item.name === 'oak_planks')?.count, 2)
  assert.deepEqual(discarded, ['netherrack'])
  assert.equal(bot.inventory.slots[0].name, 'crafting_table')
  assert.equal(bot.inventory.slots.slice(1, 5).reduce((n, item) => n + item.count, 0), 4)
  for (let slot = 9; slot < 45; slot++) bot.inventory.updateSlot(slot, stack('iron_pickaxe', 1))
  bot.inventory.selectedItem = stack('oak_planks', 2)
  await assert.rejects(require('../src/craft-confirmed').putCursorAway(bot, bot.inventory), /no inventory room/)
  assert.deepEqual(discarded, ['netherrack'], 'gear and held recipe materials must never be dropped')
})

test('parking a crafted pickaxe preserves surplus recipe ingredients in a pickup-filled inventory', async () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  const Item = require('prismarine-item')(bot.registry)
  bot.inventory = require('prismarine-windows')(bot.registry).createWindow(0, 'minecraft:inventory', 'inventory')
  const stack = (name: string, count: number) => new Item(bot.registry.itemsByName[name].id, count)
  for (let slot = 9; slot < 45; slot++) bot.inventory.updateSlot(slot, stack('iron_sword', 1))
  bot.inventory.updateSlot(9, stack('blackstone', 12))
  bot.inventory.updateSlot(10, stack('basalt', 8))
  bot.inventory.updateSlot(11, stack('cobbled_deepslate', 64))
  bot.inventory.selectedItem = stack('stone_pickaxe', 1)
  const slots = [...bot.inventory.slots]
  let carried = bot.inventory.selectedItem
  let stateId = 0
  const discarded: string[] = []
  bot._client.on('window_items', packet => packet.items.forEach((value, slot) => bot.inventory.updateSlot(slot, Item.fromNotch(value))))
  install(bot)
  bot._client.write = (_name: string, packet: any) => {
    if (packet.slot === -999) { discarded.push(carried.name); carried = null }
    else { const old = slots[packet.slot]; slots[packet.slot] = carried; carried = old }
    bot._client.emit('window_items', { windowId: 0, stateId: ++stateId, items: slots.map(Item.toNotch), carriedItem: Item.toNotch(carried) })
  }
  await require('../src/craft-confirmed').putCursorAway(bot, bot.inventory, new Set(['blackstone', 'stick']))
  assert.equal(bot.inventory.selectedItem, null)
  assert.deepEqual(discarded, ['basalt'])
  assert.equal(bot.inventory.items().find(item => item.name === 'blackstone')?.count, 12)
  assert.equal(bot.inventory.items().find(item => item.name === 'stone_pickaxe')?.count, 1)
})
