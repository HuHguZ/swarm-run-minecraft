import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { Vec3 } = require('vec3')
const co = require('../src/pvp/combat-observe')

test('PvP default observation ignores a player behind a wall inside four blocks', () => {
  let wall = true
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 0, .5), onGround: true }
  bot.inventory = { items: () => [], slots: [] }
  bot.health = 20
  bot.blockAt = p => ({ name: wall && p.x === 1 ? 'stone' : 'air', position: p,
    boundingBox: wall && p.x === 1 ? 'block' : 'empty', shapes: wall && p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const foe: any = { id: 2, type: 'player', username: 'Foe', position: new Vec3(2.5, 0, .5),
    height: 1.8, width: .6, equipment: [{ name: 'golden_apple', componentMap: new Map() }], metadata: [] }
  const flags = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  foe.metadata[flags] = 1
  const tracker = co.trackFoe(bot, foe)
  try {
    bot.emit('physicsTick')
    bot._client.emit('entity_status', { entityId: 2, entityStatus: 35 })
    assert.equal(tracker.pops, 0)
    assert.equal(tracker.using, null)
    const hidden = co.observe(bot, foe, { tracker })
    assert.equal(hidden.los, false)
    assert.equal(hidden.dist, Infinity, 'unseen raw player has no known target position')
    assert.equal(hidden.foe.main, null, 'unseen starting gear is unknown')
    wall = false
    bot.emit('physicsTick')
    bot._client.emit('entity_status', { entityId: 2, entityStatus: 35 })
    assert.equal(tracker.pops, 1)
    assert.equal(co.observe(bot, foe, { tracker }).foe.main.name, 'golden_apple')
  } finally { tracker.stop() }
})
