import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { installSight } from './arena/watch'
import { swarmWind } from './swarm/swarm-driver/wind'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTeam } from './swarm/swarm-driver/team'
import { currentTurn, swarmLifecycle } from './swarm/swarm-driver/lifecycle'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { EventEmitter } from 'node:events'
const { Vec3 } = require('../daemon/node_modules/vec3')
import * as gameClock from '../daemon/src/game-clock'
import { swarmSightings } from '../daemon/src/swarm-senses'
import { wingOrbit } from '../daemon/src/combat/wing-orbit'
import * as flight from '../daemon/src/elytra/flight'
import { createLastSeen } from '../daemon/src/pvp/last-seen'
import { enemyWindFrames, enemyWindShot } from '../daemon/src/combat/enemy-wind'
import { windImpulse, windMovement, windOutward, WIND } from '../daemon/src/combat/team-wind'
import * as pick from '../daemon/src/pick'

const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(names = ['Victim', 'Helper']) {
  const calls: any[] = [], gates = new Map<string, () => void>()
  const bots = names.map(name => {
    const b: any = { name, team: 'blue', last: { m: 'goto', pending: false } }
    b.c = { call(method, params) {
      calls.push({ name, method, params })
      if (method === 'swarm_pose') return Promise.resolve({ detail: { existing: { name: 'air', solid: false } } })
      if (method === 'wind_report' && params.cancel) return Promise.resolve({ detail: { ok: true } })
      if (method === 'wind_report') return new Promise(resolve => gates.set(name + ':report', () => resolve({ detail: {
        ok: true, coordination: params.coordination, ready: true, gameTick: 100, report: { id: name, position: pos[name].p, gameTick: 100 }
      } })))
      if (method === 'enemy_wind_plan') return new Promise(resolve => gates.set('plan', () => resolve({ detail: { ok: true, plan: {
        shots: [{ thrower: 'Helper', fireTick: 110 }]
      } } })))
      return new Promise(resolve => calls[calls.length - 1].reply = detail => resolve({ status: 'done', detail }))
    } }
    return b
  })
  const [victim, helper] = bots
  const pos: any = { Victim: { p: { x: 60, y: 120, z: 0 }, inv: { wind_charge: 2 } },
    Helper: { p: { x: 66, y: 120, z: 0 }, inv: { iron_sword: 1, wind_charge: 2, mace: 1, elytra: 1, firework_rocket: 8 } } }
  const ctx: any = { i: 31, arms: false, teams: true, bots, names: bots.map(b => b.name), pos, humans: {},
    X: 0, Y: 120, Z: 0, R: 80, L: { map: 'flat' }, home: () => '0 0', hostile: () => true,
    rcon() { throw new Error('No live actions') }, round: 1, between: false, busy: new Set(), out: new Set(), deadNow: new Set(),
    alive: name => !ctx.out.has(name) && !ctx.deadNow.has(name), log() {} }
  installSight(ctx)
  installDangers(ctx)
  const sw: any = { bots, pos, generation: 1, now: () => 100000, alive: ctx.alive, log() {},
    teamOf: b => b.team, hostile: (_b, name) => name === 'Foe', panic: () => false,
    arena: { x: 0, y: 120, z: 0, r: 80 }, boardOf: () => ({ enemies: () => [] }),
    go: (b, at, range, timeoutSeconds) => b.c.call('goto', { ...at, range, timeoutSeconds }) }
  let observedAt = Date.now()
  const report = web => victim.c.onDanger({ pos: pos.Victim.p, observedAt: ++observedAt,
    dangers: { web: web ? [{ at: pos.Victim.p, cells: 1 }] : [] } })
  const seen = [{ id: 'Foe', visible: true, position: { x: 78, y: 150, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }]
  return { bots, victim, helper, pos, ctx, sw, api: swarmWind(sw), calls, gates, report, seen }
}

test('all twenty free equipped helpers are offered a native escort of a low central target with their last wind charge', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, k) => `Blue${k}`))
  for (const [k, b] of f.bots.entries()) f.pos[b.name] = { p: { x: 25 + k * 1.8, y: 120, z: 0 },
    inv: { elytra: 1, firework_rocket: 1, wind_charge: 1 } }
  const seen = [{ id: 'Foe', visible: true, airborne: true, position: { x: 0, y: 120.5, z: 0 } }]
  for (let k = 0; k < 21; k++) f.api.windWing(f.bots[0], seen)
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 20)
  assert.ok(f.bots.every(b => b.swarmReserved), 'each flight keeps its own input owner until its acknowledgement')
  for (const c of f.calls) c.reply?.({ ok: true }); await settle()
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('the first escort is closer to the centre-side release position than a bot on the far side', async () => {
  const f = fixture()
  f.pos.Victim.p = { x: 70, y: 150, z: 0 }
  f.pos.Victim.inv = { ...f.pos.Helper.inv }
  f.pos.Helper.p = { x: 58, y: 150, z: 0 }
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true, position: { x: 68, y: 150, z: 0 } }])
  const escort = f.calls.find(c => c.method === 'wing_orbit')
  assert.equal(escort?.name, 'Helper')
  escort?.reply({ ok: true }); await settle()
})

test('a foe screened by an inner terrace gets a flank on its level before it reaches the outer wall', async () => {
  const f = fixture()
  const target = { id: 'Foe', visible: false, nametag: true, airborne: false,
    position: { x: 40, y: 125, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }
  f.api.windFlank(f.victim, [target])
  const move = f.calls.find(c => c.name === 'Helper' && c.method === 'fly_to')
  assert.ok(move, 'the inner terrace needs the same level shot as an outer ledge')
  assert.equal(move.params.at.y, target.position.y)
  assert.ok(move.params.at.x < target.position.x, 'approach from the side that pushes outward')
  for (const c of f.calls) c.reply?.({ ok: true }); await settle()
})

test('all twenty free wind holders can offer a pearl pop from forty-five blocks without a team quota', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, k) => `Blue${k}`))
  for (const [k, b] of f.bots.entries()) f.pos[b.name] = { p: { x: 45, y: 120, z: k * .2 }, inv: { wind_charge: 1 } }
  const pearl = { id: 71, owner: 'Foe', at: { x: 0, y: 120, z: 0 }, eta: 80, gameTick: 15781013 }
  f.api.pearlObserve(f.bots[0], [pearl])
  const pops = f.calls.filter(c => c.method === 'pearl_pop')
  assert.equal(pops.length, 20)
  assert.ok(pops.every(c => c.params.gameTick === pearl.gameTick && c.params.eta === pearl.eta), 'each shooter receives the same original tick and remaining ETA')
  f.api.pearlObserve(f.bots[0], [pearl])
  assert.equal(f.calls.filter(c => c.method === 'pearl_pop').length, 20, 'one observed pearl still schedules each candidate once')
  for (const c of f.calls) c.reply?.({ ok: false, why: 'controlled physical arrival deadline' }); await settle()
})

test('uncapped pearl pops preserve the current defence, flee and input owner', async () => {
  for (const mode of ['shield', 'flee', 'reserved', 'lava']) {
    const f = fixture(); f.pos.Victim.inv = {}; f.pos.Helper.p = { x: 45, y: 120, z: 0 }; f.pos.Helper.inv = { wind_charge: 1 }
    if (mode === 'shield') f.helper.maceDefense = { until: 100001 }
    if (mode === 'flee') f.helper.swarmTask = { kind: 'flee' }
    if (mode === 'reserved') f.helper.swarmReserved = {}
    if (mode === 'lava') f.helper.last = { m: 'lava_escape', pending: true }
    const before = f.helper.swarmReserved
    f.api.pearlObserve(f.victim, [{ id: 72, owner: 'Foe', at: { x: 0, y: 120, z: 0 }, eta: 80 }])
    assert.equal(f.calls.some(c => c.method === 'pearl_pop'), false, mode)
    assert.equal(f.helper.swarmReserved, before)
    for (const c of f.calls) c.reply?.({ ok: true }); await settle()
  }
})

