'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { WebSocketServer } = require('ws')
const { connect } = require('../scene-kit')

test('обрыв RPC завершает текущий запрос и не подвешивает завершение лабораторной сцены', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  server.on('connection', peer => peer.on('message', () => peer.close()))
  const conn = connect(`ws://127.0.0.1:${server.address().port}`)
  try {
    await conn.ready
    await assert.rejects(conn.call('status'), /закрыто/)
    await assert.rejects(conn.call('stop'), /закрыто/)
  } finally {
    conn.close()
    await new Promise(resolve => server.close(resolve))
  }
})
