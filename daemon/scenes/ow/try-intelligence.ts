import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { TacticalSnapshot } from '../../src/tactics/minecraft'
import type { Position } from '../../src/core/world-state'

interface Event { type: string; action?: string; threatLevel?: number; dug?: number; byItself?: boolean; replanRevision?: number }
interface State { health: number; food: number; dimension: string; pos: Position; busy: string | null; tactics: TacticalSnapshot; clock?: { tickRate: number }; username?: string }
interface Result { status: string; error?: string; code?: string; by?: { type: string }; state: State; detail?: Record<string, unknown>; events?: Event[] }
interface Connection { ready: Promise<void>; heard: Event[]; call(method: string, params?: Record<string, unknown>): Promise<Result>; close(): void }
interface Kit {
  cmd(text: string): Promise<{ ok: boolean; why?: string }>
  fillExact(dim: string, box: number[][], block: string): Promise<unknown>
  ensureWorld(dim: string, options: { tp: string }): Promise<unknown>
}
import { connect, createKit } from '../lib/scene-kit'
const wallSleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
const deadline = <T>(work: Promise<T>, milliseconds = 15000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Wall deadline ${milliseconds}ms exceeded`)), milliseconds)
  work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

export async function runIntelligenceScene(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  const player = process.env.MC_USERNAME ?? `NeuroFarm${slot}`
  assert.ok(slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'farm only; explicit slot and matching WS required')
  assert.equal(player, `NeuroFarm${slot}`, 'farm fixture player required')
  assert.ok(process.env.ND_SERVER_LOG, 'explicit farm server log required')
  const connection: Connection = connect(process.env.ND_WS)
  await deadline(connection.ready)
  const call = (method: string, params: Record<string, unknown> = {}) => deadline(connection.call(method, params))
  const kit: Kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const rows: Array<Record<string, unknown>> = []
  const save = (row: Record<string, unknown>) => {
    rows.push(row)
    console.log(JSON.stringify(row))
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
  }
  const command = async (text: string, confirm = true) => {
    const result = await kit.cmd(text)
    if (confirm) assert.ok(result.ok, `farm command not confirmed: ${text}: ${result.why}`)
  }
  const status = async () => (await call('status')).state
  const poll = async (name: string, accept: (state: State) => boolean) => {
    const start = Date.now()
    let state: State
    do {
      state = await status()
      assert.ok(state.health > 0, `${name}: bot died`)
      if (accept(state)) return state
      await wallSleep(25)
    } while (Date.now() - start < 15000)
    throw new Error(`${name}: wall timeout: ${JSON.stringify({ state, events: connection.heard.slice(-12) })}`)
  }
  const revision = (state: State) => state.tactics?.replanRevision ?? 0
  const mob = '@e[type=minecraft:zombie,tag=nd_intelligence]'
  let fixtureReady = false
  try {
    assert.equal((await call('connect')).status, 'done')
    await call('stop')
    await call('play_mode', { mode: 'free' })
    await command('/gamemode creative', false)
    await command('/effect clear @s', false)
    await kit.ensureWorld('overworld', { tp: '2800.5 205 2800.5' })
    await kit.fillExact('overworld', [[2796, 200, 2796], [2832, 205, 2806]], 'air')
    await kit.fillExact('overworld', [[2796, 199, 2796], [2832, 199, 2806]], 'stone')
    await command(`/kill ${mob}`, false)
    await command('/clear @s', false)
    for (const item of ['iron_pickaxe', 'iron_sword', 'bread 16', 'cobblestone 64']) await command(`/give @s minecraft:${item}`)
    await command('/tp @s 2800.5 200 2800.5')
    await command('/gamemode survival')
    await command('/effect give @s minecraft:saturation 1 5 true')
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await poll('fixture ready', state => state.health === 20 && state.food === 20 && Math.abs(state.pos.y - 200) < 0.1 && state.tactics?.threatLevel === 0)
    fixtureReady = true

    const beforeEmbed = await status()
    const embedMark = connection.heard.length
    await command('/setblock 2802 201 2800 minecraft:stone')
    await command('/tp @s 2802.5 200 2800.5')
    const freed = await poll('honest embedded rescue', state => revision(state) > revision(beforeEmbed) && state.tactics.threatLevel === 0 &&
      connection.heard.slice(embedMark).some(event => event.type === 'freed' && (event.dug ?? 0) > 0))
    const embedEvents = connection.heard.slice(embedMark)
    assert.ok(embedEvents.some(event => event.type === 'tactical_selected' && event.action === 'FreeEmbedded'), 'Emergency graph selected FreeEmbedded')
    const block = await call('blocks_around', { find: 'stone', radius: 3, count: 64 })
    assert.ok(!(block.detail?.found as Position[] | undefined)?.some(position => position.x === 2802 && position.y === 201 && position.z === 2800), 'server/client confirms the obstructing stone is gone')
    assert.equal(freed.tactics.requireObservation, true)
    await call('observe', { radius: 4 })
    assert.equal((await status()).tactics.requireObservation, false)
    save({ slot, name: 'FreeEmbedded', ok: true, hpBefore: beforeEmbed.health, hp: freed.health, revision: revision(freed), events: embedEvents })

    // Invulnerable, immobile opponent keeps a real skill active without adding lethal fixture damage.
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await poll('combat fixture healthy', state => state.health === 20)
    await command('/tp @s 2800.5 200 2800.5')
    await command('/summon minecraft:zombie 2810.5 200 2800.5 {Tags:["nd_intelligence"],NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}')
    const visible = await poll('fixture zombie visible', state => !!state.tactics.state?.enemies.some(enemy => enemy.kind === 'zombie' && enemy.threatening))
    const target = visible.tactics.state!.enemies.find(enemy => enemy.kind === 'zombie' && enemy.threatening)!
    const fightMark = connection.heard.length
    const fight = call('fight', { target: '#' + target.id, purpose: 'command', clearArea: 0, timeoutSeconds: 300 }).then(result => {
      save({ slot, name: 'fight-rpc-result', status: result.status, code: result.code, error: result.error, by: result.by, detail: result.detail })
      return result
    })
    await Promise.race([poll('skill fight started', state => state.busy === 'fight'),
      fight.then(result => { throw new Error(`fight ended before critical input: ${JSON.stringify(result)}`) })])
    await command(`/tp ${mob} 2803.5 200 2800.5`)
    const beforeFight = await status()
    assert.equal(beforeFight.busy, 'fight')
    await command('/damage @s 14 minecraft:generic')
    await poll('critical tactical preemption', state => connection.heard.slice(fightMark).some(event => event.type === 'tactical_selected' && (event.threatLevel ?? 0) >= 3 &&
      ['Flee', 'CreateDistance', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Heal'].includes(event.action ?? '')))
    const result = await fight
    assert.equal(result.status, 'interrupted', JSON.stringify(result))
    assert.equal(result.by?.type, 'tactical', 'skill interrupted by graph ownership')
    await command(`/kill ${mob}`)
    const released = await poll('tactical release and replan', state => revision(state) > revision(beforeFight) && state.tactics.threatLevel === 0)
    await call('observe', { radius: 4 })
    const observed = await status()
    assert.equal(observed.tactics.requireObservation, false)
    assert.ok(connection.heard.slice(fightMark).some(event => event.type === 'tactical_released'), 'fresh replan signal emitted')
    save({ slot, name: 'fight-critical-release', ok: true, hpBefore: beforeFight.health, hp: released.health, revision: revision(released),
      status: result.status, by: result.by, events: connection.heard.slice(fightMark) })
  } catch (error) {
    save({ slot, name: 'intelligence-failed', ok: false, error: error instanceof Error ? error.message : String(error), events: connection.heard.slice(-20), rows: rows.length })
    throw error
  } finally {
    try { await call('stop') } catch {}
    if (fixtureReady) { try { await command(`/kill ${mob}`, false) } catch {} }
    connection.close()
  }
}
if (require.main === module) runIntelligenceScene().catch(error => { console.error(error); process.exitCode = 1 })
