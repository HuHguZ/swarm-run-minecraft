'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const gameClock = require('../src/game-clock')
const { EventBus } = require('../src/events')
const { Session } = require('../src/session')

test('dragon, MLG, combat, navigation and intent budgets have no implicit wall clocks', () => {
  for (const name of ['dragon', 'clutch', 'blockmoves', 'edges', 'pvp', 'combat', 'movement', 'bastion', 'nether', 'actions']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', name + '.js'), 'utf8')
    assert.doesNotMatch(source, /Date\.now\b/, name)
    assert.doesNotMatch(source, /(?<![\w.])(?:setTimeout|setInterval)\s*\(/, name)
  }
})

test('intent timeout follows ticks and disconnect grace returns even in a frozen world', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  const bus = new EventBus()
  const s = new Session({}, bus, { state: {}, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  const started = s.runIntent('test_clock', () => new Promise(() => {}), { timeoutMs: 150, interruptible: false })
  c.advanceTicks(2)
  let settled = false
  started.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  c.advanceTicks(1)
  c.setState({ is_frozen: true })
  const r = await started
  assert.equal(r.status, 'timeout')
  c.dispose()
})

test('session background timers resume on a new clock after reconnect', () => {
  const loot = require('../src/lootclock')
  const structures = require('../src/structures')
  const death = { pos: { x: 0, z: 0 }, dimension: 'overworld', ticking: 0 }
  const session = { bot: { entity: { position: { x: 0, z: 0 } }, game: { dimension: 'overworld' } },
    journal: { state: { deaths: [death] } }, structuresAuto: false }
  const first = gameClock.activate(new gameClock.GameClock({ manual: true }))
  loot.install(session); structures.install(session)
  first.advanceTicks(20)
  assert.equal(death.ticking, 1)
  first.dispose()
  const second = gameClock.activate(new gameClock.GameClock({ manual: true }))
  try {
    loot.install(session); structures.install(session)
    assert.equal(session._lootclock.clock, second)
    assert.equal(session._structuresTimer.clock, second)
    second.advanceTicks(20)
    assert.equal(death.ticking, 2)
  } finally { second.dispose(); gameClock.activate(null) }
})

test('stop before a wait worker starts settles while the world is frozen', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  c.setState({ is_frozen: true })
  const s = new Session({}, new EventBus(), { state: {}, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  try {
    const waiting = s.wait({ seconds: 1 })
    await s.stop()
    const result = await waiting
    assert.equal(result.status, 'interrupted')
    assert.match(result.error, /прервано ещё до начала/)
    assert.equal(s.current, null)
    assert.equal(c.timers.size, 0)
    assert.equal(c.ticks, 0)
  } finally { c.dispose(); gameClock.activate(null) }
})

test('stop settles an already running noncooperative worker without game ticks', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  c.setState({ is_frozen: true })
  const s = new Session({}, new EventBus(), { state: {}, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  try {
    const running = s.runIntent('test_stop', () => new Promise(() => {}))
    await new Promise(resolve => setImmediate(resolve))
    await s.stop()
    const result = await running
    assert.equal(result.status, 'interrupted')
    assert.equal(result.by.type, 'cancelled')
    assert.equal(s.current, null)
    assert.equal(c.timers.size, 0)
  } finally { c.dispose(); gameClock.activate(null) }
})

test('drop retry resumes after its disconnected clock was disposed', () => {
  const s = new Session({}, new EventBus(), { state: {}, append () {} })
  let retries = 0
  s.refreshDrop = () => { retries++ }
  const first = gameClock.activate(new gameClock.GameClock({ manual: true }))
  s.dropRetry(50)
  first.dispose()
  const second = gameClock.activate(new gameClock.GameClock({ manual: true }))
  try {
    s.dropRetry(50)
    second.advanceTicks(1)
    assert.equal(retries, 1)
  } finally { second.dispose(); gameClock.activate(null) }
})
