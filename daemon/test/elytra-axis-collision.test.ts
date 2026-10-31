import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf, rollout } from '../src/elytra/physics'

test('a narrow wall beside the glider is a horizontal impact, not an overlapping ceiling (GB31p)', () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  const { Physics, PlayerState } = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const world = { getBlock(p: Vec3) {
    const q = p.floored()
    const b = q.y === 124 && q.z === 565
      ? Block.fromProperties('diorite_wall', { west: 'low', east: 'low', north: 'none', south: 'none', up: false, waterlogged: false }, 0)
      : Block.fromStateId((q.y === 123 ? data.blocksByName.stone : data.blocksByName.air).defaultState, 0)
    b.position = q; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry: data, blockAt: world.getBlock,
    entity: { position: new Vec3(590.7379088502389, 124.94302088912927, 565.0124999880791),
      velocity: new Vec3(.41324181830724077, .033824591010573044, 0),
      effects: {}, attributes: {}, onGround: false, elytraFlying: true, yaw: -2.873147100744254, pitch: .12 },
    inventory: { slots: { 6: { name: 'elytra' } } }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 29
  })
  const physics = Physics(data, world), state = new PlayerState(bot, {})
  physics.simulatePlayer(state, world)
  assert.equal(state.isCollidedHorizontally, true)
  const W = worldOf(bot), p = bot.entity.position
  assert.equal(W.boxHit(p.x, p.y, p.z, .6), false, 'the observed narrow shape does not overlap the glider at contact')
  const r = rollout(W, p, bot.entity.velocity, state.yaw, state.pitch, 16, 1)
  assert.equal(r.kind, 'wall', 'both active thrust values have the same first step; the missing shape is independent of rocket age')
  assert(r.dmg > 1)
  assert.equal(W.floorBelow(590.5, 126, 565.05, 5)?.top, 124, 'empty space beside the wall cannot become a landing support')
  assert.equal(W.floorBelow(590.5, 126, 565.5, 5)?.top, 125.5)
})

test('raised wall shapes keep their narrow footprint above the cell and follow block updates', () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  let name = 'diorite_wall'
  const bot: any = Object.assign(new EventEmitter(), { blockAt(p: Vec3) {
    const q = p.floored(), b = q.equals(new Vec3(0, 10, 0))
      ? Block.fromProperties(name, name === 'diorite_wall' ? { west: 'low', east: 'low', north: 'none', south: 'none', up: false } : {}, 0)
      : Block.fromStateId(data.blocksByName.air.defaultState, 0)
    b.position = q; return b
  } })
  const W = worldOf(bot)
  assert.equal(W.boxHit(.5, 11.1, -.1, .6), false, 'the empty strip beside the raised shape remains empty')
  assert.equal(W.boxHit(.5, 11.1, .5, .6), true, 'the upper half of the wall still blocks flight')
  name = 'air'; bot.emit('blockUpdate', null, { position: new Vec3(0, 10, 0) })
  assert.equal(W.boxHit(.5, 11.1, .5, .6), false, 'a destroyed wall cannot leave its old raised shape')
  name = 'diorite_wall'; W.clear()
  assert.equal(W.boxHit(.5, 11.1, .5, .6), true)
})

// Entity.collideWithShapes / Direction.axisStepOrder, 1.21.11: Y, then the longer horizontal axis.
function corner(x: number, z: number) {
  return worldOf(Object.assign(new EventEmitter(), {
    blockAt(p: Vec3) {
      const solid = Math.floor(p.x) === x && Math.floor(p.y) === 10 && Math.floor(p.z) === z
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: [] }
    }
  }))
}
for (const swap of [false, true]) test(`flight sees the corner hit along ${swap ? 'Z' : 'X'} before the shorter horizontal move`, () => {
  const v = swap ? { x: 1.7, y: 0, z: 2.4 } : { x: 2.4, y: 0, z: 1.7 }
  const W = swap ? corner(0, 2) : corner(2, 0)
  const r = rollout(W, { x: .5, y: 10, z: .5 }, v, Math.atan2(-v.x, -v.z), 0, 0, 1)
  assert.equal(r.kind, 'wall', 'the straight diagonal clears this block, but the real axis path hits it')
  assert.equal(r.t, 0)
  assert(r.dmg > 1)
})
test('flight does not test the shorter axis at the old position after the longer axis moved clear', () => {
  const v = { x: 2.4, y: 0, z: 1.7 }
  const r = rollout(corner(0, 2), { x: .5, y: 10, z: .5 }, v, Math.atan2(-v.x, -v.z), 0, 0, 1)
  assert.equal(r.kind, null)
})

