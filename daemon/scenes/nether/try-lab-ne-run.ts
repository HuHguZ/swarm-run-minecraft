'use strict'
const { REPO_ROOT }: typeof import('../../src/paths') = require('../../src/paths')
const gameClock: typeof import('../../src/game-clock') = require('../../src/game-clock')
// Сквозная лаборатория потока nether-end: «вход в Ад → вход в Энд» на новом мире (farm.js up N --fresh --random или
// --seeds). Подготовка — только до входа в Ад (ферма, команды): /random reset, выживание, normal, keep_inventory, набор
// «как после верхнего мира» (KIT=std|light), утро. Портал верхнего мира тело строит само (RPC portal из 10 обсидиана в
// рюкзаке), ставит кровать у портала (точка возрождения, как этап prep) и входит в Ад. С этой секунды — часы и
// campaign.js полным порядком этапов, без команд. /locate (бастион, крепость Ада, крепость Края) — только в итог
// сцены для разбора, телу и кампании не передаётся.
//
// Nether PASS (раунд 06.10) — netherPass в итоге: тело живо, без смертей снова в верхнем мире, в рюкзаке жемчуг и стержни на
// EYES очей (nether-progress.netherGoalMet). UNTIL=nether — на нём сцена и кончается (ok = netherPass).
// Успех — тело в Крае (status.dimension = the_end). Провал — кампания вышла, БЛОКЕР, ≥ DEATHS_MAX смертей, MINUTES.
// Итог — строка JSON в LAB_OUT: ok, минуты от входа в Ад, ВЕХИ, смерти, золото/жемчуг/стержни, бастионы, рюкзак.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… node try-lab-ne-run.js   KIT=std MINUTES=120
//   ENDERMEN=1 (по умолчанию: добор эндерменами после всех бастионов — правило пользователя), EYES — ND_EYES_NEED.
//   CAMPAIGN=campaign.js — какой файл кампании (снимок для A/B). CENV='{"ND_X":"1"}' — env кампании.
//   ENDKIT=1 — с набором на дракона; по умолчанию ND_ENDKIT=0 (набор — поток дракона, здесь меряем Ад → Энд).
//   MAP=1 — знание карты Ада «из копии этого же мира» (как у основного тела, AGENTS.md): бастионы с золотом и сундуками,
//   крепость и спавнер — в память тела (fortress mode=map) до старта часов; снимает try-lab-ne-map.js с правды фермы.
//   MAP_BASTIONS=2 — сколько ближних бастионов дать (порядок: сокровищница последней).
//   UNTIL=rods (поток blz, 21.10) — кусок «вход в Ад → стержни на EYES очей → живой наверху» (с STAGES=nether: после стержней
//   кампания сама идёт домой через портал и кончает запуск); ok = стержней ≥ ⌈EYES/2⌉, ни одной смерти, тело в верхнем мире.
//   STAGES=nether — только эти этапы кампании (кусок «крепость» от портала); KIT=post — std + то, что даёт бартер моста
//   (лук, 64 стрелы, 3 зелья огнестойкости, 11 жемчуга) — набор «после бастиона».
//   REUSE_ENTRY=1 — подготовка повторного мира у фактического портала памяти; ROUTE_DIAGNOSTIC=1 — один ход к бастиону, 240 с.
const fs: typeof import('fs') = require('fs')
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const path: typeof import('path') = require('path')
const { spawn, execFileSync }: typeof import('child_process') = require('child_process')
const { connect, createKit, sleep, classify, campaignFacts }: typeof import('../lib/scene-kit') = require('../lib/scene-kit')
const { farmBootstrap }: typeof import('../lib/farm-bootstrap') = require('../lib/farm-bootstrap')
const { deathFreeEnd, netherPass, bastionMetrics, explicitBarterMetrics }: typeof import('../../src/campaign/nether-progress') = require('../../src/campaign/nether-progress')
const { netherToolsReady }: typeof import('../../src/campaign/nether-supply') = require('../../src/campaign/nether-supply')
const { prepareOverworldEntry, confirmSurvivalReadiness, cleanupPreparationThreats, entryDied }: typeof import('../lib/scene-nether-entry') = require('../lib/scene-nether-entry')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-ne-run.jsonl')
const MINUTES = Number(process.env.MINUTES || 120)
const DEATHS_MAX = Number(process.env.DEATHS_MAX || (KEEPINV === 'false' ? 1 : 5))
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const KIT_NAME = process.env.KIT || 'std'
const ENDERMEN = process.env.ENDERMEN ?? '1'
const PEARLS_NEED = Number(process.env.PEARLS || 12)
let CENV: Record<string, any> = {} as Record<string, any>
try { CENV = JSON.parse(process.env.CENV || '{}') } catch {}

