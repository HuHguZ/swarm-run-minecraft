'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория куска «блейзы» (поток nether-end) на НОВОМ мире: крепость Ада ближайшая к 0,0 (/locate, только
// постановка), тело — командами на пол зала у спавнера (3..6 бл. сбоку, его уровень ±1; спавнер ищет правда мира —
// blocks_around, не зрение бота), набор KIT (std — как сквозная сцена; std+fr — ещё 3 зелья огнестойкости, как после
// бастиона). Дальше — ровно вызовы этапа nether кампании: blaze {rods: 7, timeoutSeconds: 400, box: false}, до TRIES раз,
// между ними — еда. Итог — строка JSON в LAB_OUT: стержни, секунды, смерти и причины, урон по типам.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… FARM_SLOT=N node try-lab-ne-blaze.js   KIT=std TRIES=3
//   APPROACH=1 — не ставить на пол зала, а с поверхности у старта крепости: сперва fortress mode=spawner (подход).
const fs = require('fs')
// keep_inventory: по умолчанию false (решение пользователя 02.10 — смерть в спидране = потеря вещей = провал прогона).
const KEEPINV = process.env.KEEPINV === 'true' ? 'true' : 'false'
const path = require('path')
const { execFileSync } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8821'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm21'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ne-blaze.jsonl')
const KIT_NAME = process.env.KIT || 'std'
const TRIES = Number(process.env.TRIES || 3)
const BASE = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots', 'shield', 'iron_sword', 'iron_pickaxe',
  'stone_pickaxe 2', 'flint_and_steel', 'cooked_beef 12', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table',
  'oak_planks 16', 'stick 8']
