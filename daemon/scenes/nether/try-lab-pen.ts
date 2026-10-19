'use strict'
// Лаборатория S2 (06.10.2026): загон пиглинов «люк за окном» (bastion/pen-trap) против прежнего торга из ямы (pit).
// Только ферма. Командами — лишь постановка: коробка из кирпича чернокамня в Аду, комната пиглинов (пол y=A.y),
// яма тела со ртом (P=A−2, H=A−1, M=A, рот на +x), N взрослых и BABY малышей в комнате, набор и слитки.
// Дальше — один вызов RPC pen {mode, timeoutSeconds, want, lanes}. Итог — строка JSON в LAB_OUT.
//   node dist/farm/farm.js run try-lab-pen.js --slots 31 --tag s2-pen01 MODE=pen N=4 BABY=1 GOLD=96 SECONDS=180
// RNG_SEED= — соль ГСЧ (по умолчанию случайная), A=x,y,z — место коробки в Аду.
import * as gameClock from '../../src/game-clock'
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'

const env = (k, d) => process.env[k] != null && process.env[k] !== '' ? process.env[k] : d

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const runs = Number(env('RUNS', 1))
  const conn = connect(process.env.ND_WS)
  await conn.ready
  await conn.call('connect')
  if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
  for (let k = 1; k <= runs; k++) {
    const result: Record<string, any> = { lab: 'pen', slot, k, mode: env('MODE', 'pen'), ok: false }
    try { Object.assign(result, await once(conn, k)) } catch (e) { result.error = e.message }
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    const d = result.pen || {}
    const d2 = result.pen2
    if (d2) console.log(JSON.stringify({ k, second: true, resumed: d2.resumed, ok: d2.ok, stopped: d2.stopped, captured: d2.captured, handed3: d2.handed3, perSec3: d2.ingotsPerSec3, spent: d2.spent, seconds: d2.seconds, delivery: d2.fromPen && d2.fromPen.delivery, build: d2.phases && d2.phases.build }))
    console.log(JSON.stringify({ k, mode: result.mode, ok: result.ok, error: result.error, stopped: d.stopped, captured: d.captured, handed1: d.handed1, handed3: d.handed3, perSec3: d.ingotsPerSec3, spent: d.spent, seconds: d.seconds, delivery: d.fromPen && d.fromPen.delivery, all: d.all, pearls: d.pearls, hpMin: d.hpMin, angry: d.angry, tps: result.tps, lagTicks: result.lagTicks }))
  }
  try { await conn.call('disconnect') } catch {}
  conn.close()
}

