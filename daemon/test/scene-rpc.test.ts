'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { connect } from '../scenes/lib/scene-kit'

test('обрыв RPC завершает текущий запрос и не подвешивает завершение лабораторной сцены', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  server.on('connection', peer => peer.on('message', () => peer.close()))
  const conn = connect(`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
  try {
    await conn.ready
    await assert.rejects(conn.call('status'), /закрыто/)
    await assert.rejects(conn.call('stop'), /закрыто/)
  } finally {
    conn.close()
    await new Promise<any>(resolve => server.close(resolve))
  }
})
