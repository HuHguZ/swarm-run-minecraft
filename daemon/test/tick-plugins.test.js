'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')

// Only the external server and its clock are doubled. Physics, block digTime,
// Mineflayer injection and pathfinding use the installed production libraries.
function testClock (rate = 20) {
  let gameNow = 1000000
  let wallNow = 0
  let frozen = false
  let nextId = 0
  const timers = new Map()
  const wallTimers = new Map()
  function schedule (fn, ms, interval, args) {
    const handle = ++nextId
    timers.set(handle, { fn, due: gameNow + ms, interval, args })
    return handle
  }
  const clock = {
    now: () => gameNow,
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, 0, args),
    clearTimeout: handle => timers.delete(handle),
    setInterval: (fn, ms, ...args) => schedule(fn, ms, ms, args),
    clearInterval: handle => timers.delete(handle),
    freeze: value => { frozen = value },
    pending: () => timers.size + wallTimers.size,
    async advanceGame (ms) {
      const end = gameNow + ms
      while (true) {
        let next = null
        for (const entry of timers) {
          if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry
        }
        if (!next) break
        const [handle, timer] = next
        gameNow = timer.due
        if (timer.interval) timer.due += timer.interval
        else timers.delete(handle)
        timer.fn(...timer.args)
        // Native timer turns allow promise continuations to change controls
        // before the next physics tick, including accelerated game time.
        await new Promise(resolve => setImmediate(resolve))
      }
      gameNow = end
    },
    async advanceWall (ms) {
      const end = wallNow + ms
      for (;;) {
        const next = [...wallTimers].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        wallTimers.delete(next[0])
        wallNow = next[1].due
        next[1].fn(...next[1].args)
        await new Promise(resolve => setImmediate(resolve))
      }
      wallNow = end
      if (!frozen) await clock.advanceGame(ms * rate / 20)
    },
    wall: {
      now: () => wallNow,
      setTimeout: (fn, ms, ...args) => {
        const handle = ++nextId
        wallTimers.set(handle, { fn, due: wallNow + ms, args })
        return handle
      },
      clearTimeout: handle => wallTimers.delete(handle)
    }
  }
  return clock
}

function block (name, position) {
  const b = Block.fromStateId(data.blocksByName[name].defaultState, 0)
  b.position = position.floored()
  return b
}

function testBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.packets = []
  bot._client.write = (name, packet) => bot.packets.push({ name, ...packet })
  bot.registry = data
  bot.version = '1.21.11'
  bot.supportFeature = data.supportFeature
  bot.entity = {
    id: 1, position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {}, eyeHeight: 1.62, height: 1.8
  }
  bot.entities = {}
  bot.isAlive = true
  bot.game = { gameMode: 'survival', minY: -64 }
  bot.inventory = { slots: [], items: () => bot.inventory.slots.filter(Boolean) }
  bot.heldItem = { type: data.itemsByName.iron_pickaxe.id, enchants: [] }
  bot.getEquipmentDestSlot = () => 5
  bot.blockAt = p => block(p.y < 1 ? 'stone' : 'air', p)
  bot._updateBlockState = p => bot.emit(`blockUpdate:${p}`, block('stone', p), block('air', p))
  bot.swings = 0
  bot.swingArm = () => { bot.swings++ }
  return bot
}

function install (clock, { digging = false, pathfinder = false, physicsEnabled = true } = {}) {
  const { createTickPlugins } = require('../src/tick-plugins')
  const adapters = createTickPlugins(clock)
  const bot = testBot()
  adapters.plugins.physics(bot, { physicsEnabled })
  if (digging) adapters.plugins.digging(bot)
  if (pathfinder) adapters.pathfinder(bot)
  bot.emit('login')
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
  bot.entity.onGround = true
  return bot
}

