'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория этапов, этап 2 — жемчуг эндера (server-nether, 25567). Сцена
// командами только ставит тело: /tp в искажённый лес Ада (или в верхний мир
// ночью), набор кампании после этапа стержней, лечение. Дальше — ровно тот
// вызов, что делает кампания (campaign.js, этап pearls): pearls {count:
// 12 - жемчуг, timeoutSeconds: 400}, до 8 раз, пока жемчуга меньше 12.
//
// Почему не бартер: loot_table/gameplay/piglin_bartering.json в
// server-1.21.11.jar — ender_pearl вес 10 из 469 (2.13%), 2–4 штуки: 0.064
// жемчуга на слиток, 12 жемчугов — ~188 слитков. Эндермен: ender_pearl
// uniform 0..1 (loot_table/entities/enderman.json) — 50% за убийство, без
// условия «убит игроком».
//
// Итог попытки (строка JSON в LAB_OUT): время, жемчуг, убийства, смерти и их
// причины (строка сервера), хп на минимуме.
//
// Запуск: ND_WS=ws://127.0.0.1:8773 MC_USERNAME=NeuroNether node try-lab-pearls.js [N]
//   WHERE="nether x y z" (по умолчанию искажённый лес у 0,0 сервера nether)
//   WHERE="overworld x y z" NIGHT=1 — верхний мир ночью
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8773'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-pearls.jsonl')
const N = Number(process.argv[2] || process.env.RUNS || 1)
const [DIM, ...XYZ] = (process.env.WHERE || 'nether 0 34 0').split(' ')
const DIMENSION = DIM === 'overworld' ? 'overworld' : 'the_nether'
const CALLS = Number(process.env.CALLS || 8)
const WANT = Number(process.env.PEARLS || 12)

const conn = connect(WS)
const call = conn.call
// Новый набор на каждую попытку: повтор той же команды набор отделяет
// «/say nd-…», а /say — чат для всех ботов сервера, и он рвёт их намерения
// (blaze/pearls слушают chat). Внутри попытки команды не повторяются.
let kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const inDim = c => `/execute in minecraft:${DIMENSION} run ${c.replace(/^\//, '')}`
const header = async () => ((await call('status')) || {}).state || {}
const inv = async n => ((await header()).inventory || {})[n] || 0

// KIT="предмет N,предмет,..." — набор вместо стандартного (например, рюкзак
// основного бота: репетиция на его настоящем снаряжении, 2026-09-29).
const KIT = process.env.KIT ? process.env.KIT.split(',').map(x => x.trim()).filter(Boolean) : ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'shield', 'bow', 'arrow 16',
  'cooked_beef 10', 'cobblestone 48', 'flint_and_steel', 'iron_pickaxe', 'blaze_rod 7']

