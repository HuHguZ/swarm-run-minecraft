'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория «от спавна до горящего портала без алмазной кирки» (агент G, 02.10.2026, research/07-portal-techniques.md).
// Ферма, только слоты 29–30. Пара слотов с ОДНИМ сидом (farm up 2 --from 29 --fresh --seeds S,S), /random reset,
// тело на точке спавна мира (из level.dat), одинаковый набор; дальше без команд:
//   MODE=natural  — RPC portal_natural run (daemon/src/portal-natural.js: осмотр → высота → лучи → cast.js → поджиг);
//                   демону нужен ND_PORTAL_NATURAL=1;
//   MODE=baseline — как этап cast кампании сейчас: observe 48 → к лаве → portal cast; «не вижу лавы» — explore lava
//                   (48, шаг 60, 150 с); «места под раму нет» — отойти; до 6 заходов.
//   MODE=hint     — natural с подсказкой из скана копии этого же мира (good-v2.json, поле sky — по сиду слота;
//                   AGENTS.md: знание карты из копии мира разрешено): сразу к видимой лаве, без лучей вслепую.
// MODE=pair — слот 29 natural (HINT=1 — hint), слот 30 baseline (SWAP=1 — наоборот).
// keep_inventory=false (правило пользователя 02.10: боевой режим), смерть = провал: ok — портал горит и смертей 0.
// Итог — строка JSON в LAB_OUT: ok, seconds до поджига, minHp, смерти, что нашёл, шаги.
//   KIT — набор (по умолчанию: каменная кирка, ведро + ведро воды, огниво, булыжник 48, еда); LEGS — лучей у natural (8);
//   MINUTES — потолок (12).
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')
const nbt = require('prismarine-nbt')

const slot = Number(process.env.FARM_SLOT)
const WS = process.env.ND_WS
const PLAYER = process.env.MC_USERNAME
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-portal-natural.jsonl')
const MINUTES = Number(process.env.MINUTES || 12)
const KIT = (process.env.KIT || 'stone_pickaxe;stone_shovel;bucket;water_bucket;flint_and_steel;cobblestone 48;cooked_beef 16').split(';').map(x => x.trim()).filter(Boolean)
let MODE = process.env.MODE || 'pair'
if (MODE === 'pair') MODE = (slot === 29) !== (process.env.SWAP === '1') ? (process.env.HINT === '1' ? 'hint' : 'natural') : 'baseline'

if (!(slot === 29 || slot === 30) || WS !== `ws://127.0.0.1:${8800 + slot}` || PLAYER !== `NeuroFarm${slot}`) {
  console.error('только ферма, слоты 29–30 (агент G)')
  process.exit(1)
}

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
function deathLines (from) {
  try {
    const buf = fs.readFileSync(LOG, 'utf8').slice(from)
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in|advancement/.test(l) &&
      /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up|withered|suffocated|starved|froze|walked into|experienced/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const serverDir = path.join(__dirname, '..', 'farm', `server-${slot}`)
async function worldSpawn () {
  const { parsed } = await nbt.parse(fs.readFileSync(path.join(serverDir, 'world', 'level.dat')))
  const d = nbt.simplify(parsed).Data
  if (d.spawn && d.spawn.pos) return { x: d.spawn.pos[0], y: d.spawn.pos[1], z: d.spawn.pos[2] }
  return { x: d.SpawnX, y: d.SpawnY, z: d.SpawnZ }
}
function seedOf () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[slot].seed } catch { return null }
}

let minHp = 20
let lastState = null
// Где и когда терял здоровье (опрос status раз в 3 с): разбор урона без логов демона (pn-v3/pn-hint3 02.10, сид
// −1438…: −10 HP разом в саванне с обрывами).
const hpDrops = []
let t0Scene = null
let prevHp = 20
let prevPos = null
const track = r => {
  if (r && r.state) {
    lastState = r.state
    const hp = r.state.health
    if (typeof hp === 'number') {
      minHp = Math.min(minHp, hp)
      if (t0Scene && hp < prevHp - 0.5 && hpDrops.length < 12) hpDrops.push({ s: Math.round((gameClock.now() - t0Scene) / 1000), hp: Math.round(hp * 10) / 10, from: Math.round(prevHp * 10) / 10, pos: r.state.pos, before: prevPos })
      prevHp = hp
      prevPos = r.state.pos || prevPos
    }
  }
  return r
}
const act = async (method, params: any = {} as Record<string, any>) => track(await call(method, params).catch(e => ({ status: 'RPC', error: e.message })))

async function portalLit () {
  const r = await act('blocks_around', { find: 'nether_portal', radius: 48, count: 4 })
  return !!(r && r.detail && r.detail.found && r.detail.found.length)
}

