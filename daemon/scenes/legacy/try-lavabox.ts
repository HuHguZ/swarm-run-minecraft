'use strict'
import * as gameClock from '../../src/game-clock'
import { createGameBot } from '../lib/scene-kit'
// Лава на закрывшегося (живая арена 2026-09-26: противник закрылся в коробке,
// бот прыгнул ему на крышу и вылил лаву себе под ноги — на крышу, потом
// заложил её блоком). NeuroDown2 стоит в коробке из булыжника 1×2 с крышей
// (не дерётся), NeuroDown с лавой, киркой и мечом начинает бой: сцена
// «крыша» — стоя на крыше его коробки, «сбоку» — в двух шагах от стены.
// Надо: вскрыть крышу (или стену) и лить в дыру так, чтобы лава встала в его
// столб. Итог: где оказалась лава, сколько хп у него, что делал NeuroDown.
//   A=ws://127.0.0.1:8781 B=ws://127.0.0.1:8782 OBS=1 node try-lavabox.js [крыша,сбоку]
import WebSocket = require('ws')
import { Vec3 } from 'vec3'

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8781')
const B = client(process.env.B || 'ws://127.0.0.1:8782')
async function cmd (text) { await A.call('say', { text }); await sleep(60) }

const X = 800; const Y = 150; const Z = 800

let OBS = null
async function observer () {
  const ob = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25566), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise<void>((resolve, reject) => { ob.once('spawn', resolve); ob.once('error', reject); ob.once('kicked', reject) })
  await sleep(4000)
  ob.chat('/gamemode spectator'); await sleep(300)
  ob.chat(`/tp Probe1 ${X + 0.5} ${Y + 6} ${Z - 6}`); await sleep(800)
  return ob
}

async function stage (name, { roof = true, seconds = 20 }: any) {
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 8} ${Z + 8} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'lava_bucket', 'cobblestone 32']) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown minecraft:${n} ${c || 1}`) }
  await cmd('/item replace entity NeuroDown2 armor.chest with minecraft:diamond_chestplate')
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await sleep(700)
  // Коробка: пустота 1×2 вокруг его ног и головы, всё вокруг — булыжник
  // (пол, стены, крыша 3×3).
  await cmd(`/fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 1} ${Y + 2} ${Z + 1} minecraft:cobblestone hollow`)
  if (roof) await cmd(`/tp NeuroDown ${X + 0.5} ${Y + 3} ${Z + 0.5} 0 0`)
  else await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 3.5} 180 0`)
  for (const w of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  const hp0 = (((await B.call('status')) as any).state || {} as Record<string, any>).health
  const t0 = gameClock.now()
  let lavaAt = null
  const col = [new Vec3(X, Y, Z), new Vec3(X, Y + 1, Z), new Vec3(X, Y + 2, Z)]
  const ownFeet = new Vec3(X, Y + 3, Z)
  let lavaOnRoof = null
  const iv = OBS ? gameClock.setInterval(() => {
    if (lavaAt == null && col.some(c => /lava/.test((OBS.blockAt(c) || {} as Record<string, any>).name || ''))) lavaAt = gameClock.now() - t0
    if (lavaOnRoof == null && /lava/.test((OBS.blockAt(ownFeet) || {} as Record<string, any>).name || '')) lavaOnRoof = gameClock.now() - t0
  }, 50) : null
  const r: any = await A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  if (iv) gameClock.clearInterval(iv)
  await A.call('stop').catch(() => {})
  const hp1 = (((await B.call('status').catch(() => ({} as Record<string, any>))) as any).state || {} as Record<string, any>).health
  const d = r.detail || {} as Record<string, any>
  const tricks = Object.entries<any>(d.tricks || {} as Record<string, any>).filter(([k]: any) => /лав|крыш|яма|ям|коробк|выломал|пробил|сошёл|вскры/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
  console.log(`[${name}] ${r.status}${d.killed ? ' УБИЛ' : ''} | его хп ${hp0}→${hp1} | лава в его столбе: ${lavaAt != null ? (lavaAt / 1000).toFixed(1) + ' с' : 'нет'}${roof ? ` | лава на крыше под собой: ${lavaOnRoof != null ? (lavaOnRoof / 1000).toFixed(1) + ' с' : 'нет'}` : ''}`)
  console.log(`   приёмы: ${tricks || '-'}`)
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 8} ${Y + 8} ${Z + 8} minecraft:air replace minecraft:lava`)
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`)
    await sleep(1500)
    if (process.env.OBS) { await cmd('/op Probe1'); OBS = await observer() }
    const only = (process.argv[2] || 'крыша,сбоку').split(',')
    const reps = Number(process.env.REPS || 1)
    for (let i = 1; i <= reps; i++) {
      if (only.includes('крыша')) await stage(`крыша #${i}`, { roof: true })
      if (only.includes('сбоку')) await stage(`сбоку #${i}`, { roof: false })
    }
    await cmd(`/forceload remove ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (OBS) try { OBS.quit() } catch {}
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
