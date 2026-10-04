'use strict'
// Тушение вне боя (2026-09-26, autopilot.extinguish): бот загорелся (полсекунды
// в лаве), стоит на полу; в сцене «ведро» у него ведро воды, в сцене «вода»
// ведра нет, а в DIST блоках — вода. Сколько хп сняло за 10 с и был ли в воде.
//   A=ws://127.0.0.1:8791 MC_PORT=25565 node try-extinguish.js
const WebSocket = require('ws')
function client (url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const A = client(process.env.A || 'ws://127.0.0.1:8791')
async function cmd (text) { await A.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 150; const Z = 1400
const DIST = Number(process.env.DIST || 6)

let ob = null
async function observer () {
  const mineflayer = require('mineflayer')
  const o = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25565), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { o.once('spawn', resolve); o.once('error', reject); o.once('kicked', reject) })
  await sleep(3000)
  o.chat('/gamemode spectator'); await sleep(300)
  o.chat(`/tp Probe1 ${X + 0.5} ${Y + 8} ${Z + 0.5} 0 90`); await sleep(800)
  return o
}
const burning = () => { const e = ob && ob.players.NeuroDown && ob.players.NeuroDown.entity; try { return !!(e && (e.metadata[0] & 0x01)) } catch { return false } }

async function scene (name, give, water = true) {
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 5} ${Z + 12} minecraft:air`)
  await cmd('/clear NeuroDown'); await cmd('/effect clear NeuroDown')
  for (const it of give) await cmd(`/give NeuroDown minecraft:${it}`)
  await cmd('/give NeuroDown minecraft:cobblestone 8')
  // Вода — яма глубиной 1 в DIST блоках.
  if (water) await cmd(`/setblock ${X + DIST} ${Y - 1} ${Z} minecraft:water`)
  await cmd(`/setblock ${X} ${Y - 1} ${Z + 4} minecraft:lava`)
  await cmd('/effect give NeuroDown minecraft:instant_health 1 10 true')
  await sleep(600)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y - 1} ${Z + 4.5}`)
  await sleep(500)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd(`/setblock ${X} ${Y - 1} ${Z + 4} minecraft:stone`)
  const t0 = Date.now()
  let lit = 0; let out = 0
  while (Date.now() - t0 < 12000) {
    const b = burning()
    if (b && !lit) lit = Date.now() - t0
    if (lit && !b && !out) out = Date.now() - t0
    if (out) break
    await sleep(100)
  }
  console.log(`[${name}] загорелся: ${lit ? 'да' : 'нет'}; потух через ${out && lit ? ((out - lit) / 1000).toFixed(1) + ' с' : 'не потух за 12 с'}`)
}

;(async () => {
  try {
    await A.ready
    await A.call('connect').catch(() => {})
    await A.call('stop').catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd('/weather clear')
    await cmd(`/forceload add ${X - 14} ${Z - 14} ${X + 14} ${Z + 14}`)
    await cmd('/op Probe1')
    ob = await observer()
    await scene('ведро', ['water_bucket'])
    await scene('вода рядом', [])
    await scene('ни ведра, ни воды', [], false)
    await cmd(`/forceload remove ${X - 14} ${Z - 14} ${X + 14} ${Z + 14}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (ob) try { ob.quit() } catch {}
    A.ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
