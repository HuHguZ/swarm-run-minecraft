import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { enemyWindFrames, installWindTracking, observeEnemyWindMotion, windCollisionWorld } from '../src/combat/enemy-wind'
import edges = require('../src/edges')

function fixture(input: Partial<typeof edges.IDLE>, yaw = 0, support = (p: Vec3) => p.y < 120) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const blockAt = (p: Vec3) => {
    const block = Block.fromStateId(registry.blocksByName[support(p) ? 'stone' : 'air'].defaultState)
    block.position = p.floored(); return block
  }
  let now = 1000
  const foe: any = Object.assign(new EventEmitter(), {
    id: 2, username: 'Red', type: 'player', height: 1.8, width: .6, _ndVisible: true, _ndMotionEpoch: 1,
    yaw, pitch: 0, onGround: true, metadata: [input.sprint ? 8 : 0], equipment: [], _ndObservationNow: () => now
  })
  for (const key of ['velocity', 'effects', 'attributes']) Object.defineProperty(foe, key, { get() { throw Error(`private ${key}`) } })
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, blockAt, food: 20, inventory: { slots: [] },
    entity: { id: 1, position: new Vec3(601, 120, 604) }, players: { Red: { entity: foe } } })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: blockAt })
  const state = edges.stateOf({ ...bot, entity: {
    position: new Vec3(600.5, 120, 600.5), velocity: new Vec3(0, -.0784, 0), yaw, onGround: true, effects: {}, attributes: {}
  } }, { ...edges.IDLE, ...input })
  const simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const step = (ticks = 1) => { for (let i = 0; i < ticks; i++) simulate(state, world) }
  const sample = (ticks: number, elapsed = 50 * ticks, kind = foe._ndPositionReceipts ? 'rel_entity_move' : 'reacquired',
    collision?: ReturnType<typeof windCollisionWorld>) => {
    now += elapsed; foe.position = state.pos.clone(); foe.yaw = state.yaw; foe.onGround = state.onGround
    foe.metadata[0] = state.control.sprint ? 8 : 0
    const receipt = { ...state.pos, t: now, grounded: state.onGround, yaw: state.yaw,
      kind, revision: foe._ndGlideRevision, boosted: foe._ndGlideBoosted }
    foe._ndEarlierPositionReceipt = kind === 'sync_entity_position' ? null : foe._ndPositionReceipts?.[0]
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1] || null, receipt]
    foe.emit('ndPositionObserved')
    return observeEnemyWindMotion(bot, foe, collision)
  }
  step(20); sample(0)
  for (let i = 0; i < 3; i++) { step(2); sample(2) }
  const check = (ticks = 8, tolerance = .008) => {
    const frames = enemyWindFrames(bot, foe, { x: 600.5, z: 600.5, r: 80 }, [], 0, true)
    assert.equal(frames.length, 66)
    for (let i = 1; i <= ticks; i++) {
      step()
      assert.ok(frames[i].pos.distanceTo(state.pos) < tolerance, `tick ${i}, predicted ${frames[i].pos}, native ${state.pos}`)
    }
  }
  return { bot, foe, state, step, sample, check, age: (ms: number) => { now += ms } }
}

for (const [name, control] of Object.entries({ walk: { forward: true }, sprint: { forward: true, sprint: true },
  strafe: { left: true }, diagonal: { forward: true, right: true, sprint: true } })) {
  test(`public ground forecast retains native ${name} pace and direction`, () => fixture(control, .51).check())
}

test('ground reversal follows new input even while the last movement still points forward', () => {
  const f = fixture({ forward: true, sprint: true })
  f.state.control = { ...edges.IDLE, back: true }
  const before = f.state.pos.z
  f.step(); f.sample(1)
  assert.ok(f.state.pos.z < before, 'this native tick is still moving forward from sprint inertia')
  f.check()
})

test('ground wind momentum decays while retained input continues at ordinary sprint speed', () => {
  const f = fixture({ forward: true, sprint: true })
  f.state.vel.x += .7
  f.step(); f.sample(1)
  f.check()
})

test('two native movement steps in a compressed receipt retain steady walking pace', () => {
  const f = fixture({ forward: true })
  f.step(2); f.sample(2, 1.118)
  f.check()
})

test('a compressed relative packet after absolute sync does not imply ground acceleration', () => {
  const f = fixture({})
  // BD 31e observed these positions 1.118 ms apart. The support at the recorded height is unknown here.
  f.state.pos.set(597.0481314979126, 150.5, 659.6999999880791)
  f.sample(0, 50, 'sync_entity_position')
  f.state.pos.x = 596.9612174354126
  const view = f.sample(1, 1.118)
  assert.ok(Math.abs(view.velocity.x) < .087)
  assert.equal(view.run.control.forward || view.run.control.right || view.run.control.back || view.run.control.left, false)
})

