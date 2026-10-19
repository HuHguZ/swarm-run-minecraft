import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import * as invsync from '../src/invsync'
import * as ranged from '../src/ranged'
const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Item: any = (require('prismarine-item') as typeof import('prismarine-item').default)(registry)
const windows: any = (require('prismarine-windows') as typeof import('prismarine-windows').default)(registry as any)
import codec = require('minecraft-protocol/src/transforms/serializer')
const serializer = codec.createSerializer({ state: 'play', version: '1.21.11' })
const parser = codec.createDeserializer({ state: 'play', version: '1.21.11', isServer: true })

function fixture () {
  const bot: any = new EventEmitter()
  Object.assign(bot, { version: '1.21.11', registry, supportFeature: registry.supportFeature })
  bot._client = new EventEmitter()
  const server = windows.createWindow(0, 'minecraft:inventory', 'server')
  const menus = new Map([[0, server]])
  const clicks: any[] = []; const replies: any[] = []
  const states = new Map([[0, 7]]); let selected = 0
  const full = (menu = server) => ({ windowId: menu.id, stateId: states.get(menu.id), items: menu.slots.map(Item.toNotch), carriedItem: Item.toNotch(menu.selectedItem) })
  bot._client.write = (name, raw) => {
    if (name === 'held_item_slot') { selected = raw.slotId; return }
    if (name === 'close_window') {
      const menu = menus.get(raw.windowId)
      const offset = menu.inventoryStart - server.inventoryStart
      for (let slot = menu.inventoryStart; slot < menu.inventoryEnd; slot++) server.updateSlot(slot - offset, Item.fromNotch(Item.toNotch(menu.slots[slot])))
      return
    }
    if (name !== 'window_click') return
    const packet = parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params: raw })).data.params
    clicks.push(packet)
    assert.notEqual(packet.slot, -999, 'recovery must not drop a cursor item')
    const menu = menus.get(packet.windowId)
    const stale = packet.stateId !== states.get(menu.id)
    menu.acceptClick({ ...packet, item: menu.slots[packet.slot] })
    if (stale) {
      // ServerGamePacketListenerImpl.handleContainerClick: mismatch asks for
      // broadcastFullState AFTER processing the actual click.
      states.set(menu.id, states.get(menu.id) + 1); replies.push(['window_items', full(menu)])
    } else if (menu.selectedItem?.components.length) {
      assert.ok(packet.cursorItem.components.every(c => c.hash === 0), 'actual codec encoded missing component hashes as zero')
      // A legal correction to an invalid hashed component prediction. Exact
      // Java component hash is outside this fixture. A subsequent matching
      // empty cursor is NOT echoed: synchronizeCarriedToRemote suppresses it.
      replies.push(['set_cursor_item', { contents: Item.toNotch(menu.selectedItem) }])
    }
    setImmediate(flush)
  }
  function flush () { for (const [name, packet] of replies.splice(0)) bot._client.emit(name, packet) }
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  invsync.install(bot)
  const item = (name: string, count = 1) => new Item(registry.itemsByName[name].id, count)
  const axe = item('wooden_axe')
  axe.components = [{ type: 'enchantments', data: { enchantments: [{ id: registry.enchantmentsByName.unbreaking.id, level: 3 }] } }]
  server.updateSlot(10, axe)
  server.updateSlot(36, item('crossbow'))
  const rocket = item('firework_rocket', 7)
  rocket.components = [{ type: 'fireworks', data: { flightDuration: 1, explosions: [{ shape: 'small_ball' }] } }]
  server.updateSlot(11, rocket)
  bot._client.emit('window_items', full())
  bot.setQuickBarSlot(0)
  bot.setControlState = () => {}
  bot.deactivateItem = () => {}
  bot.activateItem = () => {
    assert.equal(server.slots[36 + selected]?.name, 'crossbow')
    assert.equal(server.slots[45]?.name, 'firework_rocket')
    const charged = Item.fromNotch(Item.toNotch(server.slots[36 + selected]))
    charged.components = [{ type: 'charged_projectiles', data: { projectiles: [Item.toNotch(server.slots[45])] } }]
    server.updateSlot(36 + selected, charged)
    replies.push(['set_player_inventory', { slotId: 36 + selected, contents: Item.toNotch(charged) }])
    setImmediate(flush)
  }
  function open () {
    const menu = windows.createWindow(1, 'minecraft:generic_9x3', 'chest')
    menus.set(1, menu); states.set(1, 7)
    const offset = menu.inventoryStart - server.inventoryStart
    for (let slot = server.inventoryStart; slot < server.inventoryEnd; slot++) menu.updateSlot(slot + offset, Item.fromNotch(Item.toNotch(server.slots[slot])))
    bot._client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:generic_9x3', windowTitle: 'chest' })
    bot._client.emit('window_items', full(menu))
    return { menu, win: bot.currentWindow }
  }
  return { bot, server, clicks, flush, open, selected: () => selected, finish: () => { bot._client.write = () => {} } }
}

