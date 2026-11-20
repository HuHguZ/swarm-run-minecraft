import test from 'node:test'
import assert from 'node:assert/strict'
import { sampledGameSpeed } from './arena/server'

test('delayed RCON replies one millisecond apart do not fast-forward bot deadlines', () => {
  const first = { sent: 1000, received: 2000, tick: 40 }
  const second = { sent: 1999, received: 2001, tick: 80 }
  const speed = sampledGameSpeed(first, second, 1)
  assert.ok(speed > 1.99 && speed <= 2, `40 TPS, observed ×${speed}`)
})

test('arena clock follows clean 20, 40 and 100 TPS samples and survives a world time reset', () => {
  const first = { sent: 1000, received: 1000, tick: 120 }
  for (const rate of [20, 40, 100]) {
    assert.equal(sampledGameSpeed(first, { sent: 2000, received: 2000, tick: first.tick + rate }, 1), rate / 20)
  }
  assert.equal(sampledGameSpeed(first, { sent: 2000, received: 2000, tick: 0 }, 2), 2)
})
