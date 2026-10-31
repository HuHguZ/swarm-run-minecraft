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

test('landing prices the requested height before preferring a closer lower floor', () => {
  const { cost } = require('../src/elytra/control')
  const { worldOf } = require('../src/elytra/physics')
  const goal = { kind: 'land', at: new Vec3(.5, 160, .5) }
  const quote = (x: number) => {
    const { bot, touchdown } = fixture(x)
    const result = { kind: 'floor', p: touchdown, v: { x: 0, y: 0, z: 0 }, fd: .4, t: 1 }
    return { p: touchdown, c: cost(worldOf(bot), {}, goal, () => goal.at, result, 0, 0) }
  }
  const upper = quote(-4.5), lower = quote(2.5)
  assert.equal(upper.p.y, 160)
  assert.equal(lower.p.y, 153.5)
  assert(lower.p.distanceTo(goal.at) > upper.p.distanceTo(goal.at))
  assert(lower.c > upper.c, `a wrong floor cannot look closer: lower=${lower.c}, upper=${upper.c}`)
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

test('the last gate prices an approach while earlier gates retain through-flight', async t => {
  const { bot, touchdown } = fixture(.5)
  bot.entity.position = new Vec3(-1, 169.7, .5); bot.entity.elytraFlying = true
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_b, c) => c)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ boxHit: () => false, floorBelow: () => ({ top: 160 }) }))
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => 4)
  t.mock.method(require('../src/elytra/track'), 'gliding', e => !!e.elytraFlying)
  const goals: any[] = [], slowRockets: any[] = []
  t.mock.method(require('../src/elytra/flight'), 'fly', async (_b, _ctl, options) => {
    goals.push(options.goal())
    slowRockets.push(options.rocketIf({ p: { y: 170 }, v: { x: .3, y: 0, z: 0 } }))
    assert.equal(options.rocketIf({ p: { y: 167 }, v: { x: .3, y: 0, z: 0 } }), true, 'a needed climb still requests thrust')
    assert.equal(options.rocketIf({ p: { y: 170 }, v: { x: 1, y: 0, z: 0 } }), false)
    bot.emit('physicsTick'); bot.entity.position.x = (goals.length - 1) * 8 + 1; bot.emit('physicsTick')
    return { why: 'gate crossed' }
  })
  t.mock.method(require('../src/elytra/flight'), 'land', async () => {
    bot.entity.position = touchdown.clone(); bot.entity.onGround = true; bot.entity.elytraFlying = false
    return { ok: true, ground: { ...touchdown } }
  })
  const result = await runFlightRoute({ bot, bus: new EventEmitter() }, { aborted: false }, {
    gates: [0, 8].map(x => ({ id: String(x), center: { x, y: 170, z: .5 }, normal: { x: 1, y: 0, z: 0 }, radius: 4 })),
    landing: { x: .5, y: 160, z: .5 }
  })
  assert.equal(result.ok, true)
  assert.equal(result.crossings.length, 2)
  assert.deepEqual(goals.map(g => g.reach), [true, false], 'do not accelerate through the final approach or brake at transit gates')
  assert.deepEqual(slowRockets, [true, undefined], 'the slow final approach compares rocket price instead of forcing another acceleration')
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

for (const ceiling of ['none', 'blocked', 'alternative', 'unavailable', 'occupied', 'initial-ceiling', 'fluid', 'bounds']) test(`fly_to validates the fallback pad and its approach: ${ceiling}`, async t => {
  const { bot } = fixture(.5)
  bot.entity.position = new Vec3(.5, 120, .5)
  const pad = { x: 30.5, y: ceiling === 'initial-ceiling' ? 121 : ceiling === 'bounds' ? 131 : 128, z: 8.5 }
  const other = { x: 22.5, y: 128, z: .5 }
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({
    boxHit: () => ceiling === 'occupied',
    floorBelow: (x, y, z, depth) => depth === 0 ? ceiling !== 'none' && x === pad.x && z === pad.z && y === (ceiling === 'initial-ceiling' ? 125 : 132) ? { top: y + 1 } : null
      : depth === 14 && ceiling !== 'unavailable' && (x === pad.x && z === pad.z || ceiling === 'alternative' && x === other.x && z === other.z) ? { top: pad.y, lava: ceiling === 'fluid' } : null
  }))
  let request: any
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_s, _ctl, p) => {
    request = p
    return { ok: false, stopped: 'test route captured' }
  })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  const result = await aerialMethods({ session }).fly_to({ at: { x: 30.5, y: 120, z: .5 } })
  if (!['none', 'alternative'].includes(ceiling)) {
    assert.equal(request, undefined, 'an invalid pad or approach cannot start a flight')
    assert.equal(result.ok, false)
    assert.equal(result.why, 'негде сесть у цели (под навесом или занято)')
    assert.equal(result.landingStage, ceiling === 'blocked' ? 'approach' : 'selection')
    assert.equal(result.rejectedApproaches > 0, ceiling === 'blocked')
    const rejected = ceiling === 'unavailable' ? 'support' : ceiling === 'initial-ceiling' ? 'ceiling' : ceiling
    if (ceiling !== 'blocked') assert(result.landingChecks[rejected] > 0)
    return
  }
  assert.ok(request)
  const chosen = ceiling === 'alternative' ? other : pad
  assert.deepEqual(request.landing, chosen)
  assert.equal(result.rejectedApproaches > 0, ceiling === 'alternative')
  const gate = request.gates.at(-1)
  assert.equal(gate.center.x, (bot.entity.position.x + chosen.x) / 2)
  assert.equal(gate.center.z, (bot.entity.position.z + chosen.z) / 2, 'the approach follows the chosen pad, not the original target')
  assert.equal(gate.center.y, chosen.y + 4, 'the higher pad receives the same clearance as an observed ridge')
})

