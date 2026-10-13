'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Session } = require('../src/session')
const { EventBus } = require('../src/events')
const clock = require('../src/game-clock')
const reflexLock = require('../src/reflex-lock')

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
  session.tactics = { enabled: () => false }
  session.state = () => ({ connected: true, busy: session.current?.name || null, clock: game.snapshot() })
  return { session, game }
}
function current (name, done, params = null) {
  return { name, done, params, ctl: { aborted: false, onAbort: [], abort () { this.aborted = true } } }
}

for (const waiting of ['tactics', 'dodge', 'emergency']) {
  test(`Session.stop cancels the ${waiting} prestart wait without gameplay ticks or a late worker`, async () => {
    const { session, game } = fixture()
    const gate = deferred()
    let started = 0
    if (waiting === 'tactics') session.tactics = { enabled: () => true, waitForRelease: () => gate.promise }
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
      assert.equal(result.by.type, 'cancelled')
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