const KITS = {
  std: BASE,
  'std+fr': [...BASE, 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 3'],
  // bow — с огнестойкостью (сравнение с std+fr по одному признаку, разбор Codex ne-blaze.md п.3).
  bow: [...BASE, 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 3', 'bow', 'arrow 64'],
  // ls — набор слепого входа (try-lab-ne-run KIT=lightshield): брони нет, щит — бой у спавнера без брони (агент Ада 14.10).
  ls: ['shield', 'iron_sword', 'iron_pickaxe', 'stone_pickaxe 2', 'flint_and_steel', 'water_bucket', 'bucket',
    'cooked_mutton 8', 'cobblestone 64', 'cobbled_deepslate 64', 'crafting_table', 'oak_planks 8', 'stick 4']
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
const cnt = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)
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
      const r: Record<string, any> = { x: Number(m[1]), z: Number(m[2]) }
      r.dist = Math.round(Math.hypot(r.x - at.x, r.z - at.z))
      if (!best || r.dist < best.dist) best = r
    }
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
const SOLID = new Set(['o', 'B', 'n', 'b'])
// Клетка пола зала по срезу мира: ноги и голова — воздух, под ногами твёрдое, в 2..6 сбоку (помост MonsterThrone 5×5 — до 2.8), 0..−2 по высоте, без лавы рядом.
function hallCell (sl, sp) {
  const at = (x, y, z) => { const L = sl.layers[y]; if (!L) return '?'; const row = L[z - sl.z0]; return row ? row[x - sl.x0] || '?' : '?' }
  const out = []
  // Зал MonsterThrone: пол на 2 ниже спавнера (спавнер на помосте) — ноги на sp.y−2..sp.y.
  for (let dy = 0; dy >= -2; dy--) {
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        const h = Math.hypot(dx, dz)
        if (h < 1.9 || h > 6) continue
        const x = sp.x + dx; const y = sp.y + dy; const z = sp.z + dz
        if (at(x, y, z) !== '.' || at(x, y + 1, z) !== '.' || !SOLID.has(at(x, y - 1, z))) continue
        let lava = false
        for (let a = -2; a <= 2 && !lava; a++) for (let b = -2; b <= 1 && !lava; b++) for (let c = -2; c <= 2 && !lava; c++) if (at(x + a, y + b, z + c) === 'L') lava = true
        if (lava) continue
        out.push({ x, y, z, h })
      }
    }
  }
  return out.sort((a, b) => Math.abs(a.h - 3.5) - Math.abs(b.h - 3.5))[0] || null
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  const fail = why => {
    const rec = { at: new Date().toISOString(), seed: seedOf(), kit: KIT_NAME, ok: false, setupFail: true, stoppedBy: why }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec))
  }
  await kit.randomReset()
  // Постановка — в творческом: в выживании тело без набора стояло у спавнера под ифритами и гибло до замера (агент Ада 14.10:
  // blz-ls-1 — хп 18 → 9 → смерть при постановке, «нет пригодного оружия» в верхнем мире). Выживание — после набора, перед боем.
  await kit.cmd('/gamemode creative')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', KEEPINV) // правило пользователя 02.10: боевой режим — false
  for (const d of ['the_nether', 'the_end']) await kit.cmd(`/execute in minecraft:${d} run gamerule keep_inventory ${KEEPINV}`)
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  const F = locateNear('fortress', { x: 0, z: 0 })
  if (!F) { fail('крепости /locate не нашёл'); process.exit(0) }
  await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${F.x} ${F.z} 0 16 under 90 false @s`, { reply: /Spread|Could not/, ms: 30000 })
  await kit.ensureWorld('the_nether').catch(() => null)
  await sleep(6000)
  // Спавнер — правда мира (blocks_around find), для постановки сцены.
  let sp = null
  for (let k = 0; k < 6 && !sp; k++) {
    const r = await call('blocks_around', { find: 'spawner', radius: 160, count: 8 }).catch(() => null)
    const found = ((r && r.detail) || r || {} as Record<string, any>).found || []
    const me = (await status()).pos || { x: F.x, y: 64, z: F.z }
    sp = found.filter(p => p.y >= 40).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0] || null
    if (!sp) await sleep(3000)
  }
  if (!sp) { fail('спавнера в 160 бл. от старта крепости нет'); process.exit(0) }
  let place = null
  if (!process.env.APPROACH) {
    await kit.cmd(`/execute in minecraft:the_nether run tp @s ${sp.x + 0.5} ${sp.y + 3} ${sp.z + 6.5}`)
    await sleep(3000)
    const sl = await call('slice', { x0: sp.x - 8, x1: sp.x + 8, y0: sp.y - 4, y1: sp.y + 4, z0: sp.z - 8, z1: sp.z + 8 }).catch(() => null)
    const S = (sl && sl.detail) || sl
    place = S && S.layers ? hallCell(S, sp) : null
    if (!place) { fail(`пола зала у спавнера ${sp.x},${sp.y},${sp.z} не нашёл`); process.exit(0) }
    await kit.cmd(`/execute in minecraft:the_nether run tp @s ${place.x + 0.5} ${place.y} ${place.z + 0.5}`)
  }
  for (const g of KIT) {
    const m = /^(\S+)(?: (\d+))?$/.exec(g)
    await kit.cmd(`/give @s minecraft:${m[1]}${m[2] ? ' ' + m[2] : ''}`)
  }
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.cmd('/gamemode survival')
  await sleep(1500)
  await call('armor', {} as Record<string, any>).catch(() => null)
  if ((await status()).dimension !== 'the_nether') { fail('тело не в Аду перед боем (постановка)'); process.exit(0) }
  const size = logSize()
  const tc = gameClock.now()
  const steps = []
  let approach = null
  if (process.env.APPROACH) {
    const a = await call('fortress', { mode: 'spawner', timeoutSeconds: 300 }).catch(e => ({ error: e.message }))
    approach = { reached: !!(a.detail && a.detail.reached), dist: a.detail && a.detail.dist, stopped: a.detail && a.detail.stopped, s: Math.round((gameClock.now() - tc) / 1000) }
  }
  for (let k = 0; k < TRIES; k++) {
    const s0 = await status()
    if (cnt(s0.inventory, /^blaze_rod$/) >= 7) break
    if ((s0.food ?? 20) < 18) await call('eat', {} as Record<string, any>).catch(() => null)
    const t = gameClock.now()
    // Как кампания: без огнестойкости навык сам строит коробку с окном; BOX=0 — открытый бой (прежняя сцена).
    const r = await call('blaze', { rods: 7, timeoutSeconds: 400, ...(process.env.BOX === '0' ? { box: false } : {}) }).catch(e => ({ error: e.message }))
    const d = r.detail || {} as Record<string, any>
    steps.push({ s: Math.round((gameClock.now() - t) / 1000), code: r.code, rods: d.rods && d.rods.now, kills: Array.isArray(d.kills) ? d.kills.length : d.kills, stopped: String(d.stopped || r.error || '').slice(0, 160), dmg: d.damage && d.damage.byType })
    const s1 = await status()
    if (s1.dimension !== 'the_nether') break
    if (deathLines(size).length >= 1) break
  }
  try { await call('stop') } catch {}
  const s = await status()
  const deaths = deathLines(size)
  const rec = {
    at: new Date().toISOString(),
    seed: seedOf(),
    kit: KIT_NAME,
    approach,
    fortress: F,
    spawner: sp,
    place,
    ok: cnt(s.inventory, /^blaze_rod$/) >= 7,
    rods: cnt(s.inventory, /^blaze_rod$/),
    seconds: Math.round((gameClock.now() - tc) / 1000),
    deathCount: deaths.length,
    deaths,
    steps,
    hp: s.health,
    setupSeconds: Math.round((tc - t0) / 1000)
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ne-blaze окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
