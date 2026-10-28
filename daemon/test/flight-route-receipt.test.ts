import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { runFlightRoute } from '../src/combat/flight-route'

// Native support: the upper pad ends at x=2; an overshoot can land safely on the lower slab.
function fixture(x: number, floor = 153.5) {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  const { Physics, PlayerState } = require('prismarine-physics')
  const world = { getBlock(p) {
    const q = p.floored(), upper = q.y === 159 && (q.x < 2 || q.x >= 8)
    const b = upper ? Block.fromStateId(data.blocksByName.stone.minStateId, 0)
      : q.y === floor - .5 ? Block.fromProperties(data.blocksByName.cut_sandstone_slab.id, { type: 'bottom', waterlogged: false }, 0)
        : Block.fromStateId(data.blocksByName.air.minStateId, 0)
    b.position = q; return b
  } }
  const bot: any = new EventEmitter()
  Object.assign(bot, { version: '1.21.11', health: 20, food: 20, jumpTicks: 0, jumpQueued: false,
    inventory: { slots: [], items: () => [] }, blockAt: world.getBlock,
    entity: { position: new Vec3(x, (x < 2 || x >= 8 ? 160 : floor) + .4, .5), velocity: new Vec3(0, -.1, 0),
      effects: {}, attributes: {}, onGround: false, elytraFlying: false, yaw: 0, pitch: 0 } })
  bot.physics = Physics(data, world)
  let state = new PlayerState(bot, { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
  for (let i = 0; i < 20 && !state.onGround; i++) state = bot.physics.simulatePlayer(state, world)
  assert.equal(state.onGround, true, 'touchdown must be a real native collision')
  return { bot, touchdown: state.pos.clone() }
}

async function route(t: any, x: number, cancelled = false, drift = false) {
  const { bot, touchdown } = fixture(x), ctl = { aborted: false }
  bot.entity.position = new Vec3(-1, 169.7, .5); bot.entity.elytraFlying = true
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_b, c) => c)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ boxHit: () => false, floorBelow: () => ({ top: 160 }) }))
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => 4)
  t.mock.method(require('../src/elytra/track'), 'gliding', e => !!e.elytraFlying)
  t.mock.method(require('../src/elytra/flight'), 'fly', async () => {
    bot.emit('physicsTick'); bot.entity.position.x = 1; bot.emit('physicsTick')
    return { why: 'gate crossed' }
  })
  t.mock.method(require('../src/elytra/flight'), 'land', async () => {
    bot.entity.position = touchdown.clone(); bot.entity.onGround = true; bot.entity.elytraFlying = false
    if (cancelled) ctl.aborted = true
    // A latched touchdown remains the receipt even if a later zero-Y sample loses onGround.
    if (drift) { bot.entity.position.y += .4; bot.entity.onGround = false }
    return { ok: true, why: 'сел', ground: { ...touchdown } }
  })
  const result = await runFlightRoute({ bot, bus: new EventEmitter() }, ctl, {
    gates: [{ id: 'rim', center: { x: 0, y: 170, z: .5 }, normal: { x: 1, y: 0, z: 0 }, radius: 4 }],
    landing: { x: .5, y: 160, z: .5 }
  })
  return { result, touchdown }
}

test('flight route rejects a real safe touchdown on the wrong lower floor', async t => {
  const { result, touchdown } = await route(t, 2.5)
  assert.equal(touchdown.y, 153.5)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, 'landing_missed')
  assert.deepEqual(result.ground, { ...touchdown })
  assert.ok(result.landingError > 6)
})

test('flight route rejects a far touchdown even on the requested floor', async t => {
  const { result } = await route(t, 9.5)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, 'landing_missed')
})

test('flight route accepts the native requested pad and keeps the latched touchdown', async t => {
  const { result, touchdown } = await route(t, .5, false, true)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ground, { ...touchdown })
  assert.equal(result.landingError, 0)
})

test('cancel after native touchdown never reports route success', async t => {
  const { result } = await route(t, .5, true)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, 'interrupted')
})

test('fly_to preserves actual route landing and precise current state separately from its planned pad', async t => {
  const { bot, touchdown } = fixture(2.5)
  bot.entity.position = new Vec3(.5, 160, .5)
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ solid: () => false, boxHit: () => false,
    floorBelow: () => ({ top: 160, lava: false, water: false }) }))
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async () => {
    bot.entity.position = touchdown.clone()
    return { ok: false, stopped: 'landing_missed', landing: { ...touchdown }, ground: { ...touchdown }, landingError: 6.8 }
  })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  const result = await aerialMethods({ session }).fly_to({ at: { x: 10.5, y: 160, z: .5 } })
  assert.equal(result.ok, false)
  assert.equal(result.why, 'landing_missed')
  assert.deepEqual(result.at, { ...touchdown })
  assert.deepEqual(result.landing, { ...touchdown })
  assert.deepEqual(result.ground, { ...touchdown })
  assert.equal(result.plannedLanding.y, 160)
  assert.equal(result.landingError, 6.8)
})

for (const raised of [false, true]) test(`fly_to ${raised ? 'keeps the early climb before a real ridge' : 'flies forward over flat ground without a climb over its launch point'}`, async t => {
  const { bot } = fixture(.5)
  bot.entity.position = new Vec3(603.6924858188771, 120, 605.7662710787135)
  bot.entity.onGround = true
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({
    solid: (x, y) => y < (raised && x >= 606 && x <= 608 ? 125 : 120),
    boxHit: () => false,
    floorBelow: () => ({ top: 120, lava: false, water: false })
  }))
  let request: any
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_s, _ctl, p) => {
    request = p
    return { ok: false, stopped: 'test route captured' }
  })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  await aerialMethods({ session }).fly_to({ at: { x: 630, y: 120, z: 600 } })
  assert.ok(request)
  if (raised) {
    assert.equal(request.gates[0].id, 'подъём')
    assert.equal(request.gates[1].center.x < 610, true)
    assert.equal(request.gates[1].center.y >= 129, true)
  } else {
    assert.equal(request.gates.length, 1, 'a flat floor is not an obstacle requiring vertical circling')
    assert.equal(request.gates[0].id, 'над гребнем')
    assert.equal(request.gates[0].center.x, (603.6924858188771 + 630) / 2)
    assert.equal(request.gates[0].center.z, (605.7662710787135 + 600) / 2)
  }
})
