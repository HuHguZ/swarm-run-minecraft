import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { GameClock } from '../src/game-clock'
import { attachClients } from '../src/rpc/server'

test('квитанция спрыгивания доходит в журнал арены один раз и отписывается при закрытии RPC', () => {
  const clock = new GameClock({ manual: true })
  const bot = Object.assign(new EventEmitter(), { ndClock: clock })
  const wss = new EventEmitter(), changes = new EventEmitter(), messages = []
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: text => messages.push(JSON.parse(text)) })
  const facade = { changes, snapshot: () => clock.snapshot(), wall: { setInterval: () => 1, clearInterval() {} } }
  attachClients(wss, { session: { bot }, gameClock: facade, methods: {}, log() {}, state: { dangerWatch: { foes: ['Foe'] } } })
  wss.emit('connection', ws)
  try {
    const descent = { height: 8, technique: 'без' }
    bot.emit('nd_flee_drop', descent)
    assert.deepEqual(messages.filter(m => m.type === 'danger'), [{ type: 'danger', descent }])
    ws.emit('close')
    bot.emit('nd_flee_drop', descent)
    assert.equal(messages.filter(m => m.type === 'danger').length, 1)
    assert.equal(bot.listenerCount('nd_flee_drop'), 0)
  } finally { clock.dispose() }
})

test('wind release bids use the subscribed socket and report the actual shot or cancellation', async () => {
  const wss = new EventEmitter(), changes = new EventEmitter(), messages: any[] = [], session: any = {}
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: text => messages.push(JSON.parse(text)) })
  const facade = { changes, snapshot: () => null, wall: { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout } }
  attachClients(wss, { session, gameClock: facade, methods: {}, log() {}, state: { dangerWatch: null } })
  wss.emit('connection', ws)
  const message = (packet: object) => ws.emit('message', JSON.stringify(packet))
  assert.equal(session._windRadio, undefined)
  message({ type: 'wind_radio' })
  const bid = { target: 'Red', entity: 91, tick: 70, ticks: 6 }
  const pending = session._windRadio(bid)
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid', id: 1 })
  message({ type: 'wind_bid_answer', id: 0, granted: true })
  message({ type: 'wind_bid_answer', id: 1, granted: true })
  const complete = await pending
  complete({ tick: 71, ticks: 4 })
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid_done', id: 1, shot: { tick: 71, ticks: 4 } })
  const refused = session._windRadio(bid)
  message({ type: 'wind_bid_answer', id: 2, granted: false })
  assert.equal(await refused, undefined)
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid_done', id: 2 })
  const owner = new AbortController()
  const cancelled = session._windRadio(bid, owner.signal)
  owner.abort()
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid_done', id: 3 })
  assert.equal(await cancelled, undefined)
  const nextOwner = new AbortController()
  const next = session._windRadio(bid, nextOwner.signal)
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid', id: 4 })
  message({ type: 'wind_bid_answer', id: 3, granted: true })
  message({ type: 'wind_bid_answer', id: 4, granted: true })
  const nextFinish = await next
  nextOwner.abort()
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid', id: 4 })
  nextFinish({ tick: 71, ticks: 4 })
  assert.deepEqual(messages.at(-1), { ...bid, type: 'wind_bid_done', id: 4, shot: { tick: 71, ticks: 4 } })
  const interrupted = session._windRadio(bid)
  ws.readyState = 3
  ws.emit('close')
  assert.equal(await interrupted, undefined)
  assert.equal(session._windRadio, undefined)
})
