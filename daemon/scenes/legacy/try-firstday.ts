'use strict'
import * as gameClock from '../../src/game-clock'
// Walks the whole first-day chain: log -> planks -> table -> sticks -> pickaxe
// -> stone -> stone pickaxe. Each step prints what actually happened.
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

function inv (state) {
  const e = Object.entries<any>(state.inventory || {} as Record<string, any>)
  return e.length ? e.map(([k, v]: any) => `${k}×${v}`).join(' ') : 'пусто'
}

async function step (label, method, params) {
  try {
    const r: any = await call(method, params)
    const detail = r.detail ? JSON.stringify(r.detail) : ''
    const problem = r.status === 'failed'
      ? ` ← ${r.error}`
      : r.status === 'timeout'
        ? ' ← таймаут'
        : r.status === 'interrupted'
          ? ` ← прервано: ${JSON.stringify(r.by)}`
          : ''
    console.log(`${label.padEnd(22)} ${String(r.status).padEnd(11)} ${detail}${problem}`)
    console.log(`${''.padEnd(22)} инвентарь: ${inv(r.state)}`)
    return r
  } catch (e) {
    console.log(`${label.padEnd(22)} RPC-ОШИБКА  ${e.message}`)
    return { status: 'failed' }
  }
}

ws.on('open', async () => {
  try {
    await call('connect')
    await call('set_goal', { text: 'пережить первый день: инструменты и еда' })

    const look: any = await call('observe', { radius: 48 })
    console.log('вижу вокруг:', JSON.stringify(look.detail.blocks.map(b => `${b.name}×${b.count}@${b.dist}`)))
    console.log('')

    for (let i = 1; i <= 10; i++) {
      const r: any = await step(`разведка дерева #${i}`, 'explore',
        { block: 'any_log', radius: 48, stepDistance: 60, timeoutSeconds: 60 })
      if (r.detail && r.detail.found) break
      // A grind should not abandon the search just because someone said hello.
      if (r.status === 'failed' || r.status === 'timeout') break
    }

    await step('добыть 4 бревна', 'mine', { block: 'any_log', count: 4, radius: 48, timeoutSeconds: 240 })
    await step('доски', 'craft', { item: 'oak_planks', count: 3 })
    await step('верстак', 'craft', { item: 'crafting_table' })
    await step('поставить верстак', 'place', { block: 'crafting_table' })
    await step('палки', 'craft', { item: 'stick' })
    await step('деревянная кирка', 'craft', { item: 'wooden_pickaxe' })
    await step('добыть 8 камня', 'mine', { block: 'stone', count: 8, radius: 48, timeoutSeconds: 240 })
    await step('каменная кирка', 'craft', { item: 'stone_pickaxe' })
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
