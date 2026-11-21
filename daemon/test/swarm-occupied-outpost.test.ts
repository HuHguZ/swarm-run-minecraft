import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { model } from '../arena/colosseum'
import { generate } from '../arena/colosseum-arms'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'
import { swarmMethods } from '../src/rpc/swarm'
import { swarmSightings } from '../src/swarm-senses'
import { blockOnRay, eyeOf } from '../src/pick'
import { swarmBlueprint } from '../src/swarm-work'
import { SwarmBoard, addBlueprint } from '../src/swarm'
import { stateOf, simOf } from '../src/edges'
import { swarmBuild } from '../../farm/swarm/swarm-driver/build'
import { swarmRetry } from '../../farm/swarm/swarm-driver/retry'

const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
const layout = generate('team1'), grid = model({ R: 24, bays: 40, ceilH: 64, masts: 0 }).g
for (const [x, y, z, name] of [...layout.field, ...layout.set]) grid.set(x, y, z, name === 'air' ? '' : name.replace(/\{.*$/, ''))
const start = new Vec3(667.5, 143, 605.5), enemyAt = new Vec3(637.5, 120, 591.5)
const arena = { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113, ellipse: layout.ellipse }
const stock = { cobblestone: 64, iron_pickaxe: 1, iron_sword: 1 }

test('gallery builders reopen their surveyed entrance when a foreign block fills the doorway', async t => {
  const f = scene(t, true), door = new Vec3(667, 145, 605)
  const digs: string[] = []
  for (const worker of f.bodies.values()) {
    worker.canDigBlock = () => true
    worker.dig = async block => {
      assert.ok(block.position.equals(door))
      digs.push(worker.username)
      f.changes.set(door.toString(), 'air')
      for (const observer of f.bodies.values()) observer._client.emit('block_change', { location: door, type: registry.blocksByName.air.defaultState })
    }
  }
  await f.turn(3)
  for (let i = 0; i < 9; i++) await Promise.all([f.turn(0), f.turn(3)])
  const using = () => f.driver.snapshot().blue.tasks
  assert.ok(using().some(t => t.data?.blueprint === 'outpost:667,143,606'))
  assert.ok(!using().some(t => t.kind === 'build' && door.equals(t.position)), 'the obstruction is not our masonry')
  assert.equal((await f.rpc.swarm_pose({ inspectOnly: true, at: door })).existing?.name, 'air')
  f.changes.set(door.toString(), 'cobblestone')
  for (let i = 0; i < 10 && !digs.length; i++) await Promise.all([f.turn(0), f.turn(3)])
  assert.equal(digs.length, 1)
  assert.equal(f.body.blockAt(door).name, 'air')
  assert.equal(using().find(t => t.id === 'mine:667,145,605')?.status, 'done')
})


function scene(t, pair = false, sentry = false) {
  const blocks = new Map<string, any>(), changes = new Map<string, string | null>()
  const blockAt = (p: Vec3) => {
    const at = p.floored(), id = at.toString()
    let name = grid.get(at.x - 600, at.y - 120, at.z - 600) || 'air'
    if (changes.has(id)) { name = changes.get(id); if (!name) return null }
    const key = id + ':' + name
    if (!blocks.has(key)) {
      const [blockName, state] = name.split('[')
      const data = registry.blocksByName[blockName], block = state
        ? Block.fromProperties(data.id, Object.fromEntries(state.slice(0, -1).split(',').map(v => v.split('='))))
        : Block.fromStateId(data.defaultState)
      block.position = at; blocks.set(key, block)
    }
    return blocks.get(key)
  }
  const blue = Array.from({ length: 20 }, (_, i) => 'B' + String(i).padStart(2, '0')), red = blue.map(n => n.replace('B', 'R'))
  const makeBody = (i: number, position: Vec3) => {
    const inv = { ...stock }
    return Object.assign(new EventEmitter(), { username: blue[i], version: '1.21.11', registry, health: 20, food: 20, inv,
      game: { minY: -64, height: 384 }, physics: require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: blockAt }),
      entity: { id: 1 + i, username: blue[i], type: 'player', name: 'player', position, velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI / 2,
        pitch: 0, width: .6, height: 1.8, attributes: {}, effects: {} }, blockAt,
      inventory: { slots: [], items: () => Object.entries(inv).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) } }) as any
  }
  const body = makeBody(0, pair ? start.offset(.18, 0, .18) : start.clone()), bodies = new Map([[0, body]])
  if (pair) bodies.set(3, makeBody(3, start.offset(.18, 0, 1.18)))
  const foe = { id: 2, username: red[0], name: 'player', type: 'player', position: enemyAt.clone(), velocity: new Vec3(0, 0, 0),
    height: 1.8, width: .6, onGround: true, metadata: [], equipment: [pair ? 'bow' : 'netherite_sword', null, 'netherite_boots', 'netherite_leggings',
      'netherite_chestplate', 'netherite_helmet'].map(name => name && { name }) }
  const calls = [], surveys = [], layoutSurveys = [], logs = [], receipts = [], placements = []
  const clients = new Map<number, ReturnType<typeof swarmMethods>>()
  for (const [i, worker] of bodies) {
    worker.entities = Object.fromEntries([foe, ...[...bodies.values()].filter(other => other !== worker).map(b => b.entity)].map(e => [e.id, e]))
    worker.players = Object.fromEntries(Object.values<any>(worker.entities).map(e => [e.username, { entity: e, gamemode: 0 }]))
    worker._client = new EventEmitter(); worker.clearControlStates = () => {}; worker.stopDigging = () => {}
    let lookedAt: Vec3
    worker.lookAt = async point => {
      lookedAt = point
      const d = point.minus(eyeOf(worker))
      worker.entity.yaw = Math.atan2(-d.x, -d.z)
      worker.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    }
    worker.equip = async item => { worker.heldItem = item }
    worker._placeBlockWithOptions = async (ref, face, options) => {
      const at = ref.position.plus(face), previous = blockAt(at), name = worker.heldItem.name
      assert.ok(lookedAt.distanceTo(ref.position.plus(options.delta)) < 1e-6)
      const eye = eyeOf(worker), ray = lookedAt.minus(eye), reach = ray.norm()
      assert.ok(reach <= 4.5 && blockOnRay(worker, eye, ray.scaled(1 / reach), reach + .01)?.pos.equals(ref.position))
      assert.equal(previous.boundingBox, 'empty'); assert.ok(worker.inv[name] > 0)
      for (const other of bodies.values()) {
        const p = other.entity.position
        if (p.x + .3 > at.x && p.x - .3 < at.x + 1 && p.z + .3 > at.z && p.z - .3 < at.z + 1 &&
          p.y + 1.8 > at.y && p.y < at.y + 1) throw new Error('server refused placement inside a player')
      }
      worker.inv[name]--; changes.set(at.toString(), name)
      const block = blockAt(at)
      placements.push({ by: worker.username, at: { x: at.x, y: at.y, z: at.z }, name })
      for (const other of bodies.values()) {
        other._client.emit('block_change', { location: at, type: block.stateId })
        other.emit('blockUpdate', previous, block)
      }
    }
    const session = { bot: worker, require: () => worker, immediate: fn => fn(), runIntent: (_name, fn) => fn({ aborted: false, onAbort: [] }) }
    clients.set(i, swarmMethods({ session } as any))
    t.after(() => worker.emit('end'))
  }
  const rpc = clients.get(0)
  let afterSurvey: () => void, walk: (worker, goal) => any, time = 1000
  const bots = [...blue, ...red].map((name, i) => ({ name, team: i < 20 ? 'blue' : 'red', c: { async call(method, p) {
    const client = clients.get(i)
    if (!client) return { detail: {} }
    calls.push({ by: name, method, p })
    if (method === 'swarm_position') { const report = await client.swarm_position(p); surveys.push(report); afterSurvey?.(); return { detail: report } }
    if (method === 'swarm_pose') {
      const report = await client.swarm_pose(p)
      if (p.outpost && p.cells) layoutSurveys.push({ by: name, cells: report.cells })
      return { detail: report }
    }
    if (method === 'swarm_work') {
      const receipt = await client.swarm_work(p)
      await bodies.get(i).jumpDone
      receipts.push({ by: name, ...receipt }); return { detail: receipt }
    }
    if (method === 'goto') {
      const arrived = walk?.(bodies.get(i), new Vec3(p.x, p.y, p.z))
      if (arrived) {
        pos[name].p = arrived
        return { status: 'done', detail: { arrived } }
      }
      return { status: 'failed', detail: { why: 'noPath' } }
    }
    return { detail: {} }
  } } }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: bodies.get(i)?.entity.position || (i === 20 ? enemyAt.clone() :
    i < 4 ? start.offset(-.5, 0, i) : new Vec3(i < 20 ? 566.5 : 634.5, 120, 600.5)), hp: 20,
    inv: bodies.get(i)?.inv || (pair && i < 20 ? { iron_sword: 1, shield: 1 } : { iron_sword: 1 }), armor: {} }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena, arms: true, home: b => pos[b.team === 'blue' ? blue[1] : red[1]].p,
    hostile: (b, id) => (b.team === 'blue' ? red : blue).includes(id), now: () => time, log: s => logs.push(s),
    chestTops: [{ tier: 3, x: 644, y: 143, z: 600 }] })
  const sentryBody = sentry && makeBody(1, new Vec3(667.5, 143, 597.5))
  if (sentryBody) {
    sentryBody.entity.id = 1001; sentryBody.entities = { [foe.id]: foe }; sentryBody.players = { [foe.username]: { entity: foe, gamemode: 0 } }
    pos.B01.p = sentryBody.entity.position
    for (const worker of bodies.values()) { worker.entities[sentryBody.entity.id] = sentryBody.entity; worker.players.B01 = { entity: sentryBody.entity, gamemode: 0 } }
  }
  function scoutReport() {
    const seen = swarmSightings(sentryBody, blue)
    driver.observe(bots[1], seen, time)
    return seen.some(e => e.id === foe.username && e.visible && !e.nametag && !e.glowing)
  }
  const turn = async (i = 0) => {
    driver.observe(bots[i], swarmSightings(bodies.get(i), blue), time)
    await driver.turn(bots[i]); time += 200
  }
  return { body, bodies, clients, foe, pos: pos.B00, driver, bot: bots[0] as any, calls, surveys, layoutSurveys, logs, changes, turn, rpc, receipts, placements,
    scoutReport, onWalk: fn => { walk = fn }, onSurvey: fn => { afterSurvey = fn } }
}

