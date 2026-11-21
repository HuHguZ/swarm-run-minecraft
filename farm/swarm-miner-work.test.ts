import assert from 'node:assert/strict'
import test from 'node:test'
import { SwarmBoard } from '../daemon/src/swarm'
import { swarmMethods } from '../daemon/src/rpc/swarm'
import { swarmWork } from '../daemon/src/swarm-work'
import { block, testBot } from '../daemon/test/tick-plugins-fixture'
import { worldOf, drive } from '../daemon/test/parkour-fixture'
import { swarmBuild } from './swarm/swarm-driver/build'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmRetry } from './swarm/swarm-driver/retry'

const at = (x, y = 64, z = 0) => ({ x, y, z })
const key = p => [p.x, p.y, p.z].join(',')

test('a doorway dig prices the melee line after removing the block and checks the visible exit', async () => {
  for (const mode of ['safe', 'ambush', 'support', 'occupied', 'unknown', 'void', 'hidden', 'emptyWall', 'rejected']) {
    const f = scene(), bot = f.bodies[0], rock = at(1), exit = at(2)
    bot.entity.position.set(.68, 64, -.58)
    for (let x = -1; x <= 4; x++) for (let z = -2; z <= 2; z++) f.cells.set(key(at(x,63,z)), 'smooth_sandstone')
    f.cells.set(key(rock), 'cobblestone')
    f.cells.set(key(at(1,65)), 'cobblestone')
    if (mode === 'unknown') {
      const blockAt = bot.blockAt
      bot.blockAt = p => key(p.floored()) === key(at(2,63)) ? null : blockAt(p)
    }
    if (mode === 'void') f.cells.delete(key(at(2,63)))
    if (mode === 'hidden' || mode === 'emptyWall') for (let z = -2; z <= 2; z++) for (let y = 64; y <= 66; y++) f.cells.set(key(at(1,y,z)), 'cobblestone')
    if (['ambush', 'hidden', 'support', 'occupied'].includes(mode)) {
      const sword = { name: 'netherite_sword', type: bot.registry.itemsByName.netherite_sword.id }, shield = { name: 'shield', type: bot.registry.itemsByName.shield.id }
      const foe = { id: 9, username: mode === 'support' || mode === 'occupied' ? 'B' : 'Red', type: 'player', name: 'player', height: 1.8, width: .6,
        position: bot.entity.position.offset(2.22, 0, 1.28), velocity: bot.entity.velocity, isValid: true, metadata: [], equipment: [sword, shield] }
      if (mode === 'support') foe.position = bot.entity.position.offset(.82, 1, 1.08)
      if (mode === 'occupied') foe.position = bot.entity.position.offset(.34, 0, .83)
      bot.entities[9] = foe
    }
    let sends = 0
    const dig = bot.dig
    bot.dig = async target => {
      sends++
      if (mode === 'rejected') bot._client.emit('block_change', { location: target.position, type: target.stateId })
      else await dig(target)
    }
    const reply = await f.bots[0].c.call('swarm_work', { kind: 'dig', at: rock, item: 'cobblestone', passageExit: exit, allies: ['A','B'], timeoutSeconds: 1 })
    const result: any = reply.detail
    if (mode === 'safe') { assert.equal(result.why, 'dug'); assert.equal(sends, 1) }
    else if (mode === 'rejected') { assert.equal(result.done, false); assert.equal(sends, 1) }
    else {
      assert.equal(result.done, false, mode)
      assert.equal(sends, 0, mode)
      if (mode === 'ambush') assert.equal(result.why, 'direct_threat')
      if (mode === 'support') assert.equal(result.why, 'allied_support')
      if (mode === 'occupied') assert.equal(result.why, 'occupied_cell')
      if (mode === 'hidden' || mode === 'emptyWall') assert.equal(result.why, 'unsafe_passage_exit', 'same geometry, whether someone is hidden or not')
    }
  }
})

function scene() {
  const board = new SwarmBoard('blue', () => 1000)
  const calls = [], cells = new Map<string, string>(), pos = {}, bodies = []
  const sw: any = { now: () => 1000, generation: 1, pos, alive: () => true, detail: r => r?.detail || {},
    arena: { ...at(0), r: 40 }, telemetry: { dug: 0 }, log() {}, ownProtection: () => [], cooldown: new Map() }
  Object.assign(sw, swarmRetry(sw))
  const bots = ['A', 'B'].map(name => {
    const body = testBot()
    bodies.push(body)
    body.entity.position.y = 64
    body.health = 20
    body.heldItem.name = 'iron_pickaxe'
    body.inventory.slots[36] = body.heldItem
    body.canDigBlock = () => true
    body.lookAt = async () => {}
    body.equip = async item => { body.heldItem = item }
    body.dig = async target => {
      cells.delete(key(target.position))
      body._client.emit('block_change', { location: target.position, type: body.registry.blocksByName.air.defaultState })
    }
    pos[name] = { p: body.entity.position, hp: 20, inv: { iron_pickaxe: 1 } }
    body.blockAt = p => block(cells.get(key(p.floored())) || 'air', p.floored())
    const native = swarmMethods({ session: { require: () => body, immediate: fn => fn() } } as any)
    return { name, c: { async call(method, params) {
      calls.push({ name, method, params })
      if (method === 'swarm_pose') return { detail: await native.swarm_pose(params) }
      if (method === 'blocks_around') return { detail: { found: [...cells].filter(([, n]) => n === params.find).map(([k]) => {
        const [x, y, z] = k.split(',').map(Number); return { x, y, z }
      }) } }
      if (method === 'swarm_work') return { detail: await swarmWork({ bot: body }, { aborted: false, onAbort: [] }, params) }
      return { detail: {} }
    } } }
  })
  const members = bots.map(b => ({ id: b.name, team: 'blue', health: 20, strength: 12, role: 'miner-builder' as const, position: pos[b.name].p }))
  board.setMembers(members)
  const work = swarmBuild(sw)
  return { board, bots, bodies, cells, calls, sw, mine: (i, foe = null) => work.mineStep(bots[i], { board, members, member: members[i] }, foe) }
}


