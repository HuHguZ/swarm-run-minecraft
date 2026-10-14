'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория «пиглины без золота» (агент Ада 14.10): главная смерть слепых прогонов Ада без золотой вещи — пиглины
// вплотную (b15: 6 из 8 смертей; тактика CreateDistance/Flee/BlockOff под ударами 8 хп раз в секунду). Сцена ставит тело
// (набор входа без брони: щит, железный меч, блоки, еда) в закрытый зал Ада 23×23×7 и вызывает FOES врагов в DIST бл.;
// дальше — только тактика тела (навыка нет), SECONDS игровых секунд. Постановка — командами (ферма), замер — без команд.
// Строка на попытку в LAB_OUT: смерть, мин. хп, конечное хп, врагов осталось, цепочка выбранных тактикой действий.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-piglin.js
//   FOES=piglin:sword,piglin:crossbow (тип:оружие, через запятую; *3 — повтор: piglin:sword*3) TRIALS=6 DIST=7 SECONDS=40
//   KIT=ls|lsgold
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ne-piglin.jsonl')
const TRIALS = Number(process.env.TRIALS || 6)
const DIST = Number(process.env.DIST || 7)
const SECONDS = Number(process.env.SECONDS || 40)
const BASE = ['iron_sword', 'shield', 'iron_pickaxe', 'stone_pickaxe 2', 'flint_and_steel', 'water_bucket', 'bucket',
  'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4']
const KITS = { ls: BASE, lsgold: [...BASE, 'golden_boots'] }
const KIT_NAME = process.env.KIT || 'ls'
const KIT = KITS[KIT_NAME]
if (!KIT) { console.error(`KIT=${KIT_NAME}: жду ${Object.keys(KITS).join(', ')}`); process.exit(1) }
const WEAPON = { sword: 'golden_sword', crossbow: 'crossbow', axe: 'golden_axe', none: null }
const FOES = String(process.env.FOES || 'piglin:sword').split(',').flatMap(s => {
  const [spec, times] = s.trim().split('*')
  const [type, weapon = 'sword'] = spec.split(':')
  return Array.from({ length: Number(times || 1) }, () => ({ type, weapon }))
})
const CX = 3000, CZ = 3000, FY = 70
const N = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}
function rcon (text) {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 60000 }) } catch (e) { return String(e.message) }
}
async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await Promise.race([call('status', {} as Record<string, any>).catch(() => null), gameClock.wall.sleep(10000).then(() => null)])
    if (st && st.state && st.state.dimension) return st.state
    await gameClock.wall.sleep(500)
  }
  return {} as Record<string, any>
}
const TYPES = [...new Set(FOES.map(f => f.type))]
const alive = () => {
  let n = 0
  for (const type of TYPES) {
    const out = rcon(`execute in minecraft:the_nether if entity @e[type=minecraft:${type},x=${CX - 12},y=${FY - 1},z=${CZ - 12},dx=24,dy=9,dz=24]`)
    const m = /count: (\d+)/i.exec(out)
    if (!m && !/failed/i.test(out)) return null
    n += m ? Number(m[1]) : 0
  }
  return n
}

async function arena () {
  await kit.forceload('the_nether', [[CX - 16, FY, CZ - 16], [CX + 16, FY, CZ + 16]])
  await kit.ensureWorld('the_nether', { tp: `${CX + 0.5} ${FY + 1} ${CZ + 0.5}` })
  await sleep(3000)
  await kit.fillExact('the_nether', [[CX - 12, FY - 5, CZ - 12], [CX + 12, FY + 7, CZ + 12]], 'netherrack')
  await kit.fillExact('the_nether', [[CX - 11, FY, CZ - 11], [CX + 11, FY + 6, CZ + 11]], 'air')
}

