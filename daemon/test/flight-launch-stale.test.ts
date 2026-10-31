import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { rollout } from '../src/elytra/physics'

for (const mode of ['clear', 'moved', 'cancelled', 'handoff', 'refill-cancelled', 'refill-moved']) test(`takeoff rocket preparation: ${mode}`, async t => {
  const moved = mode.endsWith('moved'), ctl = { aborted: false }
  const W = { boxHit: (x, y, _z, h = .6) => x + .3 > 30 || y < 0, floorBelow: () => ({ top: 0 }) }
  const bot: any = new EventEmitter(), rocket = { name: 'firework_rocket', count: 16 }
  bot.entity = { id: 1, position: new Vec3(.5, 6, .5), velocity: new Vec3(0, -.08, 0),
    onGround: false, yaw: -Math.PI / 2, pitch: 1.05, elytraFlying: false }
  bot.health = 20; bot._ndElytra = { driving: mode === 'handoff' ? 1 : 0 }; bot._client = { write() {} }; bot.supportFeature = () => false
  bot.inventory = { items: () => [rocket], slots: { 6: { name: 'elytra' }, 45: rocket } }
  bot.quickBarSlot = 0
  bot.setQuickBarSlot = i => { bot.quickBarSlot = i }
  if (mode.startsWith('refill-')) { rocket['slot'] = 10; bot.inventory.slots[10] = rocket; delete bot.inventory.slots[45] }
  bot.moveSlotItem = async (from, to) => {
    bot.inventory.slots[to] = bot.inventory.slots[from]; delete bot.inventory.slots[from]
    if (moved) { bot.entity.position.x = 29; bot.entity.velocity.x = .6 }
    else ctl.aborted = true
  }
  bot.setControlState = () => {}
  if (mode === 'handoff') bot.entity.yaw = 0
  bot.look = async (yaw, pitch) => {
    if (bot._ndElytra.driving && !bot._ndElytra.steering) return
    bot.entity.yaw = yaw; bot.entity.pitch = pitch
  }
  let launched: any, uses = 0, ticks = 0
  bot.activateItem = () => {
    uses++; bot.fireworkRocketDuration = 40
    const b = bot.entity
    launched = rollout(W, b.position, b.velocity, b.yaw, b.pitch, 40, 14)
  }
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => W)
  t.mock.method(require('../src/elytra/consts'), 'nextTick', async () => {
    if (mode === 'moved' && ticks++ === 0) { bot.entity.position.x = 29; bot.entity.velocity.x = .6 }
    if (mode === 'cancelled') ctl.aborted = true
    return true
  })
  const file = require.resolve('../src/elytra/flight'), cached = require.cache[file]
  delete require.cache[file]; t.after(() => { if (cached) require.cache[file] = cached; else delete require.cache[file] })
  const { takeoff } = require('../src/elytra/flight')
  const result = await takeoff(bot, ctl, { yaw: -Math.PI / 2, pitch: 1.05 })
  if (mode === 'cancelled' || mode === 'refill-cancelled') {
    assert.equal(uses, 0, 'an obsolete takeoff cannot consume another owner\'s rocket')
    assert.equal(result.ok, false)
    return
  }
  assert.equal(result.ok, true)
  assert.equal(uses, 1)
  assert.ok(launched?.kind !== 'wall' || launched.dmg < .5, 'use the existing launch risk limit after movement, not the obsolete course')
  if (!moved) assert.equal(bot.entity.yaw, -Math.PI / 2)
})
