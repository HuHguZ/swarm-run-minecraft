import test from 'node:test'
import assert from 'node:assert/strict'
import { healExchange, pickForager, planTransfers } from '../src/swarm/logistics'

test('heal exchange: a healthy ally gives his golden apple to a badly wounded one; the wounded keeps his', () => {
  const healthy = { reserve: {} as any, needs: {} as any }, wounded = { reserve: {} as any, needs: {} as any }, hurt = { reserve: {} as any, needs: {} as any }
  healExchange(20, { golden_apple: 2 }, healthy.reserve, healthy.needs)
  healExchange(6, {}, wounded.reserve, wounded.needs)
  healExchange(12, { golden_apple: 1 }, hurt.reserve, hurt.needs)
  assert.equal(healthy.reserve.golden_apple, 0)
  assert.equal(wounded.needs.golden_apple, 1)
  assert.equal(hurt.reserve.golden_apple, 1, 'wounded but not critical: keeps his own')
  assert.equal(hurt.needs.golden_apple, undefined)
})

test('forager: the weakest of six keeps one weapon and gives the rest; fewer than six — nobody', () => {
  const team = Array.from({ length: 6 }, (_, k) => ({ id: 'b' + k, strength: 10 + k, reserve: { wind_charge: 1, iron_sword: 1 } as any,
    inventory: { iron_sword: 1, bow: 1, wind_charge: 6, golden_apple: 1 } as any }))
  const f = pickForager(team)!
  assert.equal(f.id, 'b0')
  assert.equal(f.reserve.iron_sword, 1, 'first weapon kept')
  assert.equal(f.reserve.bow, 0); assert.equal(f.reserve.wind_charge, 0); assert.equal(f.reserve.golden_apple, 0)
  assert.equal(pickForager(team.slice(0, 5)), null)
  assert.equal(typeof planTransfers, 'function')
})

test('forager stays the same while he is among the three weakest', () => {
  const team = Array.from({ length: 6 }, (_, k) => ({ id: 'b' + k, strength: 10 + k, reserve: {} as any, inventory: {} as any }))
  assert.equal(pickForager(team, 'b2')!.id, 'b2')
  assert.equal(pickForager(team, 'b4')!.id, 'b0')
})
