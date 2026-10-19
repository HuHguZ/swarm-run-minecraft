import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import type { FlightGate } from '../../src/combat/flight-route-graph'
import type { Position } from '../../src/core/world-state'
import { REPO_ROOT } from '../../src/paths'
import { connect, createKit, createGameBot, normBox, splitBox } from '../lib/scene-kit'
import * as clock from '../../src/game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

export function flightCourse(ground: { min: number; max: number }) {
  const base = ground.max + 3
  const launch = { x: 3700.5, y: base, z: 3400.5 }
  const landing = { x: 3798.5, y: base, z: 3435.5 }
  const route = [
    ['takeoff', 0, 10, 20, 0, 1], ['climb', 0, 25, 50, 0, 1],
    ['turn', 25, 26, 50, 1, 0], ['dive', 50, 15, 50, 1, 0],
    ['descent', 75, 10, 50, 1, 0], ['side-turn', 75, 14, 75, 0, 1],
    ['spiral-east', 100, 20, 75, 1, 0], ['spiral-north', 100, 25, 50, 0, -1],
    ['spiral-west', 75, 27, 25, -1, 0], ['spiral-exit', 50, 22, 25, -1, 0],
    ['approach-turn', 50, 15, 35, 0, 1], ['landing-approach', 75, 9, 35, 1, 0]
  ] as const
  const gates: FlightGate[] = route.map(([id, x, y, z, nx, nz]) => ({ id, center: { x: launch.x + x, y: base + y + .5, z: launch.z + z },
    normal: { x: nx, y: 0, z: nz }, radius: 4.5 }))
  const commands: string[] = []
  const box = [[3688, ground.min - 1, 3388], [3812, base + 35, 3488]]
  for (const b of splitBox(normBox([[3688, base, 3388], [3812, base + 35, 3488]]))) {
    commands.push(`fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)
  }
  const samples: Array<Position & { block: string }> = []
  for (const pad of [launch, landing]) {
    const x = Math.floor(pad.x); const z = Math.floor(pad.z)
    for (const b of splitBox(normBox([[x - 5, ground.min - 1, z - 5], [x + 5, base - 1, z + 5]]))) {
      commands.push(`fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:stone`)
    }
    commands.push(`fill ${x - 5} ${base} ${z - 5} ${x + 5} ${base + 4} ${z + 5} minecraft:air`)
    samples.push({ x, y: base - 1, z, block: 'stone' }, { x, y: base, z, block: 'air' })
  }
  for (const [index, gate] of gates.entries()) {
    const block = index % 2 ? 'yellow_concrete' : 'cyan_concrete'
    for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) {
      if (Math.hypot(a, b) < 5 || Math.hypot(a, b) > 6) continue
      const p = gate.normal.x ? { x: gate.center.x, y: gate.center.y + a, z: gate.center.z + b }
        : { x: gate.center.x + a, y: gate.center.y + b, z: gate.center.z }
      commands.push(`setblock ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} minecraft:${block}`)
    }
    samples.push({ x: Math.floor(gate.center.x), y: Math.floor(gate.center.y), z: Math.floor(gate.center.z), block: 'air' })
  }
  return { ground, launch, landing, gates, commands, box, samples }
}

async function naturalGround(probe: Bot, kit: any) {
  await kit.must('/tp NeuroFProbe31 3750.5 200 3440.5', null, 'course terrain probe teleport')
  const columns: Array<[number, number]> = []
  for (let x = 3696; x <= 3810; x += 16) for (let z = 3392; z <= 3488; z += 16) columns.push([x, z])
  const loaded = () => Math.hypot(probe.entity.position.x - 3750.5, probe.entity.position.z - 3440.5) < 2 &&
    columns.every(([x, z]) => probe.blockAt(new Vec3(x, 319, z)) && probe.blockAt(new Vec3(x, -64, z)))
  const readyBy = Date.now() + 15000
  while (!loaded() && Date.now() < readyBy) await clock.wall.sleep(25)
  assert.ok(loaded(), `actual course columns must be loaded at the terrain probe: ${JSON.stringify({
    position: probe.entity.position, unloaded: columns.filter(([x, z]) => !probe.blockAt(new Vec3(x, 319, z)) || !probe.blockAt(new Vec3(x, -64, z))) })}`)
  const heights: number[] = []
  for (let x = 3696; x <= 3810; x += 16) for (let z = 3392; z <= 3488; z += 16) {
    let found = false
    for (let y = 319; y >= -64; y--) {
      const block = probe.blockAt(new Vec3(x, y, z))
      if (!block) throw new Error(`flight course terrain is not loaded: ${x},${z}`)
      if (block.boundingBox === 'block' && !/water|lava/.test(block.name)) { heights.push(y); found = true; break }
    }
    if (!found) throw new Error(`flight course has no natural foundation at ${x},${z}`)
  }
  return { min: Math.min(...heights), max: Math.max(...heights) }
}

export async function runFlightCourse() {
  assert.equal(process.env.FARM_SLOT, '31')
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8831')
  assert.equal(process.env.MC_PORT, '25631')
  const slot = path.resolve(REPO_ROOT, 'farm/server-31')
  const logFile = path.resolve(process.env.ND_SERVER_LOG ?? '')
  assert.equal(logFile.toLowerCase(), path.join(slot, 'logs', 'latest.log').toLowerCase())
  const properties = fs.readFileSync(path.join(slot, 'server.properties'), 'utf8')
  const level = /^level-name=(.+)$/m.exec(properties)?.[1].trim() ?? 'world'
  const world = path.resolve(slot, level)
  assert.ok(world.startsWith(slot + path.sep))
  const cache = path.join(slot, 'flight-course.json')
  const connection = connect(process.env.ND_WS)
  let probe: Bot | null = null
  let kit: any = null
  let followedClock: { dispose(): void } | null = null
  const onClock = (value: { dispose(): void }) => { followedClock = value }
  clock.changes.on('bound', onClock)
  try {
    await connection.ready
    await connection.call('connect')
    await connection.call('stop')
    await connection.call('play_mode', { mode: 'free' })
    kit = createKit({ call: connection.call, heard: connection.heard, logFile, player: 'NeuroFarm31' })
    await kit.must('/tick unfreeze', null, 'unfrozen course setup')
    await kit.cmd('/gamemode creative NeuroFarm31')
    await kit.cmd('/effect clear NeuroFarm31')
    await kit.must('/attribute NeuroFarm31 minecraft:max_health base set 20', null, 'normal health fixture')
    await kit.gamerule('keep_inventory', false)
    await kit.forceload('overworld', [[3688, -64, 3388], [3812, 319, 3488]])
    const saved = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null
    let ground = saved?.ground
    if (!ground) {
      probe = createGameBot({ host: '127.0.0.1', port: 25631, username: 'NeuroFProbe31', auth: 'offline', version: '1.21.11' })
      await new Promise<void>((resolve, reject) => { probe!.once('spawn', () => resolve()); probe!.once('error', reject); probe!.once('kicked', reason => reject(new Error(String(reason)))) })
      await kit.cmd('/gamemode spectator NeuroFProbe31')
      ground = await naturalGround(probe!, kit)
    }
    const course = flightCourse(ground)
    if (!saved?.ready || process.env.FLIGHT_REBUILD === '1') {
      fs.writeFileSync(cache, JSON.stringify({ ground, ready: false }) + '\n')
      const pack = path.join(world, 'datapacks', 'neurodown_flight_course')
      const functions = path.join(pack, 'data', 'neurodown_flight_course', 'function')
      fs.mkdirSync(functions, { recursive: true })
      fs.writeFileSync(path.join(pack, 'pack.mcmeta'), JSON.stringify({ pack: { description: 'NeuroDown farm31 flight course', min_format: [94, 1], max_format: [94, 1] } }) + '\n')
      const batches: string[][] = []
      for (let i = 0; i < course.commands.length; i += 200) batches.push(course.commands.slice(i, i + 200))
      batches.forEach((commands, i) => fs.writeFileSync(path.join(functions, `batch_${i}.mcfunction`), commands.join('\n') + `\nscoreboard players set #batch nd_flight ${i + 1}\n`))
      await kit.must('/reload', null, 'flight datapack reload')
      await kit.cmd('/scoreboard objectives add nd_flight dummy')
      const witness = '#w' + process.pid.toString(36) + Date.now().toString(36).slice(-5)
      let serial = 0
      const confirm = async (condition: string) => {
        const value = ++serial
        await kit.must(`/execute ${condition} run scoreboard players set ${witness} nd_flight ${value}`,
          new RegExp(`^Set \\[nd_flight\\] for ${witness} to ${value}$`), 'flight course actual block witness')
      }
      for (const [i] of batches.entries()) {
        await kit.must(`/function neurodown_flight_course:batch_${i}`, null, 'flight batch execution')
        await confirm(`if score #batch nd_flight matches ${i + 1}`)
      }
      for (const p of course.samples) await confirm(`if block ${p.x} ${p.y} ${p.z} minecraft:${p.block}`)
      fs.writeFileSync(cache, JSON.stringify({ ground, ready: true }) + '\n')
    }
    console.log('FLIGHT_COURSE', JSON.stringify({ ...course, commands: course.commands.length, viewer: 'http://127.0.0.1:3131' }))
    await kit.cmd('/gamemode creative NeuroFarm31')
    await kit.cmd('/clear NeuroFarm31')
    await kit.must('/item replace entity NeuroFarm31 armor.chest with minecraft:elytra', null, 'elytra kit')
    await kit.must('/give NeuroFarm31 minecraft:firework_rocket 64', null, 'rocket kit')
    await kit.must('/give NeuroFarm31 minecraft:diamond_sword', null, 'passive main hand')
    await kit.must('/effect give NeuroFarm31 minecraft:instant_health 1 5 true', null, 'health before flight')
    await kit.must('/effect give NeuroFarm31 minecraft:saturation 1 5 true', null, 'food before flight')
    await kit.ensureWorld('overworld', { tp: `${course.landing.x} ${course.landing.y} ${course.landing.z}` })
    await kit.ensureWorld('overworld', { tp: `${course.launch.x} ${course.launch.y} ${course.launch.z}` })
    await kit.must('/gamemode survival NeuroFarm31', null, 'survival before measured flight')
    await kit.ensureWorld('overworld', { floor: 'stone' })
    const readyBy = Date.now() + 10000
    let ready = (await connection.call('status')).state
    while ((ready.health !== 20 || ready.food !== 20 || ready.clock?.frozen !== false) && Date.now() < readyBy) {
      await clock.wall.sleep(25)
      ready = (await connection.call('status')).state
    }
    assert.equal(ready.health, 20, 'actual full health before measured flight')
    assert.equal(ready.food, 20, 'actual full hunger before measured flight')
    assert.equal(ready.clock?.frozen, false, 'actual running server clock before measured flight')
    const result = await connection.call('flight_route', { gates: course.gates, landing: course.landing, timeoutSeconds: 180, gateSeconds: 20, rocketReserve: 2 })
    console.log('FLIGHT_RESULT', JSON.stringify(result))
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(result.detail.ok, true, JSON.stringify(result.detail))
    assert.deepEqual(result.detail.crossings.map((crossing: { id: string }) => crossing.id), course.gates.map(gate => gate.id))
    assert.ok(result.detail.hp > 0)
    assert.ok(result.detail.landingError <= 3, 'landing more than three blocks from requested point')
  } finally {
    await connection.call('stop').catch(() => {})
    try { await kit?.unforceload('overworld', [[3688, -64, 3388], [3812, 319, 3488]]) } catch {}
    probe?.quit('flight course fixture done')
    connection.close()
    clock.changes.removeListener('bound', onClock)
    followedClock?.dispose()
  }
}

if (require.main === module) runFlightCourse().catch(error => { console.error(error); process.exitCode = 1 })
