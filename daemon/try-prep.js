'use strict'
// Подготовка из сырья: сколько секунд уходит на рывок (меч) и на полный
// комплект, что получилось надеть.
//   ND_WS=ws://127.0.0.1:8767 node try-prep.js [rush|smart|full ...]
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8767')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cmd (text) { await call('say', { text }); await sleep(300) }

const X = -1100; const Y = 100; const Z = -1100
const RAW = ['oak_log 6', 'iron_ingot 31', 'diamond 2', 'string 3', 'arrow 16', 'cobblestone 64', 'golden_apple 2', 'cooked_beef 8']
const STRATS = process.argv.slice(2).length ? process.argv.slice(2) : ['rush', 'full']

ws.on('open', async () => {
  try {
    await call('connect')
    await call('temper', { enabled: false })
    await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`)
    await cmd(`/fill ${X - 6} ${Y} ${Z - 6} ${X + 6} ${Y + 4} ${Z + 6} minecraft:air`)
    for (const strategy of STRATS) {
      await cmd(`/fill ${X - 6} ${Y} ${Z - 6} ${X + 6} ${Y + 4} ${Z + 6} minecraft:air`)
      await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
      await cmd('/clear @s')
      for (const it of RAW) {
        const [n, c] = it.split(' ')
        await cmd(`/give @s minecraft:${n} ${c || 1}`)
      }
      await sleep(600)
      const r = await call('prep', { strategy })
      const d = r.detail || {}
      console.log(`\n=== ${strategy}: ${r.status} за ${d.seconds} с ${r.error || ''}`)
      console.log('  ' + (d.made || []).map(m => `${m.what}@${m.s}`).join(', '))
      const st = await call('status')
      const inv = (st.state && st.state.inventory) || {}
      console.log('  в рюкзаке:', Object.entries(inv).map(([k, v]) => `${k}×${v}`).join(', '))
      console.log('  надето:', JSON.stringify(st.state && (st.state.armor || st.state.worn || null)))
    }
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
