'use strict'
// Темп (tempo.js, 2026-09-25) — сцена «прижат в паутине»: живая дуэль, где
// NeuroDown2 застрял в паутине перед обсидианом, враг стоял вне досягаемости
// руки, бот «отвечал ударами» в пустоту и умер с golden_apple×4,
// enchanted_golden_apple×1 и черепашьим зельем в рюкзаке.
//
// Здесь: B (второй демон) в паутине (ноги и голова), перед ним обсидиан, A в
// 4 блоках — рукой не достать, A не дерётся. У B 8 хп (мгновенный урон II:
// 12 магией, броня его не режет), меч, яблоки, зачарованное яблоко,
// черепашье зелье, ведро воды — как в арсенале. Ждём: вышел из паутины за
// секунду-две (режет мечом 8 тиков на клетку или смывает водой), лечится,
// когда безопасно, а не стоит.
//   ARENA_A=ws://127.0.0.1:8783 ARENA_B=ws://127.0.0.1:8784 node try-tempo.js [повторов] [idle|fight]
// idle — A стоит (враг вне руки, как в жалобе); fight — A сам бьёт B.
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
const A = client(process.env.ARENA_A || 'ws://127.0.0.1:8783')
const B = client(process.env.ARENA_B || 'ws://127.0.0.1:8784')
const NA = 'NeuroDown'
const NB = 'NeuroDown2'
const X = 300; const Y = 150; const Z = 300
const cmd = async (t) => { await A.call('say', { text: t }); await sleep(120) }
const MODE = process.argv[3] || 'idle'
const pot = (kind, name) => `minecraft:${kind}[potion_contents={potion:"minecraft:${name}"}] 1`

async function scene (n) {
  await cmd(`/fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 10} ${Y - 1} ${Z + 10} minecraft:stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 10} ${X + 10} ${Y + 6} ${Z + 10} minecraft:air`)
  for (const who of [NA, NB]) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  for (const it of ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_sword']) {
    await cmd(`/give ${NA} minecraft:${it} 1`)
    await cmd(`/give ${NB} minecraft:${it} 1`)
  }
  for (const it of ['golden_apple 4', 'enchanted_golden_apple 1', 'water_bucket 1', 'cooked_beef 8']) await cmd(`/give ${NB} minecraft:${it}`)
  await cmd(`/give ${NB} ${pot('potion', 'turtle_master')}`)
  await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 0.5} -90 0`)
  await cmd(`/tp ${NA} ${X + 4.5} ${Y} ${Z + 0.5} 90 0`)
  await sleep(800)
  await Promise.all([A.call('armor').catch(() => null), B.call('armor').catch(() => null)])
  await cmd(`/effect give ${NB} minecraft:instant_health 1 10 true`)
  await cmd(`/effect give ${NA} minecraft:instant_health 1 10 true`)
  await sleep(600)
  await cmd(`/setblock ${X} ${Y} ${Z} minecraft:cobweb`)
  await cmd(`/setblock ${X} ${Y + 1} ${Z} minecraft:cobweb`)
  await cmd(`/setblock ${X + 1} ${Y} ${Z} minecraft:obsidian`)
  // 6 хп: out_of_world броню не спрашивает; естественная регенерация выключена
  // на сцену, чтобы хп не вернулось само.
  await cmd(`/damage ${NB} 14 minecraft:out_of_world`)
  await sleep(700)
  const st0 = await B.call('status')
  const hp0 = st0 && st0.state ? st0.state.health : '?'
  const t0 = Date.now()
  let outAt = null
  let minHp = hp0
  const fight = B.call('fight', { target: NA, allowPlayer: true, timeoutSeconds: 20, retreatAtHealth: 3 })
  // Вариант fight: A сам идёт бить B (прижат по-настоящему).
  const fa = MODE === 'fight' ? A.call('fight', { target: NB, allowPlayer: true, timeoutSeconds: 20, retreatAtHealth: 3 }).catch(() => null) : null
  let done = false
  fight.finally(() => { done = true })
  while (!done && Date.now() - t0 < 22000) {
    const s = await B.call('status').catch(() => null)
    const p = s && s.state && s.state.pos
    if (s && s.state && typeof s.state.health === 'number') minHp = Math.min(minHp, s.state.health)
    if (p && !outAt && (Math.floor(p.x) !== X || Math.floor(p.z) !== Z)) outAt = Date.now() - t0
    await sleep(150)
  }
  const r = await fight.catch(e => ({ error: e.message }))
  if (fa) { await A.call('stop').catch(() => {}); await fa }
  const d = r.detail || {}
  const st1 = await B.call('status').catch(() => null)
  console.log(`--- сцена ${n}: хп ${hp0} -> ${st1 && st1.state ? Math.round(st1.state.health) : '?'} (мин ${Math.round(minHp)}), вышел из клетки с паутиной через ${outAt ?? 'никогда'} мс`)
  console.log('   приёмы:', JSON.stringify(d.tricks || {}))
  console.log('   лечился:', JSON.stringify(d.healed || []), '| темп:', JSON.stringify(d.tempo || {}), '| удары', d.swings, '/', d.landed)
  return { outAt, healed: (d.healed || []).length, tricks: d.tricks || {} }
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/gamerule spawn_mobs false')
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty normal')
    await cmd('/time set day')
    await cmd('/gamerule natural_regeneration false')
    await cmd(`/tp ${NA} ${X} ${Y + 2} ${Z}`)
    await cmd(`/tp ${NB} ${X} ${Y + 2} ${Z}`)
    await sleep(1500)
    const runs = Number(process.argv[2] || 1)
    const out = []
    for (let i = 1; i <= runs; i++) out.push(await scene(i))
    const esc = out.map(o => o.outAt).filter(x => x != null)
    console.log(`ИТОГ: вышел из паутины ${esc.length}/${out.length}, медиана ${esc.sort((a, b) => a - b)[Math.floor(esc.length / 2)] ?? '-'} мс; лечился в ${out.filter(o => o.healed).length}/${out.length}; «отвечаю ударами» ${out.reduce((n, o) => n + (o.tricks['в паутине — отвечаю ударами'] || 0), 0)}`)
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
  } finally {
    await cmd('/gamerule natural_regeneration true').catch(() => {})
    A.ws.close(); B.ws.close()
  }
})()
