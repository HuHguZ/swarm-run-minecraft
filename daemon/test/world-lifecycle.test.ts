'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { installWorldTracker } from '../src/worlds'
import { portalChanged } from '../src/nether'
function fixture () {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0.5, 65, 0.5) }
  bot.entities = { 1: bot.entity }; bot.players = {} as Record<string, any>
  bot.health = 20; bot.game = { dimension: 'overworld' }
  bot.blockAt = p => ({ name: 'stone', position: p })
  bot._client.on('respawn', p => { bot.game.dimension = p.dimension })
  const session: Record<string, any> = { bot, worldChange: { seq: 9, to: 'overworld', ready: true },
    updateMovements () {}, bus: { emit () {} }, journal: { append () {} } }
  installWorldTracker(session, bot)
  return { bot, session }
}
test('смена мира после переподключения продолжает последовательность событий', async () => {
  const { bot, session } = fixture()
  bot._client.emit('respawn', { dimension: 'the_nether' })
  bot.emit('forcedMove')
  await new Promise<any>(resolve => setTimeout(resolve, 150))
  assert.equal(session.worldChange.seq, 10)
  assert.equal(session.worldChange.to, 'the_nether')
  assert.equal(session.worldChange.ready, true)
})
test('пакет прошлого соединения не меняет мир новой сессии', async () => {
  const { bot, session } = fixture()
  session.bot = { game: { dimension: 'overworld' } }
  session._rescue = { arena: { x: 600, y: 120, z: 600, r: 80 } }
  const rescue = session._rescue
  bot._client.emit('respawn', { dimension: 'the_nether' })
  await new Promise<any>(resolve => setTimeout(resolve, 150))
  assert.equal(session.worldChange.seq, 9)
  assert.equal(session.worldChange.to, 'overworld')
  assert.equal(session._rescue, rescue, 'an old connection must not clear the active arena')
})
test('новый заголовок мира прекращает движение к координатам старого портала', () => {
  assert.equal(portalChanged({ worldChange: { seq: 1, to: 'the_nether' } },
    { game: { dimension: 'the_nether' } }, 'overworld', 9), true)
  assert.equal(portalChanged({ worldChange: { seq: 9, to: 'the_nether' } },
    { game: { dimension: 'overworld' } }, 'overworld', 9), false)
})

test('arena rescue configuration survives same-world respawn and is cleared on dimension change', () => {
  const { bot, session } = fixture()
  const rescue = { arena: { x: 600, y: 120, z: 600, r: 80 }, killY: 113 }
  session._rescue = rescue
  try {
    bot._client.emit('respawn', { dimension: 'overworld' })
    assert.equal(session._rescue, rescue)
    bot._client.emit('respawn', { dimension: 'the_nether' })
    assert.equal(session._rescue, null)
  } finally { bot.emit('end') }
})
