import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import bow = require('../src/bow')
import sky = require('../src/elytra')
const Q = 1 / 4096

function actor(p = new Vec3(4105.941915882921, 179.76704537049048, 3120.5), yaw = -Math.PI / 2, pitch = 0) {
  const entity: any = new EventEmitter()
  Object.assign(entity, { id: 7, type: 'player', position: p, yaw, pitch, onGround: false, elytraFlying: true, _ndGlideBoosted: false })
  let now = 1000
  entity._ndObservationNow = () => now
  const receipt = (kind = 'rel_entity_move') => ({ ...entity.position, t: now, grounded: false, kind,
    yaw: entity.yaw, pitch: entity.pitch, flying: entity.elytraFlying, boosted: entity._ndGlideBoosted })
  entity._ndPositionReceipts = [null, receipt('sync_entity_position')]
  const tracker = bow.trackTarget(entity)
  const move = (p, dt = 50, kind = 'rel_entity_move') => {
    now += dt; entity.position = p
    entity._ndPositionReceipts = [entity._ndPositionReceipts[1], receipt(kind)]
    entity.emit('ndPositionObserved')
  }
  return { entity, tracker, move }
}

function air45() {
  const a = actor()
  a.move(new Vec3(4106.504660023546, 179.30659615174048, 3120.5), 62.215087890625)
  a.move(new Vec3(4106.947286976671, 179.00190865174048, 3120.5), 485.457763671875)
  return a
}

test('Air45 glider endpoint is recovered from three positions, not its 9.709 delivery ticks', () => {
  const { tracker, move } = air45()
  assert.equal(tracker.hasVelocity(), true)
  const v = tracker.vel()
  // Independent target-client position differences, not native Motion or a worker clock.
  assert.ok(Math.abs(v.x - .227854967388339) < Q, `vx ${v.x}`)
  assert.ok(Math.abs(v.y + .15219398776227422) < Q, `vy ${v.y}`)
  move(new Vec3(4107.188009632921, 178.85005318299048, 3120.5), 323.328857421875)
  assert.equal(tracker.hasVelocity(), true, 'the next real displacement confirms the same phase')
})

for (const change of ['pitch', 'yaw', 'rocket', 'teleport', 'phase', 'revision']) test(`glider confidence is cancelled on ${change}`, () => {
  const { tracker, entity, move } = air45()
  assert.equal(tracker.hasVelocity(), true)
  if (change === 'pitch') entity.pitch = .3
  if (change === 'yaw') entity.yaw = .7
  if (change === 'rocket') entity._ndGlideBoosted = true
  if (change === 'phase') entity.elytraFlying = false
  if (change === 'revision') entity._ndGlideRevision = 2
  if (change === 'teleport') move(entity.position.offset(4, 0, 0), 50, 'sync_entity_position')
  assert.equal(tracker.hasVelocity(), false)
})

test('one moving glide interval is not an observed physical endpoint; a real stationary receipt still is', () => {
  const { entity, tracker, move } = actor()
  move(entity.position.offset(.4, -.3, 0))
  assert.equal(tracker.hasVelocity(), false)
  move(entity.position.clone())
  assert.equal(tracker.hasVelocity(), true)
  assert.deepEqual(tracker.vel(), { x: 0, y: 0, z: 0, ageTicks: 0 })
})

test('nonzero pitch and an observed rocket cannot promote a level-flight inverse', () => {
  for (const boosted of [false, true]) {
    const { entity, tracker, move } = actor(new Vec3(0, 100, 0), -.7, boosted ? 0 : .3)
    entity._ndGlideBoosted = boosted
    const p = { ...entity.position }, v = { x: .2, y: -.3, z: -.2 }
    for (let i = 0; i < 4; i++) {
      sky.glideStep(p, v, entity.yaw, entity.pitch, boosted)
      move(new Vec3(p.x, p.y, p.z))
    }
    assert.equal(tracker.hasVelocity(), false)
  }
})

test('level-flight inverse retains all three velocity components with unknown interval lengths', () => {
  const { entity, tracker, move } = actor(new Vec3(0, 100, 0), -.7)
  const p = { ...entity.position }, v = { x: .3, y: -.4, z: .1 }
  for (const [ticks, dt] of [[3, 120], [2, 480]]) {
    for (let i = 0; i < ticks; i++) sky.glideStep(p, v, entity.yaw, entity.pitch, false)
    move(new Vec3(p.x, p.y, p.z), dt)
  }
  assert.equal(tracker.hasVelocity(), true)
  const observed = tracker.vel()
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(observed[axis] - v[axis]) < Q, axis)
})

test('ambiguous physical glide counts retain an estimate without claiming a measured endpoint', () => {
  const { entity, tracker, move } = actor(new Vec3(0, 100, 0))
  const p = { ...entity.position }, v = { x: .3, y: .005, z: 0 }
  for (const ticks of [1, 7]) {
    for (let i = 0; i < ticks; i++) sky.glideStep(p, v, entity.yaw, 0, false)
    move(new Vec3(p.x, p.y, p.z), ticks * 50)
  }
  assert.equal(tracker.hasVelocity(), false)
  assert.ok(Number.isFinite(tracker.vel().x))
})

test('a glider steering every receipt keeps a positional velocity estimate (try-lance: it stayed 0)', () => {
  const { entity, tracker, move } = actor(new Vec3(0, 100, 0))
  for (let i = 1; i <= 6; i++) {
    entity.yaw = -Math.PI / 2 + i * .05
    move(entity.position.offset(1.6, -.05, 0), 100)
  }
  assert.equal(tracker.hasVelocity(), false, 'a steered glide is not a physical endpoint')
  const v = tracker.vel()
  assert.ok(Math.abs(v.x - .8) < .05, `vx ${v.x}: 1.6 blocks per 2-tick player update`)
})
