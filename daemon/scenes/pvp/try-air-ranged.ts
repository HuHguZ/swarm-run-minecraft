import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import { fork } from 'node:child_process'
import { pairUseWitness } from './air-ranged-witness'
import { REPO_ROOT } from '../../src/paths'
const { connect, createKit, createGameBot, normBox, splitBox }: typeof import('../lib/scene-kit') = require('../lib/scene-kit')
const clock: typeof import('../../src/game-clock') = require('../../src/game-clock')
const bow: typeof import('../../src/bow') = require('../../src/bow')
const ranged: typeof import('../../src/ranged') = require('../../src/ranged')
const read: typeof import('../../src/read') = require('../../src/read')
const sky: typeof import('../../src/elytra') = require('../../src/elytra')
const { velocityFromRaw }: typeof import('../../src/drops') = require('../../src/drops')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { rayBox }: typeof import('../../src/pick') = require('../../src/pick')
const snbt = require('mojangson')

const SHOOTER = 'NeuroAir31'
const TARGET = 'NeuroAT31'
const BOX = [[4075, 110, 3085], [4135, 205, 3150]]
const CASES = ['fall-running-player', 'fall-turning-player', 'fall-running-mob', 'both-falling', 'fall-glider', 'glide-running-player', 'opposite-gliders']
const targetStart = (kind: string) => kind.endsWith('mob') ? { x: 4118.5, y: 140, z: 3120.5, yaw: -90 }
  : kind === 'opposite-gliders' ? { x: 4100.5, y: 180, z: 3118.3, yaw: 180 }
  : /both-falling|fall-glider/.test(kind) ? { x: 4104.7, y: 180, z: 3120.5, yaw: -90 }
  : { x: 4095.5, y: 140, z: 3120.5, yaw: -90 }

async function until(check: () => boolean, label: string, wallMs = 10000) {
  const by = Date.now() + wallMs
  while (!check() && Date.now() < by) await clock.wall.sleep(5)
  assert.ok(check(), label)
}

// The tick function observes real server entities together, before their next
// world tick. RCON GET replies are not broadcast to latest.log; collect all
// short paths separately, so native pretty-print truncation cannot hide data.
export function readNativeTrace(properties: string, targetOnly = false): Promise<any[]> {
  assert.equal(Number(/^rcon.port=(.+)$/m.exec(properties)?.[1]), 25731)
  const password = /^rcon.password=(.+)$/m.exec(properties)?.[1].trim()
  assert.ok(password)
  return new Promise((resolve, reject) => {
    const packet = (id: number, type: number, value: string) => {
      const data = Buffer.from(value); const out = Buffer.alloc(data.length + 14)
      out.writeInt32LE(data.length + 10, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); data.copy(out, 12)
      return out
    }
    let pending = Buffer.alloc(0)
    const samples: any[] = []; const fields = targetOnly ? ['target', 'targetMotion', 't', 'hp', 'flying']
      : ['arrow', 'velocity', 'target', 'targetMotion', 'shooter', 'shooterMotion', 't', 'hp', 'ground', 'flying']
    const tracePath = targetOnly ? 'targetSamples' : 'samples'
    const counter = targetOnly ? '#targetSamples' : '#samples'
    const request = (id: number) => {
      if (id >= 10 + samples.length * fields.length) socket.write(packet(3, 2, 'list'))
      else socket.write(packet(id, 2, `data get storage neurodown_air31:trace ${tracePath}[${Math.floor((id - 10) / fields.length)}].${fields[(id - 10) % fields.length]}`))
    }
    const socket = net.connect(25731, '127.0.0.1', () => socket.write(packet(1, 3, password!)))
    const timeout = clock.wall.setTimeout(() => { socket.destroy(); reject(new Error('native trace RCON timeout')) }, 8000)
    const done = () => { clock.wall.clearTimeout(timeout); socket.end() }
    socket.on('error', error => { done(); reject(error) })
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, typeof bytes === 'string' ? Buffer.from(bytes) : bytes])
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
        const size = pending.readInt32LE(0); const id = pending.readInt32LE(4); const type = pending.readInt32LE(8)
        const body = pending.subarray(12, size + 2).toString(); pending = pending.subarray(size + 4)
        if (id === -1) { done(); reject(new Error('native trace RCON authentication failed')); return }
        if (id === 1 && type === 2) {
          socket.write(packet(2, 2, `scoreboard players get ${counter} nd_air31`))
        } else if (id === 2) {
          const count = Number(/has (\d+) \[nd_air31\]/.exec(body)?.[1])
          if (!Number.isInteger(count) || count > 60) { done(); reject(new Error('native trace sample count')); return }
          for (let i = 0; i < count; i++) samples.push({})
          request(10)
        } else if (id >= 10) {
          const index = Math.floor((id - 10) / fields.length); const field = fields[(id - 10) % fields.length]
          try {
            // DataCommands truncates pretty-printed compounds/lists. A single
            // three-coordinate vector or scalar fits its native print budget.
            samples[index][field] = snbt.simplify(snbt.parse(body.slice(body.indexOf('contents: ') + 10)))
          } catch (error) {
            if (field !== 'flying') { done(); reject(new Error(`native trace ${index}.${field}: ` + String(error))); return }
          }
          request(id + 1)
        } else if (id === 3) {
          done(); resolve(samples)
        }
      }
    })
  })
}

