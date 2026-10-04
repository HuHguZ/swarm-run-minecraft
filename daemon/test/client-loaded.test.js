'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { install } = require('../src/client-loaded')
function bot (supported = true) {
  const b = new EventEmitter()
  b.registry = { protocol: { play: { toServer: { types: supported ? { packet_player_loaded: ['container', []] } : {} } } } }
  b.sent = []
  b._client = { write: (name, data) => b.sent.push({ name, data }) }
  b.waitForChunksToLoad = async () => {}
  return b
}
const settled = () => new Promise(resolve => setImmediate(resolve))
test('после загрузки чанков при входе и возрождении сервер получает player_loaded', async () => {
  const b = bot()
  install(b); install(b)
  b.emit('spawn'); await settled()
  b.emit('spawn'); await settled()
  assert.deepEqual(b.sent, [{ name: 'player_loaded', data: {} }, { name: 'player_loaded', data: {} }])
})
test('старый spawn не подтверждает новый незагруженный мир', async () => {
  const b = bot()
  const pending = []
  b.waitForChunksToLoad = () => new Promise(resolve => pending.push(resolve))
  install(b)
  b.emit('spawn'); b.emit('spawn')
  pending[0](); await settled()
  assert.equal(b.sent.length, 0)
  pending[1](); await settled()
  assert.equal(b.sent.length, 1)
})
test('ошибка загрузки или отключение не отправляет преждевременное подтверждение', async () => {
  const b = bot()
  b.waitForChunksToLoad = async () => { throw new Error('не загружено') }
  install(b); b.emit('spawn'); await settled()
  assert.equal(b.sent.length, 0)
})
test('на старом протоколе отсутствующий пакет не отправляется', async () => {
  const b = bot(false)
  install(b); b.emit('spawn'); await settled()
  assert.equal(b.sent.length, 0)
})
