'use strict'
const gameClock = require('./src/game-clock')
// Побег с оглядкой (flee.js) на тестовом Paper. Бот на ровном поле, вокруг
// толпа: зомби с двух сторон, скелет, крипер. Проверяем, что он бежит в
// свободную сторону, а не в соседнего моба, и сколько хп это стоит.
//   ND_WS=ws://127.0.0.1:8767 node try-flee.js
const WebSocket = require('ws')

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
async function cmd (text) { await call('say', { text }); await sleep(400) }

const X = -300; const Y = 100; const Z = -300

async function field () {
  await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
  await sleep(1500)
  await cmd('/difficulty normal')
  await cmd(`/kill @e[type=!player,distance=..60]`)
  await cmd(`/fill ${X - 30} ${Y - 1} ${Z - 30} ${X + 30} ${Y - 1} ${Z + 30} minecraft:grass_block`)
  await cmd(`/fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y + 5} ${Z + 30} minecraft:air`)
  await cmd(`/tp @s ${X} ${Y} ${Z}`)
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await cmd('/clear @s')
}

async function scene (label, summons, params: any = {} as Record<string, any>) {
  console.log(`\n=== ${label} ===`)
  await field()
  for (const s of summons) await cmd(`/summon minecraft:${s.mob} ${X + s.dx} ${Y} ${Z + s.dz}`)
  await sleep(600)
  const before: any = await call('status')
  const r: any = await call('flee', { timeoutSeconds: 15, ...params })
  const after: any = await call('status')
  console.log(`статус: ${r.status}${r.error ? ' — ' + r.error : ''}`)
  console.log('детали:', JSON.stringify(r.detail))
  console.log(`хп ${before.state.health} -> ${after.state.health}; ${JSON.stringify(before.state.pos)} -> ${JSON.stringify(after.state.pos)}`)
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/time set 18000')
    await cmd('/gamerule spawn_mobs false')
    // Зомби с запада и востока, север свободен — бежать должен на север/юг.
    await scene('зомби с двух сторон', [{ mob: 'zombie', dx: -4, dz: 0 }, { mob: 'zombie', dx: 4, dz: 0 }, { mob: 'zombie', dx: 0, dz: 5 }])
    // Крипер рядом и скелет в стороне.
    await scene('крипер и скелет', [{ mob: 'creeper', dx: 3, dz: 1 }, { mob: 'skeleton', dx: -10, dz: -6 }])
    // Толпа: 4 зомби и скелет — должен найти дыру.
    await scene('толпа', [{ mob: 'zombie', dx: -5, dz: 0 }, { mob: 'zombie', dx: 5, dz: 0 }, { mob: 'zombie', dx: 0, dz: -5 }, { mob: 'husk', dx: 4, dz: 4 }, { mob: 'skeleton', dx: -12, dz: 8 }])
    await cmd(`/kill @e[type=!player,distance=..80]`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
