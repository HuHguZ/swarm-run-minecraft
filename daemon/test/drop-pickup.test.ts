'use strict'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path = require('node:path')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Мир — пол на y=63 (верх 64). Подбор (drops.js) ведёт тело, пока рамка подбора не
// коснётся предмета; «сервер» отдаёт стопку пакетом collect.
function fakeBot (drop) {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = { entitiesByName: { item: { id: 71 } } }
  bot.entity = { position: new Vec3(1.5, 64, 0.5), isCollidedHorizontally: false }
  bot.entities = { [drop.id]: drop }
  bot.inventory = { emptySlotCount: () => 1, items: () => [] }
  bot.blockAt = p => p.y < 64 && p.y >= 63
    ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', position: p }
    : { name: 'air', shapes: [], boundingBox: 'empty', position: p }
  bot.clearControlStates = () => {}
  bot.setControlState = () => {}
  bot.look = async () => {}
  bot.pathfinder = {
    isMoving: () => false,
    setGoal (goal) {
      if (!goal) return
      // A* кончает в первом узле, где цель достигнута, — ближнем к телу.
      for (const x of [1, 2, 3]) if (goal.isEnd({ x, y: 64, z: 0 })) { bot.entity.position = new Vec3(x + 0.5, 64, 0.5); break }
    }
  }
  return bot
}

test('подбор ведёт тело, пока рамка подбора не коснётся предмета, и считает только отданное сервером', async () => {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const drop = { id: 10, name: 'item', position: new Vec3(3.9, 64, 0.5), getDroppedItem: () => ({ name: 'mutton', count: 1 }) }
  const bot = fakeBot(drop)
  const timer = setInterval(() => {
    const me = bot.entity.position
    if (bot.entities[10] && Math.abs(me.x - drop.position.x) < 1.425) { bot.emit('playerCollect', bot.entity, drop); delete bot.entities[10] }
  }, 20)
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, process: { env: {} as Record<string, any> },
    require: n => n === './pack' ? { fits: () => true, ignoreDrop: () => false } : realRequire(n) }
  vm.runInNewContext(bodySource(file), cjsContext(context))
  try {
    const picked = await context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 2000 })
    assert.equal(picked, 1)
    assert.equal(bot.entities[10], undefined)
    assert.ok(bot.entity.position.x >= 2.5, `тело в ${bot.entity.position.x}`)
  } finally { clearInterval(timer) }
})

test('исчезнувшее без пакета collect (слилось, сгорело) подобранным не считается', async () => {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const drop = { id: 11, name: 'item', position: new Vec3(3.9, 64, 0.5), getDroppedItem: () => ({ name: 'mutton', count: 1 }) }
  const bot = fakeBot(drop)
  setTimeout(() => { delete bot.entities[11] }, 100)
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, process: { env: {} as Record<string, any> },
    require: n => n === './pack' ? { fits: () => true, ignoreDrop: () => false } : realRequire(n) }
  vm.runInNewContext(bodySource(file), cjsContext(context))
  const picked = await context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 1500 })
  assert.equal(picked, 0)
})
test('known harvest waits for a delayed spawn packet within its pickup budget', async () => {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const drop = { id: 12, name: 'item', position: new Vec3(3.9, 64, .5), getDroppedItem: () => ({ name: 'string', count: 1 }) }
  const bot = fakeBot(drop); delete bot.entities[12]
  const appear = setTimeout(() => { bot.entities[12] = drop }, 750)
  const pickup = setInterval(() => {
    if (bot.entities[12] && Math.abs(bot.entity.position.x - drop.position.x) < 1.425) {
      bot.emit('playerCollect', bot.entity, drop); delete bot.entities[12]
    }
  }, 20)
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    process: { env: {} as Record<string, any> }, require: n => n === './pack' ? { fits: () => true, ignoreDrop: () => false } : realRequire(n) }
  vm.runInNewContext(bodySource(file), cjsContext(context))
  try { assert.equal(await context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 1500, appearMs: 1500 }), 1) }
  finally { clearTimeout(appear); clearInterval(pickup) }
})

test('750 TPS still waits for native spawn and pickup replies without counting a predicted drop', async t => {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const gameClock = realRequire('./game-clock')
  let wallNow = 0
  t.mock.method(gameClock.wall, 'monotonic', () => wallNow)
  const clock = new gameClock.GameClock({ manual: true, epoch: 1000 })
  clock.setState({ tick_rate: 750 }); clock.start(); gameClock.activate(clock)
  const drop = { id: 13, name: 'item', position: new Vec3(1.5, 64, .5), getDroppedItem: () => ({ name: 'string', count: 1 }) }
  const bot = fakeBot(drop); bot.version = '1.21.11'; delete bot.entities[13]
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    process: { env: {} as Record<string, any> }, require: n => n === './pack' ? { fits: () => true, ignoreDrop: () => false } : realRequire(n) }
  vm.runInNewContext(bodySource(file), cjsContext(context))
  try {
    // Deliver the native inputs after loading the fixture. Wall timers scheduled
    // before cold VM loading could both fire before the item was ever observed.
    let settled = false
    const pending = context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 1500, appearMs: 1500 })
    pending.then(() => { settled = true })
    const advance = async ticks => {
      wallNow += ticks * 1000 / 750; clock.advanceTicks(ticks)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    await advance(75)
    assert.equal(settled, false, 'native spawn is still pending after the gameplay budget')
    bot.entities[13] = drop
    await advance(2)
    assert.equal(bot._ndLastCollect.seen, 1)
    await advance(73)
    assert.equal(settled, false, 'a visible predicted pickup is not a native collect receipt')
    assert.equal(bot._ndLastCollect.picked, 0)
    bot.emit('playerCollect', bot.entity, drop); delete bot.entities[13]
    await advance(1)
    assert.equal(await pending, 1)
    assert.ok(clock.ticks * 50 > 1500, 'native replies can arrive after the original gameplay budget')
    assert.equal(bot.entities[13], undefined)
  } finally { clock.dispose(); gameClock.activate(null) }
})
