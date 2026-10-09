import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const combat = require('../src/combat')
const pvp = require('../src/pvp')
const co = require('../src/pvp/combat-observe')

const request = { requestId: 'loot-1', preparation: 'LootChest', quoteEvidence: '{"chest":"a","revision":1}', before: 200, after: 120 }
const scope = { roundScope: 'round-1', fightId: 'fight-1', target: 'Foe' }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function controller() {
  return { aborted: false, onAbort: [] as Array<() => void>, abort() { if (this.aborted) return; this.aborted = true; for (const fn of this.onAbort) fn() } }
}

function fixture(t) {
  const time = new clock.GameClock({ manual: true, epoch: 10000 }); clock.activate(time)
  t.mock.method(Math, 'random', () => .5)
  t.mock.method(console, 'log', () => {})
  const bot: any = new EventEmitter()
  bot.setMaxListeners(100)
  bot._client = new EventEmitter(); bot._client.write = () => {}
  bot.registry = require('minecraft-data')('1.21.11'); bot.version = '1.21.11'
  bot.username = 'NeuroDown'; bot.health = 20; bot.food = 20; bot.foodSaturation = 5
  bot.entity = { id: 1, type: 'player', username: bot.username, position: new Vec3(.5, 0, .5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: -Math.PI / 2, pitch: 0, height: 1.8, width: .6, eyeHeight: 1.62, metadata: [], effects: {} }
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', uuid: 'foe-uuid', isValid: true,
    position: new Vec3(8.5, 0, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI / 2, pitch: 0,
    height: 1.8, width: .6, equipment: [], metadata: [], effects: {} }
  bot.entities = { 1: bot.entity, 2: foe }; bot.players = { Foe: { entity: foe } }
  bot.blockAt = p => ({ name: p.y < 0 ? 'stone' : 'air', position: p.floored(), type: p.y < 0 ? 1 : 0,
    boundingBox: p.y < 0 ? 'block' : 'empty', shapes: p.y < 0 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { getBlock: p => bot.blockAt(p), raycast: () => null }
  bot.inventory = { slots: Array(46).fill(null), items: () => bot.inventory.slots.filter(Boolean) }
  bot.controlState = {}; const controls: any[] = []
  bot.setControlState = (key, value) => { bot.controlState[key] = value; controls.push([key, value]) }
  bot.getControlState = key => !!bot.controlState[key]
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.setControlState(key, false) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async p => { const d = p.minus(bot.entity.position.offset(0, 1.62, 0)); await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))) }
  bot.equip = async item => { bot.heldItem = item }; bot.deactivateItem = () => {}; bot.activateItem = () => {}
  bot.attack = () => {}; bot.swingArm = () => {}; bot.chat = () => {}; bot.findBlock = () => null
  bot.nearestEntity = predicate => Object.values(bot.entities).find(predicate)
  bot.pathfinder = new EventEmitter()
  Object.assign(bot.pathfinder, { movements: { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [] },
    setGoal(goal) { this.goal = goal }, isMoving: () => false, isMining: () => false, isBuilding: () => false })
  const ctl = controller()
  const params = { ...scope, allowPlayer: true, allowStrategicYield: true, arena: { x: 0, y: 0, z: 0, r: 24 }, timeoutSeconds: 3 }
  const session: any = { bot, current: { name: 'fight', ctl, params }, state: () => ({ health: bot.health }),
    bus: { emit: () => {}, drain: () => { throw new Error('yield must not drain the fight event bus') } },
    movements: bot.pathfinder.movements, tactics: { snapshot: () => ({ threatLevel: 0 }) } }
  const ask = (p = {}) => combat.requestStrategicYield?.(session, { ...scope, request, ...p }) || { accepted: false, reason: 'unsupported' }
  const step = async (ticks = 1) => { for (let i = 0; i < ticks; i++) { time.advanceTicks(1); bot.emit('physicsTick'); await flush() } }
  const settle = async promise => {
    let done = false, value, error
    promise.then(v => { value = v; done = true }, e => { error = e; done = true })
    for (let i = 0; i < 240 && !done; i++) await step()
    assert.equal(done, true, 'bounded duel completed')
    if (error) throw error
    return value
  }
  t.after(() => { ctl.abort(); bot.emit('end'); time.dispose() })
  return { bot, foe, ctl, params, session, time, controls, ask, step, settle }
}

function monitor(promise) {
  const state: any = { done: false, promise }
  promise.then(value => { state.done = true; state.value = value }, error => { state.done = true; state.error = error })
  return state
}

