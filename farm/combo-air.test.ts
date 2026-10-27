import test from 'node:test'
import assert from 'node:assert/strict'
import { airSummary } from './swarm/swarm-driver/combo-air'

test('air combo summary counts native contact and friendly cost, not sent packets', () => {
  assert.deepEqual(airSummary([{ damage: 0, allyDamage: 2, contact: false, out: false, ownDeaths: 1 },
    { damage: 30, allyDamage: 4, contact: true, out: true, ownDeaths: 0 }]),
  { n: 2, damage: 15, allyDamage: 3, contactRate: .5, outRate: .5, ownDeaths: 1 })
})
