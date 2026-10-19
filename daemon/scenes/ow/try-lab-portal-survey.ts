'use strict'
import * as gameClock from '../../src/game-clock'
// Проба осмотра portal_natural survey с точек (агент G, ферма 29–30): POINTS="x z;x z" (y — верх столба + 2).
import { connect, createKit, sleep } from '../lib/scene-kit'
const slot = Number(process.env.FARM_SLOT || 30)
if (!(slot === 29 || slot === 30)) { console.error('только 29–30'); process.exit(1) }
const conn = connect(`ws://127.0.0.1:${8800 + slot}`)
async function main () {
  await conn.ready
  await conn.call('connect')
  const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG || `../farm/server-${slot}/logs/latest.log`, player: `NeuroFarm${slot}` })
  await kit.cmd('/gamemode creative')
  for (const pt of String(process.env.POINTS || '').split(';').filter(Boolean)) {
    const [x, z] = pt.trim().split(/\s+/).map(Number)
    await kit.cmd(`/tp @s ${x} 200 ${z}`)
    await sleep(2500)
    await kit.cmd(`/execute as @s at @s run tp @s ~ ~ ~`)
    const sp = await conn.call('situation')
    // встать на верх столба
    await kit.cmd(`/spreadplayers ${x} ${z} 0 1 false @s`)
    await sleep(3500)
    const t = gameClock.now()
    const r = await conn.call('portal_natural', { mode: 'survey', radius: Number(process.env.R || 96) })
    const d = r.detail || r
    console.log(JSON.stringify({ at: d.me, ms: gameClock.now() - t, seen: d.seenSources, skyCand: d.skyCandidates, best: d.best, sites: (d.sites || []).slice(0, 3), ruins: d.ruins, error: r.error }))
  }
  await conn.call('disconnect')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
