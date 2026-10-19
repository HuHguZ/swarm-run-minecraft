// Ladder-on-wall fall lab (s6b 06.10): a ledge `drop` blocks above a stone floor beside a stone wall, ladders in
// the hotbar, no blocks and no bucket. The bot walks off with ordinary keys (RPC parkour mode 'drop'); the fall
// reflex (clutch.ladderPlan) must click a visible side face of the wall and land through the ladder unhurt.
// Control scene `no-ladder-control` keeps the same fall without ladders: it must hurt (the fixture is real).
//   node dist/farm/farm.js run try-parkour-ladder.js --slots 17 --tag s6b-ladder1 REPEAT=10 [SCENE=ladder-25]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Point } from '../../src/navigation/geometry'
import { connect, createKit } from '../lib/scene-kit'
interface Physics { pos: Point; onGround: boolean; worldLoaded?: boolean; clutch?: { stats?: Record<string, number>; lastDecision?: unknown } }
interface Reply { status: string; error?: string; state: { health: number; inventory: Record<string, number>; clock?: { tickRate: number; serverTicks?: number } }; detail: { server?: string; physics?: Physics; ok?: boolean; why?: string; [key: string]: unknown } }
interface Connection { ready: Promise<void>; heard: Array<{ type: string; what?: string; [key: string]: unknown }>; call(method: string, params?: Record<string, unknown>): Promise<Reply>; close(): void }
interface Scene { name: string; drop: number; ladders: number }
const scenes: Scene[] = [...[12, 25, 45].map(drop => ({ name: `ladder-${drop}`, drop, ladders: 4 })), { name: 'no-ladder-control', drop: 12, ladders: 0 }]

export async function runLadderFixture(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && slot !== 29, 'ladder fixture: farm slot other than the author map (29)')
  assert.equal(process.env.ND_WS, `ws://127.0.0.1:${8800 + slot}`); assert.equal(process.env.MC_USERNAME, `NeuroFarm${slot}`)
  assert.ok(process.env.ND_SERVER_LOG)
  const connection: Connection = connect(process.env.ND_WS); await connection.ready
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  const command = async (text: string) => { let reply = await kit.cmd(text); for (let i = 0; i < 2 && !reply.ok && reply.why === 'silent'; i++) reply = await kit.cmd(text); assert.ok(reply.ok, `ladder fixture preparation failed: ${text}: ${reply.why}`) }
  const status = async () => connection.call('status', { physics: true })
  const deathLog = () => fs.readFileSync(process.env.ND_SERVER_LOG!, 'utf8').split(/\r?\n/).filter(line => line.includes(`${process.env.MC_USERNAME} `) && !/joined|left|lost connection|logged in|issued server command|has made the advancement/.test(line) && /\]: /.test(line))
  try {
    await connection.call('connect'); assert.equal((await status()).detail.server, `127.0.0.1:${25600 + slot}`)
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    await command('/gamemode creative'); await kit.ensureWorld('overworld', { tp: '4060.5 150 3640.5' })
    await command('/gamerule keep_inventory false')
    const selected = process.env.SCENE ? scenes.filter(scene => scene.name === process.env.SCENE) : scenes
    assert.ok(selected.length, 'unknown SCENE')
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 1))
    for (const scene of Array.from({ length: repeat }, () => selected).flat()) {
      try {
        await connection.call('stop'); await command('/gamemode creative')
        const top = 140 + scene.drop
        await kit.fillExact('overworld', [[4056, 140, 3636], [4070, top + 4, 3644]], 'air')
        await kit.fillExact('overworld', [[4056, 139, 3636], [4070, 139, 3644]], 'stone')
        // Wall north of the fall column (z = 3639), full height; the ledge block at (4060, top − 1, 3640).
        await kit.fillExact('overworld', [[4056, 140, 3639], [4070, top + 3, 3639]], 'stone')
        await command(`/setblock 4060 ${top - 1} 3640 stone`)
        await command('/clear @s'); await command('/effect clear @s')
        if (scene.ladders) await command(`/give @s minecraft:ladder ${scene.ladders}`)
        await command('/effect give @s minecraft:instant_health 1 5 true'); await command('/effect give @s minecraft:saturation 1 5 true')
        const start = { x: 4060.65, y: top, z: 3640.5 }
        await command(`/tp @s ${start.x} ${start.y} ${start.z} -90 0`)
        let ready = await status()
        for (let tries = 0; tries < 30 && (!ready.detail.physics?.worldLoaded || !ready.detail.physics.onGround || Math.hypot(ready.detail.physics.pos.x - start.x, ready.detail.physics.pos.y - start.y, ready.detail.physics.pos.z - start.z) > .05); tries++) {
          await new Promise<void>(resolve => setTimeout(resolve, 100)); ready = await status()
          if (tries % 5 === 4) { await command(`/tp @s ${start.x} ${start.y} ${start.z} -90 0`); ready = await status() }
        }
        assert.ok(ready.detail.physics?.worldLoaded && ready.detail.physics.onGround, `start footing not observed: ${JSON.stringify(ready.detail.physics)}`)
        await command('/gamemode survival'); await connection.call('wait', { seconds: 1 })
        const before = await status(); const mark = connection.heard.length; const logMark = deathLog().length; const began = Date.now()
        assert.equal(before.state.clock?.tickRate, 750); assert.equal(before.state.health, 20)
        assert.ok(!Object.keys(before.state.inventory).some(name => /bucket|cobblestone|dirt|stone|planks|netherrack/.test(name)), 'only ladders: no bucket and no clutch blocks')
        const ladders0 = before.detail.physics?.clutch?.stats?.ladders ?? 0
        const action = await connection.call('parkour', { mode: 'drop', target: { x: 4070, y: top, z: 3640.5 }, ticks: 240, timeoutSeconds: 30 })
          .catch(async (error: Error): Promise<Reply> => ({ status: 'error', state: (await status()).state, detail: { ok: false, error: error.message } }))
        if (!action.detail) action.detail = { ok: false, why: action.error ?? action.status }
        await connection.call('wait', { seconds: 1 })
        const after = await status()
        const events = connection.heard.slice(mark).filter(event => event.type === 'nd_clutch' || event.type === 'death' || event.type === 'damage')
        const serverLines = deathLog().slice(logMark)
        const died = connection.heard.slice(mark).some(event => event.type === 'death') || after.state.health <= 0 || serverLines.some(line => /fell|hit the ground|died|was /.test(line))
        const placed = (after.detail.physics?.clutch?.stats?.ladders ?? 0) - ladders0
        // The physical outcome decides: the 'drop' RPC itself is usually cut mid-air by the tactics (level 4
        // "dangerous fall" interrupts the running skill) and the fall is then the reflex's (s6b-ladder1: 13/15).
        const landed = !!after.detail.physics?.onGround
        const ok = scene.ladders ? !died && landed && after.state.health === 20 && placed >= 1 : !died && after.state.health < 20
        const row = { physical: true, slot, scene: scene.name, drop: scene.drop, ok, died, landed, hp: after.state.health, ladderPlaced: placed, why: action.detail.why, action: action.detail, clutch: after.detail.physics?.clutch, events: events.slice(-12), serverLines, wallMs: Date.now() - began }
        console.log(JSON.stringify(row))
        if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
      } catch (error) {
        if (repeat === 1) throw error
        const row = { physical: false, fixtureError: true, slot, scene: scene.name, error: String((error as Error)?.message ?? error) }
        console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
      }
    }
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runLadderFixture().catch(error => { console.error(error); process.exitCode = 1 })
