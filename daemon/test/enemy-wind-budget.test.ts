import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { planEnemyWind, windReportAt, windTeamSafe, enemyWindShot } from '../src/combat/enemy-wind'
import { wall } from '../src/game-clock'
import pick = require('../src/pick')
import * as wind from '../src/combat/enemy-wind'
import * as teamWind from '../src/combat/team-wind'
import threats = require('../src/threats')
import * as clock from '../src/game-clock'
import * as search from '../src/pvp/search'
import edges = require('../src/edges')

function fixture() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock(p) {
    const q = p.floored(), solid = q.y === 0 && q.x >= -8 && q.x <= 4 && Math.abs(q.z) <= 5
    const block = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState)
    block.position = q; return block
  } }
  const foe: any = { id: 2, username: 'Enemy', type: 'player', position: new Vec3(3.5, 2.5, .5),
    velocity: new Vec3(.08, .2, 0), onGround: false, height: 1.8, width: .6, equipment: [], metadata: [] }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, game: { minY: -64, height: 384 },
    food: 20, inventory: { slots: [], items: () => [] }, entities: { 2: foe },
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, physics: require('../src/tick-plugins').getPhysics().Physics(registry, world) })
  const reports = [-2, -4, -6].map((x, i) => ({ id: String.fromCharCode(65 + i), position: { x, y: 1, z: [.5, -1, 2][i] },
    velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  const options = { arena: { x: -1.5, z: .5, r: 6.5, killY: -10 }, startTick: 505, maxShots: 3 }
  return { bot, foe, reports, options }
}

test('one synchronous native chain reuses fair LOS across candidates and outcome bounds', t => {
  const { bot, foe, reports, options } = fixture(), expected = planEnemyWind(bot, foe, reports, options)
  assert.ok(expected)
  for (let i = 0; i < 19; i++) bot.entities[10 + i] = { id: 10 + i, username: `Blue${i}`, type: 'player',
    position: new Vec3(-3 + i / 10, 1, 4), width: .6, height: 1.8 }
  const calls = new Map<any, number>()
  let visible = true
  t.mock.method(pick, 'canHit', (_bot, entity) => {
    if (entity === foe) return true
    calls.set(entity, (calls.get(entity) || 0) + 1); return visible
  })
  assert.deepEqual(planEnemyWind(bot, foe, reports, options), expected, 'visibility memoization cannot alter native shots or safety')
  assert.equal(calls.size, 19)
  assert.ok([...calls.values()].every(n => n === 1), `repeated LOS counts: ${[...calls.values()]}`)
  calls.clear(); visible = false
  assert.deepEqual(planEnemyWind(bot, foe, reports, options), expected, 'the next synchronous plan observes the new LOS state')
  assert.ok([...calls.values()].every(n => n === 1))
})

for (const mode of ['begin', 'team warmup', 'candidate bounds']) test(`the native planner stops its ${mode} at the existing deadline`, t => {
  const { bot, foe, reports, options } = fixture()
  let now = 0, steps = 0
  const simulate = bot.physics.simulatePlayer
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; now += 2; return simulate(...args) })
  const team = mode === 'team warmup' ? Array.from({ length: 20 }, (_, i) => ({ ...reports[0], id: `Blue${i}`,
    position: { x: -7 + i % 10, y: 1, z: -4 + Math.floor(i / 10) } })) : [reports[0]]
  const deadline = mode === 'begin' ? -1 : mode === 'team warmup' ? 100 : 280
  assert.equal(planEnemyWind(bot, foe, team, { ...options, allies: team, deadline }), null)
  assert.ok(now <= Math.max(0, deadline) + 2, `${steps} native steps consumed ${now}ms for a ${deadline}ms window`)
  if (mode === 'begin') assert.equal(steps, 0, 'expired work cannot start an unused native forecast')
})

