'use strict'
const gameClock = require('./src/game-clock')
// Булава и заряды ветра (mace.js) на двух демонах тестового сервера.
// Сцены (по одной строке итога на каждую):
//   удар      — NeuroDown с булавой и зарядами против стоящего NeuroDown2 в алмазе;
//   щит       — NeuroDown2 бьёт булавой с взлёта, NeuroDown со щитом защищается;
//   уклон     — то же, но у NeuroDown щита нет: шаг из-под булавы;
//   сброс     — NeuroDown2 стоит у дыры в полу, NeuroDown толкает зарядом ветра;
//   столб     — NeuroDown2 на столбе в 5 блоков, NeuroDown сбивает зарядом.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 node try-mace.js [сцены через запятую]
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
async function cmd (text) { await A.call('say', { text }); await sleep(60) }

const X = 400; const Y = 150; const Z = 400
const DIAMOND = [['head', 'diamond_helmet'], ['chest', 'diamond_chestplate'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots']]
const MACE = ['diamond_sword', 'mace', 'wind_charge 16']

async function kit (who, items, body) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  for (const [slot, it] of body) await cmd(`/item replace entity ${who} ${slot.startsWith('weapon') ? slot : 'armor.' + slot} with minecraft:${it}`)
  for (const it of items) { const [n, c] = it.split(' '); await cmd(`/give ${who} minecraft:${n} ${c || 1}`) }
}

async function hpOf (c) { const st = await c.call('status').catch(() => null); return st && st.state ? Math.round(st.state.health * 10) / 10 : null }

function line (r) {
  const d = (r && r.detail) || {}
  const m = d.mace ? JSON.stringify(d.mace) : '-'
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /булав|заряд|щит|полёте|паутин|тотем|вода/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  return `${r ? r.status : 'нет'} | хп ${d.hp || '?'} | mace ${m} | ${tricks || 'приёмов нет'}`
}

async function stage (name, { aItems, aBody = DIAMOND, bItems = [], bBody = DIAMOND, bz = 3.5, hole = null, pillar = 0, aFights = true, bFights = false, seconds = 12 }) {
  await cmd(`/fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 10} ${Y - 1} ${Z + 10} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 10} ${X + 10} ${Y + 15} ${Z + 10} minecraft:air`)
  if (hole) await cmd(`/fill ${X + hole[0]} ${Y - 1} ${Z + hole[1]} ${X + hole[2]} ${Y - 1} ${Z + hole[3]} minecraft:air`)
  await kit('NeuroDown', aItems, aBody)
  await kit('NeuroDown2', bItems, bBody)
  if (pillar) await cmd(`/fill ${X} ${Y} ${Z + bz} ${X} ${Y + pillar - 1} ${Z + bz} minecraft:cobblestone`)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y + pillar} ${Z + bz + 0.5} 180 0`)
  for (const w of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 1 20 true`) }
  await sleep(1800)
  const hpA0 = await hpOf(A); const hpB0 = await hpOf(B)
  const fa = aFights ? A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message })) : Promise.resolve(null)
  const fb = bFights ? B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message })) : Promise.resolve(null)
  const [ra, rb] = await Promise.all([fa, fb])
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  await sleep(600)
  const stA = await A.call('status').catch(() => null); const stB = await B.call('status').catch(() => null)
  const posB = stB && stB.state && stB.state.pos
  console.log(`[${name}] NeuroDown ${hpA0}→${await hpOf(A)} хп | NeuroDown2 ${hpB0}→${await hpOf(B)} хп${posB ? ` | NeuroDown2 y=${Math.round(posB.y * 10) / 10}` : ''}`)
  if (ra) console.log(`   A: ${line(ra)}`)
  if (rb) console.log(`   B: ${line(rb)}`)
  void stA
}

;(async () => {
  await A.ready; await B.ready
  await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
  await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
  await cmd('/gamerule send_command_feedback false')
  await cmd('/difficulty normal')
  await cmd(`/forceload add ${X - 12} ${Z - 12} ${X + 12} ${Z + 12}`)
  await sleep(1500)
  const only = (process.argv[2] || 'удар,щит,уклон,сброс,столб').split(',')
  const reps = Number(process.env.REPS || 1)
  for (let i = 1; i <= reps; i++) {
    if (only.includes('удар')) await stage(`удар #${i}`, { aItems: MACE, bz: 3.5, seconds: 10 })
    if (only.includes('щит')) await stage(`щит #${i}`, { aItems: ['diamond_sword'], aBody: [...DIAMOND, ['weapon.offhand', 'shield']], bItems: MACE, bz: 3.5, aFights: true, bFights: true, seconds: 12 })
    if (only.includes('уклон')) await stage(`уклон #${i}`, { aItems: ['diamond_sword'], bItems: MACE, bz: 3.5, aFights: true, bFights: true, seconds: 12 })
    // Тотем в рюкзаке, щита нет: на взлёт с булавой — тотем в руку заранее
    // (pvp.js maceTotem, 2026-09-26). Итог: выжил ли A и сработал ли тотем.
    if (only.includes('тотем')) await stage(`тотем #${i}`, { aItems: ['diamond_sword', 'totem_of_undying'], bItems: MACE, bz: 3.5, aFights: true, bFights: true, seconds: 12 })
    // Жемчуг из-под булавы (pvp.js maceThreat, 2026-09-26): щита нет, до удара
    // 12+ тиков — жемчуг в сторону, иначе бег спринтом.
    if (only.includes('жемчуг')) await stage(`жемчуг #${i}`, { aItems: ['diamond_sword', 'ender_pearl 4', 'totem_of_undying'], bItems: MACE, bz: 3.5, aFights: true, bFights: true, seconds: 12 })
    // Сначала обездвижить: у атакующего паутина и медлительность — взлёт после.
    if (only.includes('обездвижить')) await stage(`обездвижить #${i}`, { aItems: ['diamond_sword'], bItems: [...MACE, 'cobweb 4', 'splash_potion[potion_contents={potion:"minecraft:slowness"}] 2'], bz: 3.5, aFights: true, bFights: true, seconds: 14 })
    // Паутина и булава (живая арена 2026-09-26: бот резал паутину мечом, пока в
    // него летели с булавой, и умер): у NeuroDown меч, щит, тотем и вода, у
    // NeuroDown2 булава, заряды ветра и паутина — сначала паутина, потом взлёт.
    if (only.includes('паутина-булава')) await stage(`паутина-булава #${i}`, { aItems: ['diamond_sword', 'totem_of_undying', 'water_bucket'], aBody: [...DIAMOND, ['weapon.offhand', 'shield']], bItems: [...MACE, 'cobweb 4'], bz: 3.5, aFights: true, bFights: true, seconds: 14 })
    // Дыра 3×3 за его спиной (он на z+4.5, дыра z+6..8): в небе, насмерть.
    if (only.includes('сброс')) await stage(`сброс #${i}`, { aItems: ['diamond_sword', 'wind_charge 16'], bz: 4, hole: [-1, 6, 1, 8], seconds: 8 })
    if (only.includes('столб')) await stage(`столб #${i}`, { aItems: ['diamond_sword', 'wind_charge 16'], bz: 4, pillar: 5, seconds: 8 })
  }
  await cmd(`/forceload remove ${X - 12} ${Z - 12} ${X + 12} ${Z + 12}`)
  await cmd('/gamerule send_command_feedback true')
  A.ws.close(); B.ws.close()
  gameClock.wall.setTimeout(() => process.exit(0), 300)
})().catch(e => { console.error('FAILED', e); process.exit(1) })
