import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const lock = require('../src/reflex-lock')
const { runIntent } = require('../src/session/intent-runner')
const { EventBus } = require('../src/events')

function deferred() {
  let resolve: (value?: any) => void
  const promise = new Promise<any>(done => { resolve = done })
  return { promise, resolve: (value?: any) => resolve(value) }
}

function fixture() {
  const bot: any = new EventEmitter()
  const keys: Record<string, boolean> = {}
  const receipts: string[] = []
  bot.pathfinder = { goal: null, setGoal(goal) { this.goal = goal; receipts.push('goal') } }
  bot.setControlState = (key, value) => { keys[key] = value; receipts.push(`${key}:${value}`) }
  bot.clearControlStates = () => { for (const key of Object.keys(keys)) keys[key] = false; receipts.push('clear') }
  bot.inventory = { slots: [], items: () => [] }
  const session: any = { bot, current: null, reflex: null, bus: new EventBus(), state: () => ({ keys: { ...keys } }),
    cancel() { if (this.current) this.current.ctl.abort(); this.current = null; bot.pathfinder.setGoal(null); bot.clearControlStates() } }
  lock.install(session)
  return { session, bot, keys, receipts }
}

function walking(f) {
  const ready = deferred(), finish = deferred()
  let ctl: any, unwound = false
  const result = runIntent.call(f.session, 'edge_walk', async c => {
    ctl = c
    f.bot.setControlState('forward', true)
    f.bot.pathfinder.setGoal({ walking: true })
    c.onAbort.push(() => finish.resolve())
    ready.resolve()
    try { await finish.promise } finally { f.bot.setControlState('forward', false); unwound = true }
  }, { timeoutMs: 0 })
  return { ready: ready.promise, result, ctl: () => ctl, unwound: () => unwound }
}

test('interrupt clears the owned walking keys even though its aborted finally is fenced', async () => {
  const f = fixture(), w = walking(f)
  await w.ready
  f.session.bus.emit('chat', { message: 'stop' })
  const result = await w.result
  assert.equal(result.code, 'CHAT')
  assert.equal(w.unwound(), true)
  assert.equal(f.receipts.includes('forward:false'), false, 'the stale worker remains fenced')
  assert.equal(f.keys.forward, false, 'the intent owner must clear the physical key')
  assert.equal(f.bot.pathfinder.goal, null)
  assert.equal(f.session.current, null)
})

test('external tactical cancellation releases walking before a nonexclusive wait starts', async () => {
  const f = fixture(), w = walking(f)
  await w.ready
  w.ctl().interruptedBy = { type: 'tactical' }
  w.ctl().abort()
  assert.equal(f.keys.forward, false, 'abort must release synchronously, before the result continuation')
  assert.equal(f.bot.pathfinder.goal, null)
  const result = await w.result
  assert.equal(result.code, 'TACTICAL')
  await runIntent.call(f.session, 'wait', async () => ({}), { exclusive: false, interruptible: false, timeoutMs: 0 })
  assert.equal(f.keys.forward, false)
})

for (const owner of ['Tactical', 'Emergency']) test(`old intent abort preserves the new ${owner} owner's controls`, async () => {
  const f = fixture(), w = walking(f), release = deferred(), ready = deferred()
  await w.ready
  const lease = lock.start(f.session, async () => {
    f.bot.setControlState('back', true)
    f.bot.pathfinder.setGoal({ defence: true })
    ready.resolve()
    await release.promise
  }, { owner, priority: owner === 'Emergency' ? 3 : 2, source: 'test-defence', immediate: true })
  await ready.promise
  const clears = f.receipts.filter(x => x === 'clear').length
  w.ctl().abort()
  await w.result
  assert.equal(lock.owner(f.session)?.owner, owner)
  assert.equal(f.keys.back, true)
  assert.deepEqual(f.bot.pathfinder.goal, { defence: true })
  assert.equal(f.receipts.filter(x => x === 'clear').length, clears)
  release.resolve()
  await lease
})

test('old intent abort cannot clear a replacement skill or its persistent goal', async () => {
  const f = fixture(), w = walking(f)
  await w.ready
  const replacement = { aborted: false, onAbort: [], abort() { this.aborted = true } }
  f.session.current = { name: 'replacement', ctl: replacement }
  lock.run(f.session, replacement, () => {
    f.bot.setControlState('right', true)
    f.bot.pathfinder.setGoal({ replacement: true })
  })
  w.ctl().abort()
  await w.result
  assert.equal(f.keys.right, true)
  assert.deepEqual(f.bot.pathfinder.goal, { replacement: true })
  assert.equal(f.session.current.ctl, replacement)
})

test('a defence started synchronously by path reset keeps its new keys', async () => {
  const f = fixture(), w = walking(f), release = deferred()
  await w.ready
  const reset = f.bot.pathfinder.setGoal
  let lease: any
  f.bot.pathfinder.setGoal = goal => {
    reset(goal)
    if (goal === null && !lease) lease = lock.start(f.session, async () => {
      f.bot.setControlState('back', true)
      await release.promise
    }, { owner: 'Emergency', priority: 3, source: 'test-reset', immediate: true })
  }
  w.ctl().abort()
  await w.result
  assert.equal(f.keys.back, true)
  release.resolve()
  await lease
})

test('nonexclusive wait retains the existing follow goal and walking keys', async () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.pathfinder.setGoal({ follow: true })
  await runIntent.call(f.session, 'wait', async () => ({}), { exclusive: false, interruptible: false, timeoutMs: 0 })
  assert.equal(f.keys.forward, true)
  assert.deepEqual(f.bot.pathfinder.goal, { follow: true })
})

test('a late old worker cannot press or release the next skill keys after cleanup', async () => {
  const f = fixture(), ready = deferred(), late = deferred(), finished = deferred()
  let ctl: any
  const result = runIntent.call(f.session, 'edge_walk', async c => {
    ctl = c; f.bot.setControlState('forward', true); ready.resolve()
    await late.promise
    f.bot.setControlState('forward', true)
    f.bot.setControlState('right', false)
    finished.resolve()
  }, { timeoutMs: 0 })
  await ready.promise
  ctl.abort()
  await result
  assert.equal(f.keys.forward, false)
  f.bot.setControlState('right', true)
  late.resolve()
  await finished.promise
  assert.equal(f.keys.forward, false)
  assert.equal(f.keys.right, true)
})

test('a pending reflex settles its lease after a failed connection clears the bot', async () => {
  const f = fixture(), finish = deferred()
  const lease = lock.start(f.session, () => finish.promise, { immediate: true })
  f.session.bot = null
  finish.resolve({ acted: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([lease, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the disconnected reflex lease did not settle')), 100)
    })])
  } finally { clearTimeout(timer) }
  assert.equal(lock.owner(f.session), null)
  assert.equal(f.session.reflex, null)
})

test('a pending old connection reflex cannot clear the replacement bot controls', async () => {
  const f = fixture(), next = fixture(), finish = deferred()
  const lease = lock.start(f.session, () => finish.promise, { immediate: true })
  next.bot.setControlState('right', true)
  next.bot.pathfinder.setGoal({ replacementConnection: true })
  const receipts = next.receipts.slice()
  f.session.bot = next.bot
  finish.resolve({ acted: false })
  await lease
  assert.equal(next.keys.right, true)
  assert.deepEqual(next.bot.pathfinder.goal, { replacementConnection: true })
  assert.deepEqual(next.receipts, receipts)
  assert.equal(lock.owner(f.session), null)
})
