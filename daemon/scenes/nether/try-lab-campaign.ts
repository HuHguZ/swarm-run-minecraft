'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Лаборатория кампании: этап bastion настоящим campaign.js (как в прохождении) — бастионы по памяти по
// порядку, тело в Аду у 52,8 (где стоит основное), набор кампании + 7 стержней. Сцена только ставит тело
// и места (ND_EXTRA_PLACES), дальше решает кампания. Итог попытки (строка JSON в LAB_OUT): жемчуг,
// смерти, минуты, чем кончилось.
//
//   ND_WS=ws://127.0.0.1:8801 MC_USERNAME=NeuroFarm1 ND_SERVER_LOG=… LAB_OUT=… node try-lab-campaign.js
//   SPREAD="52 8"  MINUTES=55  EYES=10  BASTIONS="105,43,87;672,45,272"
import * as fs from 'fs'
import path = require('path')
import { spawn } from 'child_process'
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-campaign.jsonl')
const MINUTES = Number(process.env.MINUTES || 55)
// Набор — как у основного тела (server-run, playerdata 30.09: железные шлем/нагрудник/поножи, золотые
// ботинки, 5 каменных кирок, меч, лук, 19 стрел, щит, верстак, 49 булыжника, 15 досок, 5 палок, 7 стержней,
// еды мало) + одна железная кирка (золотые блоки ломает только железо; основному её ещё добыть).
// KIT=full — прежний щедрый набор.
const KIT = process.env.KIT === 'full'
  ? ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'shield', 'iron_pickaxe 2', 'bow', 'arrow 64', 'cooked_beef 24', 'cobblestone 64', 'blaze_rod 7']
  : ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'iron_sword', 'shield', 'iron_pickaxe', 'stone_pickaxe 5', 'bow', 'arrow 19',
      'crafting_table', 'cobblestone 49', 'oak_planks 15', 'stick 5', 'netherrack 21', 'blaze_rod 7', 'cooked_porkchop 2', 'apple', 'cooked_mutton',
      'cooked_rabbit', 'melon_slice 2', 'flint_and_steel', 'water_bucket']
const BASTIONS = (process.env.BASTIONS || '105,43,87;672,45,272').split(';').map(s => s.split(',').map(Number))

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
function deathLines (from) {
  try {
    const buf = fs.readFileSync(LOG, 'utf8').slice(from)
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in|advancement/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const countOf = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)

async function scene () {
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'true') // как на server-run
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${process.env.SPREAD || '52 8'} 0 8 under 50 false @s`, { reply: /Spread|Could not/, ms: 30000 })
  await kit.ensureWorld('the_nether')
  await sleep(1500)
  await call('armor', {} as Record<string, any>)
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  await scene()
  const size = logSize()
  const places = {
    портал: { x: -19, y: 65, z: -24, dimension: 'overworld' },
    'портал (ад)': { x: 3, y: 69, z: 2, dimension: 'the_nether' },
    // Крепость известна (как в memory-run) — очей нужно 10, а не 12.
    крепость: { x: -400, y: 30, z: 1776, dimension: 'overworld', refined: true }
  }
  // Второй бастион — с местом обзора (вал виден с вышки): как в memory-run.
  const VANT = { '672,45,272': { x: 642, y: 59, z: 269 }, '105,43,87': { x: 104, y: 43, z: 96 } }
  // Путь по суше к первому (вокруг лавовое море y 31; scratchpad lavamap.js) — как в memory-run.
  // Путь-«route» по точкам вёл через лавовое море (pit-v6 30.09: 13 смертей из 13) — не задаём.
  const ROUTE: Record<string, any> = {} as Record<string, any>
  BASTIONS.forEach(([x, y, z]: any, i) => { const k = `${x},${y},${z}`; places[i ? `бастион ${i + 1} (ад)` : 'бастион (ад)'] = { x, y, z, dimension: 'the_nether', ...(VANT[k] ? { vantage: VANT[k] } : {} as Record<string, any>), ...(ROUTE[k] ? { route: ROUTE[k] } : {} as Record<string, any>) } })
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const child = spawn(process.execPath, ['campaign.js', 'bastion'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ND_EYES_NEED: String(process.env.EYES || 10), ND_EXTRA_PLACES: JSON.stringify(places) },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  let stoppedBy = 'время'
  const until = t0 + MINUTES * 60000
  while (gameClock.now() < until) {
    await sleep(5000)
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    // Этап бастиона кончился: дальше кампания пошла бы домой — это уже не бастион.
    if (/в Аду делать нечего|БЛОКЕР|все известные бастионы выработаны/.test(text)) { stoppedBy = (text.match(/в Аду делать нечего|БЛОКЕР[^\n]{0,80}|все известные бастионы выработаны/) || [''])[0]; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  try { await call('stop') } catch {}
  await sleep(1000)
  let inv: Record<string, any> = {} as Record<string, any>
  for (let i = 0; i < 3 && !Object.keys(inv).length; i++) {
    const st = await call('status', {} as Record<string, any>).catch(() => ({} as Record<string, any>))
    inv = (st && st.state && st.state.inventory) || {} as Record<string, any>
    if (!Object.keys(inv).length) await sleep(2000)
  }
  let text = ''
  try { text = fs.readFileSync(clog, 'utf8') } catch {}
  const deaths = deathLines(size)
  const rec = {
    at: new Date().toISOString(),
    minutes: Math.round((gameClock.now() - t0) / 6000) / 10,
    stoppedBy,
    pearls: countOf(inv, /^ender_pearl$/),
    eyes: countOf(inv, /^ender_eye$/),
    ingots: countOf(inv, /^gold_ingot$/),
    goldBlocks: countOf(inv, /^gold_block$/),
    rods: countOf(inv, /^blaze_rod$/),
    deaths: deaths.filter(l => /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up/.test(l)),
    bastionLines: text.split('\n').filter(l => /бастион|выработан|жемчуг|БЛОКЕР/.test(l)).slice(-12).map(l => l.slice(0, 300))
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
