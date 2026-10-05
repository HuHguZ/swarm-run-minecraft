'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { GameClock, wall, follow, snapshot, changes } = require('../src/game-clock')

test('game delays and intervals use ticks, with cancellation and callback arguments', () => {
  const c = new GameClock({ manual: true, epoch: 1000 })
  const seen = []
  c.setTimeout(x => seen.push([x, c.now()]), 120, 'after3')
  const cancelled = c.setTimeout(() => seen.push('bad'), 50)
  c.clearTimeout(cancelled)
  const repeating = c.setInterval(() => seen.push(['interval', c.now()]), 100)
  c.advanceTicks(3)
  assert.deepEqual(seen, [['interval', 1100], ['after3', 1150]])
  c.clearInterval(repeating)
  c.advanceTicks(2)
  assert.equal(seen.length, 2)
  c.dispose()
})

test('freeze and step consume exactly the requested ticks without expiring game budgets', async () => {
  const c = new GameClock({ manual: true, epoch: 1000 })
  let done = false
  const sleep = c.sleep(150).then(() => { done = true })
  c.setState({ tick_rate: 100, is_frozen: true })
  c.pulse(); c.pulse()
  assert.equal(c.now(), 1000)
  c.step(2)
  c.pulse(); c.pulse(); c.pulse()
  await Promise.resolve()
  assert.equal(c.now(), 1100)
  assert.equal(done, false)
  c.step(1); c.pulse()
  await sleep
  assert.equal(c.now(), 1150)
  c.dispose()
})

test('tick rate changes do not change deadlines or simulate more than one tick per pulse', () => {
  const c = new GameClock({ manual: true, epoch: 0 })
  c.advanceTicks(10)
  c.setState({ tick_rate: 100, is_frozen: false })
  assert.equal(c.now(), 500)
  c.pulse()
  assert.equal(c.now(), 550)
  assert.equal(c.snapshot().tickRate, 100)
  c.setState({ tick_rate: 5, is_frozen: false })
  assert.equal(c.now(), 550)
  c.dispose()
})

test('scheduled callbacks preserve reflex AsyncLocalStorage ownership', () => {
  const als = new AsyncLocalStorage()
  const c = new GameClock({ manual: true })
  let owner
  als.run('worker', () => c.setTimeout(() => { owner = als.getStore() }, 50))
  als.run('physics', () => c.advanceTicks(1))
  assert.equal(owner, 'worker')
  c.dispose()
})

test('server age uses elapsed ticks, never daylight time or absolute world age', () => {
  const c = new GameClock({ manual: true, epoch: 0 })
  c.syncAge(1000000n)
  c.advanceTicks(20)
  c.syncAge(1000020n)
  assert.equal(c.now(), 1000)
  // Dimension age/rewind is a new anchor, not a million-tick catchup.
  c.syncAge(2000n)
  assert.equal(c.now(), 1000)
  c.dispose()
})

test('bound clock listens to protocol controls and stops on end', () => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const c = new GameClock({ manual: true }).attach(bot)
  bot._client.emit('set_ticking_state', { tick_rate: 60, is_frozen: true })
  bot._client.emit('step_tick', { tick_steps: 2 })
  c.pulse(); c.pulse(); c.pulse()
  assert.equal(c.snapshot().ticks, 2)
  bot.emit('end')
  c.pulse()
  assert.equal(c.snapshot().ticks, 2)
  assert.equal(bot._client.listenerCount('set_ticking_state'), 0)
})

