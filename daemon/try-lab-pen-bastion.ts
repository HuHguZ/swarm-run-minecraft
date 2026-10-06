'use strict'
// Лаборатория S2 (06.10.2026): загон пиглинов в настоящем бастионе. Командами — только постановка: /locate бастиона,
// место ямы (сцена по срезу мира ищет клетку пола у пиглинов, где penPlan строит загон, и вырезает P/H/M яму со ртом
// /fill — копку ямы в кампании делает bastion.digPit, это не предмет опыта), броня, кирка, булыжник, слитки.
// Дальше — RPC pen {mode, capture, timeoutSeconds}: стройка, люки, приманки и торг — честно, прицелом.
//   node farm/farm.js run try-lab-pen-bastion.js --slots 31 --tag s2-bast01 RUNS=3 GOLD=128 SECONDS=240
// ORIGIN0=x,z — откуда искать первый бастион (дальше +STEP по x на попытку), MODE=pen|pit (ALT=1 — чередовать по k:
// нечётные pen, чётные pit). RESUME=1 (S2b): пакет BATCH1 слитков → уход «копать» (RPC pen away: штрек назад BACK и
// вбок SIDE, пауза AWAY игровых с) → возврат → второй пакет (остаток) за SECONDS2. Итоги — pen, away, pen2.
const gameClock = require('./src/game-clock')
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')

const USED = new Set((process.env.SKIP_BASTIONS || '').split(';').filter(Boolean))
const env = (k, d) => process.env[k] != null && process.env[k] !== '' ? process.env[k] : d

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  await conn.call('connect')
  if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
  for (let k = 1; k <= Number(env('RUNS', 1)); k++) {
    const mode = env('ALT', '') === '1' ? (k % 2 ? 'pen' : 'pit') : env('MODE', 'pen')
    const result: Record<string, any> = { lab: 'pen-bastion', slot, k, mode, ok: false }
    try { Object.assign(result, await once(conn, k, mode)) } catch (e) { result.error = e.message }
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    const brief = d => d && { stopped: d.stopped, penned: d.penned, captured: d.captured, penMax: d.penMax, penNow: d.penNow, handed: d.handed, tossed: d.tossed, spent: d.spent, secs: d.seconds,
      del: `${d.barterDelivered}/${d.barterReceipts}`, perIngot: d.perIngot ?? (d.spent ? +(d.barterDelivered / d.spent).toFixed(3) : null), pen: d.fromPen && `${d.fromPen.delivered}/${d.fromPen.receipts}`, pearls: d.pearls, hpMin: d.hpMin, angry: d.angry }
    const a = result.away
    console.log(JSON.stringify({ k, mode, bastion: result.bastion, spot: result.spot, near: result.near, lanes: result.lanes, ok: result.ok, error: result.error, p1: brief(result.pen), away: a && { ok: a.ok, back: a.back, side: a.side, secs: a.awaySecs, leave: a.atLeave, far: a.atFar, ret: a.atReturn, hpMin: a.hpMin }, p2: brief(result.pen2), dead: result.dead, tps: result.tps }))
  }
  try { await conn.call('disconnect') } catch {}
  conn.close()
}

// Классы sealed по символам среза (index.ts slice; g — gilded_blackstone, h — твёрдое навсегда).
function classifier (SL, sl) {
  return (x, y, z) => {
    const rows = sl.layers[y]; if (!rows) return SL.UNKNOWN
    const row = rows[z - sl.z0]; if (!row) return SL.UNKNOWN
    const c = row[x - sl.x0]
    if (c === '.') return SL.AIR
    if (c === 'L' || c === 'W') return SL.FLUID
    if (c === 'G' || c === 'C' || c === 'g') return SL.GUARD
    if (c === 'h') return SL.HARD
    if (c === 's' || c === 'p') return SL.PARTIAL // p — песок душ: у pitHere пол под O не SOLID-по-имени не считается (s2b-alt02 k=11)
    if (c === 'f') return SL.FALL
    if (c === 'B' || c === 'b' || c === 'n' || c === 'o') return SL.SOLID
    return SL.UNKNOWN // ',' — огонь, цепь, лоза: не трогаем
  }
}

