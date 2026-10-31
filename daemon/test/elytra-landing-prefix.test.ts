import test from 'node:test'
import assert from 'node:assert/strict'
import * as physics from '../src/elytra/physics'
import { landingPlan } from '../src/elytra/landing'

test('landing flare alternatives share their unchanged initial dive forecasts', t => {
  const W = { boxHit: (_x, y) => y < 120, floorBelow: () => ({ top: 120 }) }
  const st = { p: { x: 600, y: 126, z: 600 }, v: { x: 1.2, y: .196, z: 0 },
    fd: .137, boost: 0, boostMin: 0, boostMax: 0 }
  const original = physics.rollout
  let initialDives = 0
  t.mock.method(physics, 'rollout', (...args: Parameters<typeof physics.rollout>) => {
    if (args[1] === st.p && args[2] === st.v && args[4] === -1.3) initialDives++
    return original(...args)
  })
  const plan = landingPlan(W, st, { at: { x: 644.5, y: 120, z: 607.5 } }, r =>
    ({ c: Math.hypot(r.p.x - 644.5, r.p.z - 607.5), safe: true }))
  assert(plan && plan.r.kind === 'floor' && plan.r.fd <= 3)
  assert.equal(initialDives, 7, 'four flares must share one initial dive per curve')
  assert.equal(plan.work, 32769, 'reuse must preserve the existing search budget and candidate order')
  assert(Math.abs(plan.c - 14.250240997303193) < 1e-9, 'the complete landing price must stay unchanged')
})
