'use strict'
const gameClock = require('./src/game-clock')
// Сквозная лаборатория потока nether-end: «вход в Ад → вход в Энд» на новом мире (farm.js up N --fresh --random или
// --seeds). Подготовка — только до входа в Ад (ферма, команды): /random reset, выживание, normal, keep_inventory, набор
// «как после верхнего мира» (KIT=std|light), утро. Портал верхнего мира тело строит само (RPC portal из 10 обсидиана в
// рюкзаке), ставит кровать у портала (точка возрождения, как этап prep) и входит в Ад. С этой секунды — часы и
// campaign.js полным порядком этапов, без команд. /locate (бастион, крепость Ада, крепость Края) — только в итог
// сцены для разбора, телу и кампании не передаётся.
//
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
//   STAGES=nether — только эти этапы кампании (кусок «крепость» от портала); KIT=post — std + то, что даёт бартер моста
//   (лук, 64 стрелы, 3 зелья огнестойкости, 11 жемчуга) — набор «после бастиона».
const fs = require('fs')
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { connect, createKit, sleep, classify, campaignFacts } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ne-run.jsonl')
const MINUTES = Number(process.env.MINUTES || 120)
const DEATHS_MAX = Number(process.env.DEATHS_MAX || (KEEPINV === 'false' ? 1 : 5))
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const KIT_NAME = process.env.KIT || 'std'
const ENDERMEN = process.env.ENDERMEN ?? '1'
let CENV = {}
try { CENV = JSON.parse(process.env.CENV || '{}') } catch {}

// Наборы «на входе в Ад». std — то, что требуют ворота кампании (READY.bastion, fightReady), light — как у
// fresh-A5 слот 9 (вход на 57-й мин): кирки, меч, вёдра, огниво, мало еды, блоки, без брони.
const KITS = {
  std: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'stick 8', 'white_bed', 'obsidian 10', 'iron_ingot 2'],
  post: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'stick 8', 'white_bed', 'obsidian 10', 'iron_ingot 2',
    'bow', 'spectral_arrow 64', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 3', 'ender_pearl 11', 'string 12'],
  light: ['iron_pickaxe', 'stone_pickaxe 2', 'iron_sword', 'water_bucket', 'bucket', 'flint_and_steel',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    'white_bed', 'obsidian 10', 'iron_ingot 2']
}
const KIT = KITS[KIT_NAME]
if (!KIT) { console.error(`KIT=${KIT_NAME}: жду ${Object.keys(KITS).join(', ')}`); process.exit(1) }

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
// Смерти с отметки — переживает полуночную перекладку latest.log (try-lab-ne-util.deaths, 03.10).
let _deathT = null
function deathLines (from) { if (!_deathT || _deathT.from !== from) _deathT = { from, f: require('./try-lab-ne-util').deaths(LOG, PLAYER, from) }; return _deathT.f() }
const cnt = (inv, re) => Object.entries(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}

async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {}).catch(() => null)
    if (st && st.state && st.state.dimension) return st.state
    await sleep(1500)
  }
  return {}
}

// /locate для разбора — RCON слота (ответ locate не пишется в журнал сервера): «The nearest minecraft:x is at [x, ~, z] (N blocks away)».
function rcon (text) {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 90000 }) } catch (e) { return String(e.message) }
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

