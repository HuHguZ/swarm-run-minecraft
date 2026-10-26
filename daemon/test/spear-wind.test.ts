import test from 'node:test'
import assert from 'node:assert/strict'
import { spearWindPrice, spearWindPlan, braceSpearWind, repriceSpearWind } from '../src/combat/spear-wind'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { windReceive, windImpulse, windBoost, windPairProgress, remainingWindPlan } from '../src/combat/team-wind'
import { spearWindPlan as planAttack } from '../src/combat/spear-wind'
import * as edges from '../src/edges'
import { DAMAGE_TYPES } from '../src/gamedata'
import { lanceHits, lanceDamage } from '../src/combat/aerial-lance'
import { lookVec } from '../src/elytra/physics'
import { eyeOf } from '../src/pick'
import * as combatObserve from '../src/pvp/combat-observe'

function fixture(raised = false) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock(p) {
    const q = p.floored(), solid = q.y === 0 || raised && q.x >= 4 && q.x <= 6 && Math.abs(q.z) <= 1 && q.y >= 1 && q.y <= 5
    const b = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState)
    b.position = q; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'receiver', version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [{ name: 'netherite_spear', count: 1 }] }, jumpTicks: 0, jumpQueued: false,
    entity: { id: 1, username: 'receiver', position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2,
      pitch: 0, onGround: true, effects: {}, attributes: {}, isInWater: false, isInLava: false, isInWeb: false },
    blockAt: p => world.getBlock(p), entities: {}, players: {}, fireworkRocketDuration: 0,
    physics: require('../src/tick-plugins').getPhysics().Physics(registry, world)
  })
  const foe: any = { id: 2, username: 'enemy', type: 'player', position: new Vec3(raised ? 5.5 : 6.5, raised ? 6 : 1, .5), velocity: new Vec3(0, 0, 0),
    onGround: true, width: .6, height: 1.8, equipment: [] }
  bot.entities[2] = foe
  return { bot, foe }
}

function preparedPair(t) {
  const f = fixture(true), report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  // Supply the same previously inspected geometry to initial and remaining-flight pricing.
  t.mock.method(require('../src/pvp/search'), 'observedCollision', bot => ({ blockAt: bot.blockAt, physics: bot.physics, game: bot.game }))
  const wind = require('../src/combat/team-wind'), nativePlan = wind.teamWindPlan
  // Exercise the running receiver cursor; the cheaper idle-jump candidate has no executed displacement yet.
  t.mock.method(wind, 'teamWindPlan', (bot, report, target, options) => nativePlan(bot, report, target, {
    ...options, accept: plan => plan.runTicks > 0 && (!options.accept || options.accept(plan))
  }))
  f.bot.entity.velocity.y = -.0784000015258789
  let proposal = planAttack(f.bot, report, 'enemy', { incomingDps: 0 })
  while (!proposal.best && proposal.partial) proposal = planAttack(f.bot, report, 'enemy', { incomingDps: 0 })
  const base = proposal.best
  assert.ok(base, JSON.stringify(proposal))
  // Use a fresh view so an earlier sight cache cannot silently supply the initial viewpoint instead.
  f.bot = Object.assign(new EventEmitter(), f.bot)
  return { ...f, report, base }
}

function executedPlan(t) {
  const f = preparedPair(t), { base, report } = f
  const before = f.bot.entity.position.clone(), state = edges.stateOf(f.bot, base.receiver.steps[0].control)
  state.yaw = base.receiver.steps[0].yaw; edges.simOf(f.bot)(state, edges.worldOf(f.bot))
  Object.assign(f.bot.entity, { position: state.pos.clone(), velocity: state.vel.clone(), onGround: state.onGround })
  f.bot.jumpTicks = state.jumpTicks; f.bot.jumpQueued = state.jumpQueued
  const plan = remainingWindPlan(f.bot, base, 1)
  assert.ok(plan, JSON.stringify({ why: 'after an executed step there must remain a native launch', runTicks: base.runTicks, jumpTick: base.jumpTick, state: { pos: state.pos, vel: state.vel }, shot: base.shot.ticks }))
  assert.ok(repriceSpearWind(f.bot, plan, 1, 0))
  plan.progress = { startTick: 510, executed: 1, movement: { ...state.pos.minus(before) }, receiver: 'receiver', token: 'own-run:1', gameTick: 500, sampledAt: Date.now(), validForMs: 50, cases: [plan.receiver] }
  return { ...f, report, base, plan }
}

