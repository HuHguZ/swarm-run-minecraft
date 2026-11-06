import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

function fixture(adapted = false) {
  let tick = 100, visible = true, safe = true, blocked = false, defence = false, pending: boolean | number = false, framesInput: any, pendingInput: any
  const from = new Vec3(0, 65.62, 0), feet = new Vec3(4, 65, 0), burst = new Vec3(3.7, 66, 0)
  const shot = { thrower: 'Blue', fireTick: 103, arrivalTick: 106, fireDelay: 3, ticks: 3, from, aim: feet.offset(0, 1, 0), feet, burst, velocity: new Vec3(1.5, 0, 0), yaw: 0, pitch: 0 }
  const plan = { target: 'Red', targetAt: feet, gameTick: 100, resistance: { lo: 0, hi: 0 }, shots: [shot], nominal: { progress: 3 }, baseline: { progress: 0 } }
  const foe: any = { id: 2, username: 'Red', position: feet, velocity: new Vec3(0, .2, 0), onGround: false, equipment: [], width: .6, height: 1.8 }
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'Blue', health: 20, entity: { id: 1, username: 'Blue', position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, attributes: {}, effects: {} },
    players: { Red: { entity: foe } }, entities: { 2: foe }, _client: new EventEmitter(), quickBarSlot: 1,
    registry: { entitiesByName: { wind_charge: { id: 143 } } }, ndClock: { get age() { return BigInt(tick) }, ticks: 0, serverTicks: 0 },
    inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 4 }] },
    getControlState: () => false, look: async () => {}, setQuickBarSlot: n => { bot.quickBarSlot = n },
    activateItem: () => { calls.push({ tick, slot: bot.quickBarSlot }); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
  })
  const calls: any[] = [], session: any = { bot, current: { name: 'fight', ctl: { aborted: false } }, require: () => bot, state: () => ({}) }
  const ctl = { aborted: false, onAbort: [] as (() => void)[], waitReflex: async () => {}, abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const file = path.resolve(__dirname, '../src/combat/enemy-wind-execute.js'), module = { exports: {} as any }
  const req = stubRequire(file, {
    './team-wind': { ...require('../src/combat/team-wind'), worldTick: () => tick, windInside: () => true },
    './enemy-wind': { WIND_FORECAST_TICKS: require('../src/combat/enemy-wind').WIND_FORECAST_TICKS,
      windCollisionWorld: b => { assert.equal(b, bot); return { blockAt: () => ({ observed: true }) } },
      planEnemyWind: (_b, e, reports, options) => ({ ...plan, gameTick: tick, received: { e, reports, options } }),
      installWindTracking: () => {}, windMotionFresh: (_b, e) => !e.pendingWindObservation,
      enemyWindFrames: (_b, _e, _a, shots) => { framesInput = shots; return [{}] },
      enemyWindShot: () => blocked ? null : { ...shot, fireDelay: 0 },
      pendingWindHit: (_b, _e, _f, scheduled) => { pendingInput = scheduled; return pending ? { id: 9, ticks: pending === true ? 1 : pending } : null },
      observeOwnWindBurst: require('../src/combat/enemy-wind').observeOwnWindBurst,
      windTeamSafe: proxy => { assert.notEqual(proxy, bot); assert.deepEqual(proxy.blockAt(new Vec3(0, 0, 0)), { observed: true }); return safe }, windReportAt: (_b, r) => r },
    '../pvp/last-seen': { seesPlayer: (_b, e) => !!e && visible, createLastSeen: () => ({ observe: e => e, visible: () => visible, close: () => {} }) },
    '../mace/hands': { install: () => {}, windCount: () => 4, windReady: () => true, hotbarIndex: () => 0, offWind: () => false, ensureHotbar: async () => true },
    '../reflex-lock': { owner: () => defence ? { owner: 'Emergency' } : null },
    '../edges': { afterPacket: adapted ? require('../src/edges').afterPacket : (_b, f) => setImmediate(f), worldOf: world => ({ getBlock: p => world.blockAt(p) }) },
    '../pvp/search': { observedCollision: () => ({ blockAt: () => ({ observed: true }) }) },
    '../pick': { eyeHeight: () => 1.62 }, '../game-clock': { now: () => tick * 50, wall: { monotonic: () => 1000 } }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const params = { plan, arena: { x: 0, z: 0, r: 8, killY: 40 }, allies: [] }
  return { api: module.exports, bot, session, ctl, calls, plan, shot, params, set: (p: any) => { if ('visible' in p) visible = p.visible; if ('safe' in p) safe = p.safe; if ('blocked' in p) blocked = p.blocked; if ('defence' in p) defence = p.defence; if ('tick' in p) tick = p.tick; if ('pending' in p) pending = p.pending },
    get pendingInput() { return pendingInput },
    get framesInput() { return framesInput }, async run(hook = (_t: number) => {}) {
      let done = false, result: any
      const pending = module.exports.enemyWindExecute(session, ctl, params).then(r => { done = true; result = r })
      for (let n = 0; n < 20 && !done; n++) { await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r)); if (done) break; tick++; hook(tick); bot.emit('physicsTick') }
      await new Promise<void>(r => setImmediate(r)); assert.equal(done, true); await pending
      assert.equal(ctl.onAbort.length, 0); assert.equal(bot.listenerCount('physicsTick'), 0)
      assert.equal(bot._client.listenerCount('explosion'), 0); assert.equal(bot._client.listenerCount('set_cooldown'), 0)
      return result
    }
  }
}

