import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { BoatHopResult } from './src/tactics/boat-hop-graph'
interface Event { type: string; action?: string; phase?: string; [key: string]: unknown }
interface State { health: number; food: number; dimension: string; pos: { x: number; y: number; z: number }; busy?: string | null; tactics?: unknown }
interface Connection { ready: Promise<void>; heard: Event[]; call(method: string, params?: Record<string, unknown>): Promise<{ state: State; detail?: { physics?: { onGround: boolean; worldLoaded: boolean; isInLava: boolean }; [key: string]: unknown }; [key: string]: unknown }>; close(): void }
const { connect, createKit } = require('./scene-kit')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function runBoatLab(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  const player = process.env.MC_USERNAME || `NeuroFarm${slot}`
  const mode = process.env.MODE || 'lava'
  assert.ok(mode === 'lava' || mode === 'fall')
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'farm only')
  assert.equal(player, `NeuroFarm${slot}`)
  assert.ok(process.env.ND_SERVER_LOG)
  const connection: Connection = connect(process.env.ND_WS)
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    let timer: NodeJS.Timeout | undefined
    try { return await Promise.race([connection.call(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC wall deadline')), 15000) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  await connection.ready
  const kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const cmd = async (text: string, required = true) => { const r = await kit.cmd(text); if (required) assert.ok(r.ok, `${text}: ${r.why}`) }
  try {
    await call('connect'); await call('stop'); await call('play_mode', { mode: 'free' })
    await cmd('/gamemode creative', false); await cmd('/effect clear @s', false); await cmd('/clear @s', false)
    await kit.forceload('the_nether', [[2793, 74, 2994], [2815, 114, 3006]])
    await cmd('/execute in minecraft:the_nether run fill 2793 75 2994 2815 114 3006 minecraft:air')
    await cmd('/execute in minecraft:the_nether run fill 2793 75 2994 2815 76 3006 minecraft:bedrock')
    await cmd('/execute in minecraft:the_nether run fill 2793 77 2994 2800 79 3006 minecraft:stone')
    await cmd('/execute in minecraft:the_nether run fill 2809 77 2994 2815 79 3006 minecraft:stone')
    await cmd('/execute in minecraft:the_nether run fill 2801 77 2994 2808 79 3006 minecraft:lava')
    await cmd('/execute in minecraft:the_nether run tp @s 2799.5 80 3000.5')
    const arrivedUntil = Date.now() + 10000
    let arrived = await call('status', { physics: true })
    while (arrived.state.dimension !== 'the_nether' || !arrived.detail?.physics?.worldLoaded || Math.hypot(arrived.state.pos.x - 2799.5, arrived.state.pos.z - 3000.5) > 2) {
      assert.ok(Date.now() < arrivedUntil, 'boat preparation dimension and loaded position were not confirmed')
      await sleep(20)
      arrived = await call('status', { physics: true })
    }
    await cmd('/gamerule keep_inventory false'); await cmd('/difficulty normal')
    await cmd('/give @s minecraft:oak_boat 16'); await cmd('/give @s minecraft:iron_sword')
    const parked = call('wait', { seconds: 300, holdPosition: true }).catch(() => null)
    await kit.must('/gamemode survival', /^Set own game mode to Survival Mode$/, 'boat preparation Survival')
    await cmd('/effect give @s minecraft:instant_health 1 5 true'); await cmd('/effect give @s minecraft:saturation 1 5 true')
    await call('wait', { seconds: 2 }); await cmd('/effect clear @s')
    let ready = await call('status', { physics: true })
    for (let tries = 0; tries < 30 && !(ready.detail?.physics?.worldLoaded && ready.detail.physics.onGround && !ready.detail.physics.isInLava); tries++) {
      await call('wait', { seconds: 1 }); ready = await call('status', { physics: true })
    }
    console.log(JSON.stringify({ preparation: true, mode, ready }))
    assert.equal(ready.state.health, 20); assert.equal(ready.state.food, 20)
    assert.equal(ready.state.dimension, 'the_nether'); assert.equal(ready.state.busy, 'hold_position')
    assert.ok(ready.detail?.physics?.worldLoaded && ready.detail.physics.onGround && !ready.detail.physics.isInLava)
    await call('stop'); await parked
    const mark = connection.heard.length
    const before = (await call('status')).state
    await cmd(`/execute in minecraft:the_nether run tp @s ${mode === 'lava' ? '2804.5 79.9 3000.5' : '2799.5 110 3000.5'}`)
    let rpc: unknown
    if (mode === 'fall') void call('boat_hop', { mode: 'fall', target: { x: 2799.5, y: 80, z: 3000.5 }, timeoutSeconds: 8, maxHops: 1 }).then(result => { rpc = result }, error => { rpc = { error: String(error) } })
    const began = Date.now()
    const samples: Array<Record<string, unknown>> = []
    let last = before
    let measured: BoatHopResult | undefined
    let died = false
    do {
      last = (await call('status')).state
      samples.push({ wallMs: Date.now() - began, hp: last.health, pos: last.pos, busy: last.busy, tactics: last.tactics })
      const events = connection.heard.slice(mark)
      measured = [...events].reverse().find(event => event.type === 'boat_hop_result') as unknown as BoatHopResult | undefined
      died ||= last.health <= 0 || events.some(event => event.type === 'death')
      if (died || measured) break
      await sleep(25)
    } while (Date.now() - began < 15000)
    const settleUntil = Date.now() + 1000
    while (died && !measured && Date.now() < settleUntil) {
      await sleep(10)
      measured = [...connection.heard.slice(mark)].reverse().find(event => event.type === 'boat_hop_result') as unknown as BoatHopResult | undefined
    }
    const events = connection.heard.slice(mark)
    const row = { slot, mode, physical: true, dimension: 'the_nether', hpBefore: before.health, hpAfter: last.health, died,
      result: measured, rpc, events, samples }
    const line = JSON.stringify(row)
    console.log(line)
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, line + '\n')
    assert.ok(measured, 'the real skill result was not observed')
    assert.ok(measured.witnesses.length >= 1, 'no server-confirmed passenger hop occurred')
    assert.equal(died, false, 'boat experiment died')
    assert.equal(measured.ok, true, 'a stable dry exit or fall landing was not confirmed')
  } finally { await call('stop').catch(() => {}); await call('disconnect', { reason: 'boat experiment finished' }).catch(() => {}); connection.close() }
}

if (require.main === module) runBoatLab().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
