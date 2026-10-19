'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import edges = require('../src/edges')
import reflex = require('../src/reflex-lock')
import * as gameClock from '../src/game-clock'

// Real hand/reflex wrappers around the bot boundary: force-look changes the
// entity synchronously in Mineflayer, but reflex.operation awaits before it.
function fixture (look?: any) {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  const packets = []
  bot._client.write = (name, data) => packets.push({ name, ...data })
  bot.entity = { position: new Vec3(2.5, 200, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: -Math.PI / 2, pitch: 0 }
  bot.health = 20
  bot.game = { gameMode: 'survival', dimension: 'minecraft:overworld' }
  bot.quickBarSlot = 0
  bot.inventory = new EventEmitter()
  bot.inventory.slots = []
  bot.inventory.slots[37] = { name: 'bucket', slot: 37 }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.heldItem = bot.inventory.slots[36 + slot] }
  bot.equip = async () => {}
  bot.look = look || ((yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; return Promise.resolve() })
  bot.activateItem = () => bot._client.write('use_item', { yaw: bot.entity.yaw, pitch: bot.entity.pitch, held: bot.heldItem?.name })
  const water = { name: 'water', position: new Vec3(0, 200, 0), getProperties: () => ({ level: 0 }) }
  bot.blockAt = pos => pos.floored().equals(water.position) ? water : { name: 'air', position: pos.floored(), boundingBox: 'empty', getProperties: () => ({} as Record<string, any>) }
  const session = { bot }
  const guard = edges.installFallGuard(session)
  reflex.install(session)
  guard.placed = { t: gameClock.now(), pos: water.position, fall: 8, hpAir: 20, landed: gameClock.now() - 200 }
  return { bot, guard, packets }
}

const flush = () => new Promise<any>(resolve => setImmediate(resolve))

test('MLG pickup sends bucket use only after the reflex-wrapped look reaches the water', async () => {
  const { bot, packets } = fixture()
  bot.emit('physicsTick')
  await flush()
  const use = packets.find(p => p.name === 'use_item')
  assert.ok(use, 'bucket use is sent')
  assert.equal(use.held, 'bucket')
  // Water is two blocks west and 1.32 blocks below the eyes.
  assert.ok(Math.abs(use.yaw - Math.PI / 2) < 1e-9, `wrong use yaw: ${use.yaw}`)
  assert.ok(Math.abs(use.pitch - Math.atan2(-1.32, 2)) < 1e-9, `wrong use pitch: ${use.pitch}`)
})

test('MLG pickup does not use the bucket when aiming rejects', async () => {
  const { bot, packets } = fixture(() => Promise.reject(new Error('look cancelled')))
  bot.emit('physicsTick')
  await flush()
  assert.equal(packets.filter(p => p.name === 'use_item').length, 0)
})

test('MLG pickup does not send a stale bucket use after the placed-water attempt is replaced', async () => {
  let resolveLook
  const waiting = new Promise<any>(resolve => { resolveLook = resolve })
  const { bot, guard, packets } = fixture(() => waiting)
  bot.emit('physicsTick')
  await flush()
  guard.placed = null
  resolveLook()
  await flush()
  assert.equal(packets.filter(p => p.name === 'use_item').length, 0)
})

test('MLG water placement waits for the reflex-wrapped downward look before use', async () => {
  const { bot, guard, packets } = fixture()
  guard.placed = null
  guard.peak = 208
  bot.entity.position = new Vec3(2.5, 202.3, 0.5)
  bot.entity.velocity.y = -0.9
  bot.entity.onGround = false
  bot.inventory.slots[37] = { name: 'water_bucket', slot: 37 }
  bot.blockAt = pos => ({ name: pos.y < 200 ? 'stone' : 'air', position: pos.floored(), boundingBox: pos.y < 200 ? 'block' : 'empty' })
  bot.emit('physicsTick')
  await flush()
  const use = packets.find(p => p.name === 'use_item')
  assert.ok(use, 'water use is sent')
  assert.equal(use.held, 'water_bucket')
  assert.equal(use.pitch, -Math.PI / 2)
})