test('a 20v20 builder already on the team1 eastern gallery starts its outpost from its own supported feet', async t => {
  const f = scene(t)
  await f.turn()
  assert.equal(f.surveys[0].candidates.length, 6)
  assert.ok(f.surveys[0].candidates.every(c => c.highGround === 23 && c.score > 0 && start.distanceTo(new Vec3(c.at.x, c.at.y, c.at.z)) < 2))
  assert.deepEqual(f.bot.swarmPosition?.at, { x: start.x, y: start.y, z: start.z })
  assert.ok(f.logs.some(l => l.includes('общий план outpost, 32 клеток')))
  assert.ok(f.calls.some(c => c.method === 'swarm_work' && c.p.kind === 'place'))
  const workIndex = f.calls.findIndex(c => c.method === 'swarm_work')
  assert.ok(!f.calls.slice(0, workIndex).some(c => c.method === 'goto'), 'claim the site without inventing a walk')
  await f.turn()
  assert.equal(f.calls.filter(c => c.method === 'swarm_position' && !c.p.currentBuildOnly).length, 1)
  assert.ok(f.calls.some(c => c.method === 'swarm_position' && c.p.currentBuildOnly))
})

test('an occupied outpost needs the current floor, body and personally visible lower opponent', async t => {
  const f = scene(t), key = start.offset(0, -1, 0).floored().toString()
  const inspect = async () => (await f.rpc.swarm_position({ purpose: 'build', arena, currentBuildOnly: true, enemies: [{ id: 'R00' }] })).currentBuild
  assert.deepEqual((await inspect())?.at, { x: start.x, y: start.y, z: start.z })
  for (const material of ['air', 'magma_block', null]) {
    f.changes.set(key, material)
    assert.equal(await inspect(), undefined)
  }
  f.changes.delete(key); f.body.entity.onGround = false
  assert.equal(await inspect(), undefined)
  f.body.entity.onGround = true; f.body.entity.position = start.offset(0, 1, 0)
  assert.equal(await inspect(), undefined, 'same XZ, feet are above the photographed stair')
  f.body.entity.position = start.clone()
  delete f.body.entities[2]
  assert.equal(await inspect(), undefined, 'the old target name on the radio supplies no height')
})