test('wind out keeps the current fight and releases once on the absolute shared tick with a launch receipt', async () => {
  const f = fixture(), current = f.session.current
  const activate = f.bot.activateItem
  Object.assign(f.bot.entity, { elytraFlying: true, yaw: .8, pitch: .2 })
  f.bot.version = '1.21.11'
  f.shot.yaw = .3; f.shot.pitch = -.1
  f.bot.look = () => { throw new Error('the release must use the use_item angles') }
  f.bot.activateItem = () => {
    assert.equal(f.bot.entity.yaw, f.shot.yaw); assert.equal(f.bot.entity.pitch, f.shot.pitch)
    activate()
  }
  const r = await f.run()
  assert.equal(r.fired, true); assert.equal(r.launchConfirmed, true); assert.equal(r.burstSeen, false)
  assert.deepEqual(f.calls, [{ tick: 103, slot: 0 }]); assert.equal(f.bot.quickBarSlot, 1)
  assert.deepEqual([f.bot.entity.yaw, f.bot.entity.pitch], [.8, .2], 'the weapon aim cannot steer the next flight frame')
  assert.equal(f.session.current, current); assert.equal(r.killed, undefined)
})

test('a shared throw keeps its intent on the scheduled movement frame during a catch-up batch', async () => {
  const f = fixture(true), order = { target: 'Red', coordination: 'catch-up' }
  assert.equal(f.api.enemyWindReport(f.session, order).ok, true)
  Object.assign(f.params, { coordination: order.coordination })
  f.plan.shots.push({ ...f.shot, thrower: 'Other', fireTick: 104, arrivalTick: 107, fireDelay: 4 })
  const scope = new AsyncLocalStorage<string>(), activate = f.bot.activateItem
  const contexts: Array<string | undefined> = []
  f.bot.activateItem = () => { contexts.push(scope.getStore()); activate() }
  const result = await scope.run('wind_out', () => f.run(tick => {
    if (tick !== 102) return
    scope.exit(() => {
      for (const frame of [102, 103, 104]) {
        f.set({ tick: frame }); f.bot.emit('physicsTick'); f.bot.emit('ndMovementSent')
      }
    })
  }))
  assert.equal(result.fired, true, result.why)
  assert.deepEqual(f.calls, [{ tick: 103, slot: 0 }])
  assert.deepEqual(contexts, ['wind_out'])
  assert.equal(f.bot.listenerCount('ndMovementSent'), 0)
})

