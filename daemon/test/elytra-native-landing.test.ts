import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { choose } from '../src/elytra/control'
import { worldOf } from '../src/elytra/physics'

test('native 1.21.11 landing clears movement fall before contact and has no wall or skid collision', t => {
  const data = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')(data)
  const { Physics, PlayerState } = require('prismarine-physics')
  const world = { getBlock(p) {
    const q = p.floored()
    const solid = q.y < 100 || Math.abs(q.x) > 30 || Math.abs(q.z) > 30
    const b = Block.fromStateId((solid ? data.blocksByName.stone : data.blocksByName.air).minStateId, 0)
    b.position = q
    return b
  } }
  const bot: any = {
    on() {}, blockAt: world.getBlock, version: '1.21.11',
    entity: { position: new Vec3(.5, 122, .5), velocity: new Vec3(1.2, 0, 0),
      effects: {}, attributes: {}, onGround: false, elytraFlying: true, yaw: 0, pitch: 0 },
    inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0
  }
  bot.inventory.slots[6] = { name: 'elytra' }
  const physics = Physics(data, world)
  bot.physics = physics
  const W = worldOf(bot)
  const goal = { kind: 'land', at: new Vec3(6, 100, 6), edge: () => false,
    arena: { x: 0, z: 0, r: 30, killY: 90 } }
  const idle = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  let state = new PlayerState(bot, idle), fd = 1, walls = 0, ticks = 0, maxTime = 0
  for (; ticks < 240 && !state.onGround; ticks++) {
    const start = performance.now()
    const plan = choose(W, { p: state.pos, v: state.vel, boost: state.fireworkRocketDuration, fd }, goal)
    maxTime = Math.max(maxTime, performance.now() - start)
    assert(plan)
    if ('work' in plan) assert(plan.work <= 32769, 'landing search has a bounded operation budget')
    state.yaw = plan.yaw; state.pitch = plan.pitch
    const oldY = state.pos.y
    state = physics.simulatePlayer(state, world)
    fd = state.pos.y > oldY ? 0 : fd + Math.max(0, oldY - state.pos.y)
    if (state.isCollidedHorizontally) walls++
  }
  assert(state.onGround, 'complete the landing within 240 native physics ticks')
  assert(fd <= 3, 'movement fall estimate at native touchdown: ' + fd)
  for (let i = 0; i < 10; i++) {
    state = physics.simulatePlayer(state, world)
    if (state.isCollidedHorizontally) walls++
    assert(state.pos.y >= 100, 'runout retains support')
  }
  assert.equal(walls, 0)
  t.diagnostic(JSON.stringify({ ticks, fd, walls, maxTime }))
})
