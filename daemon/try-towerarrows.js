'use strict'
const gameClock = require('./src/game-clock')
// Стрелы по тому, кто строит столб (2026-09-27, пользователь: «не
// выворачиваются от стрел, когда на башню залезают»). NeuroDown2 с луком на
// столбе высотой H, NeuroDown внизу без лука (со щитом и булыжником) — строит
// свой столб к его столбу, а тот стреляет. Считаем попадания по строящему и
// заметки про щит.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-towerarrows.js
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
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
async function cmd (text) { await B.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 150; const Z = 1600
const H = Number(process.env.H || 7)
const SECONDS = Number(process.env.SECONDS || 30)

async function round (k) {
  await cmd(`/fill ${X - 14} ${Y - 1} ${Z - 14} ${X + 14} ${Y - 1} ${Z + 14} minecraft:stone`)
  await cmd(`/fill ${X - 14} ${Y} ${Z - 14} ${X + 14} ${Y + H + 6} ${Z + 14} minecraft:air`)
  await cmd(`/kill @e[type=arrow,x=${X},y=${Y},z=${Z},distance=..40]`)
  await cmd(`/fill ${X} ${Y} ${Z} ${X} ${Y + H - 1} ${Z} minecraft:obsidian`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  await cmd('/give NeuroDown2 minecraft:bow'); await cmd('/give NeuroDown2 minecraft:arrow 64')
  for (const it of ['iron_sword', 'cobblestone 64']) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown minecraft:${n} ${c || 1}`) }
  await cmd('/item replace entity NeuroDown weapon.offhand with minecraft:shield')
  await cmd('/item replace entity NeuroDown armor.chest with minecraft:iron_chestplate')
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y + H} ${Z + 0.5}`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 4.5}`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  let hits = 0; let hp = 20; let polling = true
  const poll = (async () => { while (polling) { try { const h = ((await A.call('status')).state || {}).health; if (h != null && h < hp - 0.4) hits++; if (h != null) hp = h } catch {} await sleep(120) } })()
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(() => null)
  const ra = await A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  await B.call('stop').catch(() => {}); await fb
  polling = false
  await poll
  const tr = Object.entries(((ra && ra.detail) || {}).tricks || {}).filter(([k]) => /столб|щит|присел|стрел|лук|бросил/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  const dd = (ra && ra.detail) || {}
  const blocks = (dd.melee && dd.melee.shieldBlocks) || 0; const tshots = dd.towerShots || 0
  console.log(`[башня #${k}] попаданий по A ${hits}, щит принял ${blocks}, стрел в щит на столбе ${tshots} | ${tr || '-'}`)
  return hits
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/gamerule fall_damage false')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`)
    let sum = 0
    const reps = Number(process.env.REPS || 2)
    for (let k = 1; k <= reps; k++) sum += await round(k)
    console.log(`ИТОГО попаданий: ${sum}`)
    await cmd(`/forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`)
    await cmd('/gamerule fall_damage true')
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
