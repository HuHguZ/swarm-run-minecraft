import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { observedVelocity, hasObservedVelocity, hasObservedPhysicalVelocity } from '../src/bow/track'
import { enemyWindFrames, observeEnemyWindMotion } from '../src/combat/enemy-wind'
import edges = require('../src/edges')

// AJ BASE release+469ms: these first two public positions are red native
// frames136/137 (one movement), but their receipt clocks span97.758789ms.
const first = { x: 599.7749944850261, y: 137.92722876039957, z: 606.9067626503111, t: 1793836485539.3474, kind: 'sync_entity_position', grounded: false, flying: false, revision: 3 }
const second = { x: 599.6394964381511, y: 141.81419165102457, z: 608.1047606971861, t: 1793836485637.1062, kind: 'rel_entity_move', grounded: false, flying: false, revision: 3 }
// The next public update spans two native movements, not its163.9ms receipt interval.
const third = { x: 599.4122015162761, y: 149.12278540102457, z: 610.1133056190611, t: 1793836485801.022, kind: 'rel_entity_move', grounded: false, flying: false, revision: 3 }

function fixture() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const read = p => { const b = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sand' : 'air'].defaultState); b.position = p.floored(); return b }
  let now = 1793836485707.293
  const raw: any = { id: 579, username: 'Red', name: 'player', type: 'player', isValid: true, _ndVisible: true, _ndMotionEpoch: 4,
    position: new Vec3(second.x, second.y, second.z), onGround: false, yaw: 6.170611623689174, pitch: 0, width: .6, height: 1.8,
    metadata: [8], equipment: [], _ndPositionReceipts: [{ ...first }, { ...second }], _ndObservationNow: () => now }
  for (const key of ['velocity', 'health', 'attributes', 'effects']) Object.defineProperty(raw, key, { get() { throw Error('private target '+key) } })
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, username: 'Caster', health: 20, food: 20,
    game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, blockAt: read, entities: { 579: raw }, players: { Red: { entity: raw, gamemode: 0 } },
    entity: { id: 1, username: 'Caster', position: new Vec3(605.9040105278706, 120, 600.5106849709275), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} } })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: read })
  const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }
  const receive = receipt => {
    raw._ndPositionReceipts = [raw._ndPositionReceipts[1], { ...receipt }]
    raw.position = new Vec3(receipt.x, receipt.y, receipt.z); now = receipt.t
  }
  return { raw, bot, arena, receive }
}

test('recorded AJ first relative after sync retains its estimate but cannot certify the sprint forecast', () => {
  const f = fixture(), estimate = observedVelocity(f.raw)
  assert.ok(Math.abs(estimate.y - 1.81400622389228) < 1e-10, 'the existing public API still returns its explicitly unconfirmed estimate')
  assert.equal(hasObservedVelocity(f.raw), true, 'legacy bow readiness keeps accepting its existing public estimate')
  assert.equal(hasObservedPhysicalVelocity(f.raw), false, '97ms receipt timing cannot establish the native movement count')
  assert.equal(observeEnemyWindMotion(f.bot, f.raw), null)
  assert.deepEqual(enemyWindFrames(f.bot, f.raw, f.arena), [], 'SPRINT must not bypass the uncertain vertical phase')
})

test('a lone receipt displacement admits materially different native phases; an incompatible second displacement stays unknown', () => {
  const f = fixture(), dy = second.y - first.y, { gravity, airdrag } = f.bot.physics
  const endpoints: number[] = []
  for (const ticks of [1, 2]) {
    const sum = (1 - airdrag ** ticks) / (1 - airdrag)
    const start = (dy + gravity * airdrag * (ticks - sum) / (1 - airdrag)) / sum
    const state = edges.stateOf({ ...f.bot, entity: { position: new Vec3(first.x, first.y, first.z), velocity: new Vec3(0, start, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} } })
    for (let i = 0; i < ticks; i++) edges.simOf(f.bot)(state, edges.worldOf(f.bot))
    assert.ok(Math.abs(state.pos.y - second.y) < 1e-10, 'both native histories produce the same visible endpoint')
    endpoints.push(state.vel.y)
  }
  assert.ok(Math.abs(endpoints[0] - endpoints[1]) > 1)
  observedVelocity(f.raw)
  f.receive({ ...third, y: second.y, x: second.x + .1 })
  assert.equal(hasObservedPhysicalVelocity(f.raw), false)
  assert.deepEqual(enemyWindFrames(f.bot, f.raw, f.arena), [])
})

test('one fresh zero airborne displacement is not a certified stationary ground sample', () => {
  const f = fixture()
  f.raw.position = new Vec3(first.x, first.y, first.z)
  f.raw._ndPositionReceipts = [{ ...first }, { ...second, x: first.x, y: first.y, z: first.z }]
  assert.equal(hasObservedVelocity(f.raw), true, 'legacy measured-stop semantics stay unchanged')
  assert.equal(hasObservedPhysicalVelocity(f.raw), false)
  assert.deepEqual(enemyWindFrames(f.bot, f.raw, f.arena), [])
})

