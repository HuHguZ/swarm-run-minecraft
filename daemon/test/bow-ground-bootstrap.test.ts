import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { observedVelocity } from '../src/bow/track'
import { enemyWindFrames, planEnemyWind } from '../src/combat/enemy-wind'
import { testBot, testClock } from './tick-plugins-fixture'

async function fixture(interval = 50) {
  const bot = testBot(), clock = testClock()
  require('mineflayer/lib/plugins/entities')(bot)
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const foe = new Entity(2)
  Object.assign(foe, { position: new Vec3(3.3, 1, .5), type: 'player', username: 'Enemy', _ndVisible: true })
  bot.entities[2] = foe
  const move = async (dx = 819, dy = 0, onGround = true, ms = 50) => {
    await clock.advanceGame(ms)
    bot._client.emit('rel_entity_move', { entityId: 2, dX: dx, dY: dy, dZ: 0, onGround })
  }
  await move(); await move(819, 0, true, interval)
  return { bot, foe, move }
}

test('first tracking after two actual grounded packets keeps their measured velocity finite', async () => {
  const { bot, foe } = await fixture()
  try {
    const v = observedVelocity(foe)
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.z), 'the first ground fit has two distinct native receipts')
    assert.ok(Math.abs(v.x - 819 / 4096) < 1e-12)
    assert.equal(v.y, 0); assert.equal(v.z, 0)
    assert.deepEqual(observedVelocity(foe), v, 'reading the same receipt again retains its estimate')
  } finally { bot.emit('end') }
})

test('actual grounded packets produce finite enemy wind frames and a nonthrowing planner', async () => {
  const { bot, foe } = await fixture()
  try {
    bot.username = 'A'; bot.entity.username = 'A'; bot.entity.position = new Vec3(-2, 1, .5)
    bot.ndClock = { age: 500n, ticks: 20, serverTicks: 20 }; bot.players = { Enemy: { entity: foe, gamemode: 0 } }
    const arena = { x: -1.5, z: .5, r: 6.5, killY: -10 }
    assert.doesNotThrow(() => planEnemyWind(bot, foe, [{ id: 'A', position: { x: -2, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }],
      { arena, startTick: 500, maxShots: 1, delays: [1], reactAfterHit: true }))
    const frames = enemyWindFrames(bot, foe, arena)
    assert.ok(frames.length > 1)
    assert.ok(frames.every(f => [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z].every(Number.isFinite)), 'native rollout must not inherit a tracker 0/0')
  } finally { bot.emit('end') }
})

test('co-timestamped grounded packets retain a finite fallback until a later interval', async () => {
  const { bot, foe, move } = await fixture(0)
  try {
    assert.deepEqual(observedVelocity(foe), { x: 0, y: 0, z: 0, ageTicks: 0 })
    await move()
    assert.ok(Math.abs(observedVelocity(foe).x - 819 / 4096) < 1e-12)
  } finally { bot.emit('end') }
})

test('landing after a gliding phase rebaseline seeds the first new grounded interval', async () => {
  const { bot, foe, move } = await fixture()
  try {
    observedVelocity(foe)
    foe.metadata[0] = 128; await move(819, 4096, false)
    foe.metadata[0] = 0; await move(819, -4096, true)
    await move()
    const v = observedVelocity(foe)
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.z), 'phase rebaseline also starts with an empty ground speed history')
    assert.ok(Math.abs(v.x - 819 / 4096) < 1e-12)
  } finally { bot.emit('end') }
})