// Наборы «на входе в Ад». std — то, что требуют ворота кампании (READY.bastion, fightReady), light — как у
// fresh-A5 слот 9 (вход на 57-й мин): кирки, меч, вёдра, огниво, мало еды, блоки, без брони.
// s1 06.10: +4 бревна (16 досок) в std/post — потеря верстака (actions.reclaimTable «подобрать не успел») и ворота дерева гоняли тело
// наверх (s1-full47: 2 поездки за деревом, на равнине у портала брёвен нет, 25+ игр. мин).
const KITS = {
  std: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'oak_log 4', 'stick 8', 'white_bed', 'obsidian 10', 'iron_ingot 2'],
  post: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'oak_log 4', 'stick 8', 'white_bed', 'obsidian 10', 'iron_ingot 2',
    'bow', 'spectral_arrow 64', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 3', 'ender_pearl 13', 'string 12'],
  // postnofr — post без огнестойкости: бой у спавнера без зелий (s1c 06.10: огнестойкость — цена, не допуск). Жемчуг 13 — на 12
  // пустых рамок (MAP_SH need 12 у 7 из 8 сидов) с запасом 1.
  postnofr: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'oak_log 4', 'stick 8', 'white_bed', 'obsidian 10', 'iron_ingot 2',
    'bow', 'spectral_arrow 64', 'ender_pearl 13', 'string 12'],
  light: ['iron_pickaxe', 'stone_pickaxe 2', 'iron_sword', 'water_bucket', 'bucket', 'flint_and_steel',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    'white_bed', 'obsidian 10', 'iron_ingot 2'],
  // lightshield — light после enterNether кампании (campaign.ts: щит из слитка и досок верхнего мира перед входом, f4c89aa):
  // щит вместо одного слитка, доски Ада целы (агент Ада 14.10).
  lightshield: ['iron_pickaxe', 'stone_pickaxe 2', 'iron_sword', 'shield', 'water_bucket', 'bucket', 'flint_and_steel',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    'white_bed', 'obsidian 10', 'iron_ingot 1'],
  // lsgold — lightshield + золотые ботинки (сундук руин портала верхнего мира: золотая броня в ~60 % сундуков, loot_table
  // chests/ruined_portal 4–8 бросков, 60/398 на бросок) — мерка цены золота на входе.
  lsgold: ['iron_pickaxe', 'stone_pickaxe 2', 'iron_sword', 'shield', 'golden_boots', 'water_bucket', 'bucket', 'flint_and_steel',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    'white_bed', 'obsidian 10', 'iron_ingot 1'],
  // contract — набор на входе по договору с агентом построек (координатор 14.10): ведро, огниво, 2 кирки, меч, щит, жареная еда,
  // 64 булыжника, верстак; contractgold — то же с золотыми ботинками из построек верхнего мира. Досок и палок нет.
  contract: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'cooked_mutton 8',
    'cobblestone 64', 'crafting_table'],
  contractgold: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'golden_boots',
    'cooked_mutton 8', 'cobblestone 64', 'crafting_table'],
  // contractgoldfr — то же + 2 зелья огнестойкости (бартер бастиона удался — FR бонус): мерка остального куска крепости (поиск, подход,
  // возврат), когда бой у спавнера идёт с FR (поток blz 21.10: с FR 7 стержней за 88 с, без — 0 из 33 сцен).
  contractgoldfr: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'golden_boots',
    'cooked_mutton 8', 'cobblestone 64', 'crafting_table', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 2'],
  // contractgoldfrst — contractgoldfr + 4 палки (2 доски верхнего мира): 2 каменные кирки из булыжника набора (+262 взмаха) — мерка
  // цены «кирки кончились» в поиске крепости (blz 21.10: кирки съедены в 5 из 9 провалов bz09/bz11).
  contractgoldfrst: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'golden_boots',
    'cooked_mutton 8', 'cobblestone 64', 'crafting_table', 'stick 4', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 2'],
  // contractgoldfrst8 — то же с 8 палками: ND_OW_NETHER_STICKS (по умолчанию с 21.10 06:30, speedrun-defaults) кладёт в набор Ада 8 палок
  // (1 бревно) — 4 каменные кирки из булыжника набора (blz 21.10).
  contractgoldfrst8: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'golden_boots',
    'cooked_mutton 8', 'cobblestone 64', 'crafting_table', 'stick 8', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 2'],
  // postbastion / postbastion2 — настоящий вход в Ад полного прохода (координатор 21.10, int7-s20-1: ведро воды, каменные кирка/топор/меч,
  // огниво, булыжник 107, палки 11, еда 8, верстак) после бастиона ne: + золотые ботинки и 1 или 2 зелья FR с бартера. Без железа и щита.
  // Каменных кирок 2: сцена требует на входе ≥ 260 взмахов (netherToolsReady), одна каменная — 131.
  postbastion: ['water_bucket', 'flint_and_steel', 'stone_pickaxe 2', 'stone_axe', 'stone_sword', 'cobblestone 107', 'stick 11', 'cooked_mutton 8',
    'crafting_table', 'golden_boots', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 1'],
  postbastion2: ['water_bucket', 'flint_and_steel', 'stone_pickaxe 2', 'stone_axe', 'stone_sword', 'cobblestone 107', 'stick 11', 'cooked_mutton 8',
    'crafting_table', 'golden_boots', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 2'],
  // postbastionsh — postbastion + щит (1 слиток + 6 досок верхнего мира, blz 21.10): цена щита в наборе против иссушителей и шаров.
  postbastionsh: ['water_bucket', 'flint_and_steel', 'stone_pickaxe 2', 'stone_axe', 'stone_sword', 'cobblestone 107', 'stick 11', 'cooked_mutton 8',
    'crafting_table', 'golden_boots', 'shield', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 1'],
  // contractarmor — contractgold + железные шлем и нагрудник (13 слитков верхнего мира), без FR: бой у спавнера в броне забега (blz 21.10).
  // entry / entryi — настоящий набор входа в Ад полного прохода (бриф sr27, поток bast 27.10): без золота, брони, щита и FR.
  // Каменных кирок 2 — ворота сцены netherToolsReady (260 взмахов); третья из булыжника и палок набора — дело кампании.
  // entryi — то же с железной киркой вместо одной каменной (ND_OW_KIT_PICK в умолчаниях: железная кирка при входе 6/6).
  entry: ['water_bucket', 'flint_and_steel', 'stone_pickaxe 2', 'stone_axe', 'stone_sword', 'cobblestone 107', 'stick 11', 'cooked_mutton 4',
    'crafting_table'],
  entryi: ['water_bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'cobblestone 107', 'stick 11',
    'cooked_mutton 4', 'crafting_table'],
  contractarmor: ['bucket', 'flint_and_steel', 'iron_pickaxe', 'stone_pickaxe', 'iron_sword', 'shield', 'golden_boots',
    'iron_helmet', 'iron_chestplate', 'cooked_mutton 8', 'cobblestone 64', 'crafting_table']
}
const KIT = KITS[KIT_NAME]
if (!KIT) { console.error(`KIT=${KIT_NAME}: жду ${Object.keys(KITS).join(', ')}`); process.exit(1) }

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
// Смерти с отметки — переживает полуночную перекладку latest.log (try-lab-ne-util.deaths, 03.10).
let _deathT = null
function deathLines (from) { if (!_deathT || _deathT.from !== from) _deathT = { from, f: (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).deaths(LOG, PLAYER, from) }; return _deathT.f() }
const cnt = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}

// Ожидания здесь — с потолком по стене: бот вне игры (смерть с «brain detached»), игровые часы стоят, и sleep(1500) по игровым
// часам не кончался — сцена висела 9+ мин и не видела смерти (s1c-B-5 06.10).
const wallCap = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, gameClock.wall.sleep(ms).then(() => null)])
async function status () {
  for (let i = 0; i < 3; i++) {
    const st: any = await wallCap(call('status', {} as Record<string, any>).catch(() => null), 10000)
    if (st && st.state && st.state.dimension) return st.state
    await Promise.race([sleep(1500), gameClock.wall.sleep(1500)])
  }
  return {} as Record<string, any>
}

