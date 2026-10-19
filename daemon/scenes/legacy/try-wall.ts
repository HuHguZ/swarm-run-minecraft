'use strict'
import * as gameClock from '../../src/game-clock'
// Бот снаружи стеклянной комнаты с проёмом в 2 блока, внутри мобы. Раньше:
// стрелял в стекло и прорубал стену топором. Надо: в стекло не стрелять,
// стен не ломать, зайти через проём и убить.
//   ND_WS=ws://127.0.0.1:8767 node try-wall.js
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

const X = -900; const Y = 100; const Z = -900

ws.on('open', async () => {
  try {
    await call('connect')
    await call('temper', { enabled: false })
    await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    await cmd('/gamerule spawn_mobs false')
    await cmd('/time set 18000')
    await cmd(`/kill @e[type=!player,distance=..60]`)
    await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:stone`)
    await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 6} ${Z + 20} minecraft:air`)
    // Комната 11×11 из стекла, крыша, проём 1×2 в южной стене — не напротив бота.
    await cmd(`/fill ${X - 5} ${Y} ${Z + 4} ${X + 5} ${Y + 4} ${Z + 14} minecraft:glass hollow`)
    await cmd(`/fill ${X - 5} ${Y - 1} ${Z + 4} ${X + 5} ${Y - 1} ${Z + 14} minecraft:stone`)
    await cmd(`/fill ${X + 5} ${Y} ${Z + 9} ${X + 5} ${Y + 1} ${Z + 9} minecraft:air`)
    const before = await call('status')
    const glassBefore = 11 * 11 * 2 + 11 * 3 * 4
    await cmd('/clear @s')
    for (const it of ['bow', 'arrow 32', 'iron_sword', 'iron_axe', 'iron_chestplate']) {
      const [n, c] = it.split(' ')
      await cmd(`/give @s minecraft:${n} ${c || 1}`)
    }
    await call('armor')
    await cmd(`/summon zombie ${X} ${Y} ${Z + 10} {PersistenceRequired:1b}`)
    await cmd(`/summon zombie ${X - 2} ${Y} ${Z + 12} {PersistenceRequired:1b}`)
    await cmd(`/tp @s ${X} ${Y} ${Z - 4} 0 0`)
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await sleep(800)
    const r: any = await call('fight', { target: 'zombie', clearArea: 30, timeoutSeconds: 90, retreatAtHealth: 3 })
    const d = r.detail || {} as Record<string, any>
    console.log('статус:', r.status, r.error || '')
    console.log('убил:', d.kills || d.killed, '| выстрелов:', d.arrows || 0, '| приёмы:', JSON.stringify(d.tricks), '| хп', d.hp)
    // Цела ли стена: считаем стекло в оболочке комнаты.
    await cmd(`/fill ${X + 5} ${Y} ${Z + 9} ${X + 5} ${Y + 1} ${Z + 9} minecraft:glass`)
    const holes = []
    for (const [x, z] of [[X - 5, Z + 9], [X, Z + 4], [X, Z + 14], [X + 5, Z + 6]]) holes.push(`${x},${z}`)
    console.log('проверь глазами стену; проём закрыт командой после боя')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
