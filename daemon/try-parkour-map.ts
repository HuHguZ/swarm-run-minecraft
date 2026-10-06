import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Point } from './src/navigation/geometry'
const { connect } = require('./scene-kit')
interface Clock { ticks: number; serverTicks?: number; tickRate: number; effectiveRate?: number; lagTicks?: number }
interface Reply { status: string; state: { health: number; pos: Point; clock?: Clock }; detail?: Record<string, unknown>; events?: Array<{ type: string; text?: string; [key: string]: unknown }> }
interface Connection { ready: Promise<void>; heard: Reply['events']; call(method: string, params?: Record<string, unknown>): Promise<Reply>; close(): void }

export function authorRespawn(reply: string): Point | undefined {
  const pos = /\bpos:\s*\[I;\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(reply)
  return pos ? { x: Number(pos[1]), y: Number(pos[2]), z: Number(pos[3]) } : undefined
}

export async function runAuthorMap(): Promise<void> {
  assert.equal(Number(process.env.FARM_SLOT), 29)
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8829')
  assert.equal(process.env.MC_USERNAME, 'NeuroFarm29')
  assert.ok(process.env.ND_SERVER_LOG, 'a native server log is required to verify map game mode')
  const connection: Connection = connect(process.env.ND_WS)
  await connection.ready
  try {
    const connected = await connection.call('connect')
    let before = await connection.call('status', { physics: true })
    const deadline = Date.now() + 20_000
    let firstTicks = before.state?.clock?.ticks
    while (Date.now() < deadline) {
      const physics = before.detail?.physics as { pos?: Point; worldLoaded?: boolean } | undefined
      if (physics?.worldLoaded && physics.pos && [physics.pos.x, physics.pos.y, physics.pos.z].every(Number.isFinite) && before.state.health > 0 && firstTicks != null && (before.state.clock?.ticks ?? 0) > firstTicks) break
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      before = await connection.call('status', { physics: true })
      firstTicks ??= before.state?.clock?.ticks
    }
    assert.ok(before.detail && (before.detail.physics as { worldLoaded?: boolean } | undefined)?.worldLoaded && (before.state.clock?.ticks ?? 0) > (firstTicks ?? Infinity), `author map connection/world/clock not ready: ${JSON.stringify({ connected, before })}`)
    assert.equal(before.detail.server, '127.0.0.1:25629')
    assert.equal(before.state.clock?.tickRate, 750, 'author map requires target 750 TPS')
    // Author maps mute player command feedback. The existing farm RCON CLI
    // reads native mode directly and is used only before the measured route.
    const native = (command: string) => execFileSync(process.execPath, [path.resolve(__dirname, '../farm/farm.js'), 'rcon', '29', command], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
    const modeQuery = 'data get entity NeuroFarm29 playerGameType'
    let modeReply = native(modeQuery)
    assert.ok(/has the following entity data: [0-3]$/.test(modeReply), `native author map game mode could not be read: ${modeReply}`)
    if (!/has the following entity data: 0$/.test(modeReply)) {
      native('gamemode survival NeuroFarm29')
      modeReply = native(modeQuery)
    }
    assert.ok(/has the following entity data: 0$/.test(modeReply), `author map measurement requires actual Survival: ${modeReply}`)
    const gameModeReceipt = { source: 'native_rcon', query: modeQuery, reply: modeReply, playerGameType: 0 }
    const respawnQuery = 'data get entity NeuroFarm29 respawn'
    const respawnBefore = native(respawnQuery)
    before = await connection.call('status', { physics: true })
    const began = Date.now()
    // Semantic author landmarks orient the search. Every intermediate landing
    // still comes from visible, loaded collision shapes, including the lily pads.
    // Approach the start plate before asking for ascent toward the finish zone.
    const phase = process.env.MAP_PHASE ?? 'approach'
    assert.ok(['approach', 'checkpoint', 'finish'].includes(phase), 'unknown MAP_PHASE')
    const target = phase === 'approach' ? { x: .5, y: 52, z: -48.5 }
      : phase === 'checkpoint' ? { x: -16.5, y: 59, z: -38.5 } : { x: 0, y: 240, z: 0 }
    const exact = (before.detail.physics as { pos: Point } | undefined)?.pos
    const metadata = phase === 'finish' ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../codex-lab/parkour-map-1.21.11/semantic-landmarks.json'), 'utf8')) as { checkpoints: Point[] } : undefined
    const nextCheckpoint = Number(process.env.MAP_NEXT_CHECKPOINT ?? 2)
    assert.ok(Number.isInteger(nextCheckpoint) && nextCheckpoint >= 1 && nextCheckpoint <= (metadata?.checkpoints.length ?? 100))
    const waypoints = metadata?.checkpoints.filter((point, index) => {
      assert.ok([point.x, point.y, point.z].every(Number.isFinite) && Math.abs(point.x) < 100 && Math.abs(point.z) < 100 && point.y > 0 && point.y < 240, 'invalid semantic checkpoint data')
      // Height does not prove a checkpoint was activated: an authored route can
      // rise above it before bending back down. Resume from the observed ordinal.
      return index >= nextCheckpoint - 1
    })
    const options = await connection.call('parkour', { mode: 'options', target })
    const maxFallDamage = Number(process.env.MAP_MAX_FALL_DAMAGE ?? 0)
    assert.ok(maxFallDamage === 0 || maxFallDamage === 1, 'only explicit MAP_MAX_FALL_DAMAGE=1 permits a controlled mitigated drop')
    const progress = await connection.call('parkour', { mode: 'route', target, waypoints, maxLandings: Number(process.env.MAX_LANDINGS ?? 80), beam: 24, maxTicks: 38, timeoutSeconds: Number(process.env.MAP_TIMEOUT ?? 600), maxFallDamage })
      .catch(async (error: Error): Promise<Reply> => ({ status: 'error', state: (await connection.call('status')).state, detail: { ok: false, error: error.message } }))
    const after = await connection.call('status', { physics: true })
    const start = (before.detail.physics as { pos: Point } | undefined)?.pos
    const end = (after.detail?.physics as { pos: Point } | undefined)?.pos
    assert.ok(start && end, 'exact physics coordinates are required; state.pos is floored')
    const landings = (progress.detail?.landings ?? []) as Array<{ at: Point; ok: boolean }>
    const maxLandingY = Math.max(start.y, end.y, ...landings.map(landing => landing.at.y))
    const events = connection.heard ?? []
    const checkpoints = events.filter(event => /checkpoint/i.test(event.text ?? ''))
    const started = events.some(event => /time started/i.test(event.text ?? ''))
    const died = events.some(event => event.type === 'death') || after.state.health <= 0
    const finished = events.some(event => event.type === 'advancement' && event.id === 'main:finish' || event.type === 'author_win' && event.finished === true)
    const boundedProgress = !died && landings.some(landing => landing.ok) && Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) > .2
    const wallMs = Date.now() - began
    const clocks = { targetTPS: 750, before: before.state.clock, after: after.state.clock,
      averageServerTPS: before.state.clock?.serverTicks != null && after.state.clock?.serverTicks != null ? (after.state.clock.serverTicks - before.state.clock.serverTicks) * 1000 / Math.max(1, wallMs) : undefined }
    // The map uses vanilla spawnpoint for actual checkpoint activation. Its
    // muted actionbar bridge does not affect this native 1.21.11 respawn receipt.
    // Read after the measured snapshot so RCON latency cannot distort clock TPS.
    const respawnAfter = native(respawnQuery)
    const checkpoint = (reply: string) => {
      const pos = authorRespawn(reply)
      const index = pos && metadata?.checkpoints.findIndex(point => Math.floor(point.x) === pos.x && point.y === pos.y && Math.floor(point.z) === pos.z)
      return { pos, ordinal: index != null && index >= 0 ? index + 1 : undefined, reply }
    }
    const authoredCheckpoint = { source: 'native_rcon', query: respawnQuery, before: checkpoint(respawnBefore), after: checkpoint(respawnAfter), changed: JSON.stringify(authorRespawn(respawnBefore)) !== JSON.stringify(authorRespawn(respawnAfter)) }
    const row = { authorMap: true, physical: true, slot: 29, phase, target, nextCheckpoint, maxFallDamage, semanticWaypoints: waypoints, gameMode: 'survival', gameModeReceipt, wallMs, clocks, before, options, progress, after, startExact: start, endExact: end, maxLandingY, boundedProgress, startedTextObserved: started, died, checkpoints, authoredCheckpoint, finished, events }
    const text = JSON.stringify(row)
    console.log(text)
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, text + '\n')
    assert.ok(progress.detail, `parkour RPC did not return an action result: ${JSON.stringify(progress)}`)
    assert.equal(died, false, 'author map attempt died')
    if (process.env.REQUIRE_FINISH === '1') assert.equal(finished, true, 'no actual author win event')
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runAuthorMap().catch(error => { console.error(error); process.exitCode = 1 })