test('a sufficient physical planning window preserves the full native result', t => {
  const { bot, foe, reports, options } = fixture(), expected = planEnemyWind(bot, foe, reports, options)
  assert.ok(expected)
  t.mock.method(wall, 'monotonic', () => 1000)
  assert.deepEqual(planEnemyWind(bot, foe, reports, { ...options, deadline: 2000 }), expected)
})

test('one synchronous plan checks ally safety once for each identical impact', t => {
  const { bot, foe, reports, options } = fixture()
  const allyAttributes = { marker: {} } as any
  const allies = [{ ...reports[1], attributes: allyAttributes }]
  const settings = { ...options, startTick: 500, maxShots: 1, delays: [0], allies, reactAfterHit: true }
  const expected = planEnemyWind(bot, foe, [reports[0]], settings)
  assert.ok(expected)
  const impulses = new Map<string, number>(), impulse = teamWind.windImpulse
  t.mock.method(teamWind, 'windImpulse', (snapshot, feet, burst, pose) => {
    if (snapshot.entity?.attributes === allyAttributes) {
      const key = JSON.stringify([feet, burst]); impulses.set(key, (impulses.get(key) ?? 0) + 1)
    }
    return impulse(snapshot, feet, burst, pose)
  })
  assert.deepEqual(planEnemyWind(bot, foe, [reports[0]], settings), expected)
  assert.ok(impulses.size > 0)
  assert.ok([...impulses.values()].every(n => n === 1), `repeated safety checks: ${[...impulses.values()]}`)
  const firstPlan = [...impulses]
  impulses.clear()
  assert.deepEqual(planEnemyWind(bot, foe, [reports[0]], settings), expected)
  assert.deepEqual([...impulses], firstPlan, 'the next plan still checks its own snapshot')
})

test('a release certificate needs the exact immediate impact and the unchanged current roster', () => {
  const { bot, foe, reports, options } = fixture(), [own, ally] = reports
  const settings = { ...options, startTick: 500, maxShots: 1, delays: [0], collision: wind.windCollisionWorld(bot), reactAfterHit: true }
  const plan = (allies, extra = {}) => planEnemyWind(bot, foe, [own], { ...settings, allies, certifyRelease: true, ...extra } as any) as any
  const exact = plan([own, ally])
  assert.ok(exact)
  const { ticks, burst } = exact.shots[0]
  assert.equal(exact.releaseSafeKey, [ticks, burst.x, burst.y, burst.z].join(','))
  for (const other of [plan([own, ally, ally]), plan([ally]), plan([own, { ...ally, gameTick: 499 }]),
    plan([own, ally], { delays: [1] }), plan([own, ally], { collision: undefined }), plan([own, ally], { certifyRelease: false })]) {
    assert.ok(other, 'the ordinary plan is still available')
    assert.equal(other.releaseSafeKey, undefined)
  }
})

test('alternative launch heights share the thrower trajectory within one snapshot', t => {
  const { bot, foe, reports } = fixture()
  const report = { ...reports[0], onGround: false, position: { x: -2, y: 2, z: .5 }, velocity: { x: .12, y: .2, z: 0 } }
  const frames = Array.from({ length: 18 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const independent = enemyWindShot(bot, foe, report, frames, { fireDelay: 5, height: 1.6 })
  assert.ok(independent)
  let steps = 0
  const simulate = bot.physics.simulatePlayer
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return simulate(...args) })
  const tracks = new Map()
  assert.ok(enemyWindShot(bot, foe, report, frames, { fireDelay: 5, height: .4, tracks }))
  assert.deepEqual(enemyWindShot(bot, foe, report, frames, { fireDelay: 5, height: 1.6, tracks }), independent)
  assert.equal(steps, 5)
})

