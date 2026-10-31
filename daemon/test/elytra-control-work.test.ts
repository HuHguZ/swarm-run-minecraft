import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, cost } from '../src/elytra/control'
import { rollout } from '../src/elytra/physics'
import * as physics from '../src/elytra/physics'
import { landingPlan } from '../src/elytra/landing'

test('a recoverable landing dive does not run its identical collision forecast twice', t => {
  const inputs: string[] = []
  const original = physics.rollout
  t.mock.method(physics, 'rollout', (...args: Parameters<typeof physics.rollout>) => {
    if (inputs.length < 2) inputs.push(JSON.stringify(args.slice(1)))
    return original(...args)
  })
  const W = { boxHit: (_x, y) => y < 0, floorBelow: () => ({ top: 0 }) }
  const plan = landingPlan(W, { p: { x: 0, y: 22, z: 0 }, v: { x: 1.2, y: 0, z: 0 }, fd: 1, boost: 0 },
    { at: { x: 5.5, y: 0, z: 5.5 } }, () => ({ c: 0, safe: true }))
  assert(plan, 'the complete supported landing remains available')
  assert.equal(inputs.length, 2)
  assert.notEqual(inputs[0], inputs[1], 'reuse the accepted trial instead of repeating its world collision checks')
})

test('a losing nominal landing does not recheck rocket expiry bounds after a certified winner', t => {
  const W = { boxHit: (_x, y) => y < 0, floorBelow: () => ({ top: 0 }) }
  const st = { p: { x: 0, y: 6, z: 0 }, v: { x: .5, y: 0, z: 0 }, fd: 1,
    boost: 1, boostMin: 0, boostMax: 2 }
  const original = physics.rollout
  let initialBoost = null; let latestExpiryQuotes = 0
  t.mock.method(physics, 'rollout', (...args: Parameters<typeof physics.rollout>) => {
    if (args[1] === st.p && args[2] === st.v) initialBoost = args[5]
    return original(...args)
  })
  const plan = landingPlan(W, st, { at: { x: 5.5, y: 0, z: 5.5 }, maxFallDamage: 10 }, () => {
    if (initialBoost === st.boostMax) latestExpiryQuotes++
    return { c: 0, safe: true }
  })
  assert(plan, 'the first winner must still pass the early and late expiry checks')
  assert.equal(plan.c, 0, 'no later candidate can beat the already certified zero price')
  assert.equal(latestExpiryQuotes, 1, 'later tied or worse nominal prices cannot improve the max of the expiry prices')
})

for (const rocketNow of [false, true]) test(`point search measures the needed clearance, then returns the complete winning rollout: rocket=${rocketNow}`, () => {
  const depths: number[] = []
  const W = { boxHit: () => false, floorBelow: (_x, y, _z, depth) => {
    depths.push(depth)
    return Math.floor(y) - depth <= 0 ? { top: 1 } : null
  } }
  const st = { p: { x: 0, y: 64, z: 0 }, v: { x: .2, y: 0, z: -.3 }, boost: 0, fd: 0 }
  const goal = { kind: 'point', at: { x: 0, y: 68, z: -20 }, gap: 3 }
  const plan = choose(W, st, goal, { rocketNow })
  assert(plan)
  assert(depths.some(d => d === 4), 'candidate floor searches need only the requested gap plus the protruding support row')
  assert.equal(depths.filter(d => d === 12).length, 4, 'only the selected 18-tick rollout needs the complete clearance metric')
  const full = rollout(W, st.p, st.v, plan.yaw, plan.pitch, rocketNow ? 26 : 0, 18, { fd: st.fd })
  assert.deepEqual(plan.r, full)
  assert.equal(plan.c, cost(W, st, goal, () => goal.at, full, plan.yaw, plan.pitch))
})

for (const obstacle of ['open', 'wall', 'ceiling', 'floor']) for (const rocketNow of [false, true]) {
  test(`a static point prunes losing geometry checks without changing the full moving-point result: ${obstacle}, rocket=${rocketNow}`, () => {
    let checks = 0
    const W = { boxHit: (x, y, z) => {
      checks++
      return obstacle === 'wall' && x > 2 && x < 4 || obstacle === 'ceiling' && y > 69 || obstacle === 'floor' && y < 61
    }, floorBelow: () => null }
    const st = { p: { x: 0, y: 64, z: 0 }, v: { x: .2, y: 0, z: -.3 }, boost: 0, fd: 0 }
    const goal = { kind: 'point', at: { x: 3, y: 68, z: -20 }, gap: 3,
      arena: { x: 0, y: 60, z: 0, r: 35, killY: 40 } }
    const full = choose(W, st, { ...goal, at: () => goal.at }, { rocketNow })
    const fullChecks = checks; checks = 0
    const pruned = choose(W, st, goal, { rocketNow })
    assert.deepEqual(pruned, full)
    assert(checks < fullChecks, 'only candidates with a provably losing distance bound skip the unchanged physical checks')
  })
}

test('a tall support below the extra row keeps its clearance penalty', () => {
  const W = { boxHit: () => false, floorBelow: (_x, y, _z, depth) => Math.floor(y) - depth <= 95 ? { top: 96.5 } : null }
  const st = { p: { x: 0, y: 99.5, z: 0 }, v: { x: .1, y: 0, z: 0 }, fd: 0 }
  const goal = { kind: 'point', at: { x: 2, y: 99.5, z: 0 }, gap: 3 }
  const full = rollout(W, st.p, st.v, 0, 0, 0, 4)
  const shallow = rollout(W, st.p, st.v, 0, 0, 0, 4, { floorDepth: 4 })
  assert(full.minFloorGap < goal.gap, 'a 1.5-block support in row 95 is within the three-block clearance')
  assert.deepEqual(shallow, full)
  assert.equal(cost(W, st, goal, () => goal.at, shallow, 0, 0), cost(W, st, goal, () => goal.at, full, 0, 0))
})

for (const H of [18, 36]) test(`reach pricing and a longer-horizon fallback retain the complete moving-point plan: H=${H}`, () => {
  const W = { boxHit: (_x, y) => y > 69 || y < 60, floorBelow: () => null }
  const st = { p: { x: 0, y: 64, z: 0 }, v: { x: .2, y: 0, z: -.3 }, boost: 0, fd: 0 }
  const goal = { kind: 'point', at: { x: 3, y: 68, z: -20 }, gap: 3, reach: true }
  assert.deepEqual(choose(W, st, goal, { H }), choose(W, st, { ...goal, at: () => goal.at }, { H }))
})
