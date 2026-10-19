'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { install } from '../src/client-loaded'
import * as read from '../src/read'
import * as gameClock from '../src/game-clock'
function bot (supported = true) {
  const b: any = new EventEmitter()
  b.registry = { protocol: { play: { toServer: { types: supported ? { packet_player_loaded: ['container', []] } : {} as Record<string, any> } } } }
  b.sent = []
  b._client = { write: (name, data) => b.sent.push({ name, data }) }
  b.waitForChunksToLoad = async () => {}
  return b
}
const settled = () => new Promise<any>(resolve => setImmediate(resolve))

test('combat observation cannot acknowledge an unloaded world ahead of the shared chunk handshake', async () => {
  const b = bot()
  let loaded
  b.waitForChunksToLoad = () => new Promise(resolve => { loaded = resolve })
  const timers = []
  const oldTimeout = gameClock.wall.setTimeout
  gameClock.wall.setTimeout = callback => { timers.push(callback); return 0 }
  try {
    install(b)
    read.installLoaded(b)
    b.emit('spawn')
    for (const callback of timers) callback()
    await settled()
    assert.equal(b.sent.length, 0, 'the terrain-loading screen must last until chunks are actually available')
    loaded()
    await settled()
    assert.deepEqual(b.sent, [{ name: 'player_loaded', data: {} }])
  } finally { gameClock.wall.setTimeout = oldTimeout }
})

test('после загрузки чанков при входе и возрождении сервер получает player_loaded', async () => {
  const b = bot()
  install(b); install(b)
  b.emit('spawn'); await settled()
  b.emit('spawn'); await settled()
  assert.deepEqual(b.sent, [{ name: 'player_loaded', data: {} as Record<string, any> }, { name: 'player_loaded', data: {} as Record<string, any> }])
})
test('старый spawn не подтверждает новый незагруженный мир', async () => {
  const b = bot()
  const pending = []
  b.waitForChunksToLoad = () => new Promise<any>(resolve => pending.push(resolve))
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