test('a visible incoming hit blocks a later local release but allows an earlier one', t => {
  const { bot, foe, reports, options } = fixture()
  foe.position = new Vec3(3.5, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  const launch = new Vec3(1, 2, .5), velocity = new Vec3(1.5, 0, 0), projectile = { id: 7, name: 'wind_charge', position: launch }
  bot.entities[7] = projectile
  t.mock.method(clock, 'observationNow', () => 1000)
  bot._ndThrown = new Map([[7, { name: 'wind_charge', owner: 9, p: launch, observedAt: 1000 }]])
  const view = { _ndPositionReceipts: [null, { t: 1000 }], _ndObservationNow: () => 1000,
    _ndWindMotion: { position: launch, velocity, t: 1000 } }
  let visible = true
  t.mock.method(threats, 'projectileView', () => visible ? view : null)
  const settings = { ...options, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true }
  assert.ok(planEnemyWind(bot, foe, [reports[0]], settings))
  assert.equal(planEnemyWind(bot, foe, [reports[0]], { ...settings, waitForHit: true }), null)
  launch.x = -8
  bot._ndThrown.get(7).owner = bot.entity.id
  const before = wind.enemyWindFrames(bot, foe, options.arena, [], 0, true)
  const pending = wind.pendingWindHit(bot, foe, before)
  assert.ok(pending && pending.ticks > 4, 'the recorded world has a later direct hit in the same lane')
  const earlier = planEnemyWind(bot, foe, [reports[0]], { ...settings, waitForHit: true })
  assert.ok(earlier && earlier.shots[0].ticks < pending.ticks, 'a certified shot can arrive first')
  const near = new Vec3(1, 2, .5)
  bot.entities[8] = { ...projectile, id: 8, position: near }
  bot._ndThrown.set(8, { ...bot._ndThrown.get(7), p: near })
  t.mock.method(threats, 'projectileView', (_b, e) => visible ? e.id === 7 ? view : {
    ...view, _ndWindMotion: { ...view._ndWindMotion, position: near }
  } : null)
  assert.equal(wind.pendingWindHit(bot, foe, before)?.id, 8, 'insertion order cannot hide a sooner incoming hit')
  assert.equal(planEnemyWind(bot, foe, [reports[0]], { ...settings, waitForHit: true }), null)
  visible = false
  assert.ok(planEnemyWind(bot, foe, [reports[0]], { ...settings, waitForHit: true }))
})

test('dominated shots leave enough native work for the same certified chain among twenty ready throwers', t => {
  const { bot, foe } = fixture(), Block = require('prismarine-block')(bot.registry)
  bot.blockAt = p => {
    const q = p.floored(), block = Block.fromStateId(bot.registry.blocksByName[q.y < 1 ? 'stone' : 'air'].defaultState)
    block.position = q; return block
  }
  foe.position = new Vec3(.5, 1, .5); foe.onGround = true; foe.velocity = new Vec3(0, 0, 0)
  const reports = Array.from({ length: 20 }, (_, i) => {
    const angle = 2 * Math.PI * i / 20
    return { id: i ? `Blue${i}` : 'A', position: { x: .5 + 7 * Math.cos(angle), y: 1, z: .5 + 7 * Math.sin(angle) },
      velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }
  })
  bot.entity.position = new Vec3(7.5, 1, .5)
  const options = { arena: { x: .5, z: .5, r: 80, ellipse: { a: 77, b: 65 }, killY: -10 },
    startTick: 503, maxShots: reports.length, allies: reports }
  let steps = 0
  const native = bot.physics.simulatePlayer.bind(bot.physics)
  bot._ndSimOrig = (state, world) => { steps++; return native(state, world) }
  const expected = planEnemyWind(bot, foe, reports, options)
  assert.equal(expected?.shots.length, 3)
  const unlimitedSteps = steps
  steps = 0
  t.mock.method(wall, 'monotonic', () => steps)
  const bounded = planEnemyWind(bot, foe, reports, { ...options, deadline: 15000 })
  t.diagnostic(`native steps ${unlimitedSteps} for the complete chain, ${steps} under the work clock`)
  assert.deepEqual(bounded, expected)
})

test('the fourth ready thrower is considered when the nearer three rays are blocked', () => {
  const { bot, foe, options } = fixture(), Block = require('prismarine-block')(bot.registry), blockAt = bot.blockAt
  foe.position.y = 5
  bot.entity.username = 'D'; bot.entity.position = new Vec3(-7.5, 1, .5)
  bot.blockAt = p => {
    const q = p.floored()
    if (q.z === -1 && q.x >= -8 && q.x <= 4 && q.y >= 1 && q.y <= 6) {
      const block = Block.fromStateId(bot.registry.blocksByName.stone.defaultState); block.position = q; return block
    }
    return blockAt(p)
  }
  const reports = [-2, -4, -6].map((x, i) => ({ id: String.fromCharCode(65 + i), position: { x, y: 1, z: -2 },
    velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  reports.push({ id: 'D', position: { x: -7.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 })
  const plan = planEnemyWind(bot, foe, reports, { ...options, maxShots: 1 })
  assert.ok(plan, JSON.stringify(require('../src/combat/enemy-wind').planTraceCounts))
  assert.equal(plan.shots[0].thrower, 'D')
})

test('a short collision forecast keeps all twenty allies without eagerly simulating sixty-five ticks each', t => {
  const { bot, foe, reports } = fixture(), native = bot.physics.simulatePlayer
  const team = [reports[0], ...Array.from({ length: 19 }, (_, i) => ({ ...reports[0], id: `Blue${i}`,
    position: { x: -6 + i % 7, y: 1, z: i % 2 ? -4 : 4 } }))]
  let steps = 0
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return native(...args) })
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const shot = enemyWindShot(bot, foe, reports[0], frames, { height: .4, allies: team })
  assert.ok(shot)
  assert.ok(steps <= 19 * shot.ticks, `${steps} native steps for ${team.length} bodies and arrival ${shot.ticks}`)
})

test('an exact local release reuses its ally collision tracks for burst safety', t => {
  const f = fixture()
  f.foe.position.y = 1; f.foe.velocity = new Vec3(0, 0, 0); f.foe.onGround = true
  const simulate = f.bot.physics.simulatePlayer.bind(f.bot.physics)
  let steps = 0
  t.mock.method(f.bot.physics, 'simulatePlayer', (...args) => { steps++; return simulate(...args) })
  const collision = wind.windCollisionWorld(f.bot), observed = { ...f.bot, blockAt: p => collision.blockAt(p) }
  const frames = wind.enemyWindFrames(f.bot, f.foe, f.options.arena, [], 0, true, collision)
  const release = (shared: boolean) => {
    steps = 0
    const tracks = shared ? new Map() : undefined
    const shot = enemyWindShot(f.bot, f.foe, f.reports[0], frames, { height: .4, allies: f.reports, tracks }, undefined, undefined, collision)
    assert.ok(shot)
    const safe = windTeamSafe(observed, f.reports, [shot], f.options.arena, tracks)
    return { shot, safe, steps }
  }
  const cold = release(false), shared = release(true)
  assert.deepEqual(shared.shot, cold.shot); assert.equal(shared.safe, cold.safe)
  assert.ok(shared.steps < cold.steps, `native steps ${shared.steps} vs ${cold.steps}`)
})

test('allied splash safety forecasts the requested native arrival and refuses an absent future', t => {
  const { bot, reports } = fixture(), native = bot.physics.simulatePlayer
  let steps = 0
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return native(...args) })
  const tracks = new Map(), far = new Vec3(100, 100, 100)
  assert.equal(windTeamSafe(bot, reports, [], undefined, tracks), true)
  assert.equal(steps, 0, 'no explosion needs no future body integration')
  assert.equal(windTeamSafe(bot, reports, [{ ticks: 4, burst: far }], undefined, tracks), true)
  assert.equal(steps, reports.length * 4)
  assert.equal(windTeamSafe(bot, reports, [{ ticks: 8, burst: far }], undefined, tracks), true)
  assert.equal(steps, reports.length * 8, 'the same synchronous tracks extend from the certified prefix')
  assert.equal(windTeamSafe(bot, reports, [{ ticks: 65, burst: far }], undefined, tracks), true)
  assert.equal(steps, reports.length * 65)
  assert.equal(windTeamSafe(bot, reports, [{ ticks: 66, burst: far }], undefined, tracks), false)
  assert.equal(steps, reports.length * 65, 'an unavailable future cannot silently skip allied splash')
})

test('a delayed native burst still refuses to carry a nearby ally off its future support', () => {
  const { bot, reports, options } = fixture()
  const ally = { ...reports[0], position: { x: 3.6, y: 1, z: .5 } }
  assert.equal(windTeamSafe(bot, [ally], [{ ticks: 8, burst: new Vec3(2, 1.25, .5) }], options.arena), false)
})

test('one synchronous release shares observed geometry across frames, shot, pending and allied safety', t => {
  let now = 1000
  t.mock.method(clock, 'now', () => now)
  t.mock.method(clock, 'observationNow', () => 1000)
  const pipeline = (shared: boolean, blocked = false) => {
    const f = fixture(); f.foe.position.y = 1; f.foe.velocity = new Vec3(0, 0, 0); f.foe.onGround = true
    if (blocked) for (let y = 1; y <= 1; y++) {
      const read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
      f.bot.blockAt = p => {
        if (Math.floor(p.x) !== 2 || Math.floor(p.y) !== y || Math.floor(p.z) !== 0) return read(p)
        const b = Block.fromStateId(f.bot.registry.blocksByName.stone.defaultState); b.position = p.floored(); return b
      }
    }
    let reads = 0, rays = 0
    const read = f.bot.blockAt; f.bot.blockAt = p => { reads++; return read(p) }
    const cast = { id: 900, name: 'wind_charge', position: new Vec3(-2, 2.62, .5),
      _ndPositionReceipts: [null, { t: 1000 }], _ndObservationNow: () => 1000,
      _ndWindMotion: { t: 1000, position: new Vec3(-2, 2.62, .5), velocity: new Vec3(1.5, 0, 0) } }
    f.bot.entities[900] = cast
    const tracker = t.mock.method(threats, 'thrownTracker', () => new Map([[900, { name: 'wind_charge', owner: 1, t0: 1000, observedAt: 1000, p: cast.position }]]))
    const view = t.mock.method(threats, 'projectileView', (_bot, e) => e === cast ? cast : null)
    const ray = pick.blockOnRay, counted = t.mock.method(pick, 'blockOnRay', (...args: Parameters<typeof pick.blockOnRay>) => { rays++; return ray(...args) })
    try {
      now = 1000
      const collision = shared ? (wind.windCollisionWorld || search.observedCollision)(f.bot) : undefined
      const frames = wind.enemyWindFrames(f.bot, f.foe, f.options.arena, [], 0, true, collision)
      now += 50
      const shot = wind.enemyWindShot(f.bot, f.foe, f.reports[0], frames, { height: .4, allies: f.reports }, undefined, undefined, collision)
      now += 50
      const pending = wind.pendingWindHit(f.bot, f.foe, frames, [], collision)
      now += 50
      const world = edges.worldOf(collision || search.observedCollision(f.bot))
      const safe = !!shot && wind.windTeamSafe({ ...f.bot, blockAt: p => world.getBlock(p) }, f.reports, [shot], f.options.arena)
      return { frames, shot, pending, safe, reads, rays }
    } finally { tracker.mock.restore(); view.mock.restore(); counted.mock.restore() }
  }
  const old = pipeline(false), shared = pipeline(true)
  assert.deepEqual({ ...shared, reads: 0, rays: 0 }, { ...old, reads: 0, rays: 0 })
  assert.ok(shared.reads < old.reads, `raw Block reads ${shared.reads} vs ${old.reads}`)
  assert.ok(shared.rays < old.rays, `LOS/collision rays ${shared.rays} vs ${old.rays}`)
  assert.equal(shared.pending?.id, 900, 'the known incoming hit is retained')
  const closed = pipeline(true, true), closedOld = pipeline(false, true)
  assert.deepEqual({ ...closed, reads: 0, rays: 0 }, { ...closedOld, reads: 0, rays: 0 })
  assert.equal(closed.shot, null, 'the next release sees the newly opaque block')
  t.diagnostic(JSON.stringify({ coldReads: old.reads, sharedReads: shared.reads, coldRays: old.rays, sharedRays: shared.rays }))
})

test('radio report aging is bounded without changing the received report', t => {
  const { bot, reports } = fixture(), report = { ...reports[0], gameTick: 480 }, original = structuredClone(report)
  let now = 0
  const simulate = bot.physics.simulatePlayer
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { now += 2; return simulate(...args) })
  assert.equal(windReportAt(bot, report, 500, 10), null)
  assert.ok(now <= 12)
  assert.deepEqual(report, original)
})

