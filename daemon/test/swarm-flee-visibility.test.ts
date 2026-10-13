import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const { hostilesAround } = require('../src/flee')

test('panic flee cannot track a requested player through a wall or unloaded blocks', () => {
  let wall = true
  const enemy = { id: 2, name: 'player', username: 'Foe', position: new Vec3(2.5, 64, 0.5), type: 'player' }
  const bot = { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: { 2: enemy }, blockAt(p) {
    return wall && p.x === 1 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty' }
  } }
  assert.equal(hostilesAround(bot, 64, [2]).length, 0)
  wall = false
  assert.equal(hostilesAround(bot, 64, [2]).length, 1)
  bot.blockAt = () => null
  assert.equal(hostilesAround(bot, 64, [2]).length, 0)
})

test('escape rays stop at the arena boundary while retaining a usable shorter route', () => {
  const { runLength, pickDirection } = require('../src/flee')
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, blockAt(p) {
    const solid = p.y === 63
    return { position: p.floored(), name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  } }
  const arena = { x: .5, z: .5, r: 6, killY: 60 }
  const run = runLength(bot, { x: 1, z: 0 }, 10, 3, arena)
  assert.equal(run.len, 5)
  assert.equal(run.end.x, 5.5)
  const plan = pickDirection(bot, [], null, [{ x: 100, z: 0 }], arena)
  assert.ok(plan && plan.run >= 2, 'a bounded five-block route is not a physical corner')
  assert.ok(Math.abs(plan.end.x - .5) + .3 <= 6 && Math.abs(plan.end.z - .5) + .3 <= 6)
  assert.equal(runLength(bot, { x: 1, z: 0 }, 10, 3, { ...arena, killY: 64 }).len, 0)
})