test('a wind escort preserves defence, flee and depleted physical flight resources', async () => {
  for (const state of ['defence', 'flee', 'no_wind', 'no_rocket', 'no_elytra']) {
    const f = fixture()
    f.pos.Victim.inv = {}
    if (state === 'defence') f.helper.maceDefense = { until: 100001 }
    if (state === 'flee') f.helper.swarmTask = { kind: 'flee' }
    if (state === 'no_wind') f.pos.Helper.inv.wind_charge = 0
    if (state === 'no_rocket') f.pos.Helper.inv.firework_rocket = 0
    if (state === 'no_elytra') f.pos.Helper.inv.elytra = 0
    f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
    assert.equal(f.calls.some(c => c.method === 'wing_orbit'), false, state)
  }
})

test('an escort prices the fresh team task before reserving an idle body with stale fight metadata', async () => {
  for (const task of [
    { kind: 'flee' }, { kind: 'recover' }, { kind: 'loot', data: { rearm: true } },
    { kind: 'fight', data: { target: 'Foe', shove: true } },
    { kind: 'fight', data: { target: 'Foe' } }
  ]) {
    const f = fixture(); f.pos.Victim.inv = {}; f.helper.swarmTask = { kind: 'fight', data: { target: 'Foe' } }
    f.sw.planned = new Map()
    let refreshed = 0
    f.sw.refresh = () => {
      refreshed++; assert.equal(f.helper.swarmReserved, undefined, 'the priced choice precedes the movement lease')
      f.sw.planned.set('blue', new Map([['Helper', task]]))
    }
    f.api.windWing(f.victim, [{ ...f.seen[0], airborne: false }])
    assert.equal(refreshed, 1)
    const flight = f.calls.find(c => c.method === 'wing_orbit')
    assert.equal(!!flight, task.kind === 'fight' && !task.data?.shove,
      'flee/rearm and the priced useful shove keep their body; an ordinary ground wind approach remains eligible')
    flight?.reply({ ok: true }); await settle()
  }
})

function risingRadio(t, measured = true, rise = [122.13313981829644, 123.40708088411057]) {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.bots.forEach((b, k) => { f.pos[b.name] = { p: { x: 608 + k * 4, y: 120, z: 602 }, hp: 20, food: 20,
    inv: { iron_sword: 1, elytra: 1, firework_rocket: 8, wind_charge: 8 } } })
  f.sw.arena = { x: 600.5, y: 120, z: 600.5, r: 80 }
  f.api = swarmWind(f.sw)
  Object.assign(f.sw, f.api, { boards: new Map(), telemetry: { observed: 0 }, preempt: swarmTurn(f.sw).preempt })
  Object.assign(f.sw, swarmTeam(f.sw))
  const time = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 10000 }))
  const registry = require('../daemon/node_modules/prismarine-registry')('1.21.11')
  const Block = require('../daemon/node_modules/prismarine-block')(registry), cells = new Map()
  const blockAt = p => { const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || (q.y < 120 ? 'sand' : 'air')
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b }
  const bot: any = Object.assign(new EventEmitter(), { _client: new EventEmitter(), registry, version: '1.21.11',
    health: 20, food: 20, game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] },
    entity: { id: 1, username: 'Witness', position: new Vec3(612.5, 120, 602.5), velocity: new Vec3(0, 0, 0),
      onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} }, blockAt, entities: {}, players: {} })
  const native = require('../daemon/src/tick-plugins').getPhysics()
  bot.physics = native.Physics(registry, { getBlock: blockAt })
  time.attach(bot)
  const foe: any = Object.assign(new EventEmitter(), { id: 2, username: 'Foe', type: 'player', name: 'player',
    position: new Vec3(600.5, 120, 600.5), onGround: true, height: 1.8, width: .6, metadata: [], equipment: [{ name: 'wind_charge' }], isValid: true,
    _ndObservationNow: () => time.now() })
  Object.defineProperty(foe, 'velocity', { get() { throw Error('private enemy velocity') } })
  bot.entities[2] = foe; bot.players.Foe = { entity: foe, gamemode: 0 }
  swarmSightings(bot)
  const receipt = (y, ticks, kind = 'rel_entity_move') => {
    time.advanceTicks(ticks); foe.onGround = false; foe.position.y = y
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1] || null,
      { ...foe.position, t: time.now(), grounded: false, kind }]
    foe.emit('ndPositionObserved'); bot.emit('physicsTick')
  }
  // L1 public positions after the native wind hit, separated by one native tick.
  if (measured) { receipt(rise[0], 9); receipt(rise[1], 1) }
  else receipt(123.40708088411057, 10)
  t.after(async () => {
    for (const c of f.calls) c.reply?.({ ok: true }); await settle()
    bot.emit('end'); time.dispose(); gameClock.activate(null)
    assert.equal(bot.listenerCount('physicsTick'), 0)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
    assert.equal(foe.listenerCount('ndPositionObserved'), 0)
  })
  const radio = () => JSON.parse(JSON.stringify(swarmSightings(bot)))
  return { ...f, bot, foe, cells, blockAt, time, receipt, radio }
}

test('native observed support keeps the perch arc without a foreign ground flag, then ends its completed air phase', async t => {
  const f = risingRadio(t)
  f.bot.entity.position = new Vec3(612.5, 123.5, 602.5); f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true
  f.bot.entity.type = 'player'; f.bot.entity.height = .6; f.bot.inventory.slots[6] = { name: 'elytra' }
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  f.foe.position = new Vec3(630.5, 120, 600.5); delete f.foe.onGround
  delete f.foe._ndPositionReceipts
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.goal().at.y, 122, 'actual known sand support proves the live perch without onGround')
    assert.equal(options.until(), null)
    f.foe.position.y = 128
    assert.equal(options.goal().at.y, 129.22)
    assert.equal(options.until(), null, 'observed lift with no support is an air phase')
    f.foe.position.y = 120
    assert.equal(options.until(), 'он внизу', 'known support ends the completed flight instead of restarting the perch orbit')
    return { why: options.until() }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  assert.equal((await wingOrbit({ require: () => f.bot }, { aborted: false }, { target: 'Foe', ledge: true, floorY: 120, arena: f.sw.arena })).ok, true)
})

test('recorded L rise reaches the real team radio pipeline before current height eight', async t => {
  const f = risingRadio(t), seen = f.radio()
  assert.ok(Math.abs(seen[0].velocity.y - .340708088411057) < 1e-8, 'the 500ms radio average remains unchanged')
  assert.ok(Math.abs(seen[0].peakY - 131.23160294052474) < .002, 'the separate peak uses the two fast fair receipts and native body kernel')
  assert.ok(seen[0].position.y < 125)
  f.sw.observe(f.victim, seen)
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 1, 'the real team pipeline reserves an early escort before ground flank approaches')
  assert.equal(f.sw.boardOf(f.victim).enemies()[0].peakY, undefined, 'the short-lived radio forecast never enters long-lived target memory')
})