test('the gallery builder steps down to a visible face and confirms the ninth cell', async t => {
  const f = scene(t, true)
  await f.turn(3)
  const certified = () => f.driver.snapshot().blue.tasks.filter(c => c.data?.blueprint === 'outpost:667,143,606' && c.status === 'done')
  const wallReady = () => certified().some(c => c.position.x === 668 && c.position.y === 144 && c.position.z === 606)
  for (let i = 0; i < 12 && !wallReady(); i++) await Promise.all([f.turn(0), f.turn(3)])
  assert.ok(wallReady())
  const target = new Vec3(666, 143, 607), builder = f.bodies.get(3), helper = f.bodies.get(0)
  const poses = async () => (await f.clients.get(3).swarm_pose({ at: target })).poses
  const lower = (await poses()).find(p => p.aim === 'standing' && p.y === 142)
  assert.ok(lower, 'the builder sees a usable face from the lower stair')
  const stance = new Vec3(lower.x, lower.y, lower.z), previous = helper.entity.position
  helper.entity.position = stance
  assert.ok((await poses()).every(p => Math.abs(p.x - stance.x) >= .6 || Math.abs(p.y - stance.y) >= 1.8 || Math.abs(p.z - stance.z) >= .6))
  helper.entity.position = previous
  const tread = stance.offset(0, -.01, 0).floored().toString()
  f.changes.set(tread, 'air')
  assert.ok((await poses()).every(p => stance.distanceTo(new Vec3(p.x, p.y, p.z)) > .02), 'vanished footing is not a stance')
  f.changes.delete(tread)
  const anchor = target.offset(1, 0, 0).toString()
  f.changes.set(anchor, 'air')
  assert.ok((await poses()).every(p => !p.aim), 'an exploratory view supplies no proof of a missing support face')
  f.changes.set(anchor, 'cobblestone')
  const { stateOf, simOf }: typeof import('../src/edges') = require('../src/edges')
  let walked = 0
  f.onWalk((worker, to) => {
    if (worker !== builder || to.distanceTo(worker.entity.position) > 2) return
    const state = stateOf(worker), sim = simOf(worker), world = { getBlock: worker.blockAt }
    for (let tick = 1; tick <= 22; tick++) {
      const d = to.minus(state.pos)
      state.yaw = Math.atan2(-d.x, -d.z)
      state.control.forward = Math.hypot(d.x, d.z) > .1
      sim(state, world)
      const other = helper.entity.position
      if (Math.abs(state.pos.x - other.x) < .6 && Math.abs(state.pos.z - other.z) < .6 && Math.abs(state.pos.y - other.y) < 1.8 || state.pos.y < to.y - .3) return
      if (state.onGround && state.pos.distanceTo(to) <= .18) {
        walked += tick
        worker.entity.position = state.pos
        worker.entity.velocity = state.vel
        return state.pos
      }
    }
  })
  await Promise.all([f.turn(3), f.turn(0)])
  assert.ok(walked && certified().some(c => target.equals(new Vec3(c.position.x, c.position.y, c.position.z))), 'land on the lower tread, then place against the west face')
  assert.equal(certified().length, 9)
  assert.equal(builder.entity.position.y, 142)
  assert.deepEqual(f.placements.at(-1), { by: 'B03', at: { x: 666, y: 143, z: 607 }, name: 'cobblestone' })

  // Replay the same order after the work and its reference have been mined away.
  f.changes.set(target.toString(), 'air')
  f.changes.set(anchor, 'air')
  const order = f.calls.filter(c => c.by === 'B03' && c.method === 'swarm_work').at(-1)
  const before = builder.inv.cobblestone
  const stale = await f.clients.get(3).swarm_work(order.p)
  assert.equal(stale.done, false)
  assert.equal(stale.noVisibleSupport, true)
  assert.equal(builder.inv.cobblestone, before)
})

