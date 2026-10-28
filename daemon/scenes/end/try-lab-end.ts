'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Сцена S5c (06.10) «выход из Ада → Энд (→ дракон)» на ферме: новый мир good-v2 (farm up --pool --fresh). Подготовка
// командами — только постановка: соль ГСЧ, normal, keep_inventory, утро. Тело само строит портал верхнего мира у спавна
// (RPC portal: после выхода из Ада тело стоит у своего портала) и получает набор «после PASS Ада» (KIT=post кампании
// без зелий): очи (пустые рамки + запас), остаток жемчуга, еда, кровати и обсидиан на дракона, 2 ведра воды, лодка,
// блоки, кирки, лук. Дальше без команд — campaign.js (граф): FindStronghold (броски ока или карта) → путь → комната →
// fill → вход в Энд [→ KillDragon при UNTIL=dragon]. Часы метрики — от старта кампании.
//   MAP_SH=1 — крепость Края из копии этого же мира (место у стены комнаты; очей — по пустым рамкам): знание карты,
//   пишется в главной метрике (AGENTS.md). Без него — вслепую (броски ока), отдельной строкой.
//   GRID=1 (при MAP_SH) — сетка Ада копии по коридору спавн → крепость /8 (ход ne_route; CENV ND_NE_ROUTE=1).
//   UNTIL=end (умолч.) | dragon; MINUTES (40); EYES — очей (умолч. пустые рамки + 2, вслепую 14); EYES_RAW=1 — вместо очей
//   жемчуг и стержни на них; PEARLS (2); BEDS (5);
//   KEEPINV=false; DEATHS_MAX=1; CAMPAIGN=campaign.js; CENV='{"ND_X":"1"}' — env кампании; EXTRA — добавка к набору.
// Итог — строка JSON в LAB_OUT: ok, отметки (минуты: крепость в памяти, комната, Энд, дракон), очей потрачено, смерти,
// средний темп (игровые тики демона / реальные секунды).
import * as fs from 'fs'
import path = require('path')
import { spawn, execFileSync } from 'child_process'
import { connect, createKit, sleep } from '../lib/scene-kit'

const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-end.jsonl')
// UNTIL=room (end2 sr27): до комнаты портала (место «портал в Край» в памяти); START=sh — старт у лестницы крепости (постановка:
// /locate = куда ведёт око, тело на поверхности над углом чанка старта +4) — мерить поиск комнаты, а не путь к крепости.
const UNTIL = process.env.UNTIL === 'dragon' ? 'dragon' : process.env.UNTIL === 'room' ? 'room' : 'end'
const MINUTES = Number(process.env.MINUTES || (UNTIL === 'dragon' ? 60 : 40))
const DEATHS_MAX = Number(process.env.DEATHS_MAX || 1)
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const MAP_SH = process.env.MAP_SH === '1'
let CENV: Record<string, any> = {}
try { CENV = JSON.parse(process.env.CENV || '{}') } catch {}

