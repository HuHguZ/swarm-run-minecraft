'use strict'
// Лаборатория «постройка по шаблону» (14.10): на ферме найти настоящую постройку (/locate — выбор испытания, не знание
// бота), поставить тело в DIST блоков от неё, дальше бот сам: structure scan (узнал ли глазами) → explore (шаблон,
// сундуки, копка к ним, ныряние) → итог в LAB_OUT: узнал, шаблон, сундуков по шаблону, открыто, взято, секунды, смерть.
//   ND_WS=ws://127.0.0.1:8801 SLOT=1 KIND=shipwreck node try-lab-struct.js
//   KIND: shipwreck | desert_pyramid | jungle_pyramid | igloo | village | ruined_portal | ocean_ruin; NTH=2 — вторая по
//   близости (locate от точки за первой); KIT — набор (по умолчанию каменные инструменты и хлеб); ND_STRUCT_TEMPLATES=0
//   у демона — без шаблонов (замер «с шаблонами и без»).
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const gameClock = require('./src/game-clock')
const { connect } = require('./scene-kit')

const SLOT = process.env.SLOT || '1'
const KIND = process.env.KIND || 'shipwreck'
const PLAYER = process.env.MC_USERNAME || `NeuroFarm${SLOT}`
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-struct.jsonl')
const DIST = Number(process.env.DIST || 18)
const FROM = (process.env.FROM || '').split(',').map(Number)
const KIT = (process.env.KIT || 'stone_pickaxe;stone_axe;stone_shovel;bread 12').split(';').map(s => s.trim()).filter(Boolean)
const LOCATE = { shipwreck: '#minecraft:shipwreck', village: '#minecraft:village', ruined_portal: '#minecraft:ruined_portal', ocean_ruin: '#minecraft:ocean_ruin' }
const WET = new Set(['shipwreck', 'ocean_ruin'])
const rcon = cmd => execFileSync('node', [path.join(__dirname, '..', 'farm', 'farm.js'), 'rcon', SLOT, cmd], { encoding: 'utf8' }).replace(/^слот \d+: /gm, '').trim()
const sleep = ms => gameClock.sleep(ms)

