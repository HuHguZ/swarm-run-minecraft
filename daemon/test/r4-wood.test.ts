'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import route = require('../src/route')
const info = { spawn: { x: 0, z: 0 }, sky: { x: 40, y: 64, z: 0, src: 20 }, outposts: [], ores: { trees: [] } }
test('wood plan uses mapped small grove above 25-block band', () => {
  const i = { ...info, ores: { trees: [{ x: 70, y: 107, z: 0, n: 4 }] } }
  const w = route.plan(i, { fromY: 64 }).steps.find(s => s.kind === 'wood')
  assert.equal(w.at?.x, 70)
})
test('mapped building planks take precedence and outpost wood is excluded', () => {
  const i = { ...info, outposts: [{ x: 0, z: 30, r: 20 }], ores: { trees: [{ x: 12, y: 67, z: 0, n: 8 }], wood: [
    { x: 0, y: 65, z: 30, n: 40, in: 'pillager_outpost', stand: { x: 1, y: 64, z: 30 } },
    { x: 90, y: 65, z: 0, n: 12, in: 'village', stand: { x: 91, y: 64, z: 0 } }] } }
  const w = route.plan(i, { fromY: 64 }).steps.find(s => s.kind === 'wood')
  assert.equal(w.at?.x, 91)
  assert.equal(w.src, 'mapwood')
})
