'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Лаборатория «жемчуг эндерменами в искажённом лесу Ада» (поток ne 21.10, совет координатора: параллельная цена к бартеру).
// Постановка — командами (ферма): ближайший искажённый лес Ада (/locate biome — только постановка, телу не передаётся), тело
// командой в лес (spreadplayers по поверхности), набор KIT; дальше только навык pearls mode=hunt (как этап кампании), подряд до
// MINUTES игровых минут или COUNT жемчуга. Строка в LAB_OUT: жемчуг, минуты, вызовы, смерти.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-ender.js   COUNT=12 MINUTES=15
import * as fs from 'fs'
import path = require('path')
import { execFileSync } from 'child_process'
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-ne-ender.jsonl')
const COUNT = Number(process.env.COUNT || 12)
const MINUTES = Number(process.env.MINUTES || 15)
const KIT = ['golden_boots', 'iron_sword', 'shield', 'iron_pickaxe', 'stone_pickaxe', 'cooked_mutton 8', 'cobblestone 64', 'netherrack 64', 'crafting_table']

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
const cnt = (inv, re) => Object.entries<any>(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}
function rcon (text) {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 90000 }) } catch (e) { return String(e.message) }
}
async function status () {
  for (let i = 0; i < 3; i++) {
    const st: any = await Promise.race([call('status', {} as Record<string, any>).catch(() => null), gameClock.wall.sleep(10000).then(() => null)])
    if (st && st.state && st.state.dimension) return st.state
    await gameClock.wall.sleep(500)
  }
  return {} as Record<string, any>
}
const fail = why => { const rec = { at: new Date().toISOString(), seed: seedOf(), ok: false, setupFail: true, stoppedBy: why }; fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec)) }

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const salt = await kit.randomReset()
  await kit.cmd('/gamemode creative')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'false')
  await kit.cmd('/execute in minecraft:the_nether run gamerule keep_inventory false')
  await kit.gamerule('send_command_feedback', 'true')
  const out = rcon('execute in minecraft:the_nether positioned 0 70 0 run locate biome minecraft:warped_forest')
  const m = /\[(-?\d+), (-?\d+), (-?\d+)\] \((\d+) blocks/.exec(out)
  if (!m) { fail('искажённого леса /locate не нашёл'); process.exit(0) }
  const W = { x: Number(m[1]), z: Number(m[3]) }
  await kit.ensureWorld('the_nether', { tp: `${W.x + 0.5} 120 ${W.z + 0.5}` })
  await sleep(2000)
  const r = await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${W.x} ${W.z} 0 6 under 100 false @s`, { reply: /Spread|Could not/, ms: 30000 })
  if (!r.ok || /Could not/.test(r.reply || '')) { fail('spreadplayers в лесу не вышел'); process.exit(0) }
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  for (const g of KIT) { const k = /^(\S+)(?: (\d+))?$/.exec(g); await kit.cmd(`/give @s minecraft:${k[1]}${k[2] ? ' ' + k[2] : ''}`) }
  await sleep(1000)
  await call('armor', {} as Record<string, any>).catch(() => null)
  await kit.cmd('/gamemode survival')
  const from = logSize()
  const deaths = (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).deaths(LOG, PLAYER, from)
  const t0 = gameClock.now()
  const calls = []
  let s: Record<string, any> = await status()
  while (gameClock.now() - t0 < MINUTES * 60000 && cnt(s.inventory, /^ender_pearl$/) < COUNT) {
    const left = COUNT - cnt(s.inventory, /^ender_pearl$/)
    const h: any = await Promise.race([call('pearls', { mode: 'hunt', count: left, timeoutSeconds: 400 }).catch(e => ({ status: 'failed', error: e.message })),
      gameClock.wall.sleep(480000).then(() => ({ status: 'wall-timeout' }))])
    const d = (h && h.detail) || {}
    s = await status()
    calls.push({ s: Math.round((gameClock.now() - t0) / 1000), status: h.status, pearls: cnt(s.inventory, /^ender_pearl$/), seen: d.seenEndermen, stopped: String(d.stopped || h.error || '').slice(0, 120) })
    if (deaths().length || h.status === 'wall-timeout') break
  }
  try { await Promise.race([call('stop'), gameClock.wall.sleep(10000)]) } catch {}
  s = await status()
  const rec = { at: new Date().toISOString(), seed: seedOf(), salt, forest: W, minutes: Math.round((gameClock.now() - t0) / 6000) / 10,
    pearls: cnt(s.inventory || {}, /^ender_pearl$/), hp: s.health ?? null, deaths: deaths(), calls }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-ender окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
