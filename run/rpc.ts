'use strict'
// Мини-клиент RPC демона: node rpc.js [--ws ws://127.0.0.1:8769] method '{"json":1}' [--full]
// Печатает статус, detail (обрезанный) и сжатое состояние.
import { WebSocket } from '../daemon/node_modules/ws'
const args = process.argv.slice(2)
let ws = process.env.ND_WS || 'ws://127.0.0.1:8769'
const i = args.indexOf('--ws'); if (i >= 0) { ws = args[i + 1]; args.splice(i, 2) }
const full = args.includes('--full'); if (full) args.splice(args.indexOf('--full'), 1)
const method = args[0]
const params = args[1] ? JSON.parse(args[1]) : {} as Record<string, any>
const sock = new WebSocket(ws)
sock.on('open', () => sock.send(JSON.stringify({ id: 1, method, params })))
sock.on('message', raw => {
  const m = JSON.parse(raw.toString())
  if (m.id !== 1) return
  if (!m.ok) { console.log('ERROR', m.error); process.exit(1) }
  const r = m.result || {} as Record<string, any>
  const st = r.state || {} as Record<string, any>
  const inv = Object.entries<any>(st.inventory || {} as Record<string, any>).map(([k, v]: any) => `${k}×${v}`).join(' ')
  const armor = JSON.stringify(st.armor || {} as Record<string, any>)
  console.log(`status=${r.status} hp=${Math.round(st.health ?? -1)} food=${st.food} dim=${st.dimension} pos=${st.pos ? `${st.pos.x},${st.pos.y},${st.pos.z}` : '?'} time=${st.timeOfDay ?? st.time ?? '?'}`)
  console.log(`armor=${armor} off=${JSON.stringify(st.offHand || null)}`)
  console.log(`inv: ${inv}`)
  if (r.error) console.log('error:', r.error)
  const d = r.detail
  if (d !== undefined) {
    const s = JSON.stringify(d, null, full ? 1 : 0)
    console.log('detail:', full ? s : s.slice(0, 3000))
  }
  const evs = (r.events || []).map(e => e.type + (e.text ? `(${String(e.text).slice(0, 80)})` : '')).join(', ')
  if (evs) console.log('events:', evs.slice(0, 1500))
  sock.close()
  process.exit(0)
})
sock.on('error', e => { console.log('WS error', e.message); process.exit(1) })