test('a local plan and its release share the same visible blocks within one callback', t => {
  t.mock.method(clock, 'now', () => 1000)
  const pass = (shared: boolean) => {
    const { bot, foe, reports, options } = fixture()
    let reads = 0
    const read = bot.blockAt; bot.blockAt = p => { reads++; return read(p) }
    const collision = wind.windCollisionWorld(bot)
    const plan = planEnemyWind(bot, foe, reports, { ...options, ...(shared ? { collision } : {}) })
    assert.ok(plan)
    const frames = wind.enemyWindFrames(bot, foe, options.arena, [], 0, true, collision)
    const shot = enemyWindShot(bot, foe, reports[0], frames, { height: plan.shots[0].aimHeight, allies: reports }, undefined, undefined, collision)
    return { plan, frames, shot, reads }
  }
  const separate = pass(false), shared = pass(true)
  assert.deepEqual({ ...shared, reads: 0 }, { ...separate, reads: 0 })
  assert.ok(shared.reads < separate.reads, `observed block reads ${shared.reads} vs ${separate.reads}`)
  t.diagnostic(`observed block reads ${shared.reads} vs ${separate.reads}`)
})

test('an interrupted ally forecast never caches a partial safety track', t => {
  const { bot, reports, options } = fixture(), tracks = new Map()
  let now = 0
  const simulate = bot.physics.simulatePlayer
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { now += 2; return simulate(...args) })
  const shots = [{ ticks: 65, burst: new Vec3(100, 100, 100) }]
  assert.equal(windTeamSafe(bot, [reports[0]], shots, options.arena, tracks, false, 80), false)
  assert.equal(tracks.size, 0)
  now = 0
  assert.equal(windTeamSafe(bot, [reports[0]], [], options.arena, tracks, false, 1000), true)
  assert.equal(tracks.size, 0, 'an absent explosion needs no unused body forecast')
})

