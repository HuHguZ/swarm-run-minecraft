'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { installWorldTracker } = require('../src/worlds')
const { portalChanged } = require('../src/nether')
function fixture () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0.5, 65, 0.5) }
  bot.entities = { 1: bot.entity }; bot.players = {}
  bot.health = 20; bot.game = { dimension: 'overworld' }
  bot.blockAt = p => ({ name: 'stone', position: p })
  bot._client.on('respawn', p => { bot.game.dimension = p.dimension })
  const session = { bot, worldChange: { seq: 9, to: 'overworld', ready: true },
    updateMovements () {}, bus: { emit () {} }, journal: { append () {} } }
  installWorldTracker(session, bot)
  return { bot, session }
}
test('смена мира после переподключения продолжает последовательность событий', async () => {
  const { bot, session } = fixture()
  bot._client.emit('respawn', { dimension: 'the_nether' })
  bot.emit('forcedMove')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(session.worldChange.seq, 10)
  assert.equal(session.worldChange.to, 'the_nether')
  assert.equal(session.worldChange.ready, true)
})
test('пакет прошлого соединения не меняет мир новой сессии', async () => {
  const { bot, session } = fixture()
  session.bot = { game: { dimension: 'overworld' } }
  bot._client.emit('respawn', { dimension: 'the_nether' })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(session.worldChange.seq, 9)
  assert.equal(session.worldChange.to, 'overworld')
})
test('новый заголовок мира прекращает движение к координатам старого портала', () => {
  assert.equal(portalChanged({ worldChange: { seq: 1, to: 'the_nether' } },
    { game: { dimension: 'the_nether' } }, 'overworld', 9), true)
  assert.equal(portalChanged({ worldChange: { seq: 9, to: 'the_nether' } },
    { game: { dimension: 'overworld' } }, 'overworld', 9), false)
})
