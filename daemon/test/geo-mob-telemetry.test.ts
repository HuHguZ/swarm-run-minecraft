import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
import { bodySnapshot } from '../src/gamedata'

test('body telemetry records nearby mob poses and creeper charge, excluding players', () => {
  const keys = registry.entitiesByName.creeper.metadataKeys, metadata = []
  metadata[keys.indexOf('swell_dir')] = 1; metadata[keys.indexOf('is_powered')] = true
  const e = { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) }
  const mob = { id: 2, name: 'creeper', type: registry.entitiesByName.creeper.type, position: new Vec3(2.4, 64, 0), velocity: new Vec3(.1, 0, 0), metadata }
  const bot = { entity: e, registry, entities: { 1: e, 2: mob,
    3: { id: 3, type: 'player', position: new Vec3(1, 64, 0) },
    4: { id: 4, type: 'mob', position: new Vec3(20, 64, 0) } } }
  assert.equal(mob.type, 'hostile')
  const snapshot = bodySnapshot(bot)
  assert.equal(snapshot.mobs.length, 1)
  assert.deepEqual(snapshot.mobs[0], { id: 2, kind: 'creeper', p: [2.4, 64, 0], v: [.1, 0, 0], sw: 1, charged: true })
  mob.position.x = 8
  assert.equal(snapshot.mobs[0].p[0], 2.4)
})
