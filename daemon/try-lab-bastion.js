'use strict'
// Лаборатория этапов — бастион (server-nether, 25567): золото бастиона без
// злости пиглинов и бартер (bastion.js, RPC bastion). Сцена командами только
// ставит тело у бастиона и выдаёт набор кампании; дальше — ровно тот вызов,
// что сделает кампания: bastion {x,y,z, timeoutSeconds}.
//
// Набор: железные нагрудник/поножи/ботинки + золотой шлем, железный меч, щит,
// 2 железные кирки, лук + 64 стрелы, 16 жареной говядины, 64 булыжника.
// Золота нет — первое золото тело добывает само.
//
// Итог попытки (строка JSON в LAB_OUT): время, золото, бартер, смерти.
//
//   ND_WS=ws://127.0.0.1:8773 MC_USERNAME=NeuroNether node try-lab-bastion.js [N]
//   BASTION=-120,60,-200  START=-74,71,-194  SECONDS=400  MODE=auto
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8773'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-bastion.jsonl')
const N = Number(process.argv[2] || process.env.RUNS || 1)
const BA = (process.env.BASTION || '-120,60,-200').split(',').map(Number)
const ST = (process.env.START || '-74,71,-194').split(',').map(Number)
const SECONDS = Number(process.env.SECONDS || 400)
const MODE = process.env.MODE || 'auto'

