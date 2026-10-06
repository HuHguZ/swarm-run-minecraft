'use strict'
const gameClock = require('./src/game-clock')
// Застой у лавы (живая арена 2026-09-26: лава под ним, он на блоке посреди
// лавы, второй у края; две минуты оба стояли — «застой, ничья»). NeuroDown на
// блоке посреди лавы 5×5, NeuroDown2 в DIST блоках на полу. Оба дерутся
// SECONDS секунд: когда случился первый размен и что делали с лавой.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-lavaisland.js
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
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
async function cmd (text) { await A.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 150; const Z = 1300
const SECONDS = Number(process.env.SECONDS || 40)
const DIST = Number(process.env.DIST || 6)

async function round (k) {
  await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:obsidian`)
  await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 10} ${Z + 20} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  const kit = ['diamond_sword', 'diamond_pickaxe', 'cobblestone 32', 'bucket', 'water_bucket', 'bow', 'arrow 32', 'golden_apple 2']
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    await cmd(`/item replace entity ${who} armor.chest with minecraft:iron_chestplate`)
    for (const it of kit) { const [n, c] = it.split(' '); await cmd(`/give ${who} minecraft:${n} ${c || 1}`) }
  }
  // Остров: блок под A на уровне ног, вокруг — лава 5×5 на уровне ног.
  await cmd(`/fill ${X - 2} ${Y} ${Z - 2} ${X + 2} ${Y} ${Z + 2} minecraft:lava`)
  await cmd(`/setblock ${X} ${Y} ${Z} minecraft:obsidian`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y + 1} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + DIST + 0.5} 180 0`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  const t0 = gameClock.now()
  let first = 0
  const hp: Record<string, any> = { a: 20, b: 20 }
  let polling = true
  const poll = (async () => {
    while (polling) {
      try {
        const ha = (((await A.call('status')) as any).state || {} as Record<string, any>).health
        const hb = (((await B.call('status')) as any).state || {} as Record<string, any>).health
        if (!first && ((ha != null && ha < hp.a - 0.4) || (hb != null && hb < hp.b - 0.4))) first = gameClock.now() - t0
        if (ha != null) hp.a = ha
        if (hb != null) hp.b = hb
      } catch {}
      await sleep(150)
    }
  })()
  const fa = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const [ra, rb] = await Promise.all([fa, fb])
  polling = false
  await poll
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  const pickT = (r) => Object.entries<any>(((r && r.detail) || {} as Record<string, any>).tricks || {} as Record<string, any>).filter(([k]: any) => /лава|дыра|обхожу|перекрыт|лук|стрел|арбалет|зачерп|залил|заложил/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
  const killed = (r) => ((r && r.detail) || {} as Record<string, any>).killed ? ' УБИЛ' : ''
  console.log(`[остров #${k}] A ${ra.status}${killed(ra)} / B ${rb.status}${killed(rb)} | первый размен ${first ? (first / 1000).toFixed(1) + ' с' : 'не было'} | хп A ${hp.a} B ${hp.b}`)
  console.log(`   A: ${pickT(ra) || '-'}`)
  console.log(`   B: ${pickT(rb) || '-'}`)
  return first
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`)
    const reps = Number(process.env.REPS || 2)
    for (let k = 1; k <= reps; k++) await round(k)
    await cmd(`/forceload remove ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
