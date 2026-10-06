'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория механики литья глубоко (поток overworld, 02.10.2026): арена из команд (только ферма) — сланцевый
// блок у дна, штрек 1×2 на ногах −54, озеро лавы под потолком на −55 (как у водоносной лавы). Тело — в конце штрека
// у лавы «в 1 впереди», набор после железа. Дальше без команд — RPC portal mode=cast (windows, hint, maxDig, keep,
// radius — как зовёт кампания под ND_OW_DEEP), до трёх вызовов. Мобы выключены (peaceful) — меряется механика:
// окно, место рамы, копка, черпаки, столбы, поджиг.
//
// Итог попытки — строка JSON в LAB_OUT: ok (рама горит), минуты, вызовов, причины остановок, отчёт литья.
//   ND_WS=… MC_USERNAME=… ND_SERVER_LOG=… LAB_OUT=… node try-lab-ow-cast.js   TRIALS=3 POOL=under,cave,ahead,side
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ow-cast.jsonl')
const TRIALS = Number(process.env.TRIALS || 3)
const POOLS = (process.env.POOL || 'under').split(',')
const KIT = ['bucket', 'water_bucket', 'flint_and_steel', 'stone_pickaxe 3', 'cobblestone 64', 'torch 16', 'cooked_beef 8', 'crafting_table', 'stick 8', 'oak_log 4']
const SLOT = Number(process.env.FARM_SLOT || 1)

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })

async function arena (X, Z, pool) {
  const box = [[X - 24, -60, Z - 12], [X + 22, -44, Z + 12]]
  await kit.forceload('overworld', box)
  await kit.fillExact('overworld', box, 'deepslate')
  await kit.fillExact('overworld', [[X - 20, -54, Z], [X + 10, -53, Z]], 'air')
  // Озеро лавы под потолком на −55: «under» — прямо по ходу штрека под следующей клеткой; «side» — сбоку от конца
  // штрека (под стенкой); «ahead» — на две клетки дальше (за следующей клеткой).
  if (pool === 'under') await kit.fillExact('overworld', [[X + 11, -55, Z - 3], [X + 18, -55, Z + 3]], 'lava')
  else if (pool === 'side') await kit.fillExact('overworld', [[X + 6, -55, Z + 1], [X + 12, -55, Z + 6]], 'lava')
  else if (pool === 'cave') {
    // Пещера над озером: лава на −55, воздух −54…−52 над ней — штрек выходит прямо к берегу (ow-L3, слот 10).
    await kit.fillExact('overworld', [[X + 11, -55, Z - 3], [X + 18, -55, Z + 3]], 'lava')
    await kit.fillExact('overworld', [[X + 11, -54, Z - 3], [X + 18, -52, Z + 3]], 'air')
  }
  else await kit.fillExact('overworld', [[X + 12, -55, Z - 3], [X + 19, -55, Z + 3]], 'lava')
  return box
}

async function trial (k, pool) {
  const X = 3000 + SLOT * 7 + k * 160
  const Z = 3000 + SLOT * 13
  await call('stop').catch(() => {})
  await kit.cmd('/gamemode creative')
  await kit.cmd(`/tp @s ${X} -40 ${Z}`)
  await sleep(1500)
  const box = await arena(X, Z, pool)
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd(`/tp @s ${X + 10}.5 -54 ${Z}.5 -90 30`)
  await kit.cmd('/gamemode survival')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:saturation 2 20 true')
  await sleep(2500)
  const hint = pool === 'under' ? { x: X + 11, y: -55, z: Z } : pool === 'side' ? { x: X + 10, y: -55, z: Z + 1 } : { x: X + 12, y: -55, z: Z }
  const t0 = gameClock.now()
  const calls = []
  let ok = false
  for (let i = 0; i < 3 && !ok; i++) {
    const r = await call('portal', { mode: 'cast', windows: true, hint, maxDig: 64, keep: 8, radius: 12, timeoutSeconds: 540 }).catch(e => ({ status: 'failed', error: e.message }))
    const d = r.detail || {} as Record<string, any>
    calls.push({ status: r.status, code: r.code, stopped: d.stopped || r.error || null, frame: d.frame, cast: (d.cast || []).length, refills: d.refills, dug: d.dug, placed: d.placed, windows: d.windows, skipped: d.skipped, site: d.site, lit: d.lit, trace: d.trace, sec: Math.round((gameClock.now() - t0) / 1000) })
    ok = !!d.lit
  }
  const st = await call('status', {} as Record<string, any>).catch(() => ({} as Record<string, any>))
  const s = st.state || {} as Record<string, any>
  const rec = { at: new Date().toISOString(), trial: k, pool, ok, minutes: Math.round((gameClock.now() - t0) / 6000) / 10, calls, hp: s.health, pos: s.pos, bag: Object.entries<any>(s.inventory || {} as Record<string, any>).map(([n, v]: any) => `${n}×${v}`).join(' ') }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  await call('stop').catch(() => {})
  await kit.unforceload('overworld', box).catch(() => {})
  return rec
}

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  await kit.randomReset()
  await kit.setDifficulty('peaceful')
  await kit.gamerule('keep_inventory', 'true')
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/time set 1000')
  let k = 0
  for (let n = 0; n < TRIALS; n++) for (const pool of POOLS) await trial(k++, pool)
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ow-cast окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
