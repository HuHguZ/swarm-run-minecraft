'use strict'
const gameClock = require('./src/game-clock')
// Milestone-3 ground work: horizontal drift, emergency shelter, and walking
// back for your own loot. Also the first real exercise of mc_drop.
//
// Builds a solid stone block of world and carves a single pocket to stand in,
// because the surface has no honest place to test a mine shaft and a half-dug
// hillside makes every failure ambiguous.
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
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

async function cmd (text) {
  await call('say', { text })
  await sleep(650)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(22)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  return r
}

// A cube of stone with a 1x2 pocket at the centre, plus two ore blocks sitting
// in the wall the drift will cut past — the ore report is only meaningful if
// there is ore to report.
async function digsite () {
  // Wipe first: a backpack full of cobblestone from earlier runs makes /give
  // silently drop the pickaxe on the floor, and then every dig refuses.
  await cmd('/clear @s')
  await cmd('/tp @s -15 45 62')
  await cmd('/fill -26 36 51 -4 44 73 minecraft:stone')
  await cmd('/setblock -15 39 62 minecraft:air')
  await cmd('/setblock -15 40 62 minecraft:air')
  await cmd('/tp @s -15 39 62')
  await cmd('/effect give @s minecraft:instant_health 1 20 true')
  await cmd('/setblock -12 39 63 minecraft:iron_ore')
  await cmd('/setblock -10 40 61 minecraft:coal_ore')
  await cmd('/give @s minecraft:iron_pickaxe 1')
  await cmd('/give @s minecraft:torch 16')
  await cmd('/give @s minecraft:cobblestone 64')
  await cmd('/give @s minecraft:cooked_beef 10')
  await sleep(800)
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/time set 6000')
    await cmd('/gamerule spawn_mobs false')
    await digsite()

    const st: any = await call('status')
    console.log('старт:', JSON.stringify(st.state.pos), 'инвентарь', JSON.stringify(st.state.inventory), '\n')

    await step('штрек на восток 8', 'tunnel', { direction: 'east', length: 8, torchEvery: 4, timeoutSeconds: 150 })

    console.log('')
    const dropped: any = await step('выбросить мясо', 'drop', { item: 'cooked_beef', count: 4 })
    const here = ((await call('status')) as any).state.pos
    await step('отойти', 'goto', { x: here.x - 5, z: here.z, range: 1, timeoutSeconds: 30 })
    await step('вернуться за лутом', 'recover', { x: here.x, y: here.y, z: here.z, radius: 6, timeoutSeconds: 60 })
    if (dropped.status === 'done') {
      const back: any = await call('status')
      console.log('мясо после подбора:', back.state.inventory.cooked_beef ?? 0)
    }

    console.log('')
    await step('закопаться', 'shelter', { mode: 'enter', depth: 2 })
    await sleep(1000)
    await step('выкопаться', 'shelter', { mode: 'exit' })

    await step('осмотреться', 'observe', { radius: 10 })
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
