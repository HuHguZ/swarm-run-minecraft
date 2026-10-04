'use strict'
// Сторож Колизея на ферме (2026-09-30): бот-наблюдатель висит над полем и пишет
// каждое изменение блока ВНЕ поля (постройка, трибуны, фундамент под полем,
// всё за барьерной коробкой) — держат ли стены и фундамент взрывы кристаллов.
// Внутри поля (|dx|,|dz| ≤ R+1, от Y−2 до потолка Y+ceilH) правит сама арена
// каждый раунд — не считается. Плюс взрывы (центр, сила) и выходы бойцов за
// барьер (позиция игрока вне квадрата поля выше его пола).
//   node farm/crystal/colos-watch.js --slot 29 --pos "600 120 600" [--R 24] [--ceil 16] [--out file.json]
// Стоп — Ctrl+C или файл farm/crystal/colos-watch.stop; итог — в --out и в вывод.
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const D = path.join(__dirname, '../../daemon/node_modules/')
const mineflayer = require(D + 'mineflayer')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const SLOT = Number(arg('slot', 29))
const [X, Y, Z] = String(arg('pos', '600 120 600')).split(/\s+/).map(Number)
const R = Number(arg('R', 24))
const CEIL = Number(arg('ceil', 16))
const OUT = arg('out', path.join(__dirname, `colos-watch-${SLOT}.json`))
const STOP = path.join(__dirname, 'colos-watch.stop')
const NAME = `NeuroFarm${SLOT}w`
const rcon = (c) => { try { return execFileSync(process.execPath, [path.join(__dirname, '../farm.js'), 'rcon', String(SLOT), c], { encoding: 'utf8' }).trim() } catch (e) { return 'rcon: ' + e.message } }
const inField = (p) => Math.abs(p.x - X) <= R + 1 && Math.abs(p.z - Z) <= R + 1 && p.y >= Y - 2 && p.y <= Y + CEIL
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

const st = { since: null, changes: 0, byBlock: {}, samples: [], explosions: 0, outside: {}, outsideSamples: [] }
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25600 + SLOT, username: NAME, version: '1.21.11', auth: 'offline' })
bot.on('error', e => log('error', e.message))
bot.on('kicked', r => log('kicked', r))
bot.once('spawn', async () => {
  log(rcon(`op ${NAME}`))
  log(rcon(`gamemode spectator ${NAME}`))
  log(rcon(`execute in minecraft:overworld run tp ${NAME} ${X} ${Y + 45} ${Z} 0 90`))
  await new Promise(r => setTimeout(r, 8000)) // чанки
  st.since = new Date().toISOString()
  log(`сторож на месте: поле ${X} ${Y} ${Z}, R ${R}, потолок +${CEIL}`)
  bot.on('blockUpdate', (o, n) => {
    if (!o || !n || !n.position) return
    if (o.name === n.name) return
    if (inField(n.position)) return
    st.changes++
    const k = `${o.name}→${n.name}`
    st.byBlock[k] = (st.byBlock[k] || 0) + 1
    if (st.samples.length < 30) st.samples.push({ at: new Date().toISOString().slice(11, 19), pos: [n.position.x, n.position.y, n.position.z], from: o.name, to: n.name })
  })
  bot._client.on('explosion', (p) => { if (p && p.center) st.explosions++ })
  // Бойцы за барьером: игрок (не я) вне квадрата поля выше пола — «вылетел».
  setInterval(() => {
    for (const e of Object.values(bot.entities)) {
      if (!e || e.type !== 'player' || e.username === NAME || !e.position) continue
      const p = e.position
      if (p.y >= Y - 1 && (Math.abs(p.x - X) > R + 1.5 || Math.abs(p.z - Z) > R + 1.5)) {
        st.outside[e.username] = (st.outside[e.username] || 0) + 1
        if (st.outsideSamples.length < 20) st.outsideSamples.push({ at: new Date().toISOString().slice(11, 19), who: e.username, pos: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10] })
      }
    }
  }, 500)
  const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(st, null, 1)) } catch {} }
  setInterval(save, 10000)
  const done = () => { save(); log('итог:', JSON.stringify({ changes: st.changes, byBlock: st.byBlock, explosions: st.explosions, outside: st.outside })); bot.quit(); setTimeout(() => process.exit(0), 500) }
  process.on('SIGINT', done)
  setInterval(() => { if (fs.existsSync(STOP)) { try { fs.unlinkSync(STOP) } catch {} done() } }, 2000)
})
