'use strict'
// Отладка осмотра: где skyLava видит кандидатов и где лава у клиента (агент G, слот 30).
process.chdir(require('path').join(__dirname, '..', '..', 'daemon'))
const { connect, createKit, sleep } = require(require('path').join(process.cwd(), 'scene-kit'))
const conn = connect('ws://127.0.0.1:8830')
;(async () => {
  await conn.ready; await conn.call('connect')
  const kit = createKit({ call: conn.call, heard: conn.heard, logFile: '../farm/server-30/logs/latest.log', player: 'NeuroFarm30' })
  await kit.cmd('/gamemode creative')
  const [x, z] = (process.argv[2] || '-457,-411').split(',').map(Number)
  await kit.cmd(`/spreadplayers ${x} ${z} 0 1 false @s`); await sleep(5000)
  const r = await conn.call('portal_natural', { mode: 'survey', radius: 96 })
  console.log(JSON.stringify({ me: r.detail.me, cand: r.detail.skyCandidates, seen: r.detail.seenSources, best: r.detail.best, sites: r.detail.sites, ruins: r.detail.ruins }))
  const f = await conn.call('blocks_around', { find: 'lava', radius: 96, count: 3000 })
  const L = f.detail.found
  console.log('лава у клиента', L.length, JSON.stringify(L.filter(p => p.y > 55).slice(0, 12)))
  await conn.call('disconnect'); process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
