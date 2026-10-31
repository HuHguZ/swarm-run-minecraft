import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from '../src/wind-spend'

test('источник броска — первый файл демона в стеке вне обёрток рук', () => {
  const stack = ['Error', '    at x (/r/dist/daemon/src/wind-spend.js:10:5)', '    at y (/r/dist/daemon/src/mace/hands.js:3:1)',
    '    at z (/r/dist/daemon/src/combat/wind-out.js:300:9)', '    at w (/r/dist/daemon/src/rpc/swarm.js:1:1)'].join('\n')
  assert.equal(sourceOf(stack), 'combat/wind-out')
  assert.equal(sourceOf('Error\n    at node:internal/x'), '?')
})
