import { test } from 'node:test'
import assert = require('node:assert/strict')
import { lookDead } from '../src/pvp/body'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as duo from '../src/duo'

for (const identity of [{ username: 'Enemy' }, { name: 'player' }, { type: 'player' }]) {
  test(`player death uses its event, never private health (${Object.keys(identity)[0]})`, () => {
    let reads = 0
    const metadata: any[] = []
    Object.defineProperty(metadata, 9, { get: () => { reads++; return 0 } })
    const bot = { registry: { entitiesByName: { player: { metadataKeys: [] }, unknown: { metadataKeys: [] } } } }
    assert.equal(lookDead(bot, { name: 'unknown', ...identity, metadata }), false)
    assert.equal(reads, 0)
  })
}

test('mob health still confirms death', () => {
  const bot = { registry: { entitiesByName: { zombie: { metadataKeys: [] } } } }
  assert.equal(lookDead(bot, { name: 'zombie', metadata: { 9: 0 } }), true)
  assert.equal(lookDead(bot, { name: 'zombie', metadata: { 9: 20 } }), false)
})

test('duo retains a player without reading health, then removes it on a confirmed death', () => {
  const bot: any = new EventEmitter()
  let reads = 0
  const metadata: any[] = []
  Object.defineProperty(metadata, 9, { get: () => { reads++; return 0 } })
  const enemy = { id: 2, name: 'player', type: 'player', username: 'Enemy', isValid: true, position: new Vec3(0, 64, 2), metadata }
  Object.assign(bot, { username: 'Body', health: 20, version: '1.21.11', registry: require('minecraft-data')('1.21.11'),
    entity: { id: 1, position: new Vec3(0, 64, 0) }, players: { Enemy: { entity: enemy } } })
  const dead = new Set<number>(), fight = duo.create(bot, { target: () => enemy, dead })
  try {
    assert.deepEqual(fight.foes(), [enemy])
    assert.equal(reads, 0)
    dead.add(enemy.id)
    assert.deepEqual(fight.foes(), [])
  } finally { fight.close() }
})
