import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf, rollout } from '../src/elytra/physics'

test('HJ31m: the hanging lantern beside the glider is a wall, not an overlapping ceiling', () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), b = q.equals(new Vec3(536, 124, 571))
      ? Block.fromStateId(20636, 0) : Block.fromStateId(data.blocksByName.air.defaultState, 0)
    b.position = q; return b
  } }
  // HJ game tick 4503, followed by the recorded steering into the lantern's narrow footprint.
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry: data, blockAt: world.getBlock,
    entity: { position: new Vec3(536.3000000119209, 123.4625, 570.922019154502),
      velocity: new Vec3(0, 0, -.10568068611150001), effects: {}, attributes: {},
      onGround: false, elytraFlying: true, yaw: -3.05, pitch: .12 },
    inventory: { slots: { 6: { name: 'elytra' } } }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 28
  })
  const { Physics, PlayerState } = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const state = new PlayerState(bot, {})
  Physics(data, world).simulatePlayer(state, world)
  assert.equal(state.isCollidedHorizontally, true)
  assert.equal(state.isCollidedVertically, false)
  const W = worldOf(bot), p = bot.entity.position
  assert.equal(W.boxHit(p.x, p.y, p.z, .6), false, 'the space beside the lantern is free before moving')
  assert.equal(rollout(W, p, bot.entity.velocity, state.yaw, state.pitch, 14, 1).kind, 'wall')
  assert.equal(W.floorBelow(536.05, 125, 571.05, 2), null, 'a lantern cannot support a landing beside its actual shape')
})

for (const type of ['bottom', 'top']) test(`flight keeps the actual ${type} slab shape and invalidates it on updates`, () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  let slab = true
  const bot: any = Object.assign(new EventEmitter(), { blockAt(p: Vec3) {
    const q = p.floored(), b = slab && q.equals(new Vec3(0, 10, 0))
      ? Block.fromProperties('smooth_quartz_slab', { type, waterlogged: false }, 0)
      : Block.fromStateId(data.blocksByName.air.defaultState, 0)
    b.position = q; return b
  } })
  const W = worldOf(bot)
  assert.equal(W.boxHit(.5, type === 'bottom' ? 10.5 : 10, .5, .4), false)
  assert.equal(W.boxHit(.5, type === 'bottom' ? 10 : 10.5, .5, .4), true)
  assert.equal(W.floorBelow(.5, 11, .5, 2)?.top, type === 'bottom' ? 10.5 : 11)
  slab = false; bot.emit('blockUpdate', null, { position: new Vec3(0, 10, 0) })
  assert.equal(W.floorBelow(.5, 11, .5, 2), null)
  slab = true; W.clear()
  assert.equal(W.boxHit(.5, type === 'bottom' ? 10 : 10.5, .5, .4), true)
})
