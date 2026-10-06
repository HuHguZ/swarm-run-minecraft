import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Point } from './src/navigation/geometry'
import type { WaterLaunch } from './src/navigation/parkour'
const { connect, createKit } = require('./scene-kit')
interface Physics { pos: Point; onGround: boolean; velocity: Point; controls: Record<string, boolean>; worldLoaded?: boolean; isInWater?: boolean; clutch?: { waterPlan?: boolean; stats?: { water_saved?: number; water_plans?: number; water_failed?: number }; lastDecision?: unknown } }
interface Clock { ticks: number; serverTicks?: number; tickRate: number; effectiveRate?: number; lagTicks?: number }
interface Reply { status: string; state: { health: number; pos: Point; inventory: Record<string, number>; clock?: Clock }; detail: { server?: string; physics?: Physics; ok?: boolean; ticks?: number; samples?: Array<{ isInWater?: boolean; onGround: boolean; velocity: Point; pos: Point }>; [key: string]: unknown } }
interface Connection { ready: Promise<void>; heard: Array<{ type: string }>; call(method: string, params?: Record<string, unknown>): Promise<Reply>; close(): void }
interface Scene { name: string; drop: number; block: string; launch?: WaterLaunch; refuse?: boolean; far?: boolean }
const scenes: Scene[] = [
  ...[12, 45, 100].map(drop => ({ name: `water-${drop}`, drop, block: 'water[level=0]' })),
  { name: 'water-side-speed', drop: 45, block: 'water[level=0]', launch: { ticks: 2, yawOffset: .7, sprint: true } },
  { name: 'crystal-up', drop: 45, block: 'amethyst_cluster[facing=up,waterlogged=true]' },
  { name: 'bud-side-narrow', drop: 45, block: 'large_amethyst_bud[facing=west,waterlogged=true]' },
  { name: 'crystal-side-refusal', drop: 45, block: 'amethyst_cluster[facing=west,waterlogged=true]', refuse: true },
  { name: 'unreachable-refusal', drop: 3, block: 'water[level=0]', refuse: true, far: true }
]

