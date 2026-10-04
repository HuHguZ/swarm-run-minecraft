'use strict'
// Паутина под ногами посреди подъёма столбом (живая арена 2026-09-26, раунд 8:
// NeuroDown2 лез столбом к противнику на столбе, ему кинули паутину и лаву —
// он ковырял паутину булыжником в руке и сгорел: «не поднялся: … мешает cobweb»).
// NeuroDown стоит на столбе в 10 блоков, NeuroDown2 внизу с мечом и булыжником
// начинает бой; когда он поднялся на 2 блока, в клетку его ног и головы
// ставится паутина (сцена «паутина»), а в сцене «лава» ещё и лава рядом.
// Итог: чем он держал паутину, сколько её снимал, поднялся ли, сколько хп.
//   A=ws://127.0.0.1:8781 B=ws://127.0.0.1:8782 node try-webclimb.js [паутина,лава]
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
const A = client(process.env.A || 'ws://127.0.0.1:8781')
const B = client(process.env.B || 'ws://127.0.0.1:8782')
async function cmd (text) { await A.call('say', { text }); await sleep(60) }

// Наблюдатель (OBS=1): зритель Probe1 смотрит на клетки паутины каждые 50 мс —
// точное время, когда паутина снята (сервер 25566, Probe1 — оператор).
let OBS = null
async function observer () {
  const mineflayer = require('mineflayer')
  const ob = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25566), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { ob.once('spawn', resolve); ob.once('error', reject); ob.once('kicked', reject) })
  await sleep(4000)
  ob.chat('/gamemode spectator'); await sleep(300)
  ob.chat(`/tp Probe1 ${X + 0.5} ${Y + 5} ${Z - 5}`); await sleep(800)
  return ob
}

const X = 600; const Y = 150; const Z = 600
const H = 10

// Паутина в клетке, где стоит NeuroDown2, а NeuroDown рядом бьёт (сцены
// «в упор», «в упор+голова», «в упор без воды»): сколько он просидел в паутине,
// чем снимал (вода или меч), сколько хп потерял.
async function stageMelee (name, { head = false, water = true, seconds = 12 }) {
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + H + 4} ${Z + 8} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    await cmd(`/item replace entity ${who} armor.chest with minecraft:diamond_chestplate`)
  }
  await cmd('/give NeuroDown minecraft:diamond_sword')
  const items = ['diamond_sword', 'cobblestone 64']
  if (water) items.push('water_bucket')
  for (const it of items) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown2 minecraft:${n} ${c || 1}`) }
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 2.5} 180 0`)
  for (const w of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  await cmd(`/setblock ${X} ${Y} ${Z} minecraft:cobweb`)
  if (head) await cmd(`/setblock ${X} ${Y + 1} ${Z} minecraft:cobweb`)
  await sleep(300)
  const hp0 = ((await B.call('status')).state || {}).health
  const t0 = Date.now()
  const fa = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  let done = null
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message })).then(r => { done = r; return r })
  let outAt = null
  const held = {}
  let gone = null
  let hpNow = hp0
  let hpAtGone = null
  const { Vec3 } = require('vec3')
  const cells = head ? [new Vec3(X, Y, Z), new Vec3(X, Y + 1, Z)] : [new Vec3(X, Y, Z)]
  const obsIv = OBS ? setInterval(() => {
    if (gone != null) return
    if (!cells.some(c => (OBS.blockAt(c) || {}).name === 'cobweb')) { gone = Date.now() - t0; hpAtGone = hpNow }
  }, 50) : null
  while (!done && Date.now() - t0 < (seconds + 2) * 1000) {
    const st = await B.call('status').catch(() => null)
    const s = st && st.state
    if (s && s.health != null) hpNow = s.health
    if (s && s.pos && !outAt) {
      held[s.held || 'рука'] = (held[s.held || 'рука'] || 0) + 1
      // Вышел из паутины: клетки тела не те, где паутина стояла, или
      // поднялся/сместился — проверяем по приёмам в конце, здесь — по сдвигу.
      if (Math.hypot(s.pos.x - (X + 0.5), s.pos.z - (Z + 0.5)) > 0.9) outAt = Date.now() - t0
    }
    await sleep(100)
  }
  const [ra, rb] = await Promise.all([fa, fb])
  if (obsIv) clearInterval(obsIv)
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  if (OBS) console.log(`   паутина снята через ${gone != null ? (gone / 1000).toFixed(2) + ' с' : '— (не снята)'}; хп к этому моменту ${hpAtGone ?? '?'} из ${hp0}`)
  const d = (rb && rb.detail) || {}
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /паут|вод|булав|удар/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  const hp1 = ((await B.call('status').catch(() => ({}))).state || {}).health
  console.log(`[${name}] ${rb ? rb.status : '-'} | хп ${hp0}→${hp1} | ушёл с клетки паутины через ${outAt != null ? (outAt / 1000).toFixed(1) + ' с' : '—'} | в руке: ${JSON.stringify(held)} | A: ${ra ? ra.status : '-'}`)
  console.log(`   приёмы: ${tricks || '-'}`)
}

