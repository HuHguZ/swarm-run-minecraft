'use strict'
// Лаборатория цепочки основного прогона: копия мира server-run (farm/pristine-run) и его память
// (MEMORY=memory-run/state.json в bastion-cycle2.sh), тело в Аду там, где стоит основное (61,43,9), с
// его рюкзаком: 5 каменных кирок, без железной, еды мало, 7 стержней. Дальше — campaign.js полным
// порядком этапов с эндерменами на добор (ND_ENDERMEN=1): железо → бастион 1 → штрек → бастион 2 →
// добор эндерменами → очи. Успех — очей ≥ EYES (10). Итог попытки — строка JSON в LAB_OUT.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… node try-lab-chain.js   MINUTES=150 EYES=10
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-chain.jsonl')
const MINUTES = Number(process.env.MINUTES || 150)
const EYES = Number(process.env.EYES || 10)
// Рюкзак основного тела (server-run playerdata 30.09, 01:5x): прочность — как у него.
const KIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots',
  'stone_pickaxe[damage=23]', 'stone_pickaxe[damage=51]', 'stone_pickaxe[damage=121]', 'stone_pickaxe', 'stone_pickaxe',
  'netherrack 21', 'cooked_porkchop 2', 'oak_planks 15', 'warped_wart_block 3', 'crafting_table', 'torch 9', 'feather', 'shield',
  'cobblestone 49', 'apple', 'white_wool 2', 'iron_sword[damage=174]', 'arrow 19', 'flint_and_steel', 'obsidian', 'string 2', 'stick 5',
  'brown_mushroom 3', 'bowl', 'bow[damage=235]', 'iron_nugget 7', 'water_bucket', 'gray_wool', 'cooked_mutton', 'flint 4', 'furnace',
  'cooked_rabbit', 'raw_iron 2', 'blaze_rod 7', 'melon_slice 2', 'mossy_cobblestone']

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
const cnt = (inv, re) => Object.entries(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)

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
  await kit.cmd('/execute in minecraft:the_nether run tp @s 61.5 43 9.5')
  await kit.ensureWorld('the_nether')
  await sleep(1500)
  await call('armor', {})
}

async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {}).catch(() => null)
    const inv = st && st.state && st.state.inventory
    if (inv && Object.keys(inv).length) return st.state
    await sleep(1500)
  }
  return {}
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = Date.now()
  await scene()
  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const child = spawn(process.execPath, ['campaign.js'], {
    cwd: __dirname,
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ND_EYES_NEED: String(EYES), ND_ENDERMEN: '1' },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  let stoppedBy = 'время'
  let best = { eyes: 0, pearls: 0 }
  const until = t0 + MINUTES * 60000
  let lastCheck = 0
  while (Date.now() < until) {
    await sleep(5000)
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    if (deathLines(size).length >= 3) { stoppedBy = 'три смерти'; break }
    if (Date.now() - lastCheck > 30000) {
      lastCheck = Date.now()
      const s = await status()
      const eyes = cnt(s.inventory, /^ender_eye$/); const pearls = cnt(s.inventory, /^ender_pearl$/)
      if (eyes > best.eyes || pearls > best.pearls) best = { eyes: Math.max(eyes, best.eyes), pearls: Math.max(pearls, best.pearls) }
      if (eyes >= EYES) { stoppedBy = `очей ${eyes} — цепочка пройдена`; break }
    }
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (/БЛОКЕР/.test(text)) { stoppedBy = (text.match(/БЛОКЕР[^\n]{0,120}/) || ['БЛОКЕР'])[0]; break }
    // Дальше очей (набор на дракона, крепость) — уже не цепочка.
    if (/(endkit|stronghold)\s+ход 1/.test(text)) { stoppedBy = 'дошла до endkit/stronghold'; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  try { await call('stop') } catch {}
  await sleep(1500)
  const s = await status()
  const inv = s.inventory || {}
  let text = ''
  try { text = fs.readFileSync(clog, 'utf8') } catch {}
  const miles = [...text.matchAll(/ВЕХА (\S+): готово в (\S+), (\d+) мин/g)].map(m => `${m[1]}@${m[3]}м`)
  const rec = {
    at: new Date().toISOString(),
    minutes: Math.round((Date.now() - t0) / 6000) / 10,
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
