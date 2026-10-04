'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const route = require('../src/route')
test('path forbids entering outpost and permits outward escape', () => {
  assert.equal(typeof route.outpostStepCost, 'function')
  const info = { outposts: [{ x: 0, z: 0, r: 72 }] }
  assert.equal(route.outpostStepCost(info, { x: 120, z: 0 }, { x: 60, z: 0 }), Infinity)
  assert.equal(route.outpostStepCost(info, { x: 50, z: 0 }, { x: 51, z: 0 }), 0)
  assert.equal(route.outpostStepCost(info, { x: 50, z: 0 }, { x: 49, z: 0 }), Infinity)
})