// KIT_SET=real — что реально выносит Ад после бартера (поток ne 21.10: брони нет, кроме золотых ботинок; каменный меч, кирка
// железная; обсидиан бартера OBS (умолч. 10; 0 — без бартера), одно ведро воды; кроватей и лодки нет — их собирает этап endkit).
const KIT = [...(process.env.KIT_SET === 'real'
  ? ['golden_boots', 'shield', 'stone_sword', 'stone_axe', 'iron_pickaxe', 'stone_pickaxe', 'water_bucket', 'flint_and_steel',
    'cooked_porkchop 8', 'cobblestone 64', 'netherrack 64', 'crafting_table', 'oak_planks 8', 'stick 4',
    `obsidian ${process.env.OBS ?? 10}`, 'string 6', 'spectral_arrow 12', 'fire_charge 3', 'gold_ingot 6', `ender_pearl ${process.env.PEARLS || 0}`]
  : ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
  'stone_pickaxe 2', 'water_bucket 2', 'flint_and_steel', 'cooked_beef 16', 'cobblestone 64', 'cobbled_deepslate 64',
  'crafting_table', 'oak_planks 16', 'stick 8', `white_bed ${process.env.BEDS || 5}`, 'obsidian 4', 'oak_boat',
  'bow', 'spectral_arrow 64', 'torch 16', `ender_pearl ${process.env.PEARLS || 2}`]),
  // EXTRA="obsidian 10,flint_and_steel" — что ещё принёс Ад (обсидиан бартера на раму выхода у крепости: CENV ND_SH_NETHER=1).
  ...String(process.env.EXTRA || '').split(',').map(x => x.trim()).filter(Boolean)]

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
let deathsOf = null
const deathLines = from => (deathsOf || (deathsOf = (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).deaths(LOG, PLAYER, from)))()
const cnt = (inv, re) => Object.entries<any>(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
const seedOf = () => { try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null } }
const rcon = text => {
  if (!process.env.FARM_SLOT) return ''
  try { return execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'farm', 'farm.js'), 'rcon', process.env.FARM_SLOT, text], { encoding: 'utf8', timeout: 90000 }) } catch (e) { return String(e.message) }
}
async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {}).catch(() => null)
    if (st && st.state && st.state.dimension) return st.state
    await sleep(1500)
  }
  return {} as Record<string, any>
}
// Дракон мёртв — по серверу: дракона нет и выходной портал горит (его ставят только после смерти дракона).
function dragonDead () {
  if (!/failed/i.test(rcon('execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon]'))) return false
  for (let y = 50; y <= 75; y++) if (/passed/i.test(rcon(`execute in minecraft:the_end if block 1 ${y} 0 minecraft:end_portal`))) return true
  return false
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const size = logSize()
  const rngSalt = await kit.randomReset()
  await kit.cmd('/gamemode creative')
  await kit.setDifficulty('normal')
  for (const d of ['overworld', 'the_nether', 'the_end']) {
    await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
    await kit.cmd(`/execute in minecraft:${d} run gamerule spawn_mobs ${d === 'overworld' ? 'false' : 'true'}`)
  }
  await kit.cmd('/execute in minecraft:overworld run gamerule advance_time false')
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s'); await kit.cmd('/effect clear @s'); await kit.cmd('/time set 1000')
  await kit.cmd('/give @s minecraft:obsidian 10'); await kit.cmd('/give @s minecraft:flint_and_steel'); await kit.cmd('/give @s minecraft:cobblestone 16')
  await sleep(1500)
  // Портал верхнего мира — сам (тот же RPC, что этап portal кампании): старт «у своего портала после Ада».
  // Нет места под раму у спавна (s5c-f2: 5 из 7 «Места под раму нет» — портала нет, граф без «portal» уходил в cast/diamond) —
  // другое место в 12 бл. на поверхности (spreadplayers — постановка сцены), до 4 мест.
  let pr = null
  let portalOk = false
  const p0 = (await status()).pos || { x: 0, z: 0 }
  // PORTAL_FILL=1 (умолч., sr27-end 27.10): портал «после Ада» — постановкой: рама командами на расчищенной площадке у спавна,
  // проход туда и обратно — телепортом в раму (портал прибытия в Аду ставит сам сервер, как после настоящего выхода). Прежняя
  // постройка телом (PORTAL_FILL=0) в 8 из 11 прогонов давала «рама горит, но войти/выйти не вышло» — тело шло к крепости
  // пешком 1300+ бл., и замер мерил не то.
  if (process.env.PORTAL_FILL !== '0') {
    const x0 = Math.floor(p0.x) + 3; const y0 = Math.floor(p0.y ?? 70); const z0 = Math.floor(p0.z)
    // Вода/лава у площадки — камнем (спавн у воды: расчищенный воздух заливало, q-A −9170 «slain by Drowned» на 3-й мин).
    for (const fl of ['water', 'lava']) await kit.cmd(`/fill ${x0 - 5} ${y0 - 2} ${z0 - 5} ${x0 + 8} ${y0 + 6} ${z0 + 5} minecraft:stone replace minecraft:${fl}`)
    await kit.cmd(`/fill ${x0 - 3} ${y0 - 1} ${z0 - 3} ${x0 + 6} ${y0 - 1} ${z0 + 3} minecraft:stone`)
    await kit.cmd(`/fill ${x0 - 3} ${y0} ${z0 - 3} ${x0 + 6} ${y0 + 5} ${z0 + 3} minecraft:air`)
    await kit.cmd(`/fill ${x0} ${y0} ${z0} ${x0 + 3} ${y0 + 4} ${z0} minecraft:obsidian`)
    await kit.cmd(`/fill ${x0 + 1} ${y0 + 1} ${z0} ${x0 + 2} ${y0 + 3} ${z0} minecraft:air`)
    await kit.cmd(`/setblock ${x0 + 1} ${y0 + 1} ${z0} minecraft:fire`)
    await sleep(1000)
    const lit = /passed/i.test(rcon(`execute in minecraft:overworld if block ${x0 + 1} ${y0 + 1} ${z0} minecraft:nether_portal`))
    if (lit) {
      await kit.cmd('/gamemode survival')
      // Проход — самим телом (портал «портал»/«портал (ад)» ложится в память, как у вышедшего из Ада); не вышло — телепортом в раму.
      await kit.cmd(`/tp @s ${x0 + 1.5} ${y0} ${z0 - 1.5}`)
      await sleep(1000)
      await call('portal', { mode: 'enter', timeoutSeconds: 60 }).catch(() => null)
      let inNether = (await status()).dimension === 'the_nether'
      if (!inNether) {
        await kit.cmd(`/tp @s ${x0 + 1.5} ${y0 + 1} ${z0 + 0.5}`)
        try { await kit.ensureWorld('the_nether', { seconds: 30 }); inNether = true } catch {}
      }
      if (inNether) await call('portal', { mode: 'enter', timeoutSeconds: 60 }).catch(() => null)
      if ((await status()).dimension !== 'overworld') await kit.ensureWorld('overworld', { tp: `${x0 + 1.5} ${y0} ${z0 - 1.5}`, seconds: 30 })
      await kit.cmd('/gamemode creative')
      portalOk = inNether
      pr = { detail: { note: inNether ? 'рама горит (постановка)' : undefined, stopped: inNether ? undefined : 'в Ад телепортом в раму не перешёл' } }
    } else pr = { detail: { stopped: 'рама командами не зажглась' } }
  }
  for (let k = 0; k < 4 && !portalOk; k++) {
    if (k) {
      await kit.cmd(`/spreadplayers ${Math.round(p0.x + 12 * Math.sin(k * 2.1))} ${Math.round(p0.z + 12 * Math.cos(k * 2.1))} 0 4 false @s`)
      await sleep(2500)
      await kit.cmd('/give @s minecraft:obsidian 10'); await kit.cmd('/give @s minecraft:flint_and_steel'); await kit.cmd('/give @s minecraft:cobblestone 16')
      await sleep(800)
    }
    pr = await call('portal', { timeoutSeconds: 240 }).catch(e => ({ status: 'failed', error: e.message }))
    portalOk = /горит/.test(String(pr?.detail?.note || '') + String(pr?.detail?.stopped || ''))
    // Тело «вышло из Ада» этим порталом — значит, в него можно войти: туда и обратно (s5d-p5-3: рама горит, «К порталу не
    // подойти» — кампания пошла пешком). Заодно сервер ставит портал прибытия в Аду, как после настоящего Ада. PORTAL_CHECK=0 — выкл.
    if (portalOk && process.env.PORTAL_CHECK !== '0') {
      // В выживании, как кампания: в творческом вход мгновенный и проходит там, где ход тела к порогу не пройдёт (s5d-p6-2).
      await kit.cmd('/gamemode survival')
      await call('portal', { mode: 'enter', timeoutSeconds: 60 }).catch(() => null)
      const inNether = (await status()).dimension === 'the_nether'
      if (inNether) await call('portal', { mode: 'enter', timeoutSeconds: 60 }).catch(() => null)
      const back = (await status()).dimension === 'overworld'
      if (!back) await kit.ensureWorld('overworld', { tp: `${Math.round(p0.x)} ${Math.round(p0.y ?? 90)} ${Math.round(p0.z)}`, seconds: 30 })
      await kit.cmd('/gamemode creative')
      portalOk = inNether && back
      if (!portalOk) pr = { detail: { stopped: `рама горит, но ${inNether ? 'обратно не вышел' : 'войти не вышло'}` } }
    }
  }
  const s0 = await status()
  if (s0.dimension !== 'overworld') await kit.ensureWorld('overworld', {})
  await kit.cmd('/spawnpoint @s')
  const start = s0.pos ? { x: Math.round(s0.pos.x), z: Math.round(s0.pos.z) } : { x: 0, z: 0 }
  // Крепость Края из копии мира (MAP_SH) или вслепую.
  let shMap = null
  let need = 12
  if (MAP_SH && process.env.FARM_SLOT) {
    const sm: Awaited<ReturnType<typeof import('../lib/try-lab-ne-map').strongholdMap>> = await (require('../lib/try-lab-ne-map') as typeof import('../lib/try-lab-ne-map')).strongholdMap(Number(process.env.FARM_SLOT), start).catch(e => ({ error: e.message }))
    shMap = { start: sm.start, room: sm.room && sm.room.center, frames: sm.frames, eyes: sm.eyes, need: sm.need, error: sm.error }
    if (Number.isFinite(sm.need)) need = Math.max(1, sm.need)
    if (sm.place) {
      const w = await call('fortress', { mode: 'map', places: { крепость: sm.place }, timeoutSeconds: 30 }).catch(e => ({ error: e.message }))
      shMap.mapped = (w.detail && w.detail.mapped) || w.error || null
    }
    console.log('крепость Края (карта копии)', JSON.stringify(shMap))
  }
  // GRID=1 (при MAP_SH) — сетка Ада из копии мира по коридору «портал спавна /8 → комната /8» (как у try-lab-ne-run:
  // ход по Аду без лавы и обрывов, nether-route; кампании — CENV ND_NE_ROUTE=1). Знание карты — в главной метрике.
  let gridInfo = null
  if (MAP_SH && process.env.GRID === '1' && process.env.FARM_SLOT && shMap && (shMap.room || shMap.start)) {
    const tg = gameClock.wall.now()
    const ex = shMap.room || shMap.start
    const pts = [{ x: Math.floor(start.x / 8), z: Math.floor(start.z / 8) }, { x: Math.floor(ex.x / 8), z: Math.floor(ex.z / 8) }]
    try {
      const M: typeof import('../lib/try-lab-ne-map') = require('../lib/try-lab-ne-map')
      const r = await M.netherGrid(Number(process.env.FARM_SLOT), M.corridorRects(pts, 40), {})
      ;(require('../../src/nether-grid') as typeof import('../../src/nether-grid')).save(path.join(REPO_ROOT, 'farm', `memory-${process.env.FARM_SLOT}`), r.grid, { pts })
      gridInfo = { seconds: Math.round((gameClock.wall.now() - tg) / 1000), chunks: r.chunks, loaded: r.loaded, cells: r.grid.data.length, pts }
    } catch (e) { gridInfo = { error: e.message } }
    console.log('сетка Ада (копия)', JSON.stringify(gridInfo))
  }
  const eyes = Number(process.env.EYES || (MAP_SH ? need + 2 : 14))
  // Портал строился в creative (блоки не тратятся) — остаток обсидиана/огнива убрать: набор ровно «после Ада».
  await kit.cmd('/clear @s')
  // EYES_RAW=1 — очи не готовые, а «набор на очи», как выносит Ад: жемчуг и стержни (крафт — этап eyes кампании).
  const eyeKit = process.env.EYES_RAW === '1' ? [`ender_pearl ${eyes}`, `blaze_rod ${Math.ceil(eyes / 2)}`] : [`ender_eye ${eyes}`]
  for (const g of [...KIT, ...eyeKit]) { const [item, n] = g.split(' '); await kit.cmd(`/give @s minecraft:${item}${n ? ' ' + n : ''}`) }
  await kit.cmd('/gamemode survival')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true'); await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(1500)
  await call('armor', {}).catch(() => null)
  await kit.cmd('/execute in minecraft:overworld run gamerule spawn_mobs true')
  await kit.cmd('/execute in minecraft:overworld run gamerule advance_time true')
  await kit.cmd('/time set 1000')
  const truth = (() => { const m = /\[(-?\d+), [^,]+, (-?\d+)\] \((\d+) blocks/.exec(rcon(`execute in minecraft:overworld positioned ${start.x} 70 ${start.z} run locate structure minecraft:stronghold`)); return m ? { x: +m[1], z: +m[2], dist: +m[3] } : null })()
  if (process.env.START === 'sh' && truth) {
    await kit.cmd('/gamemode creative')
    await kit.cmd(`/spreadplayers ${truth.x + 4} ${truth.z + 4} 0 3 false @s`)
    await sleep(4000)
    await kit.cmd('/spawnpoint @s')
    await kit.cmd('/gamemode survival')
    await kit.cmd('/time set 1000')
    await sleep(1000)
  }
  const inv0 = (await status()).inventory || {}
  const eyes0 = process.env.EYES_RAW === '1' ? eyes : cnt(inv0, /^ender_eye$/)

  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const tc = gameClock.now()
  const wallTc = gameClock.wall.now()
  const clock0 = (await call('status')).state?.clock || gameClock.snapshot()
  const child = spawn(process.execPath, [CAMPAIGN], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ND_WATCHDOG_MIN: String(MINUTES + 5), ND_EYES_NEED: String(need), ND_WORLD_SEED: String(seedOf() ?? ''), ...CENV },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  const marks: Record<string, number> = {}
  const mark = k => { if (marks[k] == null) marks[k] = Math.round((gameClock.now() - tc) / 6000) / 10 }
  let stoppedBy = 'время'
  let eyesAtEnd = null
  let lastCheck = 0
  let wallSeen = { game: gameClock.now(), wall: gameClock.wall.now() }
  const until = tc + MINUTES * 60000
  while (gameClock.now() < until) {
    await Promise.race([sleep(5000), gameClock.wall.sleep(15000)])
    if (gameClock.now() > wallSeen.game) wallSeen = { game: gameClock.now(), wall: gameClock.wall.now() }
    else if (gameClock.wall.now() - wallSeen.wall > 90000) { stoppedBy = 'игровые часы стоят 90 с реального времени'; break }
    if (gameClock.now() - lastCheck > 10000 || exited !== null) {
      lastCheck = gameClock.now()
      const s = await status()
      const rc = await call('recall', { lines: 1 }).catch(() => null)
      const pl = rc?.detail?.state?.places || {}
      if (pl['крепость']) mark('stronghold')
      if (pl['портал в Край']) { mark('room'); if (UNTIL === 'room') { stoppedBy = 'комната'; break } }
      if (s.dimension === 'the_end') {
        if (marks.end == null) rcon('execute in minecraft:the_end run forceload add -16 -16 15 15') // центр острова — для проверки дракона и после ухода тела
        mark('end')
        if (eyesAtEnd === null) eyesAtEnd = cnt(s.inventory, /^ender_eye$/)
        if (UNTIL === 'end') { stoppedBy = 'в Энде'; break }
      }
      // Убит — по серверу; после убийства тело обычно падает в выходной портал и уже наверху (титры → respawn).
      if (UNTIL === 'dragon' && marks.end != null && dragonDead()) { mark('dragon'); stoppedBy = 'дракон убит'; break }
    }
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    if (deathLines(size).length >= DEATHS_MAX) { stoppedBy = `смертей ${deathLines(size).length}`; break }
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (/БЛОКЕР/.test(text)) { stoppedBy = (text.match(/БЛОКЕР[^\n]{0,160}/) || ['БЛОКЕР'])[0]; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  if (marks.end != null) rcon('execute in minecraft:the_end run forceload remove -16 -16 15 15')
  try { await call('stop') } catch {}
  const wallSeconds = (gameClock.wall.now() - wallTc) / 1000
  const clock1 = (await call('status')).state?.clock || gameClock.snapshot()
  if (UNTIL === 'dragon' && marks.dragon == null && marks.end != null && dragonDead()) { mark('dragon'); stoppedBy = 'дракон убит' }
  const s = await status()
  const deaths = deathLines(size)
  const ticks = clock0 && clock1 ? clock1.ticks - clock0.ticks : null
  const ok = deaths.length === 0 && (UNTIL === 'dragon' ? marks.dragon != null : UNTIL === 'room' ? marks.room != null : marks.end != null)
  const rec = {
    at: new Date().toISOString(), scene: 'try-lab-end', until: UNTIL, seed: seedOf(), mapSh: MAP_SH, blind: !MAP_SH, ok, stoppedBy,
    minutes: Math.round((gameClock.now() - tc) / 6000) / 10, marks, endMin: marks.end ?? null, dragonMin: marks.dragon ?? null,
    eyes0, eyesAtEnd, eyesSpent: eyesAtEnd === null ? null : eyes0 - eyesAtEnd, need, shMap, grid: gridInfo, truth, start,
    deathCount: deaths.length, deaths, health: s.health ?? null, dimension: s.dimension ?? null, pos: s.pos ?? null,
    wallSeconds, ticks, tempo: ticks && wallSeconds ? Math.round(ticks / wallSeconds) : null, tickRate: clock1?.tickRate ?? null,
    portal: portalOk, portalWhy: portalOk ? undefined : String(pr && (pr.error || pr.detail?.stopped || pr.detail?.note) || '').slice(0, 200), rngSalt, exitCode: exited, campaignLog: clog
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}

main().catch(e => {
  console.error('СЦЕНА УПАЛА:', e && e.stack || e)
  try { fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), scene: 'try-lab-end', ok: false, setupFail: true, error: String(e && e.message || e) }) + '\n') } catch {}
  process.exit(1)
})
