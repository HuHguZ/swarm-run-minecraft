'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { fixBreath } from '../src/gamedata'

function body () {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))(bot.version)
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  // Настоящий обработчик Mineflayer, а не имитация ошибки в тесте.
  require('mineflayer/lib/plugins/entities')(bot)
  bot._client.emit('login', { entityId: 1 })
  bot.oxygenLevel = 20
  if (fixBreath) fixBreath(bot)
  const Entity = require('prismarine-entity')(bot.version)
  const mob = new Entity(2)
  Object.assign(mob, bot.registry.entitiesByName.zombie)
  bot.entities[2] = mob
  const air = (entityId, value) => bot._client.emit('entity_metadata', { entityId, metadata: [{ key: 1, type: 'varint', value }] })
  return { bot, air }
}

test('воздух чужого моба не меняет воздух игрока даже в обработчике breath', () => {
  const { bot, air } = body()
  const seen = []
  bot.on('breath', () => seen.push(bot.oxygenLevel))
  air(2, 90)
  assert.equal(bot.oxygenLevel, 20)
  assert.equal(seen.at(-1), 20)
})

test('свой воздух обновляется под водой, чужой не скрывает утопление, возрождение сбрасывает запас', () => {
  const { bot, air } = body()
  air(1, 30)
  assert.equal(bot.oxygenLevel, 2)
  air(2, 300)
  assert.equal(bot.oxygenLevel, 2)
  bot.emit('respawn')
  air(2, 15)
  assert.equal(bot.oxygenLevel, 20)
})
