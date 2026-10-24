import { test } from 'node:test'
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { observeTactics } from '../src/tactics/minecraft'
import { inspect } from '../src/combat-safety'
import * as clock from '../src/game-clock'

function field() {
  const bot: any = new EventEmitter()
  Object.assign(bot, { username: 'Body', version: '1.21.11', health: 20, food: 20,
    registry: require('minecraft-data')('1.21.11'), game: { dimension: 'overworld' },
    entity: { id: 1, username: 'Body', position: new Vec3(0, 64, 0), height: 1.8, onGround: true, yaw: 0, metadata: [0], effects: {} },
    inventory: { slots: [], items: () => [{ name: 'stone_sword', count: 1, maxDurability: 131, durabilityUsed: 0 }] },
    teamMap: { Body: { team: 'blue' }, Friend: { team: 'blue' }, Enemy: { team: 'red' } },
    getControlState: () => false,
    blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored() }) })
  const friend = { id: 2, name: 'player', username: 'Friend', isValid: true, position: new Vec3(0, 64, -2), height: 1.8 }
  const enemy = { ...friend, id: 3, username: 'Enemy', position: new Vec3(2, 64, 0) }
  bot.entities = { 2: friend, 3: enemy }
  return { bot, friend, enemy, session: { bot, mcData: bot.registry, bus: { emit() {} } } as any }
}

for (const cause of ['nearby', 'wind_hit', 'stale_target']) test(`friendly ${cause} never becomes a tactical enemy`, () => {
  const { session, friend, enemy } = field()
  if (cause === 'wind_hit') session.autopilot = { lastHurt: { at: clock.now(), sourceId: friend.id, type: 'wind_charge', byMob: true, dimension: 'overworld' } }
  if (cause === 'stale_target') session.current = { name: 'fight', target: friend.username }
  const state = observeTactics(session)!
  assert.equal(state.enemies.some(e => e.id === friend.id), false)
  assert.equal(state.enemies.some(e => e.id === enemy.id), true)
  assert.equal(state.canFight, false)
  assert.equal(state.contact, false)
  assert.equal(session._tacticalShotAt, undefined)
})

test('an actual enemy hit still selects a threatening player', () => {
  const { session, enemy } = field()
  session.autopilot = { lastHurt: { at: clock.now(), sourceId: enemy.id, type: 'player_attack', byMob: true, dimension: 'overworld' } }
  assert.equal(observeTactics(session)!.enemies.find(e => e.id === enemy.id)?.threatening, true)
})

test('shared safety rejects explicit or listed allies while retaining enemies', () => {
  const { bot, friend, enemy } = field()
  assert.deepEqual(inspect(bot, { target: friend }).threats, [])
  assert.deepEqual(inspect(bot, { entities: [friend, enemy] }).threats.map(e => e.id), [enemy.id])
})
