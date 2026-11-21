import test from 'node:test'
import assert from 'node:assert/strict'
import { flankSpots, swarmWind } from './swarm/swarm-driver/wind'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { Session } from '../daemon/src/session'
import { block, data, install, testBot, testClock } from '../daemon/test/tick-plugins-fixture'
import { stateSummary } from '../daemon/src/perception'
import { commandOwnsMovement, swarmCommand } from './swarm/swarm-driver/command'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

test('wind flank: shooters under or outside an airborne foe move to the centre side at a shallow angle', () => {
  const arena = { x: 0, z: 0, r: 30 }
  const foe = { x: 10, y: 6, z: 0 } // 6 бл. над полом, к востоку от центра
  const f = flankSpots(foe, arena, 0, [{ x: 10, y: 0, z: 1 }])
  assert.ok(f.bad({ x: 10.5, y: 0, z: 0.5 }), 'прямо под ним — плохой угол')
  assert.ok(f.bad({ x: 16, y: 0, z: 0 }), 'снаружи — толкнёт внутрь')
  assert.ok(!f.bad({ x: 0, y: 0, z: 0 }), 'со стороны центра, далеко — годится')
  assert.ok(!f.bad({ x: 6, y: 6, z: 0 }), 'already level with the foe on the inside side')
  for (const s of f.spots) { assert.ok(s.x < foe.x - 8, 'на сторону центра, дальше 1.5 высоты'); assert.ok(!f.bad(s)) }
  // У края места снаружи нет — точки остаются внутри арены.
  const g = flankSpots({ x: 27, y: 1, z: 27 }, arena, 0, [])
  for (const s of g.spots) assert.ok(Math.max(Math.abs(s.x), Math.abs(s.z)) <= 28)
})

test('the central ground flank and wing use the same outward axis', () => {
  const arena = { x: 600.5, z: 600.5, r: 77, ellipse: { a: 77, b: 65 } }
  const target = { x: 600.6, y: 126, z: 600.7 }
  const f = flankSpots(target, arena, 120, [{ x: 613, y: 120, z: 602 }])
  assert.deepEqual(f.out, { x: 0, z: 1 })
  assert.ok(f.spots.every(p => p.z < target.z))
})

function upperReserve() {
  const calls: any[] = [], at = { x: 550.5000915862471, y: 153, z: 554.5 }
  const guard: any = { name: 'NeuroFarm31r', team: 'red', last: { m: 'swarm_hold', pending: true },
    swarmTask: { kind: 'goto', position: at, data: { reserve: true, sentry: true } } }
  const helper: any = { name: 'ground', team: 'red', swarmTask: { kind: 'goto',
    position: { x: 574, y: 120, z: 578 }, data: { reserve: true, sentry: true } } }
  const bots = [guard, helper], pos = Object.fromEntries(bots.map(b => [b.name,
    { p: b === guard ? at : helper.swarmTask.position, hp: 20, inv: { wind_charge: 8 } }]))
  for (const b of bots) b.c = { call: async (method, params) => { calls.push({ actor: b.name, method, params }); return { status: 'done' } } }
  const sw: any = { bots, pos, generation: 1, now: () => 100000, alive: () => true, teamOf: b => b.team,
    hostile: (_b, id) => id === 'NeuroFarm31m', panic: () => false, log() {}, planned: new Map(),
    arms: true, hideouts: [], chestTops: [{ x: 551.5, y: 153, z: 554.5, tier: 5 }],
    arena: { x: 600.5, y: 120, z: 600.5, r: 80, ellipse: { a: 77, b: 65 } },
    go: (b, p) => b.c.call('goto', p) }
  const seen = [{ id: 'NeuroFarm31m', visible: true, position: { x: 570.3000000119209, y: 123.16609373688698, z: 575.3317489442733 }, velocity: { y: .23321874737739562 } }]
  return { guard, helper, calls, sw, seen, api: swarmWind(sw) }
}

