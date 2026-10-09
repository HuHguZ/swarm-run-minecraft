import test from 'node:test'
import assert from 'node:assert/strict'
const { frWorth } = require('../src/tactics/state')

test('fire resistance: always in lava, while merely burning only at 10 hp or less', () => {
  assert.equal(frWorth({ lava: true, burning: false, health: 20 }), true)
  assert.equal(frWorth({ lava: false, burning: true, health: 20 }), false)
  assert.equal(frWorth({ lava: false, burning: true, health: 9 }), true)
  assert.equal(frWorth({ lava: false, burning: false, health: 3 }), false)
})
