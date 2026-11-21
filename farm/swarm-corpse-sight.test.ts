import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installSight, watchStatus } from './arena/watch'
import { observationMethods } from '../daemon/src/rpc/observation'
import { swarmMethods } from '../daemon/src/rpc/swarm'
import { assist } from '../daemon/src/pvp/team-assist'
import { generate as colosseumArms } from '../daemon/arena/colosseum-arms'
import { Vec3 } from '../daemon/src/pvp/vec3'
import { testBot } from '../daemon/test/tick-plugins-fixture'
import { inPickup } from '../daemon/src/drops'
import { drive, worldOf } from '../daemon/test/parkour-fixture'

const p = (x: number) => ({ x, y: 64, z: .5 })
const tick = () => new Promise(resolve => setImmediate(resolve))
function scene(t, solo = false, origin = p(0)) {
  const calls: any[] = [], visits: any[] = [], kits = new Map(), bodies: any[] = [], timers = new Map(), gifts: string[] = []
  const arena = { x: 0, y: 64, z: 0, r: 80 }
  let clock = 10000, wall = false
  t.mock.method(Date, 'now', () => clock)
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.set(ms, fn); return fn as any })
  const bots = ['Scout', 'Runner', 'Other'].map((name, i) => {
    const body: any = Object.assign(testBot(), { username: name, health: 20, game: { gameMode: 'survival', dimension: 'overworld' },
      entity: { id: i + 1, height: 1.8, position: new Vec3(origin.x + i + .5, origin.y, origin.z) }, entities: {}, players: {},
      blockAt: at => wall && at.x === 5 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] } })
    const native = createRequire(require.resolve('../daemon/src/swarm-senses'))
    native('mineflayer/lib/plugins/entities')(body); native('mineflayer/lib/plugins/health')(body, { respawn: false })
    bodies.push(body); kits.set(name, {})
    const session: any = { bot: body, require: () => body, immediate: async fn => ({ detail: await fn(), state: { pos: body.noPose ? null : body.entity.position, health: body.health, inventory: { ...kits.get(name) } } }) }
    const status = observationMethods({ session, cfg: {}, state: {}, gameClock: { now: Date.now } } as any).status
    return { name, team: solo ? null : i < 2 ? 'blue' : 'red', c: { async call(method, params) {
      calls.push({ name, method, params })
      if (method === 'status') {
        const r = await status({ ...params, dangers: false, physics: false })
        if (name === 'Runner' && body.giver) r.detail.sightings = [{ id: 'Human', visible: true, position: body.entity.position }]
        return r
      }
      if (body.survey && method === 'items_near') return swarmMethods({ session } as any).items_near(params)
      if (body.survey && method === 'assist') {
        if (params.surveySite) visits.push({ name, from: body.entity.position.clone() })
        if (body.pickupPending) await body.pickupPending
        const detail = await assist(session, params); body.afterPickup?.(detail)
        return { status: 'done', detail }
      }
      if (method === 'goto') {
        if (body.approach) return body.approach(params)
        if (body.survey && !body.shortApproach) body.entity.position = new Vec3(params.x, params.y, params.z)
        return { status: 'done', detail: { arrived: params } }
      }
      if (method === 'assist') return { status: 'done', detail: { ok: false, why: 'нет вещей' } }
      return { status: 'done', detail: {} }
    } } }
  })
  const ctx: any = { ...arena, i: 31, X: Math.floor(origin.x), Y: origin.y, Z: Math.floor(origin.z), R: 80, L: { half: 80, y0: -4, chests: [] },
    names: bots.map(b => b.name), bots, pos: {}, arms: true, teams: !solo, armsHome: () => origin, home: () => '0 0',
    round: 1, between: false, busy: new Set(), out: new Set(), deadNow: new Set(), deathAt: {}, labNeed: {}, humans: {}, rel: { red: {}, blue: {} },
    alive: name => !ctx.out.has(name) && !ctx.deadNow.has(name), hostile: () => false, teamOf: name => bots.find(b => b.name === name)?.team, log() {}, emote: async () => {}, eyeOf: () => p(1),
    relSay: (_team, _name, amount) => { if (amount > 0) gifts.push('gift') }, STOPF: '', readDeaths() {}, rcon: async () => '' }
  installSight(ctx)
  const { poll } = watchStatus(ctx)
  return { ctx, bodies, bots, kits, gifts, visits, calls, wall: (v: boolean) => { wall = v },
    async poll() { (poll as any)(); await tick() }, async turn(i: number) { calls.length = 0; clock += 5000; await ctx.swarmDriver.turn(bots[i]); return calls.filter(c => c.name === bots[i].name && c.method === 'goto').map(c => c.params.x) },
    death(i: number, x: number, y = 64, z = .5) {
      const body = bodies[i]
      body.entities[40] = { id: 40, type: 'player', username: 'Ghost', position: new Vec3(x, y, z), height: 1.8 }
      body._client.emit('entity_status', { entityId: 40, entityStatus: 3 }); delete body.entities[40]
    } }
}