test('spear wind compares native extra damage against ordinary attack, two-body time and own HP cost', () => {
  const ordinary = { damage: 8, ticks: 20 }
  assert.equal(spearWindPrice({ damage: 8, ticks: 20, setupTicks: 10, ordinary, incomingDps: 0, health: 20 }).worth, false)
  assert.equal(spearWindPrice({ damage: 30, ticks: 8, setupTicks: 10, ordinary, incomingDps: 0, health: 20 }).worth, true)
  const wounded = spearWindPrice({ damage: 30, ticks: 8, setupTicks: 10, ordinary, incomingDps: 8, health: 4 })
  assert.equal(wounded.worth, false)
  assert.ok(wounded.self > 4)
})

test('the existing read-only wind report waits for executed own physics and declines an unsafe arrival phase', async t => {
  const { bot, base, report } = preparedPair(t), controls = { ...edges.IDLE }
  bot._client = new EventEmitter(); bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { bot.ndClock.ticks++; await Promise.resolve() } }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  bot.setControlState = (key, value) => { controls[key] = value }; bot.getControlState = key => !!controls[key]
  bot.equip = async item => { bot.heldItem = item }; bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { bot.usingHeldItem = true }; bot.deactivateItem = () => { bot.usingHeldItem = false }
  const ctl = { aborted: false, onAbort: [] }, session: any = { bot, state: () => ({ own: true }), runIntent: () => { throw Error('a progress report cannot replace the running receiver intent') } }
  const methods = (require('../src/rpc/aerial') as typeof import('../src/rpc/aerial')).aerialMethods({ session } as any)
  const receiving = windReceive(session, ctl, { thrower: report, enemy: 'enemy', plan: base, startTick: 510, incomingDps: 0 })
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal((await methods.wind_report({ pairProgress: true, startTick: 510 })).detail.ok, false, 'input queued at the shared clock is not executed progress')
  const before = bot.entity.position.clone(), state = edges.stateOf(bot, controls)
  edges.simOf(bot)(state, edges.worldOf(bot))
  Object.assign(bot.entity, { position: state.pos.clone(), velocity: state.vel.clone(), onGround: state.onGround })
  bot.ndClock.ticks++; bot.emit('physicsTick')
  const response = await methods.wind_report({ pairProgress: true, startTick: 510 })
  assert.deepEqual(response.events, []); assert.deepEqual(response.state, { own: true })
  assert.equal(response.detail.executed, 1); assert.equal(response.detail.ok, false, JSON.stringify(response.detail))
  assert.equal(response.detail.why, 'arrival_phase_not_worth_or_safe')
  assert.equal(response.detail.arrival, 0)
  assert.ok(bot.entity.position.distanceTo(before) > 0)
  assert.equal(response.detail.plan, undefined, 'a nominally priced landing cannot authorize an uncertified earlier burst')
  ctl.aborted = true; bot.emit('physicsTick'); await receiving
  assert.equal((await windPairProgress(session, { startTick: 510 })).phase, 'not_running')
})

test('native spear wind has a priced ready contact and a settled two-body exit to a raised foe', () => {
  const { bot } = fixture(true)
  const report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  const throwerControls: any[] = [], native = bot.physics.simulatePlayer
  bot._ndSimOrig = function (state, world) {
    if (Math.abs(state.pos.x - report.position.x) < .001) throwerControls.push({ ...state.control })
    return native.call(this, state, world)
  }
  const proposal = spearWindPlan(bot, report, 'enemy', { arena: { x: 0, z: 0, r: 30, killY: -5 }, incomingDps: 0 })
  assert.ok(proposal.best, JSON.stringify(proposal))
  console.log('native spear wind contact', JSON.stringify({ spear: proposal.best.spear, flightTicks: proposal.best.receiver.steps.length, shotTicks: proposal.best.shot.ticks }))
  assert.ok(proposal.best.spear.price.worth)
  assert.ok(proposal.best.spear.hitTick > proposal.best.shot.ticks)
  assert.ok(proposal.best.receiver.settled && proposal.best.thrower.safe)
  assert.ok(throwerControls.length > proposal.best.shot.ticks)
  assert.ok(throwerControls.every(c => !c.sneak), 'the thrower safety forecast cannot borrow a brake that its executor never applies')
})

