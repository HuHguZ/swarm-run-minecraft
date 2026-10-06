'use strict'
// Отладка взгляда сверху: тело на камне в (x, y, z), осмотр и лучи к клеткам (агент G, слот 30).
process.chdir(require('path').join(__dirname, '..', '..', 'daemon'))
const { connect, createKit, sleep } = require(require('path').join(process.cwd(), 'scene-kit'))
const conn = connect('ws://127.0.0.1:8830')
;(async () => {
  await conn.ready; await conn.call('connect')
  const kit = createKit({ call: conn.call, heard: conn.heard, logFile: '../farm/server-30/logs/latest.log', player: 'NeuroFarm30' })
  await kit.cmd('/gamemode creative')
  const [x, y, z] = process.argv[2].split(',').map(Number)
  await kit.cmd(`/setblock ${x} ${y - 1} ${z} minecraft:stone`)
  await kit.cmd(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`); await sleep(5000)
  const r = await conn.call('portal_natural', { mode: 'survey', radius: 128 })
  console.log(JSON.stringify({ me: r.detail.me, cand: r.detail.skyCandidates, sample: r.detail.skySample, seen: r.detail.seenSources, best: r.detail.best }))
  for (const t of process.argv.slice(3)) {
    const [a, b, c] = t.split(',').map(Number)
    const q = await conn.call('portal_natural', { mode: 'ray', at: { x: a, y: b, z: c } })
    console.log(JSON.stringify(q.detail && { hit: q.detail.hit, block: q.detail.block, path: q.detail.path.slice(0, 5) }))
  }
  await conn.call('disconnect'); process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
