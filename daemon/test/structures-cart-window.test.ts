import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const { takeCart } = require('../src/structures/take')
const common = require('../src/structures/common')
const windowUtils = require('../src/containers/window')
const worth = require('../src/structures/worth')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const Vec3 = require('vec3')

// Native Mineflayer closeWindow/copyInventory; deterministic opening, clicks and delays.
function fixture(t: any) {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'; bot.registry = registry; bot.supportFeature = registry.supportFeature
  bot.entity = { position: new Vec3(0, 18, 0) }; bot._client = new EventEmitter()
  bot._client.write = () => {}
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  bot.pathfinder = { setGoal() {} }
  const item = (name: string) => new Item(registry.itemsByName[name].id, 1)
  function open(id: number) {
    bot._client.emit('open_window', { windowId: id, inventoryType: 'minecraft:generic_9x3', windowTitle: 'cart' })
    const win = bot.currentWindow
    for (const [slot, name] of ['diamond', 'bread', 'golden_apple'].entries()) win.updateSlot(slot, item(name))
    bot._client.emit('window_items', { windowId: id, stateId: 1, items: win.slots.map(Item.toNotch), carriedItem: Item.toNotch(null) })
    return win
  }
  const old = open(1), pending: Array<() => void> = [], clicks: number[] = []
  bot.openContainer = async () => old
  bot.clickWindow = async (slot: number) => {
    clicks.push(bot.currentWindow?.id ?? 0)
    const stack = old.slots[slot]
    if (stack && slot < old.inventoryStart) {
      old.updateSlot(old.inventoryStart + slot, stack); old.updateSlot(slot, null)
    }
  }
  const ctl: any = { aborted: false, onAbort: [] }
  const abort = () => { ctl.aborted = true; for (const cb of [...ctl.onAbort]) cb() }
  t.mock.method(common, 'sleep', (_ms: number, owner?: any) => {
    if (owner?.aborted) return Promise.resolve()
    return new Promise<void>(resolve => { pending.push(resolve); owner?.onAbort.push(resolve) })
  })
  t.mock.method(common, 'withTimeout', (promise: Promise<any>) => promise)
  t.mock.method(windowUtils, 'raceOpen', (_bot: any, promise: Promise<any>) => promise)
  t.mock.method(worth, 'decide', () => ({ take: true, prio: 1, why: 'test' }))
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      for (const cb of pending.splice(0)) cb()
      await flush()
      if (!pending.length) return
    }
    assert.fail('cart worker did not settle')
  }
  const session = { bot, journal: { state: {}, patch(fn: any) { fn(this.state) } } }
  const start = () => takeCart(session, ctl, { id: 50, position: new Vec3(0, 18, 1) })
  return { bot, old, item, open, clicks, abort, flush, drain, start }
}

for (const reason of ['cancelled', 'foreign-window']) {
  test(`cart loot ${reason} cannot click or close a newer menu and erase its bucket`, { timeout: 1000 }, async t => {
    const f = fixture(t), task = f.start()
    await f.flush(); assert.equal(f.clicks.length, 1)
    if (reason === 'cancelled') f.abort()
    else f.bot.closeWindow(f.old)
    f.bot.inventory.updateSlot(20, f.item('bucket'))
    const newer = f.open(2)
    newer.updateSlot(newer.inventoryStart + 11, f.item('bucket'))
    await f.drain()
    const result = await task
    assert.equal(f.bot.inventory.slots[20]?.name, 'bucket')
    assert.equal(f.bot.currentWindow, newer)
    assert.deepEqual(f.clicks, [1])
    assert.ok(result.stopped)
  })
}

test('normal cart loot takes valuable stacks and closes its own menu', { timeout: 1000 }, async t => {
  const f = fixture(t), task = f.start()
  await f.flush(); await f.drain()
  const result = await task
  assert.deepEqual(result.took, { diamond: 1, bread: 1, golden_apple: 1 })
  assert.equal(result.stopped, undefined)
  assert.equal(f.bot.currentWindow, null)
  assert.deepEqual(f.clicks, [1, 1, 1])
})
