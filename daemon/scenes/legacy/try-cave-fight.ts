'use strict'
import * as gameClock from '../../src/game-clock'
// Fighting underground, which is where the expedition actually dies. Two shapes
// matter and they are opposites:
//
//   1. A mine tunnel, 1 wide and 2 high. The best ground there is: one block
//      seals it and only one mob can reach you.
//   2. A cave breach — the staircase cuts into an open room and the bot is
//      suddenly in the open with several mobs and no wall to put up.
//
// The arena is built in a solid block of stone so neither case is polluted by
// natural terrain. /fill only works in loaded chunks and refuses over 32768
// blocks, so the bot is teleported into place first and every volume is small.
import WebSocket = require('ws')

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
const pos = async () => ((await call('status')) as any).state.pos

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type}`)
  return r
}

// Solid rock, one straight corridor, and a room at the far end of it.
async function arena () {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player,type=!item]')
  await cmd('/tp @s 315 62 315')
  // Своя сложность, а не унаследованная: на peaceful призванный моб исчезает
  // следующим тиком, и боевая сцена молча меряет пустоту.
  await cmd('/difficulty normal')
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // let the chunks arrive before filling them
  await cmd('/fill 300 40 300 329 60 329 minecraft:stone')
  await cmd('/fill 305 50 315 325 51 315 minecraft:air')   // corridor, 1 wide 2 high
  await cmd('/fill 316 50 308 325 54 314 minecraft:air')   // the cave it opens into
  await cmd('/clear @s')
  for (const give of [
    'minecraft:iron_sword 1', 'minecraft:iron_pickaxe 1', 'minecraft:cobblestone 64',
    'minecraft:torch 16', 'minecraft:cooked_beef 16',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ]) await cmd(`/give @s ${give}`)
  await cmd('/tp @s 306 50 315')
  await sleep(2500)
  await cmd('/effect give @s minecraft:regeneration 20 5 true')
  await sleep(5000)
}

async function bout (label, summonAt, params) {
  console.log(`\n=== ${label} ===`)
  await arena()
  for (const at of summonAt) await cmd(`/summon minecraft:${at}`)
  await sleep(1200)

  const before: any = await call('status')
  let watching = true
  const track = []
  const watcher = (async () => {
    while (watching) {
      try {
        const st: any = await call('status')
        track.push(`hp${st.state.health}@${st.state.pos.x},${st.state.pos.y},${st.state.pos.z}`)
      } catch {}
      await sleep(900)
    }
  })()

  const r = await step('драка', 'fight', params)
  watching = false
  await watcher
  const after: any = await call('status')
  console.log('трасса:', track.join(' '))
  console.log(`hp ${before.state.health} -> ${after.state.health} | ${JSON.stringify(before.state.pos)} -> ${JSON.stringify(after.state.pos)}`)
  return r
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/gamerule spawn_mobs false')

    // In the corridor, bailing on the first hit: the confined retreat.
    await bout('зомби в штреке, отступать сразу', ['zombie 312 50 315'],
      { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 45 })

    // Same corridor, fight it out: the corridor should be favourable ground.
    await bout('зомби в штреке, драка до конца', ['zombie 312 50 315'],
      { target: 'zombie', retreatAtHealth: 5, timeoutSeconds: 45 })

    // An archer down the corridor: nowhere sideways to dodge.
    await bout('скелет в штреке', ['skeleton 320 50 315'],
      { target: 'skeleton', retreatAtHealth: 19, timeoutSeconds: 45 })

    // The breach: three mobs in the open room the tunnel runs into.
    await bout('прорыв в пещеру, трое', ['zombie 320 50 311', 'zombie 321 50 312', 'skeleton 322 50 310'],
      { retreatAtHealth: 14, timeoutSeconds: 60 })

    await cmd('/kill @e[type=!player,type=!item]')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
