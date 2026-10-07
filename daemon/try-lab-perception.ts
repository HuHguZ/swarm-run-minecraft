'use strict'
// Лаборатория честного восприятия (S10, 07.10): в rsg бот не находит руду и сундук за стеной и в толще, находит видимые
// и «пирогом» — закопанный сундук ходом (pie_seek); доля CPU слоя на ходу по живому рельефу.
// Только ферма (постановка командами до замеров). Площадка в небе над спавном (y 199), объекты относительно её центра.
//   node farm/farm.js run try-lab-perception.js --slots 12 --tag s10-p1
const fs = require('fs')
const path = require('path')
const gameClock = require('./src/game-clock')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8812'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm12'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-perception.jsonl')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
function seedOf () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null } }
const perceive = async p => { const r = await call('perceive', p); return r && r.detail }
const key = p => `${p.x},${p.y},${p.z}`

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  await kit.randomReset()
  await kit.cmd('/gamemode survival')
  await kit.gamerule('spawn_mobs', 'false')
  await kit.cmd('/time set 1000')
  await kit.cmd('/weather clear')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect give @s minecraft:resistance 600 4 true')
  const rec: Record<string, any> = { at: new Date().toISOString(), seed: seedOf(), scene: 'try-lab-perception' }
  rec.knowledge = (await perceive({ mode: 'knowledge' })).level
  const st0 = (await call('status')).state || {}
  const p0 = st0.pos
  const C = { x: Math.floor(p0.x), y: 200, z: Math.floor(p0.z) }
  const A = (dx, dy, dz) => ({ x: C.x + dx, y: C.y + dy, z: C.z + dz })
  const at = (q, b) => kit.cmd(`/setblock ${q.x} ${q.y} ${q.z} minecraft:${b}`)
  const fill = (a, b, block) => kit.fillExact(null, [a, b], block)
  // Площадка и пустота над ней.
  await fill(A(-50, 0, -50), A(50, 6, 50), 'air')
  await fill(A(-50, -1, -50), A(50, -1, 50), 'stone')
  await kit.cmd(`/tp @s ${C.x + 0.5} ${C.y} ${C.z + 0.5}`)
  await sleep(1500)
  // Объекты: на виду; в каменной коробке; в толще под площадкой; за стеной; бочка (нет в «пироге»); клад в толще вдали.
  const visChest = A(6, 0, 0); const visOre = A(0, 0, 6)
  await at(visChest, 'chest'); await at(visOre, 'iron_ore')
  await fill(A(-9, 0, -1), A(-7, 2, 1), 'stone'); const boxChest = A(-8, 1, 0); await at(boxChest, 'chest')
  await fill(A(-3, -6, -11), A(3, -2, -5), 'stone'); const deepChest = A(0, -4, -8); const deepOre = A(2, -4, -8)
  await at(deepChest, 'chest'); await at(deepOre, 'iron_ore')
  await fill(A(-4, 0, 10), A(4, 5, 10), 'stone'); const wallChest = A(0, 0, 13); const wallOre = A(2, 0, 13)
  await at(wallChest, 'chest'); await at(wallOre, 'iron_ore')
  await at(A(4, 0, 4), 'barrel')
  const T = A(40, -4, 30)
  await fill(A(39, -6, 29), A(41, -2, 31), 'stone'); await at(T, 'chest')
  await sleep(3000)
  // A: глаза.
  for (let i = 0; i < 6; i++) await perceive({ mode: 'sweep', rays: 3000, maxMs: 300 })
  const seenChests = (await perceive({ mode: 'seen', block: 'chest', max: 20 })).seen
  const seenOres = (await perceive({ mode: 'seen', block: 'iron_ore', max: 20 })).seen
  const pie0 = await perceive({ mode: 'pie' })
  rec.eyes = {
    chests: seenChests.map(key), ores: seenOres.map(key),
    visibleChest: seenChests.some(s => key(s) === key(visChest)), visibleOre: seenOres.some(s => key(s) === key(visOre)),
    hiddenSeen: [boxChest, deepChest, wallChest, deepOre, wallOre, T].filter(q => [...seenChests, ...seenOres].some(s => key(s) === key(q))).map(key)
  }
  rec.pie0 = pie0
  rec.eyesOk = rec.eyes.visibleChest && rec.eyes.visibleOre && rec.eyes.hiddenSeen.length === 0
  rec.pieOk = pie0 && pie0.byType && pie0.byType.chest === 5 && !pie0.byType.barrel
  // B: «пирог» ходом — ближние сундуки убрать, найти закопанный клад.
  for (const q of [visChest, boxChest, deepChest, wallChest]) await at(q, 'air')
  await sleep(1500)
  rec.pie1 = await perceive({ mode: 'pie' })
  const t1 = gameClock.now()
  const seek = await call('perceive', { mode: 'pie_seek', type: 'chest', base: 24, timeoutSeconds: 150 })
  const sk = (seek && seek.detail) || {}
  rec.seek = { status: seek && seek.status, ...sk, seconds: Math.round((gameClock.now() - t1) / 1000) }
  if (sk.estimate) rec.seek.err = Math.round(Math.hypot(sk.estimate.x - (T.x + 0.5), sk.estimate.z - (T.z + 0.5)) * 10) / 10
  rec.seek.truthChunk = { x: T.x >> 4, z: T.z >> 4 }
  rec.seekOk = !!sk.estimate && rec.seek.err <= 6
  rec.seekSeenHidden = ((await perceive({ mode: 'seen', block: 'chest', max: 5 })).seen || []).some(s => key(s) === key(T))
  // D: слух — хаск (не горит днём) за стеной у z+14: не виден, слышен (сторона и полоса, без места).
  await kit.cmd(`/tp @s ${C.x + 0.5} ${C.y} ${C.z + 0.5}`)
  await kit.cmd(`/summon minecraft:husk ${C.x + 0.5} ${C.y} ${C.z + 14.5} {NoAI:1b,PersistenceRequired:1b,Tags:["s10"]}`)
  const t3 = gameClock.now()
  let ent = null; let hd = []
  while (gameClock.now() - t3 < 30000) {
    await sleep(2000)
    hd = (await perceive({ mode: 'heard', sinceSeconds: 30 })).heard || []
    ent = ((await perceive({ mode: 'entities' })).entities || []).find(e => e.name === 'husk')
    if (ent && ent.heard) break
  }
  rec.hear = { heard: hd.filter(h => h.who === 'husk').slice(0, 3), entity: ent || null }
  rec.hearOk = !!(ent && !ent.seen && ent.heard && !ent.pos && ent.heard.dir4 === 'south')
  await kit.cmd('/kill @e[tag=s10]')
  // C: доля CPU слоя на ходу по живому рельефу (глаза обходят по своему бюджету).
  await kit.cmd(`/tp @s ${p0.x} ${p0.y} ${p0.z}`)
  await sleep(2000)
  const s0 = (await perceive({ mode: 'stats' })).stats
  const t2 = gameClock.now(); const w2 = Date.now()
  const legs = []
  for (const [dx, dz] of [[64, 0], [0, 64], [-64, 0], [0, -64]]) {
    const me = ((await call('status')).state || {}).pos
    const g = await call('goto', { x: me.x + dx, z: me.z + dz, range: 4, timeoutSeconds: 90 })
    legs.push(g.status)
  }
  const ex = await call('explore', { block: 'any_log', radius: 48, timeoutSeconds: 60 })
  const s1 = (await perceive({ mode: 'stats' })).stats
  const game = (gameClock.now() - t2) / 1000; const wall = (Date.now() - w2) / 1000
  const layer = s1.ms - s0.ms; const proc = s1.cpu.processMs - s0.cpu.processMs
  rec.route = { legs, explore: ex && ex.status, exploreNote: ex && ex.detail && ex.detail.note, gameSec: Math.round(game), wallSec: Math.round(wall),
    pace: Math.round(game * 20 / Math.max(wall, 0.001)), layerMs: layer, processMs: proc, share: proc > 0 ? Math.round(layer / proc * 1000) / 1000 : null,
    sweeps: s1.sweeps - s0.sweeps, rays: s1.rays - s0.rays, sections: s1.sections - s0.sections, worstMs: s1.worstMs, remembered: s1.remembered }
  rec.cpuOk = rec.route.share !== null && rec.route.share <= 0.10
  rec.ok = !!(rec.eyesOk && rec.pieOk && rec.seekOk && !rec.seekSeenHidden && rec.hearOk && rec.cpuOk)
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec, null, 1))
  try { await call('disconnect', { reason: 'сцена окончена' }) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
