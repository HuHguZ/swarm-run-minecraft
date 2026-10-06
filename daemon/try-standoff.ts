'use strict'
const gameClock = require('./src/game-clock')
// Стояние на столбах (интеграционная арена 2026-09-26): оба бота на своих
// столбах в 4–5 блоках над полом, в 4.8 друг от друга, минутами без удара.
// Сцена: два столба высотой H, между ними пусто; оба дерутся друг с другом.
// Меряем: через сколько первый удар, чем решили (мост, спуск), удары.
//   A=ws://127.0.0.1:8783 B=ws://127.0.0.1:8784 node try-standoff.js
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
const A = client(process.env.A || 'ws://127.0.0.1:8783')
const B = client(process.env.B || 'ws://127.0.0.1:8784')
async function cmd (text) { await A.call('say', { text }); await sleep(60) }

const X = 400; const Y = 150; const Z = 400

async function stage (name, { h = 5, gap = 4, blocks = true }: any) {
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 12} ${Z + 12} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  // Два столба 1×1 высотой h: ноги бойцов на Y + h, между центрами gap + 1.
  await cmd(`/fill ${X} ${Y} ${Z} ${X} ${Y + h - 1} ${Z} minecraft:stone`)
  await cmd(`/fill ${X} ${Y} ${Z + gap + 1} ${X} ${Y + h - 1} ${Z + gap + 1} minecraft:stone`)
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    await cmd(`/give ${who} minecraft:iron_sword`)
    if (blocks) await cmd(`/give ${who} minecraft:cobblestone 32`)
    await cmd(`/effect give ${who} minecraft:instant_health 1 5 true`)
  }
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y + h} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y + h} ${Z + gap + 1.5} 180 0`)
  await sleep(1500)
  const t0 = gameClock.now()
  let firstHit = null
  const watch = gameClock.setInterval(async () => {
    const [sa, sb] = await Promise.all([A.call('status').catch(() => null), B.call('status').catch(() => null)])
    const hurt = (s) => s && s.state && s.state.health < 19.5
    if (!firstHit && (hurt(sa) || hurt(sb))) firstHit = gameClock.now() - t0
  }, 300)
  const opts = (t) => ({ target: t, allowPlayer: true, timeoutSeconds: 25, retreatAtHealth: 2 })
  const [ra, rb] = await Promise.all([
    A.call('fight', opts('NeuroDown2')).catch(e => ({ error: e.message })),
    B.call('fight', opts('NeuroDown')).catch(e => ({ error: e.message }))
  ])
  gameClock.clearInterval(watch)
  const pick = (r) => {
    const d = (r && r.detail) || {} as Record<string, any>
    const tricks = Object.entries<any>(d.tricks || {} as Record<string, any>).filter(([k]: any) => /мост|спрыг|столб|застря/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
    return `удары ${d.swings ?? '?'}/${d.landed ?? '?'} ${tricks || '-'}`
  }
  console.log(`[${name}] первый урон через ${firstHit ? (firstHit / 1000).toFixed(1) + ' с' : '— (нет)'} | A: ${pick(ra)} | B: ${pick(rb)}`)
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await stage('столбы 5, щель 4, есть блоки', { h: 5, gap: 4, blocks: true })
    if (!process.env.ONE) await stage('столбы 5, щель 4, блоков нет', { h: 5, gap: 4, blocks: false })
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
