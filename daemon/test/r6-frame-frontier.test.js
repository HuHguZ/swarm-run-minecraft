'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const nether = require('../src/nether')

function fixture ({ outside = false, fluid = false, unchanged = false } = {}) {
  const front = new Vec3(0, 64, 0); const back = new Vec3(0, 65, 1)
  const blocks = new Map(); const digs = []
  const put = (p, name) => blocks.set(p.toString(), { name, type: 1, position: p, hardness: .4,
    boundingBox: name === 'air' || name === 'lava' ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
  put(front, 'netherrack'); put(back, fluid ? 'lava' : 'netherrack')
  const bot = { entity: { position: new Vec3(.5, 64, -.5) }, inventory: { items: () => [] }, entities: {},
    blockAt: p => blocks.get(p.toString()), world: { raycast: (eye, dir) => {
      const b = blocks.get(back.toString()); const a = blocks.get(front.toString())
      // The upper/far target is hidden by the nearer cell until that cell is removed.
      return dir.y > -.3 ? (a.name === 'air' ? b : a) : a
    } },
    dig: async b => { assert.equal(blocks.get(front.toString()).name === 'air' || b.position.equals(front), true, 'never dig behind an opaque block'); digs.push([b.position.x, b.position.y, b.position.z]); if (!unchanged) put(b.position, 'air') } }
  return { session: { bot, mcData: { blocks: { 1: { harvestTools: { 2: true } } }, items: { 2: { name: 'stone_pickaxe' } } } },
    ctl: { aborted: false, onAbort: [] }, cells: outside ? [back] : [back, front], digs, front, back }
}
test('col04e N2bx23: a hidden upper cell waits while a visible frame cell exposes it', async () => {
  const f = fixture(); const r = await nether.clearCells(f.session, f.ctl, f.cells)
  assert.equal(r.stopped, undefined); assert.equal(r.dug, 2)
  assert.deepEqual(f.digs, [[0, 64, 0], [0, 65, 1]])
})
test('an occluding block outside the approved clear list is never removed', async () => {
  const f = fixture({ outside: true }); const r = await nether.clearCells(f.session, f.ctl, f.cells)
  assert.match(r.stopped, /прицел/); assert.equal(r.dug, 0); assert.deepEqual(f.digs, [])
})
test('a fluid in the planned frame still refuses clearing', async () => {
  const f = fixture({ fluid: true }); const r = await nether.clearCells(f.session, f.ctl, f.cells)
  assert.match(r.stopped, /lava/); assert.equal(r.dug, 0)
})
test('a missing block update cannot be counted as a cleared frame', async () => {
  const f = fixture({ unchanged: true }); const r = await nether.clearCells(f.session, f.ctl, f.cells)
  assert.match(r.stopped, /остался/); assert.equal(r.dug, 1); assert.equal(f.digs.length, 1)
})
test('ND_FRAME_FRONTIER=0 retains the original hidden-cell refusal', async t => {
  const before = process.env.ND_FRAME_FRONTIER; process.env.ND_FRAME_FRONTIER = '0'
  t.after(() => { if (before === undefined) delete process.env.ND_FRAME_FRONTIER; else process.env.ND_FRAME_FRONTIER = before })
  const f = fixture(); const r = await nether.clearCells(f.session, f.ctl, f.cells)
  assert.match(r.stopped, /прицел/); assert.equal(r.dug, 0)
})
test('cancellation leaves every planned block untouched', async () => {
  const f = fixture(); f.ctl.aborted = true
  assert.match((await nether.clearCells(f.session, f.ctl, f.cells)).stopped, /прервано/)
  assert.deepEqual(f.digs, [])
})