test('recorded R low wind hop reaches the real team radio pipeline below the old eight-block apex', async t => {
  const f = risingRadio(t, true, [122.9085332501186, 123.71641623368266]), seen = f.radio()
  assert.ok(Math.abs(seen[0].peakY - 126.9514518182507) < .002, 'R1 native/public rise predicts its measured low apex')
  assert.equal(seen[0].airborne, true, 'the existing wind eligibility already recognises the low rising body')
  f.sw.observe(f.victim, seen)
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 1)
})

test('a certified rise above wing height survives an unknown apex without claiming the full apex', async t => {
  const f = risingRadio(t), read = f.blockAt
  f.bot.blockAt = p => p.y >= 132 ? null : read(p)
  const seen = f.radio()
  assert.ok(seen[0].position.y < 125)
  assert.ok(seen[0].peakY >= 128 && seen[0].peakY < 131.23, 'only the known native prefix is reported')
  f.sw.observe(f.victim, seen)
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 1, 'the actual radio consumer can escort a certified high rise')
  assert.equal(f.sw.boardOf(f.victim).enemies()[0].peakY, undefined)
})

test('an unknown cell before the useful rise and a low roof do not create an early wing', async t => {
  const f = risingRadio(t), read = f.blockAt
  for (const ceiling of [121, 122]) {
    f.bot.blockAt = p => p.y >= ceiling ? null : read(p)
    const seen = f.radio()
    assert.ok(seen[0].peakY === null || seen[0].peakY < 122.5)
    f.sw.observe(f.victim, seen)
    assert.equal(f.calls.some(c => c.method === 'wing_orbit'), false)
  }
  f.bot.blockAt = read
  f.cells.set('600,126,600', 'sandstone'); f.bot.emit('blockUpdate')
  assert.equal(f.radio()[0].peakY, null, 'a real collision remains a rejected rise')
})

test('the native body accepts the recorded early rise and keeps its until through takeoff', async t => {
  const f = risingRadio(t), calls: string[] = [], ctl = { aborted: false }
  f.bot.inventory.slots[6] = { name: 'elytra' }
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  t.mock.method(flight, 'takeoff', async (_bot, owner) => {
    assert.equal(owner, ctl); assert.ok(f.foe.position.y < 125)
    calls.push('takeoff'); f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true
    return { ok: true }
  })
  t.mock.method(flight, 'fly', async (_bot, owner, o) => {
    assert.equal(owner, ctl); calls.push('fly')
    assert.equal(o.until(), null, 'a forecast high rise must not immediately finish below the old six-block gate')
    assert.equal(o.goal().kind, 'point')
    f.receipt(124.57714315138104, 1)
    assert.equal(o.until(), null)
    f.receipt(121.25, 20)
    assert.equal(o.until(), null, 'an accepted escort continues through a low descent while the feet still have air below')
    f.cells.set('600,120,600', 'sandstone_slab'); f.bot.emit('blockUpdate')
    f.receipt(120.5, 1)
    delete f.foe.onGround; f.bot.emit('physicsTick')
    f.bot.entity.position = f.foe.position.offset(0, 3, 0) // The mocked flight has reached the visible side of the landing support.
    assert.equal(o.until(), 'он внизу', 'known slab support above the arena floor ends the escort without a foreign onGround flag')
    return { why: o.until() }
  })
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, ctl); calls.push('land'); return { ok: true } })
  const result = await wingOrbit({ require: () => f.bot }, ctl, { target: 'Foe', floorY: 120, arena: f.sw.arena })
  assert.deepEqual(calls, ['takeoff', 'fly', 'land'])
  assert.equal(result.why, 'он внизу')
})

test('the native body accepts the recorded R low wind hop below the old six/eight-block gates', async t => {
  const f = risingRadio(t, true, [122.9085332501186, 123.71641623368266]), calls: string[] = []
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  t.mock.method(flight, 'takeoff', async () => {
    calls.push('takeoff'); f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true
    return { ok: true }
  })
  t.mock.method(flight, 'fly', async (_bot, _ctl, o) => {
    calls.push('fly'); assert.equal(o.until(), null)
    return { why: 'R low-hop control' }
  })
  t.mock.method(flight, 'land', async () => { calls.push('land'); return { ok: true } })
  const result = await wingOrbit({ require: () => f.bot }, { aborted: false }, { target: 'Foe', floorY: 120, arena: f.sw.arena })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['takeoff', 'fly', 'land'])
})

test('an arena wing with only two fair rising receipts uses current public eyes until the future is known', async t => {
  const f = risingRadio(t), sight = createLastSeen(f.bot), ctl = { aborted: false }
  f.bot.once('end', () => sight.close())
  f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true; f.bot.entity._ndPoseHeight = .6
  f.bot.entity.type = 'player'; f.bot.entity.name = 'player'; f.bot.entity.height = .6
  f.bot.inventory.slots[6] = { name: 'elytra' }
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  assert.deepEqual(enemyWindFrames(f.bot, sight.observe(f.foe), f.sw.arena, [], 0, true), [], 'two receipts cannot certify native future motion')
  let landed = false
  t.mock.method(flight, 'fly', async (_bot, owner, options) => {
    assert.equal(owner, ctl); assert.equal(options.until(), null, 'uncertain future does not cancel the accepted flight owner')
    const goal = options.goal()
    assert.notEqual(typeof goal.at, 'function', 'the fallback does not manufacture a future trajectory')
    assert.equal(goal.at.y, Math.max(123, f.foe.position.y + pick.eyeHeight(f.bot, f.foe) - pick.eyeHeight(f.bot)), 'current fair eyes and the existing floor clearance bound the approach')
    assert.equal(options.rocketIf({ p: goal.at.offset(0, .1, 0), v: new Vec3(1, 0, 0) }, null, goal), false,
      'a wing above its actual fallback plane does not request an upward rocket toward foeY+1')
    return { why: 'unknown future control' }
  })
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, ctl); landed = true; return { ok: true } })
  assert.equal((await wingOrbit({ require: () => f.bot }, ctl, { target: 'Foe', floorY: 120, arena: f.sw.arena })).why, 'unknown future control')
  assert.equal(landed, true)
})

