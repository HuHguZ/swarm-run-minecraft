'use strict'
import * as gameClock from '../../src/game-clock'
// Правда о стреле из игры: после каждого выстрела сервер отвечает точными
// Motion и Pos стрелы (/data get entity), а бот записывает, как он в момент
// спуска двигался и куда смотрел. Стоя и в стрейфе — чтобы увидеть, что
// именно сервер делает со стрелой, когда стрелок движется.
//   ND_WS=ws://127.0.0.1:8767 node try-bowtruth.js
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8767')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)
async function cmd (text) { await call('say', { text }); await sleep(350) }

const X = -500; const Y = 100; const Z = -500
const TOUGH = 'NoAI:1b,PersistenceRequired:1b,Silent:1b,attributes:[{id:"minecraft:max_health",base:1000}],Health:1000f'

async function run (label, params) {
  await cmd('/kill @e[type=arrow]')
  await cmd(`/tp @s ${X} ${Y} ${Z} 0 0`)
  await cmd('/clear @s minecraft:bow')
  await cmd('/give @s minecraft:bow')
  await sleep(500)
  const r: any = await call('shoot', { target: 'husk', count: 3, probe: true, ...params })
  console.log(`\n=== ${label} ===`)
  for (const s of (r.detail || {} as Record<string, any>).shots || []) {
    console.log(JSON.stringify({ wantYaw: s.diag && s.diag.wantYaw, pitchDeg: s.pitchDeg, release: s.release }))
    for (const line of s.server || []) console.log('   сервер:', line)
  }
  if (r.error) console.log('ошибка:', r.error)
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    await cmd(`/kill @e[type=!player,distance=..80]`)
    await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 10} ${X + 20} ${Y - 1} ${Z + 50} minecraft:stone`)
    await cmd(`/fill ${X - 20} ${Y} ${Z - 10} ${X + 20} ${Y + 12} ${Z + 50} minecraft:air`)
    await cmd('/give @s minecraft:arrow 64')
    await cmd(`/summon husk ${X} ${Y} ${Z + 16} {${TOUGH}}`)
    await run('стоя', { mode: 'raw' })
    await run('стрейф, без поправки', { mode: 'raw', strafe: true })
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
