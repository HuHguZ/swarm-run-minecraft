'use strict'
// Плагины тика: действия в игровом времени — копка, отключение, инвентарь после копки, еда, сон, постановка сущностей, версии Mineflayer.
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { data, testClock, block, testBot, install } from './tick-plugins-fixture'

test('stone mining uses eight game ticks at both rates and freezes its finish and arm swing', async () => {
  for (const rate of [20, 200]) {
    const clock = testClock(rate)
    const bot = install(clock, { digging: true })
    await clock.advanceGame(100)
    assert.equal(bot.entity.onGround, true, 'settle native ground contact before measuring steady mining')
    const stone = block('stone', new Vec3(1, 1, 0))
    assert.equal(bot.digTime(stone), 400)
    const digging = bot.dig(stone, 'ignore')
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0])
    await clock.advanceWall(rate === 20 ? 350 : 35)
    assert.equal(bot.swings, 2)
    clock.freeze(true)
    await clock.advanceWall(60000)
    assert.equal(bot.swings, 2)
    assert.equal(bot.targetDigBlock, stone)
    await clock.advanceGame(50)
    await digging
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 2])
    assert.equal(bot.lastDigTime, clock.now())
    assert.equal(bot.targetDigBlock, null)
    bot.emit('end')
    assert.equal(clock.pending(), 0)
  }
})
test('disconnect rejects waiting and mining and removes their timers and block listeners', async () => {
  const clock = testClock()
  const bot = install(clock, { digging: true })
  const stone = block('stone', new Vec3(1, 1, 0))
  const mining = bot.dig(stone, 'ignore')
  const waiting = bot.waitForTicks(10)
  const miningRejected = assert.rejects(mining, /aborted|disconnect/i)
  const waitingRejected = assert.rejects(waiting, /disconnect/i)
  bot.emit('end')
  await Promise.all([miningRejected, waitingRejected])
  assert.equal(clock.pending(), 0)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount(`blockUpdate:${stone.position}`), 0)
  const sent = bot.packets.length
  await clock.advanceGame(10000)
  assert.equal(bot.packets.length, sent)
  await assert.rejects(bot.dig(stone, 'ignore'), /disconnect/i)
})
test('adapter does not replace process Date, performance or native timers', async () => {
  const original = { Date, now: Date.now, performance: (require('node:perf_hooks') as typeof import('node:perf_hooks')).performance, setTimeout, setInterval }
  const clock = testClock()
  const bot = install(clock, { digging: true, pathfinder: true })
  await clock.advanceGame(50)
  assert.equal(Date, original.Date)
  assert.equal(Date.now, original.now)
  assert.equal((require('node:perf_hooks') as typeof import('node:perf_hooks')).performance, original.performance)
  assert.equal(setTimeout, original.setTimeout)
  assert.equal(setInterval, original.setInterval)
  bot.emit('end')
})
function installInventory (clock) {
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.inventory(bot, {} as Record<string, any>)
  bot.QUICK_BAR_START = 36
  bot.quickBarSlot = 0
  bot.food = 10
  return bot
}
test('post-dig inventory click waits 500 game milliseconds and stays pending while frozen', async () => {
  const clock = testClock(200)
  const bot = installInventory(clock)
  bot.lastDigTime = clock.now()
  const clicking = bot.clickWindow(36, 0, 0)
  await clock.advanceGame(450)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), false)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), false)
  await clock.advanceGame(50)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), true)
  bot.emit('end')
  await clicking.catch(() => {})
  assert.equal(clock.pending(), 0)
})
test('consume watchdog uses game time and is cancelled with its task on disconnect', async () => {
  const clock = testClock(200)
  const bot = installInventory(clock)
  const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(data)
  bot.inventory.updateSlot(36, new Item(data.itemsByName.bread.id, 1))
  const consuming = bot.consume()
  const rejected = assert.rejects(consuming, /disconnect/i)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.usingHeldItem, true)
  bot.emit('end')
  await rejected
  assert.equal(clock.pending(), 0)
})
test('bed sleep keeps its listener while frozen and releases it on disconnect', async () => {
  const clock = testClock()
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.bed(bot)
  bot.time = { timeOfDay: 13000 }
  bot.canDigBlock = () => true
  bot.activateBlock = async () => {}
  const bed = block('white_bed', new Vec3(1, 1, 0))
  bot.blockAt = p => block('white_bed', p)
  const sleeping = bot.sleep(bed)
  sleeping.catch(() => {})
  assert.equal(bot.listenerCount('sleep'), 1)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.listenerCount('sleep'), 1)
  bot.emit('end')
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('sleep'), 0)
  await assert.rejects(sleeping, /disconnect/i)
  assert.equal(clock.pending(), 0)
})
test('entity placement ignores unrelated spawns and clears its watchdog after success', async () => {
  const clock = testClock()
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  await new Promise<any>(resolve => setImmediate(resolve))
  bot.emit('entitySpawn', { name: 'cow', position: new Vec3(1, 1, 0) })
  assert.equal(bot.listenerCount('entitySpawn'), 1)
  const boat = { name: 'boat', position: new Vec3(1, 1, 0) }
  bot.emit('entitySpawn', boat)
  assert.equal(await placing, boat)
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  assert.equal(clock.pending(), 0)
  bot.emit('end')
})
test('entity placement rejects and removes its listener on disconnect', async () => {
  const clock = testClock()
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  placing.catch(() => {})
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 1)
  bot.emit('end')
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  await assert.rejects(placing, /disconnect/i)
  assert.equal(clock.pending(), 0)
})
test('unsupported Mineflayer updates fail before injecting plugins', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tick-plugins-'))
  try {
    fs.copyFileSync(path.join(__dirname, '../src/tick-plugins.js'), path.join(temporary, 'tick-plugins.js'))
    fs.copyFileSync(path.join(__dirname, '../src/position-packet.js'), path.join(temporary, 'position-packet.js'))
    const packageDir = path.join(temporary, 'node_modules', 'mineflayer')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '4.37.2' }))
    const { createTickPlugins } = require(path.join(temporary, 'tick-plugins.js'))
    assert.throws(() => createTickPlugins(testClock()), /unsupported.*mineflayer.*4\.37\.2/i)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
