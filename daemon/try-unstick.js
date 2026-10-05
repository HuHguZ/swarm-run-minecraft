'use strict'
const gameClock = require('./src/game-clock')
// Стена между бойцами. NeuroDown стоит за стеклянной стеной в два блока,
// NeuroDown2 с мечом, киркой и луком начинает бой с другой стороны. Надо:
// не тереться о стекло, а прорубить его или обойти через щель — что быстрее
// (живая арена 2026-09-26: «уперлись в стену вдвоём, ни ломают, ни обходят»).
//   A=ws://127.0.0.1:8785 B=ws://127.0.0.1:8786 node try-unstick.js
const WebSocket = require('ws')

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8785')
const B = client(process.env.B || 'ws://127.0.0.1:8786')
async function cmd (text) { await A.call('say', { text }); await sleep(40) }

const X = 0; const Y = 150; const Z = 0

async function stage (name, { wall, gapAt = null, block = 'glass' }) {
  await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:stone`)
  await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 8} ${Z + 20} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  if (wall) await cmd(`/fill ${X - wall} ${Y} ${Z + 3} ${X + wall} ${Y + 1} ${Z + 3} minecraft:${block}`)
  if (gapAt !== null) await cmd(`/fill ${X + gapAt} ${Y} ${Z + 3} ${X + gapAt} ${Y + 1} ${Z + 3} minecraft:air`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'diamond_chestplate']) await cmd(`/give NeuroDown2 minecraft:${it}`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + 6.5} 180 0`)
  await cmd('/effect give NeuroDown minecraft:resistance 30 4 true')
  await cmd('/effect give NeuroDown2 minecraft:instant_health 1 10 true')
  await sleep(1500)
  const t0 = gameClock.now()
  let firstHit = null
  const watch = gameClock.setInterval(async () => {
    const st = await A.call('status').catch(() => null)
    if (!firstHit && st && st.state && st.state.health < 20) firstHit = gameClock.now() - t0
  }, 250)
  const r = await B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: 15, retreatAtHealth: 2 }).catch(e => ({ status: 'failed', error: e.message }))
  gameClock.clearInterval(watch)
  const d = r.detail || {}
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /стен|упёр|обхож|пробил|путь/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  console.log(`[${name}] первый удар через ${firstHit ? (firstHit / 1000).toFixed(1) + ' с' : '—'} | удары ${d.swings ?? '?'}/${d.landed ?? '?'} | ${tricks || 'без обхода'}`)
  await B.call('stop').catch(() => {})
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/gamerule spawn_mobs false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await stage('без стены', { wall: 0 })
    await stage('стекло сплошное', { wall: 12 })
    await stage('стекло, щель в 3', { wall: 12, gapAt: 3 })
    await stage('обсидиан, щель в 6', { wall: 12, gapAt: 6, block: 'obsidian' })
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
