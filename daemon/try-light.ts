'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Свет, который видит бот, против расчёта (2026-09-26, src/lightfix.js).
// Колизей на тестовом 25566 стоит в 3000 120 3000 — у его модели блочный свет
// посчитан (colosseum-light.js) и сошёлся с сервером. Бот Architect читает
// свет в тех же клетках без поправки и с ней: доля совпадений по чанкам.
//   node try-light.js   (MC_PORT=25566)
const { Vec3 } = require('vec3')
const C = require('./colosseum')
const LG = require('./colosseum-light')
const lightfix = require('./src/lightfix')
const [X, Y, Z] = [3000, 120, 3000]

;(async () => {
  const m = C.model({ R: 24 })
  const r = LG.check(m, {} as Record<string, any>)
  const g = m.g
  const exp = (wx, wy, wz) => { const x = wx - X; const y = wy - Y; const z = wz - Z; return g.in(x, y, z) ? r.L[g.i(x, y, z)] : null }
  const bot = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25566), username: 'Architect', version: '1.21.11', auth: 'offline', viewDistance: 12 }, { primary: true })
  await new Promise<any>((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject) })
  await gameClock.wall.sleep(1000)
  bot.chat(`/tp Architect ${X} ${Y + 10} ${Z - 60}`)
  await gameClock.wall.sleep(7000)
  const measure = () => {
    let same = 0; let tot = 0
    const cx = Math.floor(X / 16); const cz = Math.floor((Z - 60) / 16)
    for (const [ccx, ccz] of [[cx, cz], [cx - 1, cz], [cx, cz + 1], [cx + 2, cz + 2], [cx - 2, cz + 3]]) {
      for (let wy = Y; wy <= Y + 30; wy++) {
        for (let lx = 0; lx < 16; lx++) {
          for (let lz = 0; lz < 16; lz++) {
            const e = exp(ccx * 16 + lx, wy, ccz * 16 + lz)
            if (e === null) continue
            const b = bot.blockAt(new Vec3(ccx * 16 + lx, wy, ccz * 16 + lz))
            if (!b) continue
            tot++
            if (b.light === e) same++
          }
        }
      }
    }
    return { same, tot, share: tot ? (same / tot).toFixed(3) : '-' }
  }
  const before = measure()
  // Поправка ставится на класс столбца — берём его у загруженного столбца.
  const col = bot.world.getColumnAt(new Vec3(X, Y, Z - 60))
  lightfix.patch(Object.getPrototypeOf(col))
  const after = measure()
  console.log(`свет бота против расчёта: без поправки ${before.share} (${before.same}/${before.tot}), с поправкой ${after.share} (${after.same}/${after.tot})`)
  bot.quit()
  gameClock.wall.setTimeout(() => process.exit(0), 300)
})().catch(e => { console.error('FAILED', e.message); process.exit(1) })