test('a flanker under a terrace opening takes the side stairs instead of reporting arrival on the lower floor', async () => {
  const clock = testClock(), body = install(clock, { pathfinder: true, digging: true })
  const from = body.entity.position.clone().set(5.5, 64, .5), foe = from.offset(5, 4, 0)
  const heights = new Map([['2,0', 65], ['1,0', 66], ['1,1', 67]])
  for (let x = 1; x <= 10; x++) heights.set(x + ',2', 68)
  heights.set('10,1', 68); heights.set('10,0', 68)
  body.blockAt = p => {
    const q = p.floored(), top = heights.get(q.x + ',' + q.z) ?? 64
    return block(q.x >= -3 && q.x <= 14 && q.z >= -3 && q.z <= 5 && q.y < top ? 'bedrock' : 'air', q)
  }
  body.entity.position = from.clone(); body.entity.onGround = true
  body.entity.metadata = []; body.health = body.food = 20; body.game.dimension = 'overworld'
  const session: any = Object.assign(Object.create(Session.prototype), {
    bot: body, mcData: data, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_name, worker) => {
      const ctl = session.ctl = { aborted: false, onAbort: [], abort() {
        if (this.aborted) return
        this.aborted = true; for (const fn of [...this.onAbort]) fn()
      } }
      try { return await worker(ctl) } finally { ctl.abort() }
    }
  })
  session.updateMovements(true)
  const { sw, helper, seen } = upperReserve()
  sw.arena = { x: .5, y: 64, z: .5, r: 20, killY: 60 }
  sw.pos[helper.name].p = from.clone(); sw.bots = [helper]
  seen[0].position = foe; seen[0].velocity.y = 0
  let result, error, walks = 0, mostWest = from.x
  helper.c.call = async (method, params) => {
    assert.equal(method, 'goto'); walks++
    assert.equal(Math.floor(params.x), 5)
    try { result = await session.goto(params); return { status: 'done', detail: result } }
    catch (err) { error = err; return { status: 'failed' } }
  }
  try {
    swarmWind(sw).windFlank(helper, seen)
    assert.equal(walks, 1)
    for (let i = 0; i < 320 && !result && !error; i++) {
      await clock.advanceGame(50)
      mostWest = Math.min(mostWest, body.entity.position.x)
    }
    assert.ifError(error); assert.ok(result?.arrived, JSON.stringify(result))
    assert.equal(body.entity.position.y, 68, 'the lower floor in the assigned column cannot count as a flanking position')
    assert.ok(mostWest < 3, 'the flanker initially walks away from its post to reach the side stairs')
    assert.equal(body.packets.filter(p => p.name === 'block_dig' || p.name === 'block_place').length, 0)
  } finally { session.ctl?.abort(); body.emit('end') }
})

for (const status of ['timeout', 'done']) test('a stationary terrace walker tries another flank after its centre route stops with ' + status, async () => {
  const { sw, guard, helper, seen } = upperReserve()
  Object.assign(sw, swarmRetry(sw))
  const logs: string[] = []
  sw.log = line => logs.push(line)
  let time = 100000
  sw.now = () => time
  const api = swarmWind(sw), calls = [], spots = flankSpots(seen[0].position, sw.arena, seen[0].position.y, []).spots
  const from = { ...spots[0], x: Math.floor(spots[0].x) + 8.8, y: 120 }
  sw.pos[helper.name].p = from
  let finish
  helper.c.call = (method, params) => {
    calls.push(params)
    const action = helper.last = { m: method, pending: true }
    return new Promise(resolve => { finish = r => { action.pending = false; resolve(r) } })
  }
  api.windFlank(guard, seen)
  assert.equal(calls[0].x, spots[0].x)
  time += 11000
  const body = testBot()
  body.players = {}
  body.entity.position.set(from.x, from.y, from.z)
  const receipt = stateSummary(body)
  assert.equal(receipt.pos.x, Math.floor(from.x))
  finish({ status, detail: status === 'done' ? { stopped: 'время вышло', at: receipt.pos } : {}, state: receipt })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(logs.some(line => line.endsWith('пешком — ' + (status === 'done' ? 'время вышло' : status))))
  api.windFlank(guard, seen)
  assert.equal(calls.length, 2, 'the other observed flank is immediately available')
  assert.ok(spots.slice(1).some(p => p.x === calls[1].x && p.z === calls[1].z))
  finish({ status: 'done' }); await new Promise(resolve => setImmediate(resolve))
})

