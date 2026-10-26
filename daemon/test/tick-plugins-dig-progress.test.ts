import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { block, data, testBot, testClock } from './tick-plugins-fixture'
import { createTickPlugins } from '../src/tick-plugins'
import { GameClock } from '../src/game-clock'

function mining(grounded: boolean, held = null) {
  const clock = testClock(), bot = testBot()
  createTickPlugins(clock).plugins.digging(bot)
  bot.heldItem = held
  bot.entity.onGround = grounded
  const web = block('cobweb', new Vec3(0, 1, 0))
  assert.equal(bot.digTime(web), grounded ? 20000 : 100000)
  const task = bot.dig(web, 'ignore')
  return { clock, bot, web, task }
}

test('web mining credits airborne work, then uses the landed speed without restarting', async () => {
  const { clock, bot, web, task } = mining(false)
  try {
    await clock.advanceGame(18000)
    clock.freeze(true)
    await clock.advanceWall(60000)
    assert.equal(bot.targetDigBlock, web, 'frozen wall time earns no mining progress')
    clock.freeze(false)
    bot.entity.onGround = true
    assert.equal(bot.digTime(web), 20000)
    await clock.advanceGame(16350)
    assert.equal(bot.targetDigBlock, web, '18/100 + 16.35/20 is still below one block')
    await clock.advanceGame(150)
    assert.equal(bot.targetDigBlock, null, 'landing must not keep the original 100-second timer')
    await task
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 2], 'no abort/restart loses earned work')
  } finally { task.catch(() => {}); bot.emit('end') }
  assert.equal(clock.pending(), 0)
})

test('leaving the ground slows an existing dig instead of finishing on the old timer', async () => {
  const { clock, bot, web, task } = mining(true)
  try {
    await clock.advanceGame(5000)
    bot.entity.onGround = false
    await clock.advanceGame(15000)
    assert.equal(bot.targetDigBlock, web, 'five grounded and fifteen airborne seconds cannot break a web')
    await clock.advanceGame(59950)
    assert.equal(bot.targetDigBlock, web)
    await clock.advanceGame(150)
    assert.equal(bot.targetDigBlock, null)
    await task
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 2])
  } finally { task.catch(() => {}); bot.emit('end') }
  assert.equal(clock.pending(), 0)
})

test('cancelling a changing-speed dig clears its pending progress tick', async () => {
  const { clock, bot, web, task } = mining(false)
  const rejected = assert.rejects(task, /aborted/)
  await clock.advanceGame(1000)
  bot.entity.onGround = true
  bot.stopDigging()
  await rejected
  await clock.advanceGame(120000)
  assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 1])
  assert.equal(bot.listenerCount(`blockUpdate:${web.position}`), 0)
  bot.emit('end')
  assert.equal(clock.pending(), 0)
})

test('a count-only stack update keeps mining, but changed components abort its earned progress', async () => {
  const Item = require('prismarine-item')(data)
  const { clock, bot, web, task } = mining(true, new Item(data.itemsByName.iron_pickaxe.id, 1))
  const rejected = assert.rejects(task, /aborted/)
  try {
    await clock.advanceGame(5000)
    bot.heldItem = new Item(data.itemsByName.iron_pickaxe.id, 2)
    await clock.advanceGame(100)
    assert.equal(bot.targetDigBlock, web, 'stack count is not part of vanilla sameDestroyTarget')
    bot.heldItem = new Item(data.itemsByName.iron_pickaxe.id, 2)
    bot.heldItem.components = [{ type: 'damage', data: 1 }]
    await clock.advanceGame(50)
    assert.equal(bot.targetDigBlock, null, 'a different stack cannot inherit mining progress')
    await rejected
    await clock.advanceGame(100000)
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 1])
  } finally { bot.emit('end'); await rejected }
  assert.equal(clock.pending(), 0)
})

test('a native inventory packet removing an item component cannot keep the old dig progress', async () => {
  const clock = testClock(), bot = testBot(), plugins = createTickPlugins(clock).plugins
  plugins.inventory(bot)
  bot.QUICK_BAR_START = 36; bot.quickBarSlot = 0
  plugins.digging(bot)
  const Item = require('prismarine-item')(data)
  const old = Item.fromNotch({ itemCount: 1, itemId: data.itemsByName.iron_pickaxe.id, components: [], removeComponents: [] })
  bot.inventory.updateSlot(36, old)
  const task = bot.dig(block('cobweb', new Vec3(0, 1, 0)), 'ignore')
  const rejected = assert.rejects(task, /aborted/)
  try {
    await clock.advanceGame(5000)
    bot._client.emit('set_player_inventory', { slotId: 36, contents: { itemCount: 1, itemId: old.type, components: [], removeComponents: ['tool'] } })
    assert.notEqual(bot.heldItem, old)
    await clock.advanceGame(50)
    assert.equal(bot.targetDigBlock, null, 'removed components change the effective native item stack')
    await rejected
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 1])
  } finally { bot.emit('end'); await rejected }
  assert.equal(clock.pending(), 0)
})

for (const transition of [false, true]) test(`server-age resync credits elapsed mining ticks, conservative on a speed transition: ${transition}`, async () => {
  const clock = new GameClock({ epoch: 0, predictionTicks: 20, stallMs: 0 }), bot = testBot()
  bot.heldItem = null; bot.entity.onGround = !transition
  clock.syncAge(0n)
  createTickPlugins(clock).plugins.digging(bot)
  const web = block('cobweb', new Vec3(0, 1, 0))
  const task = bot.dig(web, 'ignore')
  task.catch(() => {})
  const grant = async seconds => { clock.syncAge(BigInt(seconds * 20)); assert.equal(clock.pulse(), true); await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    for (let second = 1; second <= (transition ? 10 : 19); second++) await grant(second)
    assert.equal(bot.targetDigBlock, web)
    if (transition) {
      bot.entity.onGround = true
      await grant(20)
      for (let second = 21; second <= 30; second++) await grant(second)
      assert.equal(bot.targetDigBlock, web, 'the unknown ten-second interval cannot receive the new faster rate')
      for (let second = 31; second <= 37; second++) await grant(second)
    } else { await grant(20); await grant(21) }
    assert.equal(bot.targetDigBlock, null, 'clock deadlines cannot outrun credited mining time after resync')
    await task
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 2])
  } finally { bot.emit('end'); await task.catch(() => {}); clock.dispose() }
  assert.equal(clock.timers.size, 0)
})
