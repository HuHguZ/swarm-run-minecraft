'use strict'
// Один вызов RPC демона из командной строки (отладка сцен):
//   ND_WS=ws://127.0.0.1:8771 node rpc-once.js say '{"text":"/time set day"}'
const WebSocket = require('ws')
const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
const [method, raw] = process.argv.slice(2)
ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params: raw ? JSON.parse(raw) : {} })))
ws.on('message', m => {
  const r = JSON.parse(m.toString())
  if (r.id !== 1) return
  const out = r.ok ? r.result : { error: r.error }
  if (out && out.state) delete out.state
  console.log(JSON.stringify(out, null, 1).slice(0, Number(process.env.MAX || 6000)))
  ws.close()
})
ws.on('error', e => { console.error(e.message); process.exit(1) })
