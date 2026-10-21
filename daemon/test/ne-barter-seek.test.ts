import test from 'node:test'
import assert from 'node:assert/strict'
import { pickTrader } from '../src/pearls/seek'

// ND_BARTER_SEEK: торговец — ближайший видимый взрослый не злой пиглин, у которого нет брута/хоглина в 20 бл.
test('seek: nearest calm adult piglin away from brutes', () => {
  const p = (id, x, extra = {}) => ({ id, name: 'piglin', pos: { x, y: 64, z: 0 }, dist: Math.abs(x), ...extra })
  const brute = { id: 9, name: 'piglin_brute', pos: { x: 6, y: 64, z: 0 }, dist: 6 }
  const seen = [p(1, 4), p(2, 30), p(3, 2, { baby: true }), p(4, 3, { angry: true })]
  assert.equal(pickTrader(seen, [])?.id, 1)
  assert.equal(pickTrader(seen, [brute])?.id, 2, 'piglin 1 stands 2 blocks from a brute')
  assert.equal(pickTrader(seen, [brute], new Set([2])), null)
})