// Место ямы у пиглинов: клетка пола O (воздух ×2, под ней твёрдое), рот M = O − d в стене; P/H/M вырезаются командой,
// поэтому для penPlan они воздух. Стенки ямы и рта — твёрдые. Лучшее — больше пиглинов в 8 бл. от O, брутов/хоглинов в 12 нет.
function findSpot (SL, PT, sl, piglins, foes) {
  const cls0 = classifier(SL, sl)
  const firm = c => c === SL.SOLID || c === SL.HARD
  let best = null
  for (const y of Object.keys(sl.layers).map(Number)) {
    for (let z = sl.z0 + 2; z < sl.z0 + sl.layers[y].length - 2; z++) {
      for (let x = sl.x0 + 2; x < sl.x0 + sl.layers[y][0].length - 2; x++) {
        if (cls0(x, y, z) !== SL.AIR || cls0(x, y + 1, z) !== SL.AIR || !firm(cls0(x, y - 1, z))) continue
        const near = piglins.filter(p => Math.hypot(p[1] - x, p[3] - z) <= 6 && Math.abs(p[2] - y) <= 2).length
        if (near < Number(env('MINNEAR', 2)) || (best && near < best.near)) continue
        if (foes.some(p => Math.hypot(p[1] - x, p[3] - z) <= 12 && Math.abs(p[2] - y) <= 6)) continue
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const M = { x: x - dx, y, z: z - dz }; const H = { x: M.x, y: y - 1, z: M.z }; const P = { x: M.x, y: y - 2, z: M.z }
          const px = dz; const pz = dx
          const cut = new Set([M, H, P].map(q => `${q.x},${q.y},${q.z}`))
          if (![M, H, P].every(q => cls0(q.x, q.y, q.z) === SL.SOLID)) continue
          const walls = [[M.x, y + 1, M.z], [P.x, P.y - 1, P.z], ...[M, H, P].flatMap(q => [[q.x + px, q.y, q.z + pz], [q.x - px, q.y, q.z - pz], [q.x - dx, q.y, q.z - dz]])]
          if (!walls.every(([a, b, c]) => firm(cls0(a, b, c)))) continue
          const cls = (a, b, c) => cut.has(`${a},${b},${c}`) ? SL.AIR : cls0(a, b, c)
          const plan = PT.penPlan({ P, H, M, O: { x, y, z }, d: [dx, dz] }, cls)
          if (!plan.lanes || plan.lanes.length < Number(env('MINLANES', 1))) continue
          if (best && near === best.near && plan.lanes.length <= best.lanes) continue
          best = { near, P, H, M, O: { x, y, z }, d: [dx, dz], lanes: plan.lanes.length }
          break
        }
      }
    }
  }
  return best
}

