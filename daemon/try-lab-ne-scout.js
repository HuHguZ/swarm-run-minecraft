'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория куска «найти крепость / бастион в Аду» (поток nether-end) на новом мире: портал у спавна (RPC portal),
// вход в Ад, дальше — вызовы разведки, как кампания: fortress {timeoutSeconds: 300} до TRIES раз (этап nether), потом
// fortress {mode: 'bastion'} (поиск бастиона этапа bastion). Ничего не трогаем, кроме разведки: меряем время до
// «крепость (ад)» / «бастион (ад)» в памяти, пройденное, смерти; правда — /locate по 9 регионам (для разбора).
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-scout.js   TRIES=4
//   WANT=fortress|bastion|both (both — сначала крепость, затем бастион)
const fs = require('fs')
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const path = require('path')
const { execFileSync } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ne-scout.jsonl')
const TRIES = Number(process.env.TRIES || 4)
const WANT = process.env.WANT || 'both'
const HIGH = process.env.HIGH === '1' // взгляд с вышки и радиус 128 (fortress high)
const KIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
  'stone_pickaxe 3', 'flint_and_steel', 'cooked_beef 16', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table',
  'oak_planks 16', 'stick 8', 'obsidian 10']

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
// Смерти с отметки — переживает полуночную перекладку latest.log (try-lab-ne-util.deaths, 03.10).
let _deathT = null
function deathLines (from) { if (!_deathT || _deathT.from !== from) _deathT = { from, f: require('./try-lab-ne-util').deaths(LOG, PLAYER, from) }; return _deathT.f() }
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}
function rcon (text) {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 90000 }) } catch (e) { return String(e.message) }
}
function locateNear (what, at) {
  let best = null
  for (const i of [-1, 0, 1]) {
    for (const j of [-1, 0, 1]) {
      const p = { x: (Math.floor(at.x / 432) + i) * 432 + 216, z: (Math.floor(at.z / 432) + j) * 432 + 216 }
      const out = rcon(`execute in minecraft:the_nether positioned ${p.x} 64 ${p.z} run locate structure minecraft:${what}`)
      const m = /\[(-?\d+), [^,]+, (-?\d+)\] \((\d+) blocks/.exec(out)
      if (!m) continue
      const r = { x: Number(m[1]), z: Number(m[2]) }
      r.dist = Math.round(Math.hypot(r.x - at.x, r.z - at.z))
      if (!best || r.dist < best.dist) best = r
    }
  }
  return best
}
async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {}).catch(() => null)
    if (st && st.state && st.state.dimension) return st.state
    await sleep(1500)
  }
  return {}
}
async function places () {
  const r = await call('recall', { lines: 1 }).catch(() => null)
  return (r && r.detail && r.detail.state && r.detail.state.places) || {}
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  await kit.cmd('/random reset *')
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', KEEPINV) // правило пользователя 02.10: боевой режим — false
  for (const d of ['the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  for (const g of KIT) { const [item, n] = g.split(' '); await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`) }
  await sleep(1000)
  await call('armor', {}).catch(() => null)
  for (let k = 0; k < 3; k++) {
    const pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ error: e.message }))
    if ((pr.detail && (pr.detail.lit || pr.detail.built)) || /горит/.test(JSON.stringify(pr))) break
  }
  await kit.cmd('/spawnpoint @s')
  let s0 = {}
  for (let k = 0; k < 2 && s0.dimension !== 'the_nether'; k++) {
    await call('portal', { mode: 'enter', timeoutSeconds: 180 }).catch(() => null)
    for (let w = 0; w < 10; w++) { s0 = await status(); if (s0.dimension === 'the_nether') break; await sleep(1000) }
  }
  if (s0.dimension !== 'the_nether') {
    const rec = { at: new Date().toISOString(), seed: seedOf(), ok: false, setupFail: true, stoppedBy: 'в Ад не вошёл' }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec)); process.exit(0)
  }
  const entry = { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) }
  const truth = { fortress: locateNear('fortress', entry), bastion: locateNear('bastion_remnant', entry) }
  const size = logSize()
  const t0 = gameClock.now()
  const marks = {}
  const calls = []
  const mark = async () => {
    const pl = await places()
    const m = Math.round((gameClock.now() - t0) / 6000) / 10
    if (pl['крепость (ад)'] && marks.fortress == null) { marks.fortress = m; marks.fortressAt = { x: pl['крепость (ад)'].x, z: pl['крепость (ад)'].z } }
    if (pl['бастион (ад)'] && marks.bastion == null) { marks.bastion = m; marks.bastionAt = { x: pl['бастион (ад)'].x, z: pl['бастион (ад)'].z } }
  }
  const run = async (params) => {
    const t = gameClock.now()
    const r = await call('fortress', params).catch(e => ({ error: e.message }))
    const d = r.detail || {}
    const st = await status()
    calls.push({ mode: params.mode || 'auto', s: Math.round((gameClock.now() - t) / 1000), found: !!d.found, walked: d.walked, looks: d.looks, stopped: String(d.stopped || r.error || '').slice(0, 100), at: st.pos ? { x: Math.round(st.pos.x), y: Math.round(st.pos.y), z: Math.round(st.pos.z) } : null })
    await mark()
    if ((st.health ?? 20) < 10) await call('eat', {}).catch(() => null)
  }
  await mark()
  if (WANT !== 'bastion') for (let k = 0; k < TRIES && marks.fortress == null && deathLines(size).length < 3; k++) await run({ timeoutSeconds: 300, ...(HIGH ? { high: true } : {}) })
  if (WANT !== 'fortress') for (let k = 0; k < TRIES && marks.bastion == null && deathLines(size).length < 3; k++) await run({ mode: 'bastion', timeoutSeconds: 420, ...(HIGH ? { high: true } : {}) })
  try { await call('stop') } catch {}
  const deaths = deathLines(size)
  const err = (a, b) => a && b ? Math.round(Math.hypot(a.x - b.x, a.z - b.z)) : null
  const rec = {
    at: new Date().toISOString(),
    seed: seedOf(),
    want: WANT,
    high: HIGH,
    ok: (WANT === 'bastion' || marks.fortress != null) && (WANT === 'fortress' || marks.bastion != null),
    minutes: Math.round((gameClock.now() - t0) / 6000) / 10,
    marks,
    entry,
    truth,
    seenVsTruth: { fortress: err(marks.fortressAt, truth.fortress), bastion: err(marks.bastionAt, truth.bastion) },
    deathCount: deaths.length,
    deaths,
    calls
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-scout окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
