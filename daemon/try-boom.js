'use strict'
// «Динамит» (boom.js) на двух демонах тестового сервера, та же арена-коробка,
// что в try-elytra.js (обсидиановый пол с полосами светокамня, стекло, барьер).
// Сцены:
//   мина     — NeuroDown: лук с «Огнём», стрелы, рельсы, вагонетки с TNT, меч;
//              NeuroDown2 — меч, идёт на него;
//   мина0    — то же без рельсов и вагонеток (лук с «Огнём», меч);
//   кристалл — NeuroDown: кристаллы Края, лук, стрелы, меч; NeuroDown2 — меч;
//   защита   — взрывчатка у NeuroDown2, у NeuroDown меч и лук: разобрать, уйти.
//   A=ws://127.0.0.1:8793 B=ws://127.0.0.1:8794 node try-boom.js [сцены] [повторов]
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
const A = client(process.env.A || 'ws://127.0.0.1:8793')
const B = client(process.env.B || 'ws://127.0.0.1:8794')
async function cmd (text) { await A.call('say', { text }); await sleep(60) }

const X = Number(process.env.X || 600); const Y = Number(process.env.Y || 200); const Z = Number(process.env.Z || 600)
const R = 24; const CEIL = Number(process.env.CEIL || 16)
const DIAMOND = [['head', 'diamond_helmet'], ['chest', 'diamond_chestplate'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots']]
const SKY = ['elytra', 'firework_rocket 32']

async function kit (who, items, body) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  for (const [slot, it] of body) await cmd(`/item replace entity ${who} ${slot.startsWith('weapon') ? slot : 'armor.' + slot} with minecraft:${it}`)
  for (const it of items) { const [n, c] = it.split(' '); await cmd(`/give ${who} ${n.includes('[') ? n : 'minecraft:' + n} ${c || 1}`) }
}
async function hpOf (c) { const st = await c.call('status').catch(() => null); return st && st.state ? Math.round(st.state.health * 10) / 10 : null }

async function arena () {
  await cmd(`/forceload add ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`)
  for (let y = Y; y <= Y + CEIL - 1; y += 4) await cmd(`/fill ${X - R} ${y} ${Z - R} ${X + R} ${Math.min(Y + CEIL - 1, y + 3)} ${Z + R} minecraft:air`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:obsidian`)
  for (let d = -R + 4; d <= R - 4; d += 8) {
    await cmd(`/fill ${X + d} ${Y - 1} ${Z - R} ${X + d} ${Y - 1} ${Z + R} minecraft:glowstone`)
    await cmd(`/fill ${X - R} ${Y - 1} ${Z + d} ${X + R} ${Y - 1} ${Z + d} minecraft:glowstone`)
  }
  for (let y = Y - 1; y <= Y + CEIL - 1; y += 4) {
    const y2 = Math.min(Y + CEIL - 1, y + 3)
    await cmd(`/fill ${X - R - 1} ${y} ${Z - R - 1} ${X + R + 1} ${y2} ${Z - R - 1} minecraft:glass`)
    await cmd(`/fill ${X - R - 1} ${y} ${Z + R + 1} ${X + R + 1} ${y2} ${Z + R + 1} minecraft:glass`)
    await cmd(`/fill ${X - R - 1} ${y} ${Z - R - 1} ${X - R - 1} ${y2} ${Z + R + 1} minecraft:glass`)
    await cmd(`/fill ${X + R + 1} ${y} ${Z - R - 1} ${X + R + 1} ${y2} ${Z + R + 1} minecraft:glass`)
  }
  await cmd(`/fill ${X - R - 1} ${Y + CEIL} ${Z - R - 1} ${X + R + 1} ${Y + CEIL} ${Z + R + 1} minecraft:barrier`)
  await cmd(`/fill ${X + 3} ${Y - 1} ${Z + 9} ${X + 5} ${Y - 1} ${Z + 11} minecraft:air`)
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 5} ${X - 10} ${Y - 1} ${Z - 3} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X - R},y=${Y - 2},z=${Z - R},dx=${2 * R},dy=${CEIL + 2},dz=${2 * R}]`)
  await cmd(`/kill @e[type=arrow,x=${X - R},y=${Y - 2},z=${Z - R},dx=${2 * R},dy=${CEIL + 2},dz=${2 * R}]`)
  for (const t of ['tnt_minecart', 'end_crystal', 'tnt', 'firework_rocket']) await cmd(`/kill @e[type=${t},x=${X - R},y=${Y - 2},z=${Z - R},dx=${2 * R},dy=${CEIL + 2},dz=${2 * R}]`)
  await cmd(`/fill ${X - R} ${Y} ${Z - R} ${X + R} ${Y} ${Z + R} minecraft:air replace minecraft:rail`)
}

function line (r) {
  const d = (r && r.detail) || {}
  const el = d.boom ? JSON.stringify(d.boom) : '-'
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /взрыв|мина|кристалл|вагонет|разобрал|ухожу от|стрела|тотем/.test(k)).map(([k, v]) => `${k}×${v}`).join(', ')
  return `${r ? r.status : 'нет'}${d.killed ? ' УБИЛ ' + d.killed : ''}${d.died ? ' погиб' : ''} | хп ${d.hp || '?'} | удары ${d.swings ?? '?'}/${d.landed ?? '?'} стрел ${d.arrows || 0}/${d.arrowHits || 0} | boom ${el} | ${tricks || 'приёмов нет'}`
}

