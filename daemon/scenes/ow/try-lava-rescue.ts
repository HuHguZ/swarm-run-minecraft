import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { TacticalSnapshot } from '../../src/tactics/minecraft'
import type { Position } from '../../src/core/world-state'
import { REPO_ROOT } from '../../src/paths'
type Mode = 'pearl' | 'flight' | 'fire-wall' | 'web-boat' | 'none'
interface Event { type: string; action?: string; phase?: string; source?: string; [key: string]: unknown }
interface State { health: number; food: number; pos: Position; tactics: TacticalSnapshot; clock?: { gameMs: number; ticks: number; serverTicks?: number; frozen: boolean }; busy?: string | null; physics?: { pos: Position; worldLoaded: boolean } }
interface Result { status: string; state: State; detail?: unknown }
interface Connection { ready: Promise<void>; heard: Event[]; call(method: string, params?: Record<string, unknown>): Promise<Result>; close(): void }
import { connect, createKit } from '../lib/scene-kit'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function runLavaScene(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  const player = process.env.MC_USERNAME ?? `NeuroFarm${slot}`
  const mode = (process.env.MODE || 'pearl') as Mode
  const threats = process.env.THREATS !== '0'
  const falling = process.env.FALLING === '1'
  assert.ok(['pearl', 'flight', 'fire-wall', 'web-boat', 'none'].includes(mode))
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'farm only; exact matching slot and WS required')
  assert.equal(player, `NeuroFarm${slot}`)
  assert.ok(process.env.ND_SERVER_LOG)
  const saved = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, 'daemon', `../farm/server-${slot}/intellect-arena.json`), 'utf8')) as { arena: Position }
  assert.deepEqual(saved.arena, { x: 3000, y: 106, z: 2900, r: 24 }, 'measured ellipse fixture required')
  const connection: Connection = connect(process.env.ND_WS)
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    let timer: NodeJS.Timeout | undefined
    try { return await Promise.race([connection.call(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC wall deadline')), 15000) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  await connection.ready
  const kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const command = async (text: string, required = true) => {
    const result = await kit.cmd(text)
    if (required) assert.ok(result.ok, `fixture command failed: ${text}: ${result.why}`)
  }
  const save = (row: Record<string, unknown>) => {
    const text = JSON.stringify(row)
    console.log(text)
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, text + '\n')
  }
  const status = async () => { const reply = await call('status', { physics: true }); return { ...reply.state, physics: (reply.detail as { physics?: State['physics'] } | undefined)?.physics } }
  const foe = '@e[type=minecraft:skeleton,tag=nd_lava_rescue]'
  const expected = mode === 'pearl' ? 'PearlEscape' : mode === 'flight' ? 'FlightEscape' : mode === 'fire-wall' ? 'ClimbOut' : 'WebBoatEscape'
  try {
    await call('connect')
    await call('stop')
    await call('play_mode', { mode: 'free' })
    await command('/tick unfreeze')
    await command('/gamemode creative')
    await command('/effect clear @s', false)
    await command('/attribute @s minecraft:max_health base set 20')
    await command(`/kill ${foe}`, false)
    await command('/clear @s', false)
    await command('/tp @s 3071.5 106 2900.5')
    await command('/fill 3077 101 2896 3083 108 2904 minecraft:air')
    await command('/fill 3077 96 2896 3083 100 2904 minecraft:lava')
    await command('/fill 3077 95 2896 3083 95 2904 minecraft:obsidian')
    await command('/difficulty normal')
    await command('/time set midnight')
    await command('/gamerule keep_inventory false')
    await command('/give @s minecraft:iron_sword')
    if (mode === 'pearl') await command('/give @s minecraft:ender_pearl 8')
    if (mode === 'flight') {
      await command('/item replace entity @s armor.chest with minecraft:elytra')
      await command('/give @s minecraft:firework_rocket 32')
    }
    if (mode === 'fire-wall') {
      await command('/give @s minecraft:splash_potion[potion_contents={potion:"minecraft:long_fire_resistance"}] 1')
      await command('/give @s minecraft:cobblestone 64')
    }
    if (mode === 'web-boat') for (const item of ['cobweb 4', 'cobblestone 16', 'oak_boat 2']) await command(`/give @s minecraft:${item}`)
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await command('/effect give @s minecraft:saturation 1 5 true')
    const readyBy = Date.now() + 10000
    let ready = await status()
    const prepared = () => ready.health === 20 && ready.food === 20 && ready.clock?.frozen === false && ready.physics?.worldLoaded &&
      Math.abs(ready.physics.pos.x - 3071.5) < .1 && Math.abs(ready.physics.pos.z - 2900.5) < .1 && ready.physics.pos.y >= 105.9
    while (!prepared() && Date.now() < readyBy) { await sleep(25); ready = await status() }
    assert.equal(ready.health, 20, 'fixture must confirm actual full health before measurement')
    assert.equal(ready.food, 20, 'fixture must confirm actual full hunger before measurement')
    assert.equal(ready.clock?.frozen, false, 'fixture must confirm a running server clock')
    assert.ok(prepared(), 'fixture must confirm actual destination chunks before entering Survival lava')
    await command('/effect clear @s')
    await command('/gamemode survival')
    const before = await status()
    assert.equal(before.health, 20, 'fixture preparation lost health before the attempt')
    const mark = connection.heard.length
    await command(`/tp @s 3078.5 ${falling ? 114 : 100.1} 2900.5`)
    if (mode !== 'none' && threats) await command('/summon minecraft:skeleton 3075.5 106 2900.5 {Tags:["nd_lava_rescue"],PersistenceRequired:1b}')
    const began = Date.now()
    const samples: Array<Record<string, unknown>> = []
    let last = before
    let died = false
    let escaped = false
    do {
      last = await status()
      samples.push({ wallMs: Date.now() - began, hp: last.health, pos: last.pos, clock: last.clock, physics: last.physics, tactics: last.tactics })
      died ||= connection.heard.slice(mark).some(event => event.type === 'death') || last.health <= 0
      const ellipse = ((last.pos.x - saved.arena.x) / 76) ** 2 + ((last.pos.z - saved.arena.z) / 64) ** 2
      const shore = connection.heard.slice(mark).find(event => event.type === 'tactical_finished' && event.action === 'ClimbOut' &&
        (event.detail as { ok?: boolean } | undefined)?.ok)?.detail as { target?: Position } | undefined
      const point = last.physics?.pos
      const onOriginalShore = !!point && !!shore?.target && Math.abs(point.x - shore.target.x) < .25 &&
        Math.abs(point.z - shore.target.z) < .25 && point.y >= shore.target.y - .2
      const onDrySide = onOriginalShore || ellipse < .98 && last.pos.y >= 104 || ellipse > 1.4
      escaped = !died && last.health > 0 && onDrySide && last.tactics.state?.lava === false &&
        last.tactics.state.airborne === false && last.tactics.state.burning === false &&
        last.tactics.replanRevision > before.tactics.replanRevision && connection.heard.slice(mark).some(event => event.type === 'tactical_released')
      if (died || escaped) break
      await sleep(25)
    } while (Date.now() - began < 15000)
    const events = connection.heard.slice(mark)
    save({ slot, mode, threats, falling, physical: true, hpBefore: before.health, hpAfter: last.health, clockBefore: before.clock, clockAfter: last.clock, died, escaped, events, samples })
    if (mode === 'none') {
      assert.equal(died, true, 'unresourced lava has an honest death outcome')
      assert.ok(!events.some(event => event.type === 'tactical_phase' && event.phase === 'Done'))
    } else {
      assert.ok(events.some(event => event.type === 'tactical_selected' && event.action === expected), `${expected} was not selected`)
      if (falling) assert.ok(events.some(event => event.type === 'tactical_selected' && event.action === expected && event.lavaAhead && event.health === 20), 'rescue must begin on the real forecast before lava contact')
      assert.equal(died, false, 'rescue fixture died')
      assert.equal(escaped, true, 'rescue did not produce actual position outside the moat and replan')
      if (mode === 'web-boat') assert.ok(events.some(event => event.type === 'tactical_phase' && event.phase === 'Done'), 'all web/boat runtime phases must finish')
    }
  } finally {
    try { await call('stop') } catch {}
    try { await command(`/kill ${foe}`, false) } catch {}
    connection.close()
  }
}
if (require.main === module) runLavaScene().catch(error => { console.error(error); process.exitCode = 1 })
