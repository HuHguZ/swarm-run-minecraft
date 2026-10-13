import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { windImpulse, windShot, windLanding, windSteer, teamWindPlan, worldTick, matchingBurst } from '../src/combat/team-wind'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

function fixture(extra: Array<[number, number, number, string]> = []) {
  const cells = new Map<string, any>()
  for (let x = -6; x <= 2; x++) for (let z = -3; z <= 3; z++) cells.set(`${x},0,${z}`, 'stone')
  for (const [x, y, z, name] of extra) cells.set(`${x},${y},${z}`, name)
  const world = { getBlock(p: Vec3) {
    const q = p.floored(); const name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: [], items: () => [] }, entities: {},
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  return { bot, cells, world }
}
const report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }

test('team wind: existing 1.21.11 burst physics uses feet distance, eye direction, cover and own resistance', () => {
  const { bot } = fixture()
  const feet = new Vec3(.5, 1, .5), center = new Vec3(.5, 1.25, .5)
  const kb = windImpulse(bot, feet, center)
  assert.equal(kb.x, 0); assert.equal(kb.z, 0)
  assert.ok(Math.abs(kb.y - (1 - .25 / 2.4) * 1.22) < 1e-10)
  assert.equal(windImpulse(bot, new Vec3(10, 1, .5), center).norm(), 0)
  assert.ok(Math.abs(windImpulse(bot, feet, center, { resistance: .5 }).y - kb.y / 2) < 1e-10)
  const blocked = fixture([[0, 1, 0, 'stone'], [0, 2, 0, 'stone']]).bot
  assert.equal(windImpulse(blocked, new Vec3(1.5, 1, .5), new Vec3(-.5, 1.25, .5)).norm(), 0)
})

test('team wind: a real charge ray hits visible floor, inherits shooter motion and cannot cross a solid wall', () => {
  const { bot } = fixture()
  const from = new Vec3(-2.5, 2.62, .5), aim = new Vec3(-.5, 1, .5)
  const shot = windShot(bot, from, aim, new Vec3(.1, 0, 0))!
  assert.ok(shot)
  assert.ok(shot.impact.distanceTo(aim) < 1e-6)
  assert.equal(shot.burst.y, 1.25)
  assert.equal(shot.normal.y, 1)
  const wall = fixture([[-2, 1, 0, 'stone'], [-2, 2, 0, 'stone']]).bot
  assert.equal(windShot(wall, from, aim, new Vec3(.1, 0, 0)), null)
  const observed = bot.blockAt
  bot.blockAt = p => p.x >= -1 ? null : observed(p)
  assert.equal(windShot(bot, from, aim, new Vec3(0, 0, 0)), null)
})

test('a third honestly visible body intercepts the charge before its floor burst; packet-only bodies do not inform planning', () => {
  const { bot } = fixture(), from = new Vec3(-2.5, 2.62, .5), aim = new Vec3(-.5, 1, .5)
  bot.entities[2] = { id: 2, username: 'blocker', type: 'player', position: new Vec3(-1.2, 1, .5), width: .6, height: 1.8 }
  assert.equal(windShot(bot, from, aim), null)
  const hidden = fixture([[0, 1, 0, 'stone'], [0, 2, 0, 'stone']]).bot
  hidden.entities = bot.entities
  assert.ok(windShot(hidden, from, aim), 'a receiver cannot use a hidden ally packet to predict interception')
  const source = fixture().bot
  source.entities[3] = { id: 3, username: report.id, type: 'player', position: new Vec3(-2.5, 1, .5), width: .6, height: 1.8 }
  assert.ok(windShot(source, from, aim, new Vec3(0, 0, 0), report.id), 'the reported thrower is the projectile owner')
})

test('team wind: landing confirms the chosen support, full clear body and six settled ticks instead of a one-block radius', () => {
  const { bot } = fixture([[4, 2, 0, 'stone'], [5, 2, 0, 'stone']])
  const target = new Vec3(4.5, 3, .5)
  assert.ok(windLanding(bot, { pos: target, vel: new Vec3(0, 0, 0), onGround: true }, target))
  assert.equal(windLanding(bot, { pos: new Vec3(5.2, 3, .5), vel: new Vec3(0, 0, 0), onGround: true }, target), false)
  assert.equal(windLanding(bot, { pos: target, vel: new Vec3(.2, 0, 0), onGround: true }, target), false)
  assert.equal(windLanding(bot, { pos: target, vel: new Vec3(0, 0, 0), onGround: false }, target), false)
  const fence = fixture([[4, 0, 0, 'oak_fence']]).bot
  assert.ok(windLanding(fence, { pos: new Vec3(4.5, 1.5, .5), vel: new Vec3(0, 0, 0), onGround: true }, new Vec3(4.5, 1.5, .5)))
})

