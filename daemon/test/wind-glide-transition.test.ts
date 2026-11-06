import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { enemyWindFrames, installWindTracking, observeEnemyWindMotion } from '../src/combat/enemy-wind'
import { hasObservedVelocity } from '../src/bow/track'
import * as clock from '../src/game-clock'
import edges = require('../src/edges')

const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }

function fixture() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const blockAt = p => {
    const b = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sand' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  let now = 1000
  const raw: any = Object.assign(new EventEmitter(), {
    id: 99, username: 'Red', name: 'player', type: 'player', isValid: true, _ndVisible: true, _ndMotionEpoch: 1,
    _ndObservationNow: () => now, position: new Vec3(600.5, 150, 600.5), yaw: -Math.PI / 2, pitch: 0,
    onGround: false, width: .6, height: 1.8, metadata: [0], equipment: []
  })
  for (const key of ['velocity', 'health', 'hp', 'effects', 'attributes']) Object.defineProperty(raw, key, { get() { throw Error(`private target ${key}`) } })
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, username: 'Caster', health: 20, food: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, _client: new EventEmitter(),
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, blockAt, entities: { 99: raw }, players: { Red: { entity: raw, gamemode: 0 } },
    entity: { id: 1, username: 'Caster', position: new Vec3(598, 148, 607), velocity: new Vec3(0, 0, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} }
  })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: blockAt })
  const simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const state = (position: Vec3, velocity: Vec3, flying: boolean) => {
    const slots: any[] = []
    if (flying) slots[6] = { name: 'elytra' }
    return edges.stateOf({ ...bot, inventory: { slots, items: () => [] }, entity: {
      position, velocity, yaw: raw.yaw, pitch: raw.pitch, onGround: false, elytraFlying: flying, _ndPoseHeight: flying ? .6 : 1.8, effects: {}, attributes: {}
    } }, edges.IDLE)
  }
  const falling = state(raw.position, new Vec3(.72, -.23, .02), false)
  const receive = (time: number, kind = 'rel_entity_move', flying = false) => {
    now = time; raw.position = falling.pos.clone()
    const receipt = { ...falling.pos, t: time, kind, grounded: false, yaw: raw.yaw, pitch: raw.pitch, flying, revision: raw._ndGlideRevision || 0 }
    raw._ndPositionReceipts = [raw._ndPositionReceipts?.[1] || null, receipt]
    raw.emit('ndPositionObserved')
  }
  receive(1000, 'reacquired')
  simulate(falling, world); receive(1044)
  observeEnemyWindMotion(bot, raw)
  simulate(falling, world); simulate(falling, world); receive(1132)
  const certified = observeEnemyWindMotion(bot, raw)!
  assert.ok(certified.velocity.distanceTo(falling.vel) < 1 / 4096)
  const glide = () => {
    raw.metadata[0] = 128; raw.metadata[6] = 1; raw._ndGlideRevision = 1
  }
  return { bot, raw, certified, glide, receive, now: () => now, age: (ms: number) => { now += ms },
    actual: () => state(falling.pos, falling.vel, true), simulate, world }
}

test('a public glide transition carries the certified native endpoint on the unchanged fresh receipt', () => {
  const f = fixture(), receipt = f.raw._ndPositionReceipts[1]
  f.glide()
  const view = observeEnemyWindMotion(f.bot, f.raw)!
  assert.equal(f.raw._ndPositionReceipts[1], receipt)
  assert.ok(view.gliding && view.velocity.distanceTo(f.certified.velocity) < 1 / 4096)
  assert.equal(hasObservedVelocity(f.raw), false, 'the separate bow tracker has no post-transition velocity measurement')
  const actual = f.actual(), frames = enemyWindFrames(f.bot, f.raw, arena, [], 0, true)
  for (let tick = 1; tick <= 8; tick++) {
    f.simulate(actual, f.world)
    assert.ok(frames[tick].pos.distanceTo(actual.pos) < 1 / 4096, `glide continuation tick ${tick}`)
  }
})

for (const mode of ['expired', 'new receipt', 'visibility', 'epoch', 'target body', 'observer body', 'rocket'] as const) {
  test(`glide handoff does not carry a coast certificate across ${mode}`, () => {
    const f = fixture(); f.glide()
    if (mode === 'expired') f.age(50)
    if (mode === 'new receipt') f.receive(1133, 'rel_entity_move', true)
    if (mode === 'visibility') f.raw._ndVisible = false
    if (mode === 'epoch') f.raw._ndMotionEpoch++
    if (mode === 'target body') f.bot.players.Red.entity = { id: f.raw.id }
    if (mode === 'observer body') f.bot.entity = { ...f.bot.entity }
    if (mode === 'rocket') f.raw._ndGlideBoosted = true
    const view = observeEnemyWindMotion(f.bot, f.raw)
    assert.ok(!view || view.velocity.distanceTo(f.certified.velocity) > .1)
  })
}

test('returning to falling requires new physical history even on the same receipt', () => {
  const f = fixture(); f.glide()
  const view = observeEnemyWindMotion(f.bot, f.raw)!
  assert.ok(view.velocity.distanceTo(f.certified.velocity) < 1 / 4096)
  f.raw.metadata[0] = 0; f.raw.metadata[6] = 0; f.raw._ndGlideRevision++
  assert.equal(observeEnemyWindMotion(f.bot, f.raw), null)
})

test('a visible gust still requires fresh motion before an immediate glide forecast', t => {
  const f = fixture()
  t.mock.method(clock, 'observationNow', f.now)
  installWindTracking(f.bot)
  t.after(() => f.bot.emit('end'))
  f.bot._client.emit('explosion', { center: f.raw.position.offset(-.5, .6, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  f.glide()
  assert.equal(observeEnemyWindMotion(f.bot, f.raw), null)
})
