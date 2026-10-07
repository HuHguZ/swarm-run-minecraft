// Sprint vs sprint-jump on a flat built corridor (ND_SPRINT_JUMP is read by the daemon,
// so the A/B is two runs: daemons started without and with the flag).
//   node farm/farm.js run try-parkour-sprint.js --slots 17 --tag s6-sprint-off TICK_RATE=750 REPEAT=5
//   ND_SPRINT_JUMP=1 node farm/farm.js daemons 17 && node farm/farm.js run try-parkour-sprint.js --slots 17 --tag s6-sprint-on TICK_RATE=750 REPEAT=5
//   LAYOUT=lava-edge — walkway between lava and a trench (since 06.10 sprint jump is on by default; ND_SPRINT_JUMP=0 — off).
//   S6c: SJ=ab — on/off alternate trial by trial on one daemon; LAYOUT=turns|terrain — corners; steps and a pathfinder gap jump.
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
    // LAYOUT=turns (s6c): a 1-wide zigzag carved 2 high in stone (12 along x, 6 along z, 6 legs) — corners.
    // LAYOUT=terrain (s6c): the flat corridor walled, with 1-block steps up and down and a 2-wide gap 11 deep that
    // pathfinder must take with its own parkour jump — stairs, climbs and a pathfinder jump under sprint jumping.
    const layout = process.env.LAYOUT || 'flat'
    const lavaEdge = layout === 'lava-edge'
    await kit.fillExact('overworld', [[4097, 128, 3690], [4183, 146, 3720]], 'air')
    let start = [4101.5, 140, 3701.5]; let goal = [4175, 140, 3701]; let pathLen = 74
    if (lavaEdge) {
      await kit.fillExact('overworld', [[4097, 128, 3697], [4183, 128, 3705]], 'stone')
      await kit.fillExact('overworld', [[4098, 129, 3700], [4182, 139, 3701]], 'stone')
      await kit.fillExact('overworld', [[4097, 138, 3702], [4183, 140, 3703]], 'stone')
      await kit.fillExact('overworld', [[4098, 139, 3702], [4182, 139, 3702]], 'lava')
      start = [4101.5, 140, 3700.5]; goal = [4175, 140, 3700]
    } else if (layout === 'turns') {
      await kit.fillExact('overworld', [[4098, 139, 3698], [4180, 141, 3712]], 'stone')
      let x = 4100; let z = 3700; pathLen = 0
      for (let leg = 0; leg < 6; leg++) {
        await kit.fillExact('overworld', [[x, 140, z], [x + 12, 141, z]], 'air'); x += 12; pathLen += 12
        const z2 = leg % 2 ? 3700 : 3706
        await kit.fillExact('overworld', [[x, 140, Math.min(z, z2)], [x, 141, Math.max(z, z2)]], 'air'); pathLen += 6; z = z2
      }
      start = [4100.5, 140, 3700.5]; goal = [x, 140, z]
    } else if (layout === 'terrain') {
      await kit.fillExact('overworld', [[4098, 139, 3699], [4182, 139, 3703]], 'stone')
      await kit.fillExact('overworld', [[4098, 140, 3698], [4182, 143, 3698]], 'stone')
      await kit.fillExact('overworld', [[4098, 140, 3704], [4182, 143, 3704]], 'stone')
      for (const [x, h] of [[4115, 1], [4120, 2], [4125, 3], [4150, 2], [4155, 1]]) await kit.fillExact('overworld', [[x, 140, 3699], [x + 4, 139 + h, 3703]], 'stone')
      await kit.fillExact('overworld', [[4135, 128, 3699], [4136, 139, 3703]], 'air')
      pathLen = 74 + 12 // flat length plus 6 steps up and down
    } else await kit.fillExact('overworld', [[4098, 139, 3699], [4182, 139, 3703]], 'stone')
    // SJ=ab — alternate sprint jumping on/off trial by trial on the same daemon (goto {sprintJump}): one session, one
    // world, one server load for both arms. SJ=on|off — one arm; unset — the daemon's own default (env ND_SPRINT_JUMP).
    const arm = (trial: number) => process.env.SJ === 'ab' ? trial % 2 === 0 : process.env.SJ === 'on' ? true : process.env.SJ === 'off' ? false : undefined
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 1))
    // Preparation only (farm): a movement A/B without mobs and night (s6b-sprint-flat-on: a zombie at night slew the
    // body mid-trial and tactical fights stretched the walk 2.5x — not a property of sprint jumping).
    await kit.cmd('/gamerule spawn_mobs false'); await kit.cmd('/gamerule advance_time false'); await kit.cmd('/time set 6000')
    for (let trial = 0; trial < repeat; trial++) {
      await connection.call('stop'); await kit.cmd('/gamemode creative')
      await kit.cmd('/kill @e[type=!player,distance=..96]')
      await kit.cmd(`/tp @s ${start.join(' ')} -90 0`)
      await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
      await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
      await kit.cmd('/gamemode survival'); await kit.cmd('/effect give @s minecraft:instant_health 1 5 true'); await connection.call('wait', { seconds: 1 })
      const before = await status(); const ex0 = exhaustion()
      const mark = connection.heard.length
      const sprintJump = arm(trial); const wall0 = Date.now()
      const reply = await connection.call('goto', { x: goal[0], y: goal[1], z: goal[2], range: 1, timeoutSeconds: 90, ...(sprintJump === undefined ? {} : { sprintJump }) })
      const wallMs = Date.now() - wall0
      const after = await status(); const ex1 = exhaustion()
      const ticks = (after.state.clock?.ticks ?? NaN) - (before.state.clock?.ticks ?? NaN)
      const end = after.detail.physics?.pos
      const died = connection.heard.slice(mark).some((event: { type: string }) => event.type === 'death') || after.state.health <= 0
      const away = end ? Math.hypot(end.x - (goal[0] + .5), end.z - (goal[2] + .5)) : null
      const row = { physical: true, slot, trial, layout, sprintJump: sprintJump ?? process.env.ND_SPRINT_JUMP_EXPECTED ?? null, status: reply.status, ticks, wallMs, ticksPerWallSecond: ticks / (wallMs / 1000), hp: after.state.health, died, pathLen, away,
        blocksPerSecond: pathLen / (ticks / 20), exhaustion: Number.isFinite(ex1 - ex0) ? ex1 - ex0 : null, ok: reply.status === 'done' && away !== null && away < 2 && !died && after.state.health === 20, sj: { jumps: (after.detail.physics?.sprintJump?.jumps ?? NaN) - (before.detail.physics?.sprintJump?.jumps ?? 0), skipped: (after.detail.physics?.sprintJump?.skipped ?? NaN) - (before.detail.physics?.sprintJump?.skipped ?? 0) },
        clocks: { before: before.state.clock, after: after.state.clock } }
      console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    }
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runSprintCorridor().catch(error => { console.error(error); process.exitCode = 1 })
