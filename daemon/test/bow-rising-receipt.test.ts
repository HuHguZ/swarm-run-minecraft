import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { trackTarget, leadTarget } from '../src/bow/track'

function fixture(position = new Vec3(0, 100, 0), at = 1000) {
  const entity: any = Object.assign(new EventEmitter(), { type: 'player', onGround: false, metadata: [], height: 1.8,
    position, _ndObservationNow: () => at })
  entity._ndPositionReceipts = [null, { ...position, t: at, grounded: false, kind: 'sync_entity_position' }]
  const tracker = trackTarget(entity)
  return { entity, tracker, time: () => at, move(position, time) {
    entity.position = position; at = time
    entity._ndPositionReceipts = [entity._ndPositionReceipts[1], { ...position, t: at, grounded: false, kind: 'rel_entity_move' }]
    entity.emit('ndPositionObserved')
  } }
}

// Slot31 native capture 24.10.2026 06:24, target entity26586. These public
// sync/relative positions reconstruct the actual plan.targetAt exactly.
// RCON at the same pose measured Motion.y=.4039393144409666. No HP is used.
for (const times of [[1792812259820, 1792812259908, 1792812259970], [1000, 1001, 1002]]) {
  test(`native rising receipts recover two physics ticks instead of receive jitter (${times[1] - times[0]}ms)`, () => {
    const f = fixture(new Vec3(526.0108893691912, 154.26786701609484, 600.5319086652809), times[0])
    f.move(f.entity.position.offset(-759 / 4096, 2761 / 4096, 71 / 4096), times[1])
    f.move(f.entity.position.offset(-1318 / 4096, 4401 / 4096, 124 / 4096), times[2])
    assert.deepEqual(f.entity.position, new Vec3(525.5038092910662, 156.01640217234484, 600.5795160871559))
    assert.ok(Math.abs(f.tracker.vel().y - .4039393144409666) < .0001, `native next velocity, got ${f.tracker.vel().y}`)
    assert.ok(leadTarget(f.entity, () => f.tracker.vel(), null, 0)(9).y < 157, 'the next intercept must not invent a second ascent to Y159.65')
  })
}

function nativePositions(startY, velocity, intervals) {
  let y = startY
  return intervals.map(ticks => {
    for (let i = 0; i < ticks; i++) { y += velocity; velocity = (velocity - .08) * Math.fround(.98) }
    return { y: Math.floor(y * 4096) / 4096, velocity }
  })
}

for (const [name, velocity, intervals] of [['apex crossing', .12, [1, 3]], ['ordinary jump', .42, [1, 2]]] as const) {
  test(`the same native inverse retains ${name} without assuming its launch phase`, () => {
    const f = fixture(), points = nativePositions(100, velocity, intervals)
    points.forEach((p, i) => f.move(new Vec3(0, p.y, 0), 1000 + (i + 1) * 10))
    assert.ok(Math.abs(f.tracker.vel().y - points.at(-1).velocity) < 1 / 4096)
  })
}

test('an extra rising impulse incompatible with free flight retains the observation fallback', () => {
  const f = fixture(), fallback = trackTarget(f.entity, f.time); fallback.update()
  for (const dy of [.12, .75]) {
    f.move(f.entity.position.offset(0, dy, 0), f.time() + 100); fallback.update()
  }
  assert.deepEqual(f.tracker.vel(), fallback.vel(), 'do not force a native interval onto incompatible impulses')
})

test('ambiguous rising intervals retain the observation fallback', () => {
  const f = fixture(), fallback = trackTarget(f.entity, f.time); fallback.update()
  // Unknown initial speeds permit both final counts5 and7; neither owns the model.
  for (const dy of [.5498046875, 1.4443359375]) {
    f.move(f.entity.position.offset(0, dy, 0), f.time() + 100); fallback.update()
  }
  assert.deepEqual(f.tracker.vel(), fallback.vel())
})

test('two fresh post-impulse rising intervals recover their own native endpoint', () => {
  const f = fixture()
  f.move(new Vec3(0, 100.12, 0), 1010)
  const points = nativePositions(100.12, .75, [1, 2])
  points.forEach((p, i) => f.move(new Vec3(0, p.y, 0), 1020 + i * 10))
  assert.ok(Math.abs(f.tracker.vel().y - points.at(-1).velocity) < 1 / 4096)
})

test('the first ascending receipt keeps the existing fallback confidence until a second interval', () => {
  const f = fixture()
  f.move(f.entity.position.offset(0, 2761 / 4096, 0), 1088)
  assert.equal(f.tracker.hasVelocity(), true, 'legacy observed fallback confidence is unchanged by interval fitting')
  assert.ok(Number.isFinite(f.tracker.vel().y))
})