const arena = { x: 600.5, z: 600.5, r: 80 }

function fallingOntoLedge(multipleTicks = false, continuousFloor = false, nearBlockEdge = false) {
  const f = fixture({}, 0, p => p.y < 119 || p.y === 119 && (continuousFloor || p.x < 601))
  const collision = { ...windCollisionWorld(f.bot), blockAt: f.bot.blockAt }
  Object.assign(f.foe, { _ndPositionReceipts: undefined, _ndMotionEpoch: 5 })
  if (nearBlockEdge) {
    f.state.pos.set(600.9999, 120.5, 599.5)
    f.state.vel.set(0, -.1, .36)
  } else {
    f.state.pos.set(multipleTicks ? 599.45 : 599.9, multipleTicks ? 120.9 : 120.5, 600.5)
    f.state.vel.set(.36, -.1, 0)
  }
  f.state.onGround = false
  for (let i = 0; i < 3; i++) {
    if (i) f.step()
    const coast = f.sample(i ? 1 : 0, i ? 50 : 0, 'rel_entity_move', collision)
    if (i === 2) assert.ok(coast.velocity.distanceTo(f.state.vel) < 1e-7)
  }
  return { ...f, collision }
}

function firstLanding(moving = true) {
  const f = fixture({}), at = 1793874276588.2146
  // BM n#1081 first saw a grounded absolute position immediately after these falling feet.
  const current = { x: 586.8828159089368, y: 120, z: 630.5496359481646, t: at, grounded: true,
    yaw: 5.856452358330195, kind: 'sync_entity_position', revision: 51 }
  const previous = { ...current, x: moving ? 586.6946708823064 : current.x, y: 120.34756311798854,
    z: moving ? 630.1358731225696 : current.z, t: at - 107.6116, grounded: false,
    yaw: 5.865942532874692, kind: 'entity_move_look', revision: 50 }
  let now = at
  Object.assign(f.foe, { _ndMotionEpoch: 11, _ndObservationNow: () => now, yaw: current.yaw })
  const see = (previous: typeof current, next: typeof current) => {
    f.foe._ndPositionReceipts = [previous, next]
    f.foe.position = new Vec3(next.x, next.y, next.z)
    f.foe.emit('ndPositionObserved')
  }
  see(previous, current)
  return { frames: () => enemyWindFrames(f.bot, f.foe, arena), age: (ms: number) => { now = at + ms }, recover: () => {
    see(current, { ...current, x: 587.0088423434632, z: 630.6312473643426, t: now, kind: 'rel_entity_move', revision: 52 })
  } }
}

test('an old first moving landing does not certify rest before a relative ground observation', () => {
  const f = firstLanding()
  f.age(149)
  assert.equal(f.frames().length, 66)
  f.age(176.6042)
  assert.equal(f.frames().length, 0)
  f.recover()
  const frames = f.frames()
  assert.equal(frames.length, 66)
  assert.ok(frames[1].pos.x > frames[0].pos.x)
})

test('first landing without observed horizontal motion can still be forecast after a tick', () => {
  const f = firstLanding(false)
  f.age(176.6042)
  assert.equal(f.frames().length, 66)
})

test('an absolute first contact keeps fitted visible momentum only on its matching support', () => {
  for (const mode of ['contact', 'quantized contact', 'three-tick contact', 'outside three-tick envelope', 'one late step',
    'late with wrong timing', 'late on different support', 'late near friction boundary', 'other position', 'new visible epoch',
    'new pose revision', 'rocket boost', 'unknown support']) {
    const multiple = mode.includes('three-tick'), late = mode.includes('late')
    const frictionBoundary = mode === 'late near friction boundary'
    const f = fallingOntoLedge(multiple, mode === 'late on different support' || frictionBoundary, frictionBoundary), { collision } = f
    const ticks = multiple ? 3 : late ? 2 : 1
    f.step(ticks)
    assert.equal(f.state.onGround, true)
    f.foe._ndMotionEpoch += mode === 'new visible epoch' ? 2 : 1
    if (mode === 'quantized contact') f.state.pos.x += .0003
    if (mode === 'three-tick contact') f.state.pos.x += .000663
    if (mode === 'outside three-tick envelope') f.state.pos.x += .000863
    if (frictionBoundary) f.state.pos.x += .0002
    if (mode === 'other position') f.state.pos.x -= .02
    if (mode === 'new pose revision') f.foe._ndGlideRevision = 2
    if (mode === 'rocket boost') f.foe._ndGlideBoosted = true
    const known = mode === 'unknown support' ? { ...collision, blockAt: p => p.y === 119 ? null : f.bot.blockAt(p) } : collision
    const landing = f.sample(ticks, mode === 'late with wrong timing' ? 50 : 50 * ticks, 'sync_entity_position', known)
    if (!['contact', 'quantized contact', 'three-tick contact', 'one late step'].includes(mode)) {
      assert.equal(landing.velocity[frictionBoundary ? 'z' : 'x'], 0, mode)
      continue
    }
    assert.ok(landing.velocity.distanceTo(f.state.vel) < 1e-7)
    // The second query uses the same fair receipt after the air state was retired.
    const frames = enemyWindFrames(f.bot, f.foe, arena, [], 0, true, collision)
    for (let i = 1; i <= 4; i++) {
      f.step()
      assert.ok(frames[i].pos.distanceTo(f.state.pos) < 1e-6)
      assert.equal(frames[i].onGround, f.state.onGround)
    }
    assert.ok(f.state.pos.y < 120)
    f.foe._ndGlideRevision = 2
    assert.equal(observeEnemyWindMotion(f.bot, f.foe, collision).velocity.x, 0)
  }
})

