'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория «ведро воды» (поток overworld, 02.10.2026): почему ведро не набирается. В сериях ow-E2/E3 у воды за
// блоком штрека (portal cast waterHint) ведро набралось 2 раза из ~27, у пруда поверху — «ведро не набралось ни из
// одного из N источников» десятки раз. Арена из команд (только ферма), мобы выкл.; дальше без команд — те же RPC, что
// зовёт кампания:
//   pond      пруд 5×5 глубиной 2 на траве, тело в 8 бл. — bucket {fluid:water, radius:32}
//   grass     то же + трава по берегу и водоросли на дне
//   tunnel    штрек 1×2 на y 16 в сланце, впереди за 2 блоками карман воды (водоносный: вода до потолка) — tunnel east →
//             «вода на … (в N впереди)» → portal cast waterHint (как deepWater)
//   cave      то же, но над водой воздух (пещера с озером)
//   up        карман над следующей клеткой штрека («вода … сверху»)
// Итог попытки — строка JSON в LAB_OUT: ok (ведро воды в рюкзаке), секунды, ответы RPC.
//   ND_WS=… MC_USERNAME=… ND_SERVER_LOG=… LAB_OUT=… node try-lab-ow-water.js   TRIALS=2 POOL=pond,grass,tunnel,cave,up
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-ow-water.jsonl')
const TRIALS = Number(process.env.TRIALS || 2)
const POOLS = (process.env.POOL || 'pond,grass,tunnel,cave,up').split(',')
const KIT = ['bucket 2', 'stone_pickaxe 2', 'cobblestone 32', 'torch 8', 'cooked_beef 8']
const SLOT = Number(process.env.FARM_SLOT || 1)

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const cnt = (inv, name) => (inv && inv[name]) || 0

// Арена; возвращает { box, start:[x,y,z,yaw], deep }.
async function arena (X, Z, pool) {
  if (pool === 'pond' || pool === 'grass') {
    const Y = 100
    const box = [[X - 14, Y - 6, Z - 12], [X + 14, Y + 8, Z + 12]]
    await kit.forceload('overworld', box)
    await kit.fillExact('overworld', box, 'air')
    await kit.fillExact('overworld', [[X - 14, Y - 6, Z - 12], [X + 14, Y - 1, Z + 12]], 'stone')
    await kit.fillExact('overworld', [[X - 14, Y, Z - 12], [X + 14, Y, Z + 12]], 'grass_block')
    await kit.fillExact('overworld', [[X + 4, Y - 1, Z - 2], [X + 8, Y, Z + 2]], 'water')
    if (pool === 'grass') {
      await kit.fillExact('overworld', [[X + 3, Y + 1, Z - 3], [X + 9, Y + 1, Z - 3]], 'short_grass')
      await kit.fillExact('overworld', [[X + 3, Y + 1, Z + 3], [X + 9, Y + 1, Z + 3]], 'short_grass')
      await kit.fillExact('overworld', [[X + 3, Y + 1, Z - 2], [X + 3, Y + 1, Z + 2]], 'short_grass')
      await kit.fillExact('overworld', [[X + 5, Y - 1, Z - 1], [X + 7, Y - 1, Z + 1]], 'seagrass')
    }
    return { box, start: [X - 4, Y + 1, Z, -90], deep: false }
  }
  const Y = 16
  const box = [[X - 16, Y - 6, Z - 8], [X + 16, Y + 8, Z + 8]]
  await kit.forceload('overworld', box)
  await kit.fillExact('overworld', box, 'deepslate')
  await kit.fillExact('overworld', [[X - 12, Y, Z], [X, Y + 1, Z]], 'air')
  if (pool === 'tunnel') await kit.fillExact('overworld', [[X + 3, Y - 1, Z - 2], [X + 7, Y + 2, Z + 2]], 'water')
  else if (pool === 'cave') {
    await kit.fillExact('overworld', [[X + 3, Y - 2, Z - 2], [X + 8, Y + 3, Z + 2]], 'air')
    await kit.fillExact('overworld', [[X + 3, Y - 2, Z - 2], [X + 8, Y - 1, Z + 2]], 'water')
  } else await kit.fillExact('overworld', [[X + 1, Y + 2, Z - 1], [X + 4, Y + 4, Z + 1]], 'water')
  return { box, start: [X - 10, Y, Z, -90], deep: true }
}

async function trial (k, pool) {
  const X = 4000 + SLOT * 11 + k * 120
  const Z = 4000 + SLOT * 17
  await call('stop').catch(() => {})
  await kit.cmd('/gamemode creative')
  await kit.cmd(`/tp @s ${X} 120 ${Z}`)
  await sleep(1500)
  const { box, start, deep } = await arena(X, Z, pool)
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd(`/tp @s ${start[0]}.5 ${start[1]} ${start[2]}.5 ${start[3]} 10`)
  // Падение с высоты подготовки (тп на 120 в творческом) иначе засчитывается при смене режима — «fell from a high place».
  await sleep(1500)
  await kit.cmd(`/tp @s ${start[0]}.5 ${start[1]} ${start[2]}.5 ${start[3]} 10`)
  await kit.cmd('/gamemode survival')
  await kit.cmd('/effect clear @s')
  await sleep(2500)
  const t0 = gameClock.now()
  const calls = []
  const push = (m, r) => { const d = r.detail || {} as Record<string, any>; calls.push({ m, status: r.status, stopped: d.stopped || d.note || r.error || null, from: d.from, water: d.water, sec: Math.round((gameClock.now() - t0) / 1000) }); return d }
  let ok = false
  const has = async () => { const st = await call('status', {} as Record<string, any>).catch(() => ({} as Record<string, any>)); return cnt((st.state || {} as Record<string, any>).inventory, 'water_bucket') > 0 }
  if (!deep) {
    for (let i = 0; i < 2 && !ok; i++) {
      push('bucket', await call('bucket', { fluid: 'water', radius: 32 }).catch(e => ({ status: 'failed', error: e.message })))
      ok = await has()
    }
  } else {
    for (let i = 0; i < 2 && !ok; i++) {
      const d = push('tunnel', await call('tunnel', { direction: 'east', length: 16, torchEvery: 0, timeoutSeconds: 120 }).catch(e => ({ status: 'failed', error: e.message })))
      const wet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(String(d.stopped || ''))
      if (!wet) continue
      push('waterHint', await call('portal', { mode: 'cast', waterHint: { x: +wet[1], y: +wet[2], z: +wet[3] }, timeoutSeconds: 120 }).catch(e => ({ status: 'failed', error: e.message })))
      ok = await has()
      if (!ok) { push('bucket', await call('bucket', { fluid: 'water', radius: 16 }).catch(e => ({ status: 'failed', error: e.message }))); ok = await has() }
    }
  }
  const st = await call('status', {} as Record<string, any>).catch(() => ({} as Record<string, any>))
  const s = st.state || {} as Record<string, any>
  const rec = { at: new Date().toISOString(), trial: k, pool, ok, seconds: Math.round((gameClock.now() - t0) / 1000), calls, hp: s.health, pos: s.pos }
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
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-ow-water окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
