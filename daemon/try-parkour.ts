import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Point } from './src/navigation/geometry'
const { connect, createKit } = require('./scene-kit')
interface Physics { pos: Point; onGround: boolean; velocity: Point; controls: Record<string, boolean> }
interface Clock { ticks: number; serverTicks?: number; tickRate: number; effectiveRate?: number; lagTicks?: number }
interface Reply { status: string; state: { health: number; pos: Point; clock?: Clock }; detail: { server?: string; physics?: Physics; ok?: boolean; samples?: unknown[]; [key: string]: unknown } }
interface Connection { ready: Promise<void>; heard: Array<{ type: string }>; call(method: string, params?: Record<string, unknown>): Promise<Reply>; close(): void }
interface Scene { name: string; floor: string; target: Point; mode?: 'edge' | 'climb' | 'webcatch'; bounce?: Point; start?: Point; landingCell?: Point; extended?: boolean; extra?: Array<[Point, string]> }
const origin = { x: 4000, y: 140, z: 3600 }
const scenes: Scene[] = [
  { name: 'slab', floor: 'oak_slab[type=bottom,waterlogged=false]', target: { x: 4002.5, y: 140.5, z: 3600.5 } },
  { name: 'skull', floor: 'skeleton_skull[rotation=0]', target: { x: 4002.5, y: 140.5, z: 3600.5 } },
  { name: 'pane', floor: 'glass_pane[north=false,south=false,east=false,west=false,waterlogged=false]', target: { x: 4002.5, y: 141, z: 3600.5 } },
  { name: 'fence', floor: 'oak_fence[north=false,south=false,east=false,west=false,waterlogged=false]', target: { x: 4002.5, y: 141.5, z: 3600.5 } },
  // Upward tips punish falling even on a small hop. This case measures standing
  // and moving on the genuine supported tip; it does not claim a harmless jump.
  { name: 'dripstone', floor: 'pointed_dripstone[vertical_direction=up,thickness=tip,waterlogged=false]', target: { x: 4002.5, y: 140.6875, z: 3600.5 }, mode: 'edge',
    start: { x: 4002.375, y: 140.6875, z: 3600.375 }, extra: [[{ x: 4002, y: 139, z: 3600 }, 'stone']] },
  { name: 'wall-around', floor: 'oak_fence[north=false,south=false,east=false,west=false,waterlogged=false]', target: { x: 4002.5, y: 141.5, z: 3600.5 },
    extra: [[{ x: 4000, y: 140, z: 3599 }, 'stone'], [{ x: 4001, y: 141, z: 3600 }, 'stone'], [{ x: 4001, y: 142, z: 3600 }, 'stone']] },
  { name: 'fence-edge', floor: 'oak_fence[north=false,south=false,east=false,west=false,waterlogged=false]', target: { x: 4002.87, y: 141.5, z: 3600.5 }, mode: 'edge' },
  ...['ladder', 'vine'].map((name): Scene => ({ name: `${name}-climb`, mode: 'climb', extended: true,
    floor: 'stone', landingCell: { x: 4001, y: 144, z: 3600 }, target: { x: 4001.5, y: 145, z: 3600.5 },
    extra: Array.from({ length: 4 }, (_, i): Array<[Point, string]> => [
      [{ x: 4001, y: 141 + i, z: 3600 }, 'stone'],
      [{ x: 4000, y: 141 + i, z: 3600 }, name === 'ladder' ? 'ladder[facing=west,waterlogged=false]' : 'vine[east=true,north=false,south=false,west=false,up=false]']
    ]).flat() })),
  { name: 'web-catch', mode: 'webcatch', extended: true, floor: 'cobweb', landingCell: { x: 4002, y: 142, z: 3600 },
    target: { x: 4002.5, y: 142, z: 3600.5 }, start: { x: 4002.1, y: 162, z: 3600.5 } },
  { name: 'slime-bounce', floor: 'stone', landingCell: { x: 4007, y: 143, z: 3600 }, target: { x: 4007.5, y: 144, z: 3600.5 },
    start: { x: 4002.5, y: 146, z: 3600.5 }, bounce: { x: 4004.5, y: 141, z: 3600.5 },
    extra: [[{ x: 4000, y: 145, z: 3600 }, 'stone'], [{ x: 4001, y: 145, z: 3600 }, 'stone'], [{ x: 4002, y: 145, z: 3600 }, 'stone'],
      [{ x: 4004, y: 140, z: 3600 }, 'slime_block'], [{ x: 4005, y: 140, z: 3600 }, 'slime_block'], [{ x: 4008, y: 143, z: 3600 }, 'stone']] }
]

