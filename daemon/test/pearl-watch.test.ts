import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
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
  const hidden = { ...bot, players: { Red: { entity: { ...foe, _ndVisible: false } } }, entities: { 11: { ...pearl, id: 11 } } }
  assert.deepEqual(enemyPearls(hidden), [], 'an unseen nearby player cannot identify an unowned pearl')
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

test('a pearl hitting a wind charge teleports to the start of that tick only over a visible drop', () => {
  const { pearlWindIntercept } = require('../src/combat/pearl-wind')
  const p = new Vec3(.5, 121.52, .5), v = new Vec3(0, 0, 1.5)
  let pos = p.clone(), speed = v.clone()
  for (let i = 0; i < 18; i++) { speed = speed.offset(0, -.03, 0).scaled(.99); pos = pos.plus(speed) }
  const pearl = { id: 9, name: 'ender_pearl', width: .25, height: .25, position: pos }
  const foe: any = { id: 2, username: 'Red', type: 'player', position: p.offset(0, -1.52, 0), onGround: true }
  const sky = { name: 'air', boundingBox: 'empty', shapes: [] }
  const bot: any = Object.assign(new EventEmitter(), { username: 'Blue', entity: { id: 1, position: new Vec3(5.5, 120, 34.1), onGround: true, velocity: new Vec3(0, 0, 0) },
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, blockAt: () => sky, entities: { 2: foe, 9: pearl },
    _ndThrown: new Map([[9, { name: pearl.name, p, v, gameTick: 482, owner: 2, own: false }]]), players: { Red: { entity: foe, gamemode: 0 } } })
  const plan = () => pearlWindIntercept(bot, 113, [foe], new WeakSet())
  const hit = plan()
  assert.ok(hit, 'two native trajectories cross over an open drop')
  assert.equal(hit.pearl, pearl)
  assert.ok(hit.at.y < 113)
  assert.equal(pearlWindIntercept(bot, 60, [foe], new WeakSet()), null, 'no imminent fall boundary')
  bot.entities[9] = { ...pearl, position: pos.offset(5, 0, 0) }
  assert.equal(plan(), null, 'visible course changed')
  bot.entities[9] = pearl
  bot._ndThrown.get(9).owner = 0
  assert.equal(plan(), null, 'a guessed owner cannot commit a charge')
  bot._ndThrown.get(9).owner = 2
  bot._ndThrown.get(9).gameTick = 484
  bot.entity.position = new Vec3(7.25, 120, 31.75)
  let frame = p.clone(), vel = v.clone()
  for (let i = 0; i < 16; i++) { vel = vel.offset(0, -.03, 0).scaled(.99); frame = frame.plus(vel) }
  pearl.position = frame
  foe._ndVisible = true
  foe._ndObservationNow = () => 5000
  foe._ndPositionReceipts = [4950, 5000].map(t => ({ ...foe.position, t, kind: 'rel_entity_move', grounded: true }))
  const drop = plan()
  assert.ok(drop && drop.at.y > 113 && drop.at.y < 114, 'interception can start above the plane')
  bot.blockAt = q => q.y === 112 && q.z >= 30 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : sky
  assert.equal(plan(), null, 'a shelf under the teleport catches the player above the death boundary')
})

test('a known wall beyond an unseen cell cannot supply a pearl arrival', () => {
  const { pearlLanding } = require('../src/combat/pearl-watch')
  const world = { blockAt(q) { return q.x === 1 ? null : floor.blockAt(new Vec3(q.x, q.x === 2 ? 0 : 2, q.z)) } }
  assert.equal(pearlLanding(world, new Vec3(.9, 2, .5), new Vec3(1.5, 0, 0)), null)
})

test('a water column damps a pearl before it reaches the floor', () => {
  const { pearlLanding } = require('../src/combat/pearl-watch')
  const p = new Vec3(.5, 2.5, .5), v = new Vec3(1, -.4, 0)
  const water = { name: 'water', boundingBox: 'empty', shapes: [] }
  const world = { blockAt(q) { return q.y > 0 ? water : floor.blockAt(q) } }
  const hit = pearlLanding(world, p, v)
  let pos = p.clone(), velocity = v.clone(), tick = 0
  do {
    tick++; velocity = velocity.offset(0, -.03, 0).scaled(.8)
    if (pos.y + velocity.y <= 1) break
    pos = pos.plus(velocity)
  } while (tick < 120)
  assert.equal(hit?.tick, tick)
  assert.ok(hit.at.distanceTo(pos) < 1e-8)
})
