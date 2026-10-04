'use strict'
// Сверка постройки Колизея с моделью (2026-09-30): бот-наблюдатель над полем,
// каждая клетка модели colosseum.js ВНЕ объёма поля (|dx|,|dz| ≤ R+1, dy −2…+ceil
// правит сама арена) сравнивается по имени блока с миром. Несовпадения — по
// видам и первые примеры. До дуэлей и после: новых несовпадений 0 — взрывы
// кристаллов постройку не тронули.
//   node farm/crystal/colos-scan.js --slot 29 --pos "600 120 600" [--R 24] [--ceil 16] --out file.json
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const D = path.join(__dirname, '../../daemon/')
const mineflayer = require(D + 'node_modules/mineflayer')
const Vec3 = require(D + 'node_modules/vec3')
const CZ = require(D + 'colosseum')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const SLOT = Number(arg('slot', 29))
const [X, Y, Z] = String(arg('pos', '600 120 600')).split(/\s+/).map(Number)
const R = Number(arg('R', 24))
const CEIL = Number(arg('ceil', 16))
const OUT = arg('out', path.join(__dirname, `colos-scan-${SLOT}.json`))
const NAME = `NeuroFarm${SLOT}s`
const rcon = (c) => { try { return execFileSync(process.execPath, [path.join(__dirname, '../farm.js'), 'rcon', String(SLOT), c], { encoding: 'utf8' }).trim() } catch (e) { return 'rcon: ' + e.message } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25600 + SLOT, username: NAME, version: '1.21.11', auth: 'offline' })
bot.on('error', e => console.log('error', e.message))
bot.once('spawn', async () => {
  rcon(`op ${NAME}`)
  rcon(`gamemode spectator ${NAME}`)
  rcon(`execute in minecraft:overworld run tp ${NAME} ${X} ${Y + 50} ${Z} 0 90`)
  await sleep(12000)
  const m = CZ.model({ R, ceilH: CEIL })
  const g = m.g
  const names = g.pal.map(p => (p ? CZ.parse(p).name : null))
  let total = 0; let unloaded = 0; let bad = 0
  const byKind = {}
  const samples = []
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i]
    if (!v) continue
    const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
    if (Math.abs(x) <= R + 1 && Math.abs(z) <= R + 1 && y >= -2 && y <= CEIL) continue
    total++
    const b = bot.blockAt(new Vec3(X + x, Y + y, Z + z), false)
    if (!b) { unloaded++; continue }
    if (b.name === names[v]) continue
    bad++
    const k = `${names[v]}→${b.name}`
    byKind[k] = (byKind[k] || 0) + 1
    if (samples.length < 25) samples.push([X + x, Y + y, Z + z, names[v], b.name])
  }
  const out = { at: new Date().toISOString(), pos: [X, Y, Z], R, ceil: CEIL, total, unloaded, mismatches: bad, byKind, samples }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
  console.log(JSON.stringify({ total, unloaded, mismatches: bad, byKind }))
  rcon(`deop ${NAME}`)
  bot.quit()
  setTimeout(() => process.exit(0), 500)
})
setTimeout(() => { console.log('timeout'); process.exit(1) }, 90000)