test('recorded N descent follows its future public eye plane from the common inside side', async t => {
  const f = risingRadio(t), sight = createLastSeen(f.bot)
  f.bot.once('end', () => sight.close())
  f.radio() // Production's rising radio has already started the shared visible motion tracker.
  f.receipt(131.21002717575684, 10)
  f.receipt(131.11824217438698, 2)
  assert.deepEqual(enemyWindFrames(f.bot, sight.observe(f.foe), f.sw.arena, [], 0, true), [], 'the real earlier planner call records the second pose without inventing a future')
  f.receipt(130.71931639313698, 3)
  f.bot.entity.position = new Vec3(614.1805966709109, 124.5224986293308, 599.1829043634842)
  f.bot.entity.velocity = new Vec3(-1.0304959108227818, .851255466596401, .05301401343010841)
  f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true; f.bot.entity._ndPoseHeight = .6
  f.bot.entity.type = 'player'; f.bot.entity.name = 'player'; f.bot.entity.height = .6
  f.bot._ndLaunchMovement = () => new Vec3(614.1805966709109 - 615.2110925817336,
    124.5224986293308 - 123.6712431627344, 599.1829043634842 - 599.1298903500541)
  f.bot.inventory.slots[6] = { name: 'elytra' }
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  const ctl = { aborted: false }, arena = f.sw.arena
  let checked = false, landed = false
  const native = require('../daemon/src/combat/enemy-wind'), forecast = native.enemyWindFrames
  const calls = t.mock.method(native, 'enemyWindFrames', function (...args) { return Reflect.apply(forecast, this, args) })
  t.mock.method(flight, 'fly', async (_bot, owner, options) => {
    assert.equal(owner, ctl)
    const goal = options.goal(), at = t => typeof goal.at === 'function' ? goal.at(t) : goal.at
    const point = at(0), foe = sight.observe(f.foe)!, frames = enemyWindFrames(f.bot, foe, arena, [], 0, true)
    // Compare both launch positions through the real native projectile/body and blast kernels.
    const report = { id: 'Witness', position: point, velocity: f.bot.entity.velocity.clone(), launchMovement: windMovement(f.bot), onGround: false, gliding: true, eyeHeight: .4 }
    const shot = enemyWindShot(f.bot, foe, report, frames, { height: .4 })
    assert.ok(shot, 'the proposed orbit position has a real body interception')
    const impulse = windImpulse(f.bot, shot.feet, shot.burst, { resistance: 0 })
    const pushed = enemyWindFrames(f.bot, foe, arena, [shot], 0, true)
    const axis = windOutward(arena, foe.position, foe.width)
    assert.ok(impulse.dot(axis) > 0 && Math.hypot(impulse.x, impulse.z) > Math.abs(impulse.y), 'the real body burst is outward and horizontal, rather than buying six more air ticks')
    assert.ok(pushed[shot.ticks + 1].pos.minus(frames[shot.ticks + 1].pos).dot(axis) > 0, 'the next native body movement gains actual outward progress')
    const lead = Math.ceil(8 / WIND.speed)
    const future = frames[Math.min(frames.length - 1, lead)].pos
    assert.ok(Math.abs(point.y - Math.max(123, future.y + pick.eyeHeight(f.bot, foe) - pick.eyeHeight(f.bot))) < 1e-8, 'the muzzle follows the same native future eye plane used by its lead')
    assert.ok(point.minus(future).dot(axis) < 0, 'the forecast approach remains behind the fixed shared outward axis')
    assert.ok(at(8).y < at(0).y, 'the pilot receives the descending future goal, not a frozen current height')
    assert.ok(at(18).y >= 123, 'the existing three-block floor clearance wins over an underground interception')
    const sky = require('../daemon/src/elytra'), world = { at: (_x, y) => y < 120 ? 1 : 0,
      boxHit: (_x, y) => y < 120, floorBelow: () => ({ top: 120 }) }
    for (const boost of [0, 26]) {
      const plan = sky.choose(world, { p: f.bot.entity.position, v: f.bot.entity.velocity, boost, fd: 0 }, { ...goal, arena })
      assert.ok(plan, 'the existing pilot accepts the forecast goal')
      assert.ok(!['floor', 'wall', 'outside'].includes(plan.r.kind), 'the inside approach preserves collision and arena safety')
    }
    assert.equal(options.rocketIf({ p: point.offset(0, .1, 0), v: new Vec3(1, 0, 0) }, null, goal), false,
      'being below the old current foe height does not request another upward rocket')
    const counted = calls.mock.callCount()
    for (let t = 0; t <= 18; t++) options.goal().at(t)
    assert.equal(calls.mock.callCount(), counted, 'one native forecast per fair pair, not per pilot candidate')
    f.time.advanceTicks(1)
    assert.ok(options.goal().at(0).distanceTo(at(1)) < 1e-8, 'observation age advances the cached trajectory')
    assert.equal(calls.mock.callCount(), counted)
    f.bot.emit('blockUpdate')
    assert.equal(typeof options.goal().at, 'function')
    assert.equal(calls.mock.callCount(), counted + 1, 'new terrain invalidates the shared physical cache')
    f.foe._ndPositionReceipts[1] = { ...f.foe._ndPositionReceipts[1], kind: 'entity_teleport', t: f.time.now() }
    f.foe.emit('ndPositionObserved')
    assert.notEqual(typeof options.goal().at, 'function', 'an absolute receipt cannot retain the old future path')
    f.bot.blockAt = () => null
    assert.equal(options.goal(), null, 'loss of visibility ends pursuit without tracking hidden packets')
    checked = true
    return { why: 'он внизу' }
  })
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, ctl); landed = true; return { ok: true } })
  await wingOrbit({ require: () => f.bot }, ctl, { target: 'Foe', floorY: 120, arena })
  assert.equal(checked, true); assert.equal(landed, true)
})

for (const mode of ['hidden']) test(`the native early wing does not take off for ${mode}`, async t => {
  const f = risingRadio(t)
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 8 }]
  if (mode === 'hop') f.receipt(121.25, 1)
  if (mode === 'hidden') f.bot.blockAt = p => p.floored().x === 606
    ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : f.blockAt(p)
  t.mock.method(flight, 'takeoff', async () => { assert.fail('an unproven rise must retain its ordinary owner') })
  assert.equal((await wingOrbit({ require: () => f.bot }, { aborted: false }, { target: 'Foe', floorY: 120 })).ok, false)
})

test('the physical radio peak reuses one receipt forecast and never persists through board snapshots', async t => {
  const f = risingRadio(t), native = f.bot.physics.simulatePlayer
  let steps = 0
  t.mock.method(f.bot.physics, 'simulatePlayer', (...args) => { steps++; return native(...args) })
  const first = f.radio(); f.sw.observe(f.victim, first)
  const budget = steps
  assert.ok(budget > 0 && budget <= 40)
  assert.equal(f.radio()[0].peakY, first[0].peakY)
  assert.equal(steps, budget, 'ordinary repeated swarm reports do not rerun native physics for the same fair receipt pair')
  delete first[0].peakY
  f.sw.observe(f.victim, JSON.parse(JSON.stringify(first)))
  assert.equal(f.sw.boardOf(f.victim).enemies()[0].peakY, undefined, 'a newer observation replaces the complete physical hint')
})

for (const mode of ['hop', 'unknown velocity', 'roof', 'unknown roof', 'hidden', 'reacquired', 'absolute', 'old', 'ground', 'glider']) {
  test(`wing radio clears a prior peak for ${mode}`, async t => {
    const f = risingRadio(t, mode !== 'unknown velocity')
    const first = f.radio(); f.sw.observe(f.victim, first)
    for (const c of f.calls) c.reply?.({ ok: true }); await settle(); f.calls.length = 0
    if (mode === 'hop') f.receipt(121.25, 1)
    if (mode === 'roof') {
      for (let x = 598; x <= 602; x++) for (let z = 598; z <= 602; z++) f.cells.set(`${x},125,${z}`, 'stone')
      f.bot.emit('blockUpdate')
    }
    if (mode === 'unknown roof') f.bot.blockAt = p => p.y >= 125 ? null : f.blockAt(p)
    if (mode === 'hidden' || mode === 'reacquired') {
      f.bot.blockAt = p => p.floored().x === 606 ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : f.blockAt(p)
      f.bot.emit('physicsTick')
      if (mode === 'reacquired') { f.bot.blockAt = f.blockAt; f.bot.emit('physicsTick') }
    }
    if (mode === 'absolute') f.receipt(f.foe.position.y, 1, 'entity_teleport')
    if (mode === 'old') f.time.advanceTicks(11)
    if (mode === 'ground') { f.receipt(120, 1); f.foe.onGround = true; f.bot.emit('physicsTick') }
    if (mode === 'glider') { f.foe.metadata[0] = 128; f.foe.elytraFlying = true; f.bot.emit('physicsTick') }
    const seen = f.radio()
    assert.equal(seen[0].peakY, null, 'an explicit null survives JSON and clears the previous physical hint')
    f.sw.observe(f.victim, seen)
    assert.equal(f.sw.boardOf(f.victim).enemies()[0].peakY, undefined)
    if (mode === 'hidden') assert.equal(f.calls.some(c => c.method === 'wing_orbit'), false)
    if (['hop', 'ground', 'glider'].includes(mode)) assert.equal(f.calls.some(c => c.method === 'wing_orbit'), true, 'visible geometry reaches the native escort without a peak threshold')
    // A visible body already above the shared wind height remains eligible without an apex forecast.
  })
}