async function main () {
  const WS = process.env.ND_WS || `ws://127.0.0.1:${8800 + Number(SLOT)}`
  const conn = connect(WS)
  await conn.ready
  const call = conn.call
  const t0 = Date.now()
  if (process.env.FARM_SLOT) await require('./farm-bootstrap').farmBootstrap(call, WS, PLAYER)
  await call('connect', { bootstrapPaused: false })
  await sleep(3000)
  rcon(`gamemode survival ${PLAYER}`)
  rcon(`clear ${PLAYER}`)
  rcon(`effect clear ${PLAYER}`)
  rcon('time set 1000')
  rcon('weather clear')
  rcon('gamerule keep_inventory false')
  for (const k of KIT) { const [n, c] = k.split(' '); rcon(`give ${PLAYER} minecraft:${n} ${c || 1}`) }
  // Откуда искать: FROM=x,z, иначе спавн сида из пула good-v2 (одна и та же постройка в прогонах с шаблонами и без), иначе от тела.
  let spawn = null
  try {
    const props = fs.readFileSync(path.join(__dirname, '..', 'farm', `server-${SLOT}`, 'server.properties'), 'utf8')
    const seed = (/^level-seed=(.*)$/m.exec(props) || [])[1]
    const row = require('../farm/seeds/good-v2.json').seeds.find(s => String(s.seed) === String(seed).trim())
    if (row && Array.isArray(row.spawn)) spawn = row.spawn
  } catch {}
  const from = FROM.length === 2 && FROM.every(Number.isFinite) ? `positioned ${FROM[0]} 64 ${FROM[1]}` : spawn ? `positioned ${spawn[0]} 64 ${spawn[1]}` : `at ${PLAYER}`
  const loc = rcon(`execute ${from} run locate structure ${LOCATE[KIND] || 'minecraft:' + KIND}`)
  const m = /at \[(-?\d+), [~\-\d]+, (-?\d+)\]/.exec(loc)
  if (!m) throw new Error(`не нашёл ${KIND}: ${loc}`)
  const at = { x: Number(m[1]), z: Number(m[2]) }
  // Тело — в DIST блоков к западу от середины чанка старта: на воду (корабль, руины — с поверхности моря) или на сушу
  // (spreadplayers — на верх). Не видно оттуда (дюна, рельеф) — второй заход к самой середине (так подошёл бы игрок).
  const put = d => {
    if (WET.has(KIND)) rcon(`tp ${PLAYER} ${at.x + 8 - d} 66 ${at.z + 8}`)
    else {
      rcon(`spreadplayers ${at.x + 8 - d} ${at.z + 8} 0 3 false ${PLAYER}`)
      // На землю, не на крону (джунгли 14.10: spreadplayers ставит на верх дерева — храма под листвой оттуда не видно).
      for (let y = 100; y >= 56; y -= 4) {
        const onTree = ['#minecraft:leaves', '#minecraft:logs'].some(tag => /passed/i.test(rcon(`execute as ${PLAYER} at @s if block ~ ~-1 ~ ${tag}`)))
        if (!onTree) break
        rcon(`spreadplayers ${at.x + 8 - d} ${at.z + 8} 0 3 under ${y} false ${PLAYER}`)
      }
    }
    rcon(`effect give ${PLAYER} minecraft:resistance 6 4 true`)
  }
  let blocks = null
  const look = async () => {
    await sleep(6000)
    await gameClock.wall.sleep(3000) // прорисовка чанков у клиента — по стенным часам (750 TPS пошагово — 6 игр. с за доли секунды)
    const scan = await call('structure', { mode: 'scan', radius: 64, blocks: true })
    blocks = (scan.detail && scan.detail.blocks) || scan.blocks || null // что глаза увидели из сигнатур построек (для разбора «не узнан»)
    return ((scan.detail && scan.detail.seen) || scan.seen || []).map(s => `${s.kind}@${s.at.x},${s.at.z}`)
  }
  put(DIST)
  let seen = await look()
  let approach = DIST
  if (!seen.some(s => s.startsWith(KIND))) { put(2); approach = 2; seen = await look() }
  const st0 = await call('status', {})
  const ts = gameClock.now()
  const ex = await call('structure', { mode: 'explore', kind: KIND, x: at.x, z: at.z, timeoutSeconds: Number(process.env.SECONDS || 300) })
  const sec = Math.round((gameClock.now() - ts) / 1000)
  const d = ex.detail || ex
  // Цепочка «корабль → карта → клад»: карта в рюкзаке — прочитать (крестик и своя метка) и копать клад.
  let chain = null
  const maps = ((await call('structure', { mode: 'maps' })).detail || {}).maps || []
  if (maps.length && process.env.CHAIN !== '0') {
    let m = maps[0]
    const tc = gameClock.now()
    // Дорога — отрезками по 64, как campaign.goToward (explore идёт только последний кусок); вне карты — перечитать её по пути.
    const legs = []
    for (let k = 0; k < 12; k++) {
      const me = ((await call('status', {})).state || {}).pos
      const d = me ? Math.hypot(m.x - me.x, m.z - me.z) : 0
      if (!me || d <= 48) break
      const f = Math.min(1, 64 / d)
      const g = await call('goto', { x: Math.round(me.x + (m.x - me.x) * f), z: Math.round(me.z + (m.z - me.z) * f), range: 6, timeoutSeconds: 120 })
      legs.push(`${g.status}${g.status !== 'done' ? ':' + String((g.detail && g.detail.stopped) || g.error || '').slice(0, 60) : ''}`)
      const again = (((await call('structure', { mode: 'maps' })).detail || {}).maps || [])[0]
      if (again) m = again
      if (g.status !== 'done' && legs.filter(x => !x.startsWith('done')).length >= 3) break
    }
    const tx = await call('structure', { mode: 'explore', kind: 'buried_treasure', x: m.x, z: m.z, maxDistance: 600, timeoutSeconds: 400 })
    const td = tx.detail || {}
    chain = { map: m, legs, status: tx.status, by: tx.by || null, eventsRaw: (tx.events || []).slice(0, 6), sec: Math.round((gameClock.now() - tc) / 1000), took: td.took || {}, stopped: td.stopped || null, lines: (td.lines || []).slice(0, 8) }
  }
  const st1 = await call('status', {})
  const bag = (st1 && st1.state && st1.state.inventory) || {}
  const rec = {
    kind: KIND, at, approach, blocks, pos0: st0 && st0.state ? st0.state.pos : null, seed: process.env.SEED || null, templates: process.env.ND_STRUCT_TEMPLATES !== '0', seen, recognized: seen.some(s => s.startsWith(KIND)),
    status: ex.status, by: ex.by || null, events: (ex.events || []).map(e => e.type + (e.action ? ':' + e.action : '')).join(' '), eventsRaw: (ex.events || []).slice(0, 8), bag,
    template: ((d.lines || []).filter(l => /шаблон/.test(l)).pop() || '').replace(/^▸ /, ''),
    chests: (d.chests || []).map(c => ({ at: c.at, planned: !!c.planned, took: c.took, error: c.error, sec: c.sec })),
    opened: (d.chests || []).filter(c => c.took).length,
    took: d.took || {}, stopped: d.stopped || null, sec, realSec: Math.round((Date.now() - t0) / 1000),
    hp: st1 && st1.state ? st1.state.health : null, dead: !!(st1 && st1.state && st1.state.health === 0),
    chain,
    lines: (d.lines || []).slice(0, 30)
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec, null, 1))
  conn.close()
}

main().then(() => process.exit(0)).catch(e => { console.error(e); try { fs.appendFileSync(OUT, JSON.stringify({ kind: KIND, error: String(e.message || e) }) + '\n') } catch {} process.exit(1) })
