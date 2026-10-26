import test from 'node:test'
import assert from 'node:assert/strict'
import { pitPearlScore, ticksToY } from '../src/combat/emergency-escape'

test('pit pearl: among landings in time, the higher tier far from the enemy wins; none in time — the fastest', () => {
  const foes = [{ x: 0, y: 120, z: 0 }]
  const low = { tp: { x: 3, y: 120, z: 0 }, ticks: 6 }, tier = { tp: { x: 20, y: 137, z: 0 }, ticks: 14 }, late = { tp: { x: 30, y: 153, z: 0 }, ticks: 40 }
  const budget = 20
  const best = [low, tier, late].sort((a, b) => pitPearlScore(b, { budget, foes }) - pitPearlScore(a, { budget, foes }))[0]
  assert.equal(best, tier)
  const none = [tier, late].sort((a, b) => pitPearlScore(b, { budget: 5, foes }) - pitPearlScore(a, { budget: 5, foes }))[0]
  assert.equal(none, tier, 'nothing in time: the fastest throw')
})

test('pit pearl: time to the kill line follows player gravity and drag', () => {
  assert.equal(ticksToY(120, 0, 120.5), 0)
  const t = ticksToY(121, 0, 113)
  assert.ok(t >= 13 && t <= 16, String(t))
  assert.ok(ticksToY(153, 0, 113) > 25)
})
