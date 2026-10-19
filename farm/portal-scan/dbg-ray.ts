'use strict'
process.chdir((require('path') as typeof import('path')).join(__dirname, '..', '..', 'daemon'))
const { connect, createKit, sleep } = require((require('path') as typeof import('path')).join(process.cwd(), 'scenes', 'lib', 'scene-kit'))
const conn = connect('ws://127.0.0.1:8830')
;(async () => {
  await conn.ready; await conn.call('connect')
  const kit = createKit({ call: conn.call, heard: conn.heard, logFile: '../farm/server-30/logs/latest.log', player: 'NeuroFarm30' })
  await kit.cmd('/gamemode creative')
  const [x, z] = process.argv[2].split(',').map(Number)
  await kit.cmd(`/spreadplayers ${x} ${z} 0 1 false @s`); await sleep(5000)
  for (const t of process.argv.slice(3)) {
    const [a, b, c] = t.split(',').map(Number)
    const r = await conn.call('portal_natural', { mode: 'ray', at: { x: a, y: b, z: c } })
    console.log(JSON.stringify(r.detail || r.error))
  }
  await conn.call('disconnect'); process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
