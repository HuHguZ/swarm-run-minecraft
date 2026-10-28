import test from 'node:test'
import assert from 'node:assert/strict'
import { guardsNear } from '../src/ne-gold-first'

// ND_BAST2_OPEN_GOLD: к руде ногами, пока стражи золота не близко (сенсор пиглина 16 бл.): пиглин/хоглин на виду в 20, брут в 24, слышны ближе 8.
test('bast2 open gold: guards near', () => {
  assert.equal(guardsNear([], []), false)
  assert.equal(guardsNear([{ name: 'piglin', seen: true, dist: 25 }], []), false, 'piglin of the bastion 25 blocks off — open')
  assert.equal(guardsNear([{ name: 'piglin', seen: true, dist: 14 }], []), true)
  assert.equal(guardsNear([{ name: 'piglin_brute', seen: true, dist: 22 }], []), true)
  assert.equal(guardsNear([{ name: 'piglin', seen: false, dist: 5 }], []), false, 'remembered, not seen now')
  assert.equal(guardsNear([{ name: 'zombified_piglin', seen: true, dist: 3 }], []), false)
  assert.equal(guardsNear([], [{ who: 'piglin', band: 'средне' }]), false, 'heard behind the wall 8–16')
  assert.equal(guardsNear([], [{ who: 'hoglin', band: 'близко' }]), true)
})

// ND_BAST2_CROSSBOW_CHASE: бегом догоняем только пиглина с арбалетом и только под флагом.
test('bast2 crossbow chase: who is chased', () => {
  const { chaseShooter } = require('../src/ne-guard/fight')
  const was = process.env.ND_BAST2_CROSSBOW_CHASE
  try {
    const xbow = { name: 'piglin', equipment: [{ name: 'crossbow' }] }
    delete process.env.ND_BAST2_CROSSBOW_CHASE
    assert.equal(chaseShooter(xbow), false)
    process.env.ND_BAST2_CROSSBOW_CHASE = '1'
    assert.equal(chaseShooter(xbow), true)
    assert.equal(chaseShooter({ name: 'piglin', equipment: [{ name: 'golden_sword' }] }), false)
    assert.equal(chaseShooter({ name: 'piglin_brute', equipment: [{ name: 'golden_axe' }] }), false)
  } finally { if (was === undefined) delete process.env.ND_BAST2_CROSSBOW_CHASE; else process.env.ND_BAST2_CROSSBOW_CHASE = was }
})
