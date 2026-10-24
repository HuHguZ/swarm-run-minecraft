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
  bot.entity = { id: 1, position: new Vec3(.5, 0, .5), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6 }
  bot.entities = {}; let wall = false; let reads = 0
  bot.blockAt = p => {
    reads++
    const solid = wall && p.x === 3
    return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  let velocity = { x: -3, y: 0, z: 0 }
  t.mock.method((require('../src/drops') as typeof import('../src/drops')), 'velocityFromRaw', () => velocity)
  const forecast = (foes: string[] | null = []) => (threats as any).projectileDangers(bot, { foes })
  forecast()
  const spawn = (id, name = 'arrow', owner = 99, z = .5) => {
    bot.entities[id] = { id, name, position: new Vec3(6.5, 1, z), height: .25, width: .25 }
    bot._client.emit('packet', { entityId: id, type: bot.registry.entitiesByName[name].id,
      x: 6.5, y: 1, z, objectData: owner }, { name: 'spawn_entity' }, Buffer.alloc(0))
  }
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  return { bot, timer, forecast, spawn, wall: v => { wall = v }, reads: () => reads, velocity: v => { velocity = v } }
}

test('light projectile polling does not scan floor, lava, webs or blast cells', t => {
  const f = scene(t)
  assert.equal(f.reads(), 0)
  assert.deepEqual(f.forecast(), { arrows: [], potions: [], aims: [] })
  assert.equal(f.reads(), 0)
})

test('one physical tick reuses the scoped forecast instead of casting the same rays again', t => {
  const f = scene(t); f.spawn(10); f.bot.ndClock = f.timer
  const first = f.forecast(), before = f.reads()
  for (let i = 0; i < 100; i++) assert.equal(f.forecast().arrows, first.arrows)
  assert.equal(f.reads(), before)
  f.timer.advanceTicks(1); f.forecast()
  assert.ok(f.reads() > before)
})

test('spawn trajectory intersects the moving body between ticks and reports its native source', t => {
  const f = scene(t); f.spawn(10)
  const [hit] = f.forecast().arrows
  assert.equal(hit.id, 10); assert.equal(hit.name, 'arrow'); assert.equal(hit.blockable, true)
  assert.ok(hit.ticks > 0 && hit.ticks <= 3)
  assert.deepEqual(hit.from, { x: 6.5, y: 1, z: .5 })
  assert.equal(Math.abs(hit.side.z), 1)
  f.bot.entity.velocity.z = .8
  assert.equal(f.forecast().arrows.length, 0, 'running away from the crossing needs no extra dodge')
  delete f.bot.entities[10]; f.bot._ndThrown.delete(10)
  f.spawn(11, 'arrow', 99, 2.5)
  assert.equal(f.forecast().arrows.length, 1, 'running into a future crossing is still a threat')
})

test('all damaging flight families reuse the same forecast; splash and wind cannot be solved by a shield', t => {
  const f = scene(t)
  const names = ['arrow', 'trident', 'wind_charge', 'breeze_wind_charge', 'splash_potion', 'fireball', 'dragon_fireball']
  for (const [i, name] of names.entries()) f.spawn(i + 10, name)
  const result = f.forecast().arrows
  assert.deepEqual(result.map(a => a.name).sort(), [...names].sort())
  for (const a of result) assert.equal(a.blockable, !/(?:potion|wind_charge|dragon_fireball)$/.test(a.name), a.name)
})

test('own and known allied shots are excluded, unknown owner remains an observable threat', t => {
  const f = scene(t)
  f.bot.entities[2] = { id: 2, type: 'player', username: 'Ally', position: new Vec3(6.5, 0, .5), height: 1.8 }
  f.spawn(10, 'arrow', 1); f.spawn(11, 'arrow', 2); f.spawn(12)
  assert.deepEqual(f.forecast().arrows.map(a => a.id), [12])
})

test('a visible launch stops threatening behind a new collision block', t => {
  const f = scene(t); f.spawn(10)
  assert.equal(f.forecast().arrows.length, 1)
  f.wall(true)
  assert.deepEqual(f.forecast().arrows, [])
})

test('a currently occluded projectile cannot drive the body even if its remembered arc clears the obstacle', t => {
  const f = scene(t); f.velocity({ x: -.8, y: .25, z: 0 }); f.spawn(10)
  assert.equal(f.forecast().arrows.length, 1)
  const air = f.bot.blockAt
  let hidden = true
  f.bot.blockAt = p => hidden && p.x === 3 && p.y === 1
    ? { name: 'stone_slab', position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, .5, 1]] }
    : air(p)
  assert.deepEqual(f.forecast().arrows, [], 'current LOS is blocked although the launch arc passes over the slab')
  hidden = false
  assert.equal(f.forecast().arrows.length, 1, 'a visible projectile can drive the body again')
})

test('new visible motion corrects the launch forecast after a deflection or stop', t => {
  const f = scene(t); f.spawn(10)
  assert.equal(f.forecast().arrows.length, 1)
  f.timer.advanceTicks(1)
  f.bot.entities[10].position = new Vec3(3.5, 1, 1.5)
  assert.equal(f.forecast().arrows.length, 0, 'measured movement now misses the body')
  f.timer.advanceTicks(1)
  f.bot.entities[10]._ndPositionReceipts = [null, { t: 1100 }]
  assert.equal(f.forecast().arrows.length, 0, 'a zero-displacement native receipt stops the forecast')
})

test('fresh visible flight survives the launch tracker age limit, then a stop retires it', t => {
  const f = scene(t); f.spawn(10, 'trident'); f.forecast()
  f.timer.advanceTicks(60); f.bot.entities[10].position.x = 9.5
  f.forecast()
  f.timer.advanceTicks(1); f.bot.entities[10].position.x = 6.5
  assert.equal(f.forecast().arrows.length, 1, 'two fresh visible positions still predict flight after three seconds')
  assert.equal(f.bot._ndThrown.has(10), true)
  threats.dangers(f.bot, { foes: [] })
  assert.equal(f.bot._ndThrown.has(10), true, 'legacy observation cannot delete flight kept by the body layer')
  f.timer.advanceTicks(1)
  f.bot.entities[10]._ndPositionReceipts = [null, { t: 4100 }]
  assert.equal(f.forecast().arrows.length, 0)
  assert.equal(f.bot._ndThrown.has(10), false, 'an old stationary projectile does not stay in the launch tracker')
})

test('drawn bows are scoped and visible while an unloaded crossbow is not a shot threat', t => {
  const f = scene(t), flags = f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const foe: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Foe',
    position: new Vec3(6.5, 0, .5), yaw: Math.PI / 2, metadata: [], equipment: [{ name: 'bow' }], height: 1.8, width: .6 })
  foe.metadata[flags] = 1; f.bot.entities[2] = foe
  assert.deepEqual(f.forecast([]).aims, [])
  const [aim] = f.forecast(['Foe']).aims
  assert.equal(aim.id, 2); assert.equal(aim.name, 'Foe')
  assert.deepEqual(aim.from, { x: 6.5, y: 1.62, z: .5 })
  foe.metadata[flags] = 0; foe.equipment[0] = { name: 'crossbow' }
  assert.deepEqual(f.forecast(['Foe']).aims, [])
  foe.equipment[0].componentMap = new Map([['charged_projectiles', { data: { projectiles: [{ name: 'unknown' }] } }]])
  assert.equal(f.forecast(['Foe']).aims.length, 1)
  f.wall(true)
  assert.deepEqual(f.forecast(['Foe']).aims, [])
})
