'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Лаборатория куска «после крепости Ада → вход в Энд» (поток nether-end): новый мир (farm.js up --fresh --random/--seeds),
// тело строит портал у спавна и входит в Ад (как сквозная try-lab-ne-run.js), потом сцена ставит его (команды — только
// постановка) туда, где кончается крепость Ада, с рюкзаком «после Ада»: 12 очей, обсидиан, огниво, еда, блоки и набор на
// дракона (кровати, вёдра, лодка — чтобы endkit не уводил на охоту: его мерят отдельно). Дальше — campaign.js полным
// порядком: stronghold (выход из Ада, поиск, дорога) → комната → dragon: fill enter. Успех — тело в Крае.
//
//   START=fortress   у крепости Ада (/locate от входа; spreadplayers на поверхность рядом) — как после блейзов;
//   START=portal     у портала Ада (сразу после входа);
//   START=near       верхний мир в DIST (200) блоках от крепости Края — кусок «очи → рамка».
// Итог — строка JSON в LAB_OUT: ok, минуты, отметки (вышел из Ада, крепость в памяти, комната, Край), смерти, очи.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-sh.js  START=fortress MINUTES=60
//   EYES=12 OBSIDIAN=12 CENV='{"ND_X":"1"}' CAMPAIGN=campaign.js
import * as fs from 'fs'
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
import path = require('path')
import { spawn, execFileSync } from 'child_process'
import { connect, createKit, sleep, classify, campaignFacts } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-ne-sh.jsonl')
const MINUTES = Number(process.env.MINUTES || 60)
const DEATHS_MAX = Number(process.env.DEATHS_MAX || (KEEPINV === 'false' ? 1 : 4))
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const START = process.env.START || 'fortress'
const DIST = Number(process.env.DIST || 200)
const EYES = Number(process.env.EYES || 12)
const OBSIDIAN = Number(process.env.OBSIDIAN || 12)
let CENV: Record<string, any> = {} as Record<string, any>
try { CENV = JSON.parse(process.env.CENV || '{}') } catch {}

const KIT0 = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
  'stone_pickaxe 2', 'flint_and_steel', 'cooked_beef 16', 'crafting_table', 'oak_planks 16', 'stick 8', 'obsidian 10']