test('an affected ally still stops inside its eighty-tick safety simulation', t => {
  const { bot, reports, options } = fixture()
  let now = 0
  const simulate = bot.physics.simulatePlayer
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { now += 2; return simulate(...args) })
  const shots = [{ ticks: 1, burst: new Vec3(-4.3, 1.25, .5) }]
  assert.equal(windTeamSafe(bot, [reports[0]], shots, options.arena, new Map(), false, 140), false)
  assert.ok(now <= 142)
  assert.ok(now > 130, 'the affected body continues through its postgust safety window')
  now = 0
  assert.equal(windTeamSafe(bot, [reports[0]], shots, options.arena, new Map(), false, 1000), true)
  assert.equal(now, 2 * (1 + 80), 'one required arrival step plus all eighty affected-body safety steps')
})


test('recorded AD prefix finds its alternative native ray while a real body miss avoids allied forecasting', t => {
  const { bot, foe, reports } = fixture(), native = bot.physics.simulatePlayer
  // AD d +1190ms: the logger records only frames 0..32. The remaining flat/support frames here are a control, not a recovered world.
  const positions = [[608.5589238601552,131.54953862212054,601.338363446215],[608.6925756477032,131.37579946011422,601.2962459425676],[608.7888414675361,131.12713507650832,601.2554215375128],[608.8510860567486,130.8050439743058,601.2157738521774],[608.8823713260963,130.410994686478,601.1771969817867],[608.8854836143671,129.946426375365,601.1395945529954],[608.8601263075315,129.41274942008747,601.1028788660598],[608.8116938514754,128.8113459922105,601.0669701142127],[608.7422630096288,128.14357061989435,601.0317956732963],[608.6537236367128,127.41075074076183,600.9972894553268],[608.5477955005236,126.61418724370866,600.963391320239],[608.4260435897559,125.75515499987742,600.9300465405735],[608.2898920441216,124.83490338301219,600.8972053143423],[608.1406368307588,123.85465677940599,600.8648223217363],[607.9794572797631,122.8156150876493,600.8328563217292],[607.8074265815213,121.71895420838374,600.8012697849872],[607.6255213392858,120.56582652426044,600.7700285598163],[607.4346302620158,120,600.7391015681752],[607.134132797671,120,600.698470617194],[606.8432745981095,120,600.6637987293702],[606.5576794371198,120,600.6323804900306],[606.2749578951901,120,600.6027387427633],[605.9938053492674,120,600.5740669601674],[605.7135094751644,120,600.5459247782823],[605.433681343875,120,600.5180717583851],[605.1541086001619,120,600.4903766209333],[604.8746752980653,120,600.4627676872967],[604.5953181310914,120,600.4352058209432],[604.3160025338944,120,600.4076696533264],[604.0367096337957,120,600.3801475172196],[603.7574291263126,120,600.3526330423174],[603.4781553851976,120,600.3251227504329],[603.1988853385196,120,600.2976147424761]]
  const frames = Array.from({ length: 66 }, (_, i) => ({ pos: new Vec3(...positions[Math.min(i, positions.length - 1)] as [number, number, number]), vel: new Vec3(0, 0, 0), onGround: false }))
  const own = { ...reports[0], position: {"x":602.5014237386364,"y":124.37871164756963,"z":604.2696862885549}, velocity: {"x":-0.9386392221685992,"y":0.24697338749962114,"z":-0.7732163063490612},
    launchMovement: {"x":-0.9386392221686037,"y":0.24697338749962228,"z":-0.7732163063490134}, onGround: false, gliding: true, eyeHeight: .4, gameTick: 500 }
  bot.entity.position = new Vec3(own.position.x, own.position.y, own.position.z)
  foe.position = frames[0].pos.clone()
  const team = [own, ...Array.from({ length: 19 }, (_, i) => ({ ...reports[0], id: 'Blue' + i, position: { x: 590 + i, y: 120, z: 630 } }))]
  let steps = 0, reads = 0
  const read = bot.blockAt
  bot.blockAt = p => { reads++; return read(p) }
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return native(...args) })
  const found = enemyWindShot(bot, foe, own, frames, { height: 0.5033391207344238, allies: team })
  assert.ok(found, 'the original four-guess miss is not proof that every supplied-frame ray misses')
  assert.equal(found.ticks, 12, 'the actual recorded prefix suffices before the synthetic flat completion')
  assert.ok(found.feet.equals(frames[12].pos))
  assert.ok(steps > 0 && steps <= team.length * 65, 'a viable alternative shares bounded allied native tracks')
  steps = 0; reads = 0
  const unreachable = frames.map(frame => ({ ...frame, pos: frame.pos.offset(1000, 0, 0) }))
  assert.equal(enemyWindShot(bot, foe, own, unreachable, { height: 0.5033391207344238, allies: team }), null)
  assert.equal(steps, 0, 'a target-only miss must not integrate any allied body')
  assert.equal(reads, 0, 'a target-only miss needs no collision world')
})

test('target-only preflight checks all sixty-five supplied flight ticks', () => {
  const { bot, foe, reports } = fixture()
  foe.position = new Vec3(95.4, 2.5, .5)
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const shot = enemyWindShot(bot, foe, reports[0], frames, { height: .4 })
  assert.ok(shot)
  assert.equal(shot.ticks, 65)
  assert.equal(enemyWindShot(bot, foe, reports[0], frames.slice(0, 65), { height: .4 }), null, 'the unavailable final tick cannot be invented')
})
