import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const body = createRequire(join(dist, 'daemon/src/index.js'))

test('build writes compiled code to dist/ with source maps and leaves the source tree clean', () => {
  assert.ok(existsSync(join(dist, 'daemon/src/core/strategy.js')))
  assert.ok(existsSync(join(dist, 'daemon/src/core/strategy.js.map')))
  assert.ok(existsSync(join(dist, 'daemon/campaign.js')))
  assert.ok(existsSync(join(dist, 'farm/farm.js')))
  const map = JSON.parse(readFileSync(join(dist, 'daemon/src/core/strategy.js.map'), 'utf8'))
  assert.equal(resolve(join(dist, 'daemon/src/core'), map.sources[0]), join(root, 'daemon/src/core/strategy.ts'))
  for (const directory of ['daemon/src', 'daemon/src/core', 'daemon/test', 'farm', 'run']) {
    const compiled = readdirSync(join(root, directory)).filter(name => /\.js(\.map)?$/.test(name) && existsSync(join(root, directory, name.replace(/\.js(\.map)?$/, '.ts'))))
    assert.deepEqual(compiled, [], `${directory}: compiled output next to sources`)
  }
})

test('dist modules resolve package dependencies, the shared clock and repository paths', () => {
  assert.equal(body('./game-clock'), body(join(dist, 'daemon/src/game-clock.js')))
  assert.equal(dirname(body.resolve('vec3')).startsWith(join(root, 'daemon/node_modules')), true)
  assert.equal(body('./paths').REPO_ROOT, root)
  assert.equal(body('./paths').DIST_ROOT, dist)
  assert.equal(JSON.parse(readFileSync(join(dist, 'mcp/package.json'), 'utf8')).type, 'module')
  assert.ok(existsSync(join(dist, 'daemon/src/core/strategy.ts')), 'sources copied for tests that read them')
})