test('server death coordinates, the public kill feed and hidden death animations never direct the loot route', async t => {
  const f = scene(t)
  await f.poll()
  f.ctx.deathAt.Ghost = { at: Date.now(), p: p(21), inv: { mace: 1 }, team: 'red', by: 'Scout' }
  f.ctx.swarmDriver.publicDeath('Ghost', 'Scout')
  f.wall(true); f.death(0, 13); await f.poll()
  const route = await f.turn(1)
  assert.ok(!route.includes(21), 'a teammate was sent to a referee-only death location')
  assert.ok(!route.includes(13), 'the scout had a solid wall in front of the death')
  f.wall(false); f.death(0, 13); await f.poll()
  assert.ok((await f.turn(1)).includes(13), 'a surviving teammate can act on the scout seeing the animation')
  assert.ok(!(await f.turn(2)).includes(13), 'the other team cannot use or reserve that report')
  f.death(0, 15); f.ctx.swarmDriver.reset(); f.ctx.round++; await f.poll()
  const next = await f.turn(1)
  assert.ok(!next.includes(13) && !next.includes(15), 'old and in-flight client reports expire with the round')
})

function survey(t, origin = p(0)) {
  const f = scene(t, false, origin), shape = [[0, 0, 0, 1, 1, 1]]
  for (const b of f.bodies) {
    b.survey = true; b.entity.onGround = true; b.waitForTicks = async () => { b.step?.() }
    b.reads = 0
    b.blockAt = pos => {
      b.reads++
      if (b.unloaded && pos.x === 15) return null
      const solid = pos.y < 64 || b.corner && pos.x === 15 && pos.y === 64
      return { position: pos.floored(), name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? shape : [] }
    }
    b.inventory.slots = Array(46).fill(null)
    b.inventory.emptySlotCount = () => b.inventory.slots.slice(9, 45).filter(x => !x).length
  }
  return f
}

test('a close clear survey prevents a second team loot trip, until actually seen items or a new death reopen that ground', async t => {
  const f = survey(t)
  await f.poll(); f.death(0, 13); f.death(2, 13); await f.poll()
  f.bodies[0].reads = 0
  assert.ok((await f.turn(0)).includes(13))
  assert.ok(f.bodies[0].reads < 580, 'a single geometric pass reuses its reads of the loaded patch')
  assert.ok(!(await f.turn(1)).includes(13), 'the other looter must not repeat a fully observed empty search')
  assert.ok((await f.turn(2)).includes(13), 'the other team still has its own independent search')
  // The original scout stays within sight, and sees an actual dropped item on the patch.
  const scout = f.bodies[0]
  scout.entities[60] = { id: 60, name: 'item', height: .25, width: .25, position: new Vec3(13.5, 64.2, .5), getDroppedItem: () => ({ name: 'diamond_sword', count: 1 }) }
  scout.step = () => { delete scout.entities[60] }
  await f.turn(0)
  assert.ok((await f.turn(1)).includes(13), 'fresh visible physical loot is shared even without a second death')
  await f.poll(); f.death(0, 13); await f.poll()
  f.bodies[1].entity.position = new Vec3(1.5, 64, .5); await f.poll()
  assert.ok((await f.turn(1)).includes(13), 'a later death at the same cell starts a new search')
})

test('a physical inventory pickup followed by a clear floor closes the spot for teammates', async t => {
  const f = survey(t), scout = f.bodies[0]
  await f.poll(); f.death(0, 13); await f.poll()
  scout.entities[60] = { id: 60, name: 'item', height: .25, width: .25, position: new Vec3(13, 64.1, .5),
    getDroppedItem: () => ({ name: 'iron_sword', count: 1 }) }
  scout.step = () => {
    if (!scout.entities[60]) return
    delete scout.entities[60]; scout.inventory.slots[9] = { name: 'iron_sword', count: 1, slot: 9 }
  }
  assert.ok((await f.turn(0)).includes(13))
  assert.equal(scout.inventory.slots[9]?.name, 'iron_sword')
  assert.ok(!(await f.turn(1)).includes(13))
})

