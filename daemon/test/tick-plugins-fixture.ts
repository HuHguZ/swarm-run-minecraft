'use strict'
// Общее для тестов плагинов тика (tick-plugins-*.test.ts, pathfinder-*.test.ts): удвоены только внешний сервер и его часы.
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
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
    async advanceGame (ms, yieldTurns = true) {
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
        if (yieldTurns) await new Promise<any>(resolve => setImmediate(resolve))
      }
      gameNow = end
    },
    async advanceWall (ms) {
      const end = wallNow + ms
      for (;;) {
        const next = [...wallTimers].filter(([, timer]: any) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        wallTimers.delete(next[0])
        wallNow = next[1].due
        next[1].fn(...next[1].args)
        await new Promise<any>(resolve => setImmediate(resolve))
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
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.packets = []
  bot._client.write = (name, packet) => bot.packets.push({ name, ...packet })
  bot.registry = data
  bot.version = '1.21.11'
  bot.supportFeature = data.supportFeature
  bot.entity = {
    id: 1, position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: 0, pitch: 0, effects: {} as Record<string, any>, attributes: {} as Record<string, any>, eyeHeight: 1.62, height: 1.8
  }
  bot.entities = {} as Record<string, any>
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
function install (clock, { digging = false, pathfinder = false, physicsEnabled = true }: any = {} as Record<string, any>) {
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
  const adapters = createTickPlugins(clock)
  const bot = testBot()
  adapters.plugins.physics(bot, { physicsEnabled })
  if (digging) adapters.plugins.digging(bot)
  if (pathfinder) adapters.pathfinder(bot)
  bot.emit('login')
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 1 })
  bot.entity.onGround = true
  return bot
}

export { data, Block, testClock, block, testBot, install }
