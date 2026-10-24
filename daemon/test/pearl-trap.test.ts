import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trapOptions } from '../src/combat/pearl-trap'

test('pearl trap: lava, then web, then digging — only what fits before he appears', () => {
  const kit = { lava: true, web: true, digMs: 900, digOk: true }
  assert.deepEqual(trapOptions(3000, 500, kit).map(o => o[0]), ['lava', 'web', 'dig'])
  assert.deepEqual(trapOptions(1200, 500, kit).map(o => o[0]), ['lava', 'web'], 'no time to dig through')
  assert.deepEqual(trapOptions(3000, 0, { ...kit, lava: false, web: false }).map(o => o[0]), ['dig'])
  assert.deepEqual(trapOptions(400, 300, kit), [], 'too late for anything')
  assert.deepEqual(trapOptions(9000, 0, { lava: false, web: false, digMs: Infinity, digOk: true }), [], 'unbreakable block')
})