export function summarizeNativeTrace(samples: any[], mob: boolean) {
  let closest: any = null; let modelError = 0; let sweptHit = false
  const v = (a: number[]) => ({ x: a[0], y: a[1], z: a[2] })
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]; const height = mob ? 1.95 : s.flying ? .6 : 1.8
    const a = v(s.arrow); const p = v(s.target)
    const miss = Math.hypot(Math.max(0, Math.abs(a.x - p.x) - .3), Math.max(0, p.y - a.y, a.y - p.y - height), Math.max(0, Math.abs(a.z - p.z) - .3))
    if (!closest || miss < closest.miss) closest = { t: s.t, miss, arrow: s.arrow, target: s.target, hp: s.hp, ground: s.ground }
    const next = samples[i + 1]
    if (!next || s.ground || next.t !== s.t + 1) continue
    if (!next.ground) modelError = Math.max(modelError, Math.hypot(...s.arrow.map((n: number, axis: number) => next.arrow[axis] - n - s.velocity[axis])))
    const direction = v(next.arrow.map((n: number, axis: number) => n - s.arrow[axis] - (next.target[axis] - s.target[axis])))
    if (rayBox(a, direction, { x: p.x - .3, y: p.y, z: p.z - .3 }, { x: p.x + .3, y: p.y + height, z: p.z + .3 }, 1) != null) sweptHit = true
  }
  return { samples: samples.length, closest, modelError, sweptHit }
}

export function validateAirShot(row: any, trace: boolean) {
  const { kind, result, launch, nativeTrace, arrowVelocity, shooterHealth, reversed } = row
  if (trace && (result.shot || result.fired)) assert.ok(nativeTrace.length > 1 && nativeTrace.every(s => Number.isFinite(s.t) && s.arrow?.length === 3 && s.velocity?.length === 3 && s.target?.length === 3), 'actual server trace contains arrow and target at shared world ticks')
  assert.ok(launch && !launch.grounded, 'shot must actually release in air')
  if (kind.startsWith('glide') || kind === 'opposite-gliders') assert.equal(launch.gliding, true, 'shot must actually release while gliding')
  if (kind === 'fall-glider' || kind === 'opposite-gliders') assert.equal(launch.enemyFlying, true, 'target must actually glide during release')
  if (kind === 'both-falling' || kind === 'fall-glider' || kind === 'opposite-gliders') assert.equal(launch.enemyGrounded, false, 'target must actually be airborne during release')
  else assert.equal(launch.enemyGrounded, true, 'running target must actually remain on ground during release')
  if (kind === 'opposite-gliders') {
    const targetVelocity = launch.nativeTarget?.velocity
    assert.ok(targetVelocity && launch.moved.x * targetVelocity.x + launch.moved.z * targetVelocity.z < 0,
      'native shooter and target horizontal velocity vectors must oppose each other')
  }
  if (kind === 'fall-turning-player') assert.equal(reversed, true, 'native target reversed before release')
  assert.ok(arrowVelocity, 'actual native arrow spawn velocity')
  assert.ok(shooterHealth > 0, 'native survival shooter must live through the measured flight')
}

export function saveAirSummary(output: string | undefined, rows: any[], selected: string[]) {
  const cases = rows.map(row => ({ weapon: row.weapon, kind: row.kind, repeat: row.repeat,
    status: !(row.result?.shot || row.result?.fired) ? 'NO_SHOT' : row.validationError ? 'FAIL' : row.hit && row.damage > 0 ? 'HIT' : 'MISS',
    damage: row.damage, validationError: row.validationError ?? null }))
  const summary = { scene: 'air-ranged', ok: rows.every(row => !row.validationError) &&
    ['bow', 'crossbow'].every(weapon => selected.every(kind => rows.some(row => row.weapon === weapon && row.kind === kind && row.hit && row.damage > 0))),
    shots: rows.length, fired: cases.filter(row => row.status !== 'NO_SHOT').length,
    hits: cases.filter(row => row.status === 'HIT').length, misses: cases.filter(row => row.status === 'MISS').length,
    noShots: cases.filter(row => row.status === 'NO_SHOT').length, validationFailures: rows.filter(row => row.validationError).length, cases }
  if (output) fs.appendFileSync(output, JSON.stringify(summary) + '\n')
  return summary
}