test('ordinary flat-floor charge uses native accepted displacement and wins over unnecessary pair setup', () => {
  const { bot } = fixture()
  const report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  const proposal = spearWindPlan(bot, report, 'enemy', { incomingDps: 0 })
  assert.ok(proposal.ordinary.damage > 0, JSON.stringify(proposal))
  assert.equal(proposal.best, null)
  assert.ok(proposal.partial && proposal.tried <= 12, 'one RPC examines only one bounded native batch')
  const second = spearWindPlan(bot, report, 'enemy', { incomingDps: 0 })
  assert.ok(second.partial && second.tried <= 12, 'the next fight turn resumes its native candidate search')
})

test('the existing wind receiver holds a real spear use through the matching burst and confirms its own contact before landing', async () => {
  const { bot, foe } = fixture(true), controls = { ...edges.IDLE }, packets = []
  bot._client = new EventEmitter(); bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { bot.ndClock.ticks++; await Promise.resolve() } }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  bot.setControlState = (key, value) => { controls[key] = value }
  bot.getControlState = key => !!controls[key]
  bot.equip = async item => { bot.heldItem = item }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { bot.usingHeldItem = true; packets.push('use_item') }
  bot.deactivateItem = () => { if (bot.usingHeldItem) packets.push('release_use_item'); bot.usingHeldItem = false }
  const report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  const plan = planAttack(bot, report, 'enemy', { incomingDps: 0 }).best
  assert.ok(plan)
  const ctl = { aborted: false, onAbort: [] }, sourceTypeId = DAMAGE_TYPES.indexOf('spear')
  let finished = false
  const running = windReceive({ bot }, ctl, { thrower: report, enemy: 'enemy', plan, startTick: 510 }).then(r => { finished = true; return r })
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(bot.usingHeldItem, true)
  const state = edges.stateOf(bot, controls), simulate = edges.simOf(bot), world = edges.worldOf(bot)
  for (let tick = 0; tick < 96 && !finished; tick++) {
    if (tick === plan.shot.ticks) {
      assert.equal(bot.usingHeldItem, true, 'native charge is maintained across the ally launch')
      const impulse = windImpulse(bot, state.pos, plan.shot.burst)
      state.vel = state.vel.plus(impulse)
      bot._client.emit('explosion', { radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, center: plan.shot.burst, playerKnockback: impulse })
    }
    state.control = { ...controls }; state.yaw = bot.entity.yaw
    const before = state.pos.clone()
    simulate(state, world)
    Object.assign(bot.entity, { position: state.pos.clone(), velocity: state.vel.clone(), onGround: state.onGround })
    bot.ndClock.ticks++
    if (tick === plan.spear.hitTick - 1) {
      const direction = lookVec(bot.entity.yaw, bot.entity.pitch), movement = state.pos.minus(before)
      assert.ok(lanceHits(eyeOf(bot), direction, movement, foe.position), 'the actual held look intersects the native kinetic ray')
      assert.ok(lanceDamage(plan.spear.name, direction, movement).dmg > 0, 'actual accepted displacement pays native charge damage')
      bot._client.emit('damage_event', { entityId: foe.id, sourceCauseId: bot.entity.id + 1, sourceDirectId: bot.entity.id + 1, sourceTypeId })
    }
    bot.emit('physicsTick')
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }
  const result = await running
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.received, true); assert.equal(result.combat.hit, true)
  assert.deepEqual(packets, ['use_item', 'release_use_item'])
  assert.equal(bot._client.listenerCount('damage_event'), 0)
  assert.equal(bot._client.listenerCount('explosion'), 0)
})

test('an own native spear packet after a burst beyond the certified arrival range cannot confirm the pair', async t => {
  const { bot, base, report, foe } = preparedPair(t)
  bot._client = new EventEmitter(); bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { bot.ndClock.ticks++; await Promise.resolve() } }
  bot.clearControlStates = () => {}; bot.setControlState = () => {}; bot.getControlState = () => false
  bot.equip = async item => { bot.heldItem = item }; bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { bot.usingHeldItem = true }; bot.deactivateItem = () => { bot.usingHeldItem = false }
  const ctl = { aborted: false, onAbort: [] }, running = windReceive({ bot }, ctl, { thrower: report, enemy: 'enemy', plan: base, startTick: 510 })
  for (let i = 0; i < 40; i++) await Promise.resolve()
  for (let i = 0; i < base.shot.ticks + 2; i++) { bot.ndClock.ticks++; bot.emit('physicsTick') }
  const impulse = windImpulse(bot, bot.entity.position, base.shot.burst)
  bot._client.emit('explosion', { radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, center: base.shot.burst, playerKnockback: impulse })
  bot._client.emit('damage_event', { entityId: foe.id, sourceTypeId: 37, sourceCauseId: bot.entity.id + 1, sourceDirectId: bot.entity.id + 1 })
  ctl.aborted = true; bot.emit('physicsTick')
  const result = await running
  assert.equal(result.received, false); assert.equal(result.combat.hit, false)
})

