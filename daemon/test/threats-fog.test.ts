import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import threats = require('../src/threats')

function scene(t) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter(); bot._client = new EventEmitter()
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 0, .5), height: 1.8 }
  let wall = false
  bot.blockAt = p => ({ name: wall && p.x === 1 ? 'stone' : 'air', position: p,
    boundingBox: wall && p.x === 1 ? 'block' : 'empty', shapes: wall && p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.entities = {}
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  return { bot, timer, wall: v => { wall = v; bot.emit('physicsTick') } }
}

function player(bot, id: number, username: string, weapon = 'bow') {
  const e: any = Object.assign(new EventEmitter(), { id, type: 'player', name: 'player', username,
    position: new Vec3(4.5, 0, .5), yaw: Math.PI / 2, metadata: [], equipment: [{ name: weapon }], height: 1.8, width: .6 })
  e.metadata[bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = 1
  bot.entities[id] = e
  return e
}

test('an explicit empty enemy list skips allied player getters and never registers a vision listener', t => {
  const f = scene(t), ally = player(f.bot, 2, 'Ally')
  let reads = 0
  for (const key of ['position', 'equipment', 'metadata']) Object.defineProperty(ally, key, { get() { reads++; throw new Error(`excluded ally ${key}`) } })
  const danger = threats.dangers(f.bot, { foes: [] })
  assert.equal(reads, 0)
  assert.deepEqual(danger.aims, []); assert.deepEqual(danger.holders, []); assert.deepEqual(danger.smashes, [])
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(ally.listenerCount('ndPositionObserved'), 0)
})

test('enemy-list scopes preserve legacy defaults and stable arrays, then release obsolete player observations', t => {
  const f = scene(t), ally = player(f.bot, 2, 'Ally'), foe = player(f.bot, 3, 'Foe')
  assert.equal(threats.dangers(f.bot).aims.length, 2, 'omitted list retains legacy behavior')
  const cleanups = f.bot.listeners('end')
  assert.deepEqual(threats.dangers(f.bot, { foes: ['Foe'] }).aims.map(e => e.name), ['Foe'])
  assert.equal(ally.listenerCount('ndPositionObserved'), 0)
  assert.equal(foe.listenerCount('ndPositionObserved'), 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 1)
  const update = foe.listeners('ndPositionObserved')[0]
  f.timer.advanceTicks(1); foe.position.x = 4
  threats.dangers(f.bot, { foes: ['Foe', 'Foe'] })
  assert.equal(foe.listeners('ndPositionObserved')[0], update, 'same names keep the original motion observer')
  assert.deepEqual(f.bot.listeners('end'), cleanups, 'scope changes retain the same player-vision and projectile cleanup callbacks')
  let reads = 0
  Object.defineProperty(ally, 'position', { get() { reads++; throw new Error('obsolete ally pose') } })
  f.bot.emit('physicsTick')
  assert.equal(reads, 0)
  threats.dangers(f.bot, { foes: [] })
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(foe.listenerCount('ndPositionObserved'), 0)
  assert.deepEqual(f.bot.listeners('end'), cleanups)
  assert.equal(f.bot.listenerCount('entitySpawn'), 1)
  assert.equal(f.bot._client.listenerCount('sync_entity_position'), 1)
  f.bot.emit('end')
  assert.equal(f.bot.listenerCount('entitySpawn'), 0, 'disconnect removes the projectile spawn hook')
  assert.equal(f.bot._client.listenerCount('sync_entity_position'), 0, 'disconnect removes the native motion hook')
  assert.equal(f.bot.listenerCount('end'), 0)
})

test('reordered equal enemy lists retain the same observed motion callbacks', t => {
  const f = scene(t), a = player(f.bot, 2, 'A'), b = player(f.bot, 3, 'B')
  threats.dangers(f.bot, { foes: ['A', 'B'] })
  const cleanups = f.bot.listeners('end')
  const observedA = a.listeners('ndPositionObserved')[0], observedB = b.listeners('ndPositionObserved')[0]
  f.timer.advanceTicks(1); a.position.x -= .2; b.position.x -= .1
  for (let i = 0; i < 10; i++) threats.dangers(f.bot, { foes: i & 1 ? ['A', 'B'] : ['B', 'A', 'B'] })
  assert.equal(a.listeners('ndPositionObserved')[0], observedA)
  assert.equal(b.listeners('ndPositionObserved')[0], observedB)
  assert.equal(f.bot.listenerCount('physicsTick'), 1)
  assert.deepEqual(f.bot.listeners('end'), cleanups, 'repeated reordered polls cannot accumulate cleanup callbacks')
})

test('29-allied-player danger polling removes both immediate and persistent observation work', t => {
  const f = scene(t)
  for (let i = 0; i < 29; i++) player(f.bot, i + 2, `Ally${i}`)
  let reads = 0
  const blockAt = f.bot.blockAt
  f.bot.blockAt = p => { reads++; return blockAt(p) }
  const run = (options = {}) => {
    reads = 0
    const start = performance.now()
    for (let i = 0; i < 30; i++) { threats.dangers(f.bot, options); f.bot.emit('physicsTick') }
    return { blockReads: reads, ms: performance.now() - start, visionTicks: f.bot.listenerCount('physicsTick') }
  }
  threats.dangers(f.bot)
  const baseline = run(), filtered = run({ foes: [] })
  assert.ok(filtered.blockReads < baseline.blockReads / 10)
  assert.equal(baseline.visionTicks, 1)
  assert.equal(filtered.visionTicks, 0)
  t.diagnostic(JSON.stringify({ pollsAndTicks: 30, allies: 29, baseline, filtered }))
})

test('empty enemy lists retain unknown-owner arrows, potions, clouds and lava while skipping known allied shots', t => {
  const f = scene(t)
  let velocity = { x: -1.5, y: 0, z: 0 }
  t.mock.method((require('../src/drops') as typeof import('../src/drops')), 'velocityFromRaw', () => velocity)
  player(f.bot, 2, 'Ally')
  threats.dangers(f.bot, { foes: [] })
  const spawn = (id: number, name: string, owner: number, x: number) => {
    f.bot.entities[id] = { id, name, position: new Vec3(x, 1.6, .5), height: .25, width: .25 }
    f.bot._client.emit('packet', { entityId: id, type: f.bot.registry.entitiesByName[name].id, x, y: 1.6, z: .5, objectData: owner }, { name: 'spawn_entity' }, Buffer.alloc(0))
  }
  spawn(10, 'arrow', 99, 8)
  spawn(11, 'arrow', 2, 8)
  velocity = { x: -.08, y: .1, z: 0 }; spawn(12, 'splash_potion', 99, 3.5)
  f.bot.entities[13] = { id: 13, name: 'area_effect_cloud', position: new Vec3(.5, 0, .5), metadata: { 8: 3 } }
  const blockAt = f.bot.blockAt
  f.bot.blockAt = p => p.floored().equals(new Vec3(1, 0, 0)) ? { ...blockAt(p), name: 'lava', position: p.floored() } : blockAt(p)
  const danger = threats.dangers(f.bot, { foes: [] })
  assert.equal(danger.arrows.length, 1, 'unknown owner remains a threat; known ally is excluded')
  assert.equal(danger.potions.length, 1)
  assert.equal(danger.clouds.length, 1)
  assert.equal(danger.lava.length, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0, 'projectile predictions do not create player vision')
})

test('bow, mace and potion reflexes cannot observe a player behind a wall inside four blocks', t => {
  const f = scene(t)
  const foe = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Foe',
    position: new Vec3(2.5, 0, .5), yaw: Math.PI / 2, metadata: [], equipment: [{ name: 'bow' }], height: 1.8, width: .6 })
  const flags = f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  foe.metadata[flags] = 1; f.bot.entities[2] = foe
  f.wall(true)
  assert.deepEqual(threats.dangers(f.bot, { foes: ['Foe'] }).aims, [])
  f.wall(false)
  assert.equal(threats.dangers(f.bot, { foes: ['Foe'] }).aims.length, 1)
  foe.equipment = [{ name: 'mace' }]; foe.position.y = 3
  f.wall(true)
  assert.deepEqual(threats.dangers(f.bot, { foes: ['Foe'] }).smashes, [])
  f.wall(false)
  assert.equal(threats.dangers(f.bot, { foes: ['Foe'] }).smashes.length, 1)
  foe.position.y = 0
  foe.equipment = [{ name: 'splash_potion', componentMap: new Map([['potion_contents', { data: { potion: 'strong_healing' } }]]) }] as any
  f.wall(true)
  assert.deepEqual(threats.dangers(f.bot, { foes: ['Foe'] }).holders, [])
  f.wall(false)
  assert.equal(threats.dangers(f.bot, { foes: ['Foe'] }).holders.length, 1, 'unreadable contents remain an unknown throw threat')
})

