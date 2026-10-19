'use strict'
import * as gameClock from '../../src/game-clock'
// Стрелы не берут (2026-09-26: на живой арене с чарами «Защита от снарядов»
// на броне — перестрелка на 7 минут вничью). NeuroDown в алмазе с «Защитой от
// снарядов IV» на всех кусках, с мечом; NeuroDown2 с арбалетом (быстрая
// перезарядка), луком, стрелами и мечом начинает бой с DIST блоков. Надо: не
// держать дистанцию, а идти в ближний бой. Мерим урон по A за SECONDS секунд.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-ppweak.js
import WebSocket = require('ws')

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
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
async function cmd (text) { await A.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 150; const Z = 1200
const SECONDS = Number(process.env.SECONDS || 30)
const DIST = Number(process.env.DIST || 20)

async function round (k) {
  await cmd(`/fill ${X - 26} ${Y - 1} ${Z - 26} ${X + 26} ${Y - 1} ${Z + 26} minecraft:stone`)
  await cmd(`/fill ${X - 26} ${Y} ${Z - 26} ${X + 26} ${Y + 10} ${Z + 26} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  await cmd(`/kill @e[type=arrow,x=${X},y=${Y},z=${Z},distance=..40]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const [slot, it] of [['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'], ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots']]) {
    await cmd(`/item replace entity NeuroDown ${slot} with minecraft:${it}[enchantments={projectile_protection:4}]`)
  }
  await cmd('/give NeuroDown minecraft:diamond_sword')
  await cmd('/item replace entity NeuroDown2 armor.chest with minecraft:diamond_chestplate')
  for (const it of ['diamond_sword', 'crossbow[enchantments={quick_charge:3}]', 'bow', 'arrow 64']) {
    const m = it.match(/^(\S+?)(?: (\d+))?$/)
    await cmd(`/give NeuroDown2 minecraft:${m[1]} ${m[2] || 1}`)
  }
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + DIST + 0.5} 180 0`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  let hp = (((await A.call('status')) as any).state || {} as Record<string, any>).health ?? 20
  let dealt = 0
  let polling = true
  const poll = (async () => {
    while (polling) {
      try {
        const h = (((await A.call('status')) as any).state || {} as Record<string, any>).health
        if (h != null && h < hp) dealt += hp - h
        if (h != null) hp = h
      } catch {}
      await sleep(100)
    }
  })()
  // A только защищается рядом (не гонится): бой ведёт B.
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const rb: any = await fb
  polling = false
  await poll
  await B.call('stop').catch(() => {})
  const d = rb.detail || {} as Record<string, any>
  const tricks = Object.entries<any>(d.tricks || {} as Record<string, any>).filter(([k]: any) => /стрел|арбалет|лук|ближний|дистанц/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
  console.log(`[пп #${k}] ${rb.status}${d.killed ? ' УБИЛ' : ''} | урон по A ${dealt.toFixed(1)} за ${SECONDS} с | взмахов ${d.swings ?? '?'} | ${tricks || '-'}`)
  return dealt
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 28} ${Z - 28} ${X + 28} ${Z + 28}`)
    let sum = 0
    const reps = Number(process.env.REPS || 2)
    for (let k = 1; k <= reps; k++) sum += await round(k)
    console.log(`ИТОГО: урон по A ${sum.toFixed(1)} за ${reps} × ${SECONDS} с`)
    await cmd(`/forceload remove ${X - 28} ${Z - 28} ${X + 28} ${Z + 28}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