async function setup () {
  // Копии мира и сиды независимы только со сброшенными последовательностями ГСЧ (AGENTS.md: ферма).
  await kit.cmd('/random reset *')
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', KEEPINV) // правило пользователя 02.10: боевой режим — false, смерть = провал
  // У Paper правила игры свои у каждого мира: из верхнего мира /gamerule не трогает Ад и Край (слот 26 02.10 умер в Аду
  // и потерял весь рюкзак при keep_inventory=true наверху).
  for (const d of ['the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  for (const g of KIT) {
    const [item, n] = g.split(' ')
    await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`)
  }
  await sleep(1500)
  await call('armor', {}).catch(() => null)
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  await setup()
  // Портал верхнего мира — сам (этап portal кампании: тот же RPC), кровать у него — точка возрождения (этап prep).
  let pr = null
  for (let k = 0; k < 3; k++) {
    pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ status: 'failed', error: e.message }))
    const st = await status()
    if ((pr.detail && (pr.detail.lit || pr.detail.built)) || /горит/.test(JSON.stringify(pr))) break
    if (st.dimension !== 'overworld') break
    // «Обсидиан принеси» (рама начата, обсидиан ушёл в неё/выпал: neF-B10f23-1 03.10) — подготовка: выдать ещё.
    if (/обсидиан принеси|нет обсидиана|не хватает обсидиана/.test(JSON.stringify(pr))) { await kit.cmd('/give @s minecraft:obsidian 10'); await kit.cmd('/give @s minecraft:flint_and_steel'); await sleep(800) }
  }
  // Точка возрождения у портала — командой (этап prep ставит туда кровать; 02.10 кровать встала в проходе портала на
  // 2 слотах из 6, и enter не дошёл до порога — это отдельная беда bedtime.js, не этой сцены).
  await kit.cmd('/spawnpoint @s')
  // Карта Ада (MAP=1) — ДО входа, по оценке точки прибытия (портал/8): netherMap работает только через RCON, а тело,
  // ждущее 15–20 с у портала Ада, били и оно уходило обратно в портал (neF-Pa23-1 02.10: хп 20→13, наверху у
  // погасшего портала — кампания стартовала в верхнем мире).
  const sOw = await status()
  const est = sOw.pos ? { x: Math.floor(sOw.pos.x / 8), y: 70, z: Math.floor(sOw.pos.z / 8) } : null
  let map = null
  let mapPlaces = null
  if (process.env.MAP === '1' && est && process.env.FARM_SLOT) {
    const tm = gameClock.now()
    const m = await require('./try-lab-ne-map').netherMap(Number(process.env.FARM_SLOT), est, { bastions: Number(process.env.MAP_BASTIONS || 2) }).catch(e => ({ error: e.message, places: {} }))
    mapPlaces = m.places
    map = { seconds: Math.round((gameClock.now() - tm) / 1000), est, error: m.error,
      bastions: (m.bastions || []).map(b => ({ x: b.x, z: b.z, dist: b.dist, type: b.type, gold: (b.gold || []).length, bb: b.bbAll || undefined })), fortressBB: (m.fortress && m.fortress.bbAll) || undefined,
      fortress: m.fortress ? { x: m.fortress.x, z: m.fortress.z, dist: m.fortress.dist, spawner: m.fortress.spawner } : null, route: m.route || null }
    console.log('карта', JSON.stringify(map))
  }
  // MAP_SH=1 — и крепость Края из той же копии мира (комната портала, сколько рамок пусто): запись «крепость» у стены
  // комнаты (refined, без бросков find), очей нужно — по пустым рамкам (ND_EYES_NEED, если EYES не задан).
  let shMap = null
  if (process.env.MAP_SH === '1' && sOw.pos && process.env.FARM_SLOT) {
    const sm = await require('./try-lab-ne-map').strongholdMap(Number(process.env.FARM_SLOT), { x: Math.round(sOw.pos.x), z: Math.round(sOw.pos.z) }).catch(e => ({ error: e.message }))
    shMap = { start: sm.start, room: sm.room && sm.room.center, frames: sm.frames, eyes: sm.eyes, need: sm.need, error: sm.error }
    if (sm.place) { mapPlaces = { ...(mapPlaces || {}), крепость: sm.place }; if (!map) map = {} }
    if (sm.need && !process.env.EYES) process.env.EYES = String(sm.need)
    console.log('крепость Края', JSON.stringify(shMap))
  }
  // GRID=1 (при MAP=1) — сетка Ада по коридорам маршрута «из копии мира» (try-lab-ne-map.netherGrid): портал (оценка) →
  // бастион → спавнер → выход у крепости Края (/8), плюс коробки бастиона и крепости целиком. Тело ходит по ней
  // (nether-route, ND_NE_ROUTE=1 в CENV/окружении демона). Снимается до входа в Ад, как и карта.
  let gridInfo = null
  if (process.env.GRID === '1' && process.env.FARM_SLOT && est && mapPlaces) {
    const tg = gameClock.wall.now()
    try {
      const M = require('./try-lab-ne-map')
      const pts = [est]
      const bs = (map && map.bastions) || []
      const keyB = mapPlaces['бастион (ад)']
      if (keyB) pts.push({ x: keyB.x, z: keyB.z })
      const sp = mapPlaces['спавнер блейзов']
      if (sp) pts.push({ x: sp.x, z: sp.z })
      if (shMap && shMap.room) pts.push({ x: Math.floor(shMap.room.x / 8), z: Math.floor(shMap.room.z / 8) })
      else if (shMap && shMap.start) pts.push({ x: Math.floor(shMap.start.x / 8), z: Math.floor(shMap.start.z / 8) })
      const rects = M.corridorRects(pts, 40)
      // Второй бастион (ближе 350 бл.) — отдельными коридорами от первого и к спавнеру: жемчуга с одного бастиона часто
      // мало (бартер: 0.064/слиток), кампания идёт ко второму.
      const keyB2 = mapPlaces['бастион 2 (ад)']
      // NEAR_B2=1: бастион 2 вне сетки (дальше 350 от входа) телу не давать — от него к спавнеру ни сетки, ни пути (B2-30 03.10:
      // 13 жемчуга, ко второму за 400 бл., оттуда «путь длиной 0» ×35 к спавнеру в 563 бл., паузы, время).
      if (process.env.NEAR_B2 === '1' && keyB2 && Math.hypot(keyB2.x - est.x, keyB2.z - est.z) >= 350) { delete mapPlaces['бастион 2 (ад)']; console.log('бастион 2 вне сетки — телу не даю', JSON.stringify({ x: keyB2.x, z: keyB2.z })) }
      if (keyB2 && mapPlaces['бастион 2 (ад)'] && keyB && Math.hypot(keyB2.x - est.x, keyB2.z - est.z) < 350) {
        rects.push(...M.corridorRects([{ x: keyB.x, z: keyB.z }, { x: keyB2.x, z: keyB2.z }], 40))
        if (sp) rects.push(...M.corridorRects([{ x: keyB2.x, z: keyB2.z }, { x: sp.x, z: sp.z }], 40))
      }
      // Коробки — только выбранного бастиона (его запись в памяти внутри коробки) и крепости; дальние бастионы карты —
      // нет (сетка 91 млн клеток на слоте 25 03.10 — память и время плана).
      const near = (bb, q) => q && q.x >= bb[0] - 16 && q.x <= bb[3] + 16 && q.z >= bb[2] - 16 && q.z <= bb[5] + 16
      const chosen = bs.filter(b => b.bb && (near(b.bb, mapPlaces['бастион (ад)']) || near(b.bb, mapPlaces['бастион 2 (ад)'])) && Math.hypot(b.x - est.x, b.z - est.z) < 350)
      for (const bb of [map && map.fortressBB, ...chosen.map(b => b.bb)].filter(Boolean)) rects.push([bb[0] - 8, bb[2] - 8, bb[3] + 8, bb[5] + 8])
      const r = await M.netherGrid(Number(process.env.FARM_SLOT), rects, {})
      const NG = require('./src/nether-grid')
      NG.save(path.join(__dirname, '..', 'farm', `memory-${process.env.FARM_SLOT}`), r.grid, { pts, rects: rects.length })
      gridInfo = { seconds: Math.round((gameClock.wall.now() - tg) / 1000), chunks: r.chunks, loaded: r.loaded, box: r.box, cells: r.grid.data.length, pts }
    } catch (e) { gridInfo = { error: e.message } }
    console.log('сетка', JSON.stringify(gridInfo))
  }
  // Смерти считаются с этой точки (вход в Ад и всё после него).
  const size = logSize()
  let en = null
  let s0 = {}
  for (let k = 0; k < 3 && s0.dimension !== 'the_nether'; k++) {
    // Рама на месте, а портал погас (neF-R22/R26 02.10: «горящего портала в 16 блоках не вижу», рама из 10 обсидиана
    // цела) — поджечь заново (portal build поджигает готовую раму) и снова войти.
    if (k > 0) await call('portal', { timeoutSeconds: 120 }).catch(() => null)
    en = await call('portal', { mode: 'enter', timeoutSeconds: 180 }).catch(e => ({ status: 'failed', error: e.message }))
    for (let w = 0; w < 10; w++) { s0 = await status(); if (s0.dimension === 'the_nether') break; await sleep(1000) }
  }
  // Портал горит, а войти тело не смогло (рама на круче, у нижнего ряда негде встать: neF-A0f22-1 03.10) — подготовка
  // ещё не мерится: тело в клетку портала командой (ферма).
  let viaTp = false
  if (s0.dimension !== 'the_nether' && pr && pr.detail && pr.detail.inner) {
    viaTp = await require('./try-lab-ne-util').portalTp(kit, status, pr.detail.inner)
    if (viaTp) s0 = await status()
  }
  if (s0.dimension !== 'the_nether') {
    const rec = { at: new Date().toISOString(), seed: seedOf(), kit: KIT_NAME, ok: false, setupFail: true, stoppedBy: 'в Ад не вошёл на подготовке', portal: String(pr && (pr.error || (pr.detail && pr.detail.note)) || '').slice(0, 200), enter: String(en && (en.error || (en.detail && (en.detail.note || en.detail.stopped))) || '').slice(0, 200) }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(JSON.stringify(rec))
    try { await Promise.race([call('disconnect', { reason: 'сцена окончена' }), gameClock.wall.sleep(10000)]) } catch {}
    process.exit(0)
  }
  const entry = s0.pos ? { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) } : null
  if (mapPlaces) {
    const w = await call('fortress', { mode: 'map', places: mapPlaces, timeoutSeconds: 30 }).catch(e => ({ error: e.message }))
    map.mapped = (w.detail && w.detail.mapped) || w.error || null
  }
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const tc = gameClock.now()
  const child = spawn(process.execPath, [CAMPAIGN, ...(process.env.STAGES ? [process.env.STAGES] : [])], {
    cwd: __dirname,
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ...(ENDERMEN === '1' ? { ND_ENDERMEN: '1' } : {}), ...(process.env.ENDKIT === '1' ? {} : { ND_ENDKIT: '0' }), ND_WATCHDOG_MIN: String(MINUTES + 5), ...(process.env.EYES ? { ND_EYES_NEED: process.env.EYES } : {}), ...CENV },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  // Правда для разбора (телу не передаётся) — уже после старта кампании: тело не ждёт RCON у портала.
  const truth = entry ? {
    bastion: locate('bastion_remnant', 'the_nether', entry),
    fortress: locate('fortress', 'the_nether', entry),
    stronghold: locate('stronghold', 'overworld', { x: entry.x * 8, z: entry.z * 8 })
  } : null
  let stoppedBy = 'время'
  let ok = false
  let reachedAt = null
  let lastCheck = 0
  let best = { pearls: 0, eyes: 0, rods: 0 }
  // Отметки кусков (минуты от входа в Ад): увидел крепость/бастион, золото, стержни, жемчуг, очи, выход наверх,
  // крепость Края, комната — по памяти тела и рюкзаку раз в 20 с.
  const marks = {}
  const mark = k => { if (marks[k] == null) marks[k] = Math.round((gameClock.now() - tc) / 6000) / 10 }
  let lastDim = 'the_nether'
  const until = tc + MINUTES * 60000
  while (gameClock.now() < until) {
    await sleep(5000)
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (gameClock.now() - lastCheck > 20000 || exited !== null) {
      lastCheck = gameClock.now()
      const s = await status()
      const inv = s.inventory || {}
      best = {
        pearls: Math.max(best.pearls, cnt(inv, /^ender_pearl$/) + cnt(inv, /^ender_eye$/)),
        eyes: Math.max(best.eyes, cnt(inv, /^ender_eye$/)),
        rods: Math.max(best.rods, cnt(inv, /^blaze_rod$/) + Math.floor(cnt(inv, /^blaze_powder$/) / 2) + Math.floor(cnt(inv, /^ender_eye$/) / 2))
      }
      if (cnt(inv, /^gold_block$/) || cnt(inv, /^gold_ingot$/) >= 9) mark('gold')
      if (best.rods >= 7) mark('rods7')
      if (best.pearls >= 10) mark('pearls10')
      if (best.eyes >= 10) mark('eyes10')
      if (s.dimension && s.dimension !== lastDim) { mark(lastDim + '->' + s.dimension); lastDim = s.dimension }
      const rc = await call('recall', { lines: 1 }).catch(() => null)
      const pl = (rc && rc.detail && rc.detail.state && rc.detail.state.places) || {}
      if (pl['крепость (ад)']) mark('fortressSeen')
      if (pl['бастион (ад)']) mark('bastionSeen')
      if (pl['спавнер блейзов']) mark('spawner')
      if (pl['крепость']) mark('stronghold')
      if (pl['портал в Край']) mark('room')
      if (s.dimension === 'the_end') { ok = true; reachedAt = Math.round((gameClock.now() - tc) / 6000) / 10; stoppedBy = 'в Энде'; break }
    }
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    const deaths = deathLines(size)
    if (deaths.length >= DEATHS_MAX) { stoppedBy = `смертей ${deaths.length}`; break }
    if (/БЛОКЕР/.test(text)) { stoppedBy = (text.match(/БЛОКЕР[^\n]{0,160}/) || ['БЛОКЕР'])[0]; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  try { await call('stop') } catch {}
  await sleep(1500)
  const s = await status()
  let text = ''
  try { text = fs.readFileSync(clog, 'utf8') } catch {}
  const facts = campaignFacts(text)
  const inv = s.inventory || {}
  const deaths = deathLines(size)
  const bastions = [...text.matchAll(/(бастион[^:\n]*\(ад\)): золотых блоков (\S+), слитков пиглинам (\S+)/g)].map(m => ({ key: m[1], blocks: m[2], ingots: m[3] }))
  const rec = {
    at: new Date().toISOString(),
    seed: seedOf(),
    kit: KIT_NAME,
    ok,
    minutes: Math.round((gameClock.now() - tc) / 6000) / 10,
    reachedAt,
    stoppedBy,
    exitCode: exited,
    deathCount: deaths.length,
    deaths,
    entry,
    truth,
    map,
    shMap,
    eyesNeed: process.env.EYES ? Number(process.env.EYES) : null,
    best,
    marks,
    pearls: cnt(inv, /^ender_pearl$/),
    eyes: cnt(inv, /^ender_eye$/),
    rods: cnt(inv, /^blaze_rod$/),
    gold: cnt(inv, /^gold_ingot$/) + 9 * cnt(inv, /^gold_block$/),
    bastions,
    ingotsTraded: bastions.reduce((n, b) => n + (Number(b.ingots) || 0), 0),
    miles: facts.miles,
    lastStage: facts.lastStage,
    lastCodes: facts.codes.filter(c => c.code !== 'OK').slice(-5).map(c => `${c.method}:${c.code}@${c.minute}м`),
    dimension: s.dimension || null,
    pos: s.pos || null,
    bag: Object.entries(inv).map(([k, v]) => `${k}×${v}`).join(' '),
    campaignLog: path.basename(clog),
    setupSeconds: Math.round((tc - t0) / 1000),
    viaTp,
    grid: gridInfo
  }
  rec.class = classify({ ...rec, deathsMax: DEATHS_MAX }, text)
  rec.tail = text.split('\n').filter(l => /ВЕХА|БЛОКЕР|итог этапа|этап упал|умер|прогон упал|РИСК|сторож|нет доступного|выработан|стержней:|жемчуг:|бастион|крепост/.test(l)).slice(-16).map(l => l.slice(0, 220))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-run окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