test('a queued shared throw rechecks cancellation, ownership and clock after movement', async () => {
  for (const mode of ['abort', 'owner', 'clock']) {
    const f = fixture(true)
    const result = await f.run(tick => {
      if (tick !== 103) return
      f.bot.emit('physicsTick')
      if (mode === 'abort') f.ctl.abort()
      if (mode === 'owner') f.session.current = { name: 'evade', ctl: { aborted: false } }
      if (mode === 'clock') f.set({ tick: null })
      f.bot.emit('ndMovementSent')
    })
    assert.equal(result.fired, false, mode)
    assert.deepEqual(f.calls, [])
    assert.equal(f.bot.listenerCount('ndMovementSent'), 0)
  }
})

test('a coordinated throw cannot fire after its order is cancelled or the body respawns', async () => {
  for (const reason of ['cancel', 'respawn']) {
    const f = fixture(), report = { target: 'Red', coordination: 'order' }
    assert.equal(f.api.enemyWindReport(f.session, report).coordination, 'order')
    assert.equal(f.api.enemyWindReport(f.session, { ...report, coordination: 'another' }).ok, false)
    Object.assign(f.params, { coordination: 'order' })
    const result = await f.run(tick => {
      if (tick !== 102) return
      if (reason === 'respawn') f.bot.emit('respawn')
      else f.api.enemyWindReport(f.session, { ...report, cancel: true })
    })
    assert.equal(result.fired, false)
    assert.deepEqual(f.calls, [])
  }
})

test('a scheduled release may arrive before an unrelated later gust, but not on its tick', async () => {
  for (const pending of [2, 3, 4]) {
    const f = fixture()
    f.set({ pending })
    const result = await f.run()
    assert.equal(result.fired, pending === 4)
    if (pending !== 4) assert.equal(result.why, 'pending_wind_impulse')
  }
})

test('replacement probe checks live sight and hands under the exact order without renewing it', () => {
  const f = fixture(), report = { target: 'Red', coordination: 'order' }, probe = { ...report, probe: true }
  assert.equal(f.api.enemyWindReport(f.session, probe).ok, false)
  assert.equal(f.api.enemyWindReport(f.session, report).ok, true)
  assert.deepEqual(f.api.enemyWindReport(f.session, probe), { ok: true, ready: true, gameTick: 100, coordination: 'order', targetVisible: true })
  f.set({ tick: 101, visible: false, defence: true })
  assert.deepEqual(f.api.enemyWindReport(f.session, probe), { ok: true, ready: false, gameTick: 101, coordination: 'order', targetVisible: false })
  assert.equal(f.api.enemyWindReport(f.session, { ...probe, target: 'Other' }).ok, false)
  f.set({ tick: 100 + 21 + require('../src/combat/enemy-wind').WIND_FORECAST_TICKS })
  assert.equal(f.api.enemyWindReport(f.session, probe).ok, false)
  assert.deepEqual(f.calls, [])
})

test('an ordered single shooter can reprice a late launch with its current physical frame', async () => {
  const f = fixture()
  f.set({ tick: 104 })
  const order = { target: 'Red', coordination: 'order' }
  assert.equal(f.api.enemyWindReport(f.session, order).ok, true)
  Object.assign(f.params, order)
  const result = await f.run()
  assert.equal(result.fired, true)
  assert.deepEqual(f.calls, [{ tick: 104, slot: 0 }])
})

