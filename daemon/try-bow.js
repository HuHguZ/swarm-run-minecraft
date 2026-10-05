'use strict'
const gameClock = require('./src/game-clock')
// Тир: насколько точно бот стреляет. Мишени — хаски с NoAI и запасом
// здоровья (не умирают, но урон и попадание сервер засчитывает), на разных
// дистанциях и высотах, плюс идущий зомби. Каждая стрела прослежена:
// попала или на сколько прошла мимо.
//   ND_WS=ws://127.0.0.1:8767 node try-bow.js
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8767')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
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

async function range () {
  await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
  await sleep(1500)
  await cmd(`/kill @e[type=!player,distance=..80]`)
  await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 10} ${X + 20} ${Y - 1} ${Z + 50} minecraft:stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 5} ${X + 10} ${Y + 12} ${Z + 50} minecraft:air`)
  await cmd(`/tp @s ${X} ${Y} ${Z}`)
  await cmd('/clear @s')
  await cmd('/give @s minecraft:bow')
  await cmd('/give @s minecraft:arrow 64')
}

async function lane (label, summon, n = 4) {
  await cmd('/kill @e[type=husk]')
  await cmd('/kill @e[type=zombie]')
  await cmd('/kill @e[type=arrow]')
  // Лук ломается (384 выстрела) — свежий на каждую дорожку.
  await cmd('/clear @s minecraft:bow')
  await cmd('/give @s minecraft:bow')
  // Со стрейфом бот уходит вбок — каждую дорожку с исходной точки.
  await cmd(`/tp @s ${X} ${Y} ${Z} 0 0`)
  await cmd(summon)
  await sleep(800)
  const r = await call('shoot', { target: summon.includes('zombie') ? 'zombie' : 'husk', count: n, strafe: !!process.env.STRAFE, mode: process.env.MODE || 'compensate' })
  const d = r.detail || {}
  const shots = (d.shots || []).map(s => (s.hit ? 'ПОПАЛ' : s.shot ? `мимо ${s.missBy ?? '?'}` : s.why) + (process.env.DIAG && s.diag ? ' ' + JSON.stringify(s.diag) : '')).join(', ')
  console.log(`${label}: ${d.hit ?? 0}/${d.of ?? 0}  [${shots}]${r.error ? ' — ' + r.error : ''}`)
  return { hit: d.hit || 0, of: d.of || 0 }
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/gamerule spawn_mobs false')
    await cmd('/time set day')
    await range()
    let hit = 0; let of = 0
    const add = r => { hit += r.hit; of += r.of }
    for (const dz of [8, 16, 24, 32, 40]) add(await lane(`${dz} блоков`, `/summon husk ${X} ${Y} ${Z + dz} {${TOUGH}}`))
    if (process.env.ONE_LANE) { console.log(`ИТОГО: ${hit}/${of}`); return }
    add(await lane('20 блоков, на 6 выше', `/summon husk ${X} ${Y + 6} ${Z + 20} {${TOUGH}}`))
    await cmd(`/setblock ${X} ${Y + 5} ${Z + 20} minecraft:stone`)
    add(await lane('20 блоков, сбоку 8', `/summon husk ${X + 8} ${Y} ${Z + 20} {${TOUGH}}`))
    // Движущаяся мишень: зомби идёт поперёк линии огня.
    await cmd('/effect give @s minecraft:resistance 99999 4 true')
    add(await lane('идущий зомби ~18 блоков', `/summon zombie ${X - 8} ${Y} ${Z + 18} {PersistenceRequired:1b,attributes:[{id:"minecraft:max_health",base:1000}],Health:1000f}`, 6))
    console.log(`\nИТОГО: ${hit}/${of} (${Math.round(100 * hit / Math.max(1, of))}%)`)
    await cmd('/effect clear @s')
    await cmd('/kill @e[type=husk]')
    await cmd('/kill @e[type=zombie]')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
