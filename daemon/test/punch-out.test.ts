import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'

test('Punch arrow: hurt knockback 0.4 then the Punch push 0.6/level along the flight, both scaled by resistance', () => {
  const { punchVelocity } = require('../src/combat/punch-out')
  const v = punchVelocity(new Vec3(0, 0, 0), true, { x: 1, z: 0 }, 2, 0)
  assert.ok(Math.abs(v.x - 1.6) < 1e-9 && Math.abs(v.z) < 1e-9, JSON.stringify(v))
  assert.ok(Math.abs(v.y - .5) < 1e-9, 'on ground: 0.4 hop + 0.1 push')
  const nether = punchVelocity(new Vec3(0, 0, 0), false, { x: 1, z: 0 }, 2, .4)
  assert.ok(Math.abs(nether.x - 1.6 * .6) < 1e-9 && Math.abs(nether.y - .1) < 1e-9, 'airborne, full netherite: ×0.6, no hop')
})