for (const change of ['building material', 'slab height']) test('changing the visible enemy cannot replay an exhausted terrace walk until a route changes: ' + change, async () => {
  const { sw, helper, seen } = upperReserve(), attempts = []
  let time = 100000
  sw.now = () => time; sw.hostile = () => true
  Object.assign(sw, swarmRetry(sw))
  sw.bots = [helper]; sw.arena = { x: .5, y: 64, z: .5, r: 32, killY: 60 }
  sw.pos[helper.name].p = { x: .5, y: 64, z: .5 }
  const body = testBot(); body.players = {}; body.entity.position.set(.5, 64, .5)
  const cell = p => [Math.floor(p.x), p.y, Math.floor(p.z)].join(',')
  helper.c.call = (method, p) => {
    assert.equal(method, 'goto'); assert.equal(p.exactY, true); assert.equal(p.climb, true)
    attempts.push(cell(p))
    helper.last = { m: method, pending: false }
    time += Math.max(5, p.timeoutSeconds) * 1000
    return Promise.resolve({ status: 'timeout', state: stateSummary(body) })
  }
  const api = swarmWind(sw)
  for (const [i, rival] of ['A', 'B', 'C', 'D'].entries()) {
    // Each torso is visible and their distinct sub-block positions still resolve to the same three goto columns.
    api.windFlank(helper, [{ ...seen[0], id: rival, visible: true, position: { x: 15.52 + i * .1, y: 68, z: .5 } }])
    await new Promise(resolve => setImmediate(resolve))
    time += 50
  }
  assert.equal(attempts.length, 3, 'all three distinct posts get one attempt, then the actor is released')
  assert.equal(new Set(attempts).size, 3)
  assert.equal(helper.swarmReserved, undefined)
  const height = change === 'slab height' ? 68.5 : 68
  if (change === 'building material') sw.pos[helper.name].inv.cobblestone = 8
  const next = { x: 15.52, y: height, z: .5 }
  api.windFlank(helper, [{ ...seen[0], id: 'E', position: next }])
  assert.equal(attempts.length, 4, 'the new route is immediately available')
  assert.equal(attempts.at(-1), cell(flankSpots(next, sw.arena, height, []).spots[0]))
  await new Promise(resolve => setImmediate(resolve))
})

for (const side of ['same posts', 'slab terrace', 'different terrace']) test('simultaneous terrace approaches against different opponents: ' + side, async () => {
  const { sw, helper, seen } = upperReserve(), calls = [], pending = []
  const other = { ...helper, name: 'Other' }
  sw.bots = [helper, other]; sw.hostile = () => true
  sw.arena = { x: .5, y: 64, z: .5, r: 40, killY: 60 }
  sw.pos[helper.name].p = { x: .5, y: 64, z: .5 }
  sw.pos.Other = { p: { ...sw.pos[helper.name].p }, hp: 20, inv: {} }
  for (const b of sw.bots) b.c = { call(method, p) {
    const action = b.last = { m: method, pending: true }
    calls.push({ name: b.name, p })
    return new Promise(resolve => pending.push(() => { action.pending = false; resolve({ status: 'done' }) }))
  } }
  const api = swarmWind(sw)
  try {
    api.windFlank(helper, [{ ...seen[0], id: 'A', position: { x: 15.52, y: 68, z: .5 } }])
    sw.pos.Other.inv.wind_charge = 8
    const foe = { x: 15.62, y: side === 'slab terrace' ? 68.5 : side === 'same posts' ? 68 : 73, z: .5 }
    api.windFlank(helper, [{ ...seen[0], id: 'B', position: foe }])
    assert.deepEqual(calls.map(c => c.name), [helper.name, other.name])
    const centre = flankSpots(foe, sw.arena, foe.y, []).spots[0]
    assert.equal(calls[1].p.z === centre.z, side !== 'same posts')
  } finally { pending.forEach(done => done()); await new Promise(resolve => setImmediate(resolve)) }
})

for (const owner of ['walking', 'replaced', 'new round'] as const) test(`the second terrace flanker checks the first post's current owner: ${owner}`, async () => {
  const { sw, guard, helper, seen } = upperReserve(), calls = [], pending = []
  const second = { ...helper, name: 'second' }; sw.bots.push(second)
  sw.pos.second = { ...sw.pos[helper.name], inv: {} }
  let time = 100000; sw.now = () => time
  for (const o of [helper, second]) o.c = { call(method, params) {
    calls.push({ name: o.name, params })
    const action = o.last = { m: method, pending: true }
    return new Promise(resolve => pending.push(() => { action.pending = false; resolve({ status: 'done' }) }))
  } }
  const api = swarmWind(sw)
  try {
    api.windFlank(guard, seen)
    assert.equal(calls[0]?.name, helper.name)
    sw.pos[helper.name].p = { ...sw.pos[helper.name].p, y: 121.5 }
    if (owner === 'replaced') helper.last = { m: 'swarm_hold', pending: true }
    if (owner === 'new round') sw.generation++
    sw.pos.second.inv.wind_charge = 8; time += 3000; api.windFlank(guard, seen)
    assert.equal(calls[1]?.name, second.name)
    const separation = Math.hypot(calls[0].params.x - calls[1].params.x, calls[0].params.z - calls[1].params.z)
    assert.equal(separation > 2, owner === 'walking', 'only the still-running approach in this round owns its post')
  } finally { pending.forEach(done => done()); await new Promise(resolve => setImmediate(resolve)) }
})

