'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория этапов — возврат брошенных очей (stronghold.js throwEye →
// fetchDrop). Тело на суше в точке AT (верхний мир), 8 бросков подряд вызовом
// кампании/мозга stronghold {mode: 'throw'}; каждый следующий — оттуда, где
// кончился подбор прошлого (око падает в ~12 блоках к крепости). Око
// разбивается само в 20% (EyeOfEnder: surviveAfterDeath = nextInt(5) > 0) —
// считаем отдельно: вернулось из упавших, разбилось, потеряно.
//
// Запуск: ND_WS=ws://127.0.0.1:8775 MC_USERNAME=NeuroBuild AT=0,0 node try-lab-eyes.js [N=8]
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8775'
const PLAYER = process.env.MC_USERNAME || 'NeuroBuild'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-eyes.jsonl')
const N = Number(process.argv[2] || 8)
const AT = (process.env.AT || '0,0').split(',').map(Number)

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const header = async () => ((await call('status')) || {}).state || {}
const have = async n => ((await header()).inventory || {})[n] || 0

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  const t0 = gameClock.now()
  const res = { at: new Date().toISOString(), where: AT, throws: [] }
  try {
    await kit.cmd('/gamemode survival')
    await kit.gamerule('send_command_feedback', 'true')
    await kit.cmd('/time set day')
    await kit.cmd('/effect give @s minecraft:slow_falling 40 0 true')
    await kit.cmd(`/execute in minecraft:overworld run tp @s ${AT[0]} 200 ${AT[1]}`)
    await sleep(5000)
    await kit.cmd(`/spreadplayers ${AT[0]} ${AT[1]} 0 30 false @s`, { reply: /Spread|Could not/, ms: 45000 })
    await sleep(3000)
    await kit.cmd('/clear @s')
    for (const g of ['iron_pickaxe', 'iron_sword', 'cooked_beef 16', 'cobblestone 48', `ender_eye ${N + 2}`]) await kit.cmd(`/give @s minecraft:${g}`)
    await kit.cmd('/effect clear @s')
    await sleep(1500)
    res.start = (await header()).pos
    for (let i = 0; i < N; i++) {
      const before = await have('ender_eye')
      const r = await call('stronghold', { mode: 'throw', timeoutSeconds: 90 })
      const d = r.detail || {}
      const after = await have('ender_eye')
      const h = await header()
      const t = { i: i + 1, status: r.status, by: r.by ? r.by.type : undefined, broke: !!d.broke, lost: !!d.lost, back: after >= before, fetched: d.fetched, pos: h.pos, hp: h.health }
      res.throws.push(t)
      console.log(`  бросок ${i + 1}: ${JSON.stringify(t)}`)
      if (r.by && r.by.type === 'death') break
    }
  } catch (e) {
    res.error = e.message
    console.log('сцена оборвалась:', e.message)
  } finally {
    const th = res.throws
    res.thrown = th.length
    res.broke = th.filter(t => t.broke).length
    res.back = th.filter(t => t.back).length
    res.lost = th.filter(t => !t.back && !t.broke).length
    res.deaths = kit.between(t0, gameClock.now(), 'death').length
    res.seconds = Math.round((gameClock.now() - t0) / 1000)
    fs.appendFileSync(OUT, JSON.stringify(res) + '\n')
    console.log(`\nИТОГ: брошено ${res.thrown}, вернулось ${res.back}, разбилось ${res.broke}, потеряно ${res.lost}, смертей ${res.deaths}, ${res.seconds} с`)
    try { await call('stop') } catch {}
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
