'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { mappedRoom, roomApproach } from '../src/stronghold'

test('B4-31: recover exact room and height from the existing map note', () => {
  const rec = { dimension: 'overworld', note: 'карта (копия мира): крепость Края, комната портала -888,-7,-1413..-878,0,-1398; рамок 12, с оком 1' }
  const r = mappedRoom(rec)
  assert.deepEqual(r.centre, { x: -883, y: -4, z: -1405 })
  const p = roomApproach(r, { x: -900, y: 70, z: -1410 })
  assert.equal(p.target.y, -3)
  assert.equal(p.shaft.x, -890)
  assert.equal(p.target.x, -887)
  assert.notEqual(p.target.x, r.centre.x, 'approach the side walkway, not the lava under the portal')
})
test('structured room data and rotated bounding box', () => {
  const r = mappedRoom({ dimension: 'overworld', room: { bb: [10, 20, 30, 25, 27, 40] } })
  const p = roomApproach(r, { x: 17, z: 60 })
  assert.equal(p.shaft.z, 42)
  assert.equal(p.target.z, 39)
  assert.equal(p.target.y, 24)
})
test('reject invalid, inverted, out of world and foreign room maps', () => {
  for (const rec of [null, { room: { x: 1, z: 2 } }, { dimension: 'the_nether', room: { x: 1, y: 20, z: 2 } },
    { room: { bb: [0, 0, 0, -1, 7, 15] } }, { room: { x: 1, y: -100, z: 2 } }]) assert.equal(mappedRoom(rec), null)
})
