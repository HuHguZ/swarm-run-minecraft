'use strict'
const gameClock = require('./src/game-clock')
// Возвращение на арену снизу (2026-09-27, пользователь: «поднимался на блоке,
// упёрся в обсидиан, в потолок — не увидел, что не может подняться»).
// NeuroDown на земле под обсидиановым полом (DEPTH блоков ниже), NeuroDown2
// стоит на полу. Сцены: «дыра» — 2×2 в 8 блоках в стороне; «светокамень» —
// дыр нет, но в полу полоса светокамня; «обсидиан» — сплошной пол. Бот должен
// подняться через дыру или быстрый пол, а в сплошной обсидиан не упираться.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-climbback.js
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
const X = 1000; const Y = 170; const Z = 1500
const DEPTH = Number(process.env.DEPTH || 20)
const SECONDS = Number(process.env.SECONDS || 60)

async function scene (name) {
  await cmd(`/fill ${X - 14} ${Y - DEPTH - 1} ${Z - 14} ${X + 14} ${Y + 4} ${Z + 14} minecraft:air`)
  await cmd(`/fill ${X - 14} ${Y - DEPTH - 1} ${Z - 14} ${X + 14} ${Y - DEPTH - 1} ${Z + 14} minecraft:stone`)
  // Земля шире сцены: сбитый со столба у края не должен падать в пустоту до y≈64.
  await cmd(`/fill ${X - 30} ${Y - DEPTH - 1} ${Z - 30} ${X + 30} ${Y - DEPTH - 1} ${Z + 30} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:obsidian`)
  if (name === 'дыра' || name === 'стрелок' || name === 'две дыры') await cmd(`/fill ${X + 8} ${Y - 1} ${Z} ${X + 9} ${Y - 1} ${Z + 1} minecraft:air`)
  // Вторая дыра — по другую сторону: стрелок стоит у первой, вылезать надо во второй.
  if (name === 'две дыры') await cmd(`/fill ${X - 9} ${Y - 1} ${Z} ${X - 8} ${Y - 1} ${Z + 1} minecraft:air`)
  if (name === 'светокамень') await cmd(`/fill ${X - 5} ${Y - 1} ${Z - 12} ${X - 5} ${Y - 1} ${Z + 12} minecraft:glowstone`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  await cmd('/clear NeuroDown'); await cmd('/effect clear NeuroDown')
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'cobblestone 64']) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown minecraft:${n} ${c || 1}`) }
  await cmd('/clear NeuroDown2')
  if (name === 'стрелок' || name === 'две дыры') {
    // Стрелок у края дыры, щит у поднимающегося.
    await cmd('/give NeuroDown2 minecraft:bow'); await cmd('/give NeuroDown2 minecraft:arrow 64')
    await cmd('/item replace entity NeuroDown weapon.offhand with minecraft:shield')
    await cmd(`/tp NeuroDown2 ${X + 11.5} ${Y} ${Z + 0.5}`)
    await cmd(`/tp NeuroDown ${X + 8.5} ${Y - DEPTH} ${Z + 0.5}`)
  } else await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z - 5.5}`)
  if (name === 'две дыры') await cmd(`/tp NeuroDown ${X + 0.5} ${Y - DEPTH} ${Z + 0.5}`)
  else if (name !== 'стрелок') await cmd(`/tp NeuroDown ${X + 0.5} ${Y - DEPTH} ${Z + 0.5}`)
  await cmd('/effect give NeuroDown minecraft:instant_health 1 10 true')
  await sleep(1500)
  const t0 = gameClock.now()
  let upAt = 0
  let maxY = -1e9
  let polling = true
  const poll = (async () => {
    while (polling) {
      try {
        const st = (await A.call('status')).state || {}
        const y = st.pos && st.pos.y
        if (y != null) { maxY = Math.max(maxY, y); if (!upAt && y >= Y - 0.1) upAt = gameClock.now() - t0 }
      } catch {}
      await sleep(200)
    }
  })()
  let hits = 0; let hpWas = 20
  const hitPoll = (async () => { while (polling) { try { const h = ((await A.call('status')).state || {}).health; if (h != null && h < hpWas - 0.4 && !upAt) hits++; if (h != null) hpWas = h } catch {} await sleep(150) } })()
  const fb = (name === 'стрелок' || name === 'две дыры') ? B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(() => null) : Promise.resolve(null)
  const r = await A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  await B.call('stop').catch(() => {}); await fb
  polling = false
  await hitPoll
  await poll
  await A.call('stop').catch(() => {})
  const tricks = Object.entries(((r && r.detail) || {}).tricks || {}).filter(([k]) => /поднял|подъём|дыр|пол|столб|потол|обсид|мост|щит|присел/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  if (name === 'стрелок' || name === 'две дыры') console.log(`   попаданий по поднимающемуся до пола: ${hits}`)
  console.log(`[${name}] ${upAt ? 'поднялся на пол за ' + (upAt / 1000).toFixed(1) + ' с' : 'не поднялся (выше всего y ' + maxY.toFixed(1) + ', пол ' + Y + ')'} | ${tricks || '-'}`)
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await B.call('stop').catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`)
    const which = process.argv[2] ? [process.argv[2]] : ['дыра', 'светокамень', 'обсидиан']
    for (const s of which) await scene(s)
    await cmd(`/forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