test('team wind: native forecast reaches a chosen raised block, includes thrower recoil, refuses impossible and wall-blocked targets', () => {
  const { bot } = fixture([[4, 1, 0, 'stone'], [4, 2, 0, 'stone'], [4, 3, 0, 'stone']])
  const before = bot.entity.position.clone()
  const plan = teamWindPlan(bot, report, new Vec3(4.5, 4, .5))
  assert.ok(plan.best, JSON.stringify(plan))
  assert.ok(plan.best!.receiver.settled)
  assert.ok(plan.best!.thrower.safe)
  assert.ok(plan.best!.receiver.land.distanceTo(new Vec3(4.5, 4, .5)) < .23)
  assert.deepEqual(bot.entity.position, before, 'planning only clones native state')
  assert.equal(teamWindPlan(bot, report, new Vec3(20.5, 20, .5)).best, null)
  assert.equal(teamWindPlan(bot, report, new Vec3(4.5, 4, .5), { arena: { x: 0, z: 0, r: 4, killY: -3 } }).best, null)
  const wall = fixture([[-2, 1, 0, 'stone'], [-2, 2, 0, 'stone'], [4, 3, 0, 'stone']]).bot
  assert.equal(teamWindPlan(wall, report, new Vec3(4.5, 4, .5)).best, null)
})

test('team wind: world tick coordination ignores connection epoch and only the planned burst receipt is accepted', () => {
  assert.equal(worldTick({ ndClock: { epoch: 0, age: 500n, serverTicks: 20, ticks: 30 } }), 510)
  assert.equal(worldTick({ ndClock: { epoch: 999999, age: 500n, serverTicks: 40, ticks: 50 } }), 510)
  assert.equal(worldTick({ ndClock: { ticks: 30 } }), null)
  const burst = { x: -.5, y: 1.25, z: .5 }
  const packet = { radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, center: burst, playerKnockback: { x: .2, y: 1, z: 0 } }
  assert.ok(matchingBurst(packet, burst))
  assert.equal(matchingBurst({ ...packet, center: { ...burst, x: 7 } }, burst), false)
  assert.equal(matchingBurst({ center: burst }, burst), false)
  assert.equal(matchingBurst({ ...packet, radius: 4, explosionParticle: { type: 'explosion' } }, burst), false, 'enemy explosive at the same point is not the promised wind receipt')
  const { bot } = fixture()
  const shot = windShot(bot, new Vec3(-2.5, 2.62, .5), new Vec3(.1, 1, .5))!
  assert.ok(matchingBurst({ ...packet, center: shot.burst.offset(.099, 0, .02) }, shot.burst, shot), 'native triangular launch spread belongs to the projectile model')
  assert.equal(matchingBurst({ ...packet, center: shot.burst.offset(.6, 0, 0) }, shot.burst, shot), false)
})

test('wind feedback brakes actual dispersed impulses and centers on the intended support after edge contact', () => {
  const edges = require('../src/edges')
  for (const spread of [-.1, 0, .1]) {
    const { bot } = fixture([[4, 1, 0, 'stone'], [4, 2, 0, 'stone'], [4, 3, 0, 'stone']])
    const state = edges.stateOf(bot, edges.IDLE), simulate = edges.simOf(bot), world = edges.worldOf(bot), target = new Vec3(4.5, 4, .5)
    state.control = { ...edges.IDLE, jump: true }; simulate(state, world)
    state.control = { ...edges.IDLE }; simulate(state, world)
    state.vel = state.vel.plus(windImpulse(bot, state.pos, new Vec3(.1 + spread, 1.25, .5 + spread / 4)))
    let settled = 0
    for (let tick = 0; tick < 95 && settled < 6; tick++) {
      const input = windSteer(bot, state, target, { x: .5, z: .5, r: 8, killY: -2 })
      state.yaw = input.yaw; state.control = input.control; simulate(state, world)
      if (windLanding(bot, state, target)) settled++; else settled = 0
    }
    assert.equal(settled, 6, `spread ${spread}: ${state.pos}`)
  }
  const { bot } = fixture([[4, 3, 0, 'stone']])
  const state = edges.stateOf(bot, edges.IDLE), target = new Vec3(4.5, 4, .5)
  state.pos = new Vec3(5.17, 4, .55); state.vel = new Vec3(0, 0, 0); state.onGround = true
  const simulate = edges.simOf(bot), world = edges.worldOf(bot)
  for (let tick = 0; tick < 30; tick++) { const next = windSteer(bot, state, target); state.yaw = next.yaw; state.control = next.control; simulate(state, world) }
  assert.ok(windLanding(bot, state, target), `edge contact must move toward the center: ${state.pos}`)
})

test('self wind uses the same forecast and exact landing receipt; unsupported and outside-arena targets refuse', () => {
  const self = require('../src/wind-leap')
  const { bot } = fixture([[4, 1, 0, 'stone'], [4, 2, 0, 'stone'], [4, 3, 0, 'stone']])
  const target = new Vec3(4.5, 4, .5)
  const result = self.plan(bot, target)
  assert.ok(result.best)
  assert.ok(result.best.settled)
  assert.ok(windLanding(bot, { pos: result.best.land, vel: new Vec3(0, 0, 0), onGround: true }, target))
  assert.equal(self.plan(bot, new Vec3(5.5, 4, .5)).best, null)
  assert.equal(self.plan(bot, target, { arena: { x: 0, z: 0, r: 4, killY: -3 } }).best, null)
})