test('P8 yield: accepted current fight reaches the real PvP loop and preserves its report', async t => {
  const f = fixture(t)
  const running = combat.fight(f.session, f.ctl, f.params)
  const accepted = f.ask()
  const out = await f.settle(running)
  assert.equal(out.stopped, 'strategic preparation', JSON.stringify({ timeout: out.timeout, target: out.target, micro: out.micro }))
  assert.equal(accepted.accepted, true)
  assert.equal(out.strategicYield.requestId, request.requestId)
  assert.equal(out.target, 'Foe')
  assert.equal(out.micro, true)
  assert.ok(out.melee)
  assert.equal(out.lowHealth, undefined)
  assert.deepEqual(f.bot._ndLastDuel.detail.strategicYield, out.strategicYield)
  assert.equal(out.strategicYield.receivedAt, accepted.receivedAt)
  assert.ok(out.strategicYield.returnedAt >= accepted.receivedAt)
  assert.equal(f.ctl.aborted, false, 'cooperative return is not an abort')
  assert.equal(f.ask().accepted, false, 'finished fight rejects late RPC even before runIntent clears current')
})

test('P8 yield: foreign scope/id/target and malformed payload cannot replace an accepted request', async t => {
  const f = fixture(t)
  const running = combat.fight(f.session, f.ctl, f.params)
  assert.equal(f.ask().accepted, true)
  const controls = f.controls.length
  for (const bad of [{ roundScope: 'other' }, { fightId: 'previous' }, { target: 'Other' }, { fightId: null },
    { request: { ...request, preparation: 'Engage' } }, { request: { ...request, before: Infinity } },
    { request: { ...request, after: NaN } }, { request: { ...request, quoteEvidence: {} } }, { request: {} }]) {
    assert.equal(f.ask(bad).accepted, false)
  }
  assert.equal(f.controls.length, controls, 'mailbox validation never changes controls')
  const out = await f.settle(running)
  assert.equal(out.strategicYield.requestId, request.requestId)
  assert.equal(out.strategicYield.before, request.before)
})

test('P8 yield: RPC updates the original ctl immediately without draining combat events', async t => {
  const f = fixture(t)
  const indexPath = resolve(__dirname, '../src/index.js')
  const source = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8')
  const body = source.slice(source.indexOf('const methods = {'), source.indexOf('const wss ='))
  const code = require('esbuild').transformSync(body + '\nmethods', { loader: 'ts', format: 'cjs' }).code
  const methods = runInNewContext(code, { session: f.session, cfg: {}, require: createRequire(indexPath) })
  assert.equal(typeof methods.fight_yield, 'function')
  const original = f.session.current
  const running = combat.fight(f.session, f.ctl, f.params)
  const reply = await methods.fight_yield({ ...scope, request: { ...request, receivedAt: -999 } })
  assert.equal(reply.status, 'done')
  assert.equal(reply.detail.accepted, true)
  assert.equal(reply.events.length, 0)
  assert.equal(reply.detail.receivedAt, f.time.now(), 'client cannot forge freshness')
  assert.equal(f.session.current, original)
  assert.equal(f.ctl.aborted, false)
  const out = await f.settle(running)
  assert.equal(out.strategicYield.receivedAt, reply.detail.receivedAt)
})

test('P8 yield: ordinary fight remains opt-out; request is not a global stop', async t => {
  const f = fixture(t)
  f.params.allowStrategicYield = false
  const running = combat.fight(f.session, f.ctl, f.params)
  assert.equal(f.ask().accepted, false)
  const out = await f.settle(running)
  assert.equal(out.timeout, true)
  assert.equal(out.strategicYield, undefined)
  assert.equal(f.ctl.aborted, false)
  f.session.current = { name: 'eat', ctl: controller(), params: { ...f.params, allowStrategicYield: true } }
  assert.equal(f.ask().accepted, false)
  assert.equal(f.session.current.ctl.aborted, false)
})

