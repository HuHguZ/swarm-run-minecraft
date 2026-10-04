'use strict'
// Удар сквозь стенку (арена 2026-09-26, пользователь: «боты через один блок
// пробивают… он построил крепость, а второй летит с булавой и через блоки его
// выносит»). NeuroDown закрыт в коробке (пустота 1×2, стены, пол и крыша),
// NeuroDown2 снаружи дерётся SECONDS секунд. Зритель Probe1 каждые 100 мс
// смотрит целость коробки, статус A — его хп. Удар, пришедший, пока коробка
// целая, — удар сквозь блок: его быть не должно.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 MC_PORT=25565 node try-throughwall.js [сцена]
// Сцены: меч (булыжник, меч+кирка), обсидиан (то же, коробка из обсидиана),
// булава (булыжник, булава+заряды ветра+кирка), всё — по очереди.
const WebSocket = require('ws')
const { Vec3 } = require('vec3')

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
const B = client(process.env.B || 'ws://127.0.0.1:8792')
async function cmd (text) { await A.call('say', { text }); await sleep(40) }

const X = 1000; const Y = 150; const Z = 1040
const SECONDS = Number(process.env.SECONDS || 25)
const SCENES = {
  меч: { box: 'cobblestone', kit: ['diamond_sword', 'diamond_pickaxe', 'cobblestone 32'], dist: 3 },
  обсидиан: { box: 'obsidian', kit: ['diamond_sword', 'diamond_pickaxe', 'cobblestone 32'], dist: 3 },
  булава: { box: 'cobblestone', kit: ['mace', 'wind_charge 16', 'diamond_sword', 'diamond_pickaxe', 'cobblestone 32'], dist: 3 }
}

async function observer () {
  const mineflayer = require('mineflayer')
  const ob = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25565), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { ob.once('spawn', resolve); ob.once('error', reject); ob.once('kicked', reject) })
  await sleep(4000)
  ob.chat('/gamemode spectator'); await sleep(300)
  ob.chat(`/tp Probe1 ${X + 0.5} ${Y + 10} ${Z + 0.5} 0 90`); await sleep(800)
  return ob
}

// Стены и крыша коробки вокруг клетки (X, Y, Z) — те, что закрывают его.
function boxCells () {
  const out = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { out.push(new Vec3(X + dx, Y, Z + dz)); out.push(new Vec3(X + dx, Y + 1, Z + dz)) }
  out.push(new Vec3(X, Y + 2, Z))
  return out
}

async function scene (ob, name) {
  const sc = SCENES[name]
  await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:stone`)
  await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 14} ${Z + 20} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of sc.kit) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown2 minecraft:${n} ${c || 1}`) }
  await cmd('/item replace entity NeuroDown armor.chest with minecraft:iron_chestplate')
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await sleep(600)
  await cmd(`/fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 1} ${Y + 2} ${Z + 1} minecraft:${sc.box} hollow`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + sc.dist + 0.5} 180 0`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  const cells = boxCells()
  const t0 = Date.now()
  let firstBreak = 0
  let hp = ((await A.call('status')).state || {}).health ?? 20
  const hits = []
  let polling = true
  const poll = (async () => {
    while (polling) {
      const intact = cells.every(c => { const b = ob.blockAt(c); return b && b.name === sc.box })
      if (!intact && !firstBreak) firstBreak = Date.now()
      try {
        const h = ((await A.call('status')).state || {}).health
        if (h != null && h < hp - 0.4) hits.push({ t: Date.now() - t0, dmg: +(hp - h).toFixed(1), intact })
        if (h != null) hp = h
      } catch {}
      await sleep(100)
    }
  })()
  const r = await B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  polling = false
  await poll
  await B.call('stop').catch(() => {})
  const d = r.detail || {}
  const through = hits.filter(h => h.intact)
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /коробк|стенк|киркой|дыр|булав|прицел|паутин|караул|латает/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  console.log(`[${name}] ${r.status}${d.killed ? ' УБИЛ' : ''} | коробка цела до ${firstBreak ? ((firstBreak - t0) / 1000).toFixed(1) + ' с' : 'конца'} | попаданий ${hits.length}, сквозь целую коробку ${through.length}${through.length ? ' (' + through.map(h => `${(h.t / 1000).toFixed(1)}с −${h.dmg}`).join(', ') + ')' : ''} | взмахов ${d.swings ?? '?'} | ${tricks || '-'}`)
  return { through: through.length, hits: hits.length }
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
    await cmd(`/forceload add ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`)
    await cmd('/op Probe1')
    ob = await observer()
    const which = process.argv[2] && process.argv[2] !== 'всё' ? [process.argv[2]] : Object.keys(SCENES)
    const reps = Number(process.env.REPS || 1)
    let through = 0
    for (let k = 0; k < reps; k++) for (const s of which) through += (await scene(ob, s)).through
    console.log(`ИТОГО: ударов сквозь целую коробку ${through}`)
    await cmd(`/forceload remove ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (ob) try { ob.quit() } catch {}
    A.ws.close(); B.ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