test('a real native glider report has a safe physical wind ray with movement inheritance and native cooldown', () => {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const core = require('../src/combat/enemy-wind'), api = require('../src/combat/enemy-wind-execute'), edges = require('../src/edges')
  const read = p => { const b = Block.fromStateId(registry.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState); b.position = p.floored(); return b }
  const slots: any[] = []; slots[6] = { name: 'elytra' }; slots[36] = { name: 'wind_charge', count: 64, slot: 36 }
  const foe: any = { id: 2, username: 'Red', name: 'player', type: 'player', isValid: true, position: new Vec3(4, 64, 0),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, metadata: [], equipment: [] }
  const bot: any = Object.assign(new EventEmitter(), { username: 'Blue', version: '1.21.11', registry, health: 20, food: 20,
    game: { minY: -64, height: 384 }, _client: new EventEmitter(), ndClock: { age: 100n, ticks: 0, serverTicks: 0 },
    inventory: { slots, items: () => [slots[6], slots[36]] }, getControlState: () => false, jumpTicks: 0, jumpQueued: false,
    fireworkRocketDuration: 0, blockAt: read, players: { Red: { entity: foe, gamemode: 0 } }, entities: { 2: foe },
    entity: { id: 1, username: 'Blue', position: new Vec3(-6, 65.5, 0), velocity: new Vec3(.6, -.1, 0), onGround: false,
      elytraFlying: true, metadata: [128], yaw: -Math.PI / 2, pitch: 0, height: .6, width: .6, effects: {}, attributes: {} } })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: read })
  const state = edges.stateOf(bot), before = state.pos.clone(); edges.simOf(bot)(state, edges.worldOf(bot))
  Object.assign(bot.entity, { position: state.pos.clone(), velocity: state.vel.clone(), onGround: state.onGround })
  bot._ndLaunchMovement = () => state.pos.minus(before)
  const session = { bot, current: { name: 'wing_orbit', ctl: { aborted: false }, params: { target: 'Red' } } }, arena = { x: 0, z: 0, r: 80, killY: 40 }
  const report = api.enemyWindReport(session, { flying: true }), frames = core.enemyWindFrames(bot, foe, arena)
  assert.equal(report.ready, true); assert.deepEqual(report.report.launchMovement, { ...state.pos.minus(before) })
  const shot = core.enemyWindShot(bot, foe, report.report, frames, { height: 1.6, allies: [report.report] })
  assert.ok(shot); assert.equal(core.windTeamSafe(bot, [report.report], [shot], arena), true)
  assert.equal(api.enemyWindReport(session).ready, false, 'flight permission must be explicit in a report')
  for (const unknown of [false, true]) {
    bot.blockAt = p => { if (Math.floor(p.x) !== 0) return read(p); if (unknown) return null
      const b = read(p.offset(0, -100, 0)); b.position = p.floored(); return b }
    assert.equal(core.enemyWindShot(bot, foe, report.report, frames, { height: 1.6 }), null, 'wall/unknown remain physical blockers')
  }
  bot.blockAt = read; bot._ndWindCd = Infinity
  assert.equal(api.enemyWindReport(session, { flying: true }).ready, false)
})

test('an atomic scheduled wind throw runs beside its actual native glider movement owner', async () => {
  const f = fixture(); f.bot.entity.elytraFlying = true; f.bot.entity.onGround = false; f.session.current.name = 'wing_orbit'
  const owner = f.session.current, r = await f.run()
  assert.equal(r.fired, true); assert.equal(r.launchConfirmed, true); assert.equal(f.session.current, owner)
})

test('flying scheduled throws retain final safety, held hands, shield and actual native flight checks', async () => {
  for (const mode of ['visible', 'blocked', 'safe', 'pending', 'defence', 'held', 'shield', 'lost_native_flight']) {
    const f = fixture(); f.bot.entity.elytraFlying = true; f.bot.entity.onGround = false; f.session.current.name = 'wing_orbit'
    const r = await f.run(t => {
      if (t !== 103) return
      if (mode === 'held') f.bot.usingHeldItem = true
      else if (mode === 'shield') { f.session.current.name = 'swarm_hold'; f.session.current.params = { whileSmash: true } }
      else if (mode === 'lost_native_flight') { f.bot.entity.elytraFlying = false; f.session.current.name = 'fly_to' }
      else f.set({ [mode]: !['visible', 'safe'].includes(mode) })
    })
    assert.equal(r.fired, false, mode); assert.equal(f.calls.length, 0, mode)
  }
})

