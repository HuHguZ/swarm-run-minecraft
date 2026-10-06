import test from 'node:test'
import assert from 'node:assert/strict'
import { BARTER_WEIGHT, DEFAULT_TIMING, barterPlan, chanceAll, deliveryEstimate, expectedIngots, ingotsFor, learnTiming, meanPerIngot,
  type BarterState } from '../src/core/barter-model'
const BF = require('../src/barter-flow')

test('1.21.11 table: weight 469, pearls 10/469 × 2–4, fire resistance 16/469', () => {
  assert.equal(BARTER_WEIGHT, 469)
  assert.ok(Math.abs(meanPerIngot('ender_pearl') - 30 / 469) < 1e-12)
  assert.ok(Math.abs(meanPerIngot('fire_resistance') - 16 / 469) < 1e-12)
  assert.ok(Math.abs(meanPerIngot('ender_pearl', 0.9) - 0.9 * 30 / 469) < 1e-12)
})
test('pearl DP equals the bastion pearlChance and reproduces the 4.2 table', () => {
  for (const [n, k, q] of [[243, 10, 1], [242, 10, 1], [153, 10, 0.9], [300, 14, 0.9]] as const) {
    assert.ok(Math.abs(chanceAll(n, { ender_pearl: k }, q) - BF.pearlChance(n, k, q)) < 1e-12)
  }
  assert.deepEqual([0.5, 0.8, 0.9, 0.95].map(c => ingotsFor({ ender_pearl: 10 }, c, 1)), [157, 243, 298, 349])
  assert.equal(Math.round(expectedIngots({ ender_pearl: 10 }, 1)), 173)
  assert.equal(Math.round(expectedIngots({ ender_pearl: 12 }, 0.9)), 228)
})
test('secondary goods: joint chance never exceeds the pearl chance and FR is nearly free once pearls are met', () => {
  const pearls = chanceAll(250, { ender_pearl: 10 }, 0.9)
  const joint = chanceAll(250, { ender_pearl: 10, fire_resistance: 1 }, 0.9)
  assert.ok(joint <= pearls && pearls - joint < 0.01)
  assert.equal(ingotsFor({ fire_resistance: 1 }, 0.9, 1), 67)
  assert.equal(ingotsFor({ fire_resistance: 1 }, 0.9, 0.9), 74)
})
test('delivery and timing learn from this run, shrunk toward the measured priors', () => {
  assert.equal(deliveryEstimate(0, 0), 0.85)
  assert.ok(Math.abs(deliveryEstimate(122, 135) - 130.5 / 145) < 1e-12)
  const timing = learnTiming(DEFAULT_TIMING, { minedIngots: 27, mineSeconds: 27 * 4.5, tradedIngots: 0 })
  assert.equal(timing.mineSecondsPerIngot, 3.5)
  assert.equal(timing.tradeSecondsPerIngot, DEFAULT_TIMING.tradeSecondsPerIngot)
})
const base: BarterState = { pearls: 0, required: 10, gold: 0, here: { gold: 153, travelSeconds: 0 }, delivery: 0.9, timing: DEFAULT_TIMING }
test('stop rule: carried gold is traded while pearls are short; then only valuable secondary loot keeps the trade going', () => {
  assert.equal(barterPlan({ ...base, gold: 44 }).action, 'trade')
  assert.equal(barterPlan({ ...base, pearls: 10, gold: 44 }).action, 'stop')
  const fr = { fire_resistance: { have: 0, want: 1, valueSeconds: 600 } }
  assert.equal(barterPlan({ ...base, pearls: 10, gold: 20, wants: fr }).action, 'trade', 'FR worth 600 s → ~18 s per ingot')
  assert.equal(barterPlan({ ...base, pearls: 10, gold: 0, wants: { fire_resistance: { have: 0, want: 1, valueSeconds: 30 } } }).action, 'stop')
  assert.equal(barterPlan({ ...base, pearls: 10, gold: 0, wants: fr }).action, 'mine', 'only a valuable potion justifies more mining')
  assert.equal(barterPlan({ ...base, pearls: 11, gold: 30, spare: { count: 2, valueSeconds: 10 } }).action, 'stop', 'a cheap spare pearl is not worth trading')
})
test('mine here in an adaptive batch, else the cheaper of a second bastion or endermen', () => {
  const here = barterPlan({ ...base, next: [{ gold: 200, travelSeconds: 90 }], endermenSecondsPerPearl: 240 })
  assert.equal(here.action, 'mine')
  assert.ok(here.batch >= 54 && here.batch <= 108 && here.batch % 9 === 0, `batch ${here.batch}`)
  assert.ok(here.pReach > 0.99)
  const small = barterPlan({ ...base, pearls: 8, required: 10 })
  assert.ok(small.batch < here.batch, 'a smaller deficit mines a smaller batch')
  const moved = barterPlan({ ...base, here: { gold: 0, travelSeconds: 0 }, next: [{ gold: 200, travelSeconds: 90 }], endermenSecondsPerPearl: 240 })
  assert.equal(moved.action, 'move')
  assert.equal(moved.site, 0)
  const far = barterPlan({ ...base, pearls: 9, here: null, next: [{ gold: 200, travelSeconds: 900 }], endermenSecondsPerPearl: 240 })
  assert.equal(far.action, 'endermen', 'one pearl short: hunting beats a long trip')
  const none = barterPlan({ ...base, here: null })
  assert.equal(none.action, 'stop')
  assert.equal(none.pReach, 0)
  const thin = barterPlan({ ...base, here: { gold: 27, travelSeconds: 0 } })
  assert.ok(thin.pReach < 0.2, 'a nearly empty bastion alone rarely reaches 10 pearls')
})
test('campaign adapter: bastion numbers in, a batch to mine, a stop and a log line out; delivery and pace learn from this run', () => {
  const mine = BF.plan({ pearls: 2, required: 12, gold: 0, siteIngots: 153, mined: { ingots: 27, seconds: 27 * 4.5 } })
  assert.equal(mine.action, 'mine')
  assert.ok(mine.batch % 9 === 0 && mine.batch >= 27, `batch ${mine.batch}`)
  assert.equal(mine.timing.mineSecondsPerIngot, 3.5)
  assert.match(mine.line, /^бартер-модель: mine \d+ сл\., E \d+ с, P\(цель\) 0\.\d\d, q̂ 0\.85/)
  const trade = BF.plan({ pearls: 2, required: 12, gold: 44, siteIngots: 100, delivered: 20, thrown: 40 })
  assert.equal(trade.action, 'trade')
  assert.ok(Math.abs(trade.delivery - 28.5 / 50) < 1e-12, 'half the stacks lost: q̂ drops from 0.85 to 0.57')
  assert.equal(BF.plan({ pearls: 12, required: 12, gold: 30, siteIngots: 100 }).action, 'stop')
  assert.equal(BF.plan({ pearls: 12, required: 12, gold: 30, siteIngots: 100, fireRes: { have: 0, want: 1, valueSeconds: 600 } }).action, 'trade')
  assert.equal(BF.plan({ pearls: 4, required: 12, gold: 0, siteIngots: 0, next: [{ ingots: 153, blocks: 300 }] }).action, 'move')
})