for (const change of ['none', 'walked', 'built a block', 'target moved', 'different foe', 'helper moved', 'new round', 'interrupted', 'new wings', 'another walk budget'] as const) {
  test(`terrace walk after a timeout with ${change}`, async () => {
    const { sw, guard, helper, seen } = upperReserve()
    Object.assign(sw, swarmRetry(sw))
    sw.hostile = () => true
    let time = 100000
    sw.now = () => time
    const api = swarmWind(sw), calls = []
    sw.pos[helper.name].p = { x: 600, y: 120, z: 590 }
    sw.pos[helper.name].inv.sandstone = 10
    const from = { ...sw.pos[helper.name].p }
    let finish
    helper.c.call = (method, params) => {
      calls.push({ method, params })
      const action = helper.last = { m: method, pending: true }
      return new Promise(resolve => { finish = reply => { action.pending = false; resolve(reply) } })
    }
    api.windFlank(guard, seen)
    assert.equal(calls[0]?.method, 'goto')
    time += 16000
    if (change === 'new round') { sw.generation++; sw.retries.clear(); delete helper.swarmReserved }
    // The body can finish a useful detour between position polls, even moving away from the waypoint.
    finish({ status: change === 'interrupted' ? 'interrupted' : 'timeout',
      state: { pos: change === 'walked' ? { ...from, z: from.z + 4 } : from,
        inventory: { sandstone: change === 'built a block' ? 9 : 10 } } })
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(!helper.swarmReserved)
    if (change === 'target moved') seen[0].position.x += 4
    if (change === 'different foe') seen[0].id = 'other'
    if (change === 'helper moved') sw.pos[helper.name].p.z += 4
    if (change === 'new wings') Object.assign(sw.pos[helper.name].inv, { elytra: 1, firework_rocket: 8 })
    if (change === 'another walk budget') time += calls[0].params.timeoutSeconds * 1000
    api.windFlank(guard, seen)
    assert.equal(calls.length, 2)
    if (change === 'none') assert.notEqual(calls[1].params.x, calls[0].params.x, 'only the previous approach is exhausted')
    if (change === 'walked' || change === 'built a block' || change === 'another walk budget') assert.equal(calls[1].params.x, calls[0].params.x)
    if (change === 'new wings') assert.equal(calls[1].method, 'fly_to')
    if (calls.length === 2) { finish({ status: 'done' }); await new Promise(resolve => setImmediate(resolve)) }
  })
}

for (const fresh of [false, true]) test(`wind flank preserves ${fresh ? 'fresh planned' : 'running'} achieved upper reserve and uses a ground reserve`, () => {
  const f = upperReserve()
  if (fresh) {
    f.sw.planned.set('red', new Map([[f.guard.name, f.guard.swarmTask]]))
    f.guard.swarmTask = { kind: 'loot', data: {} }
  }
  f.api.windFlank(f.guard, f.seen)
  assert.equal(f.calls.filter(c => c.actor === f.guard.name).length, 0, 'K: optional flank must not cancel the upper hold with a 30-block descent')
  assert.ok(f.calls.some(c => c.actor === f.helper.name && c.method === 'goto'), 'an ordinary ground reserve still supplies the flank')
})

test('wind flank may use an upper actor whose reserve post has not been reached', () => {
  const f = upperReserve()
  f.guard.swarmTask.position = { ...f.guard.swarmTask.position, x: 560.5 }
  f.api.windFlank(f.guard, f.seen)
  assert.ok(f.calls.some(c => c.actor === f.guard.name && c.method === 'goto'))
})

test('O/K: optional flank preserves the live explicit upper goto and uses an uncommanded actor', () => {
  const f = upperReserve()
  f.guard.name = 'NeuroFarm31k'
  f.guard.team = f.helper.team = 'blue'
  f.guard.swarmTask = null
  f.guard.last = { m: 'goto', pending: true }
  f.sw.pos[f.guard.name] = { p: { x: 605.4736659819158, y: 120, z: 622.5491227873246 }, hp: 20, inv: { wind_charge: 8 } }
  f.sw.pos[f.helper.name].p = { x: 580, y: 120, z: 573 }
  const order = { id: 'native-post-1794573927330', do: 'goto', at: [621.5, 150.5, 546.5] }
  f.sw.commandOwnsMovement = b => b === f.guard && order.do !== 'auto'
  const seen = [{ id: 'NeuroFarm31m', visible: true, position: { x: 590, y: 124, z: 570 }, velocity: { y: 0 } }]
  f.api.windFlank(f.guard, seen)
  assert.equal(f.calls.filter(c => c.actor === f.guard.name).length, 0, 'the commander goto must not be cancelled by an unsolicited flank goto')
  assert.ok(f.calls.some(c => c.actor === f.helper.name && c.method === 'goto'))
})

