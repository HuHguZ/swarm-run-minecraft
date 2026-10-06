import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Point } from './src/navigation/geometry'
const { connect, createKit } = require('./scene-kit')
interface Clock { ticks: number; serverTicks?: number; tickRate: number; effectiveRate?: number; lagTicks?: number }
interface Physics { pos: Point; velocity: Point; onGround: boolean; isInWater?: boolean; worldLoaded?: boolean }
interface Reply { status: string; state: { health: number; isRaining: boolean; clock?: Clock; busy?: string | null }; detail?: { server?: string; physics?: Physics; ok?: boolean; ticks?: number; serverSpin?: boolean; chargedTicks?: number; moved?: number; samples?: Array<{ pos: Point; velocity: Point; onGround: boolean; isInWater?: boolean }>; [key: string]: unknown } }
interface Connection { ready: Promise<void>; heard: Array<{ type: string }>; call(method: string, params?: Record<string, unknown>): Promise<Reply>; close(): void }
interface Scene { name: string; level: number; wet?: boolean; rain?: boolean; height?: number; pitch: number; target: Point; ceiling?: boolean; releaseRoof?: boolean; refuse?: boolean; airborne?: boolean }
const start = { x: 4050.5, y: 141, z: 3600.5 }
const scenes: Scene[] = [
  { name: 'water-level1', level: 1, wet: true, pitch: 0, target: { x: 4059.5, y: 141, z: 3600.5 } },
  { name: 'water-level3', level: 3, wet: true, pitch: 0, target: { x: 4068.5, y: 141, z: 3600.5 } },
  { name: 'rain-horizontal', level: 3, rain: true, pitch: 0, target: { x: 4068.5, y: 141, z: 3600.5 } },
  { name: 'water-height', level: 3, wet: true, height: 14, pitch: .6, target: { x: 4078.5, y: 155, z: 3600.5 } },
  { name: 'rain-height', level: 3, rain: true, height: 14, pitch: .6, target: { x: 4078.5, y: 155, z: 3600.5 } },
  { name: 'water-clipped-ceiling', level: 3, wet: true, ceiling: true, pitch: 0, target: { x: 4068.5, y: 141, z: 3600.5 } },
  { name: 'dry-refusal', level: 3, pitch: 0, target: { x: 4068.5, y: 141, z: 3600.5 }, refuse: true },
  { name: 'damaging-return-refusal', level: 3, rain: true, pitch: Math.PI / 2, target: start, refuse: true },
  { name: 'unreachable-height-refusal', level: 3, wet: true, pitch: .6, target: { x: 4078.5, y: 171, z: 3600.5 }, refuse: true },
  { name: 'airborne-rain', level: 3, rain: true, airborne: true, pitch: .6, target: { x: 4080.5, y: 140, z: 3600.5 } },
  { name: 'airborne-rain-roof-refusal', level: 3, rain: true, airborne: true, releaseRoof: true, pitch: .6, target: { x: 4080.5, y: 140, z: 3600.5 }, refuse: true }
]