export async function runWaterFixture(): Promise<void> {
  assert.equal(Number(process.env.FARM_SLOT), 31)
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8831'); assert.equal(process.env.MC_USERNAME, 'NeuroFarm31')
  assert.ok(process.env.ND_SERVER_LOG)
  const connection: Connection = connect(process.env.ND_WS); await connection.ready
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const command = async (text: string) => { const reply = await kit.cmd(text); assert.ok(reply.ok, `water fixture preparation failed: ${text}: ${reply.why}`) }
  const status = async () => connection.call('status', { physics: true })
  const failures: string[] = []
  try {
    await connection.call('connect'); assert.equal((await status()).detail.server, '127.0.0.1:25631')
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    await command('/gamemode creative'); await kit.ensureWorld('overworld', { tp: '4020.5 145 3600.5' })
    await command('/gamerule keep_inventory false')
    const selected = process.env.SCENE ? scenes.filter(scene => scene.name === process.env.SCENE) : scenes
    assert.ok(selected.length, 'unknown SCENE')
    for (const scene of selected) {
      await connection.call('stop'); await command('/gamemode creative')
      await kit.fillExact('overworld', [[4017, 140, 3596], [4032, 242, 3604]], 'air')
      await kit.fillExact('overworld', [[4017, 139, 3596], [4032, 139, 3604]], 'stone')
      const cell = { x: scene.far ? 4028 : 4022, y: 140, z: 3600 }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) await command(`/setblock ${cell.x + dx} 140 ${cell.z + dz} stone`)
      await command(`/setblock ${cell.x} 140 ${cell.z} minecraft:${scene.block}`)
      const start = { x: 4021.2, y: 140 + scene.drop, z: 3600.5 }
      await command(`/setblock 4020 ${start.y - 1} 3600 stone`)
      await command('/clear @s'); await command('/effect clear @s')
      await command('/effect give @s minecraft:instant_health 1 5 true'); await command('/effect give @s minecraft:saturation 1 5 true')
      // Vanilla teleport preserves existing horizontal motion. Let ordinary
      // ground friction remove the previous swim/launch velocity on a broad
      // platform before placing the feet on its supported edge.
      await command(`/tp @s 4020.5 ${start.y} 3600.5 -90 0`)
      await connection.call('wait', { seconds: 1 })
      await command(`/tp @s ${start.x} ${start.y} ${start.z} -90 0`)
      // Preparing commands does not prove the bot received the arena chunks.
      // Stay creative until the actual observed footing and nearby world exist.
      let ready = await status()
      for (let tries = 0; tries < 20 && (!ready.detail.physics?.worldLoaded || !ready.detail.physics.onGround || Math.hypot(ready.detail.physics.pos.x - start.x, ready.detail.physics.pos.y - start.y, ready.detail.physics.pos.z - start.z) > .05); tries++) {
        await new Promise<void>(resolve => setTimeout(resolve, 100)); ready = await status()
      }
      const receipt = JSON.stringify({ expected: start, actual: ready.detail.physics })
      assert.equal(ready.detail.physics?.worldLoaded, true, `water arena chunks must be observed before Survival: ${receipt}`)
      assert.equal(ready.detail.physics.onGround, true, `native physics must confirm actual start footing: ${receipt}`)
      assert.ok(Math.hypot(ready.detail.physics.pos.x - start.x, ready.detail.physics.pos.y - start.y, ready.detail.physics.pos.z - start.z) < .05, `actual start must match prepared ledge: ${receipt}`)
      await command('/gamemode survival')
      await connection.call('wait', { seconds: 1 })
      const before = await status(); const mark = connection.heard.length; const began = Date.now()
      assert.equal(before.state.clock?.tickRate, 750); assert.equal(before.state.health, 20)
      assert.equal(before.detail.physics?.worldLoaded, true); assert.equal(before.detail.physics.onGround, true)
      assert.ok(!Object.keys(before.state.inventory).some(name => /bucket/.test(name)), 'existing-water fixture must carry no bucket')
      const automatic = process.env.AUTO_WATER === '1'
      const action = await connection.call('parkour', { mode: 'waterentry', target: cell, ticks: 160, launch: scene.launch, automatic, timeoutSeconds: 30 })
        .catch(async (error: Error): Promise<Reply> => ({ status: 'error', state: (await status()).state, detail: { ok: false, error: error.message } }))
      let after = await status()
      const observations: Array<{ isInWater?: boolean; onGround: boolean; velocity: Point; pos: Point; hp: number; ticks?: number }> = []
      const savedBefore = before.detail.physics?.clutch?.stats?.water_saved ?? 0
      if (automatic && !scene.refuse) {
        // Tactical cancellation hands this fall to the reflex. Observe it over
        // wall transport time; another wait Skill would immediately be cancelled.
        const deadline = Date.now() + 5000; let lastTick = -1
        while (Date.now() < deadline) {
          const physics = after.detail.physics; const tick = after.state.clock?.ticks
          if (physics && tick != null && tick !== lastTick) {
            lastTick = tick; observations.push({ isInWater: physics.isInWater, onGround: physics.onGround, velocity: physics.velocity, pos: physics.pos, hp: after.state.health, ticks: tick })
          }
          if (after.state.health < 20 || connection.heard.slice(mark).some(event => event.type === 'death')) break
          if ((physics?.clutch?.stats?.water_saved ?? 0) > savedBefore && observations.slice(-4).length === 4 && observations.slice(-4).every(sample => sample.isInWater)) break
          if (tick != null && tick - (before.state.clock?.ticks ?? tick) > 240) break
          await new Promise<void>(resolve => setTimeout(resolve, 5)); after = await status()
        }
      } else { await connection.call('wait', { seconds: 1 }); after = await status() }
      const samples = automatic ? observations : action.detail.samples ?? []; const p = after.detail.physics?.pos
      const died = connection.heard.slice(mark).some(event => event.type === 'death') || after.state.health <= 0
      const wet = samples.slice(-4).every(sample => sample.isInWater) && samples.length >= 4
      const inside = !!p && p.x > cell.x + .3 && p.x < cell.x + .7 && p.z > cell.z + .3 && p.z < cell.z + .7 && p.y >= cell.y - .03 && p.y < cell.y + .9
      const refused = action.detail.ok === false && action.detail.ticks === 0 && after.detail.physics?.onGround === true && !!p && Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z) < .05
      const automaticSaved = (after.detail.physics?.clutch?.stats?.water_saved ?? 0) > savedBefore
      const ok = !died && after.state.health === 20 && (scene.refuse ? refused : (automatic ? automaticSaved : action.detail.ok === true) && wet && inside)
      const wallMs = Date.now() - began; const clocks = { targetTPS: 750, before: before.state.clock, after: after.state.clock,
        averageServerTPS: before.state.clock?.serverTicks != null && after.state.clock?.serverTicks != null ? (after.state.clock.serverTicks - before.state.clock.serverTicks) * 1000 / Math.max(1, wallMs) : undefined }
      const firstAir = samples.find(sample => !sample.onGround)
      const row = { physical: true, slot: 31, scene: scene.name, automatic, automaticSaved, observations, preparedDrop: scene.drop, realInitialAirVelocity: firstAir?.velocity, cell, ok, died, clocks, wallMs, before, action, after }
      const text = JSON.stringify(row); console.log(text); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, text + '\n')
      if (!ok) failures.push(scene.name)
    }
    assert.deepEqual(failures, [], `physical water entry failures: ${failures.join(', ')}`)
  } finally { try { await connection.call('stop') } catch {}; connection.close() }
}
if (require.main === module) runWaterFixture().catch(error => { console.error(error); process.exitCode = 1 })