function driver (t, { quantum = 0 } = {}) {
  let now = 0
  const timers = new Map()
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(wall, 'setTimeout', (fn, delay) => {
    const handle = { unref () {} }
    timers.set(handle, { fn, at: now + (quantum ? Math.ceil(delay / quantum) * quantum : delay) })
    return handle
  })
  t.mock.method(wall, 'clearTimeout', handle => timers.delete(handle))
  if (wall.setImmediate) {
    t.mock.method(wall, 'setImmediate', fn => {
      const handle = { unref () { this.unreferenced = true } }
      timers.set(handle, { fn, at: now + 0.25 })
      return handle
    })
    t.mock.method(wall, 'clearImmediate', handle => timers.delete(handle))
  }
  function next () {
    return [...timers].sort((a, b) => a[1].at - b[1].at)[0]
  }
  const result = {
    now: () => now,
    pending: () => timers.size,
    referenced: () => [...timers.keys()].filter(handle => !handle.unreferenced).length,
    async turn () {
      const scheduled = next()
      assert.ok(scheduled, 'the clock scheduled another native timer turn')
      timers.delete(scheduled[0])
      now = Math.max(now, scheduled[1].at)
      scheduled[1].fn()
      await new Promise(resolve => setImmediate(resolve))
    },
    async advanceTo (at) {
      while (next()?.[1].at <= at) await result.turn()
      now = at
    }
  }
  return result
}

test('server TPS samples aggregate packet jitter over at least one second', async t => {
  const time = driver(t)
  const c = new GameClock({ manual: true, epoch: 0 })
  c.setState({ tick_rate: 100 })
  c.syncAge(0n)
  for (const [at, age] of [[100, 20n], [400, 40n], [500, 60n], [800, 80n], [1000, 100n]]) {
    await time.advanceTo(at)
    c.syncAge(age)
    assert.equal(c.effectiveRate, 100)
  }
  await time.advanceTo(1800)
  c.syncAge(140n)
  assert.equal(c.effectiveRate, 100)
  await time.advanceTo(2000)
  c.syncAge(150n)
  assert.equal(c.effectiveRate, 50, 'sustained server slowdown is still measured')
  c.dispose()
})

test('rate and dimension changes discard the previous age sampling window', async t => {
  const time = driver(t)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const c = new GameClock({ manual: true }).attach(bot)
  c.setState({ tick_rate: 100 })
  c.syncAge(1000n)
  await time.advanceTo(1000)
  c.syncAge(1050n)
  assert.equal(c.effectiveRate, 50)
  c.setState({ tick_rate: 60 })
  await time.advanceTo(1100)
  c.syncAge(1056n)
  await time.advanceTo(2100)
  c.syncAge(1116n)
  assert.equal(c.effectiveRate, 60)
  await time.advanceTo(3100)
  c.syncAge(1146n)
  assert.equal(c.effectiveRate, 30)
  bot.emit('respawn')
  assert.equal(c.effectiveRate, 60)
  assert.equal(c.snapshot().serverTicks, null)
  assert.equal(c.snapshot().lagTicks, null)
  c.syncAge(100000n)
  await time.advanceTo(4100)
  c.syncAge(100060n)
  assert.equal(c.effectiveRate, 60)
  c.dispose()
})

test('confirmed server backlog catches up one event loop turn per tick with microtask windows', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0 })
  c.setState({ tick_rate: 100 })
  c.syncAge(0n)
  c.start()
  await time.advanceTo(600)
  assert.equal(c.ticks, 20, 'prediction stops twenty ticks ahead of the last age packet')
  c.syncAge(60n)
  assert.equal(c.snapshot().serverTicks, 60)
  assert.equal(c.snapshot().lagTicks, 40)
  const seen = []
  c.setInterval(() => {
    const tick = c.ticks
    seen.push(tick)
    Promise.resolve().then(() => seen.push(`after:${tick}`))
  }, 50)
  for (let tick = 21; tick <= 60; tick++) {
    await time.turn()
    assert.equal(c.ticks, tick)
    assert.deepEqual(seen.slice(-2), [tick, `after:${tick}`])
  }
  assert.ok(time.now() <= 640, 'confirmed ticks are not limited by the native timer quantum')
  assert.equal(c.snapshot().lagTicks, 0)
  await time.advanceTo(time.now() + 10)
  assert.equal(c.ticks, 61, 'normal pacing resumes after catching up')
  c.dispose()
})

test('high TPS pacing survives a sixteen millisecond native timer quantum', async t => {
  const time = driver(t, { quantum: 16 })
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.start()
  assert.equal(time.referenced(), 1, 'short waits must keep poll awake without external packets')
  await time.advanceTo(1000)
  assert.equal(c.ticks, 200)
})

