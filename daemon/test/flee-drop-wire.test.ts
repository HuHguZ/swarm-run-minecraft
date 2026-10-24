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