test('door clearance preserves another active build or dig claim on the same block', async () => {
  for (const kind of ['build', 'mine'] as const) {
    const f = scene(), door = at(1), m = f.sw.pos.A, b = f.bots[0]
    let time = 1000
    Object.assign(f.sw, { bots: f.bots, blueprints: new Map(), placed: new Map(), now: () => time,
      teamOf: () => 'blue', arena: { x: 0, y: 64, z: 0, r: 30 }, home: () => at(0),
      renew: (board, bot, task) => board.renew(task.id, bot.name, task.claim.token), say() {} })
    f.sw.ownProtection = swarmMoves(f.sw).ownProtection
    m.inv.cobblestone = 64
    const member = { id: 'A', role: 'miner-builder', team: 'blue', health: 20, inventory: m.inv, position: m.p }
    const context = { member, members: [member], board: f.board }, work = swarmBuild(f.sw)
    const request = { kind: 'outpost', origin: at(0), direction: 'east' }
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) f.cells.set(key(at(x,63,z)), 'stone')
    const raw = b.c.call
    b.c.call = async (method,p) => method === 'swarm_work' && p.kind === 'place'
      ? { detail: { done: true, at: p.at, after: p.item, before: p.item, already: true, confirmation: 'visible_existing' } }
      : raw(method,p)
    await work.buildStep(b, context, request)
    assert.equal(f.sw.blueprints.size, 1)
    f.cells.set(key(door), 'cobblestone')
    const id = kind === 'mine' ? 'mine:' + key(door) : 'foreign-wall'
    f.board.upsert({ id, kind, position: door, data: { block: 'stone', blueprint: 'other' } })
    const lease = f.board.claim(id, 'B', 10000)
    assert.ok(lease)
    time += 2000
    await work.buildStep(b, context, request)
    assert.equal(f.cells.get(key(door)), 'cobblestone')
    assert.equal(f.board.task(id)?.claim?.owner, 'B')
    assert.equal(f.calls.some(c => c.method === 'swarm_work' && c.params.kind === 'dig'), false)
  }
})

test('a free miner can quarry the second visible block while a teammate is still digging the first', async () => {
  const f = scene()
  for (const x of [1, 2]) f.cells.set(key(at(x)), 'stone')
  let started, release
  const digging = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const call = f.bots[0].c.call
  f.bots[0].c.call = async (method, p) => {
    if (method === 'swarm_work') { started(); await held }
    return call(method, p)
  }
  const first = f.mine(0)
  try {
    await digging
    assert.equal(await f.mine(1), true)
    assert.equal(f.board.tasks().find(t => t.id === 'mine:2,64,0')?.status, 'done')
  } finally { release(); await first }
  assert.equal(f.sw.telemetry.dug, 2)
})

async function firstLanding(cells: Map<string, string>) {
  const blocks: Parameters<typeof worldOf>[0] = [...cells].map(([k, name]) => {
    const [x, y, z] = k.split(',').map(Number)
    return [x, y, z, name]
  })
  for (let x = -2; x <= 6; x++) blocks.push([x, 63, 0, 'sandstone'])
  for (let x = 2; x <= 6; x++) blocks.push([x, 64, 0, 'stone'])
  const { bot, world } = worldOf(blocks)
  bot.entity.position.y = 64
  drive(bot, world)
  bot.setControlState('forward', true)
  for (let tick = 1; tick <= 22; tick++) {
    bot.setControlState('jump', tick <= 3)
    await bot.waitForTicks(1)
    if (bot.entity.onGround && bot.entity.position.y === 65 && bot.entity.position.x >= 1.2) return tick
  }
  return null
}

