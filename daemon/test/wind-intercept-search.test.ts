import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as edges from '../src/edges'
import * as team from '../src/combat/team-wind'
import { enemyWindShot } from '../src/combat/enemy-wind'
import { wall } from '../src/game-clock'

function fixture() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const block = (p: Vec3, name: string) => { const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p.floored(); return b }
  const world = { getBlock: (p: Vec3) => block(p, p.y < 1 ? 'stone' : 'air') }
  const bot: any = { version: '1.21.11', registry, game: { minY: -64, height: 384 }, food: 20,
    inventory: { slots: [], items: () => [] }, entities: {}, ndClock: { age: 100n, ticks: 0, serverTicks: 0 },
    entity: { id: 1, username: 'Blue', position: new Vec3(0, 10, .5), velocity: new Vec3(0, 0, 0), onGround: false, attributes: {}, effects: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 }
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, world)
  const state = (position: Vec3, velocity: Vec3) => edges.stateOf({ ...bot, entity: { position, velocity, onGround: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {}, _ndPoseHeight: 1.8 } }, edges.IDLE)
  const own = state(new Vec3(0, 10, .5), new Vec3(-1.5, -.5, 0)), previous = own.pos.clone()
  edges.simOf(bot)(own, world)
  const report = { id: 'Blue', position: own.pos.clone(), velocity: own.vel.clone(), launchMovement: own.pos.minus(previous), onGround: own.onGround, gameTick: 100 }
  bot.entity.position = own.pos.clone(); bot.entity.velocity = own.vel.clone()
  const foe = { id: 2, width: .6, height: 1.8 }, target = state(new Vec3(1.5, 9.5, .5), new Vec3(-.5, -.5, 0)), frames = []
  for (let tick = 0; tick <= 65; tick++) {
    frames.push({ pos: target.pos.clone(), vel: target.vel.clone(), onGround: target.onGround })
    if (tick < 65) edges.simOf(bot)(target, world)
  }
  return { bot, report, foe, frames, block }
}

test('a failed first time guess still finds the known native airborne interception', t => {
  const f = fixture(), from = f.report.position.offset(0, 1.62, 0), nativeLaunch = team.windLaunch
  assert.equal(nativeLaunch(from, f.frames[3].pos.offset(0, .4, 0), f.report.launchMovement), null)
  const oracle = nativeLaunch(from, f.frames[9].pos.offset(0, .4, 0), f.report.launchMovement)!
  assert.ok(oracle)
  // Only propose the independently known ray; the ordinary kernel still checks native bodies and all blockers.
  const proposal = t.mock.method(team, 'windLaunch', () => oracle)
  const known = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4 })!
  proposal.mock.restore()
  assert.ok(known); assert.equal(known.ticks, 7); assert.equal(f.frames[7].onGround, false)
  const top = f.frames[7].pos.y + Math.fround(1.8) + Math.fround((known.ticks - 2) / 20)
  const nativeBurst = from.plus(oracle.velocity.scaled((top - from.y) / oracle.velocity.y))
  assert.ok(known.burst.distanceTo(nativeBurst) < 1e-12)
  const found = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4 })
  assert.ok(found, 'a physically valid supplied-frame interception cannot be lost to one unreachable time guess')
  assert.equal(found.ticks, 7); assert.ok(found.burst.equals(known.burst))
  assert.equal(found.aimHeight, .4)
})

for (const mode of ['wall', 'unknown', 'reported ally', 'native ceiling']) test(`fallback interception retains ${mode} rejection`, () => {
  const f = fixture(), normal = f.bot.blockAt
  if (mode === 'wall' || mode === 'unknown') f.bot.blockAt = p =>
    Math.floor(p.y) === 8 ? mode === 'wall' ? f.block(p, 'stone') : null : normal(p)
  if (mode === 'reported ally') f.bot.entities[3] = { id: 3, username: 'RadioAlly', type: 'player',
    position: new Vec3(-1.54, 8.1, .5), width: .6, height: 1.8, _ndReportedAlly: true }
  if (mode === 'native ceiling') f.bot.game = { minY: -64, height: 44 }
  assert.equal(enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4 }), null)
})

