'use strict'
import { REPO_ROOT, DIST_ROOT } from '../../daemon/src/paths'
// Короткий контроль дороги, затем продолжение того же прогона при полезном движении.
// Только ферма; состояние смертей читается с диска, события RPC могут быть уже drained.
import * as fs from 'fs'
import path = require('path')
import { spawn } from 'child_process'
const ROOT = REPO_ROOT
const DAEMON = path.join(DIST_ROOT, 'daemon')
const { connect, createKit, sleep } = require(path.join(DAEMON, 'scenes', 'lib', 'scene-kit'))
const SLOT = Number(process.env.FARM_SLOT || 2)
if (![2, 5].includes(SLOT)) throw new Error('Этот опыт принадлежит только выделенным слотам 2 и 5')
const MEM = path.join(ROOT, 'farm', `memory-${SLOT}`, 'state.json')
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'farm/stronghold_route/route-result.jsonl')
const LOG = process.env.ND_SERVER_LOG || path.join(ROOT, 'farm', `server-${SLOT}`, 'logs', 'latest.log')
const TRACE = OUT.replace(/\.jsonl$/, '.trace.jsonl')
const CLOG = OUT.replace(/\.jsonl$/, '.campaign.log')
const MAX_MINUTES = Number(process.env.MINUTES || 45)
const CHECK_MINUTES = Number(process.env.CHECK_MINUTES || 8)
const WS = process.env.ND_WS || `ws://127.0.0.1:${8800 + SLOT}`
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: process.env.MC_USERNAME || `NeuroFarm${SLOT}` })
const readMemory = () => { try { return JSON.parse(fs.readFileSync(MEM, 'utf8')) } catch { return {} as Record<string, any> } }
const readText = () => { try { return fs.readFileSync(CLOG, 'utf8') } catch { return '' } }
const KIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots',
  'iron_pickaxe[damage=100]', 'stone_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'bow', 'arrow 64', 'ender_eye 10',
  'cooked_beef 32', 'golden_apple 2', 'cobblestone 128', 'water_bucket', 'water_bucket', 'white_bed 6', 'crafting_table',
  'oak_planks 16', 'stick 8', 'torch 16', 'flint_and_steel', 'obsidian 5', 'blaze_rod 2']
let child = null
let exited = null
let reason = 'лимит времени'