for (const changed of [false, true]) test('an ally at the dropped sword can collect before the distant scout arrives; changed action ' + changed, async t => {
  const f = survey(t), [scout, runner] = f.bodies
  runner.entity.position = new Vec3(13, 64, .5)
  await f.poll(); f.death(0, 13); await f.poll()
  let arrive
  scout.approach = () => new Promise(resolve => { delete scout.approach; arrive = resolve })
  const walking = f.turn(0)
  try {
    await tick(); assert.ok(arrive, 'the first scout holds the approach')
    if (changed) Object.assign(f.bots[0], { last: { m: 'flee', pending: true } })
    runner.entities[60] = { id: 60, name: 'item', height: .25, width: .25, position: new Vec3(13, 64.1, .5),
      getDroppedItem: () => ({ name: 'iron_sword', count: 1 }) }
    runner.step = () => {
      delete runner.entities[60]
      runner.inventory.slots[9] = { name: 'iron_sword', count: 1, slot: 9 }
    }
    await f.turn(1)
    assert.equal(runner.inventory.slots[9]?.name, 'iron_sword', 'the on-site ally need not wait for a remote approach')
    assert.equal(f.calls.filter(c => c.name === 'Scout' && c.method === 'stop').length, changed ? 0 : 1)
  } finally { arrive?.({ status: 'done', detail: { arrived: p(13) } }); await walking }
  assert.equal(f.visits.filter(v => v.name === 'Scout').length, 0, 'a late walk cannot reopen a confirmed clear floor')
})

for (const situation of ['visible helmet', 'hidden helmet', 'closer to scout', 'nearer identical stack', 'already equipped', 'new arrow threat'] as const) test('a teammate intercepts useful visible gear during a nearby unfinished approach: ' + situation, async t => {
  const f = survey(t), [scout, runner] = f.bodies
  const floor: [number, number, number, string][] = []
  for (let x = 7; x <= 20; x++) for (let z = -4; z <= 4; z++) floor.push([x, 63, z, 'stone'])
  if (situation === 'hidden helmet') for (const y of [64, 65, 66]) floor.push([14, y, 0, 'stone'])
  const { bot, world } = worldOf(floor)
  Object.assign(runner, { blockAt: bot.blockAt, registry: bot.registry, physics: bot.physics, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 })
  Object.assign(runner.entity, bot.entity)
  drive(runner, world)
  scout.entity.position.set(9.5, 64, .5); runner.entity.position.set(13, 64, .5)
  if (situation === 'already equipped') f.kits.set('Runner', { netherite_helmet: 1 })
  await f.poll(); f.death(0, 13); await f.poll()
  let arrive
  scout.approach = () => new Promise(resolve => { delete scout.approach; arrive = resolve })
  const walk = f.turn(0)
  try {
    await tick(); assert.ok(arrive)
    const item = new Vec3(situation === 'closer to scout' ? 10.5 : 15.3, 64.05, .5)
    let reads = 0
    runner.entities[60] = { id: 60, name: 'item', width: .25, height: .25, position: item,
      getDroppedItem() { reads++; return { name: 'netherite_helmet', count: 1 } } }
    if (situation === 'nearer identical stack') runner.entities[61] = { ...runner.entities[60], id: 61, position: new Vec3(11.1, 64, .5) }
    if (situation === 'visible helmet') runner.entities[61] = { ...runner.entities[60], id: 61, position: new Vec3(13.5, 64, .5),
      getDroppedItem: () => ({ name: 'cobblestone', count: 1 }) }
    if (situation === 'new arrow threat') {
      const rpc = f.bots[1].c.call.bind(f.bots[1].c)
      f.bots[1].c.call = async (method, params) => {
        const r = await rpc(method, params)
        if (method === 'items_near') Object.assign(f.bots[1], { arrowThreat: { at: Date.now(), active: true } })
        return r
      }
    }
    assert.equal(inPickup(runner.entity.position, item), false, 'the helmet cannot enter the inventory without a step')
    runner.on('physicsTick', () => {
      if (!runner.entities[60] || !inPickup(runner.entity.position, item)) return
      delete runner.entities[60]; runner.inventory.slots[9] = { slot: 9, name: 'netherite_helmet', count: 1 }
    })
    await f.turn(1)
    const requests = f.calls.filter(c => c.name === 'Runner' && c.method === 'assist')
    if (situation === 'visible helmet') {
      assert.equal(runner.inventory.slots[9]?.name, 'netherite_helmet')
      assert.equal(requests[0]?.params.item, 'netherite_helmet')
      assert.ok(runner.entity.position.x > 13.5)
    } else {
      assert.deepEqual(requests, []); assert.equal(runner.inventory.slots[9], null)
      if (situation === 'hidden helmet') assert.equal(reads, 0)
    }
    assert.equal(f.calls.filter(c => c.method === 'stop').length, 0, 'one stack does not prove the rest of the site is clear')
  } finally { arrive?.({ status: 'timeout' }); await walk }
})

