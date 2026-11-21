'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Session } from '../src/session'
import { EventBus } from '../src/events'
import * as clock from '../src/game-clock'
import reflexLock = require('../src/reflex-lock')
import { swarmMethods } from '../src/rpc/swarm'
import { aerialMethods } from '../src/rpc/aerial'

function deferred () {
  let resolve
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve: () => resolve() }
}
function turn () { return new Promise<void>(resolve => setImmediate(resolve)) }
async function bounded (promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('queued cancellation exceeded 100 wall ms')), 100)
    })])
  } finally { clearTimeout(timer) }
}
function fixture () {
  const game = clock.activate(new clock.GameClock({ manual: true }))
  game.setState({ is_frozen: true })
  const session = new Session({}, new EventBus(), { state: {}, append () {} })
  session.tactics = { enabled: () => false } as any
  session.state = () => ({ connected: true, busy: session.current?.name || null, clock: game.snapshot() })
  return { session, game }
}
function current (name, done, params = null) {
  return { name, done, params, ctl: { aborted: false, onAbort: [], abort () { this.aborted = true } } }
}

for (const method of ['boost_lance', 'boost_shot', 'pearl_trap'] as const) test('an expired pearl cannot cancel the active route at handover: ' + method, async t => {
  const { session, game } = fixture(), gate = deferred()
  const route = current('goto', Promise.resolve()), world = { age: 100n, ticks: 0, serverTicks: 0 }
  const bot: any = session.bot = Object.assign(new EventEmitter(), { entity: {}, ndClock: world, clearControlStates() {} }) as any
  session.current = route as any
  session.tactics = { enabled: () => true, waitForRelease: () => gate.promise } as any
  let starts = 0
  const api = method === 'pearl_trap' ? require('../src/combat/pearl-trap') : require('../src/combat/arrow-boost')
  t.mock.method(api, { boost_lance: 'boostLanceRpc', boost_shot: 'boostShotRpc', pearl_trap: 'pearlTrap' }[method], async () => { starts++; return { ok: true } })
  const pending = aerialMethods({ session } as any)[method]({ at: { x: 0, y: 64, z: 0 }, eta: 30, gameTick: 100 })
  try {
    await turn()
    assert.equal(route.ctl.aborted, false)
    bot.ndClock.ticks = method === 'boost_shot' ? 29 : 31
    gate.resolve()
    const result: any = await bounded(pending)
    assert.equal(starts, 0)
    assert.equal(result.notStarted, true)
    assert.equal(route.ctl.aborted, false, 'leave the previous movement owner intact')
    assert.equal(session.current, route)
  } finally { gate.resolve(); game.dispose(); if (clock.snapshot()) clock.activate(null) }
})

test('a late flank goto cannot cancel the mace shield RPC before it blocks', async t => {
  const { session, game } = fixture(), landing = deferred()
  let shieldCtl
  t.mock.method(require('../src/swarm-position-work'), 'swarmHold', async (_session, ctl) => {
    shieldCtl = ctl
    await Promise.race([landing.promise, new Promise(resolve => ctl.onAbort.push(resolve))])
    return { ok: !ctl.aborted, why: ctl.aborted ? 'cancelled' : 'completed' }
  })
  const pending = swarmMethods({ session } as any).swarm_hold({
    shield: true, requireShield: true, whileSmash: 'NeuroFarm31ai', seconds: 20
  })
  try {
    await turn()
    assert.equal(session.current.name, 'swarm_hold')
    const walk = await session.goto({ x: 624, y: 128, z: 550, climb: true })
    assert.equal(shieldCtl.aborted, false, 'the arriving goto must leave the shield raised')
    assert.equal(walk.notStarted, true)
    assert.equal(walk.code, 'DEFENSE_BUSY')
    assert.equal(session._prestartIntents.size, 0)
    landing.resolve()
    assert.equal((await pending).detail.why, 'completed')
    const next = await session.runIntent('goto', () => ({ arrived: true }), { interruptible: false, timeoutMs: 0 })
    assert.deepEqual(next.detail, { arrived: true })
  } finally { landing.resolve(); session.cancel(); await pending; game.dispose() }
})

test('a plain formation yields to walking and an emergency or stop can interrupt a mace guard', async () => {
  const { session, game } = fixture()
  try {
    for (const [name, params] of [['goto', { shield: true }], ['dodge_blast', { whileSmash: 'Foe' }], ['stop', { whileSmash: 'Foe' }]] as const) {
      const previous = session.current = current('swarm_hold', Promise.resolve(), params)
      if (name === 'stop') await session.stop()
      else {
        const next = await session.runIntent(name, () => ({ ran: true }), { timeoutMs: 0, interruptible: false })
        assert.deepEqual(next.detail, { ran: true })
      }
      assert.equal(previous.ctl.aborted, true, name)
    }
  } finally { session.cancel(); game.dispose() }
})

