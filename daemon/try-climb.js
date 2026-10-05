'use strict'
const gameClock = require('./src/game-clock')
// Вертикальная погоня (edges.climbBack): NeuroDown внизу, NeuroDown2 на
// площадке в небе (как арена, из которой выпали). Бой — бот должен подняться
// к нему: столбом через дыру в полу (есть дыра) или сквозь пол (дыры нет).
//   ND_WS=ws://127.0.0.1:8781 ND_WS2=ws://127.0.0.1:8782 node try-climb.js [раз]
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
const A = client(process.env.ND_WS || 'ws://127.0.0.1:8781')
const B = client(process.env.ND_WS2 || 'ws://127.0.0.1:8782')
const say = async (t) => { await A.call('say', { text: t }); await sleep(200) }
const N = Number(process.argv[2] || 2)
const X = 200; const G = 100; const P = 125; const Z = 200

async function trial (hole) {
  // Земля внизу и площадка в небе; в площадке — дыра 2×2 или ничего.
  await say(`/fill ${X - 12} ${G} ${Z - 12} ${X + 12} ${P + 6} ${Z + 12} minecraft:air`)
  await say(`/fill ${X - 12} ${G - 1} ${Z - 12} ${X + 12} ${G - 1} ${Z + 12} minecraft:stone`)
  await say(`/fill ${X - 5} ${P - 1} ${Z - 5} ${X + 5} ${P - 1} ${Z + 5} minecraft:smooth_stone`)
  if (hole) await say(`/fill ${X + 2} ${P - 1} ${Z + 2} ${X + 3} ${P - 1} ${Z + 3} minecraft:air`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await say(`/clear ${who}`); await say(`/effect clear ${who}`) }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'cobblestone 64', 'oak_planks 64']) {
    const [n, c] = it.split(' ')
    await say(`/give NeuroDown minecraft:${n} ${c || 1}`)
  }
  await say('/give NeuroDown2 minecraft:diamond_sword 1')
  await say(`/tp NeuroDown2 ${X - 2.5} ${P} ${Z - 2.5}`)
  await say(`/tp NeuroDown ${X + 7.5} ${G} ${Z + 7.5}`)
  await say('/effect give NeuroDown minecraft:instant_health 1 5 true')
  await sleep(1500)
  const t0 = gameClock.now()
  const fight = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: 70, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  let up = null
  while (gameClock.now() - t0 < 72000) {
    const s = await A.call('status').catch(() => null)
    const y = s && s.state && s.state.pos ? s.state.pos.y : 0
    if (y >= P) { up = Math.round((gameClock.now() - t0) / 100) / 10; break }
    await sleep(500)
  }
  await A.call('stop').catch(() => {})
  const r = await fight
  const tr = (r.detail && r.detail.tricks) ? Object.keys(r.detail.tricks).filter(k => /поднял|не поднялся|столб/.test(k)).join('; ') : ''
  console.log(`${hole ? 'дыра в полу' : 'сплошной пол'}: ${up != null ? `поднялся за ${up} с` : 'НЕ поднялся за 70 с'} | ${tr || r.status}`)
  return up
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await say('/gamerule send_command_feedback false')
    const res = []
    for (let i = 0; i < N; i++) { res.push({ hole: true, t: await trial(true) }); res.push({ hole: false, t: await trial(false) }) }
    const ok = res.filter(x => x.t != null)
    console.log(`ИТОГ: поднялся ${ok.length}/${res.length}; через дыру ${res.filter(x => x.hole && x.t != null).map(x => x.t + 'с').join(', ') || '-'}; сквозь пол ${res.filter(x => !x.hole && x.t != null).map(x => x.t + 'с').join(', ') || '-'}`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
