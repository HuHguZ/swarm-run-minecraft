'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const scan = require('../../farm/route-scan/scan')
test('offline scanner records reachable planks in buildings and their actual stand', () => {
  assert.equal(typeof scan.woodGroups, 'function')
  const cells = Array.from({ length: 12 }, (_, i) => ({ x: 80 + (i % 3), y: 65 + Math.floor(i / 3), z: 0, name: 'oak_planks', stand: { x: 79, y: 64, z: 0 } }))
  const out = scan.woodGroups(cells, [{ name: 'village', bb: [70, 60, -8, 100, 80, 8] }], { x: 0, z: 0 })
  assert.equal(out[0].in, 'village'); assert.equal(out[0].planks, 12); assert.equal(out[0].stand.x, 79)
  assert.equal(scan.codeOf({ Name: 'minecraft:grass_block' }), scan.C.OTHER)
})
