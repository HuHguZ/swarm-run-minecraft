'use strict'
const gameClock = require('./src/game-clock')
// Подбор стрел в бою (arrows.js). У NeuroDown лук без стрел, вокруг воткнуты
// стрелы, NeuroDown2 стоит далеко без оружия. Надо: сбегать за стрелами, не
// лезть через дыру в полу за той, что за ней, и начать стрелять. Вторая часть —
// противник в 4 блоках: за стрелами не бежать.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 node try-arrows.js
const WebSocket = require('ws')

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
async function cmd (text) { await A.call('say', { text }); await sleep(40) }

const X = 500; const Y = 150; const Z = 500
const arrowsAt = (pts) => pts.map(([dx, dz]) => cmd(`/summon minecraft:arrow ${X + dx + 0.5} ${Y + 0.05} ${Z + dz + 0.5} {pickup:1b,inGround:1b}`))

async function stage (name, { foeDz, pts, hole }) {
  await cmd(`/fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 25} minecraft:stone`)
  await cmd(`/fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 6} ${Z + 25} minecraft:air`)
  await cmd(`/kill @e[type=arrow,x=${X},y=${Y},z=${Z},distance=..40]`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  if (hole) await cmd(`/fill ${X + hole[0]} ${Y - 1} ${Z + hole[1]} ${X + hole[2]} ${Y - 1} ${Z + hole[3]} minecraft:air`)
  for (const [who] of [['NeuroDown'], ['NeuroDown2']]) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of ['bow', 'diamond_sword', 'diamond_chestplate']) await cmd(`/give NeuroDown minecraft:${it}`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + foeDz + 0.5} 180 0`)
  await cmd('/effect give NeuroDown minecraft:instant_health 1 10 true')
  await cmd('/effect give NeuroDown2 minecraft:resistance 60 4 true')
  await sleep(1200)
  await Promise.all(arrowsAt(pts))
  await sleep(800)
  const r = await A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: 12, retreatAtHealth: 2 }).catch(e => ({ status: 'failed', error: e.message }))
  const st = await A.call('status')
  const d = r.detail || {}
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /стрел|выстрел/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  // Что осталось лежать: за дырой (−4,−4) стрела должна остаться.
  const ob = await A.call('observe', { radius: 24 }).catch(() => null)
  const lying = ((ob && ob.detail && ob.detail.entities) || []).filter(e => /arrow/i.test(e.name || '')).map(e => e.pos ? `${Math.floor(e.pos.x) - X},${Math.floor(e.pos.z) - Z}` : '?')
  console.log(`[${name}] ${r.status} | стрел в рюкзаке ${((st.state && st.state.inventory) || {}).arrow || 0} | выстрелов ${d.arrows || 0} | ${tricks || 'стрелы не трогал'} | лежат: ${lying.join(' ') || 'нет'} | y=${st.state && st.state.pos && st.state.pos.y}`)
  await A.call('stop').catch(() => {})
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/gamerule spawn_mobs false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    // 1. Враг в 18 блоках, стрелы рядом; одна — за дырой (дыра x −3..−2, z −3..−2,
    // стрела на −4,−4: по прямой путь через дыру).
    await stage('далеко', { foeDz: 18, pts: [[4, 0], [-5, 2], [3, -6], [-4, -4]], hole: [-3, -3, -2, -2] })
    // 2. Враг в 4 блоках — не бегать.
    await stage('рядом', { foeDz: 4, pts: [[-6, -3], [6, -2]] })
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