const score = {}
async function stage (name, { aItems, aBody = DIAMOND, bItems = [], bBody = DIAMOND, bx = 6, aHurt = 0, seconds = 60 }) {
  await arena()
  await kit('NeuroDown', aItems, aBody)
  await kit('NeuroDown2', bItems, bBody)
  await cmd(`/tp NeuroDown ${X - bx + 0.5} ${Y} ${Z + 0.5} -90 0`)
  await cmd(`/tp NeuroDown2 ${X + bx + 0.5} ${Y} ${Z + 0.5} 90 0`)
  for (const w of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  if (aHurt) { await cmd(`/damage NeuroDown ${aHurt}`); await sleep(300) }
  const hpA0 = await hpOf(A); const hpB0 = await hpOf(B)
  const t0 = Date.now()
  const over = { done: false }
  const go = (c, target, peer) => c.call('fight', { target, allowPlayer: true, timeoutSeconds: seconds, retreatAtHealth: 1 })
    .catch(e => ({ status: 'failed', error: e.message }))
    .then(r => { if (!over.done) { over.done = true; peer.call('stop').catch(() => {}) } return r })
  const [ra, rb] = await Promise.all([go(A, 'NeuroDown2', B), go(B, 'NeuroDown', A)])
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  await sleep(600)
  const hpA = await hpOf(A); const hpB = await hpOf(B)
  const da = (ra && ra.detail) || {}; const db = (rb && rb.detail) || {}
  const win = da.died && !db.died ? 'B' : db.died && !da.died ? 'A' : da.killed ? 'A' : db.killed ? 'B' : '='
  const key = name.replace(/ #\d+$/, '')
  const s = score[key] || (score[key] = { A: 0, B: 0, '=': 0 })
  s[win]++
  console.log(`[${name}] ${Math.round((Date.now() - t0) / 1000)} с | NeuroDown ${hpA0}→${hpA} | NeuroDown2 ${hpB0}→${hpB} | итог ${win === 'A' ? 'A' : win === 'B' ? 'B' : 'ничья'} | счёт ${s.A}:${s.B} (=${s['=']})`)
  console.log(`   A: ${line(ra)}`)
  console.log(`   B: ${line(rb)}`)
}

;(async () => {
  await A.ready; await B.ready
  await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
  await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
  await cmd('/gamerule send_command_feedback false')
  await cmd('/difficulty normal')
  await cmd('/gamerule do_immediate_respawn true')
  await sleep(800)
  const only = (process.argv[2] || 'пике').split(',')
  const reps = Number(process.argv[3] || process.env.REPS || 1)
  const MELEE_B = ['diamond_sword', 'golden_apple 2']
  for (let i = 1; i <= reps; i++) {
    const FLAME = 'bow[enchantments={flame:1}]'
    const CARTS = ['rail 16', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart']
    if (only.includes('мина')) await stage(`мина #${i}`, { aItems: ['diamond_sword', FLAME, 'arrow 32', ...CARTS], bItems: ['diamond_sword'], bx: 7, seconds: 45 })
    if (only.includes('мина0')) await stage(`мина0 #${i}`, { aItems: ['diamond_sword', FLAME, 'arrow 32'], bItems: ['diamond_sword'], bx: 7, seconds: 45 })
    if (only.includes('кристалл')) await stage(`кристалл #${i}`, { aItems: ['diamond_sword', 'bow', 'arrow 32', 'end_crystal 16'], bItems: ['diamond_sword'], bx: 7, seconds: 45 })
    if (only.includes('защита')) await stage(`защита #${i}`, { aItems: ['diamond_sword', 'bow', 'arrow 32'], bItems: ['diamond_sword', FLAME, 'arrow 32', ...CARTS, 'end_crystal 16'], bx: 7, seconds: 45 })
  }
  console.log('ИТОГ:', JSON.stringify(score))
  await cmd('/gamerule send_command_feedback true')
  A.ws.close(); B.ws.close()
  setTimeout(() => process.exit(0), 300)
})().catch(e => { console.error('FAILED', e); process.exit(1) })
