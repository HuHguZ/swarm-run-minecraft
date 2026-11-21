import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'
import { swarmBuild } from '../../farm/swarm/swarm-driver/build'
import { SwarmBoard } from '../src/swarm'
import { swarmMethods } from '../src/rpc/swarm'
import { swarmRetry } from '../../farm/swarm/swarm-driver/retry'

// Свой экземпляр модуля из исходника (bodySource — модуль с папкой тела одним скриптом) с подменами по spec (stubRequire);
// подмена, которую модуль ни разу не запросил, — ошибка фикстуры.
function source(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.js'), req = stubRequire(file, overrides)
  const module = { exports: {} as any }
  vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}\n})`, { filename: file })(req,
    module, module.exports, file, path.dirname(file))
  assert.deepEqual(req.unmatched(), [], name + ': unused stubs')
  return module.exports
}

function fixture() {
  const bot: any = new EventEmitter(), cells = new Map(), calls: string[] = []
  bot._client = new EventEmitter(); bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  bot.entities = {}; bot.inventory = { slots: [], items: () => [{ name: 'dirt', type: bot.registry.itemsByName.dirt.id, count: 64 }] }
  bot.pathfinder = { setGoal: () => calls.push('goal') }; bot.clearControlStates = () => calls.push('clear')
  const block = (p: any, name = 'air') => {
    const data = bot.registry.blocksByName[name]
    return { ...data, position: p.floored(), stateId: data.minStateId, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], digTime: () => 20, canHarvest: () => true }
  }
  bot.blockAt = (p: any) => cells.get(p.floored().toString()) || block(p, p.y < 64 ? 'stone' : 'air')
  bot.equip = async (item: any) => { bot.heldItem = item; calls.push('equip') }
  bot.lookAt = async () => { calls.push('look') }; bot.canDigBlock = () => true
  bot.stopDigging = () => calls.push('stopDigging')
  bot._updateBlockState = (p: any, state: number) => {
    const data = bot.registry.blocksByStateId[state]
    cells.set(p.toString(), { ...block(p, data.name), stateId: state })
  }
  const packet = (p: any, name: string) => {
    const b = block(p, name); cells.set(p.toString(), b)
    bot._client.emit('block_change', { location: p, type: b.stateId })
    bot.emit('blockUpdate', null, b)
  }
  bot._placeBlockWithOptions = async (ref: any, face: any) => { calls.push('place'); packet(ref.position.plus(face), bot.heldItem.name) }
  bot.dig = async (b: any) => { calls.push('dig'); packet(b.position, 'air') }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const session = { bot }, at = new Vec3(1, 64, 0)
  const build = source('build'), pick = source('pick'), receipt = source('environments/dig-receipt')
  const work = source('swarm-work', { './build': build, './pick': pick, './environments/dig-receipt': receipt })
  return { bot, cells, calls, ctl, session, at, packet, block, work }
}

for (const obstacle of ['player', 'stone', 'last exit']) test('a builder finishes a different wall cell while the first is blocked by ' + obstacle, async () => {
  const f = fixture(), first = f.at, second = new Vec3(obstacle === 'last exit' ? 2 : 0, 64, 2)
  const actor = { id: 2, name: 'player', type: 'player', username: 'Friend', height: 1.8, width: .6, position: first.offset(.5, 0, .5) }
  if (obstacle === 'player') f.bot.entities[2] = actor
  else if (obstacle === 'stone') f.packet(first, 'stone')
  else {
    f.bot.entity.position = new Vec3(2.5, 64, .5)
    actor.position = new Vec3(.5, 64, .5)
    f.bot.entities[2] = actor; f.bot._ndSwarmAllies = ['Friend']
    for (const [x, z] of [[-1, 0], [0, -1], [0, 1]]) for (let y = 64; y <= 66; y++) f.packet(new Vec3(x, y, z), 'stone')
    for (let x = 0; x <= 1; x++) f.packet(new Vec3(x, 66, 0), 'stone')
  }
  const actions = [], walks = [], pos = { A: { p: f.bot.entity.position, inv: { dirt: 16 } } }
  let afterInspection: (() => void) | undefined
  const member = { id: 'A', team: 'blue', health: 20, strength: 1, role: 'miner-builder' as const, position: pos.A.p, inventory: pos.A.inv }
  const board = new SwarmBoard('blue', () => 1000)
  board.setMembers([member])
  const rpc = swarmMethods({ session: { require: () => f.bot, immediate: fn => fn() } } as any)
  const b = { name: 'A', swarmTurnOwner: {}, c: { async call(method, p) {
    if (method === 'swarm_pose') {
      const detail = await rpc.swarm_pose(p)
      if (p.occupants) afterInspection?.()
      return { detail }
    }
    if (method !== 'swarm_work') return { detail: {} }
    actions.push(p.at)
    return { detail: await f.work.swarmWork(f.session, f.ctl, { ...p, allies: ['Friend'] }) }
  } } }
  const sw: any = { now: () => 1000, pos, bots: [b], alive: () => true, generation: 1, teamOf: () => 'blue',
    blueprints: new Map(), placed: new Map(), telemetry: { built: 0 }, say() {}, log() {}, detail: r => r.detail,
    renew: (board, bot, cell) => board.renew(cell.id, bot.name, cell.claim.token, 25000),
    buildGo: async (_bot, at) => { walks.push(at); return { status: 'done', detail: { arrived: pos.A.p } } } }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw)
  const step = () => buildStep(b, { board, members: [member], member },
    { kind: 'cutoff', origin: first, cells: [first, second].map(at => ({ at })) })
  await step(); await step()
  assert.equal(f.bot.blockAt(second).name, 'dirt', 'the other ready cell is physically built')
  assert.equal(sw.telemetry.built, 1)
  await step(); await step()
  assert.deepEqual(actions.map(p => [p.x, p.z]), [[1, 0], [second.x, 2]], 'a visible obstruction is checked without another placement')
  assert.deepEqual(walks, [], 'walking around does not clear a player or solid block from inside the target')
  if (obstacle === 'player') {
    actor.position = first.offset(0, 0, 5)
    afterInspection = () => { b.swarmTurnOwner = {}; afterInspection = undefined }
    await step()
    assert.equal(actions.length, 2, 'a delayed clear sighting cannot start work for a superseded turn')
  }
  else if (obstacle === 'stone') f.packet(first, 'air')
  else for (let y = 64; y <= 66; y++) f.packet(new Vec3(0, y, 1), 'air')
  await step()
  assert.equal(f.bot.blockAt(first).name, 'dirt')
  assert.equal(sw.telemetry.built, 2, 'the standing builder resumes as soon as the observed target clears')
})

test('a visible teammate in a roof cell stops the jump-placement loop until the space clears', async () => {
  const f = fixture(), at = f.at.offset(0, 2, 0), jumps = []
  f.bot.entities[2] = { id: 2, name: 'player', type: 'player', username: 'Friend',
    position: at.offset(.5, 0, .5), height: 1.8, width: .6 }
  f.bot.setControlState = (key, active) => { if (key === 'jump' && active) jumps.push(key) }
  f.packet(at.offset(1, 0, 0), 'stone')
  const place = () => f.work.swarmWork(f.session, f.ctl, { kind: 'place', at, item: 'dirt', allies: ['Friend'] })
  const blocked = await place()
  assert.equal(blocked.occupiedByEntity, true)
  assert.deepEqual(jumps, [])
  assert.equal(f.calls.includes('place'), false)
  delete f.bot.entities[2]
  assert.equal((await place()).done, true)
  assert.equal(f.bot.blockAt(at).name, 'dirt')
})

for (const floor of ['air', 'stone', 'air with spare dirt']) test('two builders share the edge platform with ' + floor + ' below the sand', async () => {
  const board = new SwarmBoard('blue', () => 1000), cell = new Vec3(1, 64, 0)
  const pos: any = {}, kept = [], walks = [], bodies = [fixture(), fixture()]
  const bots = bodies.map((f, i) => {
    const name = i ? 'Mason' : 'Miner', material = i ? 'dirt' : 'sand', count = i ? 8 : 32
    f.packet(cell.offset(1, 0, 0), 'stone') // A side face both players can reach from the ledge.
    f.packet(cell.offset(0, -1, 0), floor === 'stone' ? 'stone' : 'air')
    const inv = { [material]: count }
    if (!i && floor === 'air with spare dirt') inv.dirt = 1
    f.bot.inventory.items = () => Object.entries(inv).map(([name, count]) => ({ name, count, type: f.bot.registry.itemsByName[name].id }))
    pos[name] = { p: f.bot.entity.position, inv, hp: 20 }
    return { name, c: { async call(method, p) {
      if (method === 'swarm_keep') { kept.push(name); return {} }
      if (method !== 'swarm_work') return { detail: {} }
      const receipt = await f.work.swarmWork(f.session, f.ctl, p)
      if (receipt.done) for (const other of bodies) other.packet(cell, receipt.after)
      return { detail: receipt }
    } } }
  })
  const members = bots.map(b => ({ id: b.name, team: 'blue', role: 'miner-builder' as const, health: 20, strength: 1, position: pos[b.name].p, inventory: pos[b.name].inv }))
  board.setMembers(members)
  const telemetry = { built: 0 }, sw: any = { now: () => 1000, pos, bots, alive: () => true, generation: 1, teamOf: () => 'blue',
    blueprints: new Map(), placed: new Map(), telemetry, say() {}, log() {}, blocked: () => false, failed() {},
    detail: r => r.detail, renew: (b, who, c) => b.renew(c.id, who.name, c.claim.token, 25000),
    buildGo: async (_b, p) => { walks.push(p); return {} } }
  const { buildStep } = swarmBuild(sw)
  const step = i => buildStep(bots[i], { board, members, member: members[i] }, { kind: 'outpost', origin: cell.offset(0, 1, 0), cells: [{ at: cell }] })
  await step(0)
  if (floor === 'air') {
    assert.equal(telemetry.built, 0, 'a side-face packet must not certify a falling floor')
    assert.deepEqual(kept, []); assert.equal(bodies[0].calls.includes('place'), false)
    assert.equal(board.tasks()[0].claim, undefined)
    await step(1)
  }
  assert.equal(telemetry.built, 1)
  assert.equal(board.tasks()[0].data.block, floor === 'stone' ? 'sand' : 'dirt')
  assert.deepEqual(kept, [floor === 'air' ? 'Miner' : 'Mason'])
  assert.deepEqual(walks, [], 'nobody needs to step out over the missing floor')
})

for (const surface of ['supported lip', 'void', 'unloaded footing', 'renewed threat']) test('a sand-equipped relief builder at a shared shelter: ' + surface, async () => {
  const bodies = { A: fixture(), D: fixture() }, pos: any = {}, work = [], walks = []
  let wall: InstanceType<typeof Vec3>
  const enemy = { id: 7, name: 'player', type: 'player', username: 'Opponent', position: new Vec3(-.5, 64, .5),
    height: 1.8, width: .6, equipment: [], velocity: new Vec3(0, 0, 0) }
  const bots = ['A', 'B', 'C', 'D'].map(name => {
    const f = bodies[name], inv = { iron_sword: 1, iron_pickaxe: 1, ...(name === 'A' ? { cobblestone: 64 } : name === 'D' ? { red_sand: 8 } : {}) }
    pos[name] = { p: f?.bot.entity.position || new Vec3(-9, 64, 0), hp: 20, inv, armor: {} }
    if (f) {
      f.bot.game = { gameMode: 'survival', dimension: 'overworld' }
      f.bot.inventory.items = () => Object.entries(inv).map(([name, count]) => ({ name, count, type: f.bot.registry.itemsByName[name].id }))
      const blockAt = f.bot.blockAt
      f.bot.blockAt = p => {
        if (wall && p.y < wall.y) {
          const outward = (p.x - wall.x) * Math.sign(wall.x) + (p.z - wall.z) * Math.sign(wall.z)
          if (outward > 0 || outward === 0 && surface === 'void') return f.block(p, 'air')
          if (outward === 0 && surface === 'unloaded footing') return null
        }
        return blockAt(p)
      }
    }
    const rpc = f && swarmMethods({ session: { require: () => f.bot, immediate: fn => fn() } } as any)
    return { name, team: 'blue', c: { async call(method, p) {
      if (method === 'goto') walks.push(p)
      if (f && method === 'swarm_pose') return { detail: await rpc.swarm_pose(p) }
      if (f && method === 'swarm_work') {
        wall ||= new Vec3(p.at.x, p.at.y, p.at.z)
        const receipt = await f.work.swarmWork(f.session, f.ctl, p)
        work.push({ name, item: p.item, receipt })
        return { detail: receipt }
      }
      return { detail: {} }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24, killY: 60 },
    home: () => pos.A.p, hostile: () => false, log() {} })
  bodies.A.bot.entities[7] = enemy
  await driver.turn(bots[0])
  const task = (at = wall) => driver.snapshot().blue.tasks.find(t => t.data?.blueprint === 'shelter' && at.equals(t.position))
  assert.equal(work[0]?.receipt.why, 'direct_threat')
  assert.ok(!task().claim && task().data.block === 'cobblestone')
  if (surface === 'renewed threat') bodies.D.bot.entities[7] = enemy
  await driver.turn(bots[3])
  assert.equal(work.at(-1)?.name, 'D', 'the relief builder evaluates its own material at the shared shelter')
  const supported = surface === 'supported lip'
  const receipt = work.at(-1).receipt, at = new Vec3(receipt.at.x, receipt.at.y, receipt.at.z)
  assert.equal(receipt.why, supported ? 'placed' : surface === 'renewed threat' ? 'direct_threat' : 'needs_stable_block')
  assert.equal(bodies.D.calls.filter(c => c === 'place').length, supported ? 1 : 0)
  assert.equal(task(at).status, supported ? 'done' : 'pending')
  assert.equal(task(at).data.block, supported ? 'red_sand' : 'cobblestone')
  assert.equal(driver.snapshot().blue.stats.built, supported ? 1 : 0)
  assert.deepEqual(walks, [])
})

test('a builder keeps its red sand when visible support disappears while equipping it', async () => {
  const f = fixture(), below = f.at.offset(0, -1, 0)
  f.packet(f.at.offset(1, 0, 0), 'stone')
  f.bot.inventory.items = () => [{ name: 'red_sand', type: f.bot.registry.itemsByName.red_sand.id, count: 4 }]
  const equip = f.bot.equip
  f.bot.equip = async item => { await equip(item); f.packet(below, 'air') }
  const r = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'red_sand' })
  assert.equal(r.why, 'needs_stable_block'); assert.equal(r.done, false)
  assert.equal(f.calls.includes('place'), false); assert.equal(f.bot.listenerCount('blockUpdate'), 0)
})

test('a relief builder redirects an interrupted cutoff when witnesses see the runner leave its lane', async () => {
  const bodies = { A: fixture(), D: fixture() }, pos: any = {}, receipts = [], placed = []
  const blue = ['A', 'B', 'C', 'D', 'E', 'F'], red = blue.map((_, i) => 'R' + i)
  let now = 1000, firstAlive = true
  const bots = [...blue, ...red].map(name => {
    const f = bodies[name]
    pos[name] = { hp: 20, armor: {}, inv: { iron_sword: 1, ...(f ? { iron_pickaxe: 1, dirt: 8 } : {}) },
      p: new Vec3(.5, 64, .5) }
    if (f) {
      f.bot.game = { gameMode: 'survival', dimension: 'overworld' }
      f.bot._placeBlockWithOptions = async (ref, face) => {
        const at = ref.position.plus(face)
        placed.push({ name, at })
        for (const other of Object.values(bodies)) other.packet(at, 'dirt')
      }
    }
    return { name, team: blue.includes(name) ? 'blue' : 'red', c: { async call(method, p) {
      if (method === 'goto' && f) {
        pos[name].p = f.bot.entity.position = new Vec3(p.x - 1.25, p.y, p.z + .5)
        return { status: 'done', detail: { arrived: pos[name].p } }
      }
      if (method === 'swarm_work') {
        if (name === 'A') f.ctl.abort()
        const r = await f.work.swarmWork(f.session, f.ctl, p)
        receipts.push(r)
        return { detail: r }
      }
      return { detail: {} }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, alive: name => name !== 'A' || firstAlive, now: () => now,
    arena: { x: 0, y: 64, z: 0, r: 50 }, home: () => pos.B.p, hostile: (b, id) => b.team === 'blue' && red.includes(id), log() {} })
  const sight = (z, vx, vz) => {
    for (const who of [bots[1], bots[4]]) driver.observe(who, [{ id: 'R0', visible: true, position: { x: 8.5, y: 64, z },
      velocity: { x: vx, y: 0, z: vz }, equipment: { weapon: 'wooden_sword', armor: [] } }], now)
  }
  sight(.5, .2, 0)
  await driver.turn(bots[0])
  const before = driver.snapshot().blue.tasks.filter(t => t.data?.blueprint?.startsWith('cutoff:'))
  assert.equal(before.length, 10, 'both miners share a five-wide two-high cutoff')
  assert.ok(before.every(t => t.status === 'pending' && !t.claim))
  assert.equal(receipts[0]?.aborted, true)
  assert.deepEqual(placed, [])
  firstAlive = false; now += 1500
  sight(16.5, 0, .2)
  await driver.turn(bots[3])
  assert.deepEqual(placed.map(r => r.name), ['D'], 'the relief builder places a real block on the fresh interception lane')
  assert.ok(placed[0].at.z >= 21)
  const walls = driver.snapshot().blue.tasks.filter(t => t.data?.blueprint?.startsWith('cutoff:'))
  assert.equal(walls.length, 10)
  assert.equal(walls.filter(t => t.status === 'done').length, 1)
  assert.ok(walls.every(t => t.data.blueprint !== before[0].data.blueprint))
  assert.equal(bodies.D.bot.blockAt(placed[0].at).name, 'dirt')
})

test('a second builder repairs a witnessed breach before extending the shelter, once per confirmed wall', async () => {
  const clock = require('../src/game-clock'), { observationMethods } = require('../src/rpc/observation')
  const { swarmMethods } = require('../src/rpc/swarm')
  const bodies = { A: fixture(), D: fixture() }, pos: any = {}, placed = [], calls = [], work = []
  const now = 4000
  const bots = ['A', 'B', 'C', 'D'].map(name => {
    const f = bodies[name], p = f?.bot.entity.position || new Vec3(-9, 64, 0)
    pos[name] = { p, hp: 20, inv: { dirt: 64, iron_pickaxe: 1, iron_sword: 1 }, armor: {} }
    if (f) {
      f.bot.game = { gameMode: 'survival', dimension: 'overworld' }
      f.bot._placeBlockWithOptions = async (ref, face) => {
        const at = ref.position.plus(face); placed.push({ name, at })
        for (const other of Object.values(bodies)) other.packet(at, 'dirt')
      }
    }
    const session = { bot: f?.bot, require: () => f.bot, immediate: async fn => ({ detail: await fn() }),
      runIntent: async (_kind, fn) => ({ detail: await fn(f.ctl) }) }
    const rpc = { ...swarmMethods({ session, gameClock: clock }), ...observationMethods({ session, cfg: {}, state: {}, gameClock: clock }) }
    return { name, team: 'blue', c: { async call(method, params) {
      calls.push(method)
      if (f && ['swarm_work', 'swarm_keep', 'status'].includes(method)) {
        const result = await rpc[method](params)
        if (method === 'swarm_work') work.push(result.detail)
        return result
      }
      return { detail: {} }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, alive: () => true, now: () => now,
    arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: () => false, log() {} })
  const worker = bots[3], f = bodies.D
  const report = async () => (await worker.c.call('status', { swarm: true })).detail.breaches || []
  const receive = (b, reports, asked = now) => driver.observeBreaches(b, reports, asked)
  await driver.turn(bots[0]); assert.equal(placed.length, 1)
  const at = placed[0].at, id = 'build:shelter:' + [at.x, at.y, at.z].join(',')
  const wall = () => driver.snapshot().blue.tasks.find(t => t.id === id)
  assert.equal(wall().status, 'done')
  const start = f.bot.entity.position
  f.bot.entity.position = at.offset(4.5, 0, .5)
  for (let y = 63; y <= 67; y++) for (let z = -2; z <= 2; z++) f.packet(at.offset(2, y - at.y, z), 'stone')
  f.packet(at, 'air')
  assert.deepEqual(await report(), [], 'a server packet behind stone is not a sighting')
  f.bot.entity.position = start
  f.packet(at, 'dirt')
  f.bot.emit('blockUpdate', null, f.block(at, 'air'))
  assert.deepEqual(await report(), [], 'client prediction is not a receipt')
  f.packet(at, 'air'); f.packet(at, 'dirt')
  assert.deepEqual(await report(), [], 'already restored before the report')
  const air = f.block(at, 'air')
  f.cells.set(at.toString(), air)
  f.bot._client.emit('multi_block_change', { chunkCoordinates: at.scaled(1 / 16).floored(),
    records: [air.stateId * 4096 + ((at.x & 15) << 8) + ((at.z & 15) << 4) + (at.y & 15)] })
  const breach = await report()
  assert.equal(breach.length, 1, 'the ally saw the confirmed wall disappear')
  receive({ ...worker, team: 'red' }, breach)
  receive(worker, breach, now - 5000)
  receive(worker, [{ ...breach[0], ageMs: 5000 }])
  assert.equal(wall().status, 'done')
  receive(worker, breach)
  assert.equal(wall().status, 'pending')
  assert.equal(driver.snapshot().blue.stats.built, 1)
  const a = bodies.A
  a.packet(at, 'air')
  a.bot.entities[7] = { id: 7, name: 'player', type: 'player', username: 'Opponent', position: a.bot.entity.position.offset(-1, 0, 0),
    height: 1.8, width: .6, equipment: [], velocity: new Vec3(0, 0, 0) }
  const supplies = a.bot.inventory.items()
  a.bot.inventory.items = () => [...supplies, { name: 'iron_sword', maxDurability: 250, durabilityUsed: 0 }]
  await driver.turn(bots[0])
  assert.equal(work.at(-1)?.why, 'direct_threat')
  assert.equal(wall().claim, undefined); assert.equal(placed.length, 1)
  const actions = calls.length
  await driver.turn(worker)
  assert.equal(wall().status, 'done'); assert.equal(driver.snapshot().blue.stats.built, 2)
  assert.deepEqual(placed, [{ name: 'A', at }, { name: 'D', at }])
  assert.ok(!calls.slice(actions).includes('swarm_pose'), 'repair uses the ordinary placement with no survey RPC')
  receive(worker, breach); assert.equal(wall().status, 'done', 'delayed report must not revoke the new receipt')
  await worker.c.call('swarm_keep', { cells: [{ ...breach[0].at, repair: breach[0].repair }] })
  f.packet(at, 'air')
  const next = await report(); assert.equal(next.length, 1)
  assert.notDeepEqual(next[0].repair, breach[0].repair, 'a late acknowledgement must not disarm the repaired wall')
  driver.reset()
  receive(worker, next); assert.equal(wall(), undefined)
  assert.equal(f.bot._client.listenerCount('multi_block_change'), 0)
})

test('a visible sand cell does not identify hidden support under the platform', async () => {
  for (const concealed of ['stone', 'air']) {
    const f = fixture()
    f.packet(f.at, 'sand')
    f.packet(f.at.offset(0, -1, 0), concealed)
    const r = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'sand' })
    assert.equal(r.why, 'needs_stable_block'); assert.equal(r.done, false)
    assert.equal(f.calls.includes('place'), false)
  }
})

test('the shelter driver accepts a native sight of an existing sandstone wall and assigns the next cell', async () => {
  const f = fixture(), logs: string[] = [], attempts = [], moves = []
  const home = { x: 636.5, y: 120, z: 594.5 }
  f.bot.entity.position = new Vec3(home.x, home.y, home.z)
  f.bot.blockAt = p => f.cells.get(p.floored().toString()) || f.block(p, p.y < home.y ? 'stone' : 'air')
  let existing
  const b = { name: 'A', team: 'blue', c: { async call(method, params) {
    if (method === 'goto') moves.push(params)
    if (method !== 'swarm_work') return { detail: {} }
    attempts.push(params.at)
    if (!existing) {
      existing = new Vec3(params.at.x, params.at.y, params.at.z)
      f.packet(existing, 'smooth_sandstone')
    }
    return { detail: await f.work.swarmWork(f.session, f.ctl, params) }
  } } }
  const pos = { A: { p: home, hp: 20, inv: { dirt: 64, iron_pickaxe: 1, iron_sword: 1 }, armor: {} } }
  const driver = createSwarmDriver({ bots: [b], pos, alive: () => true, arena: { ...home, r: 48 }, home: () => home, hostile: () => false, log: v => logs.push(v) })
  await driver.turn(b)
  const wall = driver.snapshot().blue.tasks.find(t => t.kind === 'build' && t.status === 'done')
  assert.equal(wall?.data.block, 'smooth_sandstone')
  assert.deepEqual(wall.position, { x: existing.x, y: existing.y, z: existing.z })
  assert.equal(f.calls.includes('place') || f.calls.includes('dig'), false)
  assert.equal(moves.length, 0); assert.equal(driver.snapshot().blue.stats.built, 0)
  assert.ok(logs.some(line => line.includes('готовая кладка smooth_sandstone')))
  await driver.turn(b)
  assert.equal(attempts.length, 2); assert.notDeepEqual(attempts[0], attempts[1])
  assert.equal(f.calls.filter(c => c === 'place').length, 1)
  assert.equal(driver.snapshot().blue.stats.built, 1)
})

test('only witnessed stable masonry can replace the requested material of a shelter cell', async () => {
  const f = fixture(), work = (opts = {}) => f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt', reuseMasonry: true, ...opts })
  const Block = require('prismarine-block')('1.21.11')
  const set = (name, at = f.at) => {
    const block = Block.fromStateId(f.bot.registry.blocksByName[name].defaultState)
    block.position = at; f.cells.set(at.toString(), block)
  }
  for (const name of ['sand', 'sandstone_slab', 'chest', 'magma_block', 'tnt']) {
    set(name)
    assert.equal((await work()).done, false, name)
  }
  set('sandstone')
  assert.equal((await work({ reuseMasonry: false })).done, false, 'a marker still requires the specified material')
  assert.equal((await work({ protected: [f.at] })).done, false, 'do not claim the doorway')
  f.bot._ndBridgeExec = { pending: new Set(['1,64,0']) }
  assert.equal((await work()).done, false, 'a client prediction is not existing masonry')
  f.bot._ndBridgeExec.pending.clear()
  const hidden = f.at.offset(1, 0, 0)
  set('smooth_sandstone', hidden)
  for (const y of [64, 65, 66]) for (const z of [-1, 0, 1]) set('stone', new Vec3(1, y, z))
  const unseen = await work({ at: hidden })
  assert.equal(unseen.done, false); assert.equal(unseen.before, undefined)
  assert.equal(f.calls.filter(c => c === 'place' || c === 'dig').length, 0)
})

test('a worker reports that this viewpoint has no usable face without confirming a placement', async () => {
  const f = fixture(), at = new Vec3(2, 65, 0)
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at, item: 'dirt' })
  assert.equal(result.done, false)
  assert.equal(result.noVisibleSupport, true)
  assert.deepEqual(result.viewpoint, { x: .5, y: 64, z: .5 })
  assert.deepEqual(result.at, { x: 2, y: 65, z: 0 })
  assert.ok(!f.calls.includes('place'))
})

test('a builder proposes only neighbouring unoccupied blueprint air with a visible usable face', async () => {
  const at = new Vec3(2, 65, 0), below = at.offset(0, -1, 0)
  for (const mode of ['clear', 'protected', 'hidden', 'occupied', 'diagonal']) {
    const f = fixture(), candidate = mode === 'diagonal' ? at.offset(1, -1, 0) : below
    if (mode === 'hidden') for (const y of [64, 65]) f.packet(new Vec3(1, y, 0), 'stone')
    if (mode === 'occupied') f.packet(below, 'glass')
    const r = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at, item: 'dirt',
      supportCells: [candidate], protected: mode === 'protected' ? [candidate] : [] })
    assert.deepEqual(r.reachableNeighbours || [], mode === 'clear' ? [{ x: 2, y: 64, z: 0 }] : [], mode)
    assert.equal(f.calls.includes('dig'), false)
    if (r.noVisibleSupport) assert.equal(f.calls.includes('place'), false)
  }
})

test('a builder clicks the witnessed top of a lower slab when it becomes the next anchor', async () => {
  const f = fixture(), ref = new Vec3(2, 64, 0), at = ref.offset(0, 1, 0)
  const slab = f.block(ref, 'stone_slab'); slab.shapes = [[0, 0, 0, 1, .5, 1]]
  f.cells.set(ref.toString(), slab)
  let click
  f.bot._placeBlockWithOptions = async (block, face, options) => {
    click = options; f.packet(block.position.plus(face), 'dirt')
  }
  const r = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at, item: 'dirt' })
  assert.equal(r.done, true)
  assert.equal(click.delta?.y, .5)
})

test('two shelter builders start a floating wall from its visible supported neighbour under one lease', async () => {
  const bodies = { A: fixture(), D: fixture() }, beside = new Vec3(2, 64, 1)
  const pos: any = {}, placements = [], leases = [], walks = []
  let driver
  for (const [name, f] of Object.entries(bodies)) {
    f.bot.entity.position = new Vec3(1.6, 64, name === 'A' ? .05 : 2.45)
    // Only the middle of the three requested wall cells has ground beneath it.
    for (const z of [0, 2]) f.packet(new Vec3(2, 63, z), 'air')
    f.bot._placeBlockWithOptions = async (ref, face) => {
      const at = ref.position.plus(face)
      const claim = driver.snapshot().blue.tasks.find(t => t.id === 'build:shelter:' + [at.x, at.y, at.z].join(','))?.claim
      placements.push(at.toString()); leases.push([name, claim?.owner])
      for (const body of Object.values(bodies)) body.packet(at, 'dirt')
    }
  }
  let arrivals = 0, release
  const together = new Promise<void>(r => { release = r })
  const bots = ['A', 'B', 'C', 'D'].map(name => {
    const f = bodies[name]
    pos[name] = { p: f?.bot.entity.position || { x: -9, y: 64, z: 0 }, hp: 20,
      inv: { dirt: 64, iron_pickaxe: 1, iron_sword: 1 }, armor: {} }
    return { name, team: 'blue', c: { async call(method, p) {
      if (method === 'goto') walks.push(name)
      if (method !== 'swarm_work') return { detail: {} }
      const r = await f.work.swarmWork(f.session, f.ctl, p)
      if (r.noVisibleSupport && arrivals < 2) { if (++arrivals === 2) release(); await together }
      return { detail: r }
    } } }
  })
  driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 },
    home: () => ({ x: 0, y: 64, z: 0 }), hostile: () => false, log() {} })
  await Promise.all([driver.turn(bots[0]), driver.turn(bots[3])])
  assert.equal(arrivals, 2)
  assert.deepEqual(placements, [beside.toString()], 'one confirmed helper cell in the same turn as the two refusals')
  assert.deepEqual(walks, [], 'both builders can already see the useful cell')
  await Promise.all([driver.turn(bots[0]), driver.turn(bots[3])])
  assert.deepEqual(placements.sort(), [0, 1, 2].map(z => new Vec3(2, 64, z).toString()).sort())
  assert.ok(leases.every(([actor, owner]) => actor === owner))
  assert.equal(driver.snapshot().blue.stats.built, 3)
})

test('a roof cell can use an actual jump to expose the supporting wall top', async () => {
  const f = fixture()
  const target = new Vec3(1, 66, 0)
  f.cells.set(new Vec3(1, 64, 0).toString(), f.block(new Vec3(1, 64, 0), 'dirt'))
  f.cells.set(new Vec3(1, 65, 0).toString(), f.block(new Vec3(1, 65, 0), 'dirt'))
  f.bot.setControlState = (name, value) => { if (name === 'jump' && value) { f.calls.push('jump'); f.bot.entity.position.y = 64.8 } }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: target, item: 'dirt', timeoutSeconds: 1 })
  assert.equal(result.done, true)
  assert.ok(f.calls.includes('jump'))
  assert.equal(result.after, 'dirt')
})

test('blueprints have a roof, a two block exit and explicit allied floor protection', () => {
  const { swarmBlueprint } = source('swarm-work')
  const plan = swarmBlueprint('shelter', { x: 10, y: 64, z: 10 }, 'north')
  const keys = new Set(plan.cells.map((c: any) => `${c.at.x},${c.at.y},${c.at.z}`))
  assert.equal(keys.size, plan.cells.length)
  assert.equal(keys.has('10,64,8'), false); assert.equal(keys.has('10,65,8'), false)
  assert.equal(keys.has('10,66,10'), true)
  assert.equal(plan.protected.some((c: any) => c.x === 10 && c.y === 63 && c.z === 10), true)
  assert.equal(plan.cells.every((c: any) => c.kind === 'place'), true)
  const cocoon = swarmBlueprint('cocoon', { x: 10, y: 64, z: 10 }, 'north')
  assert.equal(cocoon.cells.some((c: any) => c.at.x === 10 && c.at.y === 66 && c.at.z === 10), true)
  assert.equal(cocoon.cells.some((c: any) => c.at.x === 10 && c.at.y === 65 && c.at.z === 9), false)
  assert.equal(swarmBlueprint('cutoff', { x: 10, y: 64, z: 10 }, 'east').cells.length, 10)
})

test('worker rejects bad coordinates and protected or allied supporting cells before any hand action', async () => {
  const f = fixture()
  for (const at of [{ x: NaN, y: 64, z: 0 }, { x: 30_000_000, y: 64, z: 0 }, { x: 1.5, y: 64, z: 0 }, { x: 1, y: -65, z: 0 }]) {
    const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at })
    assert.equal(result.ok, false); assert.equal(result.why, 'invalid_cell')
  }
  assert.equal((await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at, protected: [f.at] })).why, 'protected_cell')
  assert.equal((await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: { x: 0, y: 63, z: 0 } })).why, 'allied_support')
  assert.equal(f.calls.includes('dig') || f.calls.includes('place'), false)
})

test('actual native placement commits one exact cell and honest placement cannot reach behind a wall', async () => {
  const f = fixture(), result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.after, 'dirt')
  assert.equal(f.calls.filter(x => x === 'place').length, 1)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
  const hidden = fixture(), target = new Vec3(3, 64, 0)
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) hidden.cells.set(new Vec3(1, y, z).toString(), hidden.block(new Vec3(1, y, z), 'stone'))
  const refused = await hidden.work.swarmWork(hidden.session, hidden.ctl, { kind: 'place', at: target, item: 'dirt', timeoutSeconds: .1 })
  assert.equal(refused.ok, false); assert.equal(hidden.calls.includes('place'), false)
})

test('client prediction cannot commit a placement without an authoritative packet', async () => {
  const f = fixture()
  f.bot._placeBlockWithOptions = async (ref: any, face: any) => { f.cells.set(ref.position.plus(face).toString(), f.block(ref.position.plus(face), 'dirt')) }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt', timeoutSeconds: .1 })
  assert.equal(result.ok, false); assert.equal(result.done, false)
})

test('visible digging commits only a native server air receipt', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.after, 'air')
  assert.equal(f.calls.filter(x => x === 'dig').length, 1)
  const blocked = fixture(), target = new Vec3(2, 64, 0)
  blocked.cells.set(target.toString(), blocked.block(target, 'stone'))
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) blocked.cells.set(new Vec3(1, y, z).toString(), blocked.block(new Vec3(1, y, z), 'stone'))
  const refused = await blocked.work.swarmWork(blocked.session, blocked.ctl, { kind: 'dig', at: target })
  assert.equal(refused.ok, false); assert.equal(refused.why, 'occluded_or_out_of_reach'); assert.equal(blocked.calls.includes('dig'), false)
})

test('an idle distant visible enemy permits work but a visible charging enemy interrupts it', async () => {
  const f = fixture(), e = { id: 2, name: 'player', type: 'player', username: 'Enemy', position: new Vec3(10.5, 64, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0) }
  f.bot.entities[2] = e
  assert.equal(f.work.directThreat(f.bot, [], 3000), null)
  e.velocity.x = -.4
  assert.equal(f.work.directThreat(f.bot, [], 3000)?.username, 'Enemy')
  assert.equal(f.work.directThreat(f.bot, ['Enemy'], 3000), null)
})

test('placement can resume only when the current visible threat or the builder’s actual combat margin permits it', async t => {
  const f = fixture(), foe = Object.assign(new EventEmitter(), { id: 2, name: 'player', type: 'player', username: 'Enemy',
    position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, onGround: true, velocity: new Vec3(0, 0, 0) })
  let time = 1000
  const tracked: any = foe
  tracked._ndObservationNow = () => time
  const sight = require('../src/pvp/last-seen').createLastSeen(f.bot)
  t.after(() => sight.close())
  const move = (x, kind = 'rel_entity_move') => {
    time += 50; foe.position = new Vec3(x, 64, .5)
    tracked._ndPositionReceipts = [tracked._ndPositionReceipts?.[1], { ...foe.position, t: time, grounded: true, kind }]
    foe.emit('ndPositionObserved')
  }
  f.bot.health = 6; f.bot.entities[2] = foe
  const rpc = swarmMethods({ session: { require: () => f.bot, immediate: fn => fn() } } as any)
  const safe = async () => (await rpc.swarm_pose({ placementSafety: true, allies: ['Friend'], contained: [] })).safeToResume
  assert.equal(await safe(), false)
  for (let y = 64; y < 68; y++) f.packet(new Vec3(1, y, 0), 'stone')
  assert.equal(await safe(), true, 'the new solid cover hides the former opponent')
  f.bot.entities[3] = { ...foe, id: 3, username: 'Other', position: new Vec3(-1.5, 64, .5) }
  assert.equal(await safe(), false, 'a different visible attacker from behind still reaches the builder')
  f.bot.entities[3].username = 'Friend'
  assert.equal(await safe(), true)
  f.cells.clear()
  move(5.8, 'sync_entity_position'); move(5.4); move(5)
  assert.equal(await safe(), false, 'approaching before the block can be placed')
  move(5.4); move(5.8)
  assert.equal(await safe(), true, 'the runner has turned away')
  foe.position = new Vec3(2.5, 64, .5)
  f.bot.health = 20
  f.bot.inventory.items = () => ['iron_sword', 'bread'].map(name => ({ name, count: 8, type: f.bot.registry.itemsByName[name].id }))
  assert.equal(await safe(), true, 'healthy and equipped to handle the actual threat')
  assert.ok(f.calls.every(c => c !== 'place' && c !== 'dig'), 'observation never sends a work action')
})

test('external cancellation immediately stops in-flight digging and releases callbacks', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { f.calls.push('dig'); started(); await new Promise(() => {}) }
  const task = f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready; f.ctl.abort()
  const result = await task
  assert.equal(result.aborted, true); assert.equal(result.done, false)
  assert.ok(f.calls.includes('stopDigging')); assert.ok(f.calls.includes('clear'))
  assert.equal(f.ctl.onAbort.length, 0); assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})

test('contact during a dig yields to existing combat safety and does not continue work', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void, safetyChecks = 0, retreats = 0
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { started(); await new Promise(() => {}) }
  const worker = source('swarm-work', { './combat-safety': {
    inspect: () => { safetyChecks++; return { action: 'leave' } },
    disengage: async () => { retreats++; return { clear: true } }
  } })
  const pending = worker.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.emit('physicsTick')
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(result.done, false); assert.equal(result.why, 'direct_threat')
  assert.equal(safetyChecks, 1); assert.equal(retreats, 1); assert.ok(f.calls.includes('stopDigging'))
})

for (const contact of ['visible', 'wall', 'spectator', 'after the placement packet']) test('a builder loses health before the next physics tick: ' + contact, async () => {
  const f = fixture(), bot = f.bot, from = bot.entity.position.clone()
  const human = { id: 7, type: 'player', name: 'player', username: 'Visitor', position: from.offset(0, 0, 2),
    width: .6, height: 1.8, equipment: [{ name: 'netherite_sword' }], isValid: true }
  bot.players = { Visitor: { entity: human, gamemode: contact === 'spectator' ? 3 : 0 } }
  bot.health = 12
  require('mineflayer/lib/plugins/health')(bot, { respawn: false })
  const { stateOf, simOf }: typeof import('../src/edges') = require('../src/edges')
  const world = { getBlock: bot.blockAt }
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(bot.registry, world)
  Object.assign(bot.entity, { velocity: new Vec3(0, 0, 0), attributes: {}, pitch: 0 })
  const controls = {}, steps = []
  bot.look = async yaw => { bot.entity.yaw = yaw }
  bot.setControlState = (key, value) => {
    controls[key] = value
    if (key === 'forward' && value) {
      const state = stateOf(bot)
      Object.assign(state.control, controls)
      simOf(bot)(state, world)
      bot.entity.position = state.pos; bot.entity.velocity = state.vel
      steps.push(state.pos)
      delete bot.entities[7] // End the pursuit after the worker's first physical step.
    }
  }
  bot.getControlState = key => !!controls[key]
  const hit = () => {
    bot.entities[7] = human
    if (contact === 'wall') for (let x = -2; x <= 2; x++) for (let y = 64; y <= 67; y++) f.packet(new Vec3(x, y, 1), 'stone')
    bot._client.emit('update_health', { health: 5, food: 20, foodSaturation: 4 })
  }
  if (contact === 'after the placement packet') {
    const place = bot._placeBlockWithOptions
    bot._placeBlockWithOptions = async (...args) => { await place(...args); hit() }
  } else bot.lookAt = async () => { hit() }
  const session = { bot, runIntent: (_name, fn) => fn(f.ctl) }
  const result = await swarmMethods({ session } as any).swarm_work({ kind: 'place', at: f.at, item: 'dirt' })
  const danger = contact === 'visible' || contact === 'after the placement packet'
  assert.equal(result.why, danger ? 'direct_threat' : 'taking_damage')
  assert.equal(steps.length, danger ? 1 : 0)
  if (danger) {
    assert.ok(['leave', 'recover'].includes(result.safety))
    assert.ok(steps[0].distanceTo(human.position) > from.distanceTo(human.position), String(steps[0]))
    assert.equal(result.retreat.clear, true)
  }
  assert.equal(result.done, contact === 'after the placement packet')
  assert.equal(f.calls.filter(c => c === 'place').length, result.done ? 1 : 0)
  assert.equal(require('../src/swarm-work').isKept(bot, f.at), result.done)
  bot.emit('end')
})

test('a close enemy behind a wall is unseen and a cancelled placement never sends its packet', async () => {
  const f = fixture(), enemy = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.entities[2] = enemy
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) f.cells.set(new Vec3(1, y, z).toString(), f.block(new Vec3(1, y, z), 'stone'))
  assert.equal(f.work.directThreat(f.bot, [], 3000), null)
  const cancelled = fixture()
  cancelled.bot.lookAt = async () => { cancelled.ctl.abort() }
  const result = await cancelled.work.swarmWork(cancelled.session, cancelled.ctl, { kind: 'place', at: cancelled.at, item: 'dirt' })
  assert.equal(result.aborted, true); assert.equal(cancelled.calls.includes('place'), false)
})

test('a miner leaves a visible drawn bow beyond melee distance before the next radio report', async () => {
  const f = fixture()
  f.bot.health = 5
  f.packet(f.at, 'dirt')
  let start!: () => void
  const ready = new Promise<void>(resolve => { start = resolve })
  f.bot.dig = async () => { f.calls.push('dig'); start(); await new Promise(() => {}) }
  const flags = f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const archer = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Archer',
    position: new Vec3(.5, 64, 12.5), yaw: 0, metadata: [], equipment: [{ name: 'bow' }], height: 1.8, width: .6 })
  archer.metadata[flags] = 1
  let steps = 0
  f.bot.look = async yaw => { f.bot.entity.yaw = yaw }
  f.bot.setControlState = (key, value) => {
    if (key === 'forward' && value) {
      steps++
      archer.metadata[flags] = 0 // The miner can see the archer lowering the bow.
    }
  }
  const task = f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready
  f.bot.entities[2] = archer
  f.bot.emit('physicsTick')
  const result = await task
  assert.equal(result.why, 'direct_threat')
  assert.ok(['leave', 'recover'].includes(result.safety))
  assert.equal(steps, 1)
  assert.equal(result.retreat.clear, true)
  assert.deepEqual(f.calls.filter(c => c === 'dig' || c === 'stopDigging'), ['dig', 'stopDigging'])
  f.bot.emit('end')
})

for (const stage of ['beforeClick', 'afterClick', 'duringRetreat', 'differentBlock']) test('surprise contact during placement: ' + stage, async () => {
  const f = fixture(), enemy = { id: 2, type: 'player', name: 'player', username: 'Enemy',
    position: new Vec3(.5, 64, 2.5), width: .6, height: 1.8 }
  let clicks = 0
  const interrupt = () => {
    if (stage !== 'duringRetreat') f.packet(f.at, stage === 'differentBlock' ? 'stone' : 'dirt')
    f.bot.entities[2] = enemy
    f.bot.emit('physicsTick')
  }
  f.bot._placeBlockWithOptions = async () => { clicks++; interrupt() }
  if (stage === 'beforeClick') f.bot.lookAt = async () => interrupt()
  const worker = source('swarm-work', { './combat-safety': {
    inspect: () => ({ action: 'leave' }), disengage: async () => {
      if (stage === 'duringRetreat') f.packet(f.at, 'dirt')
      return { clear: true }
    } } })
  const result = await worker.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  assert.equal(result.why, 'direct_threat'); assert.equal(result.aborted, true)
  const ownBlock = stage === 'afterClick' || stage === 'duringRetreat'
  assert.equal(result.done, ownBlock)
  assert.equal(clicks, stage === 'beforeClick' ? 0 : 1)
  assert.equal(worker.isKept(f.bot, f.at), ownBlock)
  if (result.done) assert.equal(result.after, 'dirt')
})

test('digging sends the visible face without a second recentering look', async () => {
  const f = fixture(), upper = new Vec3(1, 66, 0)
  f.cells.set(upper.toString(), f.block(upper, 'dirt'))
  f.bot.dig = async (_b: any, forceLook: any) => {
    assert.equal(forceLook, 'ignore')
    assert.equal(f.bot.targetDigFace, (require('../node_modules/prismarine-world') as typeof import('../node_modules/prismarine-world')).iterators.BlockFace.BOTTOM)
    f.packet(upper, 'air')
  }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: upper })
  assert.equal(result.ok, true)
})

test('timed-out client air is restored before the next worker sees the cell', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  f.bot.dig = async () => { f.bot._updateBlockState(f.at, f.bot.registry.blocksByName.air.minStateId) }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at, timeoutSeconds: .1 })
  assert.equal(result.done, false); assert.equal(f.bot.blockAt(f.at).name, 'dirt')
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})

test('cancellation between predicted dig completion and receipt settlement restores collision', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { f.bot._updateBlockState(f.at, f.bot.registry.blocksByName.air.minStateId); started() }
  const pending = f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready; f.ctl.abort()
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(f.bot.blockAt(f.at).name, 'dirt')
})

test('a visible existing exact block acknowledges resumed work without another placement', async () => {
  const f = fixture(); f.packet(f.at, 'dirt')
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.already, true)
  assert.equal(result.confirmation, 'visible_existing'); assert.equal(f.calls.includes('place'), false)
  const wrong = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'stone' })
  assert.equal(wrong.done, false); assert.equal(wrong.why, 'occupied_cell')
})

test('resumed build cannot acknowledge an occluded exact block or pending body predictions', async () => {
  const f = fixture(), hidden = new Vec3(2, 64, 0)
  f.packet(hidden, 'dirt')
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) f.cells.set(new Vec3(1, y, z).toString(), f.block(new Vec3(1, y, z), 'stone'))
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: hidden, item: 'dirt' })
  assert.equal(result.done, false); assert.equal(result.why, 'occluded_or_out_of_reach')
  const wrong = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: hidden, item: 'stone' })
  assert.equal(wrong.why, 'occluded_or_out_of_reach'); assert.equal(wrong.before, undefined)
  const rpc = swarmMethods({ session: { require: () => f.bot, immediate: fn => fn() } } as any)
  const survey = await rpc.swarm_pose({ cells: [hidden], inspectOnly: true, occupants: true })
  assert.equal(survey.cells[0].existing, undefined, 'a wall hides both the block and any occupant from the shared plan')
  const predicted = fixture(); predicted.cells.set(predicted.at.toString(), predicted.block(predicted.at, 'dirt'))
  for (const property of ['_ndClutch', '_ndBridgeExec']) {
    predicted.bot[property] = { pending: new Map([[`${predicted.at.x},${predicted.at.y},${predicted.at.z}`, {}]]) }
    const refused = await predicted.work.swarmWork(predicted.session, predicted.ctl, { kind: 'place', at: predicted.at, item: 'dirt' })
    assert.equal(refused.done, false); assert.equal(refused.why, 'server_unconfirmed')
    delete predicted.bot[property]
  }
})

test('an enemy four blocks overhead cannot prevent an otherwise safe visible undercut just because I can reach its feet', () => {
  const f = fixture()
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(.5, 68, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0) }
  assert.equal(f.work.directThreat(f.bot, [], 1000), null)
})

test('a weak contained enemy within reach does not stop work, an uncontained or a strong one still does', () => {
  const f = fixture(), e: any = { id: 2, name: 'player', type: 'player', username: 'Caged', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0), equipment: [] }
  f.bot.entities[2] = e
  assert.equal(f.work.directThreat(f.bot, [], 1000)?.username, 'Caged', 'an ordinary close enemy is a threat')
  assert.equal(f.work.directThreat(f.bot, [], 1000, x => x, { contained: ['Caged'] }), null, 'a caged bare-handed foe poking through a slit is a price, not a stop')
  f.bot.health = 6
  assert.equal(f.work.directThreat(f.bot, [], 1000, x => x, { contained: ['Caged'] })?.username, 'Caged', 'at low health even a weak hit is too costly')
})

test('combat never punches through a block the swarm keeps as its own structure', async () => {
  const Vec3: typeof import('vec3').Vec3 = require('vec3'), { keepBlocks }: typeof import('../src/swarm-work') = require('../src/swarm-work'), { createTerrain }: typeof import('../src/pvp/terrain') = require('../src/pvp/terrain')
  const wall = new Vec3(1, 65, 0), broke: any[] = []
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, world: { raycast: () => ({ position: wall, boundingBox: 'block' }) } }
  const ctx: any = { bot, EYE: 1.62, entity: { position: new Vec3(3.5, 64, .5), height: 1.8 }, rest() {}, pathTo() {}, clear() {}, async holdWeapon() {}, used() {},
    tools: { bestFor: () => ({ ms: 300 }), breakFast: async (_b, p) => { broke.push(p); return { ok: true, tool: 'iron_pickaxe' } } } }
  const { punchThrough } = createTerrain(ctx)
  keepBlocks(bot, [{ x: 1, y: 65, z: 0 }])
  assert.equal(await punchThrough(), false, 'an own cocoon wall is not the enemy wall')
  assert.equal(broke.length, 0)
  keepBlocks(bot, [], { clear: true })
  assert.equal(await punchThrough(), true)
  assert.equal(broke.length, 1)
})
