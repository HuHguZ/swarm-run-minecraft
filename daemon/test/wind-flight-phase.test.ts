import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { testClock, install } from './tick-plugins-fixture'

const origin = new Vec3(615.9213770321567, 121.62000000476837, 588.189733549047)
const velocity = new Vec3(-1.0791784755643967, .5625883072343704, .896934546813881)
const payload = Buffer.from('01ee098017d1fe81454f2099e5df0db34b0dc98f0140833f5efaebe330405e67ae14800000408261849305e0e3baebb96547fc0fdc00cc01', 'hex')

function fixture(t, actor = 'c') {
  const clock = require('../src/game-clock'), tracker = require('../src/threats'), edges = require('../src/edges')
  const bot = install(testClock(), { physicsEnabled: false })
  const observed = actor === 'c'
    ? { birth: 1793799759820.4993, sync: 1793799759923.9058, check: 1793799760152.1865, z: 600.6603733642579, vz: .004645667504755068 }
    : { birth: 1793799759551.6348, sync: 1793799759566.5706, check: 1793799759880.3784, z: 600.6721482666015, vz: .009750796630859376 }
  let now = observed.birth
  t.mock.method(clock, 'now', () => now); t.mock.method(clock, 'observationNow', () => now)
  Object.assign(bot, { username: 'Blue', health: 20, ndClock: { age: 500n, ticks: 20, serverTicks: 20 } })
  bot.entity.username = 'Blue'; bot.entity.position = new Vec3(actor === 'c' ? 612.5 : 614.5, 120, actor === 'c' ? 602.5 : 600.5)
  const Block = require('prismarine-block')(bot.registry)
  bot.blockAt = p => { const b = Block.fromStateId(bot.registry.blocksByName[p.y < 120 ? 'sand' : 'air'].defaultState); b.position = p.floored(); return b }
  const foe = { id: 1252, username: 'Red', type: 'player', width: .6, height: 1.8,
    position: new Vec3(600.557373046875, 130.39033325957874, observed.z), velocity: new Vec3(0, -.06717313246309616, observed.vz), onGround: false, metadata: [] }
  bot.entities[1252] = foe
  bot.entities[204] = { id: 204, username: 'First', type: 'player', position: origin.offset(0, -1.62, 0), width: .6, height: 1.8 }
  const projectile: any = Object.assign(new EventEmitter(), { id: 1262, name: 'wind_charge', type: 'other', width: .25, height: .25,
    position: origin.clone(), velocity: new Vec3(-.07910639077092108, .7948483183788073, 1.9420130623206981),
    _ndPositionReceipts: [null, { ...origin, t: now, kind: 'spawn_entity' }] })
  bot.entities[1262] = projectile
  tracker.thrownTracker(bot)
  bot._client.emit('packet', { entityId: 1262, type: 143, ...origin, objectData: 204 }, { name: 'spawn_entity' }, payload)
  bot.emit('entitySpawn', projectile)
  const record = bot._ndThrown.get(1262)
  assert.ok(record, 'real visible O1262 payload initializes the public flight')
  const state = edges.stateOf({ ...bot, entity: { ...foe, effects: {}, attributes: {} } }, edges.IDLE), simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
  for (let tick = 0; tick < 32; tick++) { simulate(state, world); frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }) }
  const sync = (at, position = origin, motion = velocity) => {
    now = at; projectile.position = position.clone()
    projectile._ndPositionReceipts = [projectile._ndPositionReceipts[1], { ...position, t: at, kind: 'sync_entity_position' }]
    bot._client.emit('sync_entity_position', { entityId: 1262, ...position, dx: motion.x, dy: motion.y, dz: motion.z })
  }
  const view = () => tracker.projectileView(bot, projectile, now)
  t.after(() => bot.emit('end'))
  return { bot, foe, projectile, observed, record, frames, sync, view, at: at => { now = at } }
}

for (const actor of ['c', 'd']) test(`O1262 same birth sync preserves its visible flight phase after ${actor === 'c' ? 104 : 15}ms delivery`, t => {
  const f = fixture(t, actor), { pendingWindHit } = require('../src/combat/enemy-wind')
  f.sync(f.observed.sync)
  assert.deepEqual(f.view()._ndWindMotion.velocity, { ...velocity }, 'the native double sync still refines LPVec3 precision')
  f.at(f.observed.check)
  assert.equal(pendingWindHit(f.bot, f.foe, f.frames)?.ticks, 8, 'the existing visible hit must be protected before another independent cast')
  f.sync(f.observed.check, origin)
  const motion = f.view()._ndWindMotion
  assert.ok(new Vec3(motion.position.x, motion.position.y, motion.position.z).distanceTo(origin.plus(velocity.scaled((f.observed.check - f.observed.birth) / 50))) < 1e-9)
})

test('an advanced native sync is a new current position, not a repeated birth sample', t => {
  const f = fixture(t), position = origin.plus(velocity.scaled(3))
  f.sync(f.observed.sync, position)
  assert.deepEqual(f.view()._ndWindMotion.position, { ...position })
  assert.equal(f.view()._ndWindMotion.t, f.observed.sync)
  f.sync(f.observed.sync + 50)
  assert.deepEqual(f.view()._ndWindMotion.position, { ...origin }, 'a later return to the birth position cannot revive the old flight phase')
})

test('a changed native motion at the birth position starts its actual new phase', t => {
  const f = fixture(t), reflected = velocity.scaled(-1)
  f.sync(f.observed.sync, origin, reflected)
  assert.deepEqual(f.view()._ndWindMotion.position, { ...origin })
  assert.deepEqual(f.view()._ndWindMotion.velocity, { ...reflected })
  assert.equal(f.view()._ndWindMotion.t, f.observed.sync)
})

test('after the first precise sync even a sub-LP-cell motion change cannot reuse the old phase', t => {
  const f = fixture(t)
  f.sync(f.observed.sync)
  const changed = velocity.offset(1e-8, 0, 0), time = f.observed.sync + 50
  f.sync(time, origin, changed)
  assert.deepEqual(f.view()._ndWindMotion.position, { ...origin })
  assert.deepEqual(f.view()._ndWindMotion.velocity, { ...changed })
  assert.equal(f.view()._ndWindMotion.t, time)
})

test('reacquiring a same-birth sync cannot revive motion from the hidden interval', t => {
  const f = fixture(t), read = f.bot.blockAt
  f.sync(f.observed.sync)
  f.bot.blockAt = p => { const b = read(p); b.shapes = [[0, 0, 0, 1, 1, 1]]; b.boundingBox = 'block'; return b }
  assert.equal(f.view(), null)
  f.bot.blockAt = read
  const time = f.observed.sync + 250
  f.sync(time)
  assert.deepEqual(f.view()._ndWindMotion.position, { ...origin }, 'a new visible baseline starts at its actual received position')
  assert.equal(f.view()._ndWindMotion.t, time)
})
