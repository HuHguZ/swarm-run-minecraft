import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const { axisLeg } = require('../src/fortress')

test('on a fortress bridge the tour walks along the bridge, away from earlier stops', () => {
  const bridge = [-6, -3, 0, 3, 6].map(x => new Vec3(x, 73, 0))
  const feet = new Vec3(0, 74, 0)
  assert.deepEqual(axisLeg(bridge, feet, []), { x: 24, z: 0, axis: 'x' })
  assert.deepEqual(axisLeg(bridge, feet, [new Vec3(20, 74, 0), new Vec3(0, 74, 0)]), { x: -24, z: 0, axis: 'x' })
  const zBridge = bridge.map(p => new Vec3(p.z, 73, p.x))
  assert.equal(axisLeg(zBridge, feet, []).axis, 'z')
  assert.equal(axisLeg(bridge, feet, [new Vec3(24, 74, 0), new Vec3(-24, 74, 0)]), null)
  assert.equal(axisLeg(bridge.slice(0, 2), feet, []), null)
})
