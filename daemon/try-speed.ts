'use strict'
const gameClock = require('./src/game-clock')
// Скорость под зельем: атрибут movement_speed приходит под чужим именем
// (gamedata.fixAttributes). С фиксом Скорость II ускоряет шаг тела, без —
// тело идёт базовой скоростью, а сервер ждёт быстрее.
const WebSocket = require('ws')
const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8766')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => { const rid = ++id; pending.set(rid, { resolve, reject }); ws.send(JSON.stringify({ id: rid, method, params })) })
ws.on('message', raw => { const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)) })
const sleep = ms => gameClock.sleep(ms)
const cmd = async (t) => { await call('say', { text: t }); await sleep(350) }
const X = 2200; const Y = 100; const Z = 1700
async function run (label, effect) {
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/effect clear @s')
  if (effect) await cmd(effect)
  await sleep(800)
  const t0 = gameClock.now()
  const r: any = await call('goto', { x: X + 60, y: Y, z: Z, range: 1, timeoutSeconds: 40 })
  const s = (gameClock.now() - t0) / 1000
  console.log(`${label}: ${r.status} ${s.toFixed(1)} с → ${(60 / s).toFixed(2)} бл/с`)
  return s
}
async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(2000)
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await sleep(2000)
  await cmd(`/fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 64} ${Y - 1} ${Z + 2} minecraft:stone`)
  await cmd(`/fill ${X - 2} ${Y} ${Z - 2} ${X + 64} ${Y + 3} ${Z + 2} minecraft:air`)
  const base = await run('без зелья', null)
  const fast = await run('Скорость II', '/effect give @s minecraft:speed 60 1 true')
  const slow = await run('Замедление I', '/effect give @s minecraft:slowness 60 0 true')
  await cmd('/effect clear @s')
  const ok = fast < base * 0.85 && slow > base * 1.05
  console.log(ok ? 'всё зелёное' : 'ПЛОХО: скорость зелья телом не учтена')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(2) })