// /locate для разбора — RCON слота (ответ locate не пишется в журнал сервера): «The nearest minecraft:x is at [x, ~, z] (N blocks away)».
function rcon (text) {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 90000 }) } catch (e) { return String(e.message) }
}
// /locate отвечает постройкой СВОЕГО региона сетки (кольцо 0), даже когда в соседнем ближе (ферма 02.10: от -22,-11 —
// «-336,-80, 321 бл.», а крепость 0,-96 в 88 бл.). Поэтому для сетки Ада (регион 432) — из центров 9 регионов вокруг и
// ближайшая к точке; крепость Края (кольца) — одним вызовом.
function locateOnce (what, dim, at) {
  const out = rcon(`execute in minecraft:${dim} positioned ${at.x} ${at.y ?? 70} ${at.z} run locate structure minecraft:${what}`)
  const m = /\[(-?\d+), [^,]+, (-?\d+)\] \((\d+) blocks/.exec(out)
  return m ? { x: Number(m[1]), z: Number(m[2]) } : null
}
function locate (what, dim, at) {
  const pts = dim === 'the_nether' ? [-1, 0, 1].flatMap(i => [-1, 0, 1].map(j => ({ x: (Math.floor(at.x / 432) + i) * 432 + 216, z: (Math.floor(at.z / 432) + j) * 432 + 216 }))) : [at]
  let best = null
  for (const p of pts) {
    const r = locateOnce(what, dim, p)
    if (!r) continue
    const dist = Math.round(Math.hypot(r.x - at.x, r.z - at.z))
    if (!best || dist < best.dist) best = { ...r, dist }
  }
  return best
}

let rngSalt = null
async function setup () {
  // Копии мира независимы только со своей солью ГСЧ (без соли бартер одинаков на каждой копии сида — разбор 06.10).
  rngSalt = await kit.randomReset()
  await kit.cmd('/gamemode creative')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', KEEPINV) // правило пользователя 02.10: боевой режим — false, смерть = провал
  // У Paper правила игры свои у каждого мира: из верхнего мира /gamerule не трогает Ад и Край (слот 26 02.10 умер в Аду
  // и потерял весь рюкзак при keep_inventory=true наверху).
  for (const d of ['the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
  for (const d of ['overworld', 'the_nether', 'the_end']) {
    await kit.must(`/execute in minecraft:${d} run gamerule spawn_mobs ${d === 'overworld' ? 'false' : 'true'}`,
      new RegExp(`^Gamerule spawn_mobs is now set to: ${d === 'overworld' ? 'false' : 'true'}$`), 'спавн подготовки ' + d)
    await kit.cmd(`/execute in minecraft:${d} run gamerule spawner_blocks_work true`)
  }
  await kit.must('/execute in minecraft:overworld run gamerule advance_time false', /^Gamerule advance_time is now set to: false$/, 'время OW во время подготовки')
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  for (const g of KIT) {
    const [item, n] = g.split(' ')
    await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`)
  }
  await sleep(1500)
  await call('armor', {} as Record<string, any>).catch(() => null)
}

// Сцена по фазам (прежнее тело main): подготовка тела и портала, карта и сетка копии мира, место входа и проверка готовности,
// вход в Ад, короткая диагностика маршрута, запуск и надзор кампании, итог. Прежние let тела main — поля объекта nr.
interface NeRun {
  t0: number; reuseEntry: any; pr: any; map: any; mapPlaces: any; shMap: any; gridInfo: any; preparedEntry: any
  releasedHold: Record<string, any> | null; preparedHealth: any; preparedSupply: any; size: number; viaTp: boolean; entry: any
  clog: string; tc: number; wallTc: number; startClock: any; child: any; exited: any; truth: any; stoppedBy: string; ok: boolean
  reachedAt: any; lastCheck: number; best: any; marks: Record<string, any>; mark: (k: string) => void; lastDim: string
  UNTIL_NETHER: boolean; eyesNeed: () => number; netherPassAt: any; until: number; wallSeen: { game: number; wall: number }
}

// Тело живо, творческий режим подготовки, место повторного мира, набор, портал верхнего мира.
async function nrBody (nr: NeRun) {
  await kit.cmd('/gamemode spectator')
  await kit.must('/gamemode creative', /^Set own game mode to Creative Mode$/, 'режим подготовки creative')
  const respawnDeadline = gameClock.wall.now() + 15000
  while ((await status()).health <= 0 && gameClock.wall.now() < respawnDeadline) await gameClock.wall.sleep(250)
  if (!((await status()).health > 0)) throw new Error('тело не возродилось до операторской подготовки')
  nr.reuseEntry = null
  if (process.env.REUSE_ENTRY === '1') {
    const slot = Number(process.env.FARM_SLOT)
    const connected = await call('status')
    if (!Number.isInteger(slot) || slot < 1 || slot > 32 || WS !== `ws://127.0.0.1:${8800 + slot}` ||
      connected.detail?.server !== `127.0.0.1:${25600 + slot}` || PLAYER !== `NeuroFarm${slot}`) throw new Error('REUSE_ENTRY — только подтверждённый слот фермы')
    const recall = await call('recall', { lines: 1 })
    const portal = recall.detail?.state?.places?.['портал']
    if (!portal || (portal.dimension || 'overworld') !== 'overworld' || ![portal.x, portal.y, portal.z].every(Number.isFinite)) {
      throw new Error('REUSE_ENTRY: фактического портала верхнего мира в памяти нет')
    }
    nr.reuseEntry = { x: portal.x, y: portal.y, z: portal.z, source: 'observed portal memory' }
    await kit.ensureWorld('overworld', { tp: `${Math.floor(portal.x) + 0.5} ${portal.y} ${Math.floor(portal.z) + 0.5}` })
  }
  await setup()
  // Портал верхнего мира — сам (этап portal кампании: тот же RPC), кровать у него — точка возрождения (этап prep).
  nr.pr = null
  const p0 = (await status()).pos || { x: 0, z: 0 }
  let moves = 0
  for (let k = 0; k < 5; k++) {
    nr.pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ status: 'failed', error: e.message }))
    const st = await status()
    console.log('портал подготовки, попытка', k + 1, JSON.stringify(nr.pr).slice(0, 240))
    if ((nr.pr.detail && nr.pr.detail.lit) || /горит/.test(JSON.stringify(nr.pr))) break
    if (st.dimension !== 'overworld') break
    // «Обсидиан принеси» (рама начата, обсидиан ушёл в неё/выпал: neF-B10f23-1 03.10) — подготовка: выдать ещё.
    if (/обсидиан принеси|нет обсидиана|не хватает обсидиана/.test(JSON.stringify(nr.pr))) { await kit.cmd('/give @s minecraft:obsidian 10'); await kit.cmd('/give @s minecraft:flint_and_steel'); await sleep(800); continue }
    // Место у спавна не годится под раму (лес, песок — bz01-s18-1 21.10: «портала с безопасным местом нет», сцена кончилась кодом 1) —
    // постановка: другое место на поверхности в 12 бл., как у try-lab-end.
    moves++
    console.log('портал подготовки не встал:', JSON.stringify(nr.pr).slice(0, 240), '— другое место')
    await kit.cmd(`/spreadplayers ${Math.round(p0.x + 12 * Math.sin(moves * 2.1))} ${Math.round(p0.z + 12 * Math.cos(moves * 2.1))} 0 4 false @s`)
    await sleep(2500)
    await kit.cmd('/give @s minecraft:obsidian 10'); await kit.cmd('/give @s minecraft:flint_and_steel'); await sleep(800)
  }
}

