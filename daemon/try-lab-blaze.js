'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория этапов, этап 1 — огненные стержни в НАСТОЯЩЕЙ крепости Ада
// (server-nether, 25567). Сцена командами только ставит тело: /tp к спавнеру,
// набор кампании, лечение между попытками. Дальше — ровно те вызовы, что
// делает кампания (campaign.js, этап nether): blaze {rods: 7,
// timeoutSeconds: 400}, до 6 раз, пока стержней меньше 7.
//
// Набор кампании: железные нагрудник/поножи/ботинки + золотой шлем, железный
// меч, щит, лук + 32 стрелы, 10 жареной говядины, 64 булыжника, огниво,
// железная кирка.
//
// Итог попытки (строка JSON в LAB_OUT): время, стержни, смерти и их причины
// (строка сервера), хп на минимуме, урон по типам (detail.damage из blaze.js).
//
// Запуск: ND_WS=ws://127.0.0.1:8773 MC_USERNAME=NeuroNether node try-lab-blaze.js [N]
//   SPAWNER=283,60,328  START=294,57,328  (крепость у 288,304 в Аду сервера nether)
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8773'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-blaze.jsonl')
const N = Number(process.argv[2] || process.env.RUNS || 1)
const SP = (process.env.SPAWNER || '283,60,328').split(',').map(Number)
const ST = (process.env.START || '294,57,328').split(',').map(Number)
const CALLS = Number(process.env.CALLS || 6)
const RODS = Number(process.env.RODS || 7)