test('a second compatible public displacement recovers the native endpoint despite unequal receipt durations', () => {
  const f = fixture()
  observedVelocity(f.raw)
  f.receive(third)
  const velocity = observedVelocity(f.raw)
  assert.equal(hasObservedVelocity(f.raw), true)
  assert.equal(hasObservedPhysicalVelocity(f.raw), true)
  assert.ok(Math.abs(velocity.y - 3.4279544) < 1 / 4096, 'one-then-two native movements recover the actual recorded endpoint')
  const frames = enemyWindFrames(f.bot, f.raw, f.arena)
  assert.equal(frames.length, 66)
  assert.ok(Math.abs(frames[0].vel.y - velocity.y) < 1e-12)
  f.receive({ ...third, t: third.t + 50, y: third.y + 1, kind: 'sync_entity_position' })
  assert.equal(hasObservedVelocity(f.raw), false, 'absolute synchronization cannot inherit a previous phase certificate')
  assert.equal(hasObservedPhysicalVelocity(f.raw), false)
  assert.deepEqual(enemyWindFrames(f.bot, f.raw, f.arena), [])
})

test('reliable ground samples keep their existing confidence and native forecast', () => {
  const f = fixture()
  f.raw.onGround = true; f.raw.position = new Vec3(600.5, 120, 600.5)
  f.raw._ndPositionReceipts = [{ ...first, x: 600.3, y: 120, z: 600.5, grounded: true }, { ...second, x: 600.5, y: 120, z: 600.5, grounded: true }]
  assert.equal(hasObservedVelocity(f.raw), true)
  assert.equal(hasObservedPhysicalVelocity(f.raw), true)
  assert.equal(observedVelocity(f.raw).y, 0)
  assert.equal(enemyWindFrames(f.bot, f.raw, f.arena).length, 66)
})

test('recorded centre sprint reversals keep visible momentum without extending the last look as steady input', t => {
  const bow: typeof import('../src/bow/track') = require('../src/bow/track')
  t.mock.method(bow, 'hasObservedPhysicalVelocity', () => true)
  // CK A, two successive turns seen by c. q received the same last two positions and certified their momentum.
  const [earlier, previous, current] = [
    [600.504150390625, 123.157958984375, 600.48974609375, 1793890177976.4272, 2.773437264497239],
    [600.49462890625, 124.086669921875, 600.531982421875, 1793890178003.7966, 6.135923151542565],
    [600.498046875, 126.299072265625, 600.496337890625, 1793890178100.5715, 3.6570101983193686]
  ].map(([x, y, z, at, yaw], i) => ({ x, y, z, t: at, yaw, pitch: 0, kind: 'entity_move_look', grounded: false, flying: false, revision: i + 3 }))
  const velocity = new Vec3(0, .5524232677239197, -.011881510416699366), ageTicks = 1
  let estimate: any = { ...velocity, ageTicks }
  t.mock.method(bow, 'observedVelocity', () => estimate)
  const { raw, bot, arena } = fixture()
  raw._ndEarlierPositionReceipt = earlier
  raw._ndPositionReceipts = [previous, current]; raw._ndGlideRevision = current.revision
  raw.position = new Vec3(current.x, current.y, current.z); raw.yaw = current.yaw
  const coast = edges.stateOf({ ...bot, entity: { position: raw.position.clone(), velocity, yaw: raw.yaw, onGround: false, effects: {}, attributes: {} } }, edges.IDLE)
  const step = edges.simOf(bot), world = edges.worldOf(bot)
  for (let tick = 0; tick < ageTicks + 11; tick++) step(coast, world)
  const frames = enemyWindFrames(bot, raw, arena, [], 0, true)
  assert.ok(frames[11].pos.distanceTo(coast.pos) < 1e-10, 'repeated reversals must not extrapolate a long forward drive')

  estimate = { ...velocity.scaled(8), y: velocity.y, ageTicks }
  assert.ok(observeEnemyWindMotion(bot, raw).run?.control.forward, 'strong measured momentum keeps the sprint hypothesis')
  estimate = { ...velocity, ageTicks }
  raw._ndPositionReceipts[1].yaw = raw.yaw = previous.yaw
  assert.ok(observeEnemyWindMotion(bot, raw).run?.control.forward, 'steady sprint keeps native air acceleration')
})

test('a single airborne sprint turn can hold its new direction', () => {
  const { raw, bot, arena, receive } = fixture()
  raw._ndPositionReceipts = [null, null]
  raw.yaw = 0
  const state = edges.stateOf({ ...bot, entity: { ...bot.entity, position: new Vec3(600.5, 140, 600.5),
    velocity: new Vec3(0, .6, .06), onGround: false } }, { ...edges.IDLE, forward: true, sprint: true })
  const step = edges.simOf(bot), world = edges.worldOf(bot)
  for (let tick = 0; tick <= 3; tick++) {
    if (tick) step(state, world)
    raw.yaw = tick === 3 ? Math.PI : 0
    raw._ndEarlierPositionReceipt = raw._ndPositionReceipts[0]
    receive({ ...state.pos, t: 1000 + tick * 50, yaw: raw.yaw, kind: 'entity_move_look', grounded: false, flying: false, revision: 0 })
    observedVelocity(raw)
  }
  assert.equal(hasObservedPhysicalVelocity(raw), true)
  const frames = enemyWindFrames(bot, raw, arena, [], 0, true)
  state.yaw = Math.PI
  for (let tick = 0; tick < 11; tick++) step(state, world)
  assert.ok(frames[11].pos.distanceTo(state.pos) < .02)
})
