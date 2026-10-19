'use strict'
import * as gameClock from '../../src/game-clock'
// Столкнуть в яму (edges.pushPlan): площадка в небе с дырой 3×3, NeuroDown2
// стоит в 1-2.5 блоках от края дыры (не отвечает), NeuroDown начинает с
// разных сторон. Считаем: сбил ли его в дыру за 25 с и не упал ли сам.
//   ND_WS=ws://127.0.0.1:8781 ND_WS2=ws://127.0.0.1:8782 node try-push.js [раз]
import WebSocket = require('ws')

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
const A = client(process.env.ND_WS || 'ws://127.0.0.1:8781')
const B = client(process.env.ND_WS2 || 'ws://127.0.0.1:8782')
const say = async (t) => { await A.call('say', { text: t }); await sleep(200) }
const N = Number(process.argv[2] || 6)
const X = -200; const Y = 140; const Z = -200

async function trial (i) {
  await say(`/fill ${X - 9} ${Y - 1} ${Z - 9} ${X + 9} ${Y - 1} ${Z + 9} minecraft:smooth_stone`)
  await say(`/fill ${X - 9} ${Y} ${Z - 9} ${X + 9} ${Y + 5} ${Z + 9} minecraft:air`)
  // Дыра 3×3 в центре: клетки X-1..X+1.
  await say(`/fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 1} ${Y - 1} ${Z + 1} minecraft:air`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await say(`/clear ${who}`); await say(`/effect clear ${who}`) }
  await say('/give NeuroDown minecraft:diamond_sword 1')
  for (const a of ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']) await say(`/give NeuroDown2 minecraft:${a} 1`)
  await B.call('armor').catch(() => {})
  // Он — у края дыры (со стороны +x), на 1.2-2.4 от края; мы — с разных сторон в 5 блоках.
  const off = 1.2 + (i % 3) * 0.6
  const bx = X + 1 + 1 + off - 0.5 // край дыры — x = X+2 (грань), тело — дальше на off
  const bz = Z + 0.5 + ((i % 2) ? 1 : -1) * 0.7
  const ang = (i * 1.7) % (Math.PI * 2)
  const ax = bx + Math.cos(ang) * 5
  const az = bz + Math.sin(ang) * 5
  await say(`/tp NeuroDown2 ${bx.toFixed(2)} ${Y} ${bz.toFixed(2)}`)
  await say(`/tp NeuroDown ${ax.toFixed(2)} ${Y} ${az.toFixed(2)}`)
  await say('/effect give NeuroDown2 minecraft:instant_health 1 5 true')
  await say('/effect give NeuroDown2 minecraft:resistance 60 1 true')
  await sleep(2500)
  const t0 = gameClock.now()
  const fight = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: 25, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  let his = null; let mine = null; let killed = false
  while (gameClock.now() - t0 < 26000) {
    const [a, b] = await Promise.all([A.call('status').catch(() => null), B.call('status').catch(() => null)])
    const ay = a && a.state && a.state.pos ? a.state.pos.y : Y
    const by = b && b.state && b.state.pos ? b.state.pos.y : Y
    const bAlive = !!(b && b.state && b.state.health > 0)
    if (!bAlive) { killed = true; break }
    if (by < Y - 3 && his == null) his = Math.round((gameClock.now() - t0) / 100) / 10
    if (ay < Y - 3 && mine == null) mine = Math.round((gameClock.now() - t0) / 100) / 10
    if (his != null || mine != null) break
    await sleep(200)
  }
  await A.call('stop').catch(() => {})
  const r: any = await fight
  const tr = r.detail && r.detail.tricks ? Object.keys(r.detail.tricks).filter(k => /край|яму|столкн|рефлекс/.test(k)).map(k => `${k}×${r.detail.tricks[k]}`).join(', ') : ''
  console.log(`#${i + 1} от края ${off.toFixed(1)}, заход ${Math.round(ang * 57.3)}°: ${his != null ? `СБИЛ за ${his} с` : killed ? 'убил мечом, не сбил' : 'не сбил'}${mine != null ? ` | САМ УПАЛ за ${mine} с` : ''} | ${tr}`)
  return { his: his != null, mine: mine != null }
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await say('/gamerule send_command_feedback false')
    const res = []
    for (let i = 0; i < N; i++) res.push(await trial(i))
    console.log(`ИТОГ: сбил ${res.filter(x => x.his).length}/${res.length}, сам упал ${res.filter(x => x.mine).length}/${res.length}`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