test('missed shared tick and an invalid schedule never send a late charge', async () => {
  for (const options of [{ tick: 104 }, { tick: 100, bad: true }]) {
    const f = fixture(); f.set(options); if (options.bad) f.shot.arrivalTick = 102
    const r = await f.run(); assert.equal(r.fired, false); assert.equal(f.calls.length, 0)
  }
})

test('release accepts a native flight beyond thirty ticks within the available body forecast', async () => {
  const f = fixture(); f.shot.ticks = 40; f.shot.arrivalTick = f.shot.fireTick + 40
  const r = await f.run(t => { if (t === 104) f.ctl.abort() })
  assert.equal(r.fired, true); assert.equal(r.arrivalTick, 143)
  assert.deepEqual(f.calls, [{ tick: 103, slot: 0 }])
  const unknown = fixture(); unknown.shot.ticks = 66; unknown.shot.arrivalTick = unknown.shot.fireTick + 66
  assert.equal((await unknown.run()).why, 'invalid_schedule', 'execution cannot certify an absent body forecast')
  assert.equal(unknown.calls.length, 0)
})

test('fresh visibility, native ray, friendly blast and unscheduled wind impulse are checked again at release', async () => {
  for (const change of [{ visible: false }, { blocked: true }, { safe: false }, { defence: true }, { pending: true }, { motion: true }]) {
    const f = fixture(), r = await f.run(t => { if (t === 103) { f.set(change); f.bot.players.Red.entity.pendingWindObservation = 'motion' in change } })
    assert.equal(r.fired, false); assert.equal(f.calls.length, 0)
  }
})

