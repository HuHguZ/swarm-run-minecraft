import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const body = createRequire(resolve(root, 'daemon/src/index.js'))

test('build preserves Node aliases, shared clock and source maps', () => {
  assert.equal(body('#body/game-clock'), body('./game-clock'))
  assert.equal(body.resolve('#core/strategy'), resolve(root, 'daemon/src/core/strategy.js'))
  assert.equal(body.resolve('#tactics/state'), resolve(root, 'daemon/src/tactics/state.js'))
  assert.equal(body.resolve('#strategy/overworld-route'), resolve(root, 'daemon/src/campaign/overworld-route.js'))
  assert.ok(existsSync(resolve(root, 'daemon/src/core/strategy.js.map')))
})
