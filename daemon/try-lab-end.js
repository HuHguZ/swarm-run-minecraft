'use strict'
// Лаборатория этапов, этап 3 — очи → крепость → портал → Энд (server-nether,
// верхний мир). Сцена командами только ставит тело: набор кампании после
// этапов стержней и жемчуга (7 стержней, 12 жемчужин), точка на суше в
// DIST блоках от крепости, которую даёт /locate (правда для сверки). Дальше —
// ровно те вызовы, что делает кампания (campaign.js, этапы eyes, stronghold,
// dragon): craft blaze_powder, craft ender_eye, stronghold find, stronghold
// room (до 4 раз), stronghold fill enter:true. Итог — тело в the_end.
//
// Запуск: ND_WS=ws://127.0.0.1:8773 MC_USERNAME=NeuroNether node try-lab-end.js
//   SH_NEAR="x,z" — крепость, ближайшая к этой точке (у зажжённой fill скажет
//   «уже горит»; первая кольцевая — 3 крепости через 120°); DIST=300 — отступ.
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8773'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-end.jsonl')
const DIST = Number(process.env.DIST || 300)
const NEAR = process.env.SH_NEAR ? process.env.SH_NEAR.split(',').map(Number) : [0, 0]

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const header = async () => ((await call('status')) || {}).state || {}
const have = async n => ((await header()).inventory || {})[n] || 0

const KIT = ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'shield', 'bow', 'arrow 16',
  'cooked_beef 16', 'cobblestone 40', 'iron_pickaxe 2', 'blaze_rod 7', `ender_pearl ${process.env.PEARLS || 12}`, 'torch 16',
  // EXTRA="oak_log 4,crafting_table" — что ещё несёт кампания (дерево на лодку).
  ...String(process.env.EXTRA || '').split(',').map(x => x.trim()).filter(Boolean)]

async function locate () {
  const loc = await call('ask', { command: '/locate structure minecraft:stronghold', match: 'nearest|Could not', ms: 20000 })
  const line = (((loc && loc.detail) || loc || {}).lines || []).find(l => /nearest/.test(l)) || ''
  const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
  return m ? { x: Number(m[1]), z: Number(m[3]) } : null
}