test('production team observation reserves one centre-airborne wing before two ground flank approaches', async () => {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.bots.forEach((b, k) => { f.pos[b.name] = { p: { x: 4 + k * 4, y: 120, z: 0 }, hp: 20, food: 20,
    inv: { iron_sword: 1, elytra: 1, firework_rocket: 8, wind_charge: 8 } } })
  Object.assign(f.sw, f.api, { boards: new Map(), telemetry: { observed: 0 }, preempt: swarmTurn(f.sw).preempt })
  Object.assign(f.sw, swarmTeam(f.sw))
  f.sw.observe(f.victim, [{ id: 'Foe', visible: true, airborne: true, gliding: false,
    position: { x: 0, y: 130, z: 0 }, velocity: { x: 0, y: .1, z: 0 } }])
  try {
    const orbits = f.calls.filter(c => c.method === 'wing_orbit'), flanks = f.calls.filter(c => c.method === 'goto')
    assert.equal(orbits.length, 1, 'the first eligible escort must not be consumed by a ground flank')
    assert.equal(orbits[0].name, 'Victim'); assert.equal(orbits[0].params.target, 'Foe')
    assert.equal(flanks.length, 2, 'the remaining free helpers still take the existing ground flank')
    assert.deepEqual(flanks.map(c => c.name).sort(), ['Free', 'Helper'])
    assert.ok(flanks.every(c => c.params.y === 120))
    assert.equal(f.calls.some(c => c.method === 'wind_out'), false, 'a reserved escort keeps its native reactive throw owner')
  } finally {
    for (const c of f.calls) c.reply?.({ ok: true })
    await settle()
  }
  assert.ok(f.bots.every(b => !b.swarmReserved), 'both flight and flank reservations release with their native replies')
})

function risingFlanks() {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.bots.forEach((b, k) => {
    f.pos[b.name] = { p: { x: 1 + k, y: 120, z: 0 }, hp: 20, food: 20,
      inv: { iron_sword: 1, elytra: 1, firework_rocket: 0, wind_charge: 8 } }
    b.swarmTurnOwner = { cancelled: false }
  })
  Object.assign(f.sw, f.api, { boards: new Map(), telemetry: { observed: 0 }, preempt: swarmTurn(f.sw).preempt })
  Object.assign(f.sw, swarmTeam(f.sw))
  f.sw.go = swarmMoves(f.sw).go
  const seen = [{ id: 'Foe', visible: true, airborne: true, gliding: false,
    position: { x: 0, y: 123, z: 0 }, velocity: { x: 0, y: .7, z: 0 } }]
  f.sw.observe(f.victim, seen)
  assert.equal(f.calls.filter(c => c.method === 'goto').length, 3, 'the team stages real flank approaches before flight gear becomes available')
  for (const b of f.bots) f.pos[b.name].inv.firework_rocket = 8
  seen[0].position.y = 128
  return { ...f, seen }
}

test('a rising target transfers its exact pending flank goto to wing without cancelling another owner', async () => {
  const f = risingFlanks(), before = f.victim.last, oldToken = f.victim.swarmReserved, turnOwner = f.victim.swarmTurnOwner
  const raw = f.victim.c.call.bind(f.victim.c)
  f.victim.c.call = (method, params) => {
    if (method === 'wing_orbit') assert.notEqual(f.victim.swarmReserved, oldToken, 'the new wing owns its token before the RPC starts')
    return raw(method, params)
  }
  try {
    f.sw.observe(f.victim, f.seen)
    const flight = f.calls.find(c => c.method === 'wing_orbit')
    assert.equal(flight?.name, 'Victim', 'one eligible escort must take over its own earlier ground approach')
    const wingToken = f.victim.swarmReserved, wingAction = f.victim.last
    assert.notEqual(wingToken, oldToken)
    f.calls.find(c => c.name === 'Victim' && c.method === 'goto').reply({ ok: false, why: 'superseded' })
    await settle(); await settle()
    assert.equal(before.pending, false, 'the real arena RPC wrapper settled the old action')
    assert.equal(f.victim.last, wingAction)
    assert.equal(f.victim.swarmReserved, wingToken, 'late flank cleanup leaves the wing reservation intact')
    assert.equal(f.victim.swarmTurnOwner, turnOwner)
    assert.equal(currentTurn(f.sw, f.victim, 1), true)
    assert.equal(f.calls.some(c => c.method === 'stop'), false)
  } finally {
    for (const c of f.calls) c.reply?.({ ok: true })
    await settle(); await settle()
  }
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

for (const changed of ['foreign reservation', 'round', 'target', 'replacement goto', 'completed goto', 'fight', 'lance', 'rescue', 'assault']) {
  test(`flank-to-wing transfer preserves ${changed} ownership`, async () => {
    const f = risingFlanks()
    if (changed === 'round') f.sw.generation++
    if (changed === 'target') { f.seen[0].id = 'Other'; f.sw.hostile = () => true }
    for (const b of f.bots) {
      if (changed === 'foreign reservation') b.swarmReserved = {}
      if (changed === 'replacement goto') b.last = { m: 'goto', pending: true }
      if (changed === 'completed goto') b.last.pending = false
      if (changed === 'fight') void b.c.call('fight', { target: 'Foe' })
      if (changed === 'lance') void b.c.call('boost_lance', { target: 'Foe' })
      if (changed === 'rescue') b.c.onDanger({ pos: f.pos[b.name].p, dangers: { lava: [{ at: f.pos[b.name].p, d: 0 }] } })
      if (changed === 'assault') b.swarmTask = { kind: 'fight', data: { target: 'Foe', committed: true, assault: true } }
    }
    const owners = f.bots.map(b => ({ b, token: b.swarmReserved, action: b.last, turn: b.swarmTurnOwner }))
    try {
      f.api.windWing(f.victim, f.seen)
      assert.equal(f.calls.some(c => c.method === 'wing_orbit' || c.method === 'stop'), false)
      for (const o of owners) {
        assert.equal(o.b.swarmReserved, o.token)
        assert.equal(o.b.last, o.action)
        assert.equal(o.b.swarmTurnOwner, o.turn)
      }
    } finally {
      for (const c of f.calls) c.reply?.({ ok: true })
      await settle(); await settle()
    }
  })
}

for (const action of ['pending fight', 'finished fight', 'free']) test(`airborne wind flank preserves ${action} ownership and uses free helpers`, async () => {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.pos.Victim.p = { x: 68, y: 120, z: 0 }
  f.pos.Free = { p: { x: 67, y: 120, z: 0 }, inv: { wind_charge: 2 } }
  let fight: Promise<any> | undefined
  if (action !== 'free') {
    fight = f.helper.c.call('fight', { target: 'Foe' })
    assert.equal(f.helper.last.m, 'fight'); assert.equal(f.helper.last.pending, true)
    if (action === 'finished fight') { f.calls.find(c => c.method === 'fight').reply({ landed: 1 }); await fight }
  }
  const running = f.helper.last
  f.api.windFlank(f.victim, [{ id: 'Foe', visible: true, airborne: true,
    position: { x: 70, y: 124, z: 0 }, velocity: { x: 0, y: 1, z: 0 } }])
  const moved = f.calls.filter(c => c.method === 'goto')
  assert.deepEqual(moved.map(c => c.name).sort(), action === 'pending fight' ? ['Free', 'Victim'] : ['Free', 'Helper', 'Victim'])
  if (action === 'pending fight') {
    assert.equal(f.helper.last, running, 'a flank cannot replace the actual pending fight intent')
    assert.equal(f.helper.swarmReserved, undefined, 'the fighting ally is not claimed for repositioning')
    f.calls.find(c => c.method === 'fight').reply({ landed: 1 }); await fight
  }
  for (const move of moved) move.reply({ ok: true })
  await settle()
  assert.ok(f.bots.every(b => !b.swarmReserved), 'free helpers release their flank reservations')
})

test('wind flank preserves the actual web helper during approach and resumes after rescue', async () => {
  const f = fixture(); f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim'); assert.equal(f.ctx.busy.has('Helper'), true)
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.some(c => c.name === 'Helper' && c.method === 'fly_to'), false)
  assert.equal(f.helper.webRescue, rescue)
  f.calls.find(c => c.name === 'Helper' && c.method === 'goto').reply({ ok: true }); await settle()
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.some(c => c.name === 'Helper' && c.method === 'fly_to'), false, 'cutting retains the same rescue')
  f.calls.find(c => c.name === 'Helper' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  assert.equal(f.helper.webRescue, null); assert.equal(f.ctx.busy.has('Helper'), false)
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.filter(c => c.name === 'Helper' && c.method === 'fly_to').length, 1)
})

