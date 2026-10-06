'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория «литьё одним ведром с берега» (cast1.js, поток route, 03.10.2026): арена из команд (только ферма) —
// ровный берег, озеро лавы вровень с ним (flat), на блок ниже (low), берег с травой и слоем снега (grass); тело на берегу
// спиной к озеру, набор: ОДНО ведро воды, огниво, кирка, 64 булыжника. Дальше без команд — RPC portal mode=cast
// {one: true, hint} до трёх вызовов. Мобы выключены — меряется механика: место, копка, вода/лава, столб, поджиг.
//   node farm/farm.js run try-lab-ow-cast1.js --slots 11 --tag ow-c1 TRIALS=2 POOL=flat,low,grass
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ow-cast1.jsonl')
const TRIALS = Number(process.env.TRIALS || 2)
const POOLS = (process.env.POOL || 'flat').split(',')
const KIT = ['water_bucket', 'flint_and_steel', 'stone_pickaxe 2', 'cobblestone 64', 'cooked_beef 8']
const SLOT = Number(process.env.FARM_SLOT || 1)

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })

async function arena (X, Z, pool) {
  const box = [[X - 16, 90, Z - 12], [X + 16, 112, Z + 12]]
  await kit.forceload('overworld', box)
  await kit.fillExact('overworld', [[X - 16, 90, Z - 12], [X + 16, 99, Z + 12]], 'stone')
  await kit.fillExact('overworld', [[X - 16, 100, Z - 12], [X + 16, 112, Z + 12]], 'air')
  if (pool === 'grass') {
    await kit.fillExact('overworld', [[X - 16, 99, Z - 12], [X + 16, 99, Z + 12]], 'grass_block')
    await kit.fillExact('overworld', [[X - 10, 100, Z - 8], [X + 2, 100, Z + 8]], 'short_grass')
  }
  if (pool === 'cave' || pool === 'bowl') {
    // cave: пещера под 15 бл. породы — лава на 80, воздух 81–84 над ней и у берега (тело на берегу в пещере);
    // bowl: озеро — чаша на 3 ниже рельефа (берег вровень с лавой только у самой воды, дальше — стенка в 3 бл.).
    if (pool === 'cave') {
      await kit.fillExact('overworld', [[X - 16, 70, Z - 12], [X + 16, 99, Z + 12]], 'stone')
      await kit.fillExact('overworld', [[X - 3, 81, Z - 5], [X + 9, 84, Z + 5]], 'air')
      await kit.fillExact('overworld', [[X + 2, 80, Z - 5], [X + 9, 80, Z + 5]], 'lava')
      return { box: [[X - 16, 70, Z - 12], [X + 16, 112, Z + 12]], hint: { x: X + 3, y: 80, z: Z }, start: { x: X - 2, y: 81, z: Z } }
    }
    await kit.fillExact('overworld', [[X + 1, 97, Z - 6], [X + 10, 99, Z + 6]], 'air')
    await kit.fillExact('overworld', [[X + 1, 96, Z - 6], [X + 1, 96, Z + 6]], 'stone')
    await kit.fillExact('overworld', [[X + 2, 96, Z - 5], [X + 9, 96, Z + 5]], 'lava')
    return { box, hint: { x: X + 3, y: 96, z: Z }, start: { x: X - 1, y: 100, z: Z } }
  }
  const ly = pool === 'low' ? 98 : 99
  if (pool === 'low') await kit.fillExact('overworld', [[X + 2, 99, Z - 5], [X + 9, 99, Z + 5]], 'air')
  await kit.fillExact('overworld', [[X + 2, ly, Z - 5], [X + 9, ly, Z + 5]], 'lava')
  return { box, hint: { x: X + 3, y: ly, z: Z } }
}

async function trial (k, pool) {
  const X = 5000 + SLOT * 31 + k * 200
  const Z = 5000 + SLOT * 17
  await call('stop').catch(() => {})
  await kit.cmd('/gamemode creative')
  await kit.cmd(`/tp @s ${X} 104 ${Z}`)
  await sleep(1500)
  const { box, hint, start } = await arena(X, Z, pool)
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  const st0 = start || { x: X - 2, y: 100, z: Z }
  await kit.cmd(`/tp @s ${st0.x}.5 ${st0.y} ${st0.z}.5 -90 20`)
  await kit.cmd('/gamemode survival')
  await kit.cmd('/effect clear @s')
  await sleep(2500)
  const t0 = gameClock.now()
  const calls = []
  let ok = false
  for (let i = 0; i < 3 && !ok; i++) {
    const r = await call('portal', { mode: 'cast', one: true, hint, maxDig: pool === 'cave' ? 80 : 60, timeoutSeconds: 300 }).catch(e => ({ status: 'failed', error: e.message }))
    const d = r.detail || {} as Record<string, any>
    calls.push({ status: r.status, code: r.code, stopped: d.stopped || r.error || null, frame: d.frame, cast: (d.cast || []).length, refills: d.refills, dug: d.dug, placed: d.placed, site: d.site, lit: d.lit, seconds: d.seconds, trace: d.trace, sec: Math.round((gameClock.now() - t0) / 1000) })
    ok = !!d.lit
  }
  const st = await call('status', {} as Record<string, any>).catch(() => ({} as Record<string, any>))
  const s = st.state || {} as Record<string, any>
  const rec = { at: new Date().toISOString(), trial: k, pool, ok, seconds: Math.round((gameClock.now() - t0) / 1000), calls, hp: s.health, pos: s.pos, bag: Object.entries<any>(s.inventory || {} as Record<string, any>).map(([n, v]: any) => `${n}×${v}`).join(' ') }
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
  await kit.cmd('/random reset *')
  await kit.setDifficulty('peaceful')
  await kit.gamerule('keep_inventory', 'true')
  await kit.gamerule('send_command_feedback', 'true')
  await kit.cmd('/time set 1000')
  let k = 0
  for (let n = 0; n < TRIALS; n++) for (const pool of POOLS) await trial(k++, pool)
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ow-cast1 окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
