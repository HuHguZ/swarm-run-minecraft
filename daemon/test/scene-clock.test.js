'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { WebSocketServer } = require('ws')
const gameClock = require('../src/game-clock')
const { connect, createKit, createGameBot, sleep } = require('../scene-kit')

async function waitFor (predicate) {
  const until = gameClock.wall.now() + 2000
  while (!predicate()) {
    if (gameClock.wall.now() >= until) throw new Error('clock update did not arrive')
    await gameClock.wall.sleep(5)
  }
}

test('scene follows unsolicited primary snapshots, freezes waits, and ignores a second bot clock', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const peers = []
  const clocks = []
  const rememberClock = clock => { if (clock) clocks.push(clock) }
  gameClock.changes.on('bound', rememberClock)
  server.on('connection', peer => peers.push(peer))
  const url = `ws://127.0.0.1:${server.address().port}`
  const primary = connect(url)
  const secondary = connect(url)
  const snapshot = ticks => ({ id: 'primary', ticks, gameMs: 1000000 + ticks * 50,
    tickRate: 200, effectiveRate: 200, frozen: true, running: true })
  try {
    await Promise.all([primary.ready, secondary.ready])
    peers[0].send(JSON.stringify({ type: 'clock', clock: snapshot(10) }))
    await waitFor(() => gameClock.now() === 1000500)
    const id = gameClock.snapshot().id
    let finished = false
    const waiting = sleep(200).then(() => { finished = true })
    peers[1].send(JSON.stringify({ type: 'clock', clock: { ...snapshot(4000), id: 'secondary' } }))
    await gameClock.wall.sleep(30)
    assert.equal(gameClock.snapshot().id, id)
    assert.equal(finished, false)
    peers[0].send(JSON.stringify({ type: 'clock', clock: snapshot(14) }))
    await waitFor(() => finished)
    await waiting
    assert.equal(gameClock.now(), 1000700)
    peers[0].on('message', raw => {
      const m = JSON.parse(raw)
      peers[0].send(JSON.stringify({ id: m.id, ok: true, result: { state: { clock: snapshot(15) } } }))
    })
    await primary.call('status')
    await waitFor(() => gameClock.now() === 1000750)
  } finally {
    primary.close()
    secondary.close()
    for (const peer of peers) peer.terminate()
    await new Promise(resolve => server.close(resolve))
    // The follower owns wall pump timers; do not carry it into another test.
    gameClock.changes.removeListener('bound', rememberClock)
    for (const clock of clocks) clock.dispose()
    gameClock.activate(null)
  }
})

test('scene event windows default to game timestamps with explicit wall windows and legacy fallback', () => {
  const heard = [
    { type: 'death', at: 10, gameAt: 100 },
    { type: 'death', at: 20 },
    { type: 'hurt', at: 30, gameAt: 110 }
  ]
  const kit = createKit({ call: async () => ({}), heard })
  assert.deepEqual(kit.between(90, 120, 'death'), [heard[0]])
  assert.deepEqual(kit.between(15, 25, 'death'), [heard[1]])
  assert.deepEqual(kit.between(0, 15, 'death', 'wall'), [heard[0]])
})

test('native scene bots have separate tick plugin scopes and only primary supplies process time', t => {
  const mineflayer = require('mineflayer')
  const options = []
  t.mock.method(mineflayer, 'createBot', supplied => {
    options.push(supplied)
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    return bot
  })
  const a = createGameBot({ username: 'A' }, { primary: true })
  const b = createGameBot({ username: 'B' }, { primary: true })
  const observer = createGameBot({ username: 'Eye' })
  try {
    assert.notEqual(a.ndClock, b.ndClock)
    assert.notEqual(a.ndClock, observer.ndClock)
    assert.equal(gameClock.snapshot().id, a.ndClock.id)
    for (const supplied of options) {
      assert.equal(typeof supplied.plugins.physics, 'function')
      assert.equal(typeof supplied.plugins.digging, 'function')
      assert.equal(typeof supplied.plugins.inventory, 'function')
    }
    a.ndClock.advanceTicks(3)
    assert.equal(gameClock.now(), a.ndClock.now())
    assert.equal(b.ndClock.ticks, 0)
  } finally {
    for (const bot of [a, b, observer]) bot.emit('end')
    gameClock.activate(null)
  }
})
