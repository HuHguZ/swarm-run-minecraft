'use strict'
const gameClock = require('./src/game-clock')
// Vision check: asks the daemon for a frame and writes it to disk so the
// result can be eyeballed without going through MCP.
const WebSocket = require('ws')
const fs = require('fs')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

ws.on('open', async () => {
  try {
    await call('connect')
    console.time('first frame')
    const r = await call('look', { width: 640, height: 360 })
    console.timeEnd('first frame')
    const buf = Buffer.from(r.image, 'base64')
    fs.writeFileSync('look.png', buf)
    console.log('wrote look.png', buf.length, 'bytes |', JSON.stringify(r.detail))

    console.time('second frame')
    const r2 = await call('look', { width: 640, height: 360 })
    console.timeEnd('second frame')
    fs.writeFileSync('look2.png', Buffer.from(r2.image, 'base64'))
    console.log('wrote look2.png')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
