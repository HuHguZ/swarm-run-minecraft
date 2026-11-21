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
import { swarmWind } from '../../farm/swarm/swarm-driver/wind'

function fixture(planMs = 35, adapted = true, releaseMs = 0, fall?: { atRelease: boolean }, rim?: { atRelease: boolean; feetDelta: number }, inward?: 'alternate' | 'lift' | 'none') {
  let now = 0, sent = new Vec3(0, 0, 0), moved = false, visible = true, useful = true, throwing = false, relay = false, smash = false, lateLift = false, earlyLift = false
  const events: string[] = [], plans: any[] = [], shots: any[] = [], releaseDeadlines: number[] = []
  let flightTicks = 3, releaseFeet: Vec3 | undefined
  const sightChecks: string[] = []
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
  const shot = own => ({ thrower: own.id, fireDelay: 0, ticks: flightTicks, from: new Vec3(own.position.x, own.position.y + 1.62, own.position.z),
    aim: foe.position.offset(0, .4, 0), feet: foe.position.clone(), burst: foe.position.offset(inward ? .5 : -.5, .4, 0),
    velocity: new Vec3(1.5, .1, 0), yaw: 0, pitch: 0 })
  // The actual CD #1123 ray at release. The earlier utility plan was not captured.
  const reaim = own => ({ ...shot(own), ticks: 14, aimHeight: 1.6, yaw: 2.8371551764511445, pitch: 1.3230615116034032,
    from: new Vec3(577.9253049880568, 125.62, 568.0387917704294), aim: new Vec3(573.5986561939295, 146.33652858577753, 575.9248996350485),
    feet: new Vec3(573.5986561939295, 144.73652858577753, 575.9248996350485), burst: new Vec3(573.9278413094033, 144.76034961234598, 575.3248996231276) })
  let queued = 0, forecasts = 0
  let releaseCertificate: 'exact' | 'different' | 'expired' | undefined, safetyChecks = 0, safetyMs = 0, unsafeAlly: string | undefined
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
        events.push('plan'); plans.push({ moved, at: now, target: _foe.username, report: structuredClone(reports[0]), options })
        if (throwing) throw Error('bounded native failure')
        now += options.certifyRelease ? (_foe.releaseCostMs ?? planMs) : planMs
        if (!useful || _foe.noPlan || rim && options.delays[0] === 0 && !rim.atRelease) return null
        const atRelease = options.delays[0] === 0
        if (atRelease && inward === 'none') return null
        const ray = inward === 'lift' && atRelease ? reaim(reports[0]) : shot(reports[0])
        if (rim && options.delays[0] === 0) ray.feet.x += rim.feetDelta
        const selected = { ...ray, fireDelay: options.delays[0] }
        if (atRelease && releaseCertificate === 'expired') now += 125
        return { targetAt: foe.position.clone(), gameTick: worldTick(bot), fallThreat: !!fall && (plans.length === 1 || fall.atRelease), repriceRim: !!rim, lateLift, earlyLift: _foe.earlyLift ?? earlyLift,
          resistance: { lo: 0, hi: 0 }, baseline: { out: false, progress: relay ? 2 : 0, air: 10, outwardEffect: 0 },
          nominal: { out: false, exited: false, progress: 1, air: 15, outwardEffect: 1 }, worst: { out: false, exited: false, progress: 0 },
          shots: [selected], ...(options.certifyRelease && releaseCertificate && { releaseSafeKey: releaseCertificate === 'different' ? 'different' : impactKey(selected) }) }
      },
      enemyWindFrames: (...args) => { releaseDeadlines.push(args[7]); forecasts++; return [{ pos: releaseFeet || foe.position }] }, enemyWindShot: (_b, _e, own) => {
        const ray = inward ? reaim(own) : shot(own)
        shots.push({ ...structuredClone(own), ray }); return ray
      },
      pendingWindHit: (...args) => { releaseDeadlines.push(args[5]?.deadline); now += releaseMs; return null },
      windTeamSafe: (_bot, team) => { safetyChecks++; now += safetyMs; return !team.some(a => a.id === unsafeAlly) }, observeOwnWindBurst: () => () => {} },
    './ally-safety': { isAlly: (_bot, entity) => !!entity.ally }, '../pvp/last-seen': { seesPlayer: (_bot, entity) => {
      sightChecks.push(entity.username); return visible && !entity.hidden
    } },
    '../pvp/search': { observedCollision: () => bot }, '../bow/track': { observedVelocity: () => ({ x: .1, y: .2, z: 0 }) },
    '../elytra/track': { gliding: e => !!e.elytraFlying }, '../threats': { smashes: () => smash ? [{ name: 'Enemy', ticks: 9 }] : [] }
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
  return { bot, foe, session, plans, shots, events, sightChecks, releaseDeadlines, enqueue, movement, get queued() { return queued }, get forecasts() { return forecasts }, get safetyChecks() { return safetyChecks },
    set(p: any) {
      if ('visible' in p) visible = p.visible
      if ('useful' in p) useful = p.useful
      if ('throwing' in p) throwing = p.throwing
      if ('now' in p) now = p.now
      if ('relay' in p) relay = p.relay
      if ('lateLift' in p) lateLift = p.lateLift
      if ('earlyLift' in p) earlyLift = p.earlyLift
      if ('flightTicks' in p) flightTicks = p.flightTicks
      if ('releaseFeet' in p) releaseFeet = p.releaseFeet
      if ('releaseCertificate' in p) releaseCertificate = p.releaseCertificate
      if ('safetyMs' in p) safetyMs = p.safetyMs
      if ('unsafeAlly' in p) unsafeAlly = p.unsafeAlly
      if ('smash' in p) { smash = p.smash; session._ndFoes = ['Enemy']; bot.inventory.items = () => [{ name: 'shield' }] }
    },
    clean() { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners() } }
}

