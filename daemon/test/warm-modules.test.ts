import test from 'node:test'
import assert from 'node:assert/strict'
import path = require('path')

test('прогрев грузит ленивые модули боя заранее, по одному за проход цикла событий', async () => {
  const { warmModules, WARM } = require('../src/warm-modules')
  const src = path.dirname(require.resolve('../src/warm-modules'))
  assert.ok(WARM.length >= 10)
  const steps: Array<() => void> = []
  warmModules(WARM, (fn: () => void) => steps.push(fn))
  let turns = 0
  while (steps.length) { steps.shift()!(); turns++ }
  assert.equal(turns, WARM.length + 1, 'каждый модуль — свой проход, цикл событий между ними свободен')
  for (const m of WARM) assert.ok(require.cache[require.resolve(path.join(src, m))]?.loaded, `${m} загружен`)
})
