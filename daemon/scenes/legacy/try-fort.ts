'use strict'
import * as gameClock from '../../src/game-clock'
// Крепость против толпы: бот побит (11 хп), на него идут три зомби. Надо:
// закрыться в коробке из булыжника, отлечиться внутри (яблоко), бить через
// дыры, если есть, выйти киркой и добить. Зомби блоки не ломают.
//   ND_WS=ws://127.0.0.1:8767 node try-fort.js
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
async function cmd (text) { await call('say', { text }); await sleep(300) }

const X = -1000; const Y = 100; const Z = -1000

ws.on('open', async () => {
  try {
    await call('connect')
    await call('temper', { enabled: false })
    await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    await cmd('/gamerule spawn_mobs false')
    await cmd('/difficulty normal')
    await cmd('/time set 18000')
    await cmd(`/kill @e[type=!player,distance=..60]`)
    await cmd(`/fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} minecraft:stone`)
    await cmd(`/fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 8} ${Z + 15} minecraft:air`)
    await cmd('/clear @s')
    await cmd('/effect clear @s')
    for (const it of ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'golden_apple 2', 'iron_chestplate']) {
      const [n, c] = it.split(' ')
      await cmd(`/give @s minecraft:${n} ${c || 1}`)
    }
    await call('armor')
    await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
    await cmd('/effect give @s minecraft:instant_health 1 5 true')
    await sleep(500)
    await cmd('/damage @s 9 minecraft:generic')
    await sleep(400)
    for (const [dx, dz] of [[0, 6], [4, 5], [-4, 5]]) {
      await cmd(`/summon zombie ${X + dx} ${Y} ${Z + dz} {PersistenceRequired:1b}`)
    }
    await sleep(300)
    const r: any = await call('fight', { target: 'zombie', clearArea: 20, timeoutSeconds: 120, retreatAtHealth: 3 })
    const d = r.detail || {} as Record<string, any>
    console.log('статус:', r.status, r.error || '')
    console.log('убил:', d.kills || d.killed || '-', '| хп', d.hp, '| блоков', d.blocks || 0)
    console.log('приёмы:', JSON.stringify(d.tricks))
    console.log('лечился:', JSON.stringify(d.healed))
    if (d.lowHealth || d.retreated) console.log('отступил:', JSON.stringify(d))
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