// После Ада: очи, обсидиан, кровать, ведро, лодка, блоки. Набор на дракона не меряем (ND_ENDKIT=0 — поток дракона;
// 20 кроватей с набором Ада ещё и не влезают в рюкзак: 02.10 neF-sh-1 «блоков 64 из 108» → endkit наверху).
const KIT1 = [`ender_eye ${EYES}`, ...(OBSIDIAN ? [`obsidian ${OBSIDIAN}`] : []), 'white_bed 2', 'water_bucket',
  'oak_boat', 'cobblestone 64', 'netherrack 64', 'torch 16']

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
  await give(KIT0)
  await sleep(1000)
  await call('armor', {} as Record<string, any>).catch(() => null)
  // Дом: портал у спавна (RPC portal — этап portal кампании), точка возрождения у него, вход в Ад (портал Ада в памяти).
  let pr = null
  for (let k = 0; k < 3; k++) {
    pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ status: 'failed', error: e.message }))
    if ((pr.detail && (pr.detail.lit || pr.detail.built)) || /горит/.test(JSON.stringify(pr))) break
  }
  await kit.cmd('/spawnpoint @s')
  const home = (await status()).pos
  let s0: Record<string, any> = {} as Record<string, any>
  for (let k = 0; k < 2 && s0.dimension !== 'the_nether'; k++) {
    await call('portal', { mode: 'enter', timeoutSeconds: 180 }).catch(() => null)
    for (let w = 0; w < 10; w++) { s0 = await status(); if (s0.dimension === 'the_nether') break; await sleep(1000) }
  }
  // Портал горит, а войти не смогло (подготовка, ферма) — в клетку портала командой (try-lab-ne-util.portalTp).
  if (s0.dimension !== 'the_nether' && pr && pr.detail && pr.detail.inner && await (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).portalTp(kit, status, pr.detail.inner, call)) s0 = await status()
  const fail = why => {
    const rec: Record<string, any> = { at: new Date().toISOString(), seed: seedOf(), start: START, ok: false, setupFail: true, stoppedBy: why }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(JSON.stringify(rec))
  }
  if (s0.dimension !== 'the_nether') { fail('в Ад не вошёл на подготовке'); try { await Promise.race([call('disconnect', {} as Record<string, any>), gameClock.wall.sleep(8000)]) } catch {} process.exit(0) }
  const entry = { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) }
  const truth = { fortress: locate('fortress', 'the_nether', entry), stronghold: locate('stronghold', 'overworld', { x: entry.x * 8, z: entry.z * 8 }) }
  // MAP_SH=1 — крепость Края из копии мира (комната портала, пустые рамки): запись «крепость» у стены комнаты и очей —
  // по пустым рамкам (как сквозная try-lab-ne-run). GRID=1 — сетка Ада от крепости Ада до точки выхода (комната/8).
  let shMap = null; let shPlace = null; let gridInfo = null
  if (process.env.MAP_SH === '1' && home && process.env.FARM_SLOT) {
    const sm: Awaited<ReturnType<typeof import('../lib/try-lab-ne-map').strongholdMap>> = await (require('../lib/try-lab-ne-map') as typeof import('../lib/try-lab-ne-map')).strongholdMap(Number(process.env.FARM_SLOT), { x: Math.round(home.x), z: Math.round(home.z) }).catch(e => ({ error: e.message }))
    shMap = { start: sm.start, room: sm.room && sm.room.center, frames: sm.frames, eyes: sm.eyes, need: sm.need, error: sm.error }
    shPlace = sm.place || null
    console.log('крепость Края', JSON.stringify(shMap))
  }
  if (process.env.GRID === '1' && process.env.FARM_SLOT && START === 'fortress' && truth.fortress && shMap && (shMap.room || shMap.start)) {
    const M: typeof import('../lib/try-lab-ne-map') = require('../lib/try-lab-ne-map')
    const R0 = shMap.room || shMap.start
    const exit = { x: Math.floor(R0.x / 8), z: Math.floor(R0.z / 8) }
    const tg = gameClock.wall.now()
    try {
      const r = await M.netherGrid(Number(process.env.FARM_SLOT), M.corridorRects([{ x: truth.fortress.x, z: truth.fortress.z }, exit], 40), {} as Record<string, any>)
      ;(require('../../src/nether-grid') as typeof import('../../src/nether-grid')).save(path.join(REPO_ROOT, 'farm', `memory-${process.env.FARM_SLOT}`), r.grid, { pts: [truth.fortress, exit] })
      gridInfo = { seconds: Math.round((gameClock.wall.now() - tg) / 1000), chunks: r.chunks, loaded: r.loaded, exit }
    } catch (e) { gridInfo = { error: e.message } }
    console.log('сетка', JSON.stringify(gridInfo))
  }
  // Постановка куска.
  if (START === 'fortress' && truth.fortress) {
    const f = truth.fortress
    const r = await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${f.x} ${f.z} 0 24 under 90 false @s`, { reply: /Spread|Could not/, ms: 30000 })
    if (!r.ok || /Could not/.test(r.reply || '')) { fail('spreadplayers у крепости Ада не вышел'); process.exit(0) }
  } else if (START === 'near' && truth.stronghold) {
    // Верхний мир: выйти тем же порталом и встать в DIST от угла чанка крепости со стороны дома.
    await call('portal', { mode: 'enter', timeoutSeconds: 120 }).catch(() => null)
    const S = truth.stronghold
    const d = Math.hypot(S.x - home.x, S.z - home.z) || 1
    const x = Math.round(S.x - (S.x - home.x) / d * DIST); const z = Math.round(S.z - (S.z - home.z) / d * DIST)
    const r = await kit.cmd(`/execute in minecraft:overworld run spreadplayers ${x} ${z} 0 16 false @s`, { reply: /Spread|Could not/, ms: 30000 })
    if (!r.ok || /Could not/.test(r.reply || '')) { fail('spreadplayers у крепости Края не вышел'); process.exit(0) }
  }
  if (shPlace) {
    const w = await call('fortress', { mode: 'map', places: { крепость: shPlace }, timeoutSeconds: 30 }).catch(e => ({ error: e.message }))
    console.log('в память', JSON.stringify((w.detail && w.detail.mapped) || w.error || null))
  }
  await give(KIT1)
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(2500)
  const sA = await status()
  const startPos = sA.pos ? { x: Math.round(sA.pos.x), y: Math.round(sA.pos.y), z: Math.round(sA.pos.z), dim: sA.dimension } : null

  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const tc = gameClock.now()
  const child = spawn(process.execPath, [CAMPAIGN], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ND_EYES_NEED: String(shMap && shMap.need ? Math.min(EYES, shMap.need) : Math.min(12, EYES)), ...(process.env.ENDKIT === '1' ? {} as Record<string, any> : { ND_ENDKIT: '0' }), ...CENV },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  const marks: Record<string, any> = {} as Record<string, any>
  const mark = (k) => { if (marks[k] == null) marks[k] = Math.round((gameClock.now() - tc) / 6000) / 10 }
  let stoppedBy = 'время'
  let ok = false
  let lastCheck = 0
  const until = tc + MINUTES * 60000
  let lastDim = sA.dimension
  while (gameClock.now() < until) {
    await sleep(4000)
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (/ВЕХА stronghold/.test(text)) mark('room')
    if (gameClock.now() - lastCheck > 10000 || exited !== null) {
      lastCheck = gameClock.now()
      const s = await status()
      if (s.dimension && s.dimension !== lastDim) { mark(`${lastDim}->${s.dimension}`); lastDim = s.dimension }
      const rec = await call('recall', { lines: 1 }).catch(() => null)
      const places = (rec && rec.detail && rec.detail.state && rec.detail.state.places) || {} as Record<string, any>
      if (places['крепость']) mark('stronghold')
      if (places['портал в Край']) mark('room')
      if (s.dimension === 'the_end') { ok = true; mark('end'); stoppedBy = 'в Энде'; break }
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
  const inv = s.inventory || {} as Record<string, any>
  const deaths = deathLines(size)
  const recall = await call('recall', { lines: 1 }).catch(() => null)
  const places = (recall && recall.detail && recall.detail.state && recall.detail.state.places) || {} as Record<string, any>
  const S = places['крепость']
  const rec: Record<string, any> = {
    at: new Date().toISOString(),
    seed: seedOf(),
    start: START,
    ok,
    minutes: Math.round((gameClock.now() - tc) / 6000) / 10,
    marks,
    stoppedBy,
    exitCode: exited,
    deathCount: deaths.length,
    deaths,
    entry,
    startPos,
    truth,
    found: S ? { x: S.x, z: S.z, err: truth.stronghold ? Math.round(Math.hypot(S.x - truth.stronghold.x, S.z - truth.stronghold.z)) : null } : null,
    eyes: cnt(inv, /^ender_eye$/),
    obsidian: cnt(inv, /^obsidian$/),
    shMap,
    grid: gridInfo,
    miles: facts.miles,
    lastStage: facts.lastStage,
    lastCodes: facts.codes.filter(c => c.code !== 'OK').slice(-5).map(c => `${c.method}:${c.code}@${c.minute}м`),
    dimension: s.dimension || null,
    pos: s.pos || null,
    campaignLog: path.basename(clog),
    setupSeconds: Math.round((tc - t0) / 1000)
  }
  rec.class = classify({ ...rec, deathsMax: DEATHS_MAX }, text)
  rec.tail = text.split('\n').filter(l => /ВЕХА|БЛОКЕР|итог этапа|этап упал|умер|прогон упал|крепост|stronghold|travel|портал/.test(l)).slice(-14).map(l => l.slice(0, 220))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-sh окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
