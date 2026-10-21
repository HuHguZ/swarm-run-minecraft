'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { run } from '../src/edges/forecast'

// Native installed 1.21.11 physics, full Block shapes; no simulated result stubs.
function fixture(drop = 3, dimension = 'overworld', water = false) {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const { Physics, PlayerState } = require('prismarine-physics')
  const read = p => {
    const name = Math.floor(p.y) < (p.x < 1 ? 64 : 64 - drop) ? 'stone' :
      water && p.x >= 1 && p.y < 64 ? 'water' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].minStateId)
    b.position = p.floored()
    return b
  }
  const bot: any = { version: '1.21.11', registry, game: { dimension }, health: 1, food: 1,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(.1, 0, 0), onGround: true,
      effects: {}, attributes: {}, yaw: -Math.PI / 2, pitch: 0 },
    jumpTicks: 0, jumpQueued: false, inventory: { slots: [] }, blockAt: read,
    physics: Physics(registry, { getBlock: read }) }
  const control = { forward: true, jump: true, sprint: false, back: false, left: false, right: false, sneak: false }
  return { bot, control, state: () => new PlayerState(bot, { ...control }), read }
}
function forecast(f, flag, safe = 3) {
  const saved = process.env.ND_OW_FALL_ARC
  if (flag === undefined) delete process.env.ND_OW_FALL_ARC
  else process.env.ND_OW_FALL_ARC = flag
  try { return run(f.bot, f.state(), f.control, { hold: 35, max: 35, groundY: 64, safe, land: true }) }
  finally { if (saved === undefined) delete process.env.ND_OW_FALL_ARC; else process.env.ND_OW_FALL_ARC = saved }
}

test('L: native jump to a three-block-lower ledge has an unsafe 4.252-block arc at HP1', () => {
  const f = fixture(), state = f.state()
  let fallen = 0
  for (let tick = 0; tick < 35; tick++) {
    const before = state.pos.y
    f.bot.physics.simulatePlayer(state, { getBlock: f.read })
    fallen += Math.max(0, before - state.pos.y)
    if (tick > 1 && state.onGround) break
  }
  assert.equal(state.pos.y, 61)
  assert.ok(fallen > 4.25 && fallen < 4.26, 'native downward distance, including the jump apex')
  assert.equal(forecast(f, '1').fall, true, 'the actual forecast must see the unsafe arc before executing it')
})
test('L: the opt-in arc predictor preserves default, zero, other worlds and explicit descent allowance', () => {
  for (const value of [undefined, '0']) assert.equal(forecast(fixture(), value).fall, false)
  for (const world of ['the_nether', 'the_end']) assert.equal(forecast(fixture(3, world), '1').fall, false)
  assert.equal(forecast(fixture(3, 'minecraft:overworld'), '1').fall, true)
  assert.equal(forecast(fixture(), '1', 6).fall, false, 'an explicitly allowed descent retains its budget')
})
test('L: ordinary safe jumps, a three-block walk down and water remain valid alternatives', () => {
  for (const drop of [0, 1]) assert.equal(forecast(fixture(drop), '1').fall, false)
  const walk = fixture()
  walk.control.jump = false
  assert.equal(forecast(walk, '1').fall, false)
  assert.equal(forecast(fixture(3, 'overworld', true), '1').fall, false)
})