test('20 and 200 TPS produce identical movement in twenty fixed physics steps', async () => {
  const endPositions = []
  for (const rate of [20, 200]) {
    const clock = testClock(rate)
    const bot = install(clock)
    let ticks = 0
    bot.on('physicsTick', () => { ticks++ })
    bot.setControlState('forward', true)
    await clock.advanceWall(rate === 20 ? 1000 : 100)
    assert.equal(ticks, 20)
    assert.ok(bot.entity.position.z > 4, 'actual prismarine physics moved the player')
    endPositions.push(bot.entity.position)
    bot.emit('end')
    assert.equal(clock.pending(), 0)
  }
  assert.deepEqual(endPositions[0], endPositions[1])
})

test('play ticks end after movement, including unloaded terrain, and stop outside play', async () => {
  const clock = testClock(200)
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  bot._client.state = 'configuration'
  createTickPlugins(clock).plugins.physics(bot, {})
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets, [], 'the adapter sends nothing before login')
  bot.emit('login')
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets, [], 'the configuration state has no play packets')
  bot._client.state = 'play'
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
  bot.entity.onGround = true
  bot.packets.length = 0
  bot.setControlState('forward', true)
  for (let tick = 0; tick < 3; tick++) {
    const start = bot.packets.length
    await clock.advanceGame(50)
    const names = bot.packets.slice(start).map(packet => packet.name)
    assert.equal(names.at(-1), 'tick_end')
    assert.equal(names.filter(name => name === 'tick_end').length, 1)
    assert.ok(names.slice(0, -1).some(name => ['position', 'position_look', 'look', 'flying'].includes(name)),
      'movement is sent before that tick ends')
  }
  bot.blockAt = () => null
  let start = bot.packets.length
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets.slice(start).map(packet => packet.name), ['tick_end'])
  bot._client.state = 'configuration'
  start = bot.packets.length
  await clock.advanceGame(50)
  assert.equal(bot.packets.length, start)
  bot.emit('end')
  bot._client.state = 'play'
  await clock.advanceGame(50)
  assert.equal(bot.packets.length, start)
  assert.equal(clock.pending(), 0)
})

test('respawn transport response uses wall time while frozen and cancels on disconnect', async () => {
  const clock = testClock(200)
  clock.freeze(true)
  await clock.advanceWall(1)
  const bot = install(clock)
  let forced = 0
  let physicsTicks = 0
  bot.on('forcedMove', () => { forced++ })
  bot.on('physicsTick', () => { physicsTicks++ })
  const gameNow = clock.now()
  bot.emit('death')
  bot.emit('respawn')
  bot._client.emit('position', { x: 2.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 2 })
  await clock.advanceWall(1499)
  assert.equal(forced, 0)
  await clock.advanceWall(1)
  assert.equal(forced, 1, 'the server receives its respawn response even without ticking')
  assert.equal(bot.packets.at(-1).name, 'position_look')
  assert.equal(bot.packets.at(-1).x, 2.5)
  assert.equal(clock.now(), gameNow)
  assert.equal(physicsTicks, 0)
  await clock.advanceGame(50)
  assert.equal(physicsTicks, 1, 'the first granted tick can simulate after the transport response')
  bot.emit('death')
  bot._client.emit('position', { x: 3.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 3 })
  bot.emit('end')
  const packetsAtEnd = bot.packets.length
  assert.equal(clock.pending(), 0)
  await clock.advanceWall(1500)
  assert.equal(bot.packets.length, packetsAtEnd)
  assert.equal(forced, 1)
})

test('respawn delay eligibility expires on wall time while game time is frozen', async () => {
  const clock = testClock(200)
  clock.freeze(true)
  await clock.advanceWall(1)
  const bot = install(clock)
  bot.emit('death')
  await clock.advanceWall(2000)
  let forced = 0
  bot.on('forcedMove', () => { forced++ })
  bot._client.emit('position', { x: 2.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 2 })
  assert.equal(forced, 1, 'an old death stamp does not delay later transport replies')
  bot.emit('end')
  assert.equal(clock.pending(), 0)
})