export async function runAirRanged() {
  assert.equal(process.env.FARM_SLOT, '31')
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8831')
  assert.equal(process.env.MC_PORT, '25631')
  assert.ok(SHOOTER.length <= 16 && TARGET.length <= 16)
  const slot = path.resolve(REPO_ROOT, 'farm/server-31')
  const logFile = path.resolve(process.env.ND_SERVER_LOG ?? '')
  assert.equal(logFile.toLowerCase(), path.join(slot, 'logs', 'latest.log').toLowerCase())
  const properties = fs.readFileSync(path.join(slot, 'server.properties'), 'utf8')
  const level = /^level-name=(.+)$/m.exec(properties)?.[1].trim() ?? 'world'
  const world = path.resolve(slot, level)
  assert.ok(world.startsWith(slot + path.sep))
  const connection = connect(process.env.ND_WS, { followClock: false })
  const bots: any[] = []
  let targetWorker: ReturnType<typeof fork> | null = null
  let targetState: any = null
  let targetPacketWitness: any = null
  let measuredHealthMin: number | null = null
  let targetError: string | null = null
  let kit: any
  let followedClock: { dispose(): void } | null = null
  const onClock = (value: { dispose(): void }) => { followedClock = value }
  clock.changes.on('bound', onClock)
  try {
    await connection.ready; await connection.call('connect'); await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    kit = createKit({ call: connection.call, heard: connection.heard, logFile, player: 'NeuroFarm31' })
    await kit.must('/tick unfreeze', null, 'running fixture setup')
    await kit.gamerule('keep_inventory', false)
    await kit.gamerule('spawn_mobs', false)
    await kit.setDifficulty('normal')
    await kit.forceload('overworld', BOX)
    for (const name of [SHOOTER]) {
      const bot = createGameBot({ host: '127.0.0.1', port: 25631, username: name, auth: 'offline', version: '1.21.11', viewDistance: 'tiny' }, { primary: true })
      bots.push(bot)
      await new Promise<void>((resolve, reject) => { bot.once('spawn', () => resolve()); bot.once('error', reject); bot.once('kicked', reason => reject(new Error(String(reason)))) })
      await kit.must(`/gamemode creative ${name}`, null, 'creative setup body')
    }
    const [shooter] = bots
    sky.install(shooter)
    let chunkAt = Date.now()
    shooter._client.on('map_chunk', () => { chunkAt = Date.now() })
    targetWorker = fork(path.join(__dirname, 'air-ranged-target.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    targetWorker.on('message', (message: any) => {
      if (message.type === 'state') {
        targetState = message
        if (measuredHealthMin !== null && Number.isFinite(message.health)) measuredHealthMin = Math.min(measuredHealthMin, message.health)
      }
      if (message.type === 'error') targetError = message.message
      if (message.type === 'packet-witness') targetPacketWitness = message
    })
    targetWorker.on('error', error => { targetError = error.message })
    targetWorker.on('exit', code => { if (code) targetError = 'native target exited: ' + code })
    await until(() => !!targetState?.spawned || !!targetError, 'native target worker joined')
    assert.equal(targetError, null)
    await kit.must(`/gamemode creative ${TARGET}`, null, 'creative setup target body')
    const functions = path.join(world, 'datapacks', 'neurodown_air31', 'data', 'neurodown_air31', 'function')
    fs.mkdirSync(functions, { recursive: true })
    fs.writeFileSync(path.join(functions, '..', '..', '..', 'pack.mcmeta'), JSON.stringify({ pack: { description: 'Farm31 native ranged physics', min_format: [94, 1], max_format: [94, 1] } }) + '\n')
    const setup = splitBox(normBox(BOX)).map((b: any) => `fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)
    setup.push('fill 4075 110 3085 4135 110 3150 minecraft:stone', 'fill 4075 111 3085 4135 112 3150 minecraft:water',
      'fill 4080 139 3112 4129 139 3136 minecraft:stone', 'fill 4096 179 3097 4104 179 3101 minecraft:stone',
      'fill 4094 179 3118 4104 179 3122 minecraft:stone', 'scoreboard players set #setup nd_air31 1')
    fs.writeFileSync(path.join(functions, 'setup.mcfunction'), setup.join('\n') + '\n')
    const arrowSelector = '@e[type=arrow,x=4075,y=110,z=3085,dx=60,dy=95,dz=65,limit=1]'
    const targetSelector = `@a[name=${TARGET},limit=1]`
    const observer = ['data modify storage neurodown_air31:trace snapshot set value {}',
      'execute store result storage neurodown_air31:trace snapshot.t long 1 run time query gametime',
      `data modify storage neurodown_air31:trace snapshot.arrow set from entity ${arrowSelector} Pos`,
      `data modify storage neurodown_air31:trace snapshot.velocity set from entity ${arrowSelector} Motion`,
      `data modify storage neurodown_air31:trace snapshot.ground set from entity ${arrowSelector} inGround`,
      `data modify storage neurodown_air31:trace snapshot.shooter set from entity @a[name=${SHOOTER},limit=1] Pos`,
      `data modify storage neurodown_air31:trace snapshot.shooterMotion set from entity @a[name=${SHOOTER},limit=1] Motion`,
      ...[['target', 'Pos'], ['targetMotion', 'Motion'], ['hp', 'Health'], ['flying', 'FallFlying']].map(([key, field]) =>
        `execute if score #mob nd_air31 matches 0 run data modify storage neurodown_air31:trace snapshot.${key} set from entity ${targetSelector} ${field}`),
      ...[['target', 'Pos'], ['targetMotion', 'Motion'], ['hp', 'Health']].map(([key, field]) =>
        `execute if score #mob nd_air31 matches 1 run data modify storage neurodown_air31:trace snapshot.${key} set from entity @e[type=husk,tag=nd_air31,limit=1] ${field}`),
      'data modify storage neurodown_air31:trace samples append from storage neurodown_air31:trace snapshot',
      'scoreboard players add #samples nd_air31 1']
    fs.writeFileSync(path.join(functions, 'observe.mcfunction'), observer.join('\n') + '\n')
    // Date target positions before arrow spawn too: arrival intervals alone
    // cannot distinguish client movement batching from target acceleration.
    const beforeArrow = observer.filter(line => !/snapshot\.(arrow|velocity|ground|shooter)/.test(line) && !/samples append|#samples/.test(line))
    beforeArrow.push('execute if score #targetSamples nd_air31 matches 60.. run data remove storage neurodown_air31:trace targetSamples[0]',
      'data modify storage neurodown_air31:trace targetSamples append from storage neurodown_air31:trace snapshot',
      'execute if score #targetSamples nd_air31 matches ..59 run scoreboard players add #targetSamples nd_air31 1')
    fs.writeFileSync(path.join(functions, 'observe_target.mcfunction'), beforeArrow.join('\n') + '\n')
    fs.writeFileSync(path.join(functions, 'tick.mcfunction'), [
      `execute if score #observing nd_air31 matches 1 if score #tracking nd_air31 matches 1 if entity ${arrowSelector} run scoreboard players set #launched nd_air31 1`,
      'execute if score #observing nd_air31 matches 1 if score #tracking nd_air31 matches 1 if score #launched nd_air31 matches 0 run function neurodown_air31:observe_target',
      `execute if score #observing nd_air31 matches 1 if score #samples nd_air31 matches ..59 if entity ${arrowSelector} run function neurodown_air31:observe`
    ].join('\n') + '\n')
    const tickTags = path.join(functions, '..', '..', '..', 'data', 'minecraft', 'tags', 'function')
    fs.mkdirSync(tickTags, { recursive: true })
    fs.writeFileSync(path.join(tickTags, 'tick.json'), JSON.stringify({ values: ['neurodown_air31:tick'] }) + '\n')
    for (const weapon of ['bow', 'crossbow']) for (const kind of CASES) {
      const mob = kind.endsWith('mob')
      const start = targetStart(kind)
      const commands = ['scoreboard players set #observing nd_air31 0', 'scoreboard players set #samples nd_air31 0',
        'scoreboard players set #targetSamples nd_air31 0', 'scoreboard players set #tracking nd_air31 0', 'scoreboard players set #launched nd_air31 0',
        'data modify storage neurodown_air31:trace targetSamples set value []',
        `scoreboard players set #mob nd_air31 ${mob ? 1 : 0}`, 'data modify storage neurodown_air31:trace samples set value []',
        `fill 4080 139 3112 4129 139 3136 minecraft:${kind === 'both-falling' || kind === 'fall-glider' || kind === 'opposite-gliders' ? 'air' : 'stone'}`,
        'kill @e[type=arrow,x=4075,y=110,z=3085,dx=60,dy=95,dz=65]', 'kill @e[type=husk,tag=nd_air31]',
        ...[SHOOTER, TARGET].flatMap(name => [`gamemode creative ${name}`, `effect clear ${name}`, `clear ${name}`,
          `attribute ${name} minecraft:max_health base set 20`, `effect give ${name} minecraft:instant_health 1 5 true`,
          `effect give ${name} minecraft:saturation 1 5 true`, `item replace entity ${name} armor.chest with minecraft:elytra`]),
        `give ${SHOOTER} minecraft:${weapon === 'bow' ? 'bow' : 'crossbow[charged_projectiles=[{id:"minecraft:arrow",count:1}]]'}`,
        `give ${SHOOTER} minecraft:arrow 64`, `tp ${SHOOTER} 4100.5 180 3101.7 0 0`,
        `tp ${TARGET} ${start.x} ${start.y} ${start.z} ${start.yaw} 0`,
        ...(mob ? ['summon husk 4094.5 140 3120.5 {Tags:["nd_air31"],PersistenceRequired:1b,NoAI:1b}'] : []),
        `gamemode survival ${SHOOTER}`, `gamemode survival ${TARGET}`, 'scoreboard players set #ready nd_air31 1']
      fs.writeFileSync(path.join(functions, `${weapon}_${kind}.mcfunction`), commands.join('\n') + '\n')
    }
    await kit.must('/reload', null, 'air scene datapack loaded')
    await kit.cmd('/scoreboard objectives add nd_air31 dummy')
    const witness = '#a' + process.pid.toString(36) + Date.now().toString(36).slice(-5)
    let serial = 0
    const confirm = async (condition: string) => {
      const value = ++serial
      await kit.must(`/execute ${condition} run scoreboard players set ${witness} nd_air31 ${value}`,
        new RegExp(`^Set \\[nd_air31\\] for ${witness} to ${value}$`), 'actual changed server witness')
    }
    await kit.must('/scoreboard players set #setup nd_air31 0', null, 'fresh geometry setup marker')
    await kit.must('/execute in minecraft:overworld run function neurodown_air31:setup', null, 'air scene setup in its explicit dimension')
    await confirm('if score #setup nd_air31 matches 1')
    const rows: any[] = []
    const selected = process.env.AIR_CASES?.split(',') ?? CASES
    assert.ok(selected.every(kind => CASES.includes(kind)))
    const repeats = Math.max(1, Math.min(8, Number(process.env.AIR_REPEATS ?? 2)))
    for (const weapon of ['bow', 'crossbow']) for (const kind of selected) for (let repeat = 0; repeat < repeats; repeat++) {
      shooter.clearControlStates(); targetWorker.send({ type: 'coast' })
      await kit.must('/tick freeze', null, 'freeze only fixture preparation')
      await kit.must('/scoreboard players set #ready nd_air31 0', null, 'fresh reset marker')
      await kit.must(`/execute in minecraft:overworld run function neurodown_air31:${weapon}_${kind}`, null, 'fresh scene body in its explicit dimension')
      await confirm('if score #ready nd_air31 matches 1')
      await kit.must('/tick step 2', null, 'native health effects applied before frozen readiness')
      const start = targetStart(kind)
      const targetX = start.x
      const actualTerrain = [new Vec3(4100, 179, 3101), new Vec3(4098, /both-falling|fall-glider|opposite-gliders/.test(kind) ? 179 : 139, 3120)]
      try { await until(() => shooter.health === 20 && shooter.food === 20 && shooter.game.gameMode === 'survival' && shooter.game.dimension === 'overworld' && shooter.blockAt(shooter.entity.position) &&
        targetState?.health === 20 && targetState.food === 20 && targetState.gameMode === 'survival' && targetState.dimension === 'overworld' && targetState.loaded && targetState.quietMs >= 40 && Date.now() - chunkAt >= 40 &&
        Math.abs(shooter.entity.position.x - 4100.5) < .5 && Math.abs(shooter.entity.position.z - 3101.7) < .5 &&
        Math.abs(targetState.position.x - targetX) < .5 && Math.abs(targetState.position.z - start.z) < .5 &&
        actualTerrain.every(p => shooter.blockAt(p)?.name === 'stone') &&
        shooter.inventory.items().some((item: any) => item.name === weapon), 'actual fixture XZ, loaded native blocks, full survival HUD and weapon') } catch (error) {
        console.log('AIR_PREP_FAIL', JSON.stringify({ weapon, kind, repeat, shooter: { position: shooter.entity.position, health: shooter.health, food: shooter.food, mode: shooter.game.gameMode, dimension: shooter.game.dimension,
          loaded: !!shooter.blockAt(shooter.entity.position), clock: shooter.ndClock.snapshot(), inventory: shooter.inventory.items().map((item: any) => item.name) },
          target: targetState, terrain: actualTerrain.map(p => ({ position: p, block: shooter.blockAt(p)?.name })) }))
        throw error
      }
      for (const p of actualTerrain) assert.equal(shooter.blockAt(p)?.name, 'stone', 'actual loaded fixture blocks')
      const mob = kind.endsWith('mob')
      const getTarget = () => mob ? shooter.nearestEntity((e: any) => e.name === 'husk' && e.position.x >= 4080 && e.position.x <= 4130 && Math.abs(e.position.z - 3120.5) < 3) : shooter.players[TARGET]?.entity
      const targetLoaded = () => { const e = getTarget(); return e && Number.isFinite(e.id) && e.position && Math.abs(e.position.z - start.z) < 3 && (mob || Math.abs(e.position.x - targetX) < 1) }
      // Tracking starts after the destination chunks are acknowledged. Frozen
      // world preparation needs a few real setup ticks to publish that entity.
      for (let attempt = 0; attempt < 4 && !targetLoaded(); attempt++) {
        await kit.must('/tick step 5', null, 'native destination entity tracking during setup')
        await clock.wall.sleep(100)
      }
      // Let both native bodies process their teleport/ground contact and queued
      // movement before the measured phase. Healing here is setup, not combat.
      await connection.call('say', { text: '/tick unfreeze' })
      await until(() => shooter.entity.onGround && targetState?.grounded && shooter.ndClock.snapshot().lagTicks <= 2 && targetState.clock.lagTicks <= 2,
        'native ground contact and actor clock backlog settled before measurement')
      for (const name of [SHOOTER, TARGET]) await kit.must(`/effect give ${name} minecraft:instant_health 1 5 true`, null, 'full health after native setup contact')
      await until(() => shooter.health === 20 && targetState?.health === 20, 'actual full HP after setup ground contact')
      await kit.must('/tick freeze', null, 'stable native bodies before measurement')
      await until(() => shooter.ndClock.frozen && targetState?.clock.frozen, 'both actual actor clocks frozen for readiness')
      console.log('AIR_READY', JSON.stringify({ shooter: { ...shooter.entity.position }, dimension: shooter.game.dimension, target: targetState, clock: shooter.ndClock.snapshot(), targetLoaded: !!targetLoaded(), players: Object.keys(shooter.players) }))
      await until(targetLoaded, 'actual native target entity id and destination position')
      const entity = getTarget()
      const tracker = bow.trackTarget(entity)
      let moved = { x: 0, y: 0, z: 0 }; let previous = shooter.entity.position.clone()
      const observe = () => {
        const p = shooter.entity.position; moved = { x: p.x - previous.x, y: p.y - previous.y, z: p.z - previous.z }; previous = p.clone(); tracker.update()
        if (process.env.AIR_TRACE === '1' && shooter.ndClock.ticks % 20 === 0) probeRoundTrip()
      }
      shooter.on('physicsTick', observe)
      let hit = false; let hurtAt: any = null; let launch: any = null; let arrowVelocity: any = null
      const spawnPackets: any[] = []
      const damagePackets: any[] = []
      const usePackets: any[] = []
      const useAcknowledgements: any[] = []
      const movementPackets: any[] = []
      const shooterDamagePackets: any[] = []
      const targetTrace: any[] = []
      const targetPackets: any[] = []
      const timePackets: any[] = []
      let observerError: Error | null = null
      const roundTrips: any[] = []
      const pendingPings = new Map<string, any>()
      let pingSequence = BigInt(Date.now()) * 1000n
      // Installed 1.21.11 play schema: ping_request/ping_response both use i64.
      // Paper handlePingRequest echoes on its transport thread, so this is an
      // actual RTT witness, not a guessed main-thread queue/tick coefficient.
      const probeRoundTrip = () => {
        if (pendingPings.size >= 8) return
        const id = ++pingSequence
        pendingPings.set(String(id), { mono: clock.wall.monotonic(), sentWall: Date.now(), serverAt: clock.serverNow() })
        shooter._client.write('ping_request', { id })
      }
      const roundTrip = (packet: any) => {
        const id = Array.isArray(packet.id)
          ? BigInt.asIntN(64, (BigInt(packet.id[0]) << 32n) | BigInt(packet.id[1] >>> 0)) : packet.id
        const sent = pendingPings.get(String(id))
        if (!sent) return
        pendingPings.delete(String(id))
        roundTrips.push({ sentWall: sent.sentWall, receivedWall: Date.now(), ms: clock.wall.monotonic() - sent.mono,
          sentServerAt: sent.serverAt, receivedServerAt: clock.serverNow(), clientTicks: shooter.ndClock.ticks, serverTicks: shooter.ndClock.serverTicks })
      }
      shooter._client.on('ping_response', roundTrip)
      const traceMove = (e: any) => {
        if (process.env.AIR_TRACE !== '1' || e.id !== entity.id || targetTrace.length >= 80) return
        targetTrace.push({ at: clock.serverNow(), observationAt: clock.observationNow(), wall: Date.now(), mono: clock.wall.monotonic(), serverAge: String(shooter.ndClock.age), position: { ...e.position }, velocity: { ...tracker.vel() }, receipt: e._ndPositionReceipts?.[1], clientTicks: shooter.ndClock.ticks, serverTicks: shooter.ndClock.serverTicks })
      }
      const hurt = (victim: any) => {
        if (victim.id === entity.id && damagePackets.some(packet => packet.sourceCauseId - 1 === shooter.entity.id && spawnPackets.some(arrow => arrow.entityId === packet.sourceDirectId - 1))) {
          hit = true; hurtAt = shooter.ndClock.ticks
        }
      }
      const damage = (packet: any) => {
        if (packet.entityId === entity.id) damagePackets.push({ ticks: shooter.ndClock.ticks, ...packet })
        if (packet.entityId === shooter.entity.id) shooterDamagePackets.push({ ticks: shooter.ndClock.ticks, ...packet })
      }
      const rawSpawn = (packet: any, meta: any, bytes: Buffer) => {
        // Bundle delimiters are valid native packets with no decoded payload.
        if (!packet || !meta) return
        try {
          if (process.env.AIR_TRACE === '1' && meta.name === 'acknowledge_player_digging' && useAcknowledgements.length < 32) {
            useAcknowledgements.push({ sequenceId: packet.sequenceId, mono: clock.wall.monotonic(), wall: Date.now(),
              ticks: shooter.ndClock.ticks, serverTicks: shooter.ndClock.serverTicks, serverAge: String(shooter.ndClock.age) })
          }
          if (meta.name === 'update_time' && !shooter.ndClock.frozen) {
            const age = Array.isArray(packet.age) ? BigInt.asIntN(64, (BigInt(packet.age[0]) << 32n) | BigInt(packet.age[1] >>> 0)) : BigInt(packet.age)
            timePackets.push({ age: String(age), mono: clock.wall.monotonic(), wall: Date.now(), clientTicks: shooter.ndClock.ticks })
          }
          if (process.env.AIR_TRACE === '1' && packet.entityId === entity.id && /^(rel_entity_move|entity_move_look|entity_teleport|sync_entity_position|entity_velocity)$/.test(meta.name) && targetPackets.length < 80) {
            targetPackets.push({ at: clock.serverNow(), wall: Date.now(), mono: clock.wall.monotonic(), serverAge: String(shooter.ndClock.age), name: meta.name,
              ...packet, ...(meta.name === 'entity_velocity' ? { decodedVelocity: velocityFromRaw(bytes, 'velocity') } : {}) })
          }
          if (meta.name !== 'spawn_entity' || packet.type !== shooter.registry.entitiesByName.arrow.id) return
          const velocity = velocityFromRaw(bytes, 'spawn')
          spawnPackets.push({ ticks: shooter.ndClock.ticks, at: clock.serverNow(), mono: clock.wall.monotonic(), wall: Date.now(), serverAge: String(shooter.ndClock.age), ...packet, decodedVelocity: velocity })
          if (velocity) arrowVelocity = velocity
        } catch (error) { observerError = new Error(`native packet observer ${meta.name}: ${String(error)}`) }
      }
      shooter.on('entityHurt', hurt)
      shooter.on('entityMoved', traceMove)
      shooter._client.on('packet', rawSpawn)
      shooter._client.prependListener('damage_event', damage)
      const oldWrite = shooter._client.write.bind(shooter._client)
      let sentPosition = shooter.entity.position.clone()
      let sentMovement = { x: 0, y: 0, z: 0 }
      let sentGrounded = shooter.entity.onGround
      shooter._client.write = (name: string, packet: any) => {
        if (/^position(_look)?$/.test(name)) {
          const p = new Vec3(packet.x, packet.y, packet.z)
          sentMovement = { x: p.x - sentPosition.x, y: p.y - sentPosition.y, z: p.z - sentPosition.z }
          sentPosition = p; sentGrounded = packet.onGround ?? packet.flags?.onGround
        }
        if ((name === 'use_item' || name === 'block_dig') && usePackets.length < 32) usePackets.push({ ticks: shooter.ndClock.ticks, at: clock.serverNow(), mono: clock.wall.monotonic(), wall: Date.now(), serverAge: String(shooter.ndClock.age), name, ...packet })
        if (process.env.AIR_TRACE === '1' && /^(position|position_look|look|tick_end)$/.test(name)) {
          movementPackets.push({ ticks: shooter.ndClock.ticks, at: clock.serverNow(), mono: clock.wall.monotonic(), wall: Date.now(),
            serverTicks: shooter.ndClock.serverTicks, serverAge: String(shooter.ndClock.age), name, ...packet })
          if (movementPackets.length > 120) movementPackets.shift()
        }
        return oldWrite(name, packet)
      }
      const oldUse = shooter.activateItem.bind(shooter)
      const record = () => { launch = { ticks: shooter.ndClock.ticks, serverAt: clock.serverNow(), position: { ...sentPosition }, clientPosition: { ...shooter.entity.position }, velocity: { ...shooter.entity.velocity }, moved: { ...sentMovement }, grounded: sentGrounded, gliding: sky.gliding(shooter.entity), yaw: shooter.entity.yaw, pitch: shooter.entity.pitch, enemyVelocity: { ...tracker.vel() }, enemyPosition: { ...entity.position }, enemyFlying: sky.gliding(entity), enemyGrounded: entity.onGround,
        nativeTarget: mob ? null : targetState,
        ...(process.env.AIR_TRACE === '1' ? { targetReceipt: entity._ndPositionReceipts?.[1], targetVelocityKnown: tracker.hasVelocity(),
          mono: clock.wall.monotonic(), wall: Date.now(), serverAge: String(shooter.ndClock.age) } : {}) }
        // Keep native momentum, then coast into the water catch after release.
        // The moving target continues with its actual survival controls.
        driveAt = null; shooter.clearControlStates()
      }
      shooter.activateItem = (...args: any[]) => { if (shooter._ndXbowFiring) record(); return oldUse(...args) }
      let reversed = false
      let targetDriving = false
      let driveAt: number | null = null
      const flyingSelf = kind.startsWith('glide') || kind === 'opposite-gliders'
      const flyingTarget = kind === 'fall-glider' || kind === 'opposite-gliders'
      const airborneTarget = kind === 'both-falling' || flyingTarget
      const targetPhaseReady = () => !airborneTarget || (entity.onGround === false && targetState?.grounded === false &&
        (!flyingTarget || (sky.gliding(entity) && targetState.gliding)))
      const drive = () => {
        if (driveAt === null) return
        const elapsed = shooter.ndClock.ticks - driveAt
        shooter.setControlState('forward', true); shooter.setControlState('sprint', true)
        if (flyingSelf && !shooter.entity.onGround && shooter.entity.velocity.y < 0 && !sky.gliding(shooter.entity)) sky.startGlide(shooter)
        if (!mob && !targetDriving && elapsed >= (weapon === 'bow' ? 14 : 0)) {
          targetDriving = true
          targetWorker!.send({ type: 'drive', flying: flyingTarget, turnAt: kind === 'fall-turning-player' ? (weapon === 'bow' ? 14 : 2) : null })
        }
        reversed = !!targetState?.reversed
      }
      shooter.on('physicsTick', drive)
      // Start a real ground runner before the shooter leaves the platform.
      // Otherwise a bow releases during initial acceleration, before the
      // 20-tick server observation window or a scheduled turn has completed.
      const warmRunner = !mob && !flyingTarget && kind !== 'both-falling'
      if (process.env.AIR_TRACE === '1') await kit.must('/scoreboard players set #observing nd_air31 1', null, 'read-only native motion observer enabled before measurement')
      if (process.env.AIR_TRACE === '1') {
        probeRoundTrip()
        await until(() => { if (observerError) throw observerError; return roundTrips.length > 0 }, 'native ping_request/ping_response round-trip witness while frozen')
      }
      await connection.call('say', { text: '/tick unfreeze' })
      await until(() => !shooter.ndClock.frozen && targetState?.clock.frozen === false, 'native running clock before measurement')
      // Unfreeze resets the body's requested-rate sampling window. Keep both
      // bodies stationary until actual age packets span its existing 1 s
      // sampler; warm-up is setup and is excluded from measured flight ticks.
      await until(() => timePackets.length >= 2 && timePackets.at(-1).mono - timePackets[0].mono >= 1000 &&
        shooter.ndClock.pacingSampled && targetState.clock.pacingSampled &&
        shooter.ndClock.snapshot().lagTicks <= 2 && targetState.clock.lagTicks <= 2,
      'confirmed native packet anchors and actor pacing sampled before movement', 5000)
      console.log('AIR_WARM', JSON.stringify({ packets: timePackets.length, first: timePackets[0], last: timePackets.at(-1),
        shooter: shooter.ndClock.snapshot(), target: targetState.clock }))
      if (mob) await kit.must('/data merge entity @e[type=husk,tag=nd_air31,limit=1] {NoAI:0b}', null, 'native mob AI enabled after stationary setup warm-up')
      if (warmRunner) {
        targetDriving = true
        targetWorker.send({ type: 'drive', flying: false })
        await until(() => targetState?.driveStarted !== null && targetState.clock.ticks >= targetState.driveStarted + 25,
          'native ground runner accelerated before measured shooter movement')
      }
      assert.equal(shooter.ndClock.snapshot().tickRate, Number(process.env.TICK_RATE ?? 750))
      assert.equal(shooter.health, 20); assert.equal(targetState.health, 20)
      if (process.env.AIR_TRACE === '1') await kit.must('/scoreboard players set #tracking nd_air31 1', null, 'native target trajectory begins before measured movement')
      const started = shooter.ndClock.ticks; const serverStarted = shooter.ndClock.serverTicks; const wallStarted = Date.now()
      const witnessId = `${weapon}/${kind}/${repeat}`
      const hp0 = mob ? read.healthRaw(shooter, entity) : targetState.health
      measuredHealthMin = mob ? null : hp0
      driveAt = started
      if (warmRunner && kind === 'fall-turning-player') targetWorker.send({ type: 'turn', ticks: 2 })
      let result: any
      let resultReturned: any = null
      try {
        if (weapon === 'bow') result = await bow.shoot(shooter, entity, { velFn: () => tracker.vel(), follow: false, traceAim: process.env.AIR_TRACE === '1',
          onDraw: drive, onRelease: record, holdWhile: () => !targetPhaseReady(), shouldStop: () => !!observerError || shooter.health <= 0 || targetState.health <= 0 })
        else {
          drive()
          await until(() => !shooter.entity.onGround && shooter.entity.velocity.y < -.15 && (!flyingSelf || sky.gliding(shooter.entity)) && targetPhaseReady(), 'both native actors entered the requested airborne phase')
          result = await ranged.fire(shooter, entity, shooter.inventory.items().find((item: any) => item.name === 'crossbow'), { velFn: () => tracker.vel(), traceAim: process.env.AIR_TRACE === '1', shouldStop: () => !!observerError })
        }
        if (process.env.AIR_TRACE === '1') resultReturned = { mono: clock.wall.monotonic(), wall: Date.now(),
          ticks: shooter.ndClock.ticks, serverTicks: shooter.ndClock.serverTicks, serverAge: String(shooter.ndClock.age),
          targetReceipt: entity._ndPositionReceipts?.[1], targetVelocityKnown: tracker.hasVelocity() }
        if (observerError) throw observerError
        const releaseTick = launch ? (launch.serverAt - shooter.ndClock.epoch) / 50 : shooter.ndClock.serverTicks
        const flightTicks = result.flightTicks ?? result.ticks ?? 0
        await until(() => { if (observerError) throw observerError; return shooter.ndClock.serverTicks >= Math.ceil(releaseTick + Math.max(35, flightTicks + 20)) },
          'confirmed native server ticks cover projectile flight and hurt delivery')
      } finally {
        shooter.clearControlStates(); targetWorker.send({ type: 'coast', witnessId }); shooter.activateItem = oldUse
        shooter.removeListener('physicsTick', drive); shooter.removeListener('physicsTick', observe)
        shooter.removeListener('entityHurt', hurt)
        shooter.removeListener('entityMoved', traceMove)
        shooter._client.removeListener('packet', rawSpawn); shooter._client.write = oldWrite
        shooter._client.removeListener('damage_event', damage)
        shooter._client.removeListener('ping_response', roundTrip)
      }
      const hp = mob ? read.healthRaw(shooter, entity) : measuredHealthMin
      measuredHealthMin = null
      const measuredShooterHealth = shooter.health
      const measuredClock = shooter.ndClock.snapshot(); const wallElapsed = Math.max(1, Date.now() - wallStarted)
      const ticks = measuredClock.ticks - started; const serverTicks = measuredClock.serverTicks - serverStarted
      const firstTime = timePackets[0]; const lastTime = timePackets.at(-1)
      const observedPacketTPS = timePackets.length > 1 && lastTime.mono > firstTime.mono
        ? Number(BigInt(lastTime.age) - BigInt(firstTime.age)) * 1000 / (lastTime.mono - firstTime.mono) : null
      const useTiming = { monoDomain: 'shooter-process-monotonic-ms', ageDomain: 'last-received-update_time-age',
        pairs: pairUseWitness(weapon, shooter.entity.id, usePackets, useAcknowledgements, spawnPackets), resultReturned }
      console.log('AIR_OBSERVED', JSON.stringify({ weapon, kind, repeat, result, launch, arrowVelocity, spawnPackets, damagePackets,
        usePackets, useAcknowledgements, useTiming, movementPackets, targetTrace, targetPackets, timePackets, observedPacketTPS, roundTrips,
        hit, hp0, hp, shooterHealth: measuredShooterHealth, gameTicks: ticks, serverTicks, clock: measuredClock }))
      let nativeTrace: any[] = []
      let nativeTargetTrace: any[] = []
      let recordingError: string | null = null
      let targetWorkerWitness: any = null
      if (process.env.AIR_TRACE === '1') {
        await kit.must('/scoreboard players set #observing nd_air31 0', null, 'native motion observer disabled after measurement')
        // Measurement has ended. Hundreds of read-only RCON replies must not
        // drown survival actors at 750 TPS or invalidate the next ready phase.
        for (const name of [SHOOTER, TARGET]) await kit.must(`/gamemode creative ${name}`, null, 'post-measurement actor preserved during native trace inspection')
        try {
          nativeTrace = await readNativeTrace(properties)
          nativeTargetTrace = await readNativeTrace(properties, true)
          await until(() => targetPacketWitness?.id === witnessId, 'bounded target worker packet witness after coast', 2000)
          targetWorkerWitness = targetPacketWitness.trace
        } catch (error) { recordingError = String(error) }
      }
      const inherited = weapon === 'bow' ? launch?.moved : { x: 0, y: 0, z: 0 }
      const expected = launch ? { x: -Math.sin(launch.yaw) * Math.cos(launch.pitch) * (weapon === 'bow' ? 3 : 3.15) + inherited.x,
        y: Math.sin(launch.pitch) * (weapon === 'bow' ? 3 : 3.15) + (launch.grounded ? 0 : inherited.y),
        z: -Math.cos(launch.yaw) * Math.cos(launch.pitch) * (weapon === 'bow' ? 3 : 3.15) + inherited.z } : null
      const velocityError = expected && arrowVelocity ? Math.hypot(expected.x - arrowVelocity.x, expected.y - arrowVelocity.y, expected.z - arrowVelocity.z) : null
      const row = { weapon, kind, repeat, result, launch, arrowVelocity, spawnPackets, damagePackets, shooterDamagePackets, usePackets, useAcknowledgements, useTiming, movementPackets, targetTrace, targetPackets, timePackets, observedPacketTPS, roundTrips, nativeTrace, nativeSummary: summarizeNativeTrace(nativeTrace, mob), expected, velocityError, hit, hurtAt, hp0, hp, damage: hp0 != null && hp != null ? hp0 - hp : null,
        shooterHealth: measuredShooterHealth, gameTicks: ticks, serverTicks,
        measuredTPS: serverTicks * 1000 / wallElapsed,
        measuredClientTPS: ticks * 1000 / wallElapsed, clock: measuredClock, reversed, nativeTargetTrace, targetWorkerWitness, validationError: recordingError }
      // A real NO_SHOT or bad recording remains a failure, but must not hide
      // the remaining native cases. Preserve all receipts before final checks.
      try { validateAirShot(row, process.env.AIR_TRACE === '1') } catch (error) {
        row.validationError ??= error instanceof Error ? error.message : String(error)
      }
      rows.push(row); console.log('AIR_SHOT', JSON.stringify(row))
      if (process.env.LAB_OUT) fs.writeFileSync(process.env.LAB_OUT + '.native.json', JSON.stringify(rows, null, 2) + '\n')
    }
    const summary = saveAirSummary(process.env.LAB_OUT, rows, selected)
    console.log('AIR_RESULT', JSON.stringify({ ...summary, rows }))
    assert.ok(rows.every(row => !row.validationError), rows.filter(row => row.validationError).map(row => `${row.weapon}/${row.kind}: ${row.validationError}`).join('; '))
    for (const weapon of ['bow', 'crossbow']) for (const kind of selected) {
      const lane = rows.filter(row => row.weapon === weapon && row.kind === kind)
      assert.ok(lane.some(row => row.hit && row.damage > 0), `no native entityHurt plus damage for ${weapon}/${kind}`)
    }
  } finally {
    await connection.call('say', { text: '/scoreboard players set #observing nd_air31 0' }).catch(() => {})
    if (targetWorker?.connected) targetWorker.send({ type: 'quit' })
    if (targetWorker && targetWorker.exitCode === null) {
      await Promise.race([new Promise(resolve => targetWorker!.once('exit', resolve)), clock.wall.sleep(500)])
      if (targetWorker.exitCode === null) targetWorker.kill()
    }
    for (const bot of bots) { bot.clearControlStates(); bot.quit('air ranged fixture done') }
    await connection.call('say', { text: '/tick unfreeze' }).catch(() => {})
    try { await kit?.unforceload('overworld', BOX) } catch {}
    await connection.call('disconnect', { reason: 'air ranged fixture done' }).catch(() => {})
    connection.close()
    clock.changes.removeListener('bound', onClock)
    followedClock?.dispose()
  }
}

if (require.main === module) runAirRanged().catch(error => { console.error(error); process.exitCode = 1 })