export async function runParkourFixture(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.equal(slot, 31, 'parkour fixture owns the isolated lane of slot 31 only')
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8831')
  assert.equal(process.env.MC_USERNAME, 'NeuroFarm31')
  assert.ok(process.env.ND_SERVER_LOG)
  const connection: Connection = connect(process.env.ND_WS)
  await connection.ready
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const command = async (text: string) => {
    const reply = await kit.cmd(text)
    assert.ok(reply.ok, `fixture preparation failed: ${text}: ${reply.why}`)
  }
  const set = async (pos: Point, block: string) => command(`/setblock ${pos.x} ${pos.y} ${pos.z} minecraft:${block}`)
  const status = async () => connection.call('status', { physics: true })
  try {
    await connection.call('connect')
    assert.equal((await status()).detail.server, '127.0.0.1:25631')
    await connection.call('stop')
    await connection.call('play_mode', { mode: 'free' })
    await command('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '4000.5 141 3600.5' })
    await command('/gamerule keep_inventory false')
    await kit.fillExact('overworld', [[3997, 130, 3596], [4010, 130, 3604]], 'stone')
    const selected = process.env.SCENE ? scenes.filter(scene => scene.name === process.env.SCENE) : scenes
    assert.ok(selected.length, 'unknown SCENE')
    const failures: string[] = []
    for (const scene of selected) {
      await connection.call('stop')
      await command('/gamemode creative')
      await kit.fillExact('overworld', [[3997, 131, 3596], [4010, 165, 3604]], 'air')
      await set(origin, 'stone')
      for (const [pos, block] of scene.extra ?? []) await set(pos, block)
      await set(scene.landingCell ?? { x: 4002, y: 140, z: 3600 }, scene.floor)
      await command('/clear @s')
      await command('/effect clear @s')
      await command('/effect give @s minecraft:instant_health 1 5 true')
      await command('/effect give @s minecraft:saturation 1 5 true')
      const start = scene.start ?? (scene.mode === 'edge' ? { x: 4002.5, y: 141.5, z: 3600.5 } : { x: 4000.5, y: 141, z: 3600.5 })
      await command(`/tp @s ${start.x} ${start.y} ${start.z} -90 0`)
      await command('/gamemode survival')
      await connection.call('wait', { seconds: 1 })
      const before = await status(); const mark = connection.heard.length; const began = Date.now()
      assert.equal(before.state.clock?.tickRate, 750, 'all physical parkour fixtures require target 750 TPS')
      // All operator preparation is complete. Measurement contains only normal
      // controls and observations; neither position nor onGround are overwritten.
      const action = await connection.call('parkour', { target: scene.target, bounce: scene.bounce, mode: scene.mode ?? 'jump', beam: 60, maxTicks: scene.bounce ? 90 : 38, ticks: scene.mode === 'climb' ? 180 : 60, timeoutSeconds: 30 })
        .catch(async (error: Error): Promise<Reply> => ({ status: 'error', state: (await status()).state, detail: { ok: false, error: error.message } }))
      const settle = scene.mode === 'climb' && action.detail.ok === true ? await connection.call('parkour', { mode: 'edge', target: scene.target, ticks: 20, timeoutSeconds: 30 }) : undefined
      const after = await status()
      const died = connection.heard.slice(mark).some(event => event.type === 'death') || after.state.health <= 0
      const p = after.detail.physics?.pos
      const supported = after.detail.physics?.onGround === true && !!p && Math.abs(p.y - scene.target.y) < .04 && Math.hypot(p.x - scene.target.x, p.z - scene.target.z) < .25
      const caught = scene.mode === 'webcatch' && after.detail.physics?.onGround === false && Math.abs(after.detail.physics.velocity.y) < .16 && (action.detail.samples as Array<{ isInWeb?: boolean }> | undefined)?.some(sample => sample.isInWeb)
      const rebound = !scene.bounce || (action.detail.samples as Array<{ pos: Point; velocity: Point; onGround: boolean }> | undefined)?.some(sample => Math.abs(sample.pos.y - scene.bounce!.y) < .02 && sample.velocity.y > .3 && sample.onGround)
      const ok = !!p && !died && after.state.health === before.state.health && action.detail.ok === true && rebound && (scene.mode === 'webcatch' ? caught : supported) && (!settle || settle.detail.ok === true)
      const wallMs = Date.now() - began
      const clocks = { targetTPS: 750, before: before.state.clock, after: after.state.clock,
        averageServerTPS: before.state.clock?.serverTicks != null && after.state.clock?.serverTicks != null ? (after.state.clock.serverTicks - before.state.clock.serverTicks) * 1000 / Math.max(1, wallMs) : undefined }
      const row = { physical: true, scene: scene.name, slot, ok, died, wallMs, clocks, before, action, settle, after }
      const text = JSON.stringify(row)
      console.log(text)
      if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, text + '\n')
      if (!ok) failures.push(scene.name)
    }
    assert.deepEqual(failures, [], `physical parkour failures: ${failures.join(', ')}`)
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runParkourFixture().catch(error => { console.error(error); process.exitCode = 1 })
