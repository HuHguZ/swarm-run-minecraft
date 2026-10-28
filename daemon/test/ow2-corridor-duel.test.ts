import test from 'node:test'
import assert from 'node:assert/strict'
const { fightsInOpen } = require('../src/combat') as typeof import('../src/combat')

// ow2 27.10: ходячий моб в штреке 1×2 — старая доктрина fightCorridor стоит в его досягаемости (скамья try-ow2-duel SHAPE=tunnel:
// зомби при 12 хп — хп 12 → 6–9, 0 взмахов), pvp.duel убивает того же зомби за 3 с без урона. ND_OW2_CORRIDOR_DUEL=1 — бой в поле.
test('corridor duel: walker in a drift fights in the open only under the flag', () => {
  const was = process.env.ND_OW2_CORRIDOR_DUEL
  try {
    delete process.env.ND_OW2_CORRIDOR_DUEL
    assert.equal(fightsInOpen({ ranged: false }, () => true), false, 'flag off: drift keeps the old doctrine')
    assert.equal(fightsInOpen({ ranged: false }, () => false), true, 'open ground is the open fight')
    process.env.ND_OW2_CORRIDOR_DUEL = '1'
    let asked = false
    assert.equal(fightsInOpen({ ranged: false }, () => { asked = true; return true }), true, 'walker in a drift: open fight')
    assert.equal(asked, false, 'the drift shape is not computed when the flag decides')
    assert.equal(fightsInOpen({ ranged: true }, () => true), false, 'an archer in a drift keeps the seal branch')
    assert.equal(fightsInOpen({ lastStand: true, ranged: true }, () => true), true, 'last stand is always the open fight')
  } finally {
    if (was === undefined) delete process.env.ND_OW2_CORRIDOR_DUEL
    else process.env.ND_OW2_CORRIDOR_DUEL = was
  }
})
