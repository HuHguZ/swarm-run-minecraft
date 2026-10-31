import test from 'node:test'
import assert from 'node:assert/strict'
import { landingPlan } from '../src/elytra/landing'
const physics: typeof import('../src/elytra/physics') = require('../src/elytra/physics')

for (const safe of [true, false]) for (const upper of [0, 1]) {
  test(`a newly traced landing reuses its nominal collision path: safe=${safe}, upper=${upper}`, t => {
    const original = physics.rollout, boosts: number[] = [], quotes: number[] = []
    t.mock.method(physics, 'rollout', (...args: Parameters<typeof physics.rollout>) => {
      boosts.push(args[5]); return original(...args)
    })
    const W = { boxHit: (_x, y) => y < 100, floorBelow: () => ({ top: 100 }) }
    const st = { p: { x: .5, y: 100.01, z: .5 }, v: { x: .2, y: -.2, z: 0 }, fd: 0,
      boost: 0, boostMin: 0, boostMax: upper }
    const goal = { at: { x: 1, y: 100, z: .5 } }
    const plan = landingPlan(W, st, goal, r => {
      if (!quotes.length) assert.equal(boosts.length, 1, 'the first complete path is already collision checked')
      quotes.push(boosts.length)
      assert.equal(r.kind, 'floor')
      assert.equal(r.t, 1)
      return { c: 0, safe }
    })
    assert.equal(!!plan, safe, 'reusing the trace must retain its physical safety refusal')
    if (safe && upper) {
      assert.deepEqual(boosts.slice(0, 2), [0, 1], 'the independent rocket bound still needs its own forecast')
      assert.deepEqual(quotes.slice(0, 2), [1, 2])
    }
  })
}