// Точка возрождения, карта Ада и крепости Края из копии мира, сетка маршрута — до входа.
async function nrMaps (nr: NeRun) {
  // Точка возрождения у портала — командой (этап prep ставит туда кровать; 02.10 кровать встала в проходе портала на
  // 2 слотах из 6, и enter не дошёл до порога — это отдельная беда bedtime.js, не этой сцены).
  await kit.cmd('/spawnpoint @s')
  // Карта Ада (MAP=1) — ДО входа, по оценке точки прибытия (портал/8): netherMap работает только через RCON, а тело,
  // ждущее 15–20 с у портала Ада, били и оно уходило обратно в портал (neF-Pa23-1 02.10: хп 20→13, наверху у
  // погасшего портала — кампания стартовала в верхнем мире).
  const sOw = await status()
  const est = sOw.pos ? { x: Math.floor(sOw.pos.x / 8), y: 70, z: Math.floor(sOw.pos.z / 8) } : null
  nr.map = null
  nr.mapPlaces = null
  if (process.env.MAP === '1' && est && process.env.FARM_SLOT) {
    const tm = gameClock.now()
    const m: Record<string, any> = await (require('../lib/try-lab-ne-map') as typeof import('../lib/try-lab-ne-map')).netherMap(Number(process.env.FARM_SLOT), est, { bastions: Number(process.env.MAP_BASTIONS || 2) }).catch(e => ({ error: e.message, places: {} as Record<string, any> }))
    nr.mapPlaces = m.places
    nr.map = { seconds: Math.round((gameClock.now() - tm) / 1000), est, error: m.error,
      bastions: (m.bastions || []).map(b => ({ x: b.x, z: b.z, dist: b.dist, type: b.type, gold: (b.gold || []).length, bb: b.bbAll || undefined })), fortressBB: (m.fortress && m.fortress.bbAll) || undefined,
      fortress: m.fortress ? { x: m.fortress.x, z: m.fortress.z, dist: m.fortress.dist, spawner: m.fortress.spawner } : null, route: m.route || null }
    // Искажённый лес — где в Аду эндермены (добор жемчуга после всех бастионов, правило пользователя): ближайший по копии мира
    // (/locate biome — знание карты из копии, как постройки; в главной метрике). WARPED=0 — не давать.
    // S1f: биомы (/locate biome) — знание уровня scan, в ssg не даём.
    if (process.env.WARPED !== '0' && (require('../../src/perception/knowledge') as typeof import('../../src/perception/knowledge')).allows('biomes', 'try-lab-ne-run WARPED')) {
      const out = rcon(`execute in minecraft:the_nether positioned ${est.x} 70 ${est.z} run locate biome minecraft:warped_forest`)
      const w = /\[(-?\d+), (-?\d+), (-?\d+)\] \((\d+) blocks/.exec(out)
      if (w) {
        nr.mapPlaces = { ...(nr.mapPlaces || {}), 'искажённый лес (ад)': { x: Number(w[1]), y: Number(w[2]), z: Number(w[3]), dimension: 'the_nether', note: 'по карте копии мира' } }
        nr.map.warped = { x: Number(w[1]), y: Number(w[2]), z: Number(w[3]), dist: Number(w[4]) }
      }
    }
    console.log('карта', JSON.stringify(nr.map))
    // Карта не прочиталась (s1c-D-1 06.10: крепость null, у всех бастионов золото 0, 2375 игр. с под нагрузкой фермы) — прогон без
    // карты не сравним с остальными: стоп подготовки (MAP_STRICT=0 — идти вслепую).
    if (process.env.MAP_STRICT !== '0' && !(nr.map.ssg = !!m.ssg) && (!nr.map.fortress || !(nr.map.bastions || []).some(b => b.gold > 0))) throw new Error('SETUP_FAIL: карта копии не прочиталась (крепость или золото бастионов)')
  }
  // MAP_SH=1 — и крепость Края из той же копии мира (комната портала, сколько рамок пусто): запись «крепость» у стены
  // комнаты (refined, без бросков find), очей нужно — по пустым рамкам (ND_EYES_NEED, если EYES не задан).
  nr.shMap = null
  if (process.env.MAP_SH === '1' && sOw.pos && process.env.FARM_SLOT) {
    const sm: Awaited<ReturnType<typeof import('../lib/try-lab-ne-map').strongholdMap>> = await (require('../lib/try-lab-ne-map') as typeof import('../lib/try-lab-ne-map')).strongholdMap(Number(process.env.FARM_SLOT), { x: Math.round(sOw.pos.x), z: Math.round(sOw.pos.z) }).catch(e => ({ error: e.message }))
    nr.shMap = { start: sm.start, room: sm.room && sm.room.center, frames: sm.frames, eyes: sm.eyes, need: sm.need, error: sm.error }
    if (sm.place) { nr.mapPlaces = { ...(nr.mapPlaces || {} as Record<string, any>), крепость: sm.place }; if (!nr.map) nr.map = {} as Record<string, any> }
    if (sm.need && !process.env.EYES) process.env.EYES = String(sm.need)
    console.log('крепость Края', JSON.stringify(nr.shMap))
  }
  // GRID=1 (при MAP=1) — сетка Ада по коридорам маршрута «из копии мира» (try-lab-ne-map.netherGrid): портал (оценка) →
  // бастион → спавнер → выход у крепости Края (/8), плюс коробки бастиона и крепости целиком. Тело ходит по ней
  // (nether-route, ND_NE_ROUTE=1 в CENV/окружении демона). Снимается до входа в Ад, как и карта.
  nr.gridInfo = null
  if (process.env.GRID === '1' && process.env.FARM_SLOT && est && nr.mapPlaces) {
    const tg = gameClock.wall.now()
    try {
      const M: typeof import('../lib/try-lab-ne-map') = require('../lib/try-lab-ne-map')
      const pts: { x: number; z: number; y?: number }[] = [est]
      const bs = (nr.map && nr.map.bastions) || []
      const keyB = nr.mapPlaces['бастион (ад)']
      if (keyB) pts.push({ x: keyB.x, z: keyB.z })
      const sp = nr.mapPlaces['спавнер блейзов']
      if (sp) pts.push({ x: sp.x, z: sp.z })
      if (nr.shMap && nr.shMap.room) pts.push({ x: Math.floor(nr.shMap.room.x / 8), z: Math.floor(nr.shMap.room.z / 8) })
      else if (nr.shMap && nr.shMap.start) pts.push({ x: Math.floor(nr.shMap.start.x / 8), z: Math.floor(nr.shMap.start.z / 8) })
      const rects = M.corridorRects(pts, 40)
      // Каждый выбранный бастион получает коридоры к первому и спавнеру.
      const keyB2 = nr.mapPlaces['бастион 2 (ад)']
      // NEAR_B2=1: бастион 2 вне сетки (дальше 350 от входа) телу не давать — от него к спавнеру ни сетки, ни пути (B2-30 03.10:
      // 13 жемчуга, ко второму за 400 бл., оттуда «путь длиной 0» ×35 к спавнеру в 563 бл., паузы, время).
      if (process.env.NEAR_B2 === '1' && keyB2 && Math.hypot(keyB2.x - est.x, keyB2.z - est.z) >= 350) { delete nr.mapPlaces['бастион 2 (ад)']; console.log('бастион 2 вне сетки — телу не даю', JSON.stringify({ x: keyB2.x, z: keyB2.z })) }
      if (keyB2 && nr.mapPlaces['бастион 2 (ад)'] && keyB) {
        rects.push(...M.corridorRects([{ x: keyB.x, z: keyB.z }, { x: keyB2.x, z: keyB2.z }], 40))
        if (sp) rects.push(...M.corridorRects([{ x: keyB2.x, z: keyB2.z }, { x: sp.x, z: sp.z }], 40))
      }
      // Коробки — только выбранного бастиона (его запись в памяти внутри коробки) и крепости; дальние бастионы карты —
      // нет (сетка 91 млн клеток на слоте 25 03.10 — память и время плана).
      const near = (bb, q) => q && q.x >= bb[0] - 16 && q.x <= bb[3] + 16 && q.z >= bb[2] - 16 && q.z <= bb[5] + 16
      const chosen = bs.filter(b => b.bb && (near(b.bb, nr.mapPlaces['бастион (ад)']) || near(b.bb, nr.mapPlaces['бастион 2 (ад)'])))
      for (const bb of [nr.map && nr.map.fortressBB, ...chosen.map(b => b.bb)].filter(Boolean)) rects.push([bb[0] - 8, bb[2] - 8, bb[3] + 8, bb[5] + 8])
      const r = await M.netherGrid(Number(process.env.FARM_SLOT), rects, {} as Record<string, any>)
      const NG: typeof import('../../src/nether-grid') = require('../../src/nether-grid')
      NG.save(path.join(REPO_ROOT, 'farm', `memory-${process.env.FARM_SLOT}`), r.grid, { pts, rects: rects.length })
      nr.gridInfo = { seconds: Math.round((gameClock.wall.now() - tg) / 1000), chunks: r.chunks, loaded: r.loaded, box: r.box, cells: r.grid.data.length, pts,
        bastions: chosen.map(b => ({ x: b.x, z: b.z, bb: b.bb })) }
    } catch (e) { nr.gridInfo = { error: e.message } }
    console.log('сетка', JSON.stringify(nr.gridInfo))
  }
}

// Место входа, живые правила, выживание, подтверждение здоровья и запаса.
async function nrEntry (nr: NeRun) {
  nr.preparedEntry = await prepareOverworldEntry({ call, state: status,
    now: () => gameClock.wall.now(), sleep: () => gameClock.wall.sleep(100),
    creative: async () => { await kit.cmd('/gamemode spectator'); await kit.must('/gamemode creative', /^Set own game mode to Creative Mode$/, 'creative перед возвратом к входу') },
    returnToOverworld: async point => { await kit.ensureWorld('overworld', { tp: `${point.x} ${point.y} ${point.z}` }) }
  })
  console.log('подготовленное место входа', JSON.stringify(nr.preparedEntry))
  const cleanedThreats = await cleanupPreparationThreats(nr.preparedEntry, async text => rcon(text))
  console.log('очистка только подготовительных OW угроз', JSON.stringify({ dimension: 'overworld', at: nr.preparedEntry, radius: 16, beforeMeasurement: true, receipts: cleanedThreats }))
  await kit.setDifficulty('normal')
  await kit.must('/time set 1000', /^Set the time to 1000$/, 'утро перед измерением')
  for (const d of ['overworld', 'the_nether', 'the_end']) {
    await kit.must(`/execute in minecraft:${d} run gamerule spawn_mobs true`, /^Gamerule spawn_mobs is now set to: true$/, 'живой спавн перед измерением ' + d)
    await kit.must(`/execute in minecraft:${d} run gamerule advance_time true`, /^Gamerule advance_time is now set to: true$/, 'обычное время перед измерением ' + d)
    await kit.must(`/execute in minecraft:${d} run gamerule spawner_blocks_work true`, /^Gamerule spawner_blocks_work is now set to: true$/, 'живые спавнеры перед измерением ' + d)
  }
  await kit.must('/gamemode survival', /^Set own game mode to Survival Mode$/, 'выживание перед измерением')
  // The ten fixture obsidian build the entrance; Creative preparation must not donate them to the measured Nether run.
  await kit.cmd('/clear @s minecraft:obsidian')
  let ready: Record<string, any> = {}
  const healthSamples = []
  const heardFrom = conn.heard.length
  const preparationHold = call('wait', { seconds: 300, holdPosition: true }).catch(error => ({ error: error.message }))
  nr.releasedHold = null
  try {
    nr.preparedHealth = await confirmSurvivalReadiness({
      now: () => gameClock.wall.now(), sleep: () => gameClock.wall.sleep(25),
      heal: async () => {
        await kit.cmd('/effect give @s minecraft:instant_health 1 10 true')
        await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
      },
      clearEffects: async () => { await kit.cmd('/effect clear @s') },
      sample: async () => {
        const native = rcon(`data get entity ${PLAYER} Health`)
        const health = /(-?\d+(?:\.\d+)?)f\b/.exec(native)
        if (!health) throw new Error('подготовка: native Health не подтверждён: ' + native.slice(-250))
        const response = await call('status', { physics: true })
        ready = response.state || {}
        const physics = response.detail?.physics
        const sample = { dimension: ready.dimension, health: Number(health[1]), food: ready.food,
          serverTicks: ready.clock?.serverTicks ?? null,
          safe: ready.tactics?.threatLevel < 2 && physics?.onGround === true &&
            !physics.isInWater && !physics.isInLava }
        if (healthSamples.length < 12) healthSamples.push({ ...sample, at: ready.pos, tactics: ready.tactics?.action })
        return sample
      }
    })
  } finally {
    await call('stop').catch(() => null)
    nr.releasedHold = await Promise.race([preparationHold, gameClock.wall.sleep(1500).then(() => null)])
    const afterHold = await status()
    console.log('освобождение управления подготовки', JSON.stringify({ receipt: nr.releasedHold, after: afterHold }))
    console.log('подтверждение здоровья подготовки', JSON.stringify({ samples: healthSamples,
      damage: conn.heard.slice(heardFrom).filter(event => event.type === 'damage' || event.type === 'death') }))
    if (!nr.releasedHold || afterHold.busy === 'hold_position') throw new Error('подготовка: ожидание позиции не завершилось после stop; вход не запускаю')
  }
  const supplyObservation = await call('situation')
  nr.preparedSupply = { dimension: ready.dimension, health: ready.health, inventory: ready.inventory || {},
    pickSwings: supplyObservation.detail?.pickLeft ?? 0 }
  if (!netherToolsReady(nr.preparedSupply)) throw new Error('фактический запас для входа в Ад не подтверждён: ' + JSON.stringify(nr.preparedSupply))
  console.log('подготовленный запас', JSON.stringify(nr.preparedSupply))
}

// Вход в Ад (до 3 попыток, телепорт в портал на подготовке); смерть или неудача — итог и выход.
async function nrEnter (nr: NeRun) {
  // Смерти считаются с этой точки (вход в Ад и всё после него).
  nr.size = logSize()
  await call('connect', { bootstrapPaused: false })
  let en = null
  const entryAttempts: Record<string, any>[] = []
  let s0: Record<string, any> = {} as Record<string, any>
  for (let k = 0; k < 3 && s0.dimension !== 'the_nether'; k++) {
    // Рама на месте, а портал погас (neF-R22/R26 02.10: «горящего портала в 16 блоках не вижу», рама из 10 обсидиана
    // цела) — поджечь заново (portal build поджигает готовую раму) и снова войти.
    if (k > 0) await call('portal', { timeoutSeconds: 120 }).catch(() => null)
    const before = await status()
    en = await call('portal', { mode: 'enter', timeoutSeconds: 180 }).catch(e => ({ status: 'failed', error: e.message }))
    for (let w = 0; w < 10; w++) { s0 = await status(); if (s0.dimension === 'the_nether' || entryDied(s0, en, deathLines(nr.size).length)) break; await sleep(1000) }
    const attempt = { attempt: k + 1, before, receipt: en, after: s0 }
    entryAttempts.push(attempt)
    console.log('фактический вход через портал', JSON.stringify(attempt))
    if (entryDied(s0, en, deathLines(nr.size).length)) break
  }
  // Портал горит, а войти тело не смогло (рама на круче, у нижнего ряда негде встать: neF-A0f22-1 03.10) — подготовка
  // ещё не мерится: тело в клетку портала командой (ферма).
  nr.viaTp = false
  if (!entryDied(s0, en, deathLines(nr.size).length) && s0.dimension !== 'the_nether' && nr.pr && nr.pr.detail && nr.pr.detail.inner) {
    nr.viaTp = await (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).portalTp(kit, status, nr.pr.detail.inner, call)
    if (nr.viaTp) s0 = await status()
  }
  const entryDeaths = deathLines(nr.size)
  const diedEntering = entryDied(s0, en, entryDeaths.length)
  if (diedEntering || s0.dimension !== 'the_nether' || !(s0.health > 0)) {
    const rec: Record<string, any> = { at: new Date().toISOString(), seed: seedOf(), kit: KIT_NAME, ok: false, setupFail: !diedEntering, stoppedBy: diedEntering ? 'смерть при входе в Ад' : 'в Ад не вошёл живым на подготовке', deathCount: Math.max(entryDeaths.length, diedEntering ? 1 : 0), deaths: entryDeaths, hp: s0.health, dimension: s0.dimension, portal: String(nr.pr && (nr.pr.error || (nr.pr.detail && nr.pr.detail.note)) || '').slice(0, 200), enter: String(en && (en.error || (en.detail && (en.detail.note || en.detail.stopped))) || '').slice(0, 200), releasedHold: nr.releasedHold, entryAttempts }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(JSON.stringify(rec))
    try { await Promise.race([call('disconnect', { reason: 'сцена окончена' }), gameClock.wall.sleep(10000)]) } catch {}
    process.exit(0)
  }
  nr.entry = s0.pos ? { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) } : null
}