for (const stage of ['report', 'plan']) test(`wind chain preserves a helper claimed during awaited ${stage}`, async () => {
  const f = fixture(), done = f.api.windObserve(f.victim, f.seen)
  if (stage === 'plan') { for (const name of ['Victim', 'Helper']) f.gates.get(name + ':report')!(); await settle() }
  f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim')
  if (stage === 'report') { for (const name of ['Victim', 'Helper']) f.gates.get(name + ':report')!(); await settle() }
  f.gates.get('plan')?.()
  assert.equal(await done, false)
  assert.equal(f.calls.some(c => c.method === 'wind_out'), false)
  assert.equal(f.helper.webRescue, rescue); assert.equal(f.ctx.busy.has('Helper'), true)
})

test('pearl ambush preserves the actual web helper and resumes after rescue', async () => {
  const f = fixture(); f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim')
  f.api.pearlObserve(f.victim, [{ id: 7, owner: 'Foe', at: { x: 69, y: 120, z: 0 }, eta: 60 }])
  assert.equal(f.calls.some(c => c.name === 'Helper' && /^pearl_|^boost_/.test(c.method)), false)
  assert.equal(f.helper.webRescue, rescue); assert.equal(f.ctx.busy.has('Helper'), true)
  f.calls.find(c => c.name === 'Helper' && c.method === 'goto').reply({ ok: true }); await settle()
  f.calls.find(c => c.name === 'Helper' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  f.api.pearlObserve(f.victim, [{ id: 8, owner: 'Foe', at: { x: 69, y: 120, z: 0 }, eta: 60 }])
  assert.equal(f.calls.filter(c => c.name === 'Helper' && c.method === 'pearl_ambush').length, 1)
})

test('pearl ambush forwards the original world tick and ETA, while legacy reports stay relative', async () => {
  for (const gameTick of [15781013, undefined]) {
    const f = fixture(), at = { x: 69, y: 120, z: 0 }, eta = 60
    f.api.pearlObserve(f.victim, [{ id: 7, owner: 'Foe', at, eta, ...(gameTick === undefined ? {} : { gameTick }) }])
    try {
      const ambush = f.calls.find(c => c.name === 'Helper' && c.method === 'pearl_ambush')
      assert.ok(ambush)
      assert.equal(ambush.params.eta, eta)
      assert.equal(ambush.params.gameTick, gameTick)
      assert.equal('gameTick' in ambush.params, gameTick !== undefined)
    } finally { for (const c of f.calls) c.reply?.({ ok: true }); await settle() }
  }
})

for (const phase of ['approach', 'draw']) test(`arrow boost yields to actual helper lava reaction during ${phase}`, async t => {
  const f = fixture(), timers: (() => void)[] = []
  t.mock.method(globalThis, 'setTimeout', (work: () => void, ms: number) => {
    assert.equal(ms, 900); timers.push(work); return 0 as any
  })
  f.pos.Victim = { p: { x: 7, y: 120, z: 0 }, inv: { iron_spear: 1 } }
  f.pos.Helper = { p: { x: 10, y: 120, z: 0 }, inv: { bow: 1, arrow: 16 } }
  f.api.arrowBoost(f.victim, [{ id: 'Foe', visible: true, position: { x: 0, y: 120, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }])
  const approaches = f.calls.filter(c => c.method === 'goto')
  assert.equal(approaches.length, 2)
  const danger = () => {
    f.helper.c.onDanger({ pos: f.pos.Helper.p, dangers: { lava: [{ at: f.pos.Helper.p, d: 0 }] } })
    assert.equal(f.ctx.busy.has('Helper'), true)
    assert.equal(f.helper.last.m, 'lava_escape')
  }
  if (phase === 'approach') danger()
  for (const c of approaches) { f.pos[c.name].p = { x: c.params.x, y: c.params.y, z: c.params.z }; c.reply({ ok: true }) }
  await settle()
  if (phase === 'draw') { assert.equal(timers.length, 1); danger() }
  for (const resume of timers) resume()
  await settle()
  const shots = f.calls.filter(c => c.method === 'boost_shot')
  for (const c of f.calls.filter(c => /^boost_/.test(c.method))) c.reply({ ok: true })
  await settle()
  assert.equal(shots.length, 0, 'late ordinary boost cannot interrupt the active lava escape')
  if (phase === 'approach') assert.equal(f.calls.some(c => c.method === 'boost_lance'), false)
})

test('an unchanged arrow boost starts both native actions and releases its reservations', async t => {
  const f = fixture(), timers: (() => void)[] = []
  t.mock.method(globalThis, 'setTimeout', (work: () => void, ms: number) => {
    assert.equal(ms, 900); timers.push(work); return 0 as any
  })
  f.pos.Victim = { p: { x: 7, y: 120, z: 0 }, inv: { iron_spear: 1 } }
  f.pos.Helper = { p: { x: 10, y: 120, z: 0 }, inv: { bow: 1, arrow: 16 } }
  f.api.arrowBoost(f.victim, [{ id: 'Foe', visible: true, position: { x: 0, y: 120, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }])
  for (const c of f.calls.filter(c => c.method === 'goto')) {
    f.pos[c.name].p = { x: c.params.x, y: c.params.y, z: c.params.z }; c.reply({ ok: true })
  }
  await settle(); assert.equal(timers.length, 1); timers[0](); await settle()
  const actions = f.calls.filter(c => /^boost_/.test(c.method))
  assert.deepEqual(actions.map(c => c.method), ['boost_lance', 'boost_shot'])
  assert.equal(f.victim.last.m, 'boost_lance'); assert.equal(f.victim.last.pending, true)
  assert.equal(f.helper.last.m, 'boost_shot'); assert.equal(f.helper.last.pending, true)
  for (const c of actions) c.reply({ ok: true })
  await settle()
  assert.ok(f.bots.every(b => b.last.pending === false))
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('a real wind orbit reservation protects nongliding launch from task preemption until its reply', async () => {
  const f = fixture(), running = { kind: 'goto', data: { target: 'Old' } }
  const next = { kind: 'fight', data: { target: 'Foe' } }
  Object.assign(f.helper, { swarmExecuting: true, swarmTask: running, swarmTurnOwner: { cancelled: false } })
  f.sw.refresh = () => ({ task: next, board: { enemies: () => [] } })
  const { preempt } = swarmTurn(f.sw)
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
  const flight = f.calls.find(c => c.method === 'wing_orbit'), intent = f.helper.last
  assert.equal(flight?.name, 'Helper')
  assert.ok(f.helper.swarmReserved, 'the real producer holds its reservation before the RPC reply')
  assert.notEqual(f.pos.Helper.gliding, true, 'launch has not yet reported gliding')
  try {
    assert.equal(preempt(f.helper), false, 'a new task cannot cancel the reserved launch')
    assert.equal(f.helper.last, intent)
    assert.equal(f.helper.swarmTask, running)
    assert.equal(f.calls.some(c => c.method === 'stop'), false)
    flight.reply({ ok: true, ms: 1000, nearTicks: 1, closest: 8, why: 'долго', landed: true })
    await settle()
    assert.equal(f.helper.swarmReserved, undefined, 'the actual producer finally releases ownership')
    assert.equal(preempt(f.helper), true, 'ordinary task changes resume immediately after release')
    assert.equal(f.helper.swarmTask, next)
    assert.deepEqual(f.calls.map(c => c.method), ['wing_orbit', 'stop'])
  } finally {
    for (const c of f.calls) c.reply?.({ ok: true })
    await settle()
  }
})

test('an old fight turn cannot replace its new wind escort with an exclusive push', async () => {
  const f = fixture(), b = f.helper
  const foe = { ...f.seen[0], position: { x: 70, y: 121, z: 0 }, seenAt: Date.now() }
  const board = { enemies: () => [foe], tasks: () => [], facts: () => [] }
  const member = { id: b.name, role: 'fighter' }
  const task = { kind: 'fight', data: { target: foe.id, push: true } }
  let stalled = true, finishGrab: (found: boolean) => void
  f.ctx.swarmDriver = { enemies: board.enemies }
  Object.assign(f.sw, {
    now: () => foe.seenAt, cooldown: new Map(), refresh: () => ({ task, board, member, members: [member] }),
    say() {}, chestAtHand: () => false, onslaught: () => true,
    grab: () => stalled ? new Promise<boolean>(resolve => { finishGrab = resolve }) : Promise.resolve(false),
    detail: reply => reply.detail
  })
  Object.assign(f.sw, swarmTurnWork(f.sw))
  Object.assign(f.sw, swarmTurn(f.sw))
  const { guardedTurn } = swarmLifecycle(f.sw)
  const turn = guardedTurn(b)
  let nextTurn: Promise<void> | undefined
  try {
    assert.equal(typeof finishGrab, 'function')
    f.api.windWing(f.victim, [foe])
    const flight = f.calls.find(call => call.method === 'wing_orbit')
    assert.equal(flight?.name, b.name)
    const reservation = b.swarmReserved, intent = b.last
    assert.ok(reservation && intent.pending)

    finishGrab(false)
    await settle()
    assert.deepEqual(f.calls.map(call => call.method), ['wing_orbit'])
    assert.equal(b.swarmReserved, reservation)
    assert.equal(b.last, intent)
    await turn

    flight.reply({ ok: true })
    await settle()
    assert.equal(b.swarmReserved, undefined)
    stalled = false
    nextTurn = guardedTurn(b)
    await settle()
    const push = f.calls.find(call => call.method === 'wind_push')
    assert.equal(push?.params.target, foe.id)
    push.reply({ fired: true })
    await nextTurn
  } finally {
    finishGrab?.(false)
    for (const call of f.calls) call.reply?.({ ok: true, fired: true })
    await turn
    await nextTurn
    await settle()
  }
})

test('a free helper can approach a visible glider without a categorical throw veto', async () => {
  const f = fixture(), before = f.helper.last
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true, gliding: true }])
  assert.equal(f.calls.some(c => c.method === 'wing_orbit'), true)
  assert.ok(f.helper.swarmReserved)
  assert.notEqual(f.helper.last, before)
  assert.equal(f.helper.last.m, 'wing_orbit')
  const flight = f.calls.find(c => c.method === 'wing_orbit')
  assert.equal(flight?.name, 'Helper', 'a thrown or falling mace user still permits a wind orbit')
  flight.reply({ ok: true }); await settle()
})

test('a low native escort with one charge and one rocket delegates its launch to the existing safe flight executor', async t => {
  const f = risingRadio(t), calls: string[] = []
  f.receipt(121.25, 1)
  f.bot.inventory.items = () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 1 }, { name: 'wind_charge', count: 1 }]
  t.mock.method(flight, 'takeoff', async (_bot, _ctl, options) => {
    assert.equal(options.useReserve, true, 'the offensive caller explicitly permits its sole physical launch rocket')
    assert.deepEqual(options.arena, f.sw.arena)
    calls.push('takeoff'); f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true
    return { ok: true }
  })
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.useReserve, true)
    assert.equal(options.until(), null, 'the low public feet do not create a height veto')
    calls.push('fly'); return { why: 'one-rocket handoff control' }
  })
  t.mock.method(flight, 'land', async () => { calls.push('land'); return { ok: true } })
  const result = await wingOrbit({ require: () => f.bot }, { aborted: false }, { target: 'Foe', floorY: 120, arena: f.sw.arena })
  assert.equal(result.ok, true); assert.deepEqual(calls, ['takeoff', 'fly', 'land'])
})

