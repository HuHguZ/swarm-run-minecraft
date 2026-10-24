import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Vec3 } from 'vec3'
import { swarmSightings, placementPoses } from '../src/swarm-senses'

test('swarm sight uses duel rays, never enemy health, inventory or enchantment levels', () => {
  const metadata = []
  Object.defineProperty(metadata, 9, { get() { throw new Error('enemy health read') } })
  const item = { name: 'diamond_sword', get count() { throw new Error('stack count read') }, get ench() { throw new Error('ench read') } }
  const enemy = { id: 2, username: 'Foe', type: 'player', position: new Vec3(3, 64, 0), metadata, equipment: [item, null, { name: 'iron_boots' }], get inventory() { throw new Error('inventory read') } }
  let wall = false
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: enemy }, blockAt(p) { return wall && p.x === 1 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty' } } }
  const seen = swarmSightings(bot)
  assert.equal(seen[0].id, 'Foe')
  assert.deepEqual(seen[0].equipment, { weapon: 'diamond_sword', armor: ['iron_boots'] })
  assert.equal('hp' in seen[0], false)
  wall = true
  enemy.position = new Vec3(3, 64, 2)
  // За стеной — только ник: место без снаряжения из пакетов и не видимая цель.
  const tag = swarmSightings(bot)
  assert.deepEqual(tag.map(e => [e.id, e.visible, e.nametag]), [['Foe', false, true]])
  assert.deepEqual(tag[0].position, { x: 3, y: 64, z: 2 })
})

test('a sneaking or invisible player behind a wall shows no nametag', () => {
  const flags = { 0: 0 }
  const enemy = { id: 2, username: 'Foe', type: 'player', position: new Vec3(3, 64, 0), metadata: flags, equipment: [] }
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: enemy }, blockAt: () => ({ name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }) }
  assert.equal(swarmSightings(bot).length, 1)
  flags[0] = 0x02
  assert.deepEqual(swarmSightings(bot), [])
  flags[0] = 0x20
  assert.deepEqual(swarmSightings(bot), [])
})

test('unknown chunks and failed rays cannot reveal an enemy', () => {
  const enemy = { id: 2, username: 'Foe', type: 'player', position: new Vec3(3, 64, 0) }
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: enemy }, blockAt() { return null } }
  // Неизвестный чанк и сорванный луч не дают прямой видимости — только ник.
  assert.deepEqual(swarmSightings(bot).filter(e => e.visible), [])
  bot.blockAt = () => { throw new Error('unloaded') }
  assert.deepEqual(swarmSightings(bot).filter(e => e.visible), [])
})

test('known swarm allies are excluded before visibility, position or equipment reads while enemies remain observed', () => {
  let allyReads = 0
  const ally = { id: 2, username: 'Ally',
    get position() { allyReads++; throw new Error('excluded ally position') },
    get equipment() { allyReads++; throw new Error('excluded ally gear') } }
  const enemy = { id: 3, username: 'Foe', type: 'player', position: new Vec3(3, 64, 0), equipment: [{ name: 'iron_sword' }] }
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: ally, 3: enemy }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
  const seen = swarmSightings(bot, ['Ally'])
  assert.equal(allyReads, 0)
  assert.deepEqual(seen.map(e => e.id), ['Foe'])
  assert.equal(seen[0].equipment.weapon, 'iron_sword')
})

test('30-player status observation skips ally rays with an unchanged enemy projection', t => {
  let reads = 0
  const entities = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 2, {
    id: i + 2, username: i < 29 ? `Ally${i}` : 'Foe', type: 'player',
    position: new Vec3(3 + i % 8, 64, Math.floor(i / 8)), equipment: [{ name: 'iron_sword' }]
  }]))
  const allies = Object.values(entities).filter(e => e.username !== 'Foe').map(e => e.username)
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities, blockAt() { reads++; return { name: 'air', boundingBox: 'empty' } } }
  const run = (excluded: string[]) => {
    reads = 0
    const start = performance.now()
    let seen: any[] = []
    for (let i = 0; i < 30; i++) seen = swarmSightings(bot, excluded)
    return { seen, reads, ms: performance.now() - start }
  }
  swarmSightings(bot)
  const baseline = run([]), filtered = run(allies)
  assert.equal(baseline.seen.length, 30)
  assert.equal(filtered.seen.length, 1)
  assert.deepEqual(filtered.seen[0].equipment, baseline.seen.find(e => e.id === 'Foe').equipment)
  assert.ok(filtered.reads < baseline.reads / 20, 'known allies incur no sight or gear rays')
  t.diagnostic(JSON.stringify({ polls: 30, baseline: { rays: baseline.reads, ms: baseline.ms }, filtered: { rays: filtered.reads, ms: filtered.ms } }))
})

test('placement poses move around an occluded corner using observed, supported body space', () => {
  const bot = { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: {}, blockAt(p) {
    const solid = p.y === 63 || p.x === 1 && p.z === 0 && p.y >= 64 && p.y <= 65
    return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  } }
  const poses = placementPoses(bot, { x: 2, y: 64, z: 1 })
  assert.ok(poses.length)
  assert.ok(poses.every(p => !(p.x > 1 && p.x < 2 && p.z > 0 && p.z < 1)), 'no stance inside the blocking wall')
  assert.ok(poses.some(p => p.z > 1), 'side stance exposes a real floor face at the target')
  assert.deepEqual(placementPoses({ ...bot, blockAt: () => null }, { x: 2, y: 64, z: 1 }), [])
})
