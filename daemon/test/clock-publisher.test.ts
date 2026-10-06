'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { GameClock } = require('../src/game-clock')

test('RPC clocks advance on game ticks, expose freeze and step, and detach old clocks', async () => {
  // Exercise the actual entrypoint wiring without opening ports or loading a bot.
  const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8')
  const wiring = source.slice(source.indexOf('let clients = 0'), source.search(/\nfunction log\s*\(/))
  const wss = new EventEmitter(); const ws = new EventEmitter(); const changes = new EventEmitter()
  const messages = []; let active; let heartbeat; let cleared = false
  const session: Record<string, any> = {} as Record<string, any>
  const facade = { changes, snapshot: () => active && !active.disposed ? active.snapshot() : null, wall: {
    setInterval: fn => { heartbeat = fn; return 123 }, clearInterval: handle => { assert.equal(handle, 123); cleared = true }
  } }
  ws.readyState = 1
  ws.send = text => messages.push(JSON.parse(text))
  new Function('wss', 'session', 'gameClock', 'methods', 'log', wiring)(wss, session, facade, {} as Record<string, any>, () => {})
  wss.emit('connection', ws)
  active = new GameClock({ manual: true }); active.start(); active.setState({ tick_rate: 750 })
  session.bot = { ndClock: active }
  changes.emit('bound', active)
  try {
    messages.length = 0
    active.advanceTicks(20)
    assert.ok(messages.length >= 4, 'game waits must not await the 250 wall-ms heartbeat at high TPS')
    assert.equal(messages.at(-1).clock.ticks, 20)
    active.setState({ is_frozen: true })
    assert.equal(messages.at(-1).clock.frozen, true)
    const before = messages.length
    active.step(3)
    for (let i = 0; i < 3; i++) active.pulse()
    assert.equal(messages.at(-1).clock.ticks, 23)
    assert.ok(messages.length >= before + 3, 'small frozen steps reach followers immediately')
    const old = active
    active = new GameClock({ manual: true }); active.start(); session.bot.ndClock = active
    changes.emit('bound', active)
    const rebound = messages.length
    old.advanceTicks(10)
    assert.equal(messages.length, rebound)
    assert.equal(old.listenerCount('tick'), 0)
    // A confirmed world-age jump can skip every multiple of five without
    // replaying physical frames. Publish by elapsed ticks, reset on rebind.
    active.ticks = 13; active.emit('tick', 13)
    assert.equal(messages.at(-1).clock.ticks, 13)
    active.ticks = 18; active.emit('tick', 18)
    assert.equal(messages.at(-1).clock.ticks, 18)
    const published = messages.length
    active.ticks = 21; active.emit('tick', 21)
    assert.equal(messages.length, published, 'shorter elapsed intervals keep the five-tick publication budget')
    heartbeat()
    assert.equal(messages.at(-1).clock.id, active.id)
    active.dispose()
    assert.equal(messages.at(-1).clock.running, false, 'dispose publishes its final snapshot even when the facade returns null')
    const final = messages.length
    ws.emit('close')
    assert.equal(changes.listenerCount('bound'), 0)
    assert.equal(active.listenerCount('tick'), 0)
    assert.equal(active.listenerCount('state'), 0)
    assert.equal(cleared, true)
    old.advanceTicks(5)
    assert.equal(messages.length, final)
    old.dispose()
  } finally { active.dispose(); if (!cleared) ws.emit('close') }
})