// Карта в память тела; ROUTE_DIAGNOSTIC — один ход к бастиону и выход.
async function nrDiagnostic (nr: NeRun) {
  if (nr.mapPlaces) {
    const w = await call('fortress', { mode: 'map', places: nr.mapPlaces, timeoutSeconds: 30 }).catch(e => ({ error: e.message }))
    nr.map.mapped = (w.detail && w.detail.mapped) || w.error || null
  }
  if (process.env.ROUTE_DIAGNOSTIC === '1') {
    const recalled = nr.mapPlaces || (await call('recall', { lines: 1 })).detail?.state?.places || {}
    const destination = recalled['бастион (ад)']
    if (!destination || ![destination.x, destination.y, destination.z].every(Number.isFinite)) throw new Error('route diagnostic: известной точки бастиона нет')
    const target = { x: destination.x, y: destination.y, z: destination.z }
    const started = gameClock.now()
    const timeoutSeconds = Math.max(60, Math.min(1800, Number(process.env.ROUTE_SECONDS) || 240))
    const maxPlans = Math.max(1, Math.min(24, Number(process.env.ROUTE_PLANS) || 8))
    const deadline = started + timeoutSeconds * 1000
    const attempts = []
    let route: Record<string, any> = {}
    while (gameClock.now() < deadline && attempts.length < 12) {
      route = await call('ne_route', { ...target, r: 2, dy: 1, timeoutSeconds: Math.max(1, (deadline - gameClock.now()) / 1000), maxPlans })
        .catch(error => ({ status: 'failed', error: error.message }))
      attempts.push({ status: route.status, code: route.code, detail: route.detail, events: route.events, at: route.state?.pos })
      if (route.by?.type !== 'tactical' && route.code !== 'TACTICAL') break
      let released = false
      while (gameClock.now() < deadline) {
        const live = await status()
        if (!(live.health > 0) || deathLines(nr.size).length > 0 || live.dimension !== 'the_nether') break
        const tactics = live.tactics
        if (tactics && tactics.threatLevel < 2 && tactics.owner !== 'Tactical' && tactics.owner !== 'Emergency') {
          await call('observe', { radius: 48 })
          const checked = await status()
          if (checked.tactics?.threatLevel < 2 && !checked.tactics?.requireObservation) { released = true; break }
        }
        await sleep(100)
      }
      if (!released) break
    }
    await call('stop')
    const final = await status()
    const deaths = deathLines(nr.size)
    const distance = final.pos ? Math.hypot(final.pos.x - target.x, final.pos.z - target.z) : null
    const result = { at: new Date().toISOString(), diagnostic: 'single native Nether route', worldState: 'reused', reuseEntry: nr.reuseEntry,
      seed: seedOf(), ok: route.detail?.ok === true && final.health > 0 && deaths.length === 0 && distance !== null && distance <= 3 && Math.abs(final.pos.y - target.y) <= 2,
      seconds: (gameClock.now() - started) / 1000, budget: { timeoutSeconds, maxPlans }, entry: nr.entry, target, distance, deathCount: deaths.length, deaths,
      hp: final.health, dimension: final.dimension, pos: final.pos, route, attempts, map: nr.map, grid: nr.gridInfo }
    fs.appendFileSync(OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify(result))
    try { await Promise.race([call('disconnect', { reason: 'короткая диагностика маршрута окончена' }), gameClock.wall.sleep(10000)]) } catch {}
    process.exit(0)
  }
}

