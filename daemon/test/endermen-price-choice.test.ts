import test from 'node:test'
import assert from 'node:assert/strict'
import { speedrunRegistry, barterSituation } from '../src/core/speedrun'
import { emptyWorld, fact, amount } from '../src/core/world-state'
import { plan } from '../src/core/strategy'
const world = () => { const s = emptyWorld(); s.dimension = 'the_nether'; s.resources = { pearls: 10, rods: 6, food: 8 }; s.facts.bastion = fact(true, 'observed', 0); return s }
test('endermen compete by price without an allow flag or exhausting every bastion', () => {
  const r = speedrunRegistry({ economy: true }), s = world(), hunt = r.get('HuntEndermen')!
  assert.equal(hunt.preconditions(s), true)
  s.facts.endermen_allowed = fact(false, 'observed', 0)
  assert.equal(hunt.preconditions(s), true)
  assert.equal(hunt.estimateCost(s), 2 * 900 * 20)
  assert.equal(barterSituation(s, 12).endermenSecondsPerPearl, 900)
  s.facts.endermen_seconds_per_pearl = fact(30, 'observed', 0)
  s.facts.barter_mine_seconds = fact(200, 'observed', 0)
  assert.equal(hunt.estimateCost(s), 2 * 30 * 20)
  assert.equal(barterSituation(s, 12).endermenSecondsPerPearl, 30)
  assert.equal(plan(r, s, x => amount(x, 'pearls') >= 12).steps[0]?.id, 'HuntEndermen')
})
test('a cheap carried-gold barter wins while hunting remains an available alternative', () => {
  const r = speedrunRegistry(), s = world(); s.resources.gold = 81
  assert.equal(r.get('HuntEndermen')!.preconditions(s), true)
  assert.equal(plan(r, s, x => amount(x, 'pearls') >= 12).steps[0]?.id, 'PiglinBarter')
})
test('missing pearls raise the hunt price and completed pearls stop it', () => {
  const s = world(), h = speedrunRegistry().get('HuntEndermen')!
  const before = h.estimateCost(s); s.resources.pearls = 11
  assert.equal(h.estimateCost(s), before / 2)
  s.resources.pearls = 12; assert.equal(h.preconditions(s), false)
})
