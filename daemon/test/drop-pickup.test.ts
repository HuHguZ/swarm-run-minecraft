'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const path = require('node:path')
const Vec3 = require('vec3')

// Мир — пол на y=63 (верх 64). Подбор (drops.js) ведёт тело, пока рамка подбора не
// коснётся предмета; «сервер» отдаёт стопку пакетом collect.
function fakeBot (drop) {
  const bot = new EventEmitter()
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
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
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
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
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
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  try { assert.equal(await context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 1500, appearMs: 1500 }), 1) }
  finally { clearTimeout(appear); clearInterval(pickup) }
})

test('750 TPS still waits for native spawn and pickup replies without counting a predicted drop', async () => {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const gameClock = realRequire('./game-clock')
  const clock = new gameClock.GameClock({ manual: true, epoch: 1000 })
  clock.setState({ tick_rate: 750 }); clock.start(); gameClock.activate(clock)
  const drop = { id: 13, name: 'item', position: new Vec3(1.5, 64, .5), getDroppedItem: () => ({ name: 'string', count: 1 }) }
  const bot = fakeBot(drop); bot.version = '1.21.11'; delete bot.entities[13]
  const ticks = setInterval(() => { for (let i = 0; i < 20; i++) clock.pulse() }, 2)
  const appear = setTimeout(() => { bot.entities[13] = drop }, 100)
  const pickup = setTimeout(() => { bot.emit('playerCollect', bot.entity, drop); delete bot.entities[13] }, 200)
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    process: { env: {} as Record<string, any> }, require: n => n === './pack' ? { fits: () => true, ignoreDrop: () => false } : realRequire(n) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  try {
    const result = await context.module.exports.collectNearbyDrops(bot, { aborted: false }, { timeoutMs: 1500, appearMs: 1500 })
    assert.equal(result, 1)
    assert.ok(clock.ticks * 50 > 1500, 'native replies can arrive after the original gameplay budget')
    assert.equal(bot.entities[13], undefined)
  } finally { clearInterval(ticks); clearTimeout(appear); clearTimeout(pickup); clock.dispose(); gameClock.activate(null) }
})