test('fly_to finds a known clear pad below unknown space without inventing support', async t => {
  const { bot } = fixture(.5)
  bot.entity.position = new Vec3(.5, 120, .5)
  bot.blockAt = p => {
    const pad = p.x === 30 && p.z === 8
    if (pad && p.y === 130) return null
    const solid = pad && p.y === 127
    return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const physics = require('../src/elytra/physics'), W = physics.worldOf(bot)
  assert.equal(W.floorBelow(30.5, 130, 8.5, 14), null)
  assert.deepEqual(W.floorBelow(30.5, 127, 8.5, 0), { top: 128 })
  assert.equal(W.boxHit(30.5, 128, 8.5, 1.8), false)
  assert.equal(W.boxHit(30.5, 130, 8.5, 1.8), true, 'unknown space must keep blocking flight')
  t.mock.method(physics, 'worldOf', () => W)
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  let request: any
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_s, _ctl, p) => { request = p; return { ok: false, stopped: 'test route captured' } })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  const result = await aerialMethods({ session }).fly_to({ at: { x: 30.5, y: 120, z: .5 } })
  assert.ok(request, 'unknown air above a known support must not hide that candidate')
  assert.deepEqual(request.landing, { x: 30.5, y: 128, z: 8.5 })
  assert(result.recoveredSupports > 0)
})

for (const terrain of ['flat', 'ridge', 'shelf']) test(`fly_to ${terrain === 'ridge' ? 'keeps the early climb before a real ridge' : terrain === 'shelf' ? 'flies forward from its launch shelf toward a lower landing' : 'flies forward over flat ground without a climb over its launch point'}`, async t => {
  const raised = terrain === 'ridge', shelf = terrain === 'shelf'
  const { bot } = fixture(.5)
  const from = shelf ? new Vec3(590.5, 124, 564.5) : new Vec3(603.6924858188771, 120, 605.7662710787135)
  const target = shelf ? { x: 600.5, y: 120, z: 600.5 } : { x: 630, y: 120, z: 600 }
  bot.entity.position = from.clone()
  bot.entity.onGround = true
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({
    solid: (x, y, z) => y < (shelf && z < 574 ? 124 : raised && x >= 606 && x <= 608 ? 125 : 120),
    boxHit: () => false,
    floorBelow: (x, y, z, depth) => depth === 0
      ? y < (shelf && z < 574 ? 124 : raised && x >= 606 && x <= 608 ? 125 : 120) ? { top: y + 1 } : null
      : { top: 120, lava: false, water: false }
  }))
  let request: any
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_s, _ctl, p) => {
    request = p
    return { ok: false, stopped: 'test route captured' }
  })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  await aerialMethods({ session }).fly_to({ at: target })
  assert.ok(request)
  if (raised) {
    assert.equal(request.gates[0].id, 'подъём')
    assert.equal(request.gates[1].center.x < 610, true)
    assert.equal(request.gates[1].center.y >= 129, true)
  } else if (shelf) {
    assert.equal(request.gates.length, 1, 'leave the shelf forward without a vertical climb')
    assert.equal(request.gates[0].id, 'над гребнем')
    assert(request.gates[0].center.z > 572 && request.gates[0].center.z < 575,
      'begin the approach just beyond the shelf, not at the midpoint of the remaining open flight')
    assert.equal(request.gates[0].center.y, 128, 'the roof clearance remains unchanged')
  } else {
    assert.equal(request.gates.length, 1, 'a flat floor is not an obstacle requiring vertical circling')
    assert.equal(request.gates[0].id, 'над гребнем')
    assert.equal(request.gates[0].center.x, (from.x + request.landing.x) / 2)
    assert.equal(request.gates[0].center.z, (from.z + request.landing.z) / 2)
  }
})
