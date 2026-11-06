import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'
import { afterPacket } from '../src/mace/hands'
import { windMovement, windOutward, worldTick } from '../src/combat/team-wind'
import { cancelWindOrder, reserveWindOrder } from '../src/combat/wind-coordination'

function fixture(planMs = 35, adapted = true, releaseMs = 0, fall?: { atRelease: boolean }, rim?: { atRelease: boolean; feetDelta: number }, inward?: 'alternate' | 'lift' | 'none') {
  let now = 0, sent = new Vec3(0, 0, 0), moved = false, visible = true, useful = true, throwing = false, relay = false, smash = false, lateLift = false, earlyLift = false
  const events: string[] = [], plans: any[] = [], shots: any[] = []
  const foe: any = { id: 2, username: 'Enemy', type: 'player', position: new Vec3(4, 5, .5), velocity: new Vec3(.1, .2, 0),
    onGround: false, width: .6, height: 1.8, metadata: [], equipment: [],
    _ndPositionReceipts: [{ x: 3.9, y: 4.8, z: .5, t: 950 }, { x: 4, y: 5, z: .5, t: 1000 }] }
  const bot: any = Object.assign(new EventEmitter(), { username: 'Blue', health: 20,
    entity: { id: 1, username: 'Blue', position: new Vec3(0, 0, .5), velocity: new Vec3(.9, -.0784, .2), onGround: true, metadata: [] },
    ndClock: { age: 500n, ticks: 0, serverTicks: 0, frozen: false, disposed: false, observationNow: () => 1000 + now, observationRate: () => 20 },
    players: { Enemy: { entity: foe, gamemode: 0 } }, entities: { 2: foe }, inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 8 }] },
    _client: new EventEmitter(), getControlState: () => false, equip: async () => { events.push('shield_equip') },
    blockAt: p => ({ name: p.y < 0 ? 'stone' : 'air', boundingBox: p.y < 0 ? 'block' : 'empty' }),
    activateItem: () => events.push('use_item') })
  if (adapted) bot._ndLaunchMovement = () => sent.clone()
  const owner = { name: 'fight', ctl: { aborted: false } }, session: any = { bot, current: owner,
    _rescue: { arena: { x: 0, y: 0, z: 0, r: 80 }, killY: -64 } }
  if (inward) {
    foe.position = new Vec3(573.3499893432494, 145.99113616038323, 574.3494140505791)
    session._rescue.arena = { x: 600.5, y: 120, z: 600.5, r: 77, ellipse: { a: 77, b: 65 } }
  }
  const report = () => ({ id: bot.username, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity },
    launchMovement: { ...windMovement(bot) }, onGround: bot.entity.onGround, eyeHeight: 1.62, gameTick: worldTick(bot) })
  const shot = own => ({ thrower: own.id, fireDelay: 0, ticks: 3, from: new Vec3(own.position.x, own.position.y + 1.62, own.position.z),
    aim: foe.position.offset(0, .4, 0), feet: foe.position.clone(), burst: foe.position.offset(inward ? .5 : -.5, .4, 0),
    velocity: new Vec3(1.5, .1, 0), yaw: 0, pitch: 0 })
  // The actual CD #1123 ray at release. The earlier utility plan was not captured.
  const reaim = own => ({ ...shot(own), ticks: 14, aimHeight: 1.6, yaw: 2.8371551764511445, pitch: 1.3230615116034032,
    from: new Vec3(577.9253049880568, 125.62, 568.0387917704294), aim: new Vec3(573.5986561939295, 146.33652858577753, 575.9248996350485),
    feet: new Vec3(573.5986561939295, 144.73652858577753, 575.9248996350485), burst: new Vec3(573.9278413094033, 144.76034961234598, 575.3248996231276) })
  let queued = 0, forecasts = 0
  let releaseCertificate: 'exact' | 'different' | 'expired' | undefined, safetyChecks = 0, safetyMs = 0
  const impactKey = s => [s.fireDelay + s.ticks, s.burst.x, s.burst.y, s.burst.z].join(',')
  const file = path.resolve(__dirname, '../src/combat/wind-out.js'), module = { exports: {} as any }
  const req = stubRequire(file, {
    '../game-clock': { now: () => 1000 + now, wall: { monotonic: () => now } },
    '../mace/hands': { install() {}, windReady: () => true, windCooling: () => false, windCount: () => 8, offWind: () => true, hotbarIndex: () => 0,
      afterPacket: (b, fn) => { queued++; afterPacket(b, fn) } },
    './enemy-wind-execute': { enemyWindReport: () => ({ ok: bot.health > 0, ready: !bot.usingHeldItem, report: report() }) },
    './enemy-wind': { installWindTracking() {}, windMotionFresh: () => true, windCollisionWorld: () => bot,
      windGroundObservationExpired: (...args) => require('../src/combat/enemy-wind').windGroundObservationExpired(...args), windImpactKey: impactKey,
      planEnemyWind: (_b, _foe, reports, options) => {
        events.push('plan'); plans.push({ moved, at: now, report: structuredClone(reports[0]), options })
        if (throwing) throw Error('bounded native failure')
        now += planMs
        if (!useful || rim && options.delays[0] === 0 && !rim.atRelease) return null
        const atRelease = options.delays[0] === 0
        if (atRelease && inward === 'none') return null
        const ray = inward === 'lift' && atRelease ? reaim(reports[0]) : shot(reports[0])
        if (rim && options.delays[0] === 0) ray.feet.x += rim.feetDelta
        const selected = { ...ray, fireDelay: options.delays[0] }
        if (atRelease && releaseCertificate === 'expired') now += 125
        return { targetAt: foe.position.clone(), gameTick: worldTick(bot), fallThreat: !!fall && (plans.length === 1 || fall.atRelease), repriceRim: !!rim, lateLift, earlyLift,
          resistance: { lo: 0, hi: 0 }, baseline: { out: false, progress: relay ? 2 : 0, air: 10, outwardEffect: 0 },
          nominal: { out: false, exited: false, progress: 1, air: 15, outwardEffect: 1 }, worst: { out: false, exited: false, progress: 0 },
          shots: [selected], ...(options.certifyRelease && releaseCertificate && { releaseSafeKey: releaseCertificate === 'different' ? 'different' : impactKey(selected) }) }
      },
      enemyWindFrames: () => { forecasts++; return [{}] }, enemyWindShot: (_b, _e, own) => {
        const ray = inward ? reaim(own) : shot(own)
        shots.push({ ...structuredClone(own), ray }); return ray
      },
      pendingWindHit: () => { now += releaseMs; return null }, windTeamSafe: () => { safetyChecks++; now += safetyMs; return true }, observeOwnWindBurst: () => () => {} },
    './ally-safety': { isAlly: () => false }, '../pvp/last-seen': { seesPlayer: () => visible },
    '../pvp/search': { observedCollision: () => bot }, '../bow/track': { observedVelocity: () => ({ x: .1, y: .2, z: 0 }) },
    '../elytra/track': { gliding: () => false }, '../threats': { smashes: () => smash ? [{ name: 'Enemy', ticks: 9 }] : [] }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  module.exports.installWindOut(session)
  const enqueue = () => { bot.emit('physicsTick'); bot.emit('physicsTick') }
  const movement = (delay = 96) => {
    now += delay; events.push('other physics handlers')
    bot.entity.position = new Vec3(.25, .5, .5); bot.entity.onGround = false
    sent = new Vec3(.25, .5, 0); moved = true
    events.push('position_look', 'tick_end'); bot.emit('ndMovementSent')
  }
  return { bot, foe, session, plans, shots, events, enqueue, movement, get queued() { return queued }, get forecasts() { return forecasts }, get safetyChecks() { return safetyChecks },
    set(p: any) {
      if ('visible' in p) visible = p.visible
      if ('useful' in p) useful = p.useful
      if ('throwing' in p) throwing = p.throwing
      if ('now' in p) now = p.now
      if ('relay' in p) relay = p.relay
      if ('lateLift' in p) lateLift = p.lateLift
      if ('earlyLift' in p) earlyLift = p.earlyLift
      if ('releaseCertificate' in p) releaseCertificate = p.releaseCertificate
      if ('safetyMs' in p) safetyMs = p.safetyMs
      if ('smash' in p) { smash = p.smash; session._ndFoes = ['Enemy']; bot.inventory.items = () => [{ name: 'shield' }] }
    },
    clean() { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners() } }
}

test('a dangerous fall shot needs the lower landing to remain useful at actual release', t => {
  for (const atRelease of [true, false]) {
    const f = fixture(15, true, 0, { atRelease }); t.after(f.clean)
    f.enqueue(); f.movement(0)
    assert.equal(f.plans.length, 2)
    assert.deepEqual(f.plans[1].options.delays, [0])
    assert.equal(f.events.includes('use_item'), atRelease)
    assert.equal(f.shots.length, 0, 'a plain re-aim alone is not a fall certificate')
  }
})

test('a rim shot follows a fresh certified landing beyond the earlier aim', t => {
  for (const atRelease of [true, false]) {
    const f = fixture(15, true, 0, undefined, { atRelease, feetDelta: 3 }); t.after(f.clean)
    f.enqueue(); f.movement(0)
    assert.deepEqual(f.plans.map(p => p.options.delays[0]), [1, 0])
    assert.equal(f.events.includes('use_item'), atRelease)
    assert.equal(f.shots.length, 0, 'a changed aim cannot replace the physical landing check')
    assert.equal(f.forecasts, 0, 'the fresh plan owns the pending-hit forecast; release must not simulate it twice')
  }
})

test('a fresh local reprice reuses only an exact ally certificate and still obeys the deadline', t => {
  for (const releaseCertificate of ['exact', 'different', 'expired'] as const) {
    const f = fixture(15, true, 0, undefined, { atRelease: true, feetDelta: 3 }); t.after(f.clean)
    f.set({ releaseCertificate }); f.enqueue(); f.movement(0)
    assert.deepEqual(f.plans.map(p => p.options.certifyRelease), [undefined, true])
    assert.equal(f.safetyChecks, releaseCertificate === 'different' ? 1 : 0)
    assert.equal(f.events.includes('use_item'), releaseCertificate !== 'expired')
    if (releaseCertificate === 'expired') assert.equal(f.session._windOut.log.at(-1).why, 'stale_release')
  }
})

test('a granted single throw reuses its fresh same-team certificate before the release deadline', async t => {
  for (const releaseCertificate of ['exact', 'different', 'expired'] as const) {
    const f = fixture(15); t.after(f.clean)
    f.set({ relay: true, releaseCertificate, safetyMs: 51 })
    f.session._windRadio = async () => () => {}
    f.enqueue(); f.movement(0)
    await Promise.resolve()
    f.movement(0)
    assert.equal(f.events.includes('use_item'), releaseCertificate === 'exact')
    assert.deepEqual(f.plans.map(p => p.options.certifyRelease), [undefined, true])
    assert.equal(f.safetyChecks, releaseCertificate === 'different' ? 1 : 0)
    if (releaseCertificate !== 'exact') assert.equal(f.session._windOut.log.at(-1).why, 'stale_release')
  }
})

test('wind refuses an otherwise certified ray if the moving first landing expires during repricing', t => {
  for (const [mode, start, fires] of [
    ['moving', 117, false], ['boundary', 112, false], ['fresh', 111, true],
    ['stationary', 117, true], ['relative', 117, true]
  ] as const) {
    const f = fixture(12, true, 0, undefined, { atRelease: true, feetDelta: 3 }); t.after(f.clean)
    const last = { ...f.foe.position, grounded: true, t: 986, kind: mode === 'relative' ? 'rel_entity_move' : 'sync_entity_position' }
    const before = { ...last, x: mode === 'stationary' ? last.x : last.x - .23, y: last.y + .035,
      grounded: false, t: 885, kind: 'entity_move_look' }
    Object.assign(f.foe, { onGround: true, _ndVisible: true, _ndPositionReceipts: [before, last] })
    f.set({ now: start, releaseCertificate: 'exact' }); f.enqueue(); f.movement(0)
    assert.deepEqual(f.plans.map(p => p.options.certifyRelease), [undefined, true])
    assert.equal(f.safetyChecks, 0)
    assert.equal(f.events.includes('use_item'), fires, mode)
    if (!fires) assert.equal(f.session._windOut.log.at(-1).why, 'stale_ground_observation')
  }
})

test('a fresh inward juggle ray needs one full release plan before it may fire', t => {
  for (const mode of ['none', 'alternate', 'lift'] as const) {
    const f = fixture(15, true, 0, undefined, undefined, mode); t.after(f.clean)
    f.enqueue(); f.movement(0)
    assert.equal(f.shots.length, 1)
    const ray = f.shots[0].ray, axis = windOutward(f.session._rescue.arena, f.foe.position, f.foe.width)
    assert.ok(ray.feet.minus(ray.burst).dot(axis) < 0)
    assert.deepEqual(f.plans.map(p => p.options.delays[0]), [1, 0])
    assert.equal(f.events.includes('use_item'), mode !== 'none')
    if (mode !== 'none') assert.equal(f.bot.entity.yaw, mode === 'lift' ? ray.yaw : 0)
  }
})

for (const intent of ['flee', 'loot']) test(`wind reflex still throws while the weak body performs ${intent}`, t => {
  const f = fixture(); t.after(f.clean)
  f.session.current.name = intent
  const owner = f.session.current
  f.enqueue(); f.movement()
  assert.equal(f.events.filter(e => e === 'use_item').length, 1)
  assert.equal(f.session.current, owner)
  assert.equal(f.session._windOut.fired, 1)
})

test('a team order suppresses an already queued solo shot until that exact order ends', t => {
  const f = fixture(); t.after(f.clean)
  f.enqueue()
  assert.ok(reserveWindOrder(f.session, 'one', 'Enemy', 500, 505))
  cancelWindOrder(f.session, 'other', 'Enemy')
  f.movement(0)
  assert.equal(f.plans.length, 0)
  assert.ok(!f.events.includes('use_item'))
  cancelWindOrder(f.session, 'one', 'Enemy')
  f.enqueue(); f.movement(0)
  assert.equal(f.plans.length, 1)
  assert.ok(f.events.includes('use_item'))
})

for (const changed of ['none', 'owner', 'socket', 'spectator', 'defence', 'team_order'] as const) test(`a granted relay rechecks the current release after ${changed}`, async t => {
  const f = fixture(15); t.after(f.clean)
  f.set({ relay: true })
  let grant: (done: (shot?: any) => void) => void
  const completed: any[] = []
  f.session._windRadio = () => new Promise(resolve => { grant = resolve })
  f.enqueue(); f.movement(0)
  grant(shot => completed.push(shot))
  await Promise.resolve()
  if (changed === 'owner') f.session.current = { name: 'wing_orbit', ctl: { aborted: false } }
  if (changed === 'socket') delete f.session._windRadio
  if (changed === 'spectator') f.bot.players.Enemy.gamemode = 3
  if (changed === 'defence') f.set({ smash: true })
  if (changed === 'team_order') assert.ok(reserveWindOrder(f.session, 'one', 'Enemy', 500, 505))
  f.movement(0)
  assert.equal(f.events.includes('use_item'), changed === 'none')
  assert.equal(f.events.includes('shield_equip'), changed === 'defence')
  assert.deepEqual(completed, [changed === 'none' ? { tick: 500, ticks: 3 } : undefined])
  assert.deepEqual(f.plans.map(p => p.options.delays[0]), changed === 'none' ? [1, 0] : [1])
  if (changed !== 'none') assert.equal(f.session._windOut.log.at(-1).why, { owner: 'wind_release_owner_changed', socket: 'wind_relay_channel_changed',
    spectator: 'changed_before_release', defence: 'wind_relay_defence', team_order: 'wind_relay_team_order' }[changed])
})

test('a relay whose owner changed before the grant frees the team window before movement', async t => {
  const f = fixture(15); t.after(f.clean)
  f.set({ relay: true })
  let grant: (done: (shot?: any) => void) => void
  const completed: any[] = []
  f.session._windRadio = () => new Promise(resolve => { grant = resolve })
  f.enqueue(); f.movement(0)
  f.session.current = { name: 'fly_to', ctl: { aborted: false } }
  grant(shot => completed.push(shot))
  await Promise.resolve()
  assert.deepEqual(completed, [undefined])
  assert.equal(f.queued, 1, 'the expired owner must not enqueue another packet callback')
  assert.equal(f.session._windOut.log.at(-1).why, 'wind_release_owner_changed')
  assert.ok(!f.events.includes('use_item'))
})

test('aborting an action cancels its pending wind bid and keeps other abort hooks intact', async t => {
  const f = fixture(15); t.after(f.clean)
  f.set({ relay: true })
  const owner = f.session.current
  let otherAborted = false, radioAborted = false
  const other = () => { otherAborted = true }
  owner.ctl.onAbort = []
  f.session._windRadio = (_bid, signal?: AbortSignal) => new Promise(resolve => {
    signal?.addEventListener('abort', () => { radioAborted = true; resolve(undefined) }, { once: true })
  })
  f.enqueue(); f.movement(0)
  owner.ctl.onAbort.push(other)
  owner.ctl.aborted = true
  for (const abort of owner.ctl.onAbort) abort()
  assert.ok(radioAborted)
  assert.ok(otherAborted)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(owner.ctl.onAbort, [other])
  assert.ok(!f.events.includes('use_item'))
})

for (const phase of ['lateLift', 'earlyLift'] as const) test(`a coordinated ${phase} bids even if its own outward forecast is positive`, async t => {
  const f = fixture(15); t.after(f.clean)
  f.set({ [phase]: true })
  const bids: any[] = []
  f.session._windRadio = async bid => { bids.push(bid) }
  f.enqueue(); f.movement(0)
  await Promise.resolve()
  assert.deepEqual(bids, [{ target: 'Enemy', entity: 2, tick: 500, ticks: 3 }])
  assert.equal(f.events.includes('use_item'), false)
})

test('a grounded opening lift bids while an ordinary grounded push remains local', async t => {
  for (const earlyLift of [true, false]) {
    const f = fixture(15); t.after(f.clean)
    f.foe.onGround = true
    f.set({ earlyLift })
    const bids: any[] = []
    f.session._windRadio = async bid => { bids.push(bid) }
    f.enqueue(); f.movement(0)
    await Promise.resolve()
    assert.equal(bids.length, Number(earlyLift))
    assert.equal(f.events.includes('use_item'), !earlyLift)
  }
})

for (const cost of [35, 37]) test(`wind decision starts after the sent movement, not before 96ms of other physics work (${cost}ms plan)`, t => {
  const f = fixture(cost); t.after(f.clean)
  f.enqueue()
  const prematurePlans = f.plans.length
  assert.equal(f.queued, 1)
  f.movement()
  assert.equal(f.session._windOut.fired, 1, `other physics work must precede the fresh plan: ${JSON.stringify(f.session._windOut.log)}`)
  assert.equal(prematurePlans, 0, 'physicsTick only queues; its other handlers must not age a completed native plan')
  assert.equal(f.plans.length, 1); assert.equal(f.plans[0].at, 96); assert.equal(f.plans[0].moved, true)
  assert.deepEqual(f.plans[0].report.position, { x: .25, y: .5, z: .5 })
  assert.deepEqual(f.plans[0].report.launchMovement, { x: .25, y: .5, z: 0 }, 'the sent native delta, not post-drag entity.velocity, owns this launch')
  assert.deepEqual(f.shots[0].launchMovement, f.plans[0].report.launchMovement)
  assert.equal(f.queued, 1, 'the fresh decision and release share one callback')
  assert.equal(f.events.at(-1), 'use_item'); assert.equal(f.session._windOut.fired, 1)
})

test('the final wind ray expires after a native tick even while its planning window is open', t => {
  for (const [elapsed, fired] of [[49, true], [51, false]] as const) {
    const f = fixture(35, true, elapsed); t.after(f.clean)
    f.enqueue(); f.movement(0)
    assert.equal(f.plans.length, 1)
    assert.equal(f.events.includes('use_item'), fired)
    if (!fired) assert.equal(f.session._windOut.log[0].why, 'stale_release')
  }
})

for (const mode of ['death', 'end', 'kicked', 'respawn', 'entity', 'clock', 'frozen', 'disposed', 'owner', 'abort', 'epoch', 'using', 'invisible', 'stale-observation']) test(`queued wind cannot plan after ${mode}`, t => {
  const f = fixture(); t.after(f.clean); f.enqueue()
  if (['death', 'end', 'kicked', 'respawn'].includes(mode)) f.bot.emit(mode)
  if (mode === 'entity') f.bot.entity = { ...f.bot.entity }
  if (mode === 'clock') f.bot.ndClock = { ...f.bot.ndClock }
  if (mode === 'frozen') f.bot.ndClock.frozen = true
  if (mode === 'disposed') f.bot.ndClock.disposed = true
  if (mode === 'owner') f.session.current = { name: 'wing_orbit', ctl: { aborted: false } }
  if (mode === 'abort') f.session.current.ctl.aborted = true
  if (mode === 'epoch') f.session._reflexState = { epoch: 1 }
  if (mode === 'using') f.bot.usingHeldItem = true
  if (mode === 'invisible') f.set({ visible: false })
  if (mode === 'stale-observation') f.set({ now: 1001 })
  f.movement(0)
  assert.equal(f.plans.length, 0)
  assert.equal(f.events.includes('use_item'), false)
  assert.deepEqual(f.foe._ndPositionReceipts.map(p => p.t), [950, 1000], 'deferring a decision never renews target receipt timestamps')
})

for (const failure of ['empty', 'exception']) test(`a deferred ${failure} plan releases its busy latch for the next tick`, t => {
  const f = fixture(); t.after(f.clean)
  f.set({ useful: failure !== 'empty', throwing: failure === 'exception' })
  assert.doesNotThrow(f.enqueue); f.movement(0)
  assert.equal(f.events.includes('use_item'), false)
  f.set({ useful: true, throwing: false }); f.enqueue(); f.movement(0)
  assert.equal(f.plans.length, 2); assert.equal(f.session._windOut.fired, 1)
})

for (const adapted of [true, false]) test(`${adapted ? 'an adapted' : 'a legacy'} idle client still plans once in the existing immediate fallback`, async t => {
  const f = fixture(35, adapted); t.after(f.clean); f.enqueue()
  assert.equal(f.plans.length, 0)
  await new Promise<void>(r => setImmediate(r))
  assert.equal(f.plans.length, 1); assert.equal(f.session._windOut.fired, 1); assert.equal(f.queued, 1)
  if (adapted) assert.deepEqual(f.plans[0].report.launchMovement, { x: 0, y: 0, z: 0 }, 'fallback reads the accepted getter, never an unsent post-drag velocity')
})
