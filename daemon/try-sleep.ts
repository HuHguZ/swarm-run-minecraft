'use strict'
const gameClock = require('./src/game-clock')
// Focused repro for the night cycle: force night, get a bed, lie down, get up.
// Sleeping used to fail with "there's only half bed" and the error carried no
// information at all, so this harness prints the raw detail of every step.
//
// Uses the bot's own operator rights for /time and /give — the point here is
// the sleep code path, not the fetch quest that leads up to it.
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

async function step (label, method, params) {
  try {
    const r: any = await call(method, params)
    const detail = r.detail ? JSON.stringify(r.detail) : ''
    const problem = r.status === 'failed'
      ? ` ← ${r.error}`
      : r.status === 'timeout' ? ' ← таймаут' : ''
    console.log(`${label.padEnd(20)} ${String(r.status).padEnd(10)} ${detail}${problem}`)
    return r
  } catch (e) {
    console.log(`${label.padEnd(20)} RPC-ОШИБКА ${e.message}`)
    return { status: 'failed', error: e.message }
  }
}

ws.on('open', async () => {
  try {
    await call('connect')

    // Server-side setup. Each command needs a moment to land before the next
    // step reads the world.
    for (const cmd of [
      // Wipe first: repeated /give across runs fills the backpack, and a full
      // backpack makes /give drop the item on the floor instead. Two probe
      // runs failed on "кровати нет" for exactly that reason.
      '/clear @s',
      '/weather clear',
      '/effect give @s minecraft:instant_health 1 20 true',
      '/give @s minecraft:white_bed 1'
    ]) {
      await call('say', { text: cmd })
      await sleep(600)
    }
    await sleep(1200)

    const st: any = await call('status')
    console.log('старт:', JSON.stringify(st.state.pos), 'hp', st.state.health,
      'время', st.state.time, 'инвентарь', JSON.stringify(st.state.inventory))
    console.log('')

    // PRE_PLACE=1 exercises the harder case: a bed dropped by the generic
    // placer, which does not care which way it faces. Without it mc_sleep uses
    // its own bed-aware placement.
    if (process.env.PRE_PLACE) {
      await step('поставить кровать', 'place', { block: 'white_bed' })
      await sleep(800)
    }

    // Night has to be set right before the attempt: a previous successful
    // sleep skips the night, and the next run then finds it is morning again.
    await call('say', { text: '/time set 13000' })
    await sleep(900)
    console.log('время перед сном:', JSON.stringify(((await call('observe', { radius: 4 })) as any).state.time))

    const slept: any = await step('лечь спать', 'sleep', {} as Record<string, any>)
    if (slept.status === 'done') {
      await sleep(2000)
      await step('встать', 'wake', {} as Record<string, any>)
      const after: any = await call('status')
      console.log('после сна: время', after.state.time)
    }

    await step('осмотреться', 'observe', { radius: 8 })
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