test('paired launch rechecks a late third teammate and actual look, and requires a server launch receipt', async t => {
  // Native game time is advanced explicitly below; host CPU time must not age its receipt.
  let now = 1000000, safetyElapsed = 0
  t.mock.method(Date, 'now', () => now)
  const safety = require('../src/combat/wind-safety'), nativeReleaseSafe = safety.windReleaseSafe
  t.mock.method(safety, 'windReleaseSafe', (...args) => {
    const safe = nativeReleaseSafe(...args)
    now += safetyElapsed
    return safe
  })
  const receiver = executedPlan(t), { report, plan } = receiver
  assert.ok(plan)
  for (const mode of ['clear', 'third', 'look', 'receiver-drift', 'receiver-up', 'receiver-packet', 'expired', 'lease-49', 'lease-50', 'safety-49', 'safety-50', 'clock', 'clock-late', 'wrong-owner', 'no-receipt']) {
    now = 1000000; safetyElapsed = mode === 'safety-49' ? 49 : mode === 'safety-50' ? 50 : 0
    const { bot } = fixture(true), charge = { name: 'wind_charge', count: 64, slot: 36 }
    bot.username = 'thrower'; bot.entity.username = 'thrower'; bot.entity.id = 3; bot.entity.position = new Vec3(-2.5, 1, .5)
    bot._ndSwarmAllies = ['receiver', 'Third']; bot.inventory.items = () => [charge]; bot.inventory.slots[36] = charge
    const ally: any = { ...receiver.bot.entity, type: 'player', width: .6, height: 1.8, metadata: [], equipment: [{ name: 'netherite_spear' }] }
    ally.metadata[8] = 1; bot.entities[1] = ally
    bot._client = new EventEmitter(); bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
    bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { bot.ndClock.ticks++; await Promise.resolve() } }
    bot.clearControlStates = () => {}; bot.equip = async item => { bot.heldItem = item }
    bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
    let sent = 0
    bot.activateItem = () => { sent++; if (mode !== 'no-receipt') bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
    plan.progress.sampledAt = Date.now(); plan.progress.gameTick = mode === 'clock' ? 501 : 500
    plan.progress.receiver = mode === 'wrong-owner' ? 'Other' : 'receiver'
    const running = windBoost({ bot }, { aborted: false }, { ally: 'receiver', plan, startTick: 510 })
    for (let i = 0; i < 40; i++) await Promise.resolve()
    if (mode === 'look') bot.entity.yaw += .5
    if (mode === 'clock-late') bot.ndClock.ticks++
    if (mode === 'expired') plan.progress.sampledAt = Date.now() - 51
    if (mode === 'lease-49') now += 49
    if (mode === 'lease-50') now += 50
    if (mode === 'third') bot.entities[4] = { id: 4, username: 'Third', type: 'player', position: plan.shot.from.plus(plan.shot.velocity.scaled(.5)).offset(0, -.9, 1), velocity: new Vec3(0, 0, -2), onGround: true, width: .6, height: 1.8 }
    if (mode === 'receiver-drift') ally.velocity = new Vec3(-.7, 0, 0)
    if (mode === 'receiver-up') ally.velocity = new Vec3(0, .7, 0)
    if (mode === 'receiver-packet') {
      ally._ndPositionReceipts = [null, { x: .5, y: 1, z: .5, t: 0, grounded: true, kind: 'rel_entity_move' }]
      ally.velocity = new Vec3(-.7, 0, 0)
      bot._client.emit('entity_velocity', { entityId: ally.id, velocity: { x: -5600, y: 0, z: 0 } })
    }
    bot.emit('physicsTick')
    const result = await running
    const released = ['clear', 'lease-49', 'safety-49', 'no-receipt'].includes(mode)
    assert.equal(sent, released ? 1 : 0, JSON.stringify({ mode, result }))
    assert.equal(result.ok, released && mode !== 'no-receipt', JSON.stringify({ mode, result }))
    assert.equal(bot._client.listenerCount('set_cooldown'), 0)
    assert.equal(bot._client.listenerCount('entity_velocity'), 0)
  }
})

