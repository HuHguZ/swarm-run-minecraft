'use strict'
// Smoke test: talks to the running daemon the same way the MCP server will.
import WebSocket = require('ws')

const url = process.env.ND_WS || 'ws://127.0.0.1:8765'
const ws = new WebSocket(url)
let id = 0
const pending = new Map()

function call (method, params: any = {} as Record<string, any>) {
  const rid = ++id
  return new Promise<any>((resolve, reject) => {
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
}

ws.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))
})

ws.on('open', async () => {
  const show = (label, v) => console.log(`\n=== ${label} ===\n` + JSON.stringify(v, null, 2))
  try {
    show('connect', await call('connect'))
    show('status', await call('status'))
    show('say', await call('say', { text: 'здарова, я на связи' }))
    show('observe(fair)', await call('observe', { radius: 20 }))
    const st: any = await call('status')
    const p = st.state.pos
    show('goto +6z', await call('goto', { x: p.x, y: p.y, z: p.z + 6, range: 1 }))
    show('wait 5s', await call('wait', { seconds: 5 }))
    show('recall', await call('recall', { lines: 10 }))
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})

ws.on('error', e => { console.error('ws error:', e.message); process.exitCode = 1 })