for (const axis of ['x', 'z']) for (const wall of [false, true]) for (const direction of [-1, 1]) for (const ticks of [1, 6]) test(`ceiling contact preserves the remaining horizontal move (${axis}, ${wall ? 'wall' : 'clear'}, ${direction}, ${ticks}t)`, () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  const { Physics, PlayerState } = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), solid = q.y === 3 || wall && q[axis] === direction * (ticks === 1 ? 2 : 5) && q.y < 3
    const b = Block.fromStateId((solid ? data.blocksByName.stone : data.blocksByName.air).defaultState, 0)
    b.position = q; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry: data, blockAt: world.getBlock,
    entity: { position: new Vec3(axis === 'x' ? .5 + direction * .7 : .5, 2.1, axis === 'z' ? .5 + direction * .7 : .5),
      velocity: new Vec3(axis === 'x' ? direction * 1.2 : 0, .5, axis === 'z' ? direction * 1.2 : 0),
      effects: {}, attributes: {}, onGround: false, elytraFlying: true, yaw: axis === 'x' ? -direction * Math.PI / 2 : direction > 0 ? Math.PI : 0, pitch: .2 },
    inventory: { slots: { 6: { name: 'elytra' } } }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0
  })
  const physics = Physics(data, world), state = new PlayerState(bot, {})
  let vertical = false, horizontal = false
  for (let tick = 0; tick < ticks; tick++) {
    physics.simulatePlayer(state, world)
    vertical ||= state.isCollidedVertically; horizontal ||= state.isCollidedHorizontally
  }
  assert.equal(state.ndPoseHeight, .6)
  assert.equal(vertical, true)
  assert.equal(horizontal, wall)
  const W = worldOf(bot), r = rollout(W, bot.entity.position, bot.entity.velocity, state.yaw, state.pitch, 0, ticks, { keepPath: true })
  assert.equal(r.kind, wall ? 'wall' : 'ceil', 'the ceiling does not absorb horizontal momentum')
  if (wall) { assert(r.dmg > 1); assert(ticks === 1 || r.t > 0, 'the later wall remains inside the forecast horizon') }
  else {
    if (ticks === 1) {
      assert(Math.abs(r.p[axis] - state.pos[axis]) < 1e-6, 'clear horizontal motion still completes this tick')
      assert(Math.abs(r.p.y - state.pos.y) < 1e-6, 'clip to the free side of the ceiling')
    }
    assert.equal(r.t, 0, 'retain the first ceiling contact when the remaining horizon is clear')
    assert.equal(r.path.length, 0, 'later forecast steps do not mutate the first-contact path')
    assert.equal(r.v.y, 0)
    assert.equal(W.boxHit(r.p.x, r.p.y, r.p.z, .6), false)
  }
})

for (const y of [2.1, 2.4]) test(`ceiling movement fall uses accepted rise at Y${y}`, () => {
  const W = worldOf(Object.assign(new EventEmitter(), { blockAt(p: Vec3) {
    const solid = Math.floor(p.y) === 3
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: [] }
  } }))
  const r = rollout(W, { x: .5, y, z: .5 }, { x: 1.2, y: .5, z: 0 }, -Math.PI / 2, .2, 0, 1, { fd: 9, movementFall: true })
  assert.equal(r.kind, 'ceil')
  assert.equal(r.fd, y < 2.4 ? 0 : 9, 'a completely blocked rise cannot reset movement fall')
})

test('an already overlapping ceiling cannot move the forecast down to manufacture free space', () => {
  const W = worldOf(Object.assign(new EventEmitter(), { blockAt(p: Vec3) {
    const solid = Math.floor(p.y) === 3
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: [] }
  } }))
  const r = rollout(W, { x: .5, y: 2.6, z: .5 }, { x: 1.2, y: .5, z: 0 }, -Math.PI / 2, .2, 0, 1)
  assert.equal(r.kind, 'ceil')
  assert(r.p.y >= 2.6)
  assert.equal(r.p.x, .5)
})