const conn = connect(WS)
const call = conn.call
let kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const KIT = process.env.KIT ? process.env.KIT.split(',').map(x => x.trim()).filter(Boolean) : ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'shield', 'iron_pickaxe 2', 'bow', 'arrow 64',
  'cooked_beef 16', 'cobblestone 64', ...(process.env.GOLD ? [`gold_ingot ${process.env.GOLD}`] : [])]

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
  // KEEPINV=1 — как на основном сервере: золото до смерти остаётся в итоге.
  await kit.gamerule('keep_inventory', process.env.KEEPINV ? 'true' : 'false')
  await kit.gamerule('send_command_feedback', 'true')
  // KEEP=1 — рюкзак прошлой попытки (золото уже добыто: проверить бартер).
  if (!process.env.KEEP) {
    await kit.cmd('/clear @s')
    for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  }
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  // SPREAD="x z" — на поверхность Ада у x z (/spreadplayers under): у бастиона
  // мира прохождения рельеф неизвестен, телепорт в точку мог закопать тело.
  // LOCATE=1 — случайный мир: бастион находит /locate (только постановка
  // сцены), тело — на поверхность в 32 блоках от него со стороны 0,0 (как
  // пришло бы от портала). Дальше бот сам: узнаёт тип, идёт маршрутом.
  if (process.env.LOCATE && !located) {
    const loc = await call('ask', { command: '/execute in minecraft:the_nether positioned 0 64 0 run locate structure minecraft:bastion_remnant', match: 'nearest|Could not', ms: 30000 })
    const line = (((loc && loc.detail) || loc || {}).lines || []).find(l => /nearest/.test(l)) || ''
    const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
    if (!m) throw new Error('бастион не найден: ' + line.slice(0, 120))
    const bx = Number(m[1]); const bz = Number(m[3])
    const d = Math.hypot(bx, bz) || 1
    located = { x: bx, y: 50, z: bz, spread: `${Math.round(bx - 32 * bx / d)} ${Math.round(bz - 32 * bz / d)}` }
    console.log('бастион:', JSON.stringify(located))
  }
  const spread = located ? located.spread : process.env.SPREAD
  if (spread) {
    await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${spread} 0 ${process.env.SPREAD_R || 8} under ${process.env.SPREAD_UNDER || 80} false @s`, { reply: /Spread|Could not/, ms: 30000 })
    await kit.ensureWorld('the_nether')
  } else await kit.ensureWorld('the_nether', { tp: `${ST[0] + 0.5} ${ST[1]} ${ST[2] + 0.5}` })
  await sleep(1500)
  await call('armor', {})
}

let located = null
// Тип бастиона по правде мира (только для сводки сцены): золото в 96 блоках
// (blocks_around find — не зрение бота) против узоров золота шаблонов jar.
async function truthType () {
  const bp = require('./src/bastion-pieces')
  const r = await call('blocks_around', { find: 'gold_block', radius: 96, count: 200 })
  const gold = (((r && r.detail) || r || {}).found || [])
  const set = new Set(gold.map(g => `${g.x},${g.y},${g.z}`))
  let best = null
  for (const [name, P] of Object.entries(bp.lib())) {
    if (P.gold.length < 3) continue
    for (let rr = 0; rr < 4; rr++) {
      for (const g0 of gold) {
        for (const [ax, ay, az] of P.gold.slice(0, 4)) {
          const [rx, rz] = bp.rot(rr, ax, az)
          const t = { x: g0.x - rx, y: g0.y - ay, z: g0.z - rz }
          let n = 0
          for (const [cx, cy, cz] of P.gold) { const [wx, wz] = bp.rot(rr, cx, cz); if (set.has(`${wx + t.x},${cy + t.y},${wz + t.z}`)) n++ }
          if (!best || n > best.n) best = { n, piece: name, type: P.type }
        }
      }
    }
  }
  return { gold: gold.length, type: best && best.n >= 3 ? best.type : 'unknown', piece: best && best.n >= 3 ? best.piece : undefined, matched: best ? best.n : 0 }
}

async function run (k) {
  kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
  const t0 = Date.now()
  await scene()
  const size = logSize()
  const tt = process.env.LOCATE ? await truthType().catch(e => ({ type: 'ошибка', error: e.message })) : null
  if (tt) console.log('тип по правде мира:', JSON.stringify(tt))
  const B = located || { x: BA[0], y: BA[1], z: BA[2] }
  const r = await call('bastion', { mode: MODE, x: B.x, y: B.y, z: B.z, timeoutSeconds: SECONDS, ...(process.env.BASTION_PARAMS ? JSON.parse(process.env.BASTION_PARAMS) : {}) })
  const st = r.state || {}
  const d = r.detail || {}
  const deaths = deathLines(size)
  const rec = {
    at: new Date().toISOString(), k, mode: MODE, status: r.status, seconds: Math.round((Date.now() - t0) / 1000),
    bastionType: tt ? tt.type : undefined, bastionPiece: tt ? tt.piece : undefined, truthGold: tt ? tt.gold : undefined, bastionAt: located ? `${located.x},${located.z}` : undefined,
    hp: Math.round(st.health ?? -1), deaths, stopped: d.stopped, goldBlocksDug: d.goldBlocksDug, bribed: d.bribed, ingotsTraded: d.ingotsTraded,
    chests: (d.chests || []).length, gained: d.gained, bag: d.bag, towered: d.towered, predLeft: d.predLeft, predWrong: d.predWrong, predMiss: d.predMiss, pearls: (d.bag || {}).ender_pearl, ingots: (d.bag || {}).gold_ingot, blocks: (d.bag || {}).gold_block, fireRes: (d.bag || {}).fire_res, fights: d.fights, brutes: d.brutesAvoided, lastBlocked: d.lastBlocked, error: r.error,
    sealed: d.sealed, ores: d.sealed ? d.sealed.ores : undefined, nuggets: d.goldNuggets, pit: d.pit, pitTrade: d.pitTrade, handed: d.pitTrade ? d.pitTrade.handed : undefined, tossedIngots: d.pitTrade ? d.pitTrade.tossed : undefined, exitOk: d.exit ? d.exit.ok : undefined, hurts: d.hurts
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  console.log('note:', d.note)
}

;(async () => {
  await conn.ready
  await call('connect')
  for (let k = 1; k <= N; k++) {
    try { await run(k) } catch (e) { console.log('попытка упала:', e.message) }
  }
  conn.close()
  process.exit(0)
})()
