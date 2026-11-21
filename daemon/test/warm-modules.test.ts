import test from 'node:test'
import assert from 'node:assert/strict'
import path = require('path')
import { spawnSync } from 'node:child_process'

test('first motion forecast loads its physics without loading action handlers during the shot', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const { Vec3 } = require('vec3')
    const { leadTarget } = require('../src/bow/track')
    const actor = { position: new Vec3(0, 0, 0), onGround: true }
    const pos = leadTarget(actor, () => new Vec3(.25, 0, 0), null, 0)(2)
    if (pos.x !== .5 || require.cache[require.resolve('../src/elytra/dive')]) process.exitCode = 1
  `], { cwd: __dirname, encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
})

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
