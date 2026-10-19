'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Лаборатория штрека по маршруту (via) между бастионами: тело у бастиона 1 в закрытой ячейке на старте
// маршрута, рюкзак — как у основного тела после бастиона 1 (кирки, чернокамень, палки, доски, железная кирка).
// Туда: nether_tunnel по via «бастион 2 (ад)» из памяти основного (memory-run/state.json) до конца маршрута;
// обратно (BACK=1): по обратному маршруту бастион 2 → бастион 1 → портал (ад). Итог — строка JSON в LAB_OUT.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… node try-lab-via.js   BACK=1
import * as fs from 'fs'
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-via.jsonl')
const BACK = process.env.BACK === '1'
const MEM = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'memory-run/state.json'), 'utf8')).places
const B1 = MEM['бастион (ад)']; const B2 = MEM['бастион 2 (ад)']; const PORTAL = MEM['портал (ад)']
const KIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots',
  'stone_pickaxe[damage=60]', 'stone_pickaxe', 'iron_pickaxe[damage=40]', 'blackstone 64', 'stick 3', 'oak_planks 13',
  'crafting_table', 'cooked_porkchop 8', 'iron_sword', 'shield', 'netherrack 32', 'torch 9', 'water_bucket', 'blaze_rod 7']

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
function deathLines (from) {
  try {
    const buf = fs.readFileSync(LOG, 'utf8').slice(from)
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up|withered/.test(l) && !/advancement/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const where = async () => { const st = await call('status', {} as Record<string, any>).catch(() => null); const p = st && st.state && st.state.pos; return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null }

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const [sx, sy, sz] = B2.via[0]
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'true')
  await kit.cmd('/clear @s')
  for (const g of KIT) { const [item, n] = g.split(' '); await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`) }
  await kit.cmd('/effect clear @s')
  // Закрытая ячейка 1×2 на старте маршрута (в толще — иначе тп в камень душит).
  await kit.cmd(`/execute in minecraft:the_nether run forceload add ${sx - 16} ${sz - 16} ${sx + 16} ${sz + 16}`)
  await sleep(2000)
  await kit.cmd(`/execute in minecraft:the_nether run fill ${sx} ${sy} ${sz} ${sx} ${sy + 1} ${sz} minecraft:air`)
  await kit.cmd(`/execute in minecraft:the_nether run tp @s ${sx + 0.5} ${sy} ${sz + 0.5}`)
  await kit.ensureWorld('the_nether')
  await sleep(2500)
  await kit.cmd(`/execute in minecraft:the_nether run forceload remove ${sx - 16} ${sz - 16} ${sx + 16} ${sz + 16}`)
  await call('armor', {} as Record<string, any>)
  const size = logSize()
  const rec: Record<string, any> = { at: new Date().toISOString(), start: { x: sx, y: sy, z: sz } }
  const end = B2.via[B2.via.length - 1]
  let t0 = gameClock.now()
  const r1 = await call('nether_tunnel', { x: end[0], y: end[1], z: end[2], radius: 5, via: B2.via, budgetCheck: true, noBreachNear: { x: B2.x, z: B2.z, r: 48 }, timeoutSeconds: 2700 }).catch(e => ({ status: 'failed', error: e.message }))
  const d1 = r1.detail || {} as Record<string, any>
  rec.there = { ok: !!d1.ok, why: d1.why || r1.error, min: +((gameClock.now() - t0) / 60000).toFixed(1), dug: d1.dug, moves: d1.moves, crafted: d1.crafted, viaDone: d1.viaDone, need: d1.need, budget: d1.budget, at: await where(), deaths: deathLines(size) }
  console.log(JSON.stringify(rec.there))
  if (BACK && rec.there.deaths.length === 0) {
    const via = [...B2.via].reverse().concat([...B1.via].reverse())
    t0 = gameClock.now()
    const size2 = logSize()
    const r2 = await call('nether_tunnel', { x: PORTAL.x, y: PORTAL.y, z: PORTAL.z, radius: 6, via, ironOk: true, timeoutSeconds: 2700 }).catch(e => ({ status: 'failed', error: e.message }))
    const d2 = r2.detail || {} as Record<string, any>
    rec.back = { ok: !!d2.ok, why: d2.why || r2.error, min: +((gameClock.now() - t0) / 60000).toFixed(1), dug: d2.dug, moves: d2.moves, crafted: d2.crafted, viaDone: d2.viaDone, at: await where(), deaths: deathLines(size2) }
    console.log(JSON.stringify(rec.back))
  }
  const st = await call('status', {} as Record<string, any>).catch(() => null)
  const inv = (st && st.state && st.state.inventory) || {} as Record<string, any>
  rec.inv = Object.fromEntries(Object.entries<any>(inv).filter(([k]: any) => /pickaxe|blackstone|cobble|stick|planks|netherrack/.test(k)))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  await call('stop').catch(() => {})
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