test('freeze, completed steps and disposal cancel the short-wait pump', async t => {
  const time = driver(t, { quantum: 16 })
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.start()
  assert.equal(time.pending(), 1)
  c.setState({ is_frozen: true })
  assert.equal(time.pending(), 0)
  await time.advanceTo(100)
  c.step(2)
  await time.advanceTo(200)
  assert.equal(c.ticks, 2)
  assert.equal(time.pending(), 0)
  c.setState({ is_frozen: false })
  const sleeping = c.sleep(1000)
  c.dispose()
  await sleeping
  assert.equal(time.pending(), 0)
  assert.equal(c.timers.size, 0)
  await time.advanceTo(400)
  assert.equal(c.ticks, 2)
})

test('stalled prediction releases the pump and a fresh age packet resumes it', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.syncAge(0n)
  c.start()
  await time.advanceTo(200)
  assert.equal(c.ticks, 20)
  assert.equal(time.pending(), 0)
  c.syncAge(20n)
  await time.advanceTo(210)
  assert.equal(c.ticks, 22)
})

test('duplicate frozen follower snapshots do not postpone confirmed step grants', async t => {
  const time = driver(t)
  const source = { id: 'frozen-regression', ticks: 0, gameMs: 0, tickRate: 20, frozen: true, running: true }
  let c
  changes.once('bound', clock => { c = clock })
  follow(source)
  t.after(() => c.dispose())
  source.ticks = 3
  source.gameMs = 150
  follow(source)
  for (let n = 1; n <= 20; n++) {
    await time.advanceTo(n / 2)
    follow(source)
  }
  assert.equal(snapshot().ticks, 3)
  assert.equal(snapshot().stepping, 0)
  assert.equal(snapshot().lagTicks, 0)
})

test('followers replay confirmed snapshots without predicting or keeping an idle pump', async t => {
  const time = driver(t)
  const source = { id: 'confirmed-follower', ticks: 100, gameMs: 5000, tickRate: 250, frozen: false, running: true }
  let c
  changes.once('bound', clock => { c = clock })
  follow(source)
  t.after(() => c.dispose())
  assert.equal(time.pending(), 0, 'a follower does not predict future daemon ticks')
  const seen = []
  c.setInterval(() => {
    const tick = c.ticks
    seen.push(tick)
    Promise.resolve().then(() => seen.push(`after:${tick}`))
  }, 50)
  let slept = false
  const sleeping = c.sleep(100).then(() => { slept = true })
  source.ticks = 104
  source.gameMs = 5200
  follow(source)
  for (let tick = 101; tick <= 104; tick++) {
    await time.turn()
    assert.equal(c.ticks, tick)
    assert.deepEqual(seen.slice(-2), [tick, `after:${tick}`])
  }
  await sleeping
  assert.equal(slept, true)
  assert.equal(time.pending(), 0)
  await time.advanceTo(1000)
  assert.equal(c.ticks, 104, 'only later snapshots advance the follower')
  source.frozen = true
  follow(source)
  source.ticks = 107
  source.gameMs = 5350
  follow(source)
  for (let tick = 105; tick <= 107; tick++) {
    await time.turn()
    assert.equal(c.ticks, tick)
  }
  assert.equal(c.steps, 0)
  assert.equal(time.pending(), 0)
  source.frozen = false
  source.running = false
  follow(source)
  await time.advanceTo(2000)
  assert.equal(c.ticks, 107, 'an ended source cannot independently resume ticking')
  const cancelledOnReconnect = c.sleep(1000)
  const previous = c
  changes.once('bound', clock => { c = clock })
  follow({ ...source, id: 'replacement-follower', ticks: 2, gameMs: 100, running: true })
  await cancelledOnReconnect
  assert.equal(previous.disposed, true)
  assert.equal(previous.timers.size, 0)
  assert.equal(c.ticks, 2)
  assert.equal(time.pending(), 0)
})
