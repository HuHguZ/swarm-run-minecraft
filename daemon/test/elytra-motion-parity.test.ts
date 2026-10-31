import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { glideStep } from '../src/elytra/physics'
import { getPhysics } from '../src/tick-plugins'

test('flight prediction matches the live vertical deadzone before flight and rocket forces', () => {
  const registry = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')(registry), scoped = getPhysics()
  const world = { getBlock (p) {
    const b = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
    b.position = p.floored(); return b
  } }
  const physics = scoped.Physics(registry, world)
  for (const vy of [-.003001, -.003, -.002999, -.000001, 0, .000001, .002999, .003, .003001]) {
    for (const pitch of [-1.3, 0, .45, .95]) for (const boost of [0, 5]) {
      const bot: any = { version: '1.21.11', registry, physics, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: boost,
        inventory: { slots: Array.from({ length: 46 }, (_, i) => i === 6 ? { name: 'elytra' } : null) },
        entity: { position: new Vec3(.5, 128, .5), velocity: new Vec3(.6, vy, .2),
          yaw: -.7, pitch, elytraFlying: true, onGround: false, effects: {}, attributes: {} } }
      const state = new scoped.PlayerState(bot, { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
      physics.simulatePlayer(state, world)
      const p = { ...bot.entity.position }, v = { ...bot.entity.velocity }
      glideStep(p, v, bot.entity.yaw, pitch, boost > 0)
      for (const axis of ['x', 'y', 'z']) {
        assert(Math.abs(p[axis] - state.pos[axis]) < 1e-12, `position ${axis}, vy=${vy}, pitch=${pitch}, boost=${boost}`)
        assert(Math.abs(v[axis] - state.vel[axis]) < 1e-12, `velocity ${axis}, vy=${vy}, pitch=${pitch}, boost=${boost}`)
      }
    }
  }
})