const logSize = () => { try { return fs.readFileSync(LOG, 'utf8').length } catch { return 0 } }
function serverLines (fromSize) {
  try {
    return fs.readFileSync(LOG, 'utf8').slice(fromSize).split('\n')
      .filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}

async function scene () {
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  await kit.gamerule('spawn_mobs', 'true')
  await kit.gamerule('send_command_feedback', 'true')
  // KEEP=1 — как на основном сервере (keep_inventory true): жемчуг до смерти
  // остаётся в итоге. Без него смерть стирала добытое, и «убил 7, жемчуга 0»
  // (pearls-fulliron-2) нельзя было отличить от «жемчуг не падал».
  await kit.gamerule('keep_inventory', process.env.KEEP ? 'true' : 'false')
  if (process.env.NIGHT) await kit.cmd('/time set 13000')
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await kit.cmd('/effect give @s minecraft:slow_falling 8 0 true')
  // CLEAN=1 — убрать булыжник прошлых прогонов (столбы, коробки) в 24 блоках от
  // точки: в Аду своего булыжника нет, replace трогает только наше.
  if (process.env.CLEAN && DIM === 'nether') {
    const [x, y, z] = XYZ.map(v => Math.floor(Number(v)))
    for (const [a1, a2] of [[-10, 1], [2, 12]]) {
      await kit.cmd(`/execute in minecraft:the_nether run fill ${x - 24} ${y + a1} ${z - 24} ${x + 24} ${y + a2} ${z + 24} air replace minecraft:cobblestone`, { reply: /filled|No blocks|Successfully|too many/i, ms: 15000 }).catch(() => null)
    }
  }
  await kit.ensureWorld(DIMENSION, { tp: XYZ.join(' ') })
  await sleep(2500)
  // SPREAD="x z" — на поверхность ниже y 90 около x z (свежее место: у 0,0 лес
  // изрыт прошлыми прогонами — столбы, шахты, штреки).
  // LOCATE="x z" — свежий искажённый лес: ближайший к x z (/locate biome), тело —
  // на поверхность ниже y 80 рядом с ним (у 0,0 лес изрыт прошлыми прогонами).
  if (process.env.LOCATE) {
    const [lx, lz] = process.env.LOCATE.split(' ').map(Number)
    const loc = await call('ask', { command: `/execute in minecraft:the_nether positioned ${lx} 64 ${lz} run locate biome minecraft:warped_forest`, match: 'nearest|Could not', ms: 30000 })
    const line = (((loc && loc.detail) || loc || {}).lines || []).find(l => /nearest/.test(l)) || ''
    const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
    if (m) {
      console.log('лес:', m[1], m[3])
      await kit.cmd('/effect give @s minecraft:fire_resistance 30 0 true')
      // spreadplayers в Аду часто «Could not spread» (лава, потолок): тело оставалось
      // на WHERE — в чужом мире в пещере без выхода (foxhole-11r: «мест нет, nodes 1»).
      // Несколько попыток: шире и с другим потолком высоты.
      for (const [r, under] of [[12, 80], [24, 100], [32, 70], [48, 110]]) {
        await kit.cmd(`/spreadplayers ${m[1]} ${m[3]} 0 ${r} under ${under} false @s`, { reply: /Spread|Could not/, ms: 30000 })
        await sleep(3000)
        const st = ((await call('status')) || {}).state || {}
        if (st.pos && Math.hypot(st.pos.x - Number(m[1]), st.pos.z - Number(m[3])) < r + 16) break
      }
      await kit.cmd('/effect clear @s minecraft:fire_resistance')
    } else console.log('лес не найден:', line.slice(0, 120))
  }
  if (process.env.SPREAD) {
    await kit.cmd(`/spreadplayers ${process.env.SPREAD} 0 8 under ${process.env.SPREAD_UNDER || 90} false @s`, { reply: /Spread|Could not/, ms: 30000 })
    await sleep(2500)
  }
  // Лут прошлых попыток (жемчуг с убитых и с тел, KEEP не всегда) — не в счёт
  // этой: убрать у места старта уже после прихода (раньше чанки выгружены).
  await kit.cmd('/kill @e[type=item,distance=..48]')
  await kit.cmd('/clear @s minecraft:ender_pearl')
  await call('armor', {})
}

// Счёт сервера — правда об убийствах и подборе (сцене, не телу): отчёт тела
// считает «убит» по entityDead/пропаже, а жемчуг — по рюкзаку после смерти.
// `scoreboard players get` в latest.log не пишется — ответ через ask (чат тела).
const SCORES = { ekills: 'minecraft.killed:minecraft.enderman', picked: 'minecraft.picked_up:minecraft.ender_pearl' }
const scoreName = k => `nd_${k}`
async function scoreGet (k) {
  const r = await call('ask', { command: `/scoreboard players get @s ${scoreName(k)}`, match: 'has \\d+|none is set|Unknown|Can', ms: 5000 }).catch(() => null)
  const line = (((r && r.detail) || r || {}).lines || []).find(l => /has \d+/.test(l)) || ''
  const m = /has (\d+)/.exec(line)
  return m ? Number(m[1]) : null
}

async function run (k) {
  kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
  const t0 = gameClock.now()
  const from = logSize()
  await scene()
  for (const [key, crit] of Object.entries(SCORES)) {
    await kit.cmd(`/scoreboard objectives add ${scoreName(key)} ${crit}`)
    await kit.cmd(`/scoreboard players set @s ${scoreName(key)} 0`)
  }
  const h0 = await header()
  const res = { run: k, at: new Date().toISOString(), where: `${DIMENSION} ${XYZ.join(' ')}`, start: h0.pos, biome: h0.biome, calls: [], minHp: 20, pearlsMax: 0 }
  const hpTimer = gameClock.setInterval(async () => {
    try {
      const h = await header()
      if (typeof h.health === 'number') res.minHp = Math.min(res.minHp, h.health)
      res.pearlsMax = Math.max(res.pearlsMax, (h.inventory || {}).ender_pearl || 0)
    } catch {}
  }, 2000)
  try {
    for (let i = 0; i < CALLS; i++) {
      const have = (await inv('ender_pearl')) + (await inv('ender_eye'))
      if (have >= WANT) break
      const c0 = gameClock.now()
      const r = await call('pearls', { count: WANT - have, timeoutSeconds: 400, ...(process.env.STYLE ? { style: process.env.STYLE } : {}) })
      const d = r.detail || {}
      const h = await header()
      const brief = {
        s: Math.round((gameClock.now() - c0) / 1000),
        status: r.status,
        by: r.by ? r.by.type : undefined,
        mode: d.mode,
        pearls: d.pearls,
        kills: d.kills,
        hpLost: d.hpLost,
        hp: h.health,
        stopped: d.stopped ? String(d.stopped).slice(0, 180) : undefined,
        rounds: (d.rounds || []).length,
        hpPerKill: d.hpPerKill,
        killsPerHour: d.killsPerHour,
        err: r.error
      }
      res.calls.push(brief)
      console.log(`  вызов ${i + 1}: ${JSON.stringify(brief)}`)
      if (r.by && r.by.type === 'death') break
      if ((h.health || 0) <= 0) break
    }
  } finally { gameClock.clearInterval(hpTimer) }
  const deaths = kit.between(t0, gameClock.now(), 'death').length
  res.deaths = deaths + (res.calls.some(c => c.by === 'death') && !deaths ? 1 : 0)
  res.causes = serverLines(from).filter(l => /was|died|burn|fell|lava|drown|blew|killed|slain|fireball|flames|withered|shot/.test(l))
  res.pearls = await inv('ender_pearl')
  res.pearlsMax = Math.max(res.pearlsMax, res.pearls)
  res.kills = res.calls.reduce((n, c) => n + (c.kills || 0), 0)
  for (const key of Object.keys(SCORES)) res[key] = await scoreGet(key)
  res.hp = (await header()).health
  res.seconds = Math.round((gameClock.now() - t0) / 1000)
  res.ok = res.pearls >= WANT && res.deaths === 0
  fs.appendFileSync(OUT, JSON.stringify(res) + '\n')
  console.log(`ПОПЫТКА ${k}: ${res.ok ? 'OK' : 'ПЛОХО'} жемчуга ${res.pearls}, смертей ${res.deaths} ${JSON.stringify(res.causes)}, мин.хп ${res.minHp}, ${res.seconds} с`)
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
    console.log(`\nИТОГ: ${ok}/${all.length} без смерти и с ${WANT} жемчуга; время ${all.map(r => r.seconds).join(', ')} с`)
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
