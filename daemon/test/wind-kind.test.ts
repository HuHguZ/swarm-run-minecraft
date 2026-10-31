import test from 'node:test'
import assert from 'node:assert/strict'
const { windKind } = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')

// Враг в воздухе, номинальный план сносит на 2.5 бл. (хватает на серию), но ни один исход не выносит за край.
const air = { worstOut: false, nominalOut: false, outside: false, onGround: false, volley: false, nearEdge: false, progress: 2.5, juggle: false, gliding: false }

test('серия (chain) — только у края: с поля нет, у края да', () => {
  assert.equal(windKind(air), null)
  assert.equal(windKind({ ...air, nearEdge: true }), 'chain')
})

test('по летящему на элитрах — ни выноса, ни серии, ни подброса (только отвод)', () => {
  for (const k of [{ worstOut: true }, { nominalOut: true }, { nearEdge: true }, { juggle: true }]) {
    assert.notEqual(windKind({ ...air, ...k }), null, 'без элитр бросок есть: ' + JSON.stringify(k))
    assert.equal(windKind({ ...air, ...k, gliding: true }), null, JSON.stringify(k))
  }
})