const steps = []
async function act (method, params) {
  const t0 = Date.now()
  const r = await call(method, params)
  const d = r.detail || {}
  const h = await header()
  const brief = { method, params, s: Math.round((Date.now() - t0) / 1000), status: r.status, by: r.by ? r.by.type : undefined, err: r.error, dim: h.dimension, pos: h.pos, hp: h.health, stopped: d.stopped ? String(d.stopped).slice(0, 160) : undefined }
  for (const k of ['found', 'room', 'at', 'estimate', 'went', 'entered', 'lit', 'placed', 'frames', 'withEye', 'walked', 'legs', 'throws', 'refined']) if (d[k] !== undefined) brief[k] = typeof d[k] === 'object' ? JSON.stringify(d[k]).slice(0, 200) : d[k]
  steps.push(brief)
  console.log(`  ${method} ${JSON.stringify(params)}: ${JSON.stringify(brief).slice(0, 600)}`)
  return r
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  const t0 = Date.now()
  const res = { at: new Date().toISOString() }
  try {
    await kit.cmd('/gamemode survival')
    await kit.cmd('/effect give @s minecraft:slow_falling 60 0 true')
    await kit.cmd(`/execute in minecraft:overworld run tp @s ${NEAR[0]} 200 ${NEAR[1]}`)
    await sleep(5000)
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', 'true')
    await kit.gamerule('send_command_feedback', 'true')
    await kit.cmd('/time set day')
    const S = await locate()
    if (!S) throw new Error('/locate не дал крепость')
    res.truth = S
    console.log(`/locate: крепость (угол чанка старта) ${S.x}, ${S.z}`)
    // Точка на суше в DIST от крепости (spreadplayers не ставит в воду).
    let onLand = false
    for (let tryN = 0; tryN < 6 && !onLand; tryN++) {
    const a = Math.random() * Math.PI * 2
    // START="x,z" — своя точка старта (суша, с которой крепость видна без моря).
    const P = process.env.START && tryN === 0 ? { x: Number(process.env.START.split(',')[0]), z: Number(process.env.START.split(',')[1]) } : { x: Math.round(S.x + Math.sin(a) * DIST), z: Math.round(S.z + Math.cos(a) * DIST) }
    // Разный текст — без разделителя «/say» (он рвёт намерения других ботов).
    await kit.cmd(`/effect give @s minecraft:slow_falling ${61 + tryN} 0 true`)
    await kit.cmd(`/execute in minecraft:overworld run tp @s ${P.x} 200 ${P.z}`)
    await sleep(5000)
    // Сразу на поверхность по карте высот (execute positioned over, 1.19.4+):
    // spreadplayers у моря молча не ставил, тело висело на y 200, замедление
    // кончалось — смерть от падения и старт у точки возрождения (room-A-6:
    // «start -10,66,-8», шёл пешком 1800 блоков).
    await kit.cmd(`/execute in minecraft:overworld positioned ${P.x} 0 ${P.z} positioned over motion_blocking_no_leaves run tp @s ~0.5 ~ ~0.5`)
    await sleep(3000)
    // spreadplayers в свежих чанках отвечает долго или молча — свидетель
    // не ответ, а тело: ниже 190 и на твёрдом.
    for (let i = 0; i < 3; i++) {
      const h0 = await header()
      if (h0.pos && h0.pos.y < 190 && h0.dimension === 'overworld') break
      await kit.cmd(`/spreadplayers ${P.x + i * 64} ${P.z} 0 40 false @s`, { reply: /Spread|Could not/, ms: 45000 })
      await sleep(3000)
    }
    const o = await call('observe', { radius: 4, fair: false })
    const on = (((o && o.detail) || {}).terrain || {}).standingOn || ''
    const hh = await header()
    onLand = !!on && !/water/.test(on) && hh.pos && hh.pos.y >= 62
    console.log(`точка ${P.x},${P.z}: стою на ${on} y=${hh.pos && hh.pos.y}${onLand ? '' : ' — не суша, другая'}`)
    }
    await kit.cmd('/clear @s')
    for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
    await kit.cmd('/effect clear @s')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
    await sleep(1500)
    await call('armor', {})
    res.start = (await header()).pos
    // Этап eyes (campaign.js): порошок из стержней, око из жемчуга и порошка.
    const want = Math.min(Number(process.env.PEARLS || 12), await have('ender_pearl'))
    await act('craft', { item: 'blaze_powder', count: Math.min(2 * (await have('blaze_rod')), want + 1) })
    await act('craft', { item: 'ender_eye', count: Math.min(want, await have('blaze_powder')) })
    res.eyes = await have('ender_eye')
    // Этап stronghold.
    const f = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
    const fd = f.detail || {}
    const st = fd.stronghold || fd.at || fd.estimate
    if (st) res.findErr = Math.round(Math.hypot(st.x - S.x, st.z - S.z))
    let room = null
    for (let i = 0; i < 4 && !room; i++) {
      const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
      if (r.by && r.by.type === 'death') break
      if (r.detail && r.detail.room) room = r.detail.room
    }
    res.room = room
    // Этап dragon: вставить очи и войти.
    if (room) {
      await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 200 })
    }
    let h = await header()
    for (let i = 0; i < 20 && h.dimension !== 'the_end'; i++) { await sleep(300); h = await header() }
    res.dimension = h.dimension
    res.eyesLeft = await have('ender_eye')
  } catch (e) {
    res.error = e.message
    console.log('сцена оборвалась:', e.message)
  } finally {
    res.deaths = kit.between(t0, Date.now(), 'death').length + (steps.some(s => s.by === 'death') ? 1 : 0)
    res.seconds = Math.round((Date.now() - t0) / 1000)
    res.steps = steps
    res.ok = res.dimension === 'the_end' && !res.deaths
    fs.appendFileSync(OUT, JSON.stringify(res) + '\n')
    console.log(`\nИТОГ: ${res.ok ? 'OK — в Энде' : 'ПЛОХО'}: ${res.dimension}, смертей ${res.deaths}, ${res.seconds} с, ошибка find ${res.findErr} бл.`)
    try { await call('stop') } catch {}
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