test('a remaining native launch resumes the executed input cursor instead of repeating sprint preparation', t => {
  const { bot, plan, base } = executedPlan(t)
  assert.equal(base.receiver.steps[0].control.jump, false)
  assert.equal(plan.receiver.steps[1].control.jump, true)
  assert.ok(Math.abs(plan.receiver.steps[1].pos.y - bot.entity.position.y - Math.fround(.42)) < 1e-9)
  assert.equal(plan.receiver.native.jumpTicks, bot.jumpTicks)
  assert.equal(plan.receiver.native.onGround, bot.entity.onGround)
  bot.jumpQueued = true
  const queued = remainingWindPlan(bot, base, 1)
  assert.ok(!queued || queued.receiver.native.jumpQueued, 'the shared own native snapshot cannot erase a queued jump')
})

test('the actual pair protocol refuses a nominal positive when an earlier native arrival cannot settle safely', async t => {
  const receiver = preparedPair(t), { bot, base, report, foe } = receiver, controls = { ...edges.IDLE }
  bot._client = new EventEmitter(); bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { bot.ndClock.ticks++; await Promise.resolve() } }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  bot.setControlState = (key, value) => { controls[key] = value }; bot.getControlState = key => !!controls[key]
  bot.equip = async item => { bot.heldItem = item }; bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { bot.usingHeldItem = true }; bot.deactivateItem = () => { bot.usingHeldItem = false }
  const helper = fixture(true).bot, charge = { name: 'wind_charge', count: 16, slot: 36 }
  helper.username = 'thrower'; helper.entity.username = 'thrower'; helper.entity.id = 3; helper.entity.position = new Vec3(-2.5, 1, .5)
  helper._ndSwarmAllies = [bot.username]; helper.inventory.items = () => [charge]; helper.inventory.slots[36] = charge
  helper._client = new EventEmitter(); helper.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }; helper.clearControlStates = () => {}
  helper.equip = async item => { helper.heldItem = item }; helper.look = async (yaw, pitch) => { helper.entity.yaw = yaw; helper.entity.pitch = pitch }
  const ally: any = { ...bot.entity, type: 'player', width: .6, height: 1.8, metadata: [], equipment: [{ name: 'netherite_spear' }] }
  ally.metadata[8] = 1; helper.entities[1] = ally
  let sends = 0
  helper.activateItem = () => { sends++ }
  assert.equal((await windBoost({ bot: helper }, { aborted: false }, { ally: bot.username, plan: base, startTick: 510, prepareOnly: true })).ok, true)
  assert.equal(sends, 0)
  const ctl = { aborted: false, onAbort: [] }, receiving = windReceive({ bot }, ctl, { thrower: report, enemy: foe.username, plan: base, startTick: 510, incomingDps: 0 })
  for (let i = 0; i < 40; i++) await Promise.resolve()
  const tooEarly = await windBoost({ bot: helper }, { aborted: false }, { ally: bot.username, plan: base, startTick: 510 })
  assert.equal(tooEarly.why, 'executed_receiver_progress_required'); assert.equal(sends, 0)
  const state = edges.stateOf(bot, controls)
  edges.simOf(bot)(state, edges.worldOf(bot))
  Object.assign(bot.entity, { position: state.pos.clone(), velocity: state.vel.clone(), onGround: state.onGround })
  bot.jumpTicks = state.jumpTicks; bot.jumpQueued = state.jumpQueued
  bot.ndClock.ticks++; bot.emit('physicsTick')
  const progress = await windPairProgress({ bot }, { startTick: 510 })
  assert.equal(progress.executed, 1); assert.equal(progress.ok, false, JSON.stringify(progress))
  assert.equal(progress.why, 'arrival_phase_not_worth_or_safe'); assert.equal(progress.plan, undefined)
  assert.equal(sends, 0)
  ctl.aborted = true; bot.emit('physicsTick')
  const result = await receiving
  assert.equal(result.ok, false); assert.equal(result.received, false)
  assert.equal((await windPairProgress({ bot }, { startTick: 510 })).phase, 'not_running')
  assert.equal(bot._client.listenerCount('explosion'), 0)
})


