'use strict'
// Выбор сида испытания (координатор 14.10, golden-v2): видит ли бот САМ, своими глазами, лаву и деревья от спавна. Восприятие —
// как в кампании: обзор со спавна (observe 48: брёвна, лава; portal_natural survey 128: лава под небом), затем вышка на 10 бл.
// (тот же lookout кампании, ~10 с — «подняться на холм или дерево») и обзор оттуда. Две точки спавна на сид: вторая — после
// /kill, сервер ставит тело в новую случайную клетку радиуса спавна. Знание бота не меняется — это выбор мира для серий.
//   node farm/farm.js run try-lab-seedcheck.js --slots 1 --tag sc-<сид>
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const gameClock = require('./src/game-clock')
const { connect } = require('./scene-kit')

const SLOT = process.env.FARM_SLOT || process.env.SLOT || '1'
const PLAYER = process.env.MC_USERNAME || `NeuroFarm${SLOT}`
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-seedcheck.jsonl')
const POINTS = Number(process.env.POINTS || 2)
const rcon = cmd => execFileSync('node', [path.join(__dirname, '..', 'farm', 'farm.js'), 'rcon', SLOT, cmd], { encoding: 'utf8' }).replace(/^слот \d+: /gm, '').trim()
const sleep = ms => gameClock.sleep(ms)

async function main () {
  const WS = process.env.ND_WS || `ws://127.0.0.1:${8800 + Number(SLOT)}`
  const conn = connect(WS)
  await conn.ready
  const call = conn.call
  if (process.env.FARM_SLOT) await require('./farm-bootstrap').farmBootstrap(call, WS, PLAYER)
  await call('connect', { bootstrapPaused: false })
  const seed = (/^level-seed=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', 'farm', `server-${SLOT}`, 'server.properties'), 'utf8')) || [])[1]
  rcon('time set 1000'); rcon('weather clear'); rcon('gamerule spawn_mobs false')
  const points = []
  for (let k = 0; k < POINTS; k++) {
    if (k > 0) {
      rcon(`kill ${PLAYER}`)
      await gameClock.wall.sleep(4000)
    }
    rcon(`clear ${PLAYER}`); rcon(`gamemode survival ${PLAYER}`)
    await sleep(3000); await gameClock.wall.sleep(3000) // прорисовка чанков у клиента
    const st = await call('status', {})
    const pos = st.state && st.state.pos
    const look = async (radius) => {
      const o = await call('observe', { radius })
      const blocks = (o.detail && o.detail.blocks) || []
      const logs = blocks.filter(b => /_log$/.test(b.name) && !b.remembered).reduce((a, b) => ({ count: a.count + b.count, dist: Math.min(a.dist, b.dist) }), { count: 0, dist: Infinity })
      const lavaSeen = blocks.find(b => b.name === 'lava' && !b.remembered)
      const sv = await call('portal_natural', { mode: 'survey', radius: 128 })
      const best = sv.detail && [sv.detail.best, ...(sv.detail.sites || [])].find(s => s && s.usable !== false && s.at)
      return { logs: logs.count ? logs : null, lava: lavaSeen ? { dist: lavaSeen.dist, at: lavaSeen.nearest } : null, sky: best ? { dist: best.dist, at: best.at, kind: best.kind, open: best.open } : null }
    }
    const ground = await look(48)
    rcon(`give ${PLAYER} minecraft:dirt 16`)
    const t0 = gameClock.now()
    const up = await call('tunnel', { direction: 'up', length: 10, timeoutSeconds: 30 })
    const climb = { sec: Math.round((gameClock.now() - t0) / 1000), status: up.status, y: ((await call('status', {})).state || {}).pos?.y }
    const high = await look(64)
    points.push({ pos, ground, climb, high })
    console.log(JSON.stringify({ k, pos, ground, climb, high }))
  }
  const sees = p => !!(p.ground.sky || p.ground.lava || p.high.sky || p.high.lava)
  const trees = p => !!(p.ground.logs || p.high.logs)
  const rec = { seed, points, lavaBoth: points.every(sees), lavaAny: points.some(sees), treesBoth: points.every(trees),
    nearestLava: Math.min(...points.flatMap(p => [p.ground.sky, p.ground.lava, p.high.sky, p.high.lava].filter(Boolean).map(x => x.dist))) }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  conn.close()
}
main().then(() => process.exit(0)).catch(e => { console.error(e); try { fs.appendFileSync(OUT, JSON.stringify({ error: String(e.message || e) }) + '\n') } catch {} process.exit(1) })