async function stage (name, { lava = false, water = false, seconds = 25 }) {
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + H + 4} ${Z + 8} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    await cmd(`/item replace entity ${who} armor.chest with minecraft:diamond_chestplate`)
  }
  // Столб NeuroDown: обсидиан, наверху площадка 1×1.
  await cmd(`/fill ${X} ${Y} ${Z} ${X} ${Y + H - 1} ${Z} minecraft:obsidian`)
  // Рюкзак NeuroDown2 как в «арсенале»: блоки в начале, меч дальше.
  const items = ['cobblestone 64', 'diamond_sword', 'diamond_pickaxe']
  if (water) items.push('water_bucket')
  for (const it of items) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown2 minecraft:${n} ${c || 1}`) }
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y + H} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 3.5} ${Y} ${Z + 0.5} 90 0`)
  for (const w of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 1 20 true`) }
  await sleep(1800)
  const hp0 = ((await B.call('status')).state || {}).health
  const t0 = Date.now()
  let fight = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  let done = null
  fight = fight.then(r => { done = r; return r })
  const trace = []
  let web = null
  let heldInWeb = {}
  let lastY = null
  while (!done && Date.now() - t0 < (seconds + 3) * 1000) {
    const st = await B.call('status').catch(() => null)
    const s = st && st.state
    if (s && s.pos) {
      lastY = s.pos.y
      const t = ((Date.now() - t0) / 1000).toFixed(1)
      if (!web && s.pos.y >= Y + 2) {
        const f = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) }
        web = { ...f, at: Date.now() }
        await cmd(`/setblock ${f.x} ${f.y} ${f.z} minecraft:cobweb`)
        await cmd(`/setblock ${f.x} ${f.y + 1} ${f.z} minecraft:cobweb`)
        if (lava) await cmd(`/setblock ${f.x + 1} ${f.y} ${f.z} minecraft:lava`)
        trace.push(`${t}с паутина в ${f.x},${f.y},${f.z}${lava ? ' + лава рядом' : ''}`)
      } else if (web && Date.now() - web.at < 12000) {
        heldInWeb[s.held || 'рука'] = (heldInWeb[s.held || 'рука'] || 0) + 1
        if (trace.length < 60) trace.push(`${t}с y=${s.pos.y.toFixed(2)} в руке ${s.held || '-'} хп ${Math.round(s.health)}`)
      }
    }
    await sleep(150)
  }
  const r = await fight
  await B.call('stop').catch(() => {})
  const d = (r && r.detail) || {}
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /паут|столб|поднял|лав|вод|огн|мешает/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  const hp1 = ((await B.call('status').catch(() => ({}))).state || {}).health
  if (r && r.error) console.log('   ошибка: ' + r.error)
  console.log(`[${name}] ${r ? r.status : '-'} | хп ${hp0}→${hp1} | y ${lastY != null ? lastY.toFixed(1) : '?'} (цель ${Y + H}) | в руке после паутины: ${JSON.stringify(heldInWeb)}`)
  console.log(`   приёмы: ${tricks || '-'}`)
  if (process.env.TRACE) for (const l of trace) console.log('   ' + l)
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
    if (process.env.OBS) OBS = await observer()
    const only = (process.argv[2] || 'паутина').split(',')
    const reps = Number(process.env.REPS || 1)
    for (let i = 1; i <= reps; i++) {
      if (only.includes('паутина')) await stage(`паутина #${i}`, {})
      if (only.includes('лава')) await stage(`лава #${i}`, { lava: true })
      if (only.includes('лава+вода')) await stage(`лава+вода #${i}`, { lava: true, water: true })
      if (only.includes('в упор')) await stageMelee(`в упор #${i}`, {})
      if (only.includes('в упор+голова')) await stageMelee(`в упор+голова #${i}`, { head: true })
      if (only.includes('в упор без воды')) await stageMelee(`в упор без воды #${i}`, { water: false })
    }
    await cmd(`/forceload remove ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (OBS) try { OBS.quit() } catch {}
    A.ws.close(); B.ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
