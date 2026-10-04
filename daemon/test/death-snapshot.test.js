'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Session } = require('../src/session')
const { EventBus } = require('../src/events')

test('снимок смерти остаётся после чтения событий и создания нового тела', () => {
  const bus = new EventBus()
  const journal = { state: { goal: 'Пройти игру', deaths: [] } }
  const body = () => ({ bot: null, journal, playPolicy: { mode: 'speedrun' } })
  assert.equal(Session.prototype.state.call(body()).lastDeathAt, null)
  bus.emit('death', { pos: { x: 1, y: 64, z: 2 } })
  journal.state.deaths.push({ at: '2026-09-28T17:07:53Z' })
  assert.equal(bus.drain().length, 1)
  assert.equal(bus.drain().length, 0)
  assert.equal(Session.prototype.state.call(body()).lastDeathAt, '2026-09-28T17:07:53Z')
})