test('unknown projectile spawn behind a wall cannot create a threat; observed motion works after acquisition', t => {
  const f = scene(t)
  t.mock.method((require('../src/drops') as typeof import('../src/drops')), 'velocityFromRaw', () => ({ x: -1.5, y: 0, z: 0 }))
  const e: any = { id: 2, name: 'arrow', position: new Vec3(8, 1.6, .5), height: .25, width: .25 }
  f.bot.entities[2] = e; f.wall(true)
  threats.dangers(f.bot)
  f.bot._client.emit('packet', { entityId: 2, type: f.bot.registry.entitiesByName.arrow.id, x: 8, y: 1.6, z: .5, objectData: 99 }, { name: 'spawn_entity' }, Buffer.alloc(0))
  assert.equal(f.bot._ndThrown.has(2), false)
  assert.deepEqual(threats.incoming(f.bot), [])
  f.wall(false)
  assert.deepEqual(threats.incoming(f.bot), [], 'hidden prior packets are not a measured velocity')
  f.timer.advanceTicks(1); e.position.x = 6.5
  assert.equal(threats.incoming(f.bot).length, 1)
  f.wall(true); e.position.x = -100; e.velocity = new Vec3(200, 0, 0)
  assert.deepEqual(threats.incoming(f.bot), [], 'unseen live position updates cannot redirect defence')
})

