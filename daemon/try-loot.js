'use strict'
// Лут: три сундука. Данж (спавнер + замшелый булыжник) и вагонетка на рельсах
// с паутиной — автопилот должен забрать сам. Сундук у верстака и печи — чей-то,
// его трогать нельзя: только событие loot_seen.
//   ND_WS=ws://127.0.0.1:8767 node try-loot.js
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
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cmd (text) { await call('say', { text }); await sleep(350) }

const X = -700; const Y = 100; const Z = -700

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    await cmd('/gamerule spawn_mobs false')
    await cmd('/time set day')
    await cmd(`/kill @e[type=!player,distance=..60]`)
    await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:stone`)
    await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 6} ${Z + 20} minecraft:air`)
    await cmd('/clear @s')
    // Данж: спавнер, замшелый булыжник, сундук с добычей.
    await cmd(`/fill ${X + 6} ${Y} ${Z + 4} ${X + 10} ${Y} ${Z + 8} minecraft:mossy_cobblestone`)
    await cmd(`/fill ${X + 6} ${Y} ${Z + 4} ${X + 10} ${Y} ${Z + 8} minecraft:air replace minecraft:mossy_cobblestone`)
    await cmd(`/fill ${X + 6} ${Y - 1} ${Z + 4} ${X + 10} ${Y - 1} ${Z + 8} minecraft:mossy_cobblestone`)
    await cmd(`/setblock ${X + 8} ${Y} ${Z + 6} minecraft:spawner`)
    await cmd(`/setblock ${X + 8} ${Y} ${Z + 8} minecraft:chest{Items:[{Slot:0b,id:"minecraft:diamond",count:3},{Slot:1b,id:"minecraft:golden_apple",count:1},{Slot:2b,id:"minecraft:saddle",count:1}]}`)
    // Чей-то сундук: у верстака и печи.
    await cmd(`/setblock ${X - 8} ${Y} ${Z + 6} minecraft:crafting_table`)
    await cmd(`/setblock ${X - 7} ${Y} ${Z + 6} minecraft:furnace`)
    await cmd(`/setblock ${X - 8} ${Y} ${Z + 7} minecraft:chest{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:10}]}`)
    // Шахта: рельсы, паутина, вагонетка с сундуком.
    await cmd(`/fill ${X} ${Y} ${Z - 10} ${X} ${Y} ${Z - 4} minecraft:rail`)
    await cmd(`/setblock ${X + 1} ${Y + 1} ${Z - 7} minecraft:cobweb`)
    await cmd(`/summon minecraft:chest_minecart ${X} ${Y} ${Z - 7} {Items:[{Slot:0b,id:"minecraft:bread",count:5},{Slot:1b,id:"minecraft:iron_ingot",count:4}]}`)
    await cmd(`/tp @s ${X} ${Y} ${Z}`)
    await sleep(1000)

    const seen = await call('loot_seen', { radius: 24 })
    console.log('видит:', JSON.stringify((seen.detail || {}).chests, null, 0))

    // Ждём автопилот: он сам сходит к двум лутовым.
    const events = []
    for (let i = 0; i < 9; i++) {
      const r = await call('wait', { seconds: 10 })
      for (const e of r.events || []) if (/loot/.test(e.type)) events.push(e)
      if (events.filter(e => e.type === 'looted').length >= 2) break
    }
    for (const e of events) console.log(e.type, JSON.stringify({ at: e.at, guess: e.guess, why: e.why, took: e.took, stopped: e.stopped, error: e.error }))
    const st = await call('status')
    console.log('инвентарь:', st.state.inventory ? JSON.stringify(st.state.inventory) : JSON.stringify(st.state))
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
