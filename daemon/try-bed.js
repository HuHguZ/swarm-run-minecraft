'use strict'
// Ночь с кроватью (src/bedtime.js): (а) сумерки — поставить кровать, лечь с
// первым тиком ночи, утром забрать; (б) рядом мобы — сервер не даст лечь
// (Monster в коробке ±8/±5 от изголовья), значит бункер на 6 вниз, сон там,
// утром кровать с собой и наверх; (в) кровати нет — честный отказ с рецептом.
// Площадка x=2100 на камне без пещер, зомби — /summon без ИИ (стоят, где
// поставлены, и не бьют — проверяем правило, а не драку).
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cmd (text) { await call('say', { text }); await sleep(350) }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
const brief = (r) => JSON.stringify(r.detail || r.error || r.status).slice(0, 400) + (r.by ? ' by ' + JSON.stringify(r.by).slice(0, 200) : '')
const beds = (st) => Object.entries((st && st.inventory) || {}).filter(([n]) => /_bed$/.test(n)).reduce((n, [, c]) => n + c, 0)

const X = 2100
const Y = 100
const Z = 1600

async function stage () {
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  // Сплошной камень под площадкой — бункеру есть что копать, пещер нет.
  await cmd(`/fill ${X - 12} ${Y - 12} ${Z - 12} ${X + 12} ${Y - 2} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:grass_block`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 8} ${Z + 12} minecraft:air`)
  await cmd('/kill @e[type=!minecraft:player,distance=..60]')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/clear @s')
  await cmd('/give @s minecraft:iron_pickaxe 1')
  await cmd('/give @s minecraft:iron_axe 1')
  await cmd('/give @s minecraft:cobblestone 16')
  await sleep(800)
}

async function main () {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await cmd('/difficulty normal')
  await cmd('/gamerule advance_time true')
  await cmd('/weather clear 6000')
  // На общем сервере не спят другие боты — хватит половины.
  await cmd('/gamerule players_sleeping_percentage 50')

  const ONLY = process.env.ONLY || ''
  // (а) Сумерки: кровать с собой, мобов нет.
  if (!ONLY || ONLY.includes('а')) {
    await stage()
    await cmd('/give @s minecraft:white_bed 1')
    await cmd('/time set 12150')
    await sleep(800)
    const t0 = Date.now()
    const r = await call('sleep', { untilMorning: true })
    const d = r.detail || {}
    check('(а) лёг в сумерки с первым тиком ночи', d.sleeping === true, brief(r))
    check('(а) ночь проскочила', d.morning === true, `за ${Math.round((Date.now() - t0) / 1000)} с`)
    check('(а) кровать забрал утром', d.tookBed === true && beds(r.state) === 1, `в рюкзаке кроватей ${beds(r.state)}`)
  }

  // (б) Ночь, два зомби в 6 блоках — наверху не уснуть, под землёй можно.
  if (!ONLY || ONLY.includes('б')) {
    await stage()
    await cmd('/give @s minecraft:white_bed 1')
    await cmd('/time set 13500')
    await cmd(`/summon minecraft:zombie ${X + 6} ${Y} ${Z + 1} {NoAI:1b,PersistenceRequired:1b}`)
    await cmd(`/summon minecraft:zombie ${X - 5} ${Y} ${Z - 4} {NoAI:1b,PersistenceRequired:1b}`)
    await sleep(1000)
    const t0 = Date.now()
    const r = await call('sleep', { untilMorning: true })
    const d = r.detail || {}
    check('(б) ушёл в бункер от мобов', !!(d.bunker && d.bunker.depth >= 5), brief(r))
    check('(б) уснул под землёй', d.sleeping === true)
    check('(б) ночь проскочила', d.morning === true, `за ${Math.round((Date.now() - t0) / 1000)} с`)
    check('(б) кровать с собой', d.tookBed === true && beds(r.state) === 1, `кроватей ${beds(r.state)}`)
    const y = r.state && r.state.pos ? r.state.pos.y : null
    check('(б) вылез наверх', d.climbed === true && y >= Y - 1, `y=${y}`)
    await cmd('/kill @e[type=minecraft:zombie,distance=..40]')
  }

  // (в) Кровати нет — отказ с понятной причиной.
  if (!ONLY || ONLY.includes('в')) {
    await stage()
    await cmd('/time set 14000')
    await sleep(600)
    const r = await call('sleep', { untilMorning: true })
    check('(в) без кровати — отказ с рецептом', r.status === 'failed' && /кровати нет/.test(r.error || ''), brief(r))
    await cmd('/time set 1000')
  }

  // (г) Точка возрождения днём: кровать ставится, клик — «Respawn point set»,
  // смерть в стороне — возрождение у кровати.
  const posOf = async () => { const r = await call('observe', {}); return r.state && r.state.pos }
  const near = (a, b, r) => a && b && Math.abs(a.x - b.x) <= r && Math.abs(a.z - b.z) <= r
  let bedAt = null
  if (!ONLY || ONLY.includes('г')) {
    await stage()
    await cmd('/time set 3000')
    await cmd('/give @s minecraft:red_bed 1')
    await sleep(600)
    const r = await call('sleep', { mode: 'spawn', why: 'проверка' })
    const d = r.detail || {}
    bedAt = d.at
    check('(г) точка возрождения поставлена днём', d.set === true, brief(r))
    await cmd(`/tp @s ${X + 60} ${Y + 1} ${Z}`)
    await sleep(1500)
    await cmd('/kill @s')
    await sleep(4000)
    const p = await posOf()
    check('(г) возродился у кровати', near(p, bedAt, 3), `pos ${JSON.stringify(p)}, кровать ${JSON.stringify(bedAt)}`)
  }
  // (д) Забрал кровать — точки нет, возрождение на спавне мира.
  if (bedAt && (!ONLY || ONLY.includes('д'))) {
    await sleep(1000)
    const r = await call('sleep', { mode: 'take' })
    check('(д) кровать-точку забрал', (r.detail || {}).took === true, brief(r))
    await sleep(500)
    await cmd('/kill @s')
    await sleep(4000)
    const p = await posOf()
    check('(д) без кровати — возрождение не у неё', p && !near(p, bedAt, 16), `pos ${JSON.stringify(p)}`)
  }

  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