test('a scout arriving during its teammate’s pickup waits, then collects if that teammate is full', async t => {
  const f = survey(t), [scout, runner] = f.bodies
  runner.entity.position = new Vec3(13, 64, .5)
  await f.poll(); f.death(0, 13); await f.poll()
  for (const body of [scout, runner]) body.entities[60] = { id: 60, name: 'item', height: .25, width: .25,
    position: new Vec3(13, 64.1, .5), getDroppedItem: () => ({ name: 'iron_sword', count: 1 }) }
  for (let slot = 9; slot < 45; slot++) runner.inventory.slots[slot] = { name: 'shield', count: 1, slot }
  scout.step = () => {
    delete scout.entities[60]; delete runner.entities[60]
    scout.inventory.slots[9] = { name: 'iron_sword', count: 1, slot: 9 }
  }
  let arrive, finishPickup
  scout.approach = () => new Promise(resolve => { delete scout.approach; arrive = resolve })
  runner.pickupPending = new Promise<void>(resolve => { finishPickup = resolve })
  const walking = f.turn(0)
  await tick()
  const collecting = f.turn(1)
  try {
    await tick(); assert.deepEqual(f.visits.map(v => v.name), ['Runner'])
    scout.entity.position = runner.entity.position.clone()
    arrive({ status: 'done', detail: { arrived: p(13) } })
    await tick()
    assert.deepEqual(f.visits.map(v => v.name), ['Runner'], 'the scout waits for the outstanding local receipt')
  } finally {
    finishPickup(); arrive?.({ status: 'done', detail: { arrived: p(13) } })
    await Promise.all([walking, collecting])
  }
  assert.equal(scout.inventory.slots[9]?.name, 'iron_sword')
  assert.equal(runner.inventory.slots[9]?.name, 'shield')
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
})

test('a late empty arrival receipt cannot silence a new death in the same cell during that inspection', async t => {
  const f = survey(t), scout = f.bodies[0]
  await f.poll(); f.death(0, 13); await f.poll()
  scout.afterPickup = r => {
    if (!r.inspected) return
    delete scout.afterPickup
    f.ctx.swarmDriver.observeDeaths(f.bots[1], [{ position: p(13), ageMs: 0 }], Date.now())
    scout.unloaded = true
  }
  await f.turn(0)
  assert.equal(scout.afterPickup, undefined)
  assert.ok((await f.turn(1)).includes(13))
})

for (const reason of ['corner', 'unloaded', 'shortApproach', 'full', 'unknown item']) test(`an unconfirmed ${reason} inspection keeps the site available to another teammate`, async t => {
  const f = survey(t)
  await f.poll(); f.death(0, 13); await f.poll()
  const scout = f.bodies[0]; scout[reason] = true
  if (reason === 'full' || reason === 'unknown item') {
    scout.entities[60] = { id: 60, name: 'item', height: .25, width: .25, position: new Vec3(13.1, 64.1, .5),
      getDroppedItem: () => reason === 'full' ? { name: 'cobblestone', count: 1 } : null }
    for (let slot = 9; slot < 45; slot++) scout.inventory.slots[slot] = { name: 'shield', count: 1, slot }
  }
  assert.ok((await f.turn(0)).includes(13))
  assert.ok((await f.turn(1)).includes(13))
})