for (const mode of ['airborne', 'gliding', 'water pickup', 'aerial recovery', 'fall guard']) {
  test(`P8 yield: ${mode} keeps the body; only a fresh request after completion returns it`, async t => {
    const f = fixture(t)
    f.params.timeoutSeconds = 8
    if (mode === 'airborne') f.bot.entity.onGround = false
    if (mode === 'gliding') f.bot.entity.elytraFlying = true
    if (mode === 'water pickup') f.bot._ndClutch = { waterPlan: {} }
    if (mode === 'aerial recovery') f.bot._ndAerialRecovering = () => true
    if (mode === 'fall guard') f.bot._ndFallGuard = { busy: true }
    const run = monitor(combat.fight(f.session, f.ctl, f.params))
    const controls = f.controls.length
    assert.equal(f.ask().accepted, true)
    assert.equal(f.controls.length, controls, 'request is not a control command')
    await f.step(10)
    assert.equal(run.done, false, run.error?.stack)
    assert.equal(f.ctl.aborted, false)
    f.bot.entity.onGround = true; f.bot.entity.elytraFlying = false
    f.bot._ndClutch = null; f.bot._ndAerialRecovering = null; f.bot._ndFallGuard = null
    const fresh = f.ask({ request: { ...request, requestId: 'after-landing' } })
    const out = await f.settle(run.promise)
    assert.equal(out.strategicYield.requestId, 'after-landing')
    assert.equal(out.strategicYield.receivedAt, fresh.receivedAt)
  })
}

for (const mode of ['revoked', 'expired']) test(`P8 yield: ${mode} quote does not execute after water pickup`, async t => {
  const f = fixture(t)
  f.params.timeoutSeconds = 8
  f.bot._ndClutch = { waterPlan: {} }
  const run = monitor(combat.fight(f.session, f.ctl, f.params))
  assert.equal(f.ask().accepted, true)
  if (mode === 'revoked') assert.equal(f.ask({ request: null }).accepted, true)
  await f.step(mode === 'expired' ? 22 : 4)
  f.bot._ndClutch = null
  await f.step(5)
  assert.equal(run.done, false, run.error?.stack)
  assert.equal(f.ask({ request: { ...request, requestId: 'new-quote' } }).accepted, true)
  const out = await f.settle(run.promise)
  assert.equal(out.strategicYield.requestId, 'new-quote')
})

test('P8 yield: an awaited aerial skill finishes normally before the loop can hand off', async t => {
  const f = fixture(t)
  const elytra = require('../src/elytra')
  const create = elytra.create
  let release: () => void, started = false
  t.mock.method(elytra, 'create', (...args) => {
    const sky = create(...args)
    return { ...sky, decide: () => started ? null : { kind: 'evade' }, async run() {
      started = true; f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true
      f.bot.setControlState('forward', true)
      await new Promise<void>(resolve => { release = resolve })
      f.bot.entity.onGround = true; f.bot.entity.elytraFlying = false
      return { note: 'landed after awaited skill' }
    } }
  })
  const run = monitor(combat.fight(f.session, f.ctl, f.params))
  for (let i = 0; i < 20 && !started; i++) await f.step()
  assert.equal(started, true, run.error?.stack)
  const controls = f.controls.length
  assert.equal(f.ask().accepted, true)
  await flush()
  assert.equal(run.done, false)
  assert.equal(f.controls.length, controls)
  assert.equal(f.bot.getControlState('forward'), true)
  assert.equal(f.ctl.aborted, false)
  release!()
  const out = await f.settle(run.promise)
  assert.equal(out.strategicYield.requestId, request.requestId)
  assert.equal(out.tricks['landed after awaited skill'], 1)
})

test('P8 yield: death takes precedence and abort closes only its original controller', async t => {
  const f = fixture(t)
  f.bot._ndClutch = { waterPlan: {} }
  const running = combat.fight(f.session, f.ctl, f.params)
  assert.equal(f.ask().accepted, true)
  await f.step(8)
  f.bot.health = 0
  f.bot.emit('death')
  const out = await f.settle(running)
  assert.equal(out.died, true)
  assert.equal(out.strategicYield, undefined)
  f.bot.health = 20
  const next = controller()
  f.session.current = { name: 'fight', ctl: next, params: { ...f.params, fightId: 'fight-2' } }
  assert.equal(f.ask().accepted, false, 'late old fightId cannot request the new fight')
  assert.equal(f.ask({ fightId: 'fight-2' }).accepted, true)
  f.ctl.abort()
  assert.equal(next.aborted, false)
  next.abort()
  assert.equal(f.ask({ fightId: 'fight-2' }).accepted, false)
})

