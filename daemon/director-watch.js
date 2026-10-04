'use strict'
// Наблюдатель за директором: раз в 15 с спрашивает статус и пишет в
// director-watch.log смену шага и новые строки его журнала. Для отладки.
//   node director-watch.js [ws://127.0.0.1:8769] [goal]
const fs = require('fs')
const WebSocket = require('ws')
const url = process.argv[2] || 'ws://127.0.0.1:8769'
const goal = process.argv[3] || 'beat_game'
const ws = new WebSocket(url)
let id = 0
const pend = new Map()
const call = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.on('message', raw => { const m = JSON.parse(raw); const r = pend.get(m.id); if (r) { pend.delete(m.id); r(m) } })
const out = (s) => { const line = `[${new Date().toTimeString().slice(0, 8)}] ${s}`; console.log(line); fs.appendFileSync('director-watch.log', line + '\n') }
let seen = 0
let lastStep = null
ws.on('open', async () => {
  await call('connect')
  const st = await call('director', { mode: 'start', goal })
  out(`старт: ${st.result && st.result.detail ? st.result.detail.text : JSON.stringify(st)}`)
  for (;;) {
    await new Promise(r => setTimeout(r, 15000))
    const m = await call('director', { mode: 'status' })
    const d = m.result && m.result.detail
    if (!d) continue
    const step = d.step ? `${d.step.name} (${d.step.prio}: ${d.step.why})` : '-'
    if (step !== lastStep) { out(`ШАГ ${step} | ${d.situation}`); lastStep = step }
    const inv = m.result.state && m.result.state.inventory ? Object.entries(m.result.state.inventory).map(([k, v]) => `${k}×${v}`).join(' ') : ''
    const recent = d.recent || []
    for (const h of recent.slice(Math.max(0, recent.length - (recent.length - seen)))) { }
    const fresh = recent.filter(h => !out.seenSet || !out.seenSet.has(h.at + h.text))
    out.seenSet = out.seenSet || new Set()
    for (const h of fresh) { out.seenSet.add(h.at + h.text); out(`  · ${h.at} ${h.text}`) }
    if (fresh.length) out(`  рюкзак: ${inv}`)
    seen = recent.length
  }
})