test('an ended explicit movement owner does not suppress a later normal flank', () => {
  const f = upperReserve()
  f.guard.swarmTask = null
  let owned = true
  f.sw.commandOwnsMovement = b => b === f.guard && owned
  f.api.windFlank(f.guard, f.seen)
  assert.equal(f.calls.filter(c => c.actor === f.guard.name).length, 0)
  owned = false
  f.sw.now = () => 103000
  // A new API keeps the fixture clock and opportunity independent of the previous flank's cooldown.
  swarmWind(f.sw).windFlank(f.guard, f.seen)
  assert.ok(f.calls.some(c => c.actor === f.guard.name && c.method === 'goto'))
})

test('explicit command movement ownership ends with auto, removal or its completed one-shot RPC', () => {
  assert.equal(commandOwnsMovement({ do: 'goto', at: [621.5, 150.5, 546.5] }), true)
  assert.equal(commandOwnsMovement({ do: 'hold' }), true)
  assert.equal(commandOwnsMovement({ do: 'auto' }), false)
  assert.equal(commandOwnsMovement(null), false)
  assert.equal(commandOwnsMovement({ id: 'one', rpc: { m: 'goto' } }), true)
  assert.equal(commandOwnsMovement({ id: 'one', rpc: { m: 'goto' } }, 'one'), false)
  assert.equal(commandOwnsMovement({ id: 'one', rpc: { m: 'goto' } }, 'one', 'one'), true, 'commandDone is set before the RPC finishes')
  assert.equal(commandOwnsMovement({ do: 'auto' }, 'one', 'one'), false, 'auto supersedes an earlier in-flight owner')
  assert.equal(commandOwnsMovement({ id: 'one', do: 'hold', rpc: { m: 'goto' } }, 'one'), true)
})

test('a real deferred one-shot command owns movement until its own completion without releasing a newer id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-command-owner-')), file = path.join(dir, 'orders.json')
  const previous = process.env.SWARM_ORDERS, previousStatus = process.env.SWARM_STATUS
  const nativeInterval = global.setInterval, timers: ReturnType<typeof setInterval>[] = []
  let reload: () => void
  global.setInterval = ((callback, delay, ...args) => { reload = callback; const timer = nativeInterval(callback, delay, ...args); timers.push(timer); return timer }) as typeof setInterval
  const resolvers: (() => void)[] = [], actor: any = { name: 'k', team: 'blue', c: { call: (method: string) => method === 'goto' ? new Promise(resolve => resolvers.push(() => resolve({ status: 'done' }))) : Promise.resolve({ status: 'done' }) } }
  let stamp = Date.now()
  const order = (id: string) => { fs.writeFileSync(file, JSON.stringify({ bots: { k: { id, rpc: { m: 'goto' } } } })); fs.utimesSync(file, new Date(stamp += 2000), new Date(stamp)) }
  try {
    process.env.SWARM_ORDERS = file; delete process.env.SWARM_STATUS; order('old')
    const api = swarmCommand({ bots: [actor], pos: {}, alive: () => true, teamOf: b => b.team, now: () => 0, log() {} })
    const first = api.commandTurn(actor)
    assert.equal(api.commandOwnsMovement(actor), true, 'the running RPC remains owned after commandDone is set')
    order('new'); reload!()
    const second = api.commandTurn(actor)
    resolvers[0](); await first
    assert.equal(actor.commandRunning, 'new', 'an old completion cannot release the new command owner')
    assert.equal(api.commandOwnsMovement(actor), true)
    resolvers[1](); await second
    assert.equal(api.commandOwnsMovement(actor), false, 'the completed one-shot gives movement back')
  } finally {
    global.setInterval = nativeInterval; for (const timer of timers) clearInterval(timer)
    if (previous === undefined) delete process.env.SWARM_ORDERS; else process.env.SWARM_ORDERS = previous
    if (previousStatus === undefined) delete process.env.SWARM_STATUS; else process.env.SWARM_STATUS = previousStatus
    fs.unlinkSync(file); fs.rmdirSync(dir)
  }
})