test('frozen clock preserves waitForTicks and stepping advances exactly the requested ticks', async () => {
  const clock = testClock(200)
  const bot = install(clock)
  let completed = false
  const waiting = bot.waitForTicks(5).then(() => { completed = true })
  const initialPosition = bot.entity.position.clone()
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(completed, false)
  assert.deepEqual(bot.entity.position, initialPosition)
  await clock.advanceGame(200)
  assert.equal(completed, false)
  await clock.advanceGame(50)
  await waiting
  assert.equal(completed, true)
  bot.emit('end')
  assert.equal(clock.pending(), 0)
})

test('promise continuations can release movement before the next accelerated physics tick', async () => {
  const clock = testClock(200)
  const bot = install(clock)
  const controls = []
  bot.setControlState('forward', true)
  bot.on('physicsTick', () => controls.push(bot.getControlState('forward')))
  const waiting = bot.waitForTicks(1).then(() => bot.setControlState('forward', false))
  await clock.advanceWall(10)
  await waiting
  assert.deepEqual(controls, [true, false])
  bot.emit('end')
})

test('stone mining uses eight game ticks at both rates and freezes its finish and arm swing', async () => {
  for (const rate of [20, 200]) {
    const clock = testClock(rate)
    const bot = install(clock, { digging: true })
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

test('pathfinder stuck budget counts game time while AStar keeps wall CPU time', async () => {
  const clock = testClock(200)
  const bot = install(clock, { pathfinder: true, physicsEnabled: false })
  const { goals } = require('mineflayer-pathfinder')
  const resets = []
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.setGoal(new goals.GoalBlock(6, 1, 0))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMoving(), true)
  clock.freeze(true)
  await clock.advanceWall(60000)
  bot.emit('physicsTick')
  assert.deepEqual(resets, [])
  const search = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(12, 1, 0))
  assert.equal(search.status, 'success')
  assert.ok(search.time > 0, 'AStar reports real CPU time even when the game clock is frozen')
  await clock.advanceGame(3500)
  bot.emit('physicsTick')
  assert.deepEqual(resets, [])
  await clock.advanceGame(50)
  bot.emit('physicsTick')
  assert.deepEqual(resets, ['stuck'])
  bot.emit('end')
})

test('adapter does not replace process Date, performance or native timers', async () => {
  const original = { Date, now: Date.now, performance: require('node:perf_hooks').performance, setTimeout, setInterval }
  const clock = testClock()
  const bot = install(clock, { digging: true, pathfinder: true })
  await clock.advanceGame(50)
  assert.equal(Date, original.Date)
  assert.equal(Date.now, original.now)
  assert.equal(require('node:perf_hooks').performance, original.performance)
  assert.equal(setTimeout, original.setTimeout)
  assert.equal(setInterval, original.setInterval)
  bot.emit('end')
})

function installInventory (clock) {
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.inventory(bot, {})
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
  const Item = require('prismarine-item')(data)
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
  const { createTickPlugins } = require('../src/tick-plugins')
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
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('sleep'), 0)
  await assert.rejects(sleeping, /disconnect/i)
  assert.equal(clock.pending(), 0)
})

test('entity placement ignores unrelated spawns and clears its watchdog after success', async () => {
  const clock = testClock()
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  await new Promise(resolve => setImmediate(resolve))
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
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  placing.catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 1)
  bot.emit('end')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  await assert.rejects(placing, /disconnect/i)
  assert.equal(clock.pending(), 0)
})

test('unsupported Mineflayer updates fail before injecting plugins', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tick-plugins-'))
  try {
    fs.copyFileSync(path.join(__dirname, '../src/tick-plugins.js'), path.join(temporary, 'tick-plugins.js'))
    const packageDir = path.join(temporary, 'node_modules', 'mineflayer')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '4.37.2' }))
    const { createTickPlugins } = require(path.join(temporary, 'tick-plugins.js'))
    assert.throws(() => createTickPlugins(testClock()), /unsupported.*mineflayer.*4\.37\.2/i)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
