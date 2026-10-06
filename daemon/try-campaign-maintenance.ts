'use strict'
const gameClock = require('./src/game-clock')
// Короткая проверка на существующем рюкзаке NeuroRun: без /give и сброса мира.
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8769')
const pending = new Map()
let id = 0
function call (method, params: any = {} as Record<string, any>) {
  return new Promise<any>((resolve, reject) => {
    const rid = ++id
    const timer = gameClock.wall.setTimeout(() => { pending.delete(rid); reject(new Error(`${method}: время вышло`)) }, 25000)
    pending.set(rid, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
}
ws.on('message', raw => {
  const r = JSON.parse(raw); gameClock.follow(r.clock || r.result?.state?.clock || r.result?.clock)
  const p = pending.get(r.id)
  if (!p) return
  gameClock.wall.clearTimeout(p.timer)
  pending.delete(r.id)
  r.ok ? p.resolve(r.result) : p.reject(new Error(r.error))
})
ws.on('error', err => { console.error(err.message); process.exitCode = 1 })
ws.on('open', async () => {
  try {
    const target: any = await call('status')
    assert.equal(target.detail.server, '127.0.0.1:25569', 'проверка разрешена только в мире прохождения')
    assert.equal(target.detail.fairPlay, true)
    await call('connect')
    const before: any = await call('pack', { mode: 'status' })
    const cleaned: any = await call('pack', { mode: 'tidy', also: 'cobblestone:128, cobbled_deepslate:128, netherrack:64, raw_copper:0, copper_ingot:0, leaf_litter:0, magma_block:0, nether_brick_fence:0, nether_bricks:0' })
    // Задержка подбора выброшенного — 2 с: результат сразу после броска
    // не доказывает, что свободные клетки сохранились.
    await gameClock.sleep(3500)
    const after: any = await call('pack', { mode: 'status' })
    for (const [name, count] of Object.entries<any>(before.state.inventory || {} as Record<string, any>)) {
      if (/_(pickaxe|sword|axe|shovel)$|^(bow|arrow|blaze_rod|ender_pearl|ender_eye|obsidian|gold_ingot|potion|splash_potion|water_bucket|crafting_table)$/.test(name)) {
        assert.ok((after.state.inventory[name] || 0) >= count, `${name} должен сохраниться`)
      }
    }
    console.log(JSON.stringify({ before: before.detail, tossed: cleaned.detail.tossed, after: after.detail, pos: after.state.pos }, null, 2))
    assert.ok(after.detail.free >= 8, `после задержки подбора свободно только ${after.detail.free}`)
    console.log('OK: место освобождено, предметы прохождения сохранены')
  } catch (err) {
    console.error(err.stack || err.message)
    process.exitCode = 1
  } finally {
    for (const p of pending.values()) gameClock.wall.clearTimeout(p.timer)
    ws.close()
  }
})
