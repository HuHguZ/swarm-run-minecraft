'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Жемчуг с обсидиановой платформы Энда на остров (s5, 06.10): на 750 тиках из 18 бросков боя перенесло 7, с платформы 0 из 9,
// на 20 тиках (ca3, xda1) — 67 из 67. Сцена: подготовка на 20 тиках, броски RPC throw на PEARL_RATE (по умолчанию TICK_RATE)
// с платформы в точку на острове; правда — forcedMove (перенос) и позиция после броска.
//   node dist/farm/farm.js run try-dragon-pearl.js --slots 1 --tag s5-pearl-a PEARLS=6 PEARL_RATE=750 PEARL_X=62
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const conn = connect(process.env.ND_WS || 'ws://127.0.0.1:8801')
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG || path.join(REPO_ROOT, 'server-end/logs/latest.log'), player: process.env.MC_USERNAME || 'NeuroEnd' })
const end = c => `/execute in minecraft:the_end run ${c.replace(/^\//, '')}`
const header = async () => ((await call('status')) || {}).state || {}
let seq = 0
async function blockIs (x, y, z, name) {
  const tag = `nd-block-${++seq}`
  const from = kit.serverLog.mark()
  await kit.cmd(`/execute in minecraft:the_end if block ${x} ${y} ${z} minecraft:${name} run say ${tag}`)
  await sleep(300)
  return kit.serverLog.linesFrom(from).lines.some(l => l.text.includes(`] ${tag}`) && !l.text.includes('issued server command'))
}
async function setRate (n) {
  await kit.cmd(`/tick rate ${n}`)
  for (let i = 0; i < 40 && (await header()).clock?.tickRate !== n; i++) await gameClock.wall.sleep(50)
}

async function main () {
  await conn.ready
  await call('connect')
  const rate = Number(process.env.PEARL_RATE || process.env.TICK_RATE || 20)
  const N = Number(process.env.PEARLS || 6)
  const X = Number(process.env.PEARL_X || 62)
  await setRate(20)
  await kit.cmd('/effect give @s minecraft:resistance 600 4 true')
  if ((await header()).dimension !== 'the_end') { await kit.ensureWorld('the_end', { tp: '100.5 60 0.5' }); await sleep(3000) }
  await kit.cmd(end('kill @e[type=minecraft:ender_dragon]'))
  await kit.cmd(end('tp @s 100.5 60 0.5'))
  await sleep(2000)
  await kit.cmd(end('fill 98 48 -2 102 48 2 minecraft:obsidian'))
  await kit.cmd(end('fill 98 49 -2 102 51 2 minecraft:air'))
  let ty = null
  for (let y = 75; y >= 45 && ty == null; y--) if (await blockIs(X, y, 0, 'end_stone')) ty = y + 1
  if (ty == null) { console.log(`   нет острова в ${X},?,0`); process.exit(2) }
  const to = { x: X + 0.5, y: ty, z: 0.5 }
  const rows = []
  for (let i = 1; i <= N; i++) {
    await setRate(20)
    await kit.cmd(end('kill @e[type=minecraft:enderman,distance=..40]'))
    await kit.cmd(end('tp @s 100.5 49 0.5 -90 0'))
    await kit.cmd('/clear @s minecraft:ender_pearl')
    await kit.cmd('/give @s minecraft:ender_pearl 4')
    await sleep(1500)
    if (rate !== 20) await setRate(rate)
    const s0 = (await header()).clock
    const r = await call('throw', { item: 'ender_pearl', to, mode: 'exact' }).catch(e => ({ error: e.message }))
    const st = await header()
    const d = (r && r.detail) || {}
    const p = st.pos || {}
    const moved = Math.hypot((p.x ?? 100.5) - 100.5, (p.z ?? 0.5) - 0.5) > 3
    const row = { i, rate, thrown: d.thrown ?? null, why: d.why ?? r.error ?? null, landed: d.landed ?? null, err: d.err ?? null, pos: [p.x, p.y, p.z].map(v => v == null ? null : +Number(v).toFixed(1)), moved, tps: s0?.effectiveRate ?? null }
    rows.push(row)
    console.log('   ' + JSON.stringify(row))
    if (process.env.E2E_OUT) (require('fs') as typeof import('fs')).appendFileSync(process.env.E2E_OUT, JSON.stringify(row) + '\n')
  }
  await setRate(20)
  const ok = rows.filter(r => r.moved).length
  console.log(`   ИТОГ: перенесло ${ok} из ${N} на ${rate} тиках/с (цель ${to.x},${to.y},${to.z})`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
