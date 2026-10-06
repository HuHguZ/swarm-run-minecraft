'use strict'
// ARENA_TERRAIN=1 (D1, 2026-10-06): случайный рельеф отдельным модулем —
// повторяем по seed, точки появления и полоса между ними свободны.
const test = require('node:test')
const assert = require('node:assert/strict')
const tr = require('../arena-terrain-random')

async function build (seed) {
  const cmds = []
  const feats = await tr.buildTerrain(async c => { cmds.push(c) }, { X: 0, Y: 100, Z: 0, R: 15, seed, avoid: [[-6, 0], [6, 0]] })
  return { cmds, feats }
}

test('рельеф: тот же seed — те же команды, другой — другие; старты свободны', async () => {
  const a = await build(42)
  const b = await build(42)
  const c = await build(43)
  assert.deepEqual(a.cmds, b.cmds)
  assert.notDeepEqual(a.cmds, c.cmds)
  assert.ok(a.feats.length >= 6, `особенностей ${a.feats.length}`)
  for (const f of a.feats) {
    const [x1, z1, x2, z2] = f.at
    for (const [sx, sz] of [[-6, 0], [6, 0]]) assert.ok(!(sx > x1 - 4 && sx < x2 + 4 && sz > z1 - 4 && sz < z2 + 4), `${f.kind} у старта`)
    assert.ok(!(x2 >= -6 && x1 <= 6 && z2 >= -1 && z1 <= 1), `${f.kind} на полосе между стартами`)
  }
  const fills = []
  await tr.clearTerrain(async () => {}, async (...a) => { fills.push(a) }, { X: 0, Y: 100, Z: 0, R: 15, top: 115 })
  assert.equal(fills.length, 3)
  assert.equal(fills[2][4], 115, 'воздух до верха коробки')
})