test('a visible velocity event at contact fences the old fit until two new relative positions', () => {
  for (const beforeSync of [true, false]) {
    const f = fallingOntoLedge(), { bot, foe, collision } = f
    bot._client = new EventEmitter()
    bot.entities = { [foe.id]: foe }
    installWindTracking(bot)
    const packet = { entityId: foe.id, get velocity() { throw Error('the event vector is private') } }
    if (beforeSync) bot._client.emit('entity_velocity', packet)
    f.step()
    foe._ndMotionEpoch++
    const landing = f.sample(1, 50, 'sync_entity_position', collision)
    if (beforeSync) assert.equal(landing, null)
    else {
      assert.ok(landing.velocity.x > 0)
      f.age(1)
      bot._client.emit('entity_velocity', packet)
    }
    assert.equal(observeEnemyWindMotion(bot, foe, collision), null)
    f.state.vel.set(0, -.0784000015258789, 0)
    f.step()
    assert.equal(f.sample(1, 50, 'rel_entity_move', collision), null)
    f.step()
    assert.equal(f.sample(1, 50, 'rel_entity_move', collision).velocity.x, 0)
    bot.emit('end')
  }
})

test('a visible stationary grounded target stays on its unobserved support', () => {
  const f = fixture({}), world = windCollisionWorld(f.bot)
  const collision = { ...world, blockAt: (p: Vec3) => p.y < 120 ? null : world.blockAt(p) }
  // BG's two stationary ground receipts were 3004 ms apart, then the position aged 2330 ms.
  f.sample(0, 3004); f.age(2330)
  assert.equal(observeEnemyWindMotion(f.bot, f.foe, collision).position.y, 120)
  const frames = enemyWindFrames(f.bot, f.foe, arena, [], 0, true, collision)
  assert.ok(frames[51]?.onGround && frames[51].pos.equals(f.foe.position))
})

test('a stationary target still falls after observed support removal', () => {
  const f = fixture({}), world = windCollisionWorld(f.bot)
  const collision = { ...world, blockAt: (p: Vec3) => f.bot.blockAt(p.y < 120 ? p.offset(0, 120 - p.y, 0) : p) }
  f.sample(0, 3004); f.age(2330)
  assert.ok(observeEnemyWindMotion(f.bot, f.foe, collision).position.y < 120)
})

test('a walking target can step off an observed ledge', () => {
  const f = fixture({ forward: true }), world = windCollisionWorld(f.bot)
  const edge = Math.floor(f.state.pos.z)
  const collision = { ...world, blockAt: (p: Vec3) => f.bot.blockAt(p.y < 120 && p.z < edge ? p.offset(0, 120 - p.y, 0) : p) }
  const frames = enemyWindFrames(f.bot, f.foe, arena, [], 0, true, collision)
  assert.ok(frames[12]?.pos.y < 120 && frames[12].pos.z < edge)
})

test('a wind impulse moves the stationary target off its observed ground pose', () => {
  const f = fixture({}), world = windCollisionWorld(f.bot)
  const collision = { ...world, blockAt: (p: Vec3) => p.y < 120 ? null : world.blockAt(p) }
  f.sample(0, 3004); f.age(2330)
  const from = new Vec3(600.5, 120.7, 604), feet = f.foe.position.clone(), aim = feet.offset(0, .7, 0)
  const shot = { from, aim, feet, burst: aim, velocity: new Vec3(0, 0, -1.5), fireDelay: 0, ticks: 3, yaw: 0, pitch: 0, thrower: 'Caster' }
  const frames = enemyWindFrames(f.bot, f.foe, arena, [shot], 0, true, collision)
  assert.ok(frames[4]?.pos.y > 120.1 && frames[4].pos.z < feet.z)
})