export async function runRiptideFixture(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && slot !== 29, 'riptide fixture: farm slot other than the author map (29)')
  assert.equal(process.env.ND_WS, `ws://127.0.0.1:${8800 + slot}`)
  assert.equal(process.env.MC_USERNAME, `NeuroFarm${slot}`); assert.ok(process.env.ND_SERVER_LOG)
  const connection: Connection = connect(process.env.ND_WS); await connection.ready
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  // Preparation only: a silent reply under farm load is retried (s6-water-series3: one silent /fill).
  const command = async (text: string) => { let reply = await kit.cmd(text); for (let i = 0; i < 2 && !reply.ok && reply.why === 'silent'; i++) reply = await kit.cmd(text); assert.ok(reply.ok, `riptide preparation failed: ${text}: ${reply.why}`) }
  const status = () => connection.call('status', { physics: true, enchants: true })
  const failures: string[] = []
  try {
    await connection.call('connect'); assert.equal((await status()).detail?.server, `127.0.0.1:${25600 + slot}`)
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' }); await command('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '4050.5 141 3600.5' }); await command('/gamerule keep_inventory false')
    const automatic = process.env.AUTO_ROUTE === '1'
    const supportedScenes = automatic ? scenes.filter(scene => !scene.refuse && !scene.airborne) : scenes
    const selected = process.env.SCENE ? supportedScenes.filter(scene => scene.name === process.env.SCENE) : supportedScenes
    assert.ok(selected.length, 'unknown SCENE')
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 1))
    for (const scene of Array.from({ length: repeat }, () => selected).flat()) {
     try {
      const sceneStart = scene.airborne ? { ...start, y: 181 } : start
      const preparationMark = connection.heard.length
      await connection.call('stop'); await command('/gamemode creative')
      await kit.fillExact('overworld', [[4045, 141, 3596], [4093, 180, 3604]], 'air')
      await kit.fillExact('overworld', [[4045, 181, 3596], [4093, 185, 3604]], 'air')
      await kit.fillExact('overworld', [[4045, 140, 3596], [4093, 140, 3604]], 'stone')
      // Vanilla teleport preserves momentum from the previous course. Let
      // actual ground friction stop it before preparing the final wet start.
      await command('/tp @s 4050.5 141 3600.5 -90 0'); await connection.call('wait', { seconds: 1 })
      await connection.call('stop')
      // A genuine bounded position-hold intent owns preparation, so the idle
      // autopilot does not swim out of an intentionally occupied launch pool.
      // Damage/death/emergency interrupts remain enabled.
      const parked = connection.call('wait', { seconds: 300, holdPosition: true }).catch((error: Error): Reply => ({ status: 'error', state: { health: -1, isRaining: false }, detail: { error: error.message } }))
      await command('/fillbiome 4045 140 3596 4093 180 3604 minecraft:desert')
      await command('/fillbiome 4045 140 3596 4093 180 3604 minecraft:plains')
      if (scene.height) await kit.fillExact('overworld', [[4072, 141, 3599], [4084, 140 + scene.height, 3601]], 'stone')
      if (scene.airborne) {
        await kit.fillExact('overworld', [[4045, 139, 3596], [4093, 139, 3604]], 'stone')
        await kit.fillExact('overworld', [[4045, 140, 3596], [4093, 142, 3604]], 'water[level=0]')
        await command('/setblock 4050 180 3600 stone')
      }
      if (scene.wet) await kit.fillExact('overworld', scene.airborne ? [[4050, 181, 3600], [4050, 181, 3600]] : [[4049, 141, 3599], [4051, 141, 3601]], 'water[level=0]')
      if (scene.ceiling) await kit.fillExact('overworld', [[4049, 143, 3599], [4052, 143, 3601]], 'oak_slab[type=bottom,waterlogged=false]')
      if (scene.releaseRoof) await kit.fillExact('overworld', [[4052, 184, 3599], [4093, 184, 3601]], 'stone')
      await command(`/weather ${scene.rain ? 'rain' : 'clear'} 1000000`)
      await command('/clear @s'); await command('/effect clear @s')
      await command('/effect give @s minecraft:instant_health 1 5 true'); await command('/effect give @s minecraft:saturation 1 5 true')
      await command(`/give @s minecraft:trident[minecraft:enchantments={"minecraft:riptide":${scene.level}}] 1`)
      await command(`/tp @s ${sceneStart.x} ${sceneStart.y} ${sceneStart.z} -90 0`); await connection.call('wait', { seconds: 1 })
      // Activation is measured in Survival: creative flight can skip native
      // fluid movement, so its wet flag is not a launch precondition.
      await command('/gamemode survival'); await connection.call('wait', { seconds: 1 })
      await command('/effect clear @s')
      let ready = await status()
      for (let tries = 0; tries < 30; tries++) {
        const physics = ready.detail?.physics
        if (physics?.worldLoaded && physics.onGround && !!physics.isInWater === !!scene.wet && ready.state.isRaining === !!scene.rain && Math.hypot(physics.pos.x - sceneStart.x, physics.pos.y - sceneStart.y, physics.pos.z - sceneStart.z) < .05) break
        await connection.call('wait', { seconds: 1 }); ready = await status()
      }
      const preparation = { preparation: true, slot, scene: scene.name, expected: { start: sceneStart, wet: !!scene.wet, rain: !!scene.rain }, ready, events: connection.heard.slice(preparationMark) }
      console.log(JSON.stringify(preparation))
      if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(preparation) + '\n')
      assert.ok(ready.detail?.physics?.worldLoaded && ready.detail.physics.onGround, `actual Riptide footing is not ready: ${JSON.stringify(ready)}`)
      assert.equal(ready.state.busy, 'hold_position', `Riptide preparation hold expired or was interrupted: ${JSON.stringify(ready)}`)
      assert.equal(!!ready.detail.physics.isInWater, !!scene.wet, `actual Riptide wet receipt: ${JSON.stringify(ready)}`)
      assert.equal(ready.state.isRaining, !!scene.rain, `actual Riptide rain receipt: ${JSON.stringify(ready)}`)
      assert.ok(Math.hypot(ready.detail.physics.pos.x - sceneStart.x, ready.detail.physics.pos.y - sceneStart.y, ready.detail.physics.pos.z - sceneStart.z) < .05, `actual Riptide start receipt: ${JSON.stringify(ready)}`)
      await connection.call('stop'); await parked
      const before = await status(); const mark = connection.heard.length; const began = Date.now()
      assert.equal(before.state.health, 20); assert.equal(before.state.clock?.tickRate, 750)
      assert.ok(before.detail?.physics?.worldLoaded); assert.equal(before.detail.physics.onGround, true)
      assert.equal(!!before.detail.physics.isInWater, !!scene.wet)
      assert.equal(before.state.isRaining, !!scene.rain)
      const action = await connection.call('parkour', automatic ? { mode: 'route', target: scene.target, maxLandings: 2, timeoutSeconds: 30 }
        : { mode: 'riptide', target: scene.target, pitch: scene.pitch, launch: scene.airborne ? { ticks: 6 } : undefined, timeoutSeconds: 30 })
        .catch(async (error: Error): Promise<Reply> => ({ status: 'error', state: (await status()).state, detail: { ok: false, error: error.message } }))
      const after = await status(); const p = after.detail?.physics?.pos
      const died = connection.heard.slice(mark).some(event => event.type === 'death') || after.state.health <= 0
      const measured = automatic ? (action.detail?.landings as Array<NonNullable<Reply['detail']>> | undefined)?.find(landing => landing.mode === 'riptide') : action.detail
      const samples = measured?.samples ?? []; const last = samples.slice(-6)
      const supported = !!p && after.detail?.physics?.onGround && Math.abs(p.y - scene.target.y) < .04 && Math.hypot(p.x - scene.target.x, p.z - scene.target.z) < .3
      const refused = action.detail?.ok === false && !action.detail.serverSpin && (action.detail.ticks ?? 0) === 0 && !!p && Math.hypot(p.x - sceneStart.x, p.y - sceneStart.y, p.z - sceneStart.z) < .05
      const launchSamples = (measured?.launchSamples ?? []) as Array<{ pos: Point; onGround: boolean }>
      const chargeSamples = (measured?.chargeSamples ?? []) as Array<{ pos: Point; onGround: boolean }>
      const releaseState = measured?.releaseState as { onGround: boolean } | undefined
      const airborneWitness = !scene.airborne || launchSamples.some(sample => !sample.onGround) && chargeSamples.length >= 13 && chargeSamples.every(sample => !sample.onGround) && releaseState?.onGround === false
      const useServerAt = measured?.useServerAt; const releaseServerAt = measured?.releaseServerAt
      const serverChargeWitness = typeof useServerAt === 'number' && typeof releaseServerAt === 'number' && releaseServerAt - useServerAt >= 13 * 50
      const ok = !died && after.state.health === 20 && (scene.refuse ? refused : action.detail?.ok === true && measured?.serverSpin === true && (measured.chargedTicks ?? 0) >= 13 && serverChargeWitness && supported && last.length === 6 && last.every(sample => sample.onGround || sample.isInWater) && airborneWitness)
      const wallMs = Date.now() - began
      const clocks = { targetTPS: 750, before: before.state.clock, after: after.state.clock,
        averageServerTPS: before.state.clock?.serverTicks != null && after.state.clock?.serverTicks != null ? (after.state.clock.serverTicks - before.state.clock.serverTicks) * 1000 / Math.max(1, wallMs) : undefined }
      const row = { physical: true, slot, scene: scene.name, automatic, ok, died, target: scene.target, airborneWitness, serverChargeWitness, wallMs, clocks, maxActualY: Math.max(sceneStart.y, ...[...launchSamples, ...chargeSamples, ...samples].map(sample => sample.pos.y)), before, action, after }
      const text = JSON.stringify(row); console.log(text); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, text + '\n')
      if (!ok) failures.push(scene.name)
     } catch (error) {
      // A series records a fixture/infrastructure fault (silent command, lost
      // footing, reconnect) as its own row and continues; a single run still throws.
      if (repeat === 1) throw error
      const row = { physical: false, fixtureError: true, scene: scene.name, slot, error: String((error as Error)?.message ?? error).slice(0, 600) }
      console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
     }
    }
    assert.deepEqual(failures, [], `physical Riptide failures: ${failures.join(', ')}`)
  } finally { try { await connection.call('stop'); await command('/weather clear 1000000') } catch {}; connection.close() }
}
if (require.main === module) runRiptideFixture().catch(error => { console.error(error); process.exitCode = 1 })