function team1Pile(t) {
  const f = survey(t, { x: 602, y: 120, z: 598.5 }), cells = new Map<string, string>()
  for (const [x, y, z, name] of colosseumArms('team1').field) cells.set([600 + x, 120 + y, 600 + z].join(','), name)
  assert.equal(cells.get('593,119,595'), 'lava')
  assert.equal(cells.get('593,120,593'), 'sand')
  for (const b of f.bodies) b.blockAt = p => {
    const at = p.floored(), name = cells.get([at.x, at.y, at.z].join(',')) || (at.y < 120 ? 'sand' : 'air')
    const full = name !== 'air' && name !== 'lava'
    return { position: at, name, boundingBox: full ? 'block' : 'empty', shapes: full ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  return f
}

test('the original team1 layout around 593,120,597 leaves a lava pocket and slope outside a provably clear patch', async t => {
  const f = team1Pile(t), scout = f.bodies[0]
  scout.entity.position = new Vec3(593.5, 120, 597.5)
  const r = await assist({ require: () => scout }, { mode: 'pickup', surveySite: scout.entity.position, maxD: 6 })
  assert.equal(r.ok, false); assert.ok(!('inspected' in r))
})

test('team1 at 593,120,597: allies inspect distinct safe viewpoints, then leave the hidden slope alone until fresh evidence', async t => {
  const f = team1Pile(t), site = new Vec3(593.5, 120, 597.5), firstDeath = Date.now()
  await f.poll(); f.death(0, site.x, site.y, site.z); f.death(2, site.x, site.y, site.z); await f.poll()
  await f.turn(0)
  assert.ok(f.visits.some(v => v.name === 'Scout' && v.from.equals(site)))
  f.visits.length = 0
  await f.turn(1)
  assert.ok(f.visits.some(v => v.name === 'Runner' && v.from.distanceTo(site) >= 1.3), 'the second scout gets a physically different viewpoint')
  assert.ok(f.visits.every(v => !['lava', 'magma_block'].includes(f.bodies[1].blockAt(v.from.offset(0, -1, 0)).name)))
  assert.ok(f.ctx.swarmDriver.knownDrops(f.bots[1]).every(d => d.inspectedAt === undefined), 'the hidden side remains unknown')
  await f.turn(2)
  assert.ok(f.visits.some(v => v.name === 'Other' && v.from.equals(site)), 'the other team has its own first look')
  for (let n = 0; n < 6; n++) { await f.poll(); await f.turn(n % 2) }
  const looks = [site, ...f.visits.filter(v => v.name !== 'Other').map(v => v.from)]
  assert.ok(looks.length >= 2 && looks.length <= 5)
  for (let i = 0; i < looks.length; i++) assert.ok(looks.slice(i + 1).every(next => next.distanceTo(looks[i]) >= 1.3))
  t.diagnostic(`team1: ${looks.length} distinct blue viewpoints: ${looks.map(v => v.toString()).join(' ')}`)
  f.visits.length = 0
  f.ctx.swarmDriver.observeDeaths(f.bots[0], [{ position: site, ageMs: Date.now() - firstDeath }], Date.now())
  await f.turn(1)
  assert.equal(f.visits.length, 0, 'a bounded set of known viewpoints cannot send allies around indefinitely')
  f.death(0, site.x, site.y, site.z); await f.poll()
  await f.turn(1)
  assert.ok(f.visits.some(v => v.name === 'Runner'), 'a new actual death at the very same cell restarts the investigation')
})

test('a newly visible item on partially hidden team1 ground can be collected from a previously checked side', async t => {
  const f = team1Pile(t), site = new Vec3(593.5, 120, 597.5), scout = f.bodies[0]
  await f.poll(); f.death(0, site.x, site.y, site.z); await f.poll(); await f.turn(0); await f.poll()
  scout.entities[70] = { id: 70, name: 'item', height: .25, width: .25, position: site.offset(.1, .1, 0),
    getDroppedItem: () => ({ name: 'diamond_sword', count: 1 }) }
  scout.step = () => {
    if (!scout.entities[70]) return
    delete scout.entities[70]; scout.inventory.slots[9] = { name: 'diamond_sword', count: 1, slot: 9 }
  }
  f.visits.length = 0
  await f.turn(0)
  assert.ok(f.visits.some(v => v.name === 'Scout' && v.from.equals(site)))
  assert.equal(scout.inventory.slots[9]?.name, 'diamond_sword')
})

for (const change of ['magma_block', 'air', 'wall']) test(`a teammate around a corner keeps a hidden viewpoint but withdraws a stance visibly changed by ${change}`, async t => {
  const f = survey(t), site = new Vec3(13.5, 64, .5), north = site.offset(0, 0, -2), south = site.offset(0, 0, 2)
  let changed = false
  const received = []
  for (const bot of f.bodies) {
    const read = bot.blockAt
    bot.blockAt = p => {
      const at = p.floored(), corner = at.x === 12 && at.z === -1 && at.y >= 64 && at.y <= 66
      if (at.x === 13 && at.y === 63 && at.z === 1) return { position: at, name: 'air', shapes: [], boundingBox: 'empty' }
      if (changed && at.x === 13 && at.z === 2) {
        if (change !== 'wall' && at.y === 63) return { position: at, name: change,
          shapes: change === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], boundingBox: change === 'air' ? 'empty' : 'block' }
        if (change === 'wall' && at.y >= 64 && at.y <= 66) return { position: at, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
      }
      return corner ? { position: at, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' } : read(at)
    }
    bot.afterPickup = r => { if (r.partial) received.push(r.partial) }
  }
  await f.poll(); f.death(0, site.x, site.y, site.z); await f.poll(); await f.turn(0)
  const includes = (options, v) => options.some(p => v.distanceTo(p) < .01)
  assert.ok(includes(received[0].options, north) && includes(received[0].options, south), 'both supports start in plain view at the original site')
  changed = true; await f.poll(); await f.turn(1)
  assert.ok(site.offset(-2, 0, 0).distanceTo(received[1].from) < .01)
  assert.ok(!includes(received[1].options, north) && !includes(received[1].options, south), 'the west scout cannot propose either support from its current view')
  assert.ok(!includes(received[1].ruledOut, north) && includes(received[1].ruledOut, south), 'only the southern stance is visibly unsafe')
  const views = f.ctx.swarmDriver.knownDrops(f.bots[0])[0].views
  assert.ok(includes(views.options, north), 'the first scout actually saw the safe north support before the west scout lost sight of it')
  assert.ok(!includes(views.options, south), 'the west scout can directly see the new danger to the south')
  f.bodies[0].entity.position = north.offset(0, 0, -2); await f.poll(); await f.turn(0)
  assert.ok(f.visits.some(v => v.name === 'Scout' && v.from.equals(north)), 'the remembered direction still drives a real search choice')
})

test('a dying body can radio its own location, and a private solo observation has no teammates', async t => {
  const f = scene(t, true)
  await f.poll()
  f.bodies[0].entity.position = new Vec3(11, 64, .5); f.bodies[0]._client.emit('update_health', { health: 0 })
  f.bodies[0].entity.position = new Vec3(.5, 64, .5); await f.poll()
  assert.ok(!(await f.turn(1)).includes(11))
  f.bodies[0]._client.emit('update_health', { health: 20 }); await f.poll()
  assert.ok((await f.turn(0)).includes(11))
})

test('an unseen death on the referee map does not change whether a visible human is credited with a gift', async t => {
  const f = scene(t)
  await f.poll()
  f.ctx.deathAt.Ghost = { at: Date.now(), p: p(1.5), team: null }
  f.bodies[1].giver = true; f.kits.set('Runner', { diamond_sword: 1 }); await f.poll()
  assert.equal(f.gifts.length, 1)
  f.bodies[0].entity.position = new Vec3(2, 64, .5); f.bodies[0]._client.emit('update_health', { health: 0 })
  await f.poll(); f.kits.set('Runner', { diamond_sword: 1, diamond_boots: 1 }); await f.poll()
  assert.equal(f.gifts.length, 1, 'a known pile near the recipient explains the new gear')
  assert.ok((await f.turn(1)).every(x => x !== 21))
})

for (const ledgerFirst of [true, false]) test(`own death still reaches an allied looter when the referee records it ${ledgerFirst ? 'before' : 'after'} the client report`, async t => {
  const f = scene(t)
  await f.poll()
  const scout = f.bodies[0]
  const eliminate = () => { f.ctx.out.add('Scout'); f.ctx.deadNow.add('Scout'); f.ctx.swarmDriver.publicDeath('Scout', null) }
  if (ledgerFirst) eliminate()
  scout.entity.position = new Vec3(17, 64, .5); scout._client.emit('update_health', { health: 0 }); scout.game.gameMode = 'spectator'
  scout.noPose = true; f.death(0, 23)
  await f.poll()
  if (!ledgerFirst) eliminate()
  assert.ok((await f.turn(1)).includes(17))
  assert.deepEqual(f.ctx.swarmDriver.knownDrops(f.bots[1]).map(d => d.p.x), [17], 'a spectator cannot scout another death')
  assert.deepEqual(f.ctx.swarmDriver.knownDrops(f.bots[2]), [])
})
