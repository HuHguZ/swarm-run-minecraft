'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория «голем деревни на железо» (поток route, 03.10.2026): новый мир сида с големом у спавна (по скану копии
// farm/route-scan/<сид>.json), набор — каменные топор и меч, 16 булыжника; дойти к голему, fauna.golem {mode:'kill'}
// (столб 3, удары сверху), итог — железо и урон телу. Только ферма (подготовка командами до старта).
//   node farm/farm.js run try-lab-ow-golem.js --slots 28 --tag ow-golem1 TRIALS=1
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8828'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm28'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-golem.jsonl')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
function seedOf () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null } }

async function main () {
  await conn.ready
  await call('connect')
  await call('stop')
  await kit.randomReset()
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', 'false')
  await kit.cmd('/clear @s')
  await kit.cmd('/effect clear @s')
  await kit.cmd('/time set 1000')
  for (const g of ['stone_axe', 'stone_sword', 'cobblestone 16', 'bread 8']) await kit.cmd(`/give @s minecraft:${g}`)
  const seed = seedOf()
  let golem = null
  try { golem = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'farm', 'route-scan', `${seed}.json`), 'utf8')).golems[0] } catch {}
  const t0 = gameClock.now()
  const rec: Record<string, any> = { at: new Date().toISOString(), seed, golem }
  if (golem) {
    const g = await call('goto', { x: golem.x, z: golem.z, range: 10, timeoutSeconds: 90 })
    rec.goto = g.status
  }
  const st0 = (await call('status')).state || {} as Record<string, any>
  const r = await call('golem', { mode: 'kill', radius: 64, timeoutSeconds: 55 })
  const st1 = (await call('status')).state || {} as Record<string, any>
  rec.status = r.status
  rec.detail = r.detail
  rec.hp0 = st0.health
  rec.hp1 = st1.health
  rec.iron = (st1.inventory || {} as Record<string, any>).iron_ingot || 0
  rec.ok = rec.iron >= 3
  rec.seconds = Math.round((gameClock.now() - t0) / 1000)
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  try { await call('disconnect', { reason: 'сцена окончена' }) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