// Запуск кампании и правда для разбора (после старта: тело не ждёт RCON у портала).
async function nrStart (nr: NeRun) {
  nr.clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(nr.clog, '') } catch {}
  nr.tc = gameClock.now()
  nr.wallTc = gameClock.wall.now()
  nr.startClock = gameClock.snapshot()
  nr.child = spawn(process.execPath, [CAMPAIGN, ...(process.env.STAGES ? [process.env.STAGES] : [])], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: nr.clog, ...(ENDERMEN === '1' ? { ND_ENDERMEN: '1' } : {} as Record<string, any>), ...(process.env.ENDKIT === '1' ? {} as Record<string, any> : { ND_ENDKIT: '0' }), ND_WATCHDOG_MIN: String(MINUTES + 5), ...(process.env.EYES ? { ND_EYES_NEED: process.env.EYES } : {} as Record<string, any>), ...CENV },
    stdio: 'ignore'
  })
  nr.exited = null
  nr.child.on('exit', code => { nr.exited = code })
  // Правда для разбора (телу не передаётся) — уже после старта кампании: тело не ждёт RCON у портала.
  nr.truth = nr.entry ? {
    bastion: locate('bastion_remnant', 'the_nether', nr.entry),
    fortress: locate('fortress', 'the_nether', nr.entry),
    stronghold: locate('stronghold', 'overworld', { x: nr.entry.x * 8, z: nr.entry.z * 8 })
  } : null
  nr.stoppedBy = 'время'
  nr.ok = false
  nr.reachedAt = null
  nr.lastCheck = 0
  nr.best = { pearls: 0, eyes: 0, rods: 0, fireResistancePotions: 0, fireResistanceObserved: false }
  // Отметки кусков (минуты от входа в Ад): увидел крепость/бастион, золото, стержни, жемчуг, очи, выход наверх,
  // крепость Края, комната — по памяти тела и рюкзаку раз в 20 с.
  nr.marks = {} as Record<string, any>
  nr.mark = k => { if (nr.marks[k] == null) nr.marks[k] = Math.round((gameClock.now() - nr.tc) / 6000) / 10 }
  nr.lastDim = 'the_nether'
  nr.UNTIL_NETHER = process.env.UNTIL === 'nether'
  nr.eyesNeed = () => Math.max(1, Math.min(12, Number(process.env.EYES) || 12))
  nr.netherPassAt = null
  nr.until = nr.tc + MINUTES * 60000
  // Стража по РЕАЛЬНОМУ времени: бот выкинут с сервера (s1-full49 06.10: «Invalid move player packet» — часы демона встали,
  // sleep(5000) по игровым часам не кончался, сцена висела 4+ мин). Ни отклика status, ни хода игровых часов 90 с — стоп.
  nr.wallSeen = { game: gameClock.now(), wall: gameClock.wall.now() }
}

