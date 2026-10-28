import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { windGravityAt } from './swarm/swarm-driver/combo-wind-gravity'
import { anvilArm } from './swarm/swarm-driver/combo-anvil'

const { Vec3 } = require('../daemon/node_modules/vec3')
const air = require('../daemon/src/swarm/combos/air-ideas'), pick = require('../daemon/src/pick')
const track = require('../daemon/src/bow/track'), physics = require('../daemon/src/elytra/physics')
const ballistics = require('../daemon/src/combat/team-wind')

function fixture(flight = 6, floor: number | null = null) {
  const bot: any = new EventEmitter(), target: any = { id: 2, username: 'body', type: 'player', name: 'player',
    position: new Vec3(6, 158, 0), velocity: new Vec3(), onGround: false, metadata: [], height: 1.8, width: .6 }
  Object.defineProperty(target, 'health', { get() { throw Error('enemy HP stays private') } })
  bot.username = 'support'; bot.health = 20; bot._client = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 151, 0), velocity: new Vec3(), onGround: true, yaw: 0, pitch: 0, metadata: [] }
  bot.entities = { 2: target }; bot.players = {}; bot.registry = { effectsByName: {}, entitiesByName: {} }
  bot.heldItem = { name: 'wind_charge', slot: 36, count: 64 }; bot.inventory = { items: () => [bot.heldItem], slots: [] }
  bot.waits = []; bot.waitForTicks = async n => { bot.waits.push(n) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activations = 0; bot.activateItem = () => { bot.activations++ }
  let velocity = { x: .2, y: -.3, z: .1, ageTicks: 1 }, solverCalls = 0
  const old = { canHit: pick.canHit, blockOnRay: pick.blockOnRay, observedVelocity: track.observedVelocity,
    hasObservedVelocity: track.hasObservedVelocity, worldOf: physics.worldOf, windLaunch: ballistics.windLaunch }
  pick.canHit = () => true; pick.blockOnRay = () => null
  track.observedVelocity = () => velocity; track.hasObservedVelocity = () => true
  physics.worldOf = () => ({ floorBelow: () => floor === null ? null : { top: floor, lava: false, water: false } })
  ballistics.windLaunch = (from, at) => {
    solverCalls++; const v = at.minus(from).scaled(1 / flight), d = v.scaled(1 / v.norm())
    return { time: flight, velocity: v, direction: d, yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y) }
  }
  return { bot, target, velocity, solverCalls: () => solverCalls, setVelocity: v => { velocity = v },
    restore() { Object.assign(pick, { canHit: old.canHit, blockOnRay: old.blockOnRay })
      Object.assign(track, { observedVelocity: old.observedVelocity, hasObservedVelocity: old.hasObservedVelocity })
      physics.worldOf = old.worldOf; ballistics.windLaunch = old.windLaunch }
  }
}

test('C2b predicts native gravity with captured age plus one look tick, after the existing two preparation ticks', async () => {
  const f = fixture()
  try {
    const look = f.bot.look
    f.bot.look = async (...args) => { await look(...args); f.setVelocity({ x: 9, y: -9, z: 9, ageTicks: 0 }) }
    const r: any = await windGravityAt(f.bot, f.target)
    assert.equal(r.fired, true); assert.equal(f.bot.activations, 1); assert.deepEqual(f.bot.waits, [1, 1, 1])
    assert.equal(f.solverCalls(), 4, 'reuse the existing initial solve and three aim iterations')
    assert.ok(Math.abs(r.trace.aim.at.y - 153.9518926441163) < 1e-10)
    assert.ok(Math.abs(r.trace.aim.at.x - 7.6) < 1e-12); assert.ok(Math.abs(r.trace.aim.at.z - .8) < 1e-12)
    assert.equal(r.gravityPrediction.usedVelocity.y, -.3); assert.equal(r.gravityPrediction.usedVelocity.ageTicks, 1)
    assert.equal(r.gravityPrediction.horizonTicks, 8); assert.ok(Number.isFinite(r.gravityPrediction.epochMs))
  } finally { f.restore() }
})

test('C2b keeps fractional air motion and the existing solid-floor clamp with the original feet plus .3 aim height', async () => {
  for (const floor of [null, 151]) {
    const f = fixture(2.25, floor)
    try {
      f.target.position.y = floor === null ? 158 : 151.2
      f.setVelocity({ x: 0, y: -.3, z: 0, ageTicks: .5 })
      let y = f.target.position.y, vy = -.3
      for (let i = 0; i < 3; i++) { y += vy; vy = (vy - .08) * Math.fround(.98) }
      y += .75 * vy
      const r: any = await windGravityAt(f.bot, f.target)
      assert.equal(r.fired, true)
      assert.ok(Math.abs(r.trace.aim.at.y - (floor === null ? y : Math.max(y, floor)) - .3) < 1e-10)
    } finally { f.restore() }
  }
})

test('the default C2a wind remains linear and does not acquire age, look delay or gravity', async () => {
  const f = fixture()
  try {
    const r: any = await air.windAt(f.bot, f.target)
    assert.equal(r.fired, true); assert.equal(f.bot.activations, 1)
    assert.deepEqual(r.trace.aim.at, { x: 7.2, y: 156.5, z: .6000000000000001 })
    assert.equal(r.gravityPrediction, undefined); assert.deepEqual(f.bot.waits, [1, 1, 1])
    for (const enabled of [false, true]) assert.deepEqual(anvilArm(enabled, 'wind-gravity'), anvilArm(enabled, 'wind-observed'))
  } finally { f.restore() }
})

test('a visible static third-body ray intercept is diagnostic only and does not add a refusal', async () => {
  const f = fixture()
  try {
    f.bot.entities[3] = { id: 3, username: 'other', type: 'player', position: new Vec3(3, 152, .3), height: 1.8, width: .6 }
    const r: any = await windGravityAt(f.bot, f.target)
    assert.equal(r.fired, true); assert.equal(f.bot.activations, 1)
    assert.equal(r.gravityPrediction.firstStaticInterceptorId, 3)
    assert.equal(r.gravityPrediction.collisionModel, 'static_aim_ray_only_no_moving_safety')
    assert.equal(r.gravityPrediction.thirdBodies.length, 1)
  } finally { f.restore() }
})

test('C2b still refuses a wall or cancellation appearing during look without activating', async () => {
  for (const change of ['wall', 'cancel']) {
    const f = fixture(), ctl = { aborted: false }, look = f.bot.look
    try {
      f.bot.look = async (...args) => { await look(...args)
        if (change === 'wall') pick.blockOnRay = () => ({ name: 'stone' }); else ctl.aborted = true }
      const r: any = await windGravityAt(f.bot, f.target, { ctl })
      assert.equal(r.fired, false); assert.equal(f.bot.activations, 0)
      assert.equal(r.why, change === 'wall' ? 'release_changed_or_unsafe' : 'cancelled_or_changed')
      if (change === 'wall') assert.equal(r.check, 'block')
    } finally { f.restore() }
  }
})
