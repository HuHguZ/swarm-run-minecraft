import WebSocket = require('ws')
const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
const [method, params] = [process.argv[2], JSON.parse(process.argv[3] || '{}')]
ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id !== 1) return; console.log(JSON.stringify(m.ok ? m.result : m.error).slice(0, 3000)); process.exit(0) })
