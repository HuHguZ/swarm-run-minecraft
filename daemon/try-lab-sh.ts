'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория дороги к крепости основного прогона: копия мира server-run (farm/pristine-run) и его память
// (MEMORY=memory-run/state.json: крепость -400,30,1776, портал), тело у портала верхнего мира с 10 очами и
// набором на дракона. campaign.js полным порядком: endkit (если чего-то не хватает) → stronghold. Успех —
// найдена комната портала (ВЕХА stronghold или начало этапа dragon). Итог — строка JSON в LAB_OUT.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… node try-lab-sh.js   MINUTES=120
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-chain.jsonl')
const MINUTES = Number(process.env.MINUTES || 120)
const EYES = Number(process.env.EYES || 10)
// Рюкзак основного тела (server-run playerdata 30.09, 01:5x): прочность — как у него.
const KIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots',
  'iron_pickaxe[damage=100]', 'stone_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'bow', 'arrow 64', 'ender_eye 10',
  'cooked_beef 32', 'golden_apple 2', 'cobblestone 128', 'water_bucket', 'water_bucket', 'white_bed 6', 'crafting_table',
  'oak_planks 16', 'stick 8', 'torch 16', 'flint_and_steel', 'obsidian 5', 'blaze_rod 2']

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
const cnt = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)

async function scene () {
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'true') // как на server-run
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  for (const g of KIT) {
    const [item, n] = g.split(' ')
    await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`)
  }
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  await kit.cmd('/execute in minecraft:overworld run tp @s -19.5 65 -22.5')
  await kit.ensureWorld('overworld')
  await sleep(1500)
  await call('armor', {} as Record<string, any>)
}

async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {} as Record<string, any>).catch(() => null)
    const inv = st && st.state && st.state.inventory
    if (inv && Object.keys(inv).length) return st.state
    await sleep(1500)
  }
  return {} as Record<string, any>
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  await scene()
  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const child = spawn(process.execPath, ['campaign.js'], {
    cwd: __dirname,
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ND_EYES_NEED: String(EYES) },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  let stoppedBy = 'время'
  let best = { eyes: 0, pearls: 0 }
  const until = t0 + MINUTES * 60000
  let lastCheck = 0
  while (gameClock.now() < until) {
    await sleep(5000)
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    if (deathLines(size).length >= 3) { stoppedBy = 'три смерти'; break }
    if (gameClock.now() - lastCheck > 30000) {
      lastCheck = gameClock.now()
      const s = await status()
      const eyes = cnt(s.inventory, /^ender_eye$/); const pearls = cnt(s.inventory, /^ender_pearl$/)
      if (eyes > best.eyes || pearls > best.pearls) best = { eyes: Math.max(eyes, best.eyes), pearls: Math.max(pearls, best.pearls) }
    }
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (/БЛОКЕР/.test(text)) { stoppedBy = (text.match(/БЛОКЕР[^\n]{0,120}/) || ['БЛОКЕР'])[0]; break }
    if (/ВЕХА stronghold|dragon\s+ход 1/.test(text)) { stoppedBy = 'крепость найдена'; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  try { await call('stop') } catch {}
  await sleep(1500)
  const s = await status()
  const inv = s.inventory || {} as Record<string, any>
  let text = ''
  try { text = fs.readFileSync(clog, 'utf8') } catch {}
  const miles = [...text.matchAll(/ВЕХА (\S+): готово в (\S+), (\d+) мин/g)].map(m => `${m[1]}@${m[3]}м`)
  const rec = {
    at: new Date().toISOString(),
    minutes: Math.round((gameClock.now() - t0) / 6000) / 10,
    stoppedBy,
    eyes: cnt(inv, /^ender_eye$/),
    pearls: cnt(inv, /^ender_pearl$/),
    best,
    ingots: cnt(inv, /^gold_ingot$/) + 9 * cnt(inv, /^gold_block$/),
    ironPick: cnt(inv, /^(iron|diamond)_pickaxe$/),
    stonePicks: cnt(inv, /^stone_pickaxe$/),
    rods: cnt(inv, /^blaze_rod$/),
    food: s.food,
    deaths: deathLines(size),
    miles,
    tail: text.split('\n').filter(l => /бастион|выработан|жемчуг|БЛОКЕР|штрек|ВЕХА|умер|эндермен|pearls|iron/.test(l)).slice(-14).map(l => l.slice(0, 240))
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