test('pair preparation refreshes an expired held charge and rejects an ally in its next look', async () => {
  const { bot } = fixture(), packets = []
  bot._client = new EventEmitter(); bot._ndSwarmAllies = ['Third']; bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.heldItem = { name: 'netherite_spear' }; bot.usingHeldItem = true
  bot._ndUse = { cur: { name: 'netherite_spear', hand: 0, since: -100000 } }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { packets.push('use_item'); bot.usingHeldItem = true }
  bot.deactivateItem = () => { if (bot.usingHeldItem) packets.push('release_use_item'); bot.usingHeldItem = false }
  const plan: any = { spear: { target: 'enemy', name: 'netherite_spear', delay: 8, ordinary: { damage: 0, ticks: 90 }, price: { self: 0 } } }
  const attack = await braceSpearWind(bot, { aborted: false }, plan)
  assert.ok(attack)
  assert.equal(attack.readyAt, 509, 'readiness is measured from this actual fresh use, with one native receipt tick')
  assert.deepEqual(packets, ['release_use_item', 'use_item'], 'an exhausted charge must start a fresh native use duration')
  bot.entities[4] = { id: 4, username: 'Third', type: 'player', position: new Vec3(.5, 1, -2.5), velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8 }
  attack.pitch(0)
  assert.equal(attack.result().cancelled, true, 'the new native ray must be guarded before look changes')
  assert.equal(bot.usingHeldItem, false)
  attack.close()
  assert.equal(bot._client.listenerCount('damage_event'), 0)
})


test('the real wind receiver RPC result preserves a partial native candidate search', async () => {
  const { bot } = fixture(), report = { id: 'thrower', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  const reply = await windReceive({ bot }, { aborted: false }, { thrower: report, enemy: 'enemy', incomingDps: 0, dryRun: true })
  assert.equal(reply.ok, false); assert.equal(reply.partial, true); assert.equal(reply.tried, 12); assert.equal(reply.gameTick, 500)
})

test('the exact owned native spear receipt is accepted only after the matching boost', async () => {
  const { bot, foe } = fixture(true)
  bot.entity.id = 23057; foe.id = 23085; bot._client = new EventEmitter()
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }; bot.heldItem = { name: 'netherite_spear' }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => { bot.usingHeldItem = true }; bot.deactivateItem = () => { bot.usingHeldItem = false }
  const plan: any = { spear: { target: 'enemy', name: 'netherite_spear', delay: 8 } }
  const attack = await braceSpearWind(bot, { aborted: false }, plan)
  assert.ok(attack)
  const packet = { entityId: 23085, sourceTypeId: 37, sourceCauseId: 23058, sourceDirectId: 23058 }
  try {
    bot._client.emit('damage_event', packet); assert.equal(attack.result().hit, false)
    attack.boosted()
    for (const altered of [{ sourceCauseId: 99 }, { sourceDirectId: 99 }, { entityId: 99 }, { sourceTypeId: DAMAGE_TYPES.indexOf('player_attack') }, { sourceTypeId: DAMAGE_TYPES.indexOf('wind_charge') }]) {
      bot._client.emit('damage_event', { ...packet, ...altered }); assert.equal(attack.result().hit, false)
    }
    bot._client.emit('damage_event', packet); assert.equal(attack.result().hit, true)
  } finally { attack.close() }
})

test('the shared fair HP producer already records native spear receipts with only own attribution', () => {
  const { bot, foe } = fixture()
  bot.entity.id = 23057; foe.id = 23085
  bot._client = new EventEmitter(); foe.metadata = []
  Object.defineProperty(foe.metadata, 9, { get() { throw Error('private enemy HP is not a receipt') } })
  const tracker = combatObserve.trackFoe(bot, foe, { roundScope: 'native-spear-receipt', visible: () => true })
  const packet = { entityId: 23085, sourceTypeId: 37, sourceCauseId: 23058, sourceDirectId: 23058 }
  try {
    bot._client.emit('damage_event', { ...packet, sourceCauseId: 99 })
    assert.equal(combatObserve.foeHitProof(bot, foe).hits.length, 0)
    bot._client.emit('damage_event', packet)
    assert.equal(combatObserve.foeHitProof(bot, foe).hits.length, 1)
    assert.equal(tracker.hp.snapshot().exact, false)
  } finally { tracker.stop(); bot.emit('end') }
})
