// Sprint vs sprint-jump on a flat built corridor (ND_SPRINT_JUMP is read by the daemon,
// so the A/B is two runs: daemons started without and with the flag).
//   node farm/farm.js run try-parkour-sprint.js --slots 17 --tag s6-sprint-off TICK_RATE=750 REPEAT=5
//   ND_SPRINT_JUMP=1 node farm/farm.js daemons 17 && node farm/farm.js run try-parkour-sprint.js --slots 17 --tag s6-sprint-on TICK_RATE=750 REPEAT=5
//   LAYOUT=lava-edge — walkway between lava and a trench (since 06.10 sprint jump is on by default; ND_SPRINT_JUMP=0 — off).
// Measures game ticks for a 70-block straight goto and the server's food exhaustion.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const { connect, createKit } = require('./scene-kit')

export async function runSprintCorridor(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && slot !== 29, 'sprint corridor: farm slot other than the author map (29)')
  assert.equal(process.env.ND_WS, `ws://127.0.0.1:${8800 + slot}`)
  const connection = connect(process.env.ND_WS); await connection.ready
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const rcon = (command: string) => execFileSync(process.execPath, [path.resolve(__dirname, '../farm/farm.js'), 'rcon', String(slot), command], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const exhaustion = () => Number(/:\s*(-?[\d.]+)f?\s*$/.exec(rcon(`data get entity ${process.env.MC_USERNAME} foodExhaustionLevel`).trim())?.[1] ?? NaN)
  const status = async () => connection.call('status', { physics: true })
  try {
    await connection.call('connect'); assert.equal((await status()).detail.server, `127.0.0.1:${25600 + slot}`)
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    await kit.cmd('/gamemode creative'); await kit.ensureWorld('overworld', { tp: '4101.5 141 3701.5' })
    // LAYOUT=lava-edge (s6b): a 2-wide walkway (z 3700..3701) between a lava strip (z 3702, at floor level) and a
    // 10-deep trench (z 3699): sprint jumps must not cost health here (sprintjump side check).
    const lavaEdge = process.env.LAYOUT === 'lava-edge'
    await kit.fillExact('overworld', [[4097, 128, 3697], [4183, 146, 3705]], 'air')
    if (lavaEdge) {
      await kit.fillExact('overworld', [[4097, 128, 3697], [4183, 128, 3705]], 'stone')
      await kit.fillExact('overworld', [[4098, 129, 3700], [4182, 139, 3701]], 'stone')
      await kit.fillExact('overworld', [[4097, 138, 3702], [4183, 140, 3703]], 'stone')
      await kit.fillExact('overworld', [[4098, 139, 3702], [4182, 139, 3702]], 'lava')
    } else await kit.fillExact('overworld', [[4098, 139, 3699], [4182, 139, 3703]], 'stone')
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 1))
    // Preparation only (farm): a movement A/B without mobs and night (s6b-sprint-flat-on: a zombie at night slew the
    // body mid-trial and tactical fights stretched the walk 2.5x — not a property of sprint jumping).
    await kit.cmd('/gamerule spawn_mobs false'); await kit.cmd('/gamerule advance_time false'); await kit.cmd('/time set 6000')
    for (let trial = 0; trial < repeat; trial++) {
      await connection.call('stop'); await kit.cmd('/gamemode creative')
      await kit.cmd('/kill @e[type=!player,distance=..96]')
      await kit.cmd(lavaEdge ? '/tp @s 4101.5 140 3700.5 -90 0' : '/tp @s 4101.5 140 3701.5 -90 0')
      await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
      await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
      await kit.cmd('/gamemode survival'); await connection.call('wait', { seconds: 1 })
      const before = await status(); const ex0 = exhaustion()
      const mark = connection.heard.length
      const reply = await connection.call('goto', { x: 4175, y: 140, z: lavaEdge ? 3700 : 3701, range: 1, timeoutSeconds: 60 })
      const after = await status(); const ex1 = exhaustion()
      const ticks = (after.state.clock?.ticks ?? NaN) - (before.state.clock?.ticks ?? NaN)
      const end = after.detail.physics?.pos
      const died = connection.heard.slice(mark).some((event: { type: string }) => event.type === 'death') || after.state.health <= 0
      const row = { physical: true, slot, trial, layout: lavaEdge ? 'lava-edge' : 'flat', sprintJump: process.env.ND_SPRINT_JUMP_EXPECTED ?? null, status: reply.status, ticks, hp: after.state.health, died, distance: end ? end.x - 4101.5 : null,
        blocksPerSecond: end ? (end.x - 4101.5) / (ticks / 20) : null, exhaustion: Number.isFinite(ex1 - ex0) ? ex1 - ex0 : null, ok: reply.status === 'done' && !!end && Math.abs(end.x - 4175.5) < 2 && !died && after.state.health === 20,
        clocks: { before: before.state.clock, after: after.state.clock } }
      console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    }
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runSprintCorridor().catch(error => { console.error(error); process.exitCode = 1 })