test('two builders certify separate cells of one team1 gallery outpost through native work', async t => {
  const f = scene(t, true)
  // One builder discovers the site. Both then take ordinary concurrent turns from adjacent stair cells.
  assert.notDeepEqual(f.bodies.get(0).entity.position.floored(), f.bodies.get(3).entity.position.floored())
  await f.turn(3)
  for (let i = 0; i < 12; i++) await Promise.all([f.turn(0), f.turn(3)])
  const cells = f.driver.snapshot().blue.tasks.filter(c => c.data?.blueprint?.startsWith('outpost:'))
  const done = cells.filter(c => c.status === 'done')
  const key = p => [p.x, p.y, p.z].join(',')
  const proven = f.receipts.filter(r => r.done && done.some(c => key(c.position) === key(r.at)))
  assert.equal(new Set(cells.map(c => c.data.blueprint)).size, 1)
  assert.equal(cells.length, 32)
  // The north door opens one block down onto a personally seen stair in the generated gallery.
  const doorstep = f.layoutSurveys.find(s => s.by === 'B03').cells.filter(c => c.at.x === 667 && c.at.z === 604)
  assert.equal(doorstep.find(c => c.at.y === 142)?.existing?.tread, true)
  for (const y of [143, 144, 145]) assert.equal(doorstep.find(c => c.at.y === y)?.existing?.name, 'air')
  for (const y of [144, 145]) assert.ok(!cells.some(c => key(c.position) === [667, y, 605].join(',')))
  assert.ok(f.logs.some(l => l.includes('→ ring')))
  assert.deepEqual([...new Set(proven.map(r => r.by))].sort(), ['B00', 'B03'])
  assert.equal(new Set(proven.map(r => key(r.at))).size, proven.length)
  assert.equal(proven.length, done.length)
  const reused = proven.filter(r => r.already && r.confirmation === 'visible_existing')
  assert.ok(reused.length >= 2 && reused.every(r => r.before === 'smooth_sandstone_stairs' && r.after === r.before))
  const installed = proven.filter(r => r.why === 'placed' && r.after === 'cobblestone')
  assert.ok(installed.some(r => r.at.y === start.y), 'fill the deck beside the stairs')
  assert.ok(installed.some(r => r.at.y === start.y + 1), 'raise the first wall above the deck')
  const byCell = r => r.by + ':' + key(r.at)
  assert.deepEqual(installed.map(byCell).sort(), f.placements.map(byCell).sort())
  for (const worker of f.bodies.values()) {
    const spent = stock.cobblestone - worker.inv.cobblestone
    assert.equal(spent, installed.filter(r => r.by === worker.username).length)
  }
})

