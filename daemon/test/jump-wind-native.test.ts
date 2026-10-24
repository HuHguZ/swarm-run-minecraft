import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import * as edges from '../src/edges'
import { getPhysics } from '../src/tick-plugins'
import { teamSafe } from '../src/spear'

// Local 1.21.11 LivingEntity.jumpFromGround: setDeltaMovement(oldX, max(getJumpPower(), oldY), oldZ).
// getJumpPower includes Jump Boost before the max; sprint then adds its native horizontal .2 impulse.
function fixture({ vy = -.0784000015258789, jumpBoost = 0, sprint = false, ceiling = false, queued = false, held = true } = {}) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock(p) {
    const pos = p.floored(), solid = pos.y === 0 || ceiling && pos.y === 3
    const block = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState)
    block.position = pos; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, game: { minY: -64, height: 384 }, food: 20,
    inventory: { slots: [] }, jumpTicks: 0, jumpQueued: queued, fireworkRocketDuration: 0,
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(.10754042068376066, vy, 0), yaw: -Math.PI / 2, pitch: 0,
      onGround: true, effects: {}, attributes: {}, isInWater: false, isInLava: false, isInWeb: false },
    blockAt: p => world.getBlock(p), physics: getPhysics().Physics(registry, world) })
  const controls = { ...edges.IDLE, jump: held, sprint }, state = edges.stateOf(bot, controls)
  state.jumpBoost = jumpBoost
  return { bot, controls, state, step() { edges.simOf(bot)(state, edges.worldOf(bot)); return state } }
}

for (const queued of [false, true]) test(`ground jump keeps the larger native wind impulse (queued=${queued})`, () => {
  // The owned live burst supplied +.8671859873436613 before the pending native jump.
  const incoming = -.0784000015258789 + .8671859873436613
  const f = fixture({ vy: incoming, queued, held: !queued }), before = f.state.pos.y
  f.step()
  assert.ok(Math.abs(f.state.pos.y - before - incoming) < 1e-12)
  assert.ok(Math.abs(f.state.vel.y - (incoming - .08) * Math.fround(.98)) < 1e-12)
  assert.equal(f.controls.jump, !queued, 'physics preserves the caller input rather than cancelling a jump')
})

test('ordinary, negative and smaller upward velocities retain the ordinary native jump', () => {
  for (const vy of [-.4, -.0784000015258789, 0, .2]) {
    const f = fixture({ vy }), before = f.state.pos.y; f.step()
    assert.ok(Math.abs(f.state.pos.y - before - Math.fround(.42)) < 1e-12)
  }
})

test('native max compares the complete Jump Boost power with the existing wind velocity', () => {
  for (const incoming of [.45, .7]) {
    const f = fixture({ vy: incoming, jumpBoost: 1 }), before = f.state.pos.y; f.step()
    const jumpPower = Math.fround(Math.fround(.42) + Math.fround(.1))
    assert.ok(Math.abs(f.state.pos.y - before - Math.max(jumpPower, incoming)) < 1e-7)
  }
})

test('native sprint still adds horizontal knockback while a larger vertical wind impulse survives', () => {
  const f = fixture({ vy: .79, sprint: true }), before = f.state.pos.clone(); f.step()
  assert.ok(Math.abs(f.state.pos.x - before.x - (.10754042068376066 + .2)) < 1e-7)
  assert.ok(Math.abs(f.state.pos.y - before.y - .79) < 1e-12)
})

test('native collision still clips an upward impulse against the visible ceiling', () => {
  const f = fixture({ vy: .79, ceiling: true }), before = f.state.pos.y; f.step()
  assert.ok(Math.abs(f.state.pos.y - before - .2) < 1e-7)
  assert.ok(f.state.vel.y < 0, 'collision zeroes upward movement before native gravity')
})

test('the spear ray still vetoes a newly visible ally after actual wind and jump physics', () => {
  const f = fixture({ vy: .79 }), bot = f.bot
  bot.username = 'Me'; bot.entity.username = 'Me'; bot._ndSwarmAllies = ['Late']; bot.entities = {}; bot.players = {}
  f.step()
  Object.assign(bot.entity, { position: f.state.pos.clone(), velocity: f.state.vel.clone(), onGround: f.state.onGround })
  assert.equal(teamSafe(bot, -Math.PI / 2, 0), true)
  bot.entities[2] = { id: 2, username: 'Late', type: 'player', position: bot.entity.position.offset(3, 0, 0),
    velocity: new Vec3(0, 0, 0), width: .6, height: 1.8, onGround: false }
  assert.equal(teamSafe(bot, -Math.PI / 2, 0), false)
})
