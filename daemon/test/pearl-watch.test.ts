import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)

// Flat stone floor y = 0 (top at y = 1) over x −50..50.
const floor = { blockAt(p: Vec3) {
  const q = p.floored(), name = q.y === 0 && Math.abs(q.x) <= 50 && Math.abs(q.z) <= 50 ? 'stone' : q.y < -5 ? null : 'air'
  if (!name) return null
  const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
} }

test('pearl landing follows the native gravity → drag → move order and stops on the first block', () => {
  const { pearlLanding } = require('../src/combat/pearl-watch')
  const from = new Vec3(0, 3, 0), v = new Vec3(1.5, .2, 0)
  const land = pearlLanding(floor, from, v)
  assert.ok(land)
  // Same integrator by hand: the hit tick is the first whose move segment reaches y = 1.
  let p = from.clone(), w = v.clone(), tick = 0
  while (true) { tick++; w = new Vec3(w.x, w.y - .03, w.z).scaled(.99); if (p.y + w.y <= 1) break; p = p.plus(w) }
  assert.equal(land.tick, tick)
  assert.ok(Math.abs(land.contact.y - 1) < 1e-6, JSON.stringify(land))
  assert.ok(land.contact.x > p.x && land.contact.x < p.x + w.x + 1e-9)
  // Owner appears at the pearl's position at the start of the hit tick (ThrownEnderpearl.onHit → oldPosition()).
  assert.ok(land.at.distanceTo(p) < 1e-9, JSON.stringify(land))
  // Thrown over the edge into unknown cells: no confident landing.
  assert.equal(pearlLanding(floor, new Vec3(45, 3, 0), new Vec3(2, .4, 0)), null)
})

test('only a visible hostile pearl is reported, with its thrower guessed from the first sighting', () => {
  const { enemyPearls } = require('../src/combat/pearl-watch')
  const foe = { username: 'Red', position: new Vec3(5, 1, 0) }
  const pearl = { id: 9, name: 'ender_pearl', position: new Vec3(5, 2.8, 0), velocity: new Vec3(1, .3, 0) }
  const bot: any = { username: 'Blue', entity: { position: new Vec3(0, 1, 0), height: 1.8 }, blockAt: (p: Vec3) => floor.blockAt(p),
    entities: { 9: pearl }, players: { Red: { entity: foe }, Blue: {} } }
  bot.players.Blue.entity = bot.entity
  const seen = enemyPearls(bot)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].owner, 'Red')
  // Point of appearance — the pearl one step before touching the floor (oldPosition), so above y = 1 by less than a step.
  assert.ok(seen[0].eta > 0 && seen[0].at.y >= 1 && seen[0].at.y < 2.6, JSON.stringify(seen[0]))
  const ally: any = { ...bot, _ndSwarmAllies: ['Red'], entities: { 10: { ...pearl, id: 10 } } }
  assert.equal(enemyPearls(ally).length, 0, 'a teammate pearl is not an ambush target')
})

test('visible native pearl birth owns the arrival position and its original server deadline', () => {
  const { enemyPearls, pearlLanding } = require('../src/combat/pearl-watch')
  const red = { id: 2, username: 'Red', type: 'player', position: new Vec3(6, 1, 0) }
  const pearl = { id: 9, name: 'ender_pearl', position: new Vec3(9, 4, 0), velocity: new Vec3(0, .9, 0) }
  const p = new Vec3(6, 3, 0), v = new Vec3(1, .22, 0), expected = pearlLanding(floor, p, v)
  assert.ok(expected && expected.tick > 5)
  const bot: any = { username: 'Blue', entity: { id: 1, position: new Vec3(0, 1, 0), height: 1.8 },
    ndClock: { age: 500n, serverTicks: 0, ticks: 0 }, blockAt: (q: Vec3) => floor.blockAt(q),
    entities: { 2: red, 9: pearl }, players: { Red: { entity: red } },
    _ndThrown: new Map([[pearl.id, { name: pearl.name, owner: red.id, p, v, gameTick: 495 }]]) }
  const [report] = enemyPearls(bot)
  assert.deepEqual(report.at, Object.fromEntries(['x', 'y', 'z'].map(k => [k, +expected.at[k].toFixed(2)])))
  assert.equal(report.gameTick, 500)
  assert.equal(report.eta, expected.tick - 5)
  bot.ndClock.ticks = expected.tick
  assert.deepEqual(enemyPearls(bot), [], 'a still-rendered but already arrived projectile cannot extend its own deadline')
})

test('stasis trap: a near-vertical pearl is held by a 3-deep bubble column; a 45° pearl and a 1-deep column are not', () => {
  const { pearlStasis } = require('../src/combat/pearl-watch')
  const entry = { x: 10.5, y: 63.9, z: 10.5 }
  assert.equal(pearlStasis(entry, { x: .02, y: -.6, z: 0 }, 3).caught, true)
  assert.equal(pearlStasis(entry, { x: .02, y: -.6, z: 0 }, 1).caught, false, 'one water block cannot stop it before the sand')
  assert.equal(pearlStasis(entry, { x: .7, y: -.7, z: 0 }, 3).why, 'left_column')
})
