import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { getPhysics } from '../src/tick-plugins'

const upstream = require('prismarine-physics')
const AABB = require('prismarine-physics/lib/aabb')
const HALF = Math.fround(.6) / 2
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
const faces = [
  { name: 'west roof X600', p: [600.3177401388041, 161.3245157168153, 600.4445660300697], v: [-.1, .09333777878053491, .1709669194431], wall: [599, 161, 600], axis: 'x', edge: 600, sign: 1 },
  { name: 'east X601', p: [600.6822598611959, 161.3245157168153, 600.4445660300697], v: [.1, .09333777878053491, .1709669194431], wall: [601, 161, 600], axis: 'x', edge: 601, sign: -1 },
  { name: 'north ground Z620', p: [581.8661398069296, 120, 620.3947802174927], v: [0, -.0784000015258789, -.2], wall: [582, 120, 619], axis: 'z', edge: 620, sign: 1 },
  { name: 'south Z621', p: [581.8661398069296, 120, 620.6052197825073], v: [0, -.0784000015258789, .2], wall: [582, 120, 621], axis: 'z', edge: 621, sign: -1 }
]

function fixture(engine, c, version = '1.21.11') {
  const registry = require('prismarine-registry')(version), Block = require('prismarine-block')(registry)
  const world = { getBlock(p) {
    const pos = p.floored(), wall = c.wall && c.wall.every((n, i) => n === [pos.x, pos.y, pos.z][i])
    const name = wall ? 'oak_planks' : pos.y === 119 ? 'sand' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = pos; return b
  } }
  const bot = { version, registry, inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: new Vec3(c.p[0], c.p[1], c.p[2]), velocity: new Vec3(c.v[0], c.v[1], c.v[2]), onGround: c.p[1] === 120,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
      elytraFlying: false, effects: {}, attributes: {}, yaw: 0, pitch: 0 } }
  const physics = engine.Physics(registry, world), state = new engine.PlayerState(bot, { ...IDLE })
  return { physics, state, world, step() { physics.simulatePlayer(state, world); return state } }
}

function nativeBox(p) {
  return new AABB(p.x - HALF, p.y, p.z - HALF, p.x + HALF, p.y + Math.fround(1.8), p.z + HALF)
}
function cube(c) { const [x, y, z] = c.wall; return new AABB(x, y, z, x + 1, y + 1, z + 1) }

// Exact Paper 1.21.11 path: hasNewCollision gathers the UNDEFLATED end box.
// Shapes.block() uses raw AABB.intersects; the old box is checked with epsilon.
// These old boxes are wholly outside, so both raw and epsilon old checks are false.
test('upstream .3 clamp reproduces the native full-cube endpoint rejection on all four faces', () => {
  for (const c of faces) {
    const f = fixture(upstream, c), old = nativeBox(f.state.pos), block = cube(c)
    assert.equal(old.intersects(block), false, c.name)
    f.step()
    assert.equal(nativeBox(f.state.pos).intersects(block), true, c.name)
  }
})

for (const c of faces) test(`1.21.11 physical width clears Paper's full-cube end check: ${c.name}`, () => {
  const f = fixture(getPhysics(), c), old = nativeBox(f.state.pos), block = cube(c)
  assert.equal(old.intersects(block), false)
  f.step()
  assert.equal(nativeBox(f.state.pos).intersects(block), false, 'native body must not penetrate the contacted full cube')
  assert.equal(f.state.pos[c.axis], c.edge + c.sign * HALF)
  assert.equal(f.state.isCollidedHorizontally, true)
})

test('older Minecraft retains upstream width and collision outputs', () => {
  for (const c of faces) {
    const actual = fixture(getPhysics(), c, '1.20.4'), expected = fixture(upstream, c, '1.20.4')
    assert.equal(actual.physics.playerHalfWidth, .3)
    actual.step(); expected.step()
    assert.deepEqual(actual.state.pos, expected.state.pos)
    assert.deepEqual(actual.state.vel, expected.state.vel)
    assert.equal(actual.state.onGround, expected.state.onGround)
  }
})

test('1.21.11 non-contact trajectories and the native step height remain unchanged', () => {
  for (const p of [[600.5, 120, 620.5], [600.5, 150, 620.5]]) {
    const c = { p, v: [.2, .4, .1] }, actual = fixture(getPhysics(), c), expected = fixture(upstream, c)
    assert.equal(actual.physics.stepHeight, expected.physics.stepHeight)
    for (let i = 0; i < 20; i++) {
      actual.step(); expected.step()
      assert.deepEqual(actual.state.pos, expected.state.pos)
      assert.deepEqual(actual.state.vel, expected.state.vel)
      assert.equal(actual.state.onGround, expected.state.onGround)
    }
  }
})