test('an uphill miner opens the next head space and leaves the step and decorative stone beside it intact', async () => {
  for (const blocked of [true, false]) {
    const f = scene()
    f.cells.set(key(at(-1)), 'smooth_sandstone')
    f.cells.set(key(at(1)), 'stone')
    if (blocked) {
      f.cells.set(key(at(1,65)), 'oak_planks')
      assert.equal(await firstLanding(f.cells), null)
    }
    assert.equal(await f.mine(0, { id: 'Red', position: at(6,70) }), blocked)
    assert.deepEqual(f.calls.filter(c => c.method === 'swarm_work').map(c => c.params.at), blocked ? [at(1,65)] : [])
    assert.equal(f.cells.get(key(at(1))), 'stone')
    assert.equal(f.cells.get(key(at(-1))), 'smooth_sandstone')
    assert.equal(f.cells.has(key(at(1,65))), false)
    assert.equal(await firstLanding(f.cells), 9)
  }
})

test('a miner whose round ends during observation never starts work in the replacement round', async () => {
  const f = scene(), call = f.bots[0].c.call
  f.cells.set(key(at(1)), 'smooth_sandstone')
  f.bots[0].c.call = async (method, p) => {
    const r = await call(method, p)
    if (method === 'blocks_around') f.sw.generation++
    return r
  }
  await f.mine(0)
  assert.deepEqual(f.calls.map(c => c.method), ['blocks_around'])
  assert.deepEqual(f.board.tasks(), [])
})

for (const phase of ['approach', 'aim']) test('a newly placed barrel survives when it replaces a surveyed wall during ' + phase, async () => {
  const f = scene(), call = f.bots[0].c.call, wall = at(1,65)
  f.cells.set(key(wall), 'oak_planks')
  f.bots[0].c.call = async (method, p) => {
    if (method === 'swarm_work' && phase === 'approach') f.cells.set(key(wall), 'barrel')
    return call(method, p)
  }
  if (phase === 'aim') f.bodies[0].lookAt = async () => { f.cells.set(key(wall), 'barrel') }
  await f.mine(0, { id: 'Red', position: at(6,70) })
  assert.equal(f.cells.get(key(wall)), 'barrel')
  assert.equal(f.sw.telemetry.dug, 0)
  assert.equal(f.calls.some(c => c.method === 'assist'), false)
})

test('a stationary miner can reconsider the only nearby material once its teammate releases the cell', async () => {
  const f = scene(), rock = at(1)
  f.cells.set(key(rock), 'stone')
  const task = f.board.upsert({ id: 'mine:' + key(rock), kind: 'mine', position: rock })
  const held = f.board.claim(task.id, 'B')!
  assert.equal(await f.mine(0), false)
  assert.equal(f.board.release(task.id, 'B', held.claim.token), true)
  assert.equal(await f.mine(0), true)
  assert.equal(f.sw.telemetry.dug, 1)
})

for (const screened of [false, true]) test('a cleared cell needs a personal sightline before the miner credits it; screened ' + screened, async () => {
  const f = scene(), rock = at(3,65), call = f.bots[0].c.call
  f.cells.set(key(rock), 'stone')
  f.bots[0].c.call = async (method, p) => {
    if (method === 'swarm_work') {
      f.cells.delete(key(rock))
      if (screened) for (const y of [64,65,66]) f.cells.set(key(at(1,y)), 'stone')
    }
    return call(method, p)
  }
  await f.mine(0)
  assert.equal(f.board.task('mine:' + key(rock))?.status, screened ? 'pending' : 'done')
  assert.equal(f.sw.telemetry.dug, 0)
  assert.equal(f.calls.some(c => c.method === 'assist'), false)
})

test('the miner preserves the stone supporting a visible ally and takes the other stone', async () => {
  const f = scene(), body = f.bodies[0]
  for (const x of [1, -1]) f.cells.set(key(at(x)), 'stone')
  body.entities[9] = { id: 9, type: 'player', username: 'B', height: 1.8, width: .6,
    position: body.entity.position.offset(1, 1, 0), metadata: [], equipment: [] }
  await f.mine(0)
  assert.equal(f.cells.has(key(at(1))), true)
  assert.equal(f.cells.has(key(at(-1))), false)
  assert.equal(f.sw.telemetry.dug, 1)
})

test('a miner whose retreat was blocked yields excavation until its own sightline is safe again', async () => {
  const f = scene(), actor = f.bodies[0], rock = at(1), call = f.bots[0].c.call
  f.cells.set(key(rock), 'stone')
  const sword = { name: 'netherite_sword', type: actor.registry.itemsByName.netherite_sword.id, count: 1 }
  actor.entities[8] = { id: 8, type: 'player', username: 'Red', height: 1.8, width: .6, isValid: true,
    position: actor.entity.position.offset(0, 0, 2), velocity: actor.entity.velocity, metadata: [], equipment: [sword], heldItem: sword }
  actor.health = 4
  let attempts = 0
  f.bots[0].c.call = async (method, p) => {
    if (method === 'swarm_work') {
      attempts++
      if (actor.entities[8]) return { detail: { done: false, aborted: true, why: 'direct_threat', safety: 'leave', retreat: { clear: false } } }
    }
    return call(method, p)
  }
  assert.equal(await f.mine(0), true)
  assert.equal(await f.mine(0), false)
  assert.equal(attempts, 1)
  delete actor.entities[8]
  assert.equal(await f.mine(0), true)
  assert.equal(attempts, 2)
  assert.equal(f.cells.has(key(rock)), false)
})