const conn = connect(WS)
const call = conn.call
// Новый набор на каждую попытку: повтор той же команды набор отделяет
// «/say nd-…», а /say — чат для всех ботов сервера, и он рвёт их намерения
// (blaze/pearls слушают chat). Внутри попытки команды не повторяются.
let kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const nether = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`
const header = async () => ((await call('status')) || {}).state || {}
const inv = async n => ((await header()).inventory || {})[n] || 0

// ARROWS=64 — сколько стрел в наборе (кампании советуем 64).
// KIT="предмет N,предмет,..." — набор вместо стандартного (например, рюкзак
// основного бота: репетиция на его настоящем снаряжении, 2026-09-29).
const KIT = process.env.KIT ? process.env.KIT.split(',').map(x => x.trim()).filter(Boolean) : ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'shield', 'bow', `arrow ${Number(process.env.ARROWS || 32)}`,
  'cooked_beef 10', 'cobblestone 64', 'flint_and_steel', 'iron_pickaxe']

function deathLines (fromSize) {
  try {
    const buf = fs.readFileSync(LOG, 'utf8').slice(fromSize)
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const logSize = () => { try { return fs.readFileSync(LOG, 'utf8').length } catch { return 0 } }

async function scene () {
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('spawn_mobs', 'true')
  await kit.gamerule('spawner_blocks_work', 'true')
  await kit.gamerule('send_command_feedback', 'true')
  // KEEP=1 — как на основном сервере: стержни до смерти остаются в итоге.
  await kit.gamerule('keep_inventory', process.env.KEEP ? 'true' : 'false')
  // Свежий приход: ни мобов, ни лута прошлой попытки в 48 блоках от спавнера.
  await kit.cmd(nether(`kill @e[type=!player,x=${SP[0]},y=${SP[1]},z=${SP[2]},distance=..48]`))
  // Следы прошлых попыток: коробки/шалаш из булыжника и огонь от шаров (в
  // крепости булыжника нет, так что replace трогает только наше).
  for (const what of ['cobblestone', 'fire']) {
    await kit.cmd(nether(`fill ${SP[0] - 16} ${SP[1] - 8} ${SP[2] - 16} ${SP[0] + 16} ${SP[1] + 8} ${SP[2] + 16} air replace minecraft:${what}`))
  }
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.ensureWorld('the_nether', { tp: `${ST[0] + 0.5} ${ST[1]} ${ST[2] + 0.5}` })
  await sleep(1500)
  // Повтор после прихода: до него тело могло стоять в верхнем мире (возрождение),
  // чанки у спавнера выгружены, и kill выше лута не видел — слот 13
  // (blaze-fulliron-6) «добыл» за 2 с 7 стержней, оставшихся от прошлой попытки.
  await kit.cmd(nether(`kill @e[type=item,x=${SP[0]},y=${SP[1]},z=${SP[2]},distance=..48]`))
  await kit.cmd('/clear @s minecraft:blaze_rod')
  await call('armor', {})
}

async function run (k) {
  kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
  const t0 = gameClock.now()
  const from = logSize()
  await scene()
  const h0 = await header()
  const res = { run: k, at: new Date().toISOString(), start: h0.pos, calls: [], deaths: 0, minHp: 20 }
  res.rodsMax = 0
  let hpTimer = gameClock.setInterval(async () => {
    try {
      const h = await header()
      if (typeof h.health === 'number') res.minHp = Math.min(res.minHp, h.health)
      res.rodsMax = Math.max(res.rodsMax, (h.inventory || {}).blaze_rod || 0)
    } catch {}
  }, 2000)
  try {
    for (let i = 0; i < CALLS; i++) {
      const have = await inv('blaze_rod')
      if (have >= RODS) break
      const c0 = gameClock.now()
      const r = await call('blaze', { rods: RODS, timeoutSeconds: 400, ...(process.env.BLAZE_PARAMS ? JSON.parse(process.env.BLAZE_PARAMS) : {}) })
      const d = r.detail || {}
      const h = await header()
      const brief = {
        s: Math.round((gameClock.now() - c0) / 1000),
        status: r.status,
        by: r.by ? r.by.type : undefined,
        rods: d.rods,
        kills: d.kills,
        hpLost: d.hpLost,
        hp: h.health,
        dmg: d.damage,
        stopped: d.stopped ? String(d.stopped).slice(0, 160) : undefined,
        rests: d.rests ? d.rests.length : undefined,
        covers: d.covers ? d.covers.length : undefined,
        fled: d.fled ? d.fled.mode : undefined,
        doc: d.doctrine,
        err: r.error
      }
      res.calls.push(brief)
      console.log(`  вызов ${i + 1}: ${JSON.stringify(brief)}`)
      if (r.by && r.by.type === 'death') break
      if ((h.health || 0) <= 0) break
      if (/не вижу/.test(String(d.stopped || '')) && i >= 1) break
    }
  } finally { gameClock.clearInterval(hpTimer) }
  const h = await header()
  const deaths = kit.between(t0, gameClock.now(), 'death').length
  res.deaths = deaths + (res.calls.some(c => c.by === 'death') && !deaths ? 1 : 0)
  res.causes = deathLines(from).filter(l => /was|died|burn|fell|lava|drown|blew|killed|slain|fireball|flames|withered|shot/.test(l))
  res.rods = await inv('blaze_rod')
  res.rodsMax = Math.max(res.rodsMax, res.rods)
  res.hp = h.health
  res.seconds = Math.round((gameClock.now() - t0) / 1000)
  res.ok = res.rods >= RODS && res.deaths === 0
  fs.appendFileSync(OUT, JSON.stringify(res) + '\n')
  console.log(`ПОПЫТКА ${k}: ${res.ok ? 'OK' : 'ПЛОХО'} стержней ${res.rods}, смертей ${res.deaths} ${JSON.stringify(res.causes)}, мин.хп ${res.minHp}, ${res.seconds} с`)
  return res
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  const all = []
  try {
    for (let k = 1; k <= N; k++) all.push(await run(k))
  } catch (e) {
    console.log('сцена оборвалась:', e.message)
    process.exitCode = 1
  } finally {
    try { await call('stop') } catch {}
    const ok = all.filter(r => r.ok).length
    console.log(`\nИТОГ: ${ok}/${all.length} без смерти и с ${RODS} стержнями; время ${all.map(r => r.seconds).join(', ')} с`)
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