test('an enchanted tool equip cannot leave an earlier cursor correction after its final placement', async () => {
  const f = fixture()
  await f.bot.equip(f.bot.inventory.slots[10], 'hand')
  assert.equal(f.bot.inventory.selectedItem, null, 'ordinary Mineflayer predicts both clicks before responses')
  f.flush()
  assert.equal(f.server.selectedItem, null, 'server completed the real transfer')
  assert.equal(f.server.slots[36 + f.selected()]?.name, 'wooden_axe')
  const result = await ranged.load(f.bot, { aborted: false }, f.bot.inventory.slots[36], { ammo: 'firework' })
  assert.equal(result.ok, true, `actual rocket load remains possible: ${result.why}`)
  assert.equal(f.bot.inventory.selectedItem, null)
  assert.equal(f.server.selectedItem, null)
  assert.equal(f.server.count(registry.itemsByName.wooden_axe.id, null), 1, 'the only axe is preserved')
  assert.equal(f.bot.inventory.slots[45]?.count, 7)
})

test('a cancelled transfer with a genuine server cursor remains guarded', async () => {
  const f = fixture()
  await f.bot.clickWindow(10, 0, 0) // Cancellation before its second click.
  f.flush()
  assert.equal(f.server.selectedItem?.name, 'wooden_axe')
  assert.equal(f.bot.inventory.selectedItem?.name, 'wooden_axe')
  const before = f.clicks.length
  const result = await ranged.load(f.bot, { aborted: false }, f.bot.inventory.slots[36], { ammo: 'firework' })
  assert.equal(result.ok, false)
  assert.equal(result.why, 'курсор занят')
  assert.equal(invsync.resync(f.bot), false)
  assert.equal(f.clicks.length, before, 'no cleanup click or invented empty cursor')
})

test('the same full receipts synchronize an open menu and preserve its close guard', async t => {
  const f = fixture(); t.after(f.finish)
  const { menu, win } = f.open()
  const offset = win.inventoryStart - f.bot.inventory.inventoryStart
  await f.bot.moveSlotItem(10 + offset, 37 + offset)
  f.flush()
  assert.equal(menu.selectedItem, null)
  assert.equal(win.selectedItem, null)
  assert.equal(f.bot.inventory.selectedItem, null)
  const clickCount = f.clicks.length
  win.close()
  assert.equal(f.bot.currentWindow, null)
  assert.equal(f.bot.inventory.slots[37]?.name, 'wooden_axe')
  assert.equal(f.server.slots[37]?.name, 'wooden_axe')
  assert.equal(f.bot.inventory.selectedItem, null)
  assert.equal(f.clicks.length, clickCount, 'server receipts never generate another click')
})

test('the 1.21.11 write adapter is idempotent and preserves other packets, versions and call semantics', () => {
  for (const version of ['1.21.11', '1.21.10']) {
    const bot: any = new EventEmitter()
    Object.assign(bot, { version, registry, inventory: { selectedItem: null }, _client: new EventEmitter() })
    const calls: any[] = []
    const receipt = {}
    bot._client.write = function (...args) { calls.push({ receiver: this, args }); return receipt }
    const original = bot._client.write
    invsync.install(bot)
    const installed = bot._client.write
    invsync.install(bot)
    assert.equal(bot._client.write, installed)
    assert.equal(bot._client.listenerCount('window_items'), 1)
    const receiver = {}; const tail = {}; const click = { windowId: 0, stateId: 7, slot: 10 }
    assert.equal(installed.call(receiver, 'window_click', click, tail), receipt)
    assert.equal(calls[0].receiver, receiver)
    assert.equal(calls[0].args[2], tail)
    assert.equal(calls[0].args[1].stateId, version === '1.21.11' ? -2 : 7)
    assert.equal(click.stateId, 7, 'caller packet is not mutated')
    installed.call(receiver, 'keep_alive', tail)
    assert.deepEqual(calls[1].args, ['keep_alive', tail])
    installed.call(receiver, 'no_arguments')
    assert.deepEqual(calls[2].args, ['no_arguments'])
    if (version !== '1.21.11') assert.equal(installed, original)
  }
})
