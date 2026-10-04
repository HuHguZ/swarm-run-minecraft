'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const route = require('../src/route')
const info = {
  spawn: { x: 0, z: 0 }, sky: { x: 40, y: 64, z: 0, src: 20 },
  treasure: { x: 320, z: 0 }, village: null, outposts: [],
  ores: { v: 6, spawn: { x: 0, z: 0 }, half: 512,
    chests: [{ x: 320, y: 64, z: 0, table: 'buried_treasure' }],
    ironBuried: [{ x: 10, y: 58, z: 0, n: 8, depth: 5, top: 63 }] }
}
const opts = { fromY: 64, have: { stone_pickaxe: 1 } }
const sources = p => p.steps.filter(s => ['treasure', 'village', 'ore'].includes(s.kind))
test('far structure exceeds explicit search budget and route uses mapped ore', () => {
  const p = route.plan(info, opts)
  assert.equal(sources(p)[0].kind, 'ore')
  assert.equal(p.structureBudgetSeconds, 180)
})
test('near structure still precedes ore within remaining budget', () => {
  const i = { ...info, treasure: { x: 20, z: 0 }, ores: { ...info.ores,
    chests: [{ x: 20, y: 64, z: 0, table: 'buried_treasure' }] } }
  assert.equal(sources(route.plan(i, opts))[0].kind, 'treasure')
})
test('spent structure time survives replanning and moves to ore', () => {
  const i = { ...info, treasure: { x: 20, z: 0 }, ores: { ...info.ores,
    chests: [{ x: 20, y: 64, z: 0, table: 'buried_treasure' }] } }
  assert.equal(sources(route.plan(i, { ...opts, structureSeconds: 180 }))[0].kind, 'ore')
})
test('existing iron does not schedule another speculative source', () => {
  const p = route.plan(info, { ...opts, have: { stone_pickaxe: 1, iron_ingot: 4 } })
  assert.equal(sources(p).length, 0)
})
test('explicit budget disable preserves the former structure choice', () => {
  const prev = process.env.ND_ROUTE_STRUCTURE_BUDGET
  try {
    process.env.ND_ROUTE_STRUCTURE_BUDGET = '0'
    assert.equal(sources(route.plan(info, opts))[0].kind, 'treasure')
  } finally {
    if (prev === undefined) delete process.env.ND_ROUTE_STRUCTURE_BUDGET
    else process.env.ND_ROUTE_STRUCTURE_BUDGET = prev
  }
})
test('campaign caps the structure RPC and keeps consumed search time on the next plan', async () => {
  const { fixture } = require('./r5-budget-fixture')
  const i = { ...info, treasure: { x: 20, z: 0 }, village: { x: 80, z: 0 }, ores: { ...info.ores,
    chests: [{ x: 20, y: 64, z: 0, table: 'buried_treasure' }], golems: [{ x: 80, y: 64, z: 0 }] } }
  const c = fixture(i); await c.run()
  assert.equal(c.calls.find(x => x.method === 'structure').params.timeoutSeconds, 180)
  assert.deepEqual(c.steps, ['treasure', 'ore'])
  assert.ok(c.logs.some(l => /постройки:.*180/.test(l)))
})
