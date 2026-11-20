import test from 'node:test'
import assert from 'node:assert/strict'
import { flankSpots, swarmWind } from './swarm/swarm-driver/wind'
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