// Надзор: раз в 20 с — вехи по рюкзаку и памяти, Nether PASS, Энд; стоп по смертям, БЛОКЕРу, выходу кампании.
async function nrWatch (nr: NeRun) {
  while (gameClock.now() < nr.until) {
    await Promise.race([sleep(5000), gameClock.wall.sleep(15000)])
    if (gameClock.now() > nr.wallSeen.game) nr.wallSeen = { game: gameClock.now(), wall: gameClock.wall.now() }
    else if (gameClock.wall.now() - nr.wallSeen.wall > 90000) {
      const s = await Promise.race([status(), gameClock.wall.sleep(10000).then(() => ({} as Record<string, any>))])
      nr.stoppedBy = s.connected === false ? 'бот отключён от сервера' : 'игровые часы стоят 90 с реального времени'
      break
    }
    let text = ''
    try { text = fs.readFileSync(nr.clog, 'utf8') } catch {}
    if (gameClock.now() - nr.lastCheck > 20000 || nr.exited !== null) {
      nr.lastCheck = gameClock.now()
      const s = await status()
      const inv = s.inventory || {} as Record<string, any>
      nr.best = {
        pearls: Math.max(nr.best.pearls, cnt(inv, /^ender_pearl$/) + cnt(inv, /^ender_eye$/)),
        eyes: Math.max(nr.best.eyes, cnt(inv, /^ender_eye$/)),
        rods: Math.max(nr.best.rods, cnt(inv, /^blaze_rod$/) + Math.floor(cnt(inv, /^blaze_powder$/) / 2) + Math.floor(cnt(inv, /^ender_eye$/) / 2)),
        fireResistancePotions: Math.max(nr.best.fireResistancePotions, cnt(s.potions, /fire_resistance$/)),
        fireResistanceObserved: nr.best.fireResistanceObserved || s.fireResistance === true
      }
      if (cnt(inv, /^gold_block$/) || cnt(inv, /^gold_ingot$/) >= 9) nr.mark('gold')
      if (nr.best.rods >= 7) nr.mark('rods7')
      if (nr.best.rods >= Math.ceil(nr.eyesNeed() / 2)) nr.mark('rodsNeed')
      if (nr.best.pearls >= 10) nr.mark('pearls10')
      if (process.env.UNTIL === 'pearls' && nr.best.pearls >= PEARLS_NEED) { nr.mark('pearlsNeed'); nr.stoppedBy = 'жемчуг набран'; break }
      if (nr.best.eyes >= 10) nr.mark('eyes10')
      if (nr.best.fireResistancePotions > 0 || nr.best.fireResistanceObserved) nr.mark('fireResistance')
      if (s.dimension && s.dimension !== nr.lastDim) { nr.mark(nr.lastDim + '->' + s.dimension); nr.lastDim = s.dimension }
      const rc: any = await wallCap(call('recall', { lines: 1 }).catch(() => null), 10000)
      const pl = (rc && rc.detail && rc.detail.state && rc.detail.state.places) || {} as Record<string, any>
      if (pl['крепость (ад)']) nr.mark('fortressSeen')
      if (pl['бастион (ад)']) nr.mark('bastionSeen')
      if (pl['спавнер блейзов']) nr.mark('spawner')
      if (pl['крепость']) nr.mark('stronghold')
      if (pl['портал в Край']) nr.mark('room')
      if (nr.netherPassAt === null && netherPass({ dimension: s.dimension || null, health: s.health ?? 0, deaths: deathLines(nr.size).length, inventory: inv, eyesNeed: nr.eyesNeed() })) {
        nr.netherPassAt = Math.round((gameClock.now() - nr.tc) / 6000) / 10
        nr.mark('netherPass')
        if (nr.UNTIL_NETHER) { nr.stoppedBy = 'Nether PASS'; break }
      }
      if (s.dimension === 'the_end') {
        const deaths = deathLines(nr.size)
        nr.ok = deathFreeEnd({ reachedEnd: true, health: s.health ?? 0, deaths: deaths.length })
        nr.reachedAt = Math.round((gameClock.now() - nr.tc) / 6000) / 10
        nr.stoppedBy = nr.ok ? 'в Энде' : `смертей ${deaths.length}, здоровье ${s.health ?? 0}`
        break
      }
    }
    if (nr.exited !== null) { nr.stoppedBy = `кампания вышла (${nr.exited})`; break }
    const deaths = deathLines(nr.size)
    if (deaths.length >= DEATHS_MAX) { nr.stoppedBy = `смертей ${deaths.length}`; break }
    if (/БЛОКЕР/.test(text)) { nr.stoppedBy = (text.match(/БЛОКЕР[^\n]{0,160}/) || ['БЛОКЕР'])[0]; break }
  }
}