test('P8 yield: old completion cannot clear another controller request', async t => {
  const f = fixture(t)
  f.bot._ndClutch = { waterPlan: {} }
  const running = combat.fight(f.session, f.ctl, f.params)
  assert.equal(f.ask().accepted, true)
  const next = controller(), nextParams = { ...f.params, fightId: 'fight-2' }
  t.after(() => next.abort())
  f.session.current = { name: 'fight', ctl: next, params: nextParams }
  f.bot._ndClutch = null
  const out = await f.settle(running)
  assert.equal(out.timeout, true, 'old reader loses ownership even with a still-live ctl')
  assert.equal(out.strategicYield, undefined)
  const second = combat.fight(f.session, next, nextParams)
  assert.equal(f.ask({ fightId: 'fight-2' }).accepted, true)
  const resumed = await f.settle(second)
  assert.equal(resumed.strategicYield.requestId, request.requestId)
})

test('P8 yield: confirmed hit survives handoff and dormant aging; raw HP never replaces the estimator', async t => {
  const f = fixture(t)
  const tracks = [], trackFoe = co.trackFoe
  t.mock.method(co, 'trackFoe', (...args) => { const track = trackFoe(...args); tracks.push(track); return track })
  const running = combat.fight(f.session, f.ctl, f.params)
  for (let i = 0; i < 10 && !tracks.length; i++) await f.step()
  assert.equal(tracks.length, 1)
  tracks[0].noteAttack({ min: 12, max: 12, mean: 12, raw: 12 })
  f.bot._client.emit('damage_event', { entityId: f.foe.id, sourceTypeId: 0, sourceCauseId: 2, sourceDirectId: 2 })
  f.bot.emit('entityHurt', f.foe, f.bot.entity)
  assert.equal(tracks[0].hp.snapshot().lo, 8)
  assert.equal(f.ask().accepted, true)
  const out = await f.settle(running)
  assert.equal(out.landed, 1)
  assert.ok(out.strategicYield)
  const h1 = co.readFoeEstimate(f.bot, { roundScope: scope.roundScope, target: 'Foe' })
  f.foe.metadata[9] = 1
  await f.step(20)
  const aged = co.readFoeEstimate(f.bot, { roundScope: scope.roundScope, target: 'Foe' })
  assert.equal(aged.lo, h1.lo)
  assert.ok(aged.hi > h1.hi, 'idle time widens the existing estimate')
  f.foe.metadata[9] = 20
  const next = controller(), nextParams = { ...f.params, fightId: 'fight-2' }
  t.after(() => next.abort())
  f.session.current = { name: 'fight', ctl: next, params: nextParams }
  const second = combat.fight(f.session, next, nextParams)
  for (let i = 0; i < 10 && tracks.length < 2; i++) await f.step()
  assert.equal(tracks[1].hp.snapshot().lo, aged.lo)
  assert.equal(tracks[1].hp.snapshot().exact, false)
  assert.equal(f.ask({ fightId: 'fight-2' }).accepted, true)
  assert.ok((await f.settle(second)).strategicYield)
  const newScope = co.trackFoe(f.bot, f.foe, { roundScope: 'round-2', visible: () => true })
  assert.equal(newScope.hp.snapshot().lo, 20)
  newScope.stop()
  f.bot.emit('death')
  assert.equal(co.readFoeEstimate(f.bot, { roundScope: 'round-2', target: 'Foe' }), null)
})

for (const mode of ['airborne', 'revoked', 'expired']) test(`P8 yield: ${mode} during awaited finish preparation cannot return a stale handoff`, async t => {
  const f = fixture(t)
  f.params.timeoutSeconds = 8
  const duel = pvp.duel
  let release: () => void, preparing = false
  t.mock.method(pvp, 'duel', (session, ctl, entity, opts) => duel(session, ctl, entity, { ...opts,
    guard: { ...opts.guard, async raise(want) {
      if (!want && !preparing) { preparing = true; await new Promise<void>(resolve => { release = resolve }) }
      return opts.guard.raise(want)
    } }
  }))
  const run = monitor(combat.fight(f.session, f.ctl, f.params))
  assert.equal(f.ask().accepted, true)
  for (let i = 0; i < 20 && !preparing; i++) await f.step()
  assert.equal(preparing, true, run.error?.stack)
  if (mode === 'airborne') f.bot.entity.onGround = false
  if (mode === 'revoked') assert.equal(f.ask({ request: null }).accepted, true)
  if (mode === 'expired') await f.step(22)
  release!()
  await f.step(3)
  assert.equal(run.done, false, 'cleanup await is still inside the old fight')
  f.bot.entity.onGround = true
  assert.equal(f.ask({ request: { ...request, requestId: 'after-cleanup' } }).accepted, true)
  assert.equal((await f.settle(run.promise)).strategicYield.requestId, 'after-cleanup')
})
