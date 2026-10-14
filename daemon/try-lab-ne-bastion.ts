'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория куска «бастион» (поток nether-end) на новом мире: тело строит портал у спавна и входит в Ад (как
// try-lab-ne-run.js), бастион — ближайший к порталу Ада (/locate, только постановка) — передаётся кампании так, как его
// записала бы разведка крепости («бастион (ад)» через ND_EXTRA_PLACES). Рюкзак — std сквозной сцены + 7 стержней (этап
// bastion идёт после крепости Ада). Дальше — campaign.js только этапом bastion (и eyes): дорога от портала, золото,
// бартер. Итог — строка JSON в LAB_OUT: минуты, жемчуг/очи, слитков пиглинам, золотых блоков, огнестойкость, обсидиан,
// нить, смерти, тип бастиона (по правде мира — для сводки).
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-bastion.js   MINUTES=40
//   NEAR=1 — тело сразу у бастиона (spreadplayers в 40 блоках со стороны портала), без дороги.
//   STAGES=bastion,eyes  CENV='{"ND_X":"1"}'  CAMPAIGN=campaign.js
//   MAP=1 — бастион «по карте из копии мира» (try-lab-ne-map.js: золото и сундуки по NBT кусков, сверено) — в память тела.
const fs = require('fs')
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { connect, createKit, sleep, classify, campaignFacts } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ne-bastion.jsonl')
const MINUTES = Number(process.env.MINUTES || 40)
const METRICS = process.env.ND_BARTER_METRICS === '1'
const { markPearls } = require('./src/barter-marks')
const DEATHS_MAX = Number(process.env.DEATHS_MAX || (KEEPINV === 'false' ? 1 : 3))
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const STAGES = process.env.STAGES || 'bastion,eyes'
let CENV: Record<string, any> = {} as Record<string, any>
try { CENV = JSON.parse(process.env.CENV || '{}') } catch {}

