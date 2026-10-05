'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Поле с брошенной паутиной (арена 2026-09-26: «боты часто в паутине
// застревают, как будто её не видят»). Площадка 17×17, на ней N паутин в
// случайных клетках (у ног), два бота с мечами и щитами без паутины и воды
// дерутся SECONDS секунд. Зритель Probe1 каждые 100 мс смотрит, стоит ли
// кто-то в паутине (клетка ног или головы) — время в паутине и сколько раз
// зашёл в неё. Паутину тут никто не ставит — всё это «не увидел».
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-webfield.js
const WebSocket = require('ws')
const { Vec3 } = require('vec3')

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
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
async function cmd (text) { await A.call('say', { text }); await sleep(50) }

const X = 1000; const Y = 150; const Z = 1000; const R = 8
const N = Number(process.env.WEBS || 14)
const SECONDS = Number(process.env.SECONDS || 25)

// Детерминированный случай: одни и те же клетки для «до» и «после».
let seed = Number(process.env.SEED || 7)
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

async function observer () {
  const ob = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25565), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { ob.once('spawn', resolve); ob.once('error', reject); ob.once('kicked', reject) })
  await sleep(4000)
  ob.chat('/gamemode spectator'); await sleep(300)
  ob.chat(`/tp Probe1 ${X + 0.5} ${Y + 12} ${Z + 0.5} 0 90`); await sleep(800)
  return ob
}

async function round (ob, k) {
  await cmd(`/fill ${X - R - 1} ${Y - 1} ${Z - R - 1} ${X + R + 1} ${Y - 1} ${Z + R + 1} minecraft:smooth_stone`)
  await cmd(`/fill ${X - R - 1} ${Y} ${Z - R - 1} ${X + R + 1} ${Y + 4} ${Z + R + 1} minecraft:glass hollow`)
  await cmd(`/fill ${X - R} ${Y} ${Z - R} ${X + R} ${Y + 3} ${Z + R} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..20]`)
  const webs = []
  while (webs.length < N) {
    const x = X - R + 1 + Math.floor(rnd() * (2 * R - 1)); const z = Z - R + 1 + Math.floor(rnd() * (2 * R - 1))
    if (Math.abs(z - Z) < 2 && (Math.abs(x - (X - 4)) < 2 || Math.abs(x - (X + 4)) < 2)) continue
    if (webs.some(w => w.x === x && w.z === z)) continue
    webs.push({ x, z })
  }
  for (const w of webs) await cmd(`/setblock ${w.x} ${Y} ${w.z} minecraft:cobweb`)
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    for (const [s, it] of [['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['weapon.offhand', 'shield']]) await cmd(`/item replace entity ${who} ${s} with minecraft:${it}`)
    await cmd(`/give ${who} minecraft:iron_sword`)
    await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${who} minecraft:saturation 1 20 true`)
  }
  await cmd(`/tp NeuroDown ${X - 4 + 0.5} ${Y} ${Z + 0.5} -90 0`)
  await cmd(`/tp NeuroDown2 ${X + 4 + 0.5} ${Y} ${Z + 0.5} 90 0`)
  await sleep(1500)
  const stat = { NeuroDown: { ticks: 0, entries: 0, was: false }, NeuroDown2: { ticks: 0, entries: 0, was: false } }
  const iv = gameClock.setInterval(() => {
    for (const name of Object.keys(stat)) {
      const e = ob.players[name] && ob.players[name].entity
      if (!e) continue
      const f = e.position.floored()
      const inWeb = [f, f.offset(0, 1, 0)].some(c => (ob.blockAt(c) || {}).name === 'cobweb')
      if (inWeb) { stat[name].ticks++; if (!stat[name].was) stat[name].entries++ }
      stat[name].was = inWeb
    }
  }, 100)
  const fa = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const [ra, rb] = await Promise.all([fa, fb])
  gameClock.clearInterval(iv)
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  const left = webs.filter(w => (ob.blockAt(new Vec3(w.x, Y, w.z)) || {}).name === 'cobweb').length
  const notes = (r) => Object.entries(((r && r.detail) || {}).tricks || {}).filter(([k]) => /паутин/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  console.log(`[поле #${k}] в паутине: NeuroDown ${(stat.NeuroDown.ticks / 10).toFixed(1)} с (заходов ${stat.NeuroDown.entries}), NeuroDown2 ${(stat.NeuroDown2.ticks / 10).toFixed(1)} с (заходов ${stat.NeuroDown2.entries}) | паутины осталось ${left}/${N} | ${ra.status}/${rb.status}`)
  const na = notes(ra); const nb = notes(rb)
  if (na || nb) console.log(`   A: ${na || '-'} | B: ${nb || '-'}`)
  return stat
}

;(async () => {
  let ob = null
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 12} ${Z - 12} ${X + 12} ${Z + 12}`)
    await cmd('/op Probe1')
    ob = await observer()
    const reps = Number(process.env.REPS || 3)
    let tot = 0; let ent = 0
    for (let k = 1; k <= reps; k++) {
      const s = await round(ob, k)
      tot += s.NeuroDown.ticks + s.NeuroDown2.ticks; ent += s.NeuroDown.entries + s.NeuroDown2.entries
    }
    console.log(`ИТОГО: в паутине ${(tot / 10).toFixed(1)} с на двоих за ${reps} боёв по ${SECONDS} с, заходов ${ent}`)
    await cmd(`/forceload remove ${X - 12} ${Z - 12} ${X + 12} ${Z + 12}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (ob) try { ob.quit() } catch {}
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