test('a visible mace holder cannot reveal an occluded supporting block', t => {
  const f = scene(t), baseAt = f.bot.blockAt
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', position: new Vec3(2.5, 5, .5),
    yaw: 0, metadata: [], equipment: [{ name: 'mace' }], height: 1.8, width: .6 }
  f.bot.entities[2] = foe
  f.bot.blockAt = p => p.floored().equals(new Vec3(2, 4, 0)) ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : baseAt(p)
  const support = t.mock.method((require('../src/pick') as typeof import('../src/pick')), 'blockSeen', () => false)
  assert.equal(threats.dangers(f.bot, { foes: ['Foe'] }).smashes.length, 1, 'unseen support cannot suppress the visible aerial threat')
  support.mock.mockImplementation(() => true)
  assert.equal(threats.dangers(f.bot, { foes: ['Foe'] }).smashes.length, 0, 'visibly standing on a roof is not a fall')
})

test('a seen launch retains its own prediction without hidden packet updates, and own launches are ignored', t => {
  const f = scene(t)
  t.mock.method((require('../src/drops') as typeof import('../src/drops')), 'velocityFromRaw', () => ({ x: -1.5, y: 0, z: 0 }))
  const e: any = { id: 2, name: 'arrow', position: new Vec3(8, 1.6, .5), height: .25, width: .25 }
  f.bot.entities[2] = e
  threats.dangers(f.bot)
  const spawn = owner => f.bot._client.emit('packet', { entityId: 2, type: f.bot.registry.entitiesByName.arrow.id, x: 8, y: 1.6, z: .5, objectData: owner }, { name: 'spawn_entity' }, Buffer.alloc(0))
  spawn(99)
  const initial = structuredClone(f.bot._ndThrown.get(2))
  const before = threats.dangers(f.bot).arrows
  assert.equal(before.length, 1)
  f.wall(true); e.position.x = 800; e.velocity = new Vec3(10, 10, 10)
  assert.deepEqual(threats.dangers(f.bot).arrows, before)
  assert.deepEqual(f.bot._ndThrown.get(2), initial)
  spawn(1)
  assert.deepEqual(threats.dangers(f.bot).arrows, [])
})
