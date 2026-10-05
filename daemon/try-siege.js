'use strict'
const gameClock = require('./src/game-clock')
// Осада коробки. NeuroDown сидит в закрытой коробке из булыжника (1×2 внутри,
// с крышей), NeuroDown2 с киркой и мечом начинает бой с 5, 12 и 20 блоков.
// Надо: подойти, выломать блок и бить. Живая арена 2026-09-26: противник
// «прыгал на месте, крутил головой, не бежал, не ломал киркой».
//   A=ws://127.0.0.1:8785 B=ws://127.0.0.1:8786 node try-siege.js
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
const SECONDS = Number(process.env.SECONDS || 30)

async function stage (dist, extra = '') {
  await cmd(`/fill ${X - 25} ${Y - 1} ${Z - 25} ${X + 25} ${Y - 1} ${Z + 25} minecraft:stone`)
  await cmd(`/fill ${X - 25} ${Y} ${Z - 25} ${X + 25} ${Y + 8} ${Z + 25} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'cobblestone 32', 'diamond_chestplate', 'bow', 'arrow 16']) {
    const [n, c] = it.split(' ')
    await cmd(`/give NeuroDown2 minecraft:${n} ${c || 1}`)
  }
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await sleep(600)
  // Коробка: пустота 1×2 вокруг ног и головы, стены, пол и крыша — булыжник.
  await cmd(`/fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 1} ${Y + 2} ${Z + 1} minecraft:cobblestone hollow`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + dist + 0.5} 180 0`)
  await cmd('/effect give NeuroDown minecraft:instant_health 1 10 true')
  await cmd('/effect give NeuroDown2 minecraft:instant_health 1 10 true')
  if (extra) await cmd(extra)
  await sleep(1500)
  const hp0 = ((await A.call('status')).state || {}).health
  const r = await B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 2 }).catch(e => ({ status: 'failed', error: e.message }))
  const stA = await A.call('status')
  const d = r.detail || {}
  const tricks = Object.entries(d.tricks || {}).map(([k, v]) => `${k}×${v}`).join(', ')
  console.log(`[${dist} бл.] ${r.status}${d.killed ? ' УБИЛ' : ''}${d.lost ? ' ' + d.lost : ''}${d.timeout ? ' время' : ''} | хп A ${hp0} -> ${(stA.state || {}).health} | удары ${d.swings ?? '?'}/${d.landed ?? '?'} | ${tricks || 'приёмов нет'}`)
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
    for (const d of (process.env.DISTS || '5,12,20').split(',').map(Number)) await stage(d)
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