async function main () {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  await conn.ready
  await call('connect')
  await call('stop')
  // Ровно перед независимым прогоном, подтверждение scene-kit в server log.
  await kit.randomReset()
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'true')
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  await kit.cmd('/execute in minecraft:overworld run tp @s -19.5 65 -22.5')
  await kit.ensureWorld('overworld')
  await sleep(1500)
  await call('armor', {} as Record<string, any>)
  const before = readMemory()
  const baselineDeaths = new Set((before.deaths || []).map(d => d.at))
  const target = before.places?.['крепость']
  if (!target || target.x !== -400 || target.z !== 1776) throw new Error(`Память не от server-run: ${JSON.stringify(target)}`)
  const s0 = (await call('status')).state
  const t0 = Date.now()
  const far = s => s.pos ? Math.hypot(target.x - s.pos.x, target.z - s.pos.z) : Infinity
  const initialFar = far(s0)
  let bestFar = initialFar
  let lastProgress = t0
  let checked = false
  fs.writeFileSync(CLOG, '')
  let campaignFile = path.join(DAEMON, 'campaign.js')
  if (process.env.ROUTE_MODE === 'east') {
    campaignFile = OUT.replace(/\.jsonl$/, '.east-campaign.js')
    const marker = '  // Дальняя дорога (до 1800+ блоков поверху)'
    let source = fs.readFileSync(path.join(DAEMON, 'campaign.js'), 'utf8')
    if (!source.includes(marker)) throw new Error('Точка вставки диагностического маршрута отсутствует')
    source = source.replace("require('ws')", `require(${JSON.stringify(path.join(DAEMON, 'node_modules', 'ws'))})`)
      .replace("require(path.join(__dirname, 'src', 'play-policy'))", `require(${JSON.stringify(path.join(DAEMON, 'src', 'play-policy'))})`)
      .replace(marker, `  // Диагностический восточный обход горы, только на ферме.
  if (state.pos && state.pos.z < 620 && known.stronghold && known.stronghold.x === -400 && known.stronghold.z === 1776) {
    const route = [[32, -16], [64, 48], [64, 160], [32, 256], [16, 384], [-80, 496], [-144, 608]];
    for (const [x, z] of route) {
      if (died) return;
      if (state.pos.z > z + 16) continue;
      log('восточный маршрут: ' + x + ',' + z);
      await goToward({ x, z }, 8);
    }
  }
` + marker)
    fs.writeFileSync(campaignFile, source)
  }
  child = spawn(process.execPath, [campaignFile, 'endkit,stronghold'], {
    cwd: DAEMON, env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: CLOG, ND_EYES_NEED: '10' },
    stdio: 'ignore', windowsHide: true
  })
  child.on('exit', code => { exited = code })
  fs.writeFileSync(OUT.replace(/\.jsonl$/, '.pids.json'), JSON.stringify({ scene: process.pid, campaign: child.pid }))
  while (Date.now() - t0 < MAX_MINUTES * 60000) {
    await sleep(10000)
    const s = (await call('status')).state || {} as Record<string, any>
    const m = readMemory()
    const deaths = (m.deaths || []).filter(d => !baselineDeaths.has(d.at))
    const distance = far(s)
    if (distance < bestFar - 10) { bestFar = distance; lastProgress = Date.now() }
    const row = { at: new Date().toISOString(), minutes: +((Date.now() - t0) / 60000).toFixed(2), pos: s.pos, health: s.health, food: s.food,
      busy: s.busy, lastDeathAt: s.lastDeathAt, deaths: deaths.map(({ at, pos, cause }: any) => ({ at, pos, cause })), distance: Math.round(distance),
      picks: Object.entries<any>(s.inventory || {} as Record<string, any>).filter(([k]: any) => /_pickaxe$/.test(k)), room: m.places?.['портал в Край'] || null }
    fs.appendFileSync(TRACE, JSON.stringify(row) + '\n')
    console.log(JSON.stringify(row))
    const text = readText()
    if (deaths.length) { reason = 'смерть по durable журналу'; break }
    if (/ВЕХА stronghold/.test(text)) { reason = 'комната найдена'; break }
    if (/БЛОКЕР/.test(text)) { reason = (text.match(/БЛОКЕР[^\n]{0,180}/) || ['БЛОКЕР'])[0]; break }
    if (exited !== null) { reason = `кампания вышла (${exited})`; break }
    if (!checked && Date.now() - t0 >= CHECK_MINUTES * 60000) {
      checked = true
      const progress = Math.round(initialFar - bestFar)
      console.log(JSON.stringify({ checkpoint: true, minutes: CHECK_MINUTES, progress, distance: Math.round(distance) }))
      if (progress < 250) { reason = `диагностика: лишь ${progress} блоков полезного движения за ${CHECK_MINUTES} минут`; break }
    }
    if (distance > 200 && Date.now() - lastProgress > 240000) { reason = '4 минуты без приближения к крепости'; break }
  }
  if (exited === null) { child.kill(); await sleep(500) }
  await call('stop').catch(() => {})
  await sleep(1000)
  const state = (await call('status')).state || {} as Record<string, any>
  const after = readMemory()
  const newDeaths = (after.deaths || []).filter(d => !baselineDeaths.has(d.at)).map(({ at, pos, cause }: any) => ({ at, pos, cause }))
  const rec = { at: new Date().toISOString(), minutes: +((Date.now() - t0) / 60000).toFixed(2), reason,
    initialDistance: Math.round(initialFar), bestDistance: Math.round(bestFar), finalDistance: Math.round(far(state)),
    pos: state.pos, health: state.health, food: state.food, inventory: state.inventory, lastDeathAt: state.lastDeathAt,
    deaths: newDeaths, places: Object.fromEntries(Object.entries<any>(after.places || {} as Record<string, any>).filter(([k]: any) => /Край|крепость|кровать/.test(k))),
    milestone: /ВЕХА stronghold/.test(readText()), campaignLog: CLOG }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  await call('disconnect', { reason: 'ферма: опыт дороги завершён' })
  conn.close()
}
main().then(() => process.exit(0)).catch(async e => {
  console.error(e.stack || e)
  if (child && exited === null) child.kill()
  await call('stop').catch(() => {})
  await call('disconnect', { reason: 'ферма: ошибка опыта дороги' }).catch(() => {})
  conn.close()
  process.exit(1)
})
