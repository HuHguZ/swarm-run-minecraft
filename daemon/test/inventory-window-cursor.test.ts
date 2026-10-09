import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const invsync = require('../src/invsync')
const ranged = require('../src/ranged')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')(registry)

// Real mineflayer click/transfer/close/equip code, with a separate server Window.
// The valid click's predicted cursor already agrees with the server, so the
// server need not send another full-state carriedItem to clear our shadow copy.
function fixture () {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.registry = registry
  bot.supportFeature = registry.supportFeature
  bot._client = new EventEmitter()
  bot.entity = { id: 1, position: new (require('vec3'))(0, 120, 0), yaw: 0, pitch: 0, onGround: true }
  const packets: Array<{ name: string, packet: any }> = []
  const menus = new Map<number, any>()
  const player = windows.createWindow(0, 'minecraft:inventory', 'player')
  menus.set(0, player)
  let stateId = 7
  bot._client.write = (name: string, packet: any) => {
    packets.push({ name, packet })
    if (name === 'window_click') {
      const menu = menus.get(packet.windowId)
      assert.ok(menu, 'click belongs to an existing server menu')
      assert.notEqual(packet.slot, -999, 'this fixture must not discard a cursor stack')
      menu.acceptClick({ ...packet, item: menu.slots[packet.slot] })
      assert.ok(Item.equal(menu.selectedItem, Item.fromNotch(packet.cursorItem), true), 'real click prediction matches the server cursor')
    } else if (name === 'close_window') {
      const menu = menus.get(packet.windowId)
      const offset = menu.inventoryStart - player.inventoryStart
      for (let i = menu.inventoryStart; i < menu.inventoryEnd; i++) player.updateSlot(i - offset, Item.fromNotch(Item.toNotch(menu.slots[i])))
    }
  }
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  invsync.install(bot)
  bot.setQuickBarSlot(0)
  bot.setControlState = () => {}
  // Native charge completion is not under test. The actual ranged.load must
  // reach use_item only after real inventory/equip operations released the cursor.
  bot.activateItem = () => {
    const held = bot.heldItem
    assert.equal(held?.name, 'crossbow')
    assert.equal(bot.inventory.slots[45]?.name, 'firework_rocket')
    const charged = Item.fromNotch(Item.toNotch(held))
    charged.components = [{ type: 'charged_projectiles', data: { projectiles: [Item.toNotch(bot.inventory.slots[45])] } }]
    player.updateSlot(held.slot, charged)
    bot._client.emit('set_player_inventory', { slotId: held.slot, contents: Item.toNotch(charged) })
  }
  function open (id = 1) {
    const menu = windows.createWindow(id, 'minecraft:generic_9x3', 'chest')
    menus.set(id, menu)
    bot._client.emit('open_window', { windowId: id, inventoryType: 'minecraft:generic_9x3', windowTitle: 'chest' })
    return menu
  }
  function send (menu: any) {
    bot._client.emit('window_items', { windowId: menu.id, stateId: stateId++, items: menu.slots.map(Item.toNotch), carriedItem: Item.toNotch(menu.selectedItem) })
  }
  function item (name: string, count = 1) { return new Item(registry.itemsByName[name].id, count) }
  function carriedRockets (id = 1) {
    const menu = open(id)
    menu.selectedItem = item('firework_rocket', 7)
    menu.selectedItem.components = [{ type: 'fireworks', data: { flightDuration: 1, explosions: [{ shape: 'small_ball' }] } }]
    menu.updateSlot(menu.inventoryStart + 27, item('crossbow'))
    send(menu)
    return { menu, win: bot.currentWindow }
  }
  function finish () {
    // The production timer remains guarded; prevent the test's delayed resync
    // from issuing any packet after assertions have completed.
    bot._client.write = () => {}
  }
  return { bot, packets, player, menus, open, send, item, carriedRockets, finish }
}