async function once (conn, k) {
  const call = conn.call
  const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const [ax, ay, az] = env('A', `${1200 + 40 * k},70,1200`).split(',').map(Number)
  const N = Number(env('N', 4)); const BABY = Number(env('BABY', 1)); const GOLD = Number(env('GOLD', 96))
  const nether = 'the_nether'
  // Прошлая попытка могла кончиться смертью: ждём возрождения (команды мёртвому теряются).
  for (let i = 0; i < 40; i++) { const st = await call('status'); if ((st.state && st.state.health) > 0) break; await sleep(250) }
  await kit.cmd('/gamemode creative')
  await kit.ensureWorld(nether, { tp: `${ax + 0.5} ${ay + 8} ${az + 0.5}` })
  await kit.forceload(nether, [[ax - 8, 0, az - 10], [ax + 14, 0, az + 10]])
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('keep_inventory', 'false')
  await kit.cmd(`/execute in minecraft:${nether} run kill @e[type=!player,x=${ax - 10},y=${ay - 10},z=${az - 12},dx=26,dy=24,dz=24]`)
  // Коробка: стены, пол и крыша из кирпича чернокамня (как стены бастиона: твёрдость 1.5).
  await kit.fillExact(nether, [[ax - 6, ay - 6, az - 8], [ax + 12, ay + 6, az + 8]], 'polished_blackstone_bricks')
  await kit.fillExact(nether, [[ax + 1, ay, az - 5], [ax + 9, ay + 3, az + 5]], 'air')
  await kit.fillExact(nether, [[ax, ay - 2, az], [ax, ay, az]], 'air')
  await kit.cmd('/clear @s')
  for (const g of ['iron_pickaxe', 'iron_sword', 'cobblestone 64', 'cooked_beef 16', `gold_ingot ${GOLD}`]) await kit.cmd(`/give @s minecraft:${g}`)
  // Броня — командой (s2-lure05 k=2: RPC armor не надел золотой шлем → «slain by Piglin» через 1 с после survival).
  for (const [slot, item] of [['head', 'golden_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) await kit.must(`/item replace entity @s armor.${slot} with minecraft:${item}`, /^Replaced a slot on /, `броня ${slot}`)
  await kit.must(`/execute in minecraft:${nether} run tp @s ${ax + 0.5} ${ay - 2} ${az + 0.5} -90 0`, /^Teleported /, 'тело не в яме')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.cmd('/gamemode survival')
  // Пиглины в случайных клетках комнаты (не у самого рта), малыши — тоже.
  const spots = []
  for (let x = ax + 2; x <= ax + 9; x++) for (let z = az - 5; z <= az + 5; z++) spots.push([x, z])
  spots.sort(() => Math.random() - 0.5)
  for (let i = 0; i < N + BABY; i++) {
    const [x, z] = spots[i]
    const nbt = i < N ? '{PersistenceRequired:1b}' : '{PersistenceRequired:1b,IsBaby:1b}'
    await kit.cmd(`/execute in minecraft:${nether} run summon minecraft:piglin ${x + 0.5} ${ay} ${z + 0.5} ${nbt}`)
  }
  const salt = await kit.randomReset()
  await sleep(1500)
  const h0 = await call('status')
  const clock0 = h0.state && h0.state.clock
  const wall0 = gameClock.wall.monotonic()
  const t0 = gameClock.now()
  const r = await call('pen', { mode: env('MODE', 'pen'), timeoutSeconds: Number(env('SECONDS', 180)), want: env('WANT', '') ? Number(env('WANT', '')) : undefined, lanes: Number(env('LANES', 3)), catchSeconds: Number(env('CATCH', 90)), refill: env('REFILL', '1') !== '0', capture: env('CAPTURE', 'gather'), penMax: Number(env('PENMAX', 6)) })
  const wallSecs = (gameClock.wall.monotonic() - wall0) / 1000
  const h1 = await call('status')
  const clock1 = h1.state && h1.state.clock
  const serverTicks = clock0 && clock1 && clock1.serverTicks != null && clock0.serverTicks != null ? clock1.serverTicks - clock0.serverTicks : null
  const d = r.detail || {}
  // SECOND=с — повторный вызов у готового загона (бот в B): торг без стройки и поимки (penHere), слитки — снова GOLD.
  let pen2 = null
  if (Number(env('SECOND', 0)) > 0) {
    await kit.cmd(`/give @s minecraft:gold_ingot ${GOLD}`)
    await sleep(1000)
    const r2 = await call('pen', { mode: 'pen', timeoutSeconds: Number(env('SECOND', 0)), penMax: Number(env('PENMAX', 6)) })
    pen2 = { status: r2.status, ...(r2.detail || {}) }
  }
  const st = (await call('status')).state || h1.state || {}
  return {
    ok: r.status === 'done' && !!d.ok, status: r.status, error: r.error, salt, N, BABY, GOLD,
    gameSecs: +((gameClock.now() - t0) / 1000).toFixed(1), wallSecs: +wallSecs.toFixed(1), serverTicks,
    tps: serverTicks ? +(serverTicks / wallSecs).toFixed(0) : null, rate: clock0 && clock0.tickRate, lagTicks: clock1 && clock1.lagTicks,
    hp: st.health, dead: st.health === 0, pen: d, pen2
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