test('a committed fighter already within native combat approach keeps attacking while a free helper orbits', async () => {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.pos.Helper.p = { x: 74, y: 150, z: 0 }
  f.pos.Free = { p: { x: 62, y: 145, z: 0 }, inv: { ...f.pos.Helper.inv } }
  f.helper.swarmTask = { kind: 'fight', data: { target: 'Foe', committed: true } }
  const before = f.helper.last
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
  const flight = f.calls.find(c => c.method === 'wing_orbit')
  assert.equal(flight?.name, 'Free', 'a free escort must not take the close fighter away from its target')
  assert.equal(f.helper.swarmReserved, undefined)
  assert.equal(f.helper.last, before)
  flight.reply({ ok: true }); await settle()
})

test('an explicit assault keeps its distant committed fighter while ordinary far approaches can still escort', async () => {
  for (const [gap, assault, expected] of [[20, true, 'Free'], [30, true, 'Free'], [20, false, 'Helper']] as const) {
    const f = fixture(['Victim', 'Helper', 'Free'])
    f.pos.Helper.p = { x: 78 - gap, y: 150, z: 0 }
    f.pos.Free = { p: { x: 70 - gap, y: 150, z: 0 }, inv: { ...f.pos.Helper.inv } }
    f.helper.swarmTask = { kind: 'fight', data: { target: 'Foe', committed: true, assault } }
    f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
    const flight = f.calls.find(c => c.method === 'wing_orbit')
    assert.equal(flight?.name, expected, `${gap} blocks, assault=${assault}`)
    if (assault) assert.equal(f.helper.swarmReserved, undefined, 'native combat keeps the assault fighter')
    flight.reply({ ok: true }); await settle()
  }
})