test('cancellation unhooks a scheduled shot without waiting for another physical frame', async () => {
  const f = fixture(), pending = f.api.enemyWindExecute(f.session, f.ctl, f.params)
  await new Promise<void>(r => setImmediate(r)); f.ctl.abort()
  const r = await pending
  assert.equal(r.fired, false); assert.equal(f.calls.length, 0); assert.equal(f.ctl.onAbort.length, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('plan is made from a fresh fair local view and shared ticks, not driver floor positions', async () => {
  const f = fixture(), own = f.api.enemyWindReport(f.session)
  assert.equal(own.gameTick, 100); assert.equal(own.report.position.y, 64)
  const r = await f.api.enemyWindPlan(f.session, { target: 'Red', throwers: [own.report], allies: [own.report], arena: f.params.arena, leadTicks: 4 })
  assert.equal(r.plan.received.options.startTick, 104); assert.equal(r.plan.target, 'Red')
  assert.equal(r.plan.received.options.waitForHit, true, 'the shared plan must end before a visible incoming gust invalidates the trajectory')
  f.set({ visible: false }); assert.equal((await f.api.enemyWindPlan(f.session, { target: 'Red', throwers: [own.report], arena: f.params.arena })).ok, false)
})

test('a matching distant gust needs the own native projectile removal, not knockback to the thrower', async () => {
  for (const own of [true, false]) {
    const f = fixture(), r = await f.run(t => {
      if (t === 104) f.bot._client.emit('spawn_entity', { entityId: 90, type: 143, objectData: f.bot.entity.id })
      if (t === 106) {
        f.bot._client.emit('explosion', { center: f.shot.burst, radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, playerKnockback: new Vec3(0, 0, 0) })
        f.bot._client.emit('entity_destroy', { entityIds: [own ? 90 : 91] })
      }
    })
    assert.equal(r.burstSeen, own); assert.equal(r.launchConfirmed, true)
    assert.equal(f.bot._client.listenerCount('spawn_entity'), 0); assert.equal(f.bot._client.listenerCount('entity_destroy'), 0)
  }
})

test('RPC radio does not drain observations and wind_out uses the beside intent contract', async () => {
  const file = path.resolve(__dirname, '../src/rpc/aerial.js'), module = { exports: {} as any }, calls: any[] = []
  const session: any = { state: () => ({ own: true }), immediate: () => { throw new Error('radio must not drain events') },
    runIntent: async (name, fn, options) => { calls.push({ name, options }); return fn({ aborted: false }) } }
  const req = stubRequire(file, { '../combat/enemy-wind-execute': {
    enemyWindReport: () => ({ gameTick: 100 }), enemyWindPlan: async (_s, p) => { await Promise.resolve(); return { target: p.target } }, enemyWindExecute: (_s, _ctl, p) => ({ fired: p.test })
  } })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const methods = module.exports.aerialMethods({ session })
  assert.deepEqual((await methods.wind_report()).events, []); assert.equal((await methods.enemy_wind_plan({ target: 'Red' })).detail.target, 'Red')
  assert.equal((await methods.wind_out({ test: true })).fired, true)
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'wind_out'); assert.equal(calls[0].options.exclusive, false)
  assert.equal(calls[0].options.timeoutMs, 5000); assert.deepEqual(calls[0].options.interruptOn, ['death', 'kicked', 'disconnected'])
})

for (const mode of ['coast', 'sprint', 'gust', 'LOS gap', 'last-pose reacquire', 'last-pose absolute', 'new motion', 'disjoint history', 'owner', 'clock', 'frozen', 'death', 'abort']) test(`JSON radio timed native launch beside a fight: ${mode}`, async t => {
  const running = mode === 'sprint', fires = mode === 'coast' || running
  const clock = require('../src/game-clock'), game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const native = require('../src/tick-plugins').getPhysics(), core = require('../src/combat/enemy-wind'), api = require('../src/combat/enemy-wind-execute')
  // The running baseline stays on support: this case tests a useful timed launch, not an already doomed sprint into the tiny fixture's void.
  const world = { getBlock(p) { const q = p.floored(), name = q.y === 0 && q.x >= (running ? -100 : -8) && q.x <= (running ? 100 : 4) && Math.abs(q.z) <= 5 ? 'stone' : 'air'; const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block } }
  const charge = { ...registry.itemsByName.wind_charge, type: registry.itemsByName.wind_charge.id, count: 4, slot: 36 }, slots = Array(46).fill(null); slots[36] = charge
  const foe: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', isValid: true, position: new Vec3(running ? 4.2 : 3.5, 2.5, .5), velocity: new Vec3(running ? -.28 : .08, running ? .6 : .2, 0), onGround: false, height: 1.8, width: .6, equipment: [], metadata: [running ? 8 : 0] }
  const calls: number[] = [], bot: any = Object.assign(new EventEmitter(), {
    username: 'A', version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 }, entities: { 2: foe }, players: { Enemy: { entity: foe } },
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    inventory: { slots, items: () => [charge] }, blockAt: p => world.getBlock(p), physics: native.Physics(registry, world), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, _client: new EventEmitter(), getControlState: () => false,
    quickBarSlot: 1, setQuickBarSlot(n) { this.quickBarSlot = n }, look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    activateItem: () => { calls.push(500 + bot.ndClock.ticks - 20); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
  })
  const session: any = { bot, current: { name: 'fight', ctl: { aborted: false } } }, ctl = { aborted: false, onAbort: [], waitReflex: async () => {} }, arena = { x: -1.5, z: .5, r: running ? 80 : 6.5, killY: -10 }
  try {
    api.enemyWindReport(session, { target: 'Enemy' })
    const edges = require('../src/edges'), nativeState = edges.stateOf({ ...bot, entity: { ...foe, effects: {}, attributes: {}, yaw: Math.PI / 2, pitch: 0 } },
      running ? { ...edges.IDLE, forward: true, sprint: true } : edges.IDLE)
    for (let tick = 0; tick < 2; tick++) {
      edges.simOf(bot)(nativeState, world)
      foe.position = nativeState.pos.clone(); foe.velocity = nativeState.vel.clone(); foe.onGround = nativeState.onGround
      game.advanceTicks(1); bot.ndClock.ticks++
      foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1], { ...foe.position, t: clock.observationNow(), grounded: foe.onGround, kind: 'rel_entity_move' }]
      bot.emit('physicsTick')
      core.enemyWindFrames(bot, foe, arena) // The production estimator observes each actual native interval before planning the timed cast.
    }
    const report = api.enemyWindReport(session).report, proposal = await api.enemyWindPlan(session, { target: 'Enemy', throwers: [report], allies: [report], arena, leadTicks: 4, maxShots: 1 })
    assert.ok(proposal.plan, 'fresh, measured airborne view must produce a native plan')
    const plan = JSON.parse(JSON.stringify(proposal.plan)), frames = core.enemyWindFrames(bot, foe, arena)
    const motion = core.observeEnemyWindMotion, forecast = core.enemyWindFrames
    let fullForecasts = 0, invalid = false, invalidMotionReads = 0, changed: any = null
    t.mock.method(core, 'enemyWindFrames', (...args) => { fullForecasts++; return forecast(...args) })
    t.mock.method(core, 'observeEnemyWindMotion', (...args) => { if (invalid) invalidMotionReads++; return motion(...args) })
    let done = false, result: any
    const pending = api.enemyWindExecute(session, ctl, { plan, arena, allies: [report] }).then(r => { done = true; result = r })
    for (let tick = 0; tick < 45 && !done; tick++) {
      await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r)); if (done) break
      const frame = frames[tick + 1]
      if (changed) { edges.simOf(bot)(changed, world); foe.position = changed.pos.clone(); foe.velocity = changed.vel.clone(); foe.onGround = changed.onGround }
      else { foe.position = frame.pos.clone(); foe.velocity = frame.vel.clone(); foe.onGround = frame.onGround }
      game.advanceTicks(1); bot.ndClock.ticks++
      const until = plan.shots[0].fireTick - (500 + bot.ndClock.ticks - 20)
      const kind = mode === 'disjoint history' && until === 2 || mode === 'last-pose absolute' && until === 0 ? 'sync_entity_position' : 'rel_entity_move'
      foe._ndPositionReceipts = [foe._ndPositionReceipts[1], { ...foe.position, t: clock.observationNow(), grounded: foe.onGround, kind }]
      if (mode === 'LOS gap') foe.isValid = until > 2 || until <= 1
      if (mode === 'last-pose reacquire') foe.isValid = until > 2 || until === 0
      if (until === 1) {
        if (mode === 'gust') bot._client.emit('explosion', { center: foe.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
        if (mode === 'new motion') changed = edges.stateOf({ ...bot, entity: { ...foe, effects: {}, attributes: {},
          velocity: foe.velocity.offset(.2, 1, -.1), yaw: 0, pitch: 0 } }, edges.IDLE)
        if (mode === 'owner') { session.current = { name: 'evade', ctl: { aborted: false } }; invalid = true }
        if (mode === 'clock') { bot.ndClock = { ...bot.ndClock }; invalid = true }
        if (mode === 'frozen') { bot.ndClock.frozen = true; invalid = true }
        if (mode === 'death') { bot.health = 0; invalid = true }
        if (mode === 'abort') { ctl.aborted = true; invalid = true }
      }
      bot.emit('physicsTick')
    }
    await pending
    assert.equal(result.fired, fires, JSON.stringify(result))
    if (fires) { assert.equal(result.launchConfirmed, true); assert.deepEqual(calls, [plan.shots[0].fireTick]); assert.equal(fullForecasts, 1, 'the packet callback owns the only full release forecast') }
    else assert.deepEqual(calls, [], 'unknown motion or a changed active owner cannot authorize the timed hand action')
    assert.equal(invalidMotionReads, 0, 'invalidated active consumers stop updating motion after their awaited tick')
    assert.equal(session.current.name, mode === 'owner' ? 'evade' : 'fight')
    bot.emit('end'); assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(ctl.onAbort.length, 0)
  } finally { bot.emit('end'); game.dispose() }
})
