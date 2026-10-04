'use strict'
// Ведро воды при падении (edges.installFallGuard): бот с ведром в рюкзаке
// (не в хотбаре) телепортируется на H блоков над каменной площадкой и падает.
// Должен выжить без урона и забрать воду обратно. Второй заход — посреди боя
// (fight на NeuroDown2, который стоит внизу и не отвечает).
//   ND_WS=ws://127.0.0.1:8781 ND_WS2=ws://127.0.0.1:8782 node try-mlg.js [раз на высоту]
const WebSocket = require('ws')

function client (url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
const A = client(process.env.ND_WS || 'ws://127.0.0.1:8781')
const B = client(process.env.ND_WS2 || 'ws://127.0.0.1:8782')
const cmd = async (text) => { await A.call('say', { text }); await sleep(250) }
const N = Number(process.argv[2] || 2)
const X = 60; const FLOOR = 70; const Z = 60

async function state (c) { const s = await c.call('status').catch(() => null); return s && s.state }

async function trial (h, inFight) {
  await cmd('/clear NeuroDown')
  await cmd('/effect clear NeuroDown')
  // Хотбар занят мусором, ведро — в рюкзаке: сторож сам переложит его в хотбар.
  for (let i = 0; i < 9; i++) await A.call('say', { text: `/item replace entity NeuroDown hotbar.${i} with minecraft:${i === 0 ? 'diamond_sword' : 'dirt'}` })
  await cmd('/item replace entity NeuroDown inventory.5 with minecraft:water_bucket')
  await cmd('/effect give NeuroDown minecraft:instant_health 1 5 true')
  await sleep(600)
  let fight = null
  if (inFight) {
    await cmd(`/tp NeuroDown2 ${X + 3} ${FLOOR + 1} ${Z}`)
    await cmd(`/tp NeuroDown ${X} ${FLOOR + 1} ${Z}`)
    await sleep(800)
    fight = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: 25, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
    await sleep(1500)
  }
  const s0 = await state(A)
  const hp0 = s0 ? s0.health : null
  await cmd(`/tp NeuroDown ${X + 0.5} ${FLOOR + 1 + h} ${Z + 0.5}`)
  const t0 = Date.now()
  let landed = null
  let low = 99
  while (Date.now() - t0 < 9000) {
    const s = await state(A)
    if (s && s.pos) {
      low = Math.min(low, s.pos.y)
      if (!landed && s.pos.y < FLOOR + 2.5) landed = { at: Date.now() - t0, hp: s.health }
    }
    if (landed && Date.now() - t0 > landed.at + 2500) break
    await sleep(150)
  }
  const s1 = await state(A)
  const inv = (s1 && s1.inventory) || {}
  const hp1 = s1 ? s1.health : null
  if (fight) { await A.call('stop').catch(() => {}); await fight }
  const water = Object.keys(inv).filter(k => /bucket/.test(k)).map(k => `${k}×${inv[k]}`).join(',')
  const ok = hp1 != null && hp0 != null && hp1 >= hp0 - 0.5
  console.log(`H=${h} ${inFight ? 'в бою' : 'вне боя'}: хп ${hp0} -> ${hp1} ${ok ? 'ЦЕЛ' : 'УРОН'} | вёдра: ${water || 'нет'} | ${water.includes('water_bucket') ? 'воду забрал' : 'воду НЕ забрал'}`)
  return { ok, picked: water.includes('water_bucket') }
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/gamerule fall_damage true')
    await cmd(`/fill ${X - 6} ${FLOOR} ${Z - 6} ${X + 6} ${FLOOR} ${Z + 6} minecraft:stone`)
    await cmd(`/fill ${X - 6} ${FLOOR + 1} ${Z - 6} ${X + 6} ${FLOOR + 50} ${Z + 6} minecraft:air`)
    await cmd('/gamemode survival NeuroDown')
    await cmd('/clear NeuroDown2')
    const res = { off: [], on: [] }
    for (let i = 0; i < N; i++) {
      for (const h of [30, 40]) res.off.push(await trial(h, false))
    }
    for (let i = 0; i < N; i++) res.on.push(await trial(35, true))
    const sum = (a) => `${a.filter(x => x.ok).length}/${a.length} целы, воду забрал ${a.filter(x => x.picked).length}/${a.length}`
    console.log(`ИТОГ: вне боя ${sum(res.off)}; в бою ${sum(res.on)}`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