test('a free gliding assault without an airborne attack can escort the same wind-displaced target', async () => {
  for (const state of ['free', 'fight', 'fly_to', 'goto', 'rescue', 'defense', 'rearm', 'lance', 'near', 'spear', 'offhand spear', 'mace', 'crossbow', 'bow', 'trident', 'pearl', 'ordinary jump', 'ground', 'foe gliding', 'hidden']) {
    const f = fixture(['Victim', 'Helper', 'Free'])
    // DN walk B at client tick 585: a glider on the centre side and a much later ground approach.
    Object.assign(f.sw.arena, { x: 600.5, z: 600.5, ellipse: { a: 77, b: 65 } })
    const position = { x: 537.723, y: 153.135, z: 627.479 }
    const inv = { netherite_sword: 1, elytra: 1, firework_rocket: 64, wind_charge: 64 }
    f.pos.Victim = { p: { x: 546, y: 153, z: 626 }, hp: 20, food: 20, inv: {} }
    f.pos.Helper = { p: state === 'near' ? { ...position, x: position.x + 5 } : { x: 551.579, y: 158.519, z: 642.187 },
      hp: 20, food: 20, gliding: true, inv: { ...inv }, attackArrows: 0 }
    f.pos.Free = { p: { x: 600.5, y: 120, z: 600.5 }, hp: 20, food: 20, inv }
    f.helper.swarmTask = { kind: 'fight', data: { target: 'Foe', committed: true, assault: true, rearm: state === 'rearm' } }
    if (['fight', 'fly_to', 'goto'].includes(state)) f.helper.last = { m: state, pending: true }
    if (state === 'rescue') f.pos.Helper.rescuing = true
    if (state === 'defense') f.helper.maceDefense = { until: f.sw.now() + 500 }
    if (state === 'lance') f.pos.Helper.lance = { target: 'Foe' }
    if (state === 'spear') f.pos.Helper.inv.iron_spear = 1
    if (state === 'offhand spear') f.pos.Helper.offHand = { item: 'iron_spear' }
    if (state === 'pearl') f.pos.Helper.inv.ender_pearl = 1
    if (['mace', 'crossbow', 'bow', 'trident'].includes(state)) f.pos.Helper.inv[state] = 1
    if (state === 'bow') f.pos.Helper.attackArrows = 1
    Object.assign(f.sw, f.api, { boards: new Map(), telemetry: { observed: 0 }, preempt: swarmTurn(f.sw).preempt })
    Object.assign(f.sw, swarmTeam(f.sw))
    f.sw.observe(f.victim, [{ id: 'Foe', position, visible: state !== 'hidden', airborne: state !== 'ground',
      gliding: state === 'foe gliding', windAffected: state !== 'ordinary jump' }])
    try {
      assert.equal(f.calls.find(c => c.method === 'wing_orbit')?.name, state === 'free' ? 'Helper' : state === 'hidden' ? undefined : 'Free', state)
      assert.equal(!!f.helper.swarmReserved, state === 'free', state)
      assert.equal(f.calls.some(c => c.method === 'stop'), false, state)
    } finally {
      for (const c of f.calls) c.reply?.({ ok: true })
      await settle()
    }
    assert.equal(f.helper.swarmReserved, undefined, state)
  }
})

for (const job of ['windFlank', 'sentries'] as const) test(`${job} preserves an assigned assault during its pending approach and uses a free helper`, async () => {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.pos.Free = { p: { x: 66, y: 120, z: 6 }, inv: { ...f.pos.Helper.inv } }
  f.helper.swarmTask = { kind: 'fight', data: { target: 'Foe', committed: true, assault: true } }
  f.helper.last = { m: 'goto', pending: true }
  if (job === 'windFlank') {
    f.pos.Victim.p = { x: 70, y: 120, z: 0 }
    f.pos.Helper.p = { x: 74, y: 120, z: 0 }
    f.pos.Free.p = { x: 74, y: 120, z: 1 }
  }
  const before = f.helper.last
  f.api[job](f.victim, [{ ...f.seen[0], ...(job === 'windFlank' ? { position: { x: 78, y: 124, z: 0 } } : {}), airborne: true }])
  try {
    assert.equal(f.calls.some(c => c.name === 'Helper'), false, 'selected assault retains its approach before native fight starts')
    assert.equal(f.helper.last, before)
    assert.equal(f.helper.swarmReserved, undefined)
    assert.ok(f.calls.some(c => c.name === 'Free' && c.method === 'goto'), 'the free helper still takes the support job')
  } finally {
    for (const c of f.calls) c.reply?.({ ok: true })
    await settle()
  }
})

test('wind orbit reservations preserve emergency reactions, death invalidation and actual round reset', async () => {
  const f = fixture()
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
  assert.ok(f.helper.swarmReserved)
  f.helper.c.onDanger({ pos: f.pos.Helper.p, dangers: { lava: [{ at: f.pos.Helper.p, d: 0 }] } })
  assert.equal(f.helper.last.m, 'lava_escape', 'the actual danger adapter still starts the emergency RPC')
  assert.equal(f.ctx.busy.has('Helper'), true)
  f.ctx.deadNow.add('Helper')
  assert.equal(currentTurn(f.sw, f.helper, f.sw.generation), false, 'death invalidates the old turn despite its reservation')
  f.ctx.deathAt = {}
  f.ctx.swarmDriver.reset()
  assert.equal(f.helper.swarmReserved, undefined, 'the actual round reset clears the reservation')
  assert.equal(f.helper.swarmTask, undefined)
  assert.equal(f.calls.filter(c => c.method === 'swarm_keep').length, f.bots.length)
  for (const c of f.calls) c.reply?.({ ok: true })
  await settle()
})

test('wind orbit retries require target movement after completion, not movement during the reserved flight', async () => {
  const f = fixture()
  let seen = { ...f.seen[0], airborne: true }
  f.sw.boardOf = () => ({ enemies: () => [seen] })
  f.api.windWing(f.victim, [seen])
  const first = f.calls.find(c => c.method === 'wing_orbit')
  assert.ok(first)
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 10 } }
  first.reply({ ok: true, ms: 18000, windShots: 0, nearTicks: 0, closest: 17, landed: true })
  await settle()
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 1, 'the completed flight already covered this movement')
  assert.equal(f.helper.swarmReserved, undefined, 'ordinary combat can resume')
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 6 } }
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 2, 'new movement permits another useful approach')
  f.calls.at(-1).reply({ ok: true, windShots: 1 }); await settle()
  f.sw.generation++
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 3, 'the next round does not inherit the last flight position')
  f.calls.at(-1).reply({ ok: true }); await settle()
})

test('an old round orbit reply cannot poison the current round launch memory', async () => {
  const f = fixture()
  let seen = { ...f.seen[0], airborne: true }
  f.sw.boardOf = () => ({ enemies: () => [seen] })
  f.api.windWing(f.victim, [seen])
  const old = f.calls.at(-1)
  f.sw.generation++
  delete f.helper.swarmReserved
  f.helper.last.pending = false
  f.api.windWing(f.victim, [seen])
  const current = f.calls.at(-1), owner = f.helper.swarmReserved
  assert.notEqual(current, old)
  old.reply({ ok: false, why: 'взлёт: blocked' }); await settle()
  assert.equal(f.helper.swarmReserved, owner, 'late cleanup leaves the new flight owner intact')
  current.reply({ ok: true, windShots: 1 }); await settle()
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 6 } }
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 3, 'the old failure did not block the same launch point')
  f.calls.at(-1).reply({ ok: true }); await settle()
})