for (const closure of ['client', 'server']) {
  test(`real ${closure} chest close releases the carried shadow and permits rocket loading`, async t => {
    const f = fixture(); t.after(f.finish)
    const { bot, player } = f
    const { menu, win } = f.carriedRockets()
    assert.equal(bot.inventory.selectedItem.count, 7, 'initial full-state packet reported a carried stack')
    await bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, null)
    assert.equal(win.selectedItem, null, 'actual mineflayer transfer stored the full cursor')
    assert.equal(menu.selectedItem, null, 'independent server inventory agrees')
    assert.equal(win.count(registry.itemsByName.firework_rocket.id, null), 7)
    if (closure === 'client') win.close()
    else {
      const offset = menu.inventoryStart - player.inventoryStart
      for (let i = menu.inventoryStart; i < menu.inventoryEnd; i++) player.updateSlot(i - offset, Item.fromNotch(Item.toNotch(menu.slots[i])))
      bot._client.emit('close_window', { windowId: menu.id })
    }
    assert.equal(bot.currentWindow, null)
    const cb = bot.inventory.items().find((i: any) => i.name === 'crossbow')
    const result = await ranged.load(bot, { aborted: false }, cb, { ammo: 'firework' })
    assert.equal(result.ok, true, `actual ranged.load: ${result.why}`)
    assert.equal(bot.inventory.selectedItem, null)
    assert.equal(player.selectedItem, null)
    assert.equal(bot.inventory.slots[45].count, 7, 'no rocket was dropped while moving the stack')
    assert.equal(f.packets.some(p => p.name === 'window_click' && p.packet.slot === -999), false)
  })
}

test('a real cursor with a full inventory stays guarded after a cancelled transfer', async t => {
  const f = fixture(); t.after(f.finish)
  const { bot } = f
  const { menu, win } = f.carriedRockets()
  for (let i = menu.inventoryStart; i < menu.inventoryEnd; i++) if (!menu.slots[i]) menu.updateSlot(i, f.item('cobblestone', 64))
  f.send(menu)
  win.close()
  assert.equal(bot.inventory.selectedItem?.count, 7, 'closing must not invent an empty cursor')
  const before = f.packets.length
  const result = await ranged.load(bot, { aborted: false }, bot.inventory.items().find((i: any) => i.name === 'crossbow'), { ammo: 'firework' })
  assert.equal(result.ok, false)
  assert.equal(invsync.resync(bot), false)
  assert.equal(f.packets.length, before, 'no equip, outside click or item loss from the blocked state')
})

test('late close and old full-state packets cannot clear the newly opened menu cursor', async t => {
  const f = fixture(); t.after(f.finish)
  const { bot } = f
  const old = f.carriedRockets(1)
  await bot.putSelectedItemRange(old.win.inventoryStart, old.win.inventoryEnd, old.win, null)
  old.win.close()
  const next = f.carriedRockets(2)
  bot.emit('windowClose', old.win)
  f.send(old.menu)
  assert.equal(bot.currentWindow, next.win)
  assert.equal(next.win.selectedItem?.count, 7)
  assert.equal(bot.inventory.selectedItem?.count, 7)
  assert.equal(invsync.resync(bot), false)
})

test('an unknown or repeated close cannot erase the player cursor after returning to inventory', async t => {
  const f = fixture(); t.after(f.finish)
  const { bot } = f
  const { win } = f.carriedRockets()
  await bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, null)
  win.close()
  const real = f.item('diamond', 2)
  bot._client.emit('set_cursor_item', { contents: Item.toNotch(real) })
  bot.emit('windowClose', null)
  bot.emit('windowClose', { id: 999, selectedItem: null })
  bot.emit('windowClose', win)
  assert.equal(bot.inventory.selectedItem?.name, 'diamond')
  assert.equal(bot.inventory.selectedItem?.count, 2)
  assert.equal(invsync.resync(bot), false)
})
