'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Лаборатория «бартер на открытом» (поток ne 21.10, совет координатора): золото уже на руках, торг — любыми видимыми взрослыми
// пиглинами вне построек (в золотых ботинках они нейтральны), без ям и окон. Постановка — командами (ферма): закрытый зал Ада
// 23×23×7, тело с набором KIT и золотом GOLD слитков, PIGS взрослых пиглинов (PersistenceRequired) в DIST бл.; дальше только
// навык pearls mode=barter (как вызывает кампания), подряд до MINUTES игровых минут. Строка в LAB_OUT: слитков отдано, жемчуг,
// огнестойкость, обсидиан, сделок/мин, смерти.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-openbarter.js   PIGS=4 GOLD=144 MINUTES=10
import * as fs from 'fs'
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-ne-openbarter.jsonl')
const PIGS = Number(process.env.PIGS || 4)
const GOLD = Number(process.env.GOLD || 144)
const MINUTES = Number(process.env.MINUTES || 10)
const DIST = Number(process.env.DIST || 6)
const KIT = ['golden_boots', 'iron_sword', 'shield', 'iron_pickaxe', 'cooked_mutton 8', 'cobblestone 64', 'crafting_table']
const CX = 3000, CZ = 3000, FY = 70
const N = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
const cnt = (inv, re) => Object.entries<any>(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}
async function status () {
  for (let i = 0; i < 3; i++) {
    const st: any = await Promise.race([call('status', {} as Record<string, any>).catch(() => null), gameClock.wall.sleep(10000).then(() => null)])
    if (st && st.state && st.state.dimension) return st.state
    await gameClock.wall.sleep(500)
  }
  return {} as Record<string, any>
}

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
  for (const d of ['overworld', 'the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule spawn_mobs false`)
  await kit.forceload('the_nether', [[CX - 16, FY, CZ - 16], [CX + 16, FY, CZ + 16]])
  await kit.ensureWorld('the_nether', { tp: `${CX + 0.5} ${FY + 1} ${CZ + 0.5}` })
  await sleep(3000)
  await kit.fillExact('the_nether', [[CX - 12, FY - 5, CZ - 12], [CX + 12, FY + 7, CZ + 12]], 'netherrack')
  await kit.fillExact('the_nether', [[CX - 11, FY, CZ - 11], [CX + 11, FY + 6, CZ + 11]], 'air')
  await kit.cmd(N(`kill @e[type=!minecraft:player,x=${CX - 14},y=${FY - 3},z=${CZ - 14},dx=28,dy=12,dz=28]`))
  await kit.ensureWorld('the_nether', { tp: `${CX + 0.5} ${FY} ${CZ + 0.5}` })
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  for (const g of KIT) { const m = /^(\S+)(?: (\d+))?$/.exec(g); await kit.cmd(`/give @s minecraft:${m[1]}${m[2] ? ' ' + m[2] : ''}`) }
  for (let left = GOLD; left > 0; left -= 64) await kit.cmd(`/give @s minecraft:gold_ingot ${Math.min(64, left)}`)
  await sleep(1000)
  await call('armor', {} as Record<string, any>).catch(() => null)
  for (let i = 0; i < PIGS; i++) {
    const a = (i * Math.PI * 2) / PIGS
    const x = Math.round((CX + 0.5 + Math.cos(a) * DIST) * 10) / 10
    const z = Math.round((CZ + 0.5 + Math.sin(a) * DIST) * 10) / 10
    await kit.cmd(N(`summon minecraft:piglin ${x} ${FY} ${z} {PersistenceRequired:1b,IsImmuneToZombification:1b}`))
  }
  await kit.cmd('/gamemode survival')
  const from = logSize()
  const deaths = (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).deaths(LOG, PLAYER, from)
  const s0 = await status()
  const t0 = gameClock.now()
  const calls = []
  while (gameClock.now() - t0 < MINUTES * 60000) {
    const r: any = await Promise.race([call('pearls', { mode: 'barter', timeoutSeconds: 180 }).catch(e => ({ status: 'failed', error: e.message })),
      gameClock.wall.sleep(240000).then(() => ({ status: 'wall-timeout' }))])
    const d = (r && r.detail) || {}
    calls.push({ s: Math.round((gameClock.now() - t0) / 1000), status: r.status, spent: d.spent, handed: d.handed, thrown: d.thrown, pile: d.pile, pearls: d.pearls, stopped: String(d.stopped || r.error || '').slice(0, 120) })
    if (deaths().length) break
    const st = await status()
    if (!cnt(st.inventory, /^gold_ingot$/)) break
    if (r.status === 'wall-timeout') break
    if (!d.spent) await Promise.race([sleep(3000), gameClock.wall.sleep(3000)])
  }
  try { await Promise.race([call('stop'), gameClock.wall.sleep(10000)]) } catch {}
  const s = await status()
  const inv = s.inventory || {}
  const g0 = cnt(s0.inventory, /^gold_ingot$/)
  const spent = g0 - cnt(inv, /^gold_ingot$/)
  const minutes = (gameClock.now() - t0) / 60000
  const rec = { at: new Date().toISOString(), seed: seedOf(), salt, pigs: PIGS, gold: g0, spent, minutes: Math.round(minutes * 10) / 10,
    perMin: minutes > 0 ? Math.round(spent / minutes * 10) / 10 : null, pearls: cnt(inv, /^ender_pearl$/),
    fireRes: cnt(s.potions || {}, /fire_resistance$/), obsidian: cnt(inv, /^obsidian$/), deaths: deaths(), calls }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-openbarter окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