const KITS = {
  std: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
    'stone_pickaxe 2', 'water_bucket', 'bucket', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64',
    'cobbled_deepslate 64', 'crafting_table', 'oak_planks 16', 'stick 8', 'obsidian 10', 'iron_ingot 2'],
  // ls — набор слепого входа (try-lab-ne-run KIT=lightshield): брони и золота нет — золото бастиона на ботинки и бартер (агент Ада 14.10).
  ls: ['iron_pickaxe', 'stone_pickaxe 2', 'iron_sword', 'shield', 'water_bucket', 'bucket', 'flint_and_steel',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    'white_bed', 'obsidian 10', 'iron_ingot 1']
}
const KIT = KITS[process.env.KIT || 'std'] || KITS.std
const KIT_AFTER = ['blaze_rod 7']

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
// Смерти с отметки — переживает полуночную перекладку latest.log (try-lab-ne-util.deaths, 03.10).
let _deathT = null
function deathLines (from) { if (!_deathT || _deathT.from !== from) _deathT = { from, f: require('./try-lab-ne-util').deaths(LOG, PLAYER, from) }; return _deathT.f() }
const cnt = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}
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
async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {} as Record<string, any>).catch(() => null)
    if (st && st.state && st.state.dimension) return st.state
    await sleep(1500)
  }
  return {} as Record<string, any>
}
async function give (list) {
  for (const g of list) {
    const [item, n] = g.split(' ')
    await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`)
  }
}
// Тип бастиона по правде мира (только для сводки): золото в 96 блоках против узоров шаблонов jar (как try-lab-bastion).
async function truthType () {
  const bp = require('./src/bastion-pieces')
  const r = await call('blocks_around', { find: 'gold_block', radius: 96, count: 200 })
  const gold = (((r && r.detail) || r || {} as Record<string, any>).found || [])
  const set = new Set(gold.map(g => `${g.x},${g.y},${g.z}`))
  let best = null
  for (const [name, P] of Object.entries<any>(bp.lib())) {
    if (P.gold.length < 3) continue
    for (let rr = 0; rr < 4; rr++) {
      for (const g0 of gold) {
        for (const [ax, ay, az] of P.gold.slice(0, 4)) {
          const [rx, rz] = bp.rot(rr, ax, az)
          const t = { x: g0.x - rx, y: g0.y - ay, z: g0.z - rz }
          let n = 0
          for (const [cx, cy, cz] of P.gold) { const [wx, wz] = bp.rot(rr, cx, cz); if (set.has(`${wx + t.x},${cy + t.y},${wz + t.z}`)) n++ }
          if (!best || n > best.n) best = { n, piece: name, type: P.type }
        }
      }
    }
  }
  return { gold: gold.length, type: best && best.n >= 3 ? best.type : 'unknown', piece: best && best.n >= 3 ? best.piece : undefined }
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  await kit.randomReset()
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', KEEPINV) // правило пользователя 02.10: боевой режим — false
  // У Paper правила игры свои у каждого мира: из верхнего мира /gamerule не трогает Ад и Край (слот 26 02.10 умер в Аду
  // и потерял весь рюкзак при keep_inventory=true наверху).
  for (const d of ['the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  await give(KIT)
  await sleep(1000)
  await call('armor', {} as Record<string, any>).catch(() => null)
  let pr = null
  for (let k = 0; k < 3; k++) {
    pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ status: 'failed', error: e.message }))
    if ((pr.detail && (pr.detail.lit || pr.detail.built)) || /горит/.test(JSON.stringify(pr))) break
  }
  await kit.cmd('/spawnpoint @s')
  let s0: Record<string, any> = {} as Record<string, any>
  for (let k = 0; k < 2 && s0.dimension !== 'the_nether'; k++) {
    await call('portal', { mode: 'enter', timeoutSeconds: 180 }).catch(() => null)
    for (let w = 0; w < 10; w++) { s0 = await status(); if (s0.dimension === 'the_nether') break; await sleep(1000) }
  }
  // Портал горит, а войти не смогло (подготовка, ферма) — в клетку портала командой (try-lab-ne-util.portalTp).
  if (s0.dimension !== 'the_nether' && pr && pr.detail && pr.detail.inner && await require('./try-lab-ne-util').portalTp(kit, status, pr.detail.inner, call)) s0 = await status()
  const fail = why => {
    const rec: Record<string, any> = { at: new Date().toISOString(), seed: seedOf(), ok: false, setupFail: true, stoppedBy: why }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(JSON.stringify(rec))
  }
  if (s0.dimension !== 'the_nether') { fail('в Ад не вошёл на подготовке'); try { await Promise.race([call('disconnect', {} as Record<string, any>), gameClock.wall.sleep(8000)]) } catch {} process.exit(0) }
  const entry = { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) }
  const B = locate('bastion_remnant', 'the_nether', entry)
  if (!B) { fail('бастиона /locate не нашёл'); process.exit(0) }
  if (process.env.NEAR === '1') {
    const d = Math.hypot(B.x - entry.x, B.z - entry.z) || 1
    const x = Math.round(B.x - (B.x - entry.x) / d * 40); const z = Math.round(B.z - (B.z - entry.z) / d * 40)
    const r = await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${x} ${z} 0 8 under 80 false @s`, { reply: /Spread|Could not/, ms: 30000 })
    if (!r.ok || /Could not/.test(r.reply || '')) { fail('spreadplayers у бастиона не вышел'); process.exit(0) }
  }
  await give(KIT_AFTER)
  let map = null
  if (process.env.MAP === '1') {
    const m = await require('./try-lab-ne-map').netherMap(Number(process.env.FARM_SLOT), entry, { bastions: 1 }).catch(e => ({ error: e.message, places: {} as Record<string, any> }))
    const pl = Object.fromEntries(Object.entries<any>(m.places || {} as Record<string, any>).filter(([k]: any) => /бастион/.test(k)))
    const w = await call('fortress', { mode: 'map', places: pl, timeoutSeconds: 30 }).catch(e => ({ error: e.message }))
    map = { mapped: (w.detail && w.detail.mapped) || w.error || null, error: m.error, bastions: (m.bastions || []).map(b => ({ x: b.x, z: b.z, type: b.type, gold: (b.gold || []).length })) }
    // GRID=1 — сетка Ада «из копии мира» от входа до бастиона (+ его коробка) для nether-route (ND_NE_ROUTE=1 у демона).
    if (process.env.GRID === '1') {
      const tg = gameClock.wall.now()
      try {
        const M = require('./try-lab-ne-map')
        const b0 = (m.bastions || []).find(b => b.gold && b.gold.length) || null
        const key = pl['бастион (ад)']
        const pts = [entry, key ? { x: key.x, z: key.z } : (b0 ? { x: b0.x, z: b0.z } : entry)]
        const rects = M.corridorRects(pts, 40)
        if (b0 && b0.bbAll) rects.push([b0.bbAll[0] - 8, b0.bbAll[2] - 8, b0.bbAll[3] + 8, b0.bbAll[5] + 8])
        const r = await M.netherGrid(Number(process.env.FARM_SLOT), rects, {} as Record<string, any>)
        require('./src/nether-grid').save(path.join(__dirname, '..', 'farm', `memory-${process.env.FARM_SLOT}`), r.grid, { pts })
        map.grid = { seconds: Math.round((gameClock.wall.now() - tg) / 1000), chunks: r.chunks, loaded: r.loaded }
      } catch (e) { map.grid = { error: e.message } }
      console.log('сетка', JSON.stringify(map.grid))
    }
  }
  await sleep(2000)
  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const tc = gameClock.now()
  const places = { 'бастион (ад)': { x: B.x, y: 50, z: B.z, dimension: 'the_nether', note: 'сцена: как записала бы разведка' } }
  const child = spawn(process.execPath, [CAMPAIGN, STAGES], {
    cwd: __dirname,
    // SEARCH=1 — бастион кампания находит сама (этап bastion: fortress mode=bastion, запись — ближний ВИДИМЫЙ кирпич, как в
    // настоящем прохождении); иначе — «как записала бы разведка» по /locate (старт постройки бывает внутри двора).
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ...(process.env.SEARCH === '1' || process.env.MAP === '1' || !require('./src/perception/knowledge').allows('structures', 'try-lab-ne-bastion EXTRA_PLACES') ? {} as Record<string, any> : { ND_EXTRA_PLACES: JSON.stringify(places) }), ...CENV },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  let stoppedBy = 'время'
  let best: Record<string, any> = { pearls: 0 }
  const marks: Record<string, any> = {} as Record<string, any>
  let lastCheck = 0
  const until = tc + MINUTES * 60000
  while (gameClock.now() < until) {
    await sleep(5000)
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (gameClock.now() - lastCheck > (METRICS ? 4500 : 20000)) {
      lastCheck = gameClock.now()
      const s = await status()
      best.pearls = Math.max(best.pearls, cnt(s.inventory, /^(ender_pearl|ender_eye)$/))
      if (METRICS && !deathLines(size).length) markPearls(marks, s.inventory || {} as Record<string, any>, (gameClock.now() - tc) / 1000)
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
  const tt = await truthType().catch(e => ({ type: 'ошибка', error: e.message }))
  const facts = campaignFacts(text)
  const inv = s.inventory || {} as Record<string, any>
  const deaths = deathLines(size)
  const bastions = [...text.matchAll(/(бастион[^:\n]*\(ад\)): золотых блоков (\S+), слитков пиглинам (\S+)/g)].map(m => ({ key: m[1], blocks: m[2], ingots: m[3] }))
  const rec: Record<string, any> = {
    at: new Date().toISOString(),
    seed: seedOf(),
    near: process.env.NEAR === '1',
    minutes: Math.round((gameClock.now() - tc) / 6000) / 10,
    stoppedBy,
    exitCode: exited,
    deathCount: deaths.length,
    deaths,
    entry,
    bastion: { ...B, ...tt },
    map,
    pearls: cnt(inv, /^ender_pearl$/) + cnt(inv, /^ender_eye$/),
    best,
    ...(METRICS ? { marks, ok: deaths.length === 0 && marks.pearls10 !== undefined && marks.pearls10 <= 12 } : {} as Record<string, any>),
    ingotsTraded: bastions.reduce((n, b) => n + (Number(b.ingots) || 0), 0),
    goldBlocks: bastions.reduce((n, b) => n + (Number(b.blocks) || 0), 0),
    goldLeft: cnt(inv, /^gold_ingot$/) + 9 * cnt(inv, /^gold_block$/),
    obsidian: cnt(inv, /^obsidian$/),
    crying: cnt(inv, /^crying_obsidian$/),
    string: cnt(inv, /^string$/),
    fireRes: cnt(inv, /fire_resistance/) + Object.keys(inv).filter(k => /potion/.test(k)).length,
    bastions,
    miles: facts.miles,
    lastCodes: facts.codes.filter(c => c.code !== 'OK').slice(-5).map(c => `${c.method}:${c.code}@${c.minute}м`),
    bag: Object.entries<any>(inv).map(([k, v]: any) => `${k}×${v}`).join(' '),
    campaignLog: path.basename(clog),
    setupSeconds: Math.round((tc - t0) / 1000)
  }
  rec.class = classify({ ...rec, ok: METRICS ? rec.ok : rec.pearls >= 12, deathsMax: DEATHS_MAX }, text)
  rec.tail = text.split('\n').filter(l => /ВЕХА|БЛОКЕР|итог этапа|этап упал|умер|прогон упал|бастион|выработан|штрек/.test(l)).slice(-14).map(l => l.slice(0, 220))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-bastion окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