for (const waiting of ['tactics', 'dodge', 'emergency']) {
  test(`Session.stop cancels the ${waiting} prestart wait without gameplay ticks or a late worker`, async () => {
    const { session, game } = fixture()
    const gate = deferred()
    let started = 0
    if (waiting === 'tactics') session.tactics = { enabled: () => true, waitForRelease: () => gate.promise } as any
    if (waiting === 'dodge') session.current = current('wind_leap', gate.promise)
    if (waiting === 'emergency') {
      const bot: any = session.bot = new EventEmitter()
      bot.pathfinder = { setGoal () {} }
      bot.clearControlStates = () => {}
      reflexLock.start(session, () => gate.promise, { owner: 'Emergency', priority: 3 })
    }
    const pending = session.runIntent(waiting === 'emergency' ? 'wind_leap' : 'test_prestart', () => { started++; return { entered: true } }, { timeoutMs: 0, interruptible: false })
    try {
      await turn()
      assert.equal(started, 0)
      await session.stop()
      const result: any = await bounded(pending)
      assert.equal(result.status, 'interrupted')
      assert.deepEqual(result.by, { type: 'cancelled', by: 'stop' })
      assert.equal(result.notStarted, true)
      assert.equal(result.code, 'CANCELLED')
      assert.equal(result.state.busy, null)
      assert.equal(game.ticks, 0)
      assert.equal(game.timers.size, 0)
      gate.resolve()
      await turn()
      assert.equal(started, 0)
      assert.equal(session._prestartIntents.size, 0)
      assert.equal(session.current, null)
    } finally {
      gate.resolve()
      session.cancel()
      await pending
      game.dispose()
    }
  })
}

test('a healthy dodge still finishes before the next exclusive worker starts', async () => {
  const { session, game } = fixture()
  const gate = deferred()
  const old = session.current = current('wind_leap', gate.promise)
  let started = 0
  const pending = session.runIntent('test_prestart', () => { started++; return { entered: true } }, { timeoutMs: 0, interruptible: false })
  try {
    await turn()
    assert.equal(session.current, old)
    assert.equal(old.ctl.aborted, false)
    assert.equal(started, 0)
    gate.resolve()
    const result: any = await bounded(pending)
    assert.equal(result.status, 'done')
    assert.equal(started, 1)
    assert.equal(session._prestartIntents.size, 0)
  } finally { gate.resolve(); session.cancel(); await pending; game.dispose() }
})

test('a rescue flight rejects a new exclusive intent without registering an orphan waiter', async () => {
  const { session, game } = fixture()
  const old = session.current = current('fly_to', Promise.resolve(), { rescue: true })
  let started = 0
  try {
    const result = await session.runIntent('test_prestart', () => { started++ }, { timeoutMs: 0, interruptible: false })
    assert.equal(result.code, 'RESCUE_BUSY')
    assert.equal(session.current, old)
    assert.equal(old.ctl.aborted, false)
    assert.equal(started, 0)
    assert.equal(session._prestartIntents.size, 0)
  } finally { session.cancel(); game.dispose() }
})

test('the queued cancellation does not cancel a replacement worker after the old dodge settles', async () => {
  const { session, game } = fixture()
  const oldGate = deferred(), replacementGate = deferred()
  session.current = current('wind_leap', oldGate.promise)
  let lateStarted = 0
  const queued = session.runIntent('test_prestart', () => { lateStarted++ }, { timeoutMs: 0, interruptible: false })
  let replacement
  try {
    await turn()
    session.cancel()
    await bounded(queued)
    replacement = session.runIntent('test_replacement', () => replacementGate.promise, { timeoutMs: 0, interruptible: false })
    await turn()
    const ctl = session.current.ctl
    oldGate.resolve()
    await turn()
    assert.equal(lateStarted, 0)
    assert.equal(session.current.name, 'test_replacement')
    assert.equal(ctl.aborted, false)
    replacementGate.resolve()
    assert.equal((await bounded(replacement)).status, 'done')
  } finally { oldGate.resolve(); replacementGate.resolve(); session.cancel(); await queued; await replacement; game.dispose() }
})

for (const [by, prior] of [
  ['test_next', null], ['stop', null], ['stop', { type: 'tactical' }]
] as const) test('cancel source ' + by + ' ' + (prior?.type || ''), async () => {
  const { session, game } = fixture()
  let ctl
  const pending = session.runIntent('test_current', c => {
    ctl = c
    if (prior) c.interruptedBy = prior
    return new Promise(resolve => c.onAbort.push(() => resolve({ swings: 0, landed: 0 })))
  }, { timeoutMs: 0, interruptible: false })
  try {
    await turn()
    if (by === 'stop') await session.stop()
    else await session.runIntent(by, () => ({}), { timeoutMs: 0, interruptible: false })
    const result = await bounded(pending), expected = prior || { type: 'cancelled', by }
    assert.deepEqual(ctl.interruptedBy, expected)
    assert.deepEqual(result.by, expected)
    assert.equal(result.code, prior ? 'TACTICAL' : 'CANCELLED')
  } finally { session.cancel(); await pending; game.dispose() }
})
