import test from 'node:test'
import assert from 'node:assert/strict'
import { deficit, eyesTarget, paceMin } from '../src/campaign/eyes-price'

// Таблица P(очей хватит): 12 рамок по 10 %, броски с 20 % поломки (сверено пересчётом 21.10, поток ne).
test('eyes-price: probability table', () => {
  const ok = (n, t) => +(1 - deficit(n, t).pShort).toFixed(3)
  assert.equal(ok(12, 2), 0.883); assert.equal(ok(13, 2), 0.989); assert.equal(ok(11, 2), 0.573)
  assert.equal(ok(12, 3), 0.821); assert.equal(ok(13, 3), 0.968); assert.equal(ok(14, 3), 0.998)
  assert.ok(deficit(14, 3).expected < deficit(12, 3).expected)
})

// Уход ценой (замеренные 4.4 / +1.2 / 24 мин): золото на руках или в бастионе — до 12; торговать нечем — 11; темп быстрее — 13.
test('eyes-price: departure by price, floor 11, ceiling 13', () => {
  assert.equal(eyesTarget({ base: 13, throws: 3, paceMin: paceMin({ goldCarried: 90, goldLeft: 0 }) }), 12)
  assert.equal(eyesTarget({ base: 13, throws: 3, paceMin: paceMin({ goldCarried: 0, goldLeft: 30 }) }), 12)
  assert.equal(eyesTarget({ base: 13, throws: 3, paceMin: 3 }), 13, 'faster trade than measured: 13')
  assert.equal(eyesTarget({ base: 13, throws: 3, paceMin: paceMin({ goldCarried: 0, goldLeft: 0 }) }), 11)
  assert.equal(eyesTarget({ base: 13, throws: 3, paceMin: 0.5 }), 13, 'cheap pearls: the full target')
  assert.equal(eyesTarget({ base: 12, throws: 1, paceMin: 2 }), 12)
})