// Как этап cast кампании (campaign.js, поверху): observe → к лаве → литьё; нет лавы — разведка.
async function baseline (deadline, steps, t0) {
  const mark = (what, extra: any = {} as Record<string, any>) => steps.push({ s: Math.round((gameClock.now() - t0) / 100) / 10, what, ...extra })
  let lava = null
  const seenLava = r => {
    const d = r && r.detail
    if (!d) return null
    const b = (Array.isArray(d.blocks) ? d.blocks : []).find(x => x && x.name === 'lava')
    if (b && b.nearest) return b.nearest
    if (d.found === 'lava' && d.at) return d.at
    return null
  }
  const o = await act('observe', { radius: 48 })
  lava = seenLava(o)
  mark('observe', { lava })
  const far = () => lava && lastState && lastState.pos && Math.hypot(lava.x - lastState.pos.x, lava.z - lastState.pos.z) > 16
  if (far()) { const g = await act('goto', { x: lava.x, y: lava.y, z: lava.z, range: 8, timeoutSeconds: 90 }); mark('goto', { status: g.status }) }
  for (let i = 0; i < 6 && gameClock.now() < deadline; i++) {
    const left = Math.round((deadline - gameClock.now()) / 1000)
    if (left < 30) break
    const r = await act('portal', { mode: 'cast', timeoutSeconds: Math.min(540, left) })
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    mark('cast', { status: r.status, built: r.detail && r.detail.built, lit: r.detail && r.detail.lit, why: why.slice(0, 120) })
    if (r.detail && r.detail.lit) return true
    if (await portalLit()) return true
    if (r.detail && r.detail.need) break
    if (/не вижу лавы/.test(why)) {
      if (lava && lastState && lastState.pos && Math.hypot(lava.x - lastState.pos.x, lava.y - lastState.pos.y, lava.z - lastState.pos.z) > 12 && i < 3) {
        const g = await act('goto', { x: lava.x, y: lava.y, z: lava.z, range: 8, timeoutSeconds: 90 }); mark('goto', { status: g.status }); continue
      }
      const e = await act('explore', { block: 'lava', radius: 48, stepDistance: 60, timeoutSeconds: Math.min(150, Math.max(20, Math.round((deadline - gameClock.now()) / 1000) - 10)) })
      const f = seenLava(e)
      mark('explore', { found: f })
      if (f) { lava = f; if (far()) { const g = await act('goto', { x: lava.x, y: lava.y, z: lava.z, range: 8, timeoutSeconds: 90 }); mark('goto', { status: g.status }) } }
      continue
    }
    if (/места под раму/.test(why) && lastState && lastState.pos) {
      const a = Math.PI / 2 * (i + 1)
      const g = await act('goto', { x: Math.round(lastState.pos.x + 12 * Math.cos(a)), z: Math.round(lastState.pos.z + 12 * Math.sin(a)), range: 3, timeoutSeconds: 40 })
      mark('отошёл', { status: g.status })
    }
  }
  return portalLit()
}

async function main () {
  await conn.ready
  await call('connect')
  if ((await call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
  await call('stop')
  // Подготовка (ферма): ГСЧ сброшен — копии мира независимы и одинаковы у пары; день, normal, keep_inventory=false.
  // level.dat у свежего мира пишется только при сохранении.
  await kit.cmd('/save-all flush')
  let sp = null
  for (let k = 0; k < 10 && !sp; k++) { try { sp = await worldSpawn() } catch { await sleep(1000) } }
  if (!sp) throw new Error('нет level.dat — спавн неизвестен')
  await kit.cmd('/gamemode creative')
  await kit.cmd(`/tp @s ${sp.x + 0.5} ${sp.y + 1} ${sp.z + 0.5}`)
  await sleep(3000)
  await kit.cmd('/random reset *')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'false')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/gamemode survival')
  await sleep(1500)
  const size = logSize()
  const t0 = gameClock.now()
  t0Scene = t0
  const deadline = t0 + MINUTES * 60000
  const steps = []
  // Опрос здоровья, пока идёт работа (status — мгновенный, тело не трогает).
  let polling = true
  const poller = (async () => { while (polling) { await act('status'); await sleep(3000) } })()
  let ok = false
  let detail = null
  try {
    if (MODE === 'natural' || MODE === 'hint') {
      const q: Record<string, any> = { mode: 'run', timeoutSeconds: MINUTES * 60 - 30, legs: Number(process.env.LEGS || 8) }
      if (MODE === 'hint') q.seed = seedOf()
      const r = await act('portal_natural', q)
      detail = r.detail || { status: r.status, error: r.error }
      if (r.detail && r.detail.steps) steps.push(...r.detail.steps)
      ok = !!(r.detail && r.detail.lit) || await portalLit()
      if (r.detail && r.detail.hintUsed) detail.hintUsed = r.detail.hintUsed
      // Не нашёл с поверхности — честно провал этой техники (дальше в кампании — путь вниз).
    } else {
      ok = await baseline(deadline, steps, t0)
    }
  } finally {
    polling = false
    await poller
  }
  const seconds = Math.round((gameClock.now() - t0) / 1000)
  try { await call('stop') } catch {}
  const st = await act('status')
  const deaths = deathLines(size)
  if (deaths.length) ok = false // keep_inventory=false: смерть — провал прогона
  const pick = steps.find(x => x.what === 'выбрал')
  const rec = {
    at: new Date().toISOString(),
    slot,
    seed: seedOf(),
    mode: MODE,
    ok,
    seconds,
    minutes: Math.round(seconds / 6) / 10,
    minHp,
    deaths: deaths.length,
    deathLines: deaths,
    spawn: sp,
    end: st.state ? { pos: st.state.pos, hp: st.state.health, dim: st.state.dimension, bag: st.state.inventory } : null,
    site: detail && detail.site ? detail.site : undefined,
    foundAt: pick ? pick.s : undefined,
    hpDrops: hpDrops.length ? hpDrops : undefined,
    hint: detail && detail.hintUsed ? detail.hintUsed : undefined,
    cast: detail && detail.cast ? detail.cast : undefined,
    stopped: detail && detail.stopped ? detail.stopped : undefined,
    steps: steps.slice(-30)
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify({ slot, mode: MODE, ok, seconds, minHp, deaths: deaths.length, site: rec.site && rec.site.kind, stopped: rec.stopped }))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-portal-natural окончена' }), gameClock.wall.sleep(8000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
