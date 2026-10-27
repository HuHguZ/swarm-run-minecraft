import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createPostSmashObserver } from './swarm/swarm-driver/combo-wind-observation'

const r = Math.fround(.98), q = 1 / 4096
const tracked = { x: .125, y: 999, z: -.25, ageTicks: .2 }
const receipt = (y: number, t: number, kind = 'rel_entity_move') => ({ x: 600.5, y, z: 597.5, t, kind })
// Forward native movement is the test oracle; no inverse/count-fitting implementation is copied here.
function arc(initialVy: number, intervals: number[]) {
  let y = 160, vy = initialVy
  const points = [{ y: Math.floor(y / q) * q, vy }]
  for (const count of intervals) {
    for (let i = 0; i < count; i++) { y += vy; vy = (vy - .08) * r }
    points.push({ y: Math.floor(y / q) * q, vy })
  }
  return points
}
const watermark = receipt(900, 10)

test('three fresh post-cue positions fit variable whole-tick intervals and preserve tracked XZ/age without using receipt time as tick count', () => {
  for (const [vy, n1, n2] of [[-.6, 2, 3], [-1.1, 4, 2], [.01, 2, 2]]) {
    const observe = createPostSmashObserver(watermark), points = arc(vy, [n1, n2])
    assert.equal(observe(watermark, tracked).fit.sampleCount, 0, 'cue baseline is a watermark, never a fit sample')
    assert.equal(observe(receipt(points[0].y, 1000), tracked).confidence, false)
    assert.equal(observe(receipt(points[1].y, 1000.001), tracked).confidence, false)
    const result = observe(receipt(points[2].y, 1000.002), tracked)
    assert.equal(result.confidence, true); assert.equal(result.fit.sampleCount, 3); assert.equal(result.fit.intervalTicks, n2)
    const sum = (1 - r ** n2) / (1 - r), quantumBound = q * r ** n2 / sum
    assert.ok(Math.abs(result.velocity.y - points[2].vy) <= quantumBound + 1e-12)
    assert.equal(result.velocity.x, tracked.x); assert.equal(result.velocity.z, tracked.z); assert.equal(result.velocity.ageTicks, tracked.ageTicks)
  }
})

test('a mixed impulse/reset interval stays unknown, then a wholly post-reset arc recovers even across an absolute sync', () => {
  const observe = createPostSmashObserver(watermark)
  for (const [i, y] of [160, 158, 158.01].entries()) {
    const result = observe(receipt(y, 20 + i), tracked)
    assert.equal(result.confidence, false); assert.equal(result.velocity, null)
  }
  const clean = arc(-.6, [2, 3])
  let result: any
  for (const [i, p] of clean.entries()) result = observe(receipt(p.y, 30 + i, i === 1 ? 'sync_entity_position' : 'rel_entity_move'), tracked)
  assert.equal(result.confidence, true); assert.equal(result.fit.intervalTicks, 3)
})

test('duplicate polling cannot fabricate three samples; stale or nonfinite inputs never fall back to tracked Y', () => {
  const observe = createPostSmashObserver(watermark), points = arc(-.6, [2, 3, 2])
  const first = receipt(points[0].y, 20)
  for (let i = 0; i < 5; i++) { const result = observe({ ...first }, tracked); assert.equal(result.confidence, false); assert.equal(result.fit.sampleCount, 1) }
  observe(receipt(points[1].y, 21), tracked)
  const third = receipt(points[2].y, 22), valid = observe(third, { ...tracked, y: NaN })
  assert.equal(valid.confidence, true, 'the replaced tracker Y is not a fit input'); assert.ok(Number.isFinite(valid.velocity.y))
  const replay = observe(first, tracked)
  assert.equal(replay.confidence, false, 'an older receipt cannot reuse the newest arc endpoint'); assert.equal(replay.velocity, null)
  const stale = observe(third, { ...tracked, ageTicks: 2 })
  assert.equal(stale.confidence, false); assert.equal(stale.velocity, null)
  assert.equal(observe(receipt(points[3].y, 23), tracked).confidence, true, 'a stale poll between packets must not erase fresh receipt history')
  for (const bad of [{ ...tracked, x: Infinity }, { ...tracked, z: NaN }, { ...tracked, ageTicks: NaN }, { ...tracked, ageTicks: -1 }]) {
    const result = observe(receipt(points[3].y, 23), bad); assert.equal(result.confidence, false); assert.equal(result.velocity, null)
  }
  for (const bad of [null, { ...third, y: NaN }, { ...third, x: Infinity }, { ...third, t: NaN }]) {
    const result = observe(bad, tracked); assert.equal(result.confidence, false); assert.equal(result.velocity, null)
  }
})