async function trial (k) {
  await kit.cmd('/gamemode creative')
  await kit.cmd(N(`kill @e[type=!minecraft:player,x=${CX - 14},y=${FY - 3},z=${CZ - 14},dx=28,dy=12,dz=28]`))
  // Зал заново на каждую попытку: норы, столбы и коробки прошлой попытки — не пол этой.
  await kit.ensureWorld('the_nether', { tp: `${CX + 0.5} ${FY + 8} ${CZ + 0.5}` })
  await kit.fillExact('the_nether', [[CX - 12, FY - 5, CZ - 12], [CX + 12, FY - 1, CZ + 12]], 'netherrack')
  await kit.fillExact('the_nether', [[CX - 11, FY, CZ - 11], [CX + 11, FY + 6, CZ + 11]], 'air')
  await kit.cmd(N(`kill @e[type=minecraft:item,x=${CX - 14},y=${FY - 6},z=${CZ - 14},dx=28,dy=16,dz=28]`))
  await kit.ensureWorld('the_nether', { tp: `${CX + 0.5} ${FY} ${CZ + 0.5}` })
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  for (const g of KIT) {
    const m = /^(\S+)(?: (\d+))?$/.exec(g)
    await kit.cmd(`/give @s minecraft:${m[1]}${m[2] ? ' ' + m[2] : ''}`)
  }
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(1000)
  await call('armor', {} as Record<string, any>).catch(() => null)
  const a0 = Math.random() * Math.PI * 2
  for (let i = 0; i < FOES.length; i++) {
    const f = FOES[i]
    const a = a0 + (i * Math.PI * 2) / FOES.length
    const x = Math.round((CX + 0.5 + Math.cos(a) * DIST) * 10) / 10
    const z = Math.round((CZ + 0.5 + Math.sin(a) * DIST) * 10) / 10
    const w = WEAPON[f.weapon]
    const nbt = `{PersistenceRequired:1b${w ? `,equipment:{mainhand:{id:"minecraft:${w}",count:1}}` : ''}}`
    await kit.cmd(N(`summon minecraft:${f.type} ${x} ${FY} ${z} ${nbt}`))
  }
  await kit.cmd('/gamemode survival')
  const from = logSize()
  const deaths = require('./try-lab-ne-util').deaths(LOG, PLAYER, from)
  const heard0 = conn.heard.length
  const t0 = gameClock.now()
  let hpMin = 20
  let st: Record<string, any> = {}
  let left = null
  let lastCount = gameClock.now()
  while (gameClock.now() - t0 < SECONDS * 1000) {
    await Promise.race([sleep(500), gameClock.wall.sleep(5000)])
    st = await status()
    if (typeof st.health === 'number') hpMin = Math.min(hpMin, st.health)
    if (deaths().length || (st.health ?? 20) <= 0) break
    if (gameClock.now() - lastCount > 4000) { lastCount = gameClock.now(); left = alive(); if (left === 0) break }
  }
  try { await call('stop') } catch {}
  const died = deaths()
  left = alive()
  const events = conn.heard.slice(heard0)
  const chain = events.filter(e => e.type === 'tactical_selected').map(e => e.action)
  const fails = events.filter(e => e.type === 'tactical_failed').map(e => `${e.action}: ${String(e.reason || '').slice(0, 60)}`)
  const rec = { at: new Date().toISOString(), seed: seedOf(), kit: KIT_NAME, trial: k + 1, foes: FOES.map(f => `${f.type}:${f.weapon}`).join(','), dist: DIST,
    died: died.length > 0, deaths: died, hpMin: Math.round(hpMin * 10) / 10, hp: died.length ? 0 : Math.round((st.health ?? 0) * 10) / 10,
    left, seconds: Math.round((gameClock.now() - t0) / 100) / 10, chain: chain.join('>'), fails: fails.slice(0, 6) }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  if (died.length) {
    // Возрождение — в верхнем мире; следующая попытка вернёт тело в зал командой.
    for (let w = 0; w < 30 && !((await status()).health > 0); w++) await gameClock.wall.sleep(500)
  }
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  await kit.randomReset()
  await kit.cmd('/gamemode creative')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'false')
  await kit.gamerule('send_command_feedback', 'true')
  for (const d of ['overworld', 'the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule spawn_mobs false`)
  await arena()
  for (let k = 0; k < TRIALS; k++) await trial(k)
  await kit.cmd('/gamemode creative')
  await kit.cmd(N(`kill @e[type=!minecraft:player,x=${CX - 14},y=${FY - 3},z=${CZ - 14},dx=28,dy=12,dz=28]`))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-piglin окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