test('a valid ordinary ray keeps its native contact and uses its existing four proposals', t => {
  const f = fixture(), native = team.windLaunch
  f.bot.entity.position = new Vec3(0, 1, .5)
  const own = { id: 'Blue', position: f.bot.entity.position, velocity: new Vec3(.2, 0, 0), launchMovement: new Vec3(.2, 0, 0), onGround: true }
  const frames = Array.from({ length: 66 }, () => ({ pos: new Vec3(4, 1, .5), vel: new Vec3(0, 0, 0), onGround: true }))
  let calls = 0
  t.mock.method(team, 'windLaunch', (...args: Parameters<typeof team.windLaunch>) => { calls++; return native(...args) })
  const shot = enemyWindShot(f.bot, f.foe, own, frames, { height: .4 })
  assert.equal(JSON.stringify(shot), '{"thrower":"Blue","fireDelay":0,"ticks":3,"from":{"x":0,"y":2.62,"z":0.5},"aim":{"x":4,"y":1.4,"z":0.5},"aimHeight":0.4,"yaw":-1.5707963267948966,"pitch":-0.33494509472897316,"velocity":{"x":1.6166425390542603,"y":-0.49307597441154943,"z":0},"burst":{"x":3.649999987334013,"y":1.506750003863126,"z":0.5},"feet":{"x":4,"y":1,"z":0.5}}')
  assert.equal(calls, 4, 'an already valid proposal does not trigger extra search')
})

test('the final supplied native body tick remains available without inventing the absent next tick', () => {
  const f = fixture(); f.bot.entity.position = new Vec3(0, 1, .5)
  const own = { id: 'Blue', position: f.bot.entity.position, velocity: new Vec3(0, 0, 0), onGround: true }
  const frames = Array.from({ length: 66 }, () => ({ pos: new Vec3(97, 1, .5), vel: new Vec3(0, 0, 0), onGround: true }))
  assert.equal(enemyWindShot(f.bot, f.foe, own, frames, { height: .4 })?.ticks, 65)
  assert.equal(enemyWindShot(f.bot, f.foe, own, frames.slice(0, 65), { height: .4 }), null)
})

test('a stationary target behind a wall does not repeat the identical native ray at every tick', t => {
  const f = fixture(), native = team.windLaunch, normal = f.bot.blockAt
  f.bot.entity.position = new Vec3(0, 1, .5)
  f.bot.blockAt = p => Math.floor(p.x) === 2 && p.y >= 1 ? f.block(p, 'stone') : normal(p)
  const own = { id: 'Blue', position: f.bot.entity.position, velocity: new Vec3(0, 0, 0), onGround: true }
  const frames = Array.from({ length: 66 }, () => ({ pos: new Vec3(4, 1, .5), vel: new Vec3(0, 0, 0), onGround: true }))
  let calls = 0
  t.mock.method(team, 'windLaunch', (...args: Parameters<typeof team.windLaunch>) => { calls++; return native(...args) })
  assert.equal(enemyWindShot(f.bot, f.foe, own, frames, { height: .4 }), null)
  assert.equal(calls, 4, 'the fallback has no different aim to check')
})

test('fallback extends each reported ally once and still stops at the actual deadline', t => {
  const f = fixture(), native = f.bot.physics.simulatePlayer, states = new Set(), allies = Array.from({ length: 19 }, (_, i) => ({
    id: `Ally${i}`, position: new Vec3(20 + i, 1, 20), velocity: new Vec3(0, 0, 0), onGround: true, gameTick: 100 }))
  let steps = 0
  t.mock.method(f.bot.physics, 'simulatePlayer', (state, world) => { states.add(state); steps++; return native(state, world) })
  assert.ok(enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4, allies }))
  assert.equal(states.size, allies.length, 'alternative rays share one native track per ally')
  assert.ok(steps > 0 && steps <= allies.length * 65)
  let clock = 0
  t.mock.method(wall, 'monotonic', () => clock++)
  assert.equal(enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4, allies }, undefined, 5), null)
  assert.ok(clock <= 7, `an expired alternative search cannot keep working (${clock} clock checks)`)
})