// Итог сцены: строка JSON в LAB_OUT.
async function nrFinish (nr: NeRun) {
  if (nr.exited === null) { try { nr.child.kill() } catch {} }
  // Бот вне игры — stop и пауза по игровым часам не кончаются (s1c-F-17 06.10: сцена висела 27 мин после выхода кампании).
  try { await wallCap(call('stop'), 10000) } catch {}
  await Promise.race([sleep(1500), gameClock.wall.sleep(1500)])
  let s = await status()
  // Кампания в конце сама отключает тело («кампания завершена — бот отключён») — итог читается по снова подключённому телу:
  // рюкзак и место хранит сервер (bz09-s17-1 21.10: 7 стержней дома, а итог «стержни 0», статус пуст).
  if (!s.dimension) {
    await wallCap(call('connect', { bootstrapPaused: true }).catch(() => null), 20000)
    for (let i = 0; i < 10 && !s.dimension; i++) { await gameClock.wall.sleep(500); s = await status() }
  }
  let text = ''
  try { text = fs.readFileSync(nr.clog, 'utf8') } catch {}
  const facts = campaignFacts(text)
  const inv = s.inventory || {} as Record<string, any>
  const deaths = deathLines(nr.size)
  nr.ok = deathFreeEnd({ reachedEnd: nr.ok, health: s.health ?? 0, deaths: deaths.length })
  // PASS — снимок в цикле (netherPassAt) и ни одной смерти до конца сцены; при UNTIL=nether ещё и итоговый снимок.
  const passFinal = netherPass({ dimension: s.dimension || null, health: s.health ?? 0, deaths: deaths.length, inventory: inv, eyesNeed: nr.eyesNeed() })
  const passNow = nr.netherPassAt !== null && deaths.length === 0 && (!nr.UNTIL_NETHER || passFinal)
  if (nr.UNTIL_NETHER) nr.ok = passNow
  // UNTIL=pearls (поток bast 27.10) — «вход в Ад → ≥ PEARLS жемчуга (или очей) живым», где бы ни был: ни одной смерти, тело живо.
  if (process.env.UNTIL === 'pearls') nr.ok = deaths.length === 0 && (s.health ?? 0) > 0 && nr.best.pearls >= PEARLS_NEED
  if (process.env.UNTIL === 'rods') nr.ok = deaths.length === 0 && (s.health ?? 0) > 0 && s.dimension === 'overworld' &&
    cnt(inv, /^blaze_rod$/) + Math.floor(cnt(inv, /^blaze_powder$/) / 2) >= Math.ceil(nr.eyesNeed() / 2)
  if (deaths.length) nr.stoppedBy = `смертей ${deaths.length}`
  const bastions = bastionMetrics(text)
  let explicitBarters = []
  try {
    const samples = fs.readFileSync(nr.clog.replace(/(\.campaign)?\.log$/, '') + '.skills.jsonl', 'utf8').split('\n')
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    explicitBarters = explicitBarterMetrics(samples)
  } catch {}
  const rec: Record<string, any> = {
    at: new Date().toISOString(),
    worldState: nr.reuseEntry ? 'reused' : 'fixture',
    reuseEntry: nr.reuseEntry,
    seed: seedOf(),
    kit: KIT_NAME,
    ok: nr.ok,
    minutes: Math.round((gameClock.now() - nr.tc) / 6000) / 10,
    wallSeconds: (gameClock.wall.now() - nr.wallTc) / 1000,
    health: typeof s.health === 'number' ? s.health : null,
    food: typeof s.food === 'number' ? s.food : null,
    inventory: inv,
    measuredClock: { start: nr.startClock, final: s.clock || gameClock.snapshot() },
    reachedAt: nr.reachedAt,
    netherPass: passNow,
    netherPassAt: nr.netherPassAt,
    rngSalt,
    stoppedBy: nr.stoppedBy,
    exitCode: nr.exited,
    deathCount: deaths.length,
    deaths,
    entry: nr.entry,
    truth: nr.truth,
    map: nr.map,
    shMap: nr.shMap,
    eyesNeed: nr.eyesNeed(),
    best: nr.best,
    marks: nr.marks,
    pearls: cnt(inv, /^ender_pearl$/),
    eyes: cnt(inv, /^ender_eye$/),
    rods: cnt(inv, /^blaze_rod$/),
    gold: cnt(inv, /^gold_ingot$/) + 9 * cnt(inv, /^gold_block$/),
    bastions,
    explicitBarters,
    ingotsTraded: [...bastions, ...explicitBarters].reduce((n, b) => n + (Number(b.ingots) || 0), 0),
    miles: facts.miles,
    lastStage: facts.lastStage,
    lastCodes: facts.codes.filter(c => c.code !== 'OK').slice(-5).map(c => `${c.method}:${c.code}@${c.minute}м`),
    dimension: s.dimension || null,
    pos: s.pos || null,
    bag: Object.entries<any>(inv).map(([k, v]: any) => `${k}×${v}`).join(' '),
    campaignLog: path.basename(nr.clog),
    setupSeconds: Math.round((nr.tc - nr.t0) / 1000),
    preparedSupply: nr.preparedSupply,
    preparedEntry: nr.preparedEntry,
    preparedHealth: nr.preparedHealth,
    viaTp: nr.viaTp,
    grid: nr.gridInfo
  }
  rec.class = classify({ ...rec, deathsMax: DEATHS_MAX }, text)
  rec.tail = text.split('\n').filter(l => /ВЕХА|БЛОКЕР|итог этапа|этап упал|умер|прогон упал|РИСК|сторож|нет доступного|выработан|стержней:|жемчуг:|бастион|крепост/.test(l)).slice(-16).map(l => l.slice(0, 220))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-run окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}

const NR_PHASES: ((nr: NeRun) => Promise<void>)[] = [nrBody, nrMaps, nrEntry, nrEnter, nrDiagnostic, nrStart, nrWatch, nrFinish]

async function main () {
  await conn.ready
  await farmBootstrap(call, WS, PLAYER)
  await call('stop')
  const t0 = gameClock.now()
  const nr = { t0 } as NeRun
  for (const phase of NR_PHASES) await phase(nr)
}
main().catch(async e => {
  console.error(e)
  try { await Promise.race([call('disconnect', { reason: 'try-lab-ne-run: подготовка или измерение прерваны' }), gameClock.wall.sleep(5000)]) } catch {}
  conn.close()
  process.exit(1)
})
