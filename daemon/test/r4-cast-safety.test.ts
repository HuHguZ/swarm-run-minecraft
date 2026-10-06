'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { castOne } = require('../src/cast1')
function fixture (bear) {
  return { bot: { entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null }, entities: { 1: bear }, inventory: { items: () => [] },
    pathfinder: { setGoal () {} }, clearControlStates () {} } }
}
test('casting near adult polar bear is refused before construction', async () => {
  const r = await castOne(fixture({ name: 'polar_bear', position: new Vec3(6, 64, 0), metadata: { 16: false } }), { onAbort: [], aborted: false })
  assert.equal(r.code, 'CAST_UNSAFE')
  assert.match(r.stopped, /polar_bear/)
})
test('cub is not a hunting target; casting avoids it conservatively', async () => {
  const r = await castOne(fixture({ name: 'polar_bear', position: new Vec3(6, 64, 0), metadata: { 16: true } }), { onAbort: [], aborted: false })
  assert.equal(r.code, 'CAST_UNSAFE')
})
test('visible crossbow/arrow threat blocks casting', async () => {
  const r = await castOne(fixture({ name: 'pillager', position: new Vec3(12, 64, 0) }), { onAbort: [], aborted: false })
  assert.equal(r.code, 'CAST_UNSAFE')
})
