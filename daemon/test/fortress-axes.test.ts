import test from 'node:test'
import assert from 'node:assert/strict'
import { axisScoreOf } from '../src/fortress/sweep'

// ND_BLZ_AXES: портал у угла четырёх регионов (432) — луч оси между двумя регионами; регион увиденного бастиона снимается.
test('axes: an axis ray scores the regions on both sides; a bastion region drops out', () => {
  const origin = { x: 43, z: -38 } // 5730: портал в регионе (0,-1), у угла 0,0
  const E = { R: 128, ax: 1, az: 0 }, W = { R: 128, ax: -1, az: 0 }, S = { R: 128, ax: 0, az: 1 }, N = { R: 128, ax: 0, az: -1 }
  for (const p of [E, W, S, N]) assert.equal(axisScoreOf(p, origin, []), 2)
  const bastionSE = [[0, 0]] // бастион 39,38
  assert.equal(axisScoreOf(E, origin, bastionSE), 1)
  assert.equal(axisScoreOf(S, origin, bastionSE), 1)
  assert.equal(axisScoreOf(W, origin, bastionSE), 2)
  assert.equal(axisScoreOf(N, origin, bastionSE), 2)
})

// ND_BLZ_OPEN_LEGS: отрезок — по самому длинному чистому лучу у направления прямой; в сплошной толще — null (прямо, как прежде).
test('open legs: a visible corridor along the line becomes the leg target; solid rock gives none', () => {
  const { openLeg } = require('../src/fortress/sweep')
  const { Vec3 } = require('vec3')
  const corridor = (p: any) => p.y >= 64 && p.y <= 65 && p.z === 0 && p.x >= 0 && p.x <= 30
  const mk = (open: (p: any) => boolean) => ({ entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, eyeHeight: 1.62 },
    blockAt: (p: any) => { const q = p.floored(); const air = open(q); return { name: air ? 'air' : 'netherrack', position: q, boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]] } } })
  const leg = openLeg(mk(corridor), 1, 0)
  assert.ok(leg, 'corridor found')
  assert.equal(leg.off, 0)
  assert.ok(leg.x >= 15 && Math.abs(leg.z) <= 1, `along the corridor: ${JSON.stringify(leg)}`)
  assert.equal(openLeg(mk(() => false), 1, 0), null)
})