test('a changed observer position, opponent or round during the survey cannot create an outpost', async t => {
  for (const event of ['other tier', 'other opponent', 'round reset']) await t.test(event, async st => {
    const f = scene(st)
    f.onSurvey(() => {
      if (event === 'round reset') f.driver.reset()
      else if (event === 'other opponent') {
        const other = { ...f.foe, id: 3, username: 'R01' }
        f.body.entities = { 3: other }; f.body.players = { R01: { entity: other, gamemode: 0 } }
        f.driver.observe(f.bot, swarmSightings(f.body, []))
      }
      else f.pos.p = f.body.entity.position = start.offset(0, -1, 0)
    })
    await f.turn()
    assert.ok(f.surveys[0].currentBuild)
    assert.equal(f.bot.swarmPosition?.occupied, undefined)
    assert.ok(f.logs.every(s => !s.includes('общий план outpost')))
  })
})

test('one observed exterior stair unlocks the last gallery wall and the roof in the normal work queue', async t => {
  const f = scene(t, true), bot = f.body, origin = { x: 667, y: 144, z: 606 }, wall = new Vec3(666,145,606), outside = new Vec3(669,144,606)
  const plan = swarmBlueprint('outpost', origin, 'north')
  const board = new SwarmBoard('blue', () => 1000), id = 'gallery', key = p => [p.x, p.y, p.z].join(',')
  // Resume the measured 22/32 checkpoint. On this tier the original lower stairs remain part of the deck.
  const prior = plan.cells.filter(c => c.at.y < 146 && !wall.equals(new Vec3(c.at.x,c.at.y,c.at.z)))
  for (const { at } of prior) {
    const p = new Vec3(at.x,at.y,at.z), previous = bot.blockAt(p)
    if (!previous.shapes.length) f.changes.set(p.toString(), 'cobblestone')
  }
  bot.entity.position = f.pos.p = new Vec3(669.49,144,607.615); bot.jumpTicks = 0; bot.jumpQueued = false
  f.bodies.get(3).entity.position = new Vec3(667.5,143,597.5)
  const member = { id: 'B00', role: 'miner-builder' as const, team: 'blue', position: f.pos.p, health: 20, strength: 1, inventory: bot.inv }
  board.setMembers([member])
  addBlueprint(board, { id, cells: plan.cells.map(c => ({ id: key(c.at), position: c.at, block: 'cobblestone',
    dependsOn: c.at.y === 146 ? [...prior.map(c => key(c.at)),key(wall)] : [] })) })
  for (const { at } of prior) {
    const work = board.claim('build:' + id + ':' + key(at), member.id)
    assert.ok(board.ack(work.id, member.id, { token: work.claim.token, confirmed: true, position: at, block: 'cobblestone' }))
  }
  const sw: any = { bots: [f.bot], arena, pos: { B00: f.pos }, blueprints: new Map([['blue:' + id, plan]]), placed: new Map(),
    now: () => 1000, alive: () => true, log() {}, say() {}, telemetry: { built: 0 }, teamOf: () => 'blue', detail: r => r?.detail || {},
    renew: (board,b,c) => board.renew(c.id,b.name,c.claim.token,25000), buildGo: (b,p,range) => b.c.call('goto', { ...p, range }) }
  Object.assign(sw, swarmRetry(sw))
  walkGallery(f)
  const ctx = { board, member, members: [member] }, { buildStep } = swarmBuild(sw)
  const work = () => buildStep(f.bot, ctx, { id, kind: 'outpost', origin })
  await work()
  assert.deepEqual(f.placements.map(r => key(r.at)), [key(outside), key(wall)])
  assert.equal(board.tasks().filter(t => t.status === 'done').length, 23)
  assert.equal(bot.entity.position.y, 146)
  for (let i = 0; i < 15 && board.tasks().some(t => t.status !== 'done'); i++) await work()
  assert.equal(board.tasks().filter(t => t.status === 'done').length, 32)
  assert.equal(f.placements.filter(r => r.at.y === 146).length, 9)
  assert.equal(stock.cobblestone - bot.inv.cobblestone, 11)
})