async function once (conn, k, mode) {
  const call = conn.call
  const SL = require('./src/sealed'); const PT = require('./src/bastion/pen-trap')
  const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const GOLD = Number(env('GOLD', 128))
  const nether = 'the_nether'
  for (let i = 0; i < 40; i++) { const st = await call('status'); if ((st.state && st.state.health) > 0) break; await sleep(250) }
  await kit.cmd('/gamemode creative')
  await kit.gamerule('spawn_mobs', 'true')
  await kit.gamerule('keep_inventory', 'false')
  const [ox, oz] = env('ORIGIN0', '-1500,-1500').split(',').map(Number)
  const step = Number(env('STEP', 700))
  // Тот же бастион, что в прошлой попытке этой сцены (ближайший к соседним точкам), — сдвиг дальше по x.
  let bx = 0; let bz = 0
  for (let shift = 0; shift < 4; shift++) {
    const at = `${ox + step * (k - 1) + shift * Math.round(step / 2)} 64 ${oz}`
    const loc = await call('ask', { command: `/execute in minecraft:${nether} positioned ${at} run locate structure minecraft:bastion_remnant`, match: 'nearest|Could not', ms: 30000 })
    const line = ((loc && loc.detail && loc.detail.lines) || []).find(l => /nearest/.test(l)) || ''
    const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
    if (!m) throw new Error('бастион не найден: ' + line.slice(0, 120))
    bx = Number(m[1]); bz = Number(m[3])
    if (!USED.has(`${bx},${bz}`)) break
  }
  if (USED.has(`${bx},${bz}`)) throw new Error(`бастион ${bx},${bz} уже был`)
  USED.add(`${bx},${bz}`)
  await kit.ensureWorld(nether, { tp: `${bx + 0.5} 118 ${bz + 0.5}` })
  await sleep(4000)
  const snap = async () => ((await call('slice', { x0: bx, x1: bx, y0: 0, y1: 0, z0: bz, z1: bz, mobs: true })).detail || {}).mobs || []
  const first = await snap(); await sleep(4000)
  const all = await snap()
  const piglins = [...first, ...all].filter(e => e[0] === 'piglin' && Math.hypot(e[1] - bx, e[3] - bz) < 64)
  const foes = all.filter(e => /^(piglin_brute|hoglin|zoglin|magma_cube|ghast|wither_skeleton|blaze)$/.test(e[0]))
  let spot = null
  for (const p of [...piglins].sort((a, b) => piglins.filter(q => Math.hypot(q[1] - b[1], q[3] - b[3]) < 8).length - piglins.filter(q => Math.hypot(q[1] - a[1], q[3] - a[3]) < 8).length).slice(0, 6)) {
    const sl = (await call('slice', { x0: p[1] - 9, x1: p[1] + 9, y0: p[2] - 4, y1: p[2] + 3, z0: p[3] - 9, z1: p[3] + 9, mark: { gilded_blackstone: 'g', nether_gold_ore: 'g', gold_ore: 'g', bedrock: 'h', ancient_debris: 'h', obsidian: 'h', crying_obsidian: 'h', respawn_anchor: 'h', spawner: 'h', gravel: 'f', sand: 'f', magma_block: 'f', soul_sand: 'p', soul_soil: 'o' } })).detail
    const s = findSpot(SL, PT, sl, piglins, foes)
    if (s && (!spot || s.near > spot.near)) spot = s
  }
  const base = { bastion: `${bx},${bz}`, piglins: piglins.length, foes: foes.map(f => f[0]).join(',') }
  if (!spot) return { ...base, error: 'места для загона у пиглинов нет' }
  const { P, M, d } = spot
  await kit.must(`/execute in minecraft:${nether} run fill ${P.x} ${P.y} ${P.z} ${M.x} ${M.y} ${M.z} minecraft:air`, /^Successfully filled 3 block/, 'яма не вырезана')
  await kit.cmd('/clear @s')
  for (const g of ['iron_pickaxe', 'iron_sword', 'cobblestone 64', 'cooked_beef 16', `gold_ingot ${GOLD}`]) await kit.cmd(`/give @s minecraft:${g}`)
  for (const [s, item] of [['head', 'golden_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) await kit.must(`/item replace entity @s armor.${s} with minecraft:${item}`, /^Replaced a slot on /, `броня ${s}`)
  const yaw = d[0] === 1 ? -90 : d[0] === -1 ? 90 : d[1] === 1 ? 0 : 180
  await kit.must(`/execute in minecraft:${nether} run tp @s ${P.x + 0.5} ${P.y} ${P.z + 0.5} ${yaw} 0`, /^Teleported /, 'тело не в яме')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.cmd('/gamemode survival')
  const salt = await kit.randomReset()
  await sleep(1500)
  const h0 = await call('status'); const clock0 = h0.state && h0.state.clock
  // Смерти — по строкам сервера (хп в конце обманет: тело успеет возродиться).
  const logMark = kit.serverLog.mark()
  const wall0 = gameClock.wall.monotonic(); const t0 = gameClock.now()
  const resume = env('RESUME', '') === '1'
  const penArgs = { mode, capture: env('CAPTURE', 'gather'), penMax: Number(env('PENMAX', 6)), catchSeconds: Number(env('CATCH', 90)) }
  const r = await call('pen', { ...penArgs, timeoutSeconds: Number(env('SECONDS', 240)), keep: resume ? Math.max(0, GOLD - Number(env('BATCH1', 64))) : 0 })
  let away = null; let r2 = null
  if (resume && r.status === 'done' && (r.detail || {}).spent > 0) {
    // Уход «копать»: свой замкнутый штрек назад и вбок, пауза, возврат; второй пакет — у того же места (загон — penHere).
    const awaySecs = Number(env('AWAY', 90))
    const a = await call('pen', { mode: 'away', back: Number(env('BACK', 2)), side: Number(env('SIDE', 6)), seconds: awaySecs, timeoutSeconds: awaySecs + 60 })
    away = a.detail || { error: a.error, status: a.status }
    if (away.ok) {
      const own = [...((r.detail || {}).own || []), ...(away.own || [])]
      const b = await call('pen', { ...penArgs, timeoutSeconds: Number(env('SECONDS2', 180)), keep: 0, own })
      r2 = { status: b.status, error: b.error, ...(b.detail || {}) }
    }
  }
  const wallSecs = (gameClock.wall.monotonic() - wall0) / 1000
  const h1 = await call('status'); const clock1 = h1.state && h1.state.clock
  const serverTicks = clock0 && clock1 && clock1.serverTicks != null && clock0.serverTicks != null ? clock1.serverTicks - clock0.serverTicks : null
  const d1 = r.detail || {}
  const me = process.env.MC_USERNAME
  const deaths = kit.serverLog.linesFrom(logMark).lines.map(l => l.text).filter(t => t.includes(`]: ${me} `) && !/issued server command|joined|left|lost connection|logged in/.test(t) &&
    /was |died|burn|fell|lava|drown|blew|killed|slain|fireball|flames|withered|shot/.test(t)).map(t => t.replace(/^.*\]: /, ''))
  const st = h1.state || {}
  return {
    ...base, spot: `${spot.O.x},${spot.O.y},${spot.O.z} d=${d.join(',')}`, near: spot.near, lanes: spot.lanes,
    ok: r.status === 'done' && !!d1.ok, status: r.status, error: r.error, salt, GOLD,
    gameSecs: +((gameClock.now() - t0) / 1000).toFixed(1), wallSecs: +wallSecs.toFixed(1), serverTicks,
    tps: serverTicks ? +(serverTicks / wallSecs).toFixed(0) : null, rate: clock0 && clock0.tickRate, lagTicks: clock1 && clock1.lagTicks,
    hp: st.health, dead: st.health === 0 || deaths.length > 0, deaths, pen: d1, away, pen2: r2
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
