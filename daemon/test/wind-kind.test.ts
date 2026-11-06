import test from 'node:test'
import assert from 'node:assert/strict'
const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
const windKind = (o: typeof air) => out.windKind(o)

// Враг в воздухе, номинальный план сносит на 2.5 бл. (хватает на серию), но ни один исход не выносит за край.
const air = { worstOut: false, nominalOut: false, outside: false, onGround: false, volley: false, nearEdge: false, progress: 2.5, juggle: false, gliding: false }

test('outward landing gain is useful in the centre without a minimum number of metres', () => {
  assert.equal(windKind(air), 'chain')
  assert.equal(windKind({ ...air, nearEdge: true }), 'chain')
  assert.equal(windKind({ ...air, progress: Number.EPSILON, onGround: true }), 'chain')
})

test('the native outcome decides a throw against a glider too', () => {
  for (const k of [{ worstOut: true }, { nominalOut: true }, { nearEdge: true }, { juggle: true }]) {
    assert.notEqual(windKind({ ...air, ...k }), null, 'без элитр бросок есть: ' + JSON.stringify(k))
    assert.equal(windKind({ ...air, ...k, gliding: true }), windKind({ ...air, ...k }), JSON.stringify(k))
  }
})

test('zero benefit and inward landings are refused, including a longer inward flight', () => {
  assert.equal(windKind({ ...air, progress: 0 }), null)
  assert.equal(windKind({ ...air, progress: 0, juggle: true }), 'juggle')
  assert.equal(windKind({ ...air, progress: -.001, juggle: true }), null)
})