function walkGallery(f: ReturnType<typeof scene>) {
  f.onWalk((body, to) => {
    const state = stateOf(body), sim = simOf(body), world = { getBlock: body.blockAt }
    const other = [...f.bodies.values()].find(b => b !== body).entity.position
    if (state.pos.distanceTo(to) > 14) return
    for (let i = 0; i < 120; i++) {
      const d = to.minus(state.pos)
      state.yaw = Math.atan2(-d.x, -d.z)
      state.control.forward = Math.hypot(d.x, d.z) > .1
      state.control.jump = state.onGround && d.y > .59
      sim(state, world)
      if (state.pos.y < Math.min(to.y, body.entity.position.y) - .55 ||
          Math.abs(state.pos.x - other.x) < .6 && Math.abs(state.pos.z - other.z) < .6 && Math.abs(state.pos.y - other.y) < 1.8) return
      if (state.onGround && state.pos.distanceTo(to) <= .22) {
        body.entity.position = state.pos; body.entity.velocity = state.vel
        return state.pos
      }
    }
  })
}

test('gallery builders place the reachable upper wall before marking a repeated scout report', async t => {
  let seed = 37
  t.mock.method(Math, 'random', () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  const f = scene(t, true, true)
  for (const worker of f.bodies.values()) { worker.jumpTicks = 0; worker.jumpQueued = false }
  const done = () => f.driver.snapshot().blue.tasks.filter(t => t.data?.blueprint === 'outpost:667,143,606' && t.status === 'done')
  await f.turn(3)
  for (let k = 0; k < 14 && done().length < 8; k++) await Promise.all([f.turn(0), f.turn(3)])
  walkGallery(f)
  for (const worker of f.bodies.values()) worker.setControlState = (name, pressed) => {
    if (name !== 'jump' || !pressed || !worker.entity.onGround || worker.jumping) return
    worker.jumping = true
    worker.jumpDone = new Promise<void>(resolve => {
      const state = stateOf(worker), simulate = simOf(worker)
      let frames = 0
      const frame = () => {
        state.control.jump = frames++ === 0
        simulate(state, { getBlock: worker.blockAt })
        worker.entity.position = state.pos.clone(); worker.entity.velocity = state.vel.clone(); worker.entity.onGround = state.onGround
        if (worker === f.body) f.pos.p = worker.entity.position
        if (frames > 1 && state.onGround || frames >= 30) { worker.jumping = false; resolve(); return }
        setTimeout(frame,25)
      }
      frame()
    })
  }
  for (let k = 0; k < 9; k++) {
    assert.equal(f.scoutReport(), true)
    await f.turn(k % 2 ? 0 : 3)
  }
  const wall = new Vec3(668, 145, 607)
  assert.ok(done().some(t => wall.equals(new Vec3(t.position.x, t.position.y, t.position.z))))
  assert.ok(f.placements.some(r => r.by === 'B03' && wall.equals(new Vec3(r.at.x, r.at.y, r.at.z))))
  assert.ok(f.logs.every(l => !l.includes('общий план beacon')))
  const floor = new Vec3(667,143,605), key = p => [p.x, p.y, p.z].join(',')
  for (let k = 9; k < 22; k++) {
    assert.ok(f.scoutReport())
    const n = f.calls.length
    await f.turn(k % 2 ? 0 : 3)
    if (f.calls.slice(n).some(c => c.method === 'swarm_work' && key(c.p.at) === key(floor)) && done().some(t => key(t.position) === key(floor))) {
      assert.ok(f.calls.slice(n).every(c => c.method !== 'goto'), 'finish the vacated floor from the existing stance')
      break
    }
  }
  assert.ok(done().some(t => key(t.position) === key(floor)), 'step onto the gallery only after the accessible floor is confirmed')
  for (let k = 22; k < 40 && done().length < 32; k++) {
    assert.ok(f.scoutReport())
    await f.turn(k % 2 ? 0 : 3)
  }
  assert.equal(done().length, 32, 'builders use the visible exterior post to reach all remaining roof cells')
  assert.equal(f.placements.filter(r => key(r.at) === '669,144,607').length, 1)
})