test('the release passes its remaining wall-clock deadline to both motion forecasts', t => {
  const f = fixture(15); t.after(f.clean)
  f.enqueue(); f.movement(0)
  assert.ok(f.events.includes('use_item'))
  assert.deepEqual(f.releaseDeadlines, [65, 65], '15 ms planning, then one release tick of 50 ms')
})

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

test('an expired opening relay skips the entire release forecast and a new movement tick can still throw', async t => {
  const f = fixture(15); t.after(f.clean)
  let finished = 0
  f.foe.onGround = true; f.set({ earlyLift: true })
  f.session._windRadio = async () => () => { finished++ }
  f.enqueue(); f.movement(0); await Promise.resolve()
  assert.equal(f.plans.length, 1)
  f.movement(200) // The movement packet follows the grant exactly at its existing exclusive cutoff.
  assert.equal(f.session._windOut.log.at(-1).why, 'stale_release')
  assert.match(f.session._windOut.log.at(-1).dbg, /истёк заказ роя/)
  assert.equal(finished, 1)
  assert.deepEqual({ plans: f.plans.length, safety: f.safetyChecks, fired: f.session._windOut.fired }, { plans: 1, safety: 0, fired: 0 })
  f.bot.ndClock.ticks++; f.set({ earlyLift: false })
  f.enqueue(); f.movement(0)
  assert.equal(f.session._windOut.fired, 1)
  assert.equal(f.plans.length, 2)
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

test('the final charge uses the currently observed motion frame after a centre crossing', t => {
  const f = fixture(15, true, 0, undefined, undefined, 'none'); t.after(f.clean)
  const raw = f.foe.position, arena = f.session._rescue.arena, advanced = raw.offset(0, 0, -1)
  arena.x = raw.x + .5; arena.z = raw.z - .5
  f.set({ releaseFeet: advanced })
  f.enqueue(); f.movement(0)
  const ray = f.shots[0].ray, impulse = ray.feet.minus(ray.burst)
  assert.ok(impulse.dot(windOutward(arena, raw)) > 0)
  assert.ok(impulse.dot(windOutward(arena, advanced)) < 0)
  assert.deepEqual(f.plans.map(p => p.options.delays[0]), [1, 0])
  assert.ok(!f.events.includes('use_item'))
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

test('a full wind radio leaves an independent throw available and immediately reopens the relay when drained', async t => {
  const f = fixture(10); t.after(f.clean)
  const bids: string[] = []
  let ready = false
  f.session._windRadio = Object.assign(async bid => {
    bids.push(bid.target)
    if (ready) return () => {}
  }, { canBid: () => ready })
  f.foe.onGround = true
  f.set({ earlyLift: true })
  const other = { ...f.foe, id: 9, username: 'Other', earlyLift: false, position: new Vec3(3, 5, .5) }
  f.bot.players.Other = { entity: other, gamemode: 0 }; f.bot.entities[9] = other
  // The first opening needs a team slot. The alternate outward push can be used independently.
  f.enqueue(); f.movement(0); await Promise.resolve()
  assert.deepEqual(bids, [])
  assert.deepEqual(f.plans.filter(p => !p.options.certifyRelease).map(p => [p.target, p.options.waitForRelaySlot]),
    [['Enemy', true], ['Other', true]])
  assert.equal(f.session._windOut.fired, 1)
  ready = true
  f.enqueue(); f.movement(0); await Promise.resolve(); f.movement(0)
  assert.deepEqual(bids, ['Enemy'])
  assert.equal(f.session._windOut.fired, 2)
})

for (const next of ['same lift', 'ordinary push', 'second target']) test('a released local wind flight preserves ' + next, async t => {
  const f = fixture(15); t.after(f.clean)
  const actor = { name: 'Blue', team: 'blue' }, bids: string[] = []
  const team = swarmWind({ generation: 1, teamOf: b => b.team, alive: () => true, hostile: () => true } as any)
  let id = 0
  f.session._windRadio = async bid => {
    const q = { ...bid, id: ++id, type: 'wind_bid' }
    bids.push(bid.target)
    if (team.windBid(actor, q)) return shot => team.windBid(actor, { ...q, type: 'wind_bid_done', shot })
  }
  f.foe.onGround = true
  f.set({ earlyLift: true, flightTicks: 16 })
  f.enqueue(); f.movement(0); await Promise.resolve(); f.movement(0)
  assert.equal(f.session._windOut.fired, 1)
  if (next === 'ordinary push') f.set({ earlyLift: false })
  if (next === 'second target') {
    const foe = { ...f.foe, id: 9, username: 'Other' }
    f.bot.players.Other = { entity: foe, gamemode: 0 }; f.bot.entities[9] = foe
  }
  f.enqueue(); f.movement(0); await Promise.resolve()
  assert.ok(f.plans.some(p => p.target === 'Enemy' && p.options.waitForRelaySlot === true))
  assert.deepEqual(bids, next === 'second target' ? ['Enemy', 'Other'] : ['Enemy'])
  f.movement(0)
  assert.equal(f.session._windOut.fired, next === 'same lift' ? 1 : 2)
  if (next === 'same lift') {
    f.bot.usingHeldItem = true
    for (let i = 0; i < 20; i++) f.bot.emit('physicsTick')
    f.bot.usingHeldItem = false
    f.enqueue(); f.movement(0); await Promise.resolve(); f.movement(0)
    assert.deepEqual(bids, ['Enemy', 'Enemy'])
    assert.equal(f.session._windOut.fired, 2)
  }
})

test('nineteen allied sight checks serve twenty candidates; a grant takes a fresh allied roster', async t => {
  const f = fixture(0); t.after(f.clean)
  f.foe.onGround = true
  for (let i = 1; i < 20; i++) {
    const enemy = { ...f.foe, id: 10 + i, username: 'Foe' + i }
    const ally = { ...f.foe, id: 50 + i, username: 'Ally' + i, ally: true, hidden: i === 1, position: new Vec3(50 + i, 0, 0) }
    for (const body of [enemy, ally]) {
      f.bot.players[body.username] = { entity: body, gamemode: 0 }
      f.bot.entities[body.id] = body
    }
  }
  f.set({ useful: false }); f.enqueue(); f.movement(0)
  assert.equal(f.plans.length, 20)
  assert.equal(f.sightChecks.filter(id => id.startsWith('Ally')).length, 19)
  assert.ok(f.plans.every(p => p.options.allies.length === 18 && !p.options.allies.some(a => a.id === 'Ally1')))
  f.set({ useful: true, earlyLift: true, unsafeAlly: 'Ally1' })
  f.session._windRadio = async () => () => {}
  f.enqueue(); f.movement(0); await Promise.resolve()
  f.bot.players.Ally1.entity.hidden = false
  f.bot.players.Ally1.entity.position = new Vec3(3, 5, 0)
  f.movement(0)
  const released = f.plans.at(-1).options.allies
  assert.equal(released[1].id, 'Ally1', 'the newly visible closest ally is checked first after the thrower')
  assert.equal(released.length, 20)
  assert.equal(f.events.includes('use_item'), false)
  assert.equal(f.session._windOut.log.at(-1).why, 'changed_before_release')
})

test('an elytra interception protects the thrower and visible nearby allies only', t => {
  const f = fixture(0); t.after(f.clean)
  f.foe.elytraFlying = true
  for (const [i, name] of ['Seen', 'BehindWall', 'Spectator'].entries()) {
    const ally = { ...f.foe, id: i + 5, username: name, position: new Vec3(i + 2, 0, 0), height: 1.5, ally: true, elytraFlying: false, hidden: name === 'BehindWall' }
    f.bot.players[name] = { entity: ally, gamemode: name === 'Spectator' ? 3 : 0 }
    f.bot.entities[ally.id] = ally
  }
  f.set({ useful: false }); f.enqueue(); f.movement(0)
  const plan = f.plans.find(p => p.options.protect)
  assert.ok(plan)
  assert.deepEqual(plan.options.protect.map(p => p.x), [.25, 2])
  assert.equal(plan.options.protect[1].y, 1.27)
})

test('a busy wind relay checks the roster once after movement and sees a replacement target in the next window', async t => {
  const f = fixture(15); t.after(f.clean)
  f.foe.onGround = true
  for (let i = 1; i < 20; i++) {
    const foe = { ...f.foe, id: i + 2, username: 'Foe' + i }
    f.bot.players[foe.username] = { entity: foe, gamemode: 0 }
    f.bot.entities[foe.id] = foe
  }
  const bids = []
  f.session._windRadio = async bid => { bids.push(bid.target) }
  f.set({ earlyLift: true })
  f.enqueue(); f.movement(0); await Promise.resolve()
  assert.deepEqual(bids, ['Enemy'])
  assert.equal(f.session._windOut.log.at(-1).why, 'wind_relay_busy')
  assert.equal(f.sightChecks.length, 1 + 20, 'an admitted phase needs one first witness plus the fresh ranked roster')
  f.enqueue()
  f.foe.hidden = true
  f.set({ earlyLift: false }); f.movement(0); await Promise.resolve()
  assert.deepEqual(f.plans.map(p => p.target), ['Enemy', 'Foe1'])
  assert.deepEqual(bids, ['Enemy'], 'the independent push is still local')
  assert.equal(f.events.filter(e => e === 'use_item').length, 1)
})

for (const mode of ['two occupied', 'moved', 'next window', 'only target', 'ordinary fallback']) test('denied wind bids reprice current targets: ' + mode, async t => {
  const f = fixture(15); t.after(f.clean)
  const actor = { name: 'Blue', team: 'blue' }, other = { name: 'Relay', team: 'blue' }
  const team = swarmWind({ generation: 1, teamOf: b => b.team, alive: () => true, hostile: () => true } as any)
  f.foe.onGround = true; f.set({ earlyLift: true })
  const blockers = [], bids = []
  for (const [i, name] of (mode === 'only target' ? ['Enemy'] : ['Enemy', 'Second', 'Third']).entries()) {
    const entity = i ? { ...f.foe, id: 2 + i, username: name } : f.foe
    f.bot.players[name] = { entity, gamemode: 0 }; f.bot.entities[entity.id] = entity
    if (i < 2) {
      const bid = { id: 21 + i, type: 'wind_bid', entity: entity.id, target: name, tick: 500, ticks: 16 }
      assert.ok(team.windBid(other, bid)); blockers.push(bid)
    }
  }
  f.session._windRadio = async bid => {
    const q = { ...bid, id: 1 + bids.length, type: 'wind_bid' }
    bids.push(q.target)
    if (team.windBid(actor, q)) return shot => team.windBid(actor, { ...q, type: 'wind_bid_done', shot })
  }
  for (let i = 0; i < 6 && !f.session._windOut.fired; i++) {
    if (i) f.bot.ndClock.age += 2n
    if (i === 1 && mode !== 'two occupied') {
      if (mode === 'moved') f.foe.position = f.foe.position.offset(1, 0, 0)
      if (mode === 'next window') f.bot.ndClock.age += 5n
      if (mode === 'ordinary fallback') {
        f.set({ earlyLift: false })
        f.bot.players.Second.entity.noPlan = f.bot.players.Third.entity.noPlan = true
      } else team.windBid(other, { ...blockers[0], type: 'wind_bid_done' })
    }
    f.enqueue(); f.movement(0); await Promise.resolve(); f.movement(0)
  }
  const expected = mode === 'two occupied' ? ['Enemy', 'Second', 'Third'] : mode === 'ordinary fallback' ? ['Enemy'] : ['Enemy', 'Enemy']
  assert.deepEqual(bids, expected)
  assert.deepEqual(f.plans.filter(p => !p.options.certifyRelease).map(p => p.target),
    mode === 'ordinary fallback' ? ['Enemy', 'Second', 'Third', 'Enemy'] : expected)
  assert.deepEqual(f.plans.filter(p => p.options.certifyRelease).map(p => p.target), mode === 'ordinary fallback' ? [] : expected.slice(-1))
  assert.equal(f.session._windOut.fired, 1)
})

for (const mode of ['fresh alternative', 'failed alternative', 'same-frame fallback', 'newly visible alternative', 'hidden alternative',
  'only target', 'changed pose', 'different owner', 'new hand window', 'defence']) {
  test('a local release deadline leaves a fair next opening: ' + mode, t => {
    const f = fixture(35, true, 0, undefined, { atRelease: true, feetDelta: 0 }); t.after(f.clean)
    f.foe.releaseCostMs = 65
    const others = mode === 'only target' ? 0 : mode.endsWith('visible alternative') || mode === 'hidden alternative' ? 1 : 38
    for (let i = 0; i < others; i++) {
      const name = 'Other' + i
      const e = { ...f.foe, id: 3 + i, username: name, position: f.foe.position.offset(-1, 0, 0), releaseCostMs: 25,
        hidden: mode === 'newly visible alternative' }
      f.bot.players[name] = { entity: e, gamemode: 0 }; f.bot.entities[e.id] = e
    }
    const pulse = () => { f.enqueue(); f.movement(0) }
    pulse()
    assert.equal(f.session._windOut.log.at(-1)?.why, 'stale_release')
    assert.equal(f.session._windOut.fired, 0)
    pulse()
    assert.equal(f.plans.length, 2, 'the same expired native frame is not repriced')
    f.bot.ndClock.ticks++
    if (mode === 'failed alternative' || mode === 'same-frame fallback') f.bot.players.Other0.entity.noPlan = true
    if (mode === 'hidden alternative' || mode === 'newly visible alternative') f.bot.players.Other0.entity.hidden = mode === 'hidden alternative'
    if (mode === 'changed pose') f.foe.position.x += 1
    if (mode === 'different owner') f.session.current = { name: 'wing_orbit', ctl: { aborted: false } }
    if (mode === 'new hand window') f.bot.ndClock.ticks += 10
    if (mode === 'defence') f.set({ smash: true })
    if (mode !== 'failed alternative') f.foe.releaseCostMs = 25
    pulse()
    const expected = mode === 'fresh alternative' || mode === 'newly visible alternative' ? ['Enemy', 'Other0'] :
      mode === 'failed alternative' || mode === 'same-frame fallback' ? ['Enemy', 'Other0', 'Enemy'] : ['Enemy', 'Enemy']
    if (mode === 'defence') {
      assert.ok(f.events.includes('shield_equip'))
      assert.equal(f.plans.length, 2)
    } else {
      assert.deepEqual(f.plans.filter(p => !p.options.certifyRelease).map(p => p.target), expected)
      if (mode === 'failed alternative') {
        assert.equal(f.session._windOut.fired, 0)
        f.bot.ndClock.ticks++; pulse()
        assert.equal(f.plans.at(-1).target, 'Other1', 'a repeatedly failing runner-up does not monopolize the next chance')
      }
      assert.equal(f.session._windOut.fired, 1)
    }
  })
}

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

test('an expired interception ends before aiming or ally simulation and logs the actual release budget', t => {
  for (const elapsed of [25, 26]) {
    const f = fixture(10, true, elapsed); t.after(f.clean)
    f.bot.ndClock.observationRate = () => 40
    f.enqueue(); f.movement(0)
    assert.equal(f.events.includes('use_item'), elapsed === 25)
    assert.equal(f.shots.length, elapsed === 25 ? 1 : 0)
    assert.equal(f.safetyChecks, elapsed === 25 ? 1 : 0)
    if (elapsed === 26) {
      const entry = f.session._windOut.log.at(-1)
      assert.equal(entry.why, 'stale_release')
      assert.match(entry.dbg, /перехват: бюджет перепроверки, 26 из 25 мс/)
    }
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
