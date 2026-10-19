import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { cjsContext } from './cjs-context'
import { Vec3 } from 'vec3'
import { transformSync } from 'esbuild'

async function receipt({ sky = true, openSides = 2, targetY = null, pitExit = false } = {}) {
  const file = path.join(__dirname, '../src/survival/surface-body.ts'), realRequire = createRequire(file)
  const bot = {
    entity: { position: new Vec3(24.5, 62, -17.5) }, health: 20, food: 20,
    game: { minY: -64, height: 384 }, inventory: { items: () => [] },
    nearestEntity: () => null, clearControlStates() {}, stopDigging() {},
    blockAt(point) {
      const position = point.floored(), dx = position.x - 24, dz = position.z + 18
      const open = position.y >= 62 && (dx === 0 && dz === 0 || dx === 1 && dz === 0 || openSides > 1 && dx === -1 && dz === 0)
      return { position, name: open ? 'air' : 'dirt', boundingBox: open ? 'empty' : 'block' }
    }
  }
  const context: any = { module: { exports: {} }, require(name) {
    const actual = realRequire(name)
    if (name === './enter-shelter') return { ...actual, toolBudget: () => Infinity, inWater: () => false }
    if (name === './recover-loot') return { ...actual, pitCheck: () => ({ out: pitExit, free: false, sky }), openSky: () => sky }
    return actual
  } }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts' }).code, cjsContext(context))
  return context.module.exports.surface({ bot, mcData: {}, journal: { append() {} } },
    { aborted: !sky && targetY === null || openSides < 2 && !pitExit, onAbort: [] }, { targetY })
}

test('AA22 open sky with two open sides acknowledges the actual exit instead of repeating surface RPC', async () => {
  const result = await receipt()
  assert.equal(result.out, true)
  assert.equal(result.climbed, 0)
  assert.equal(result.stopped, undefined)
})

test('a requested underground height does not invent a surface exit', async () => {
  const result = await receipt({ sky: false, targetY: 62 })
  assert.equal(result.out, false)
  assert.equal(result.climbed, 0)
})

test('open sky without a traversable second side does not acknowledge an exit', async () => {
  assert.equal((await receipt({ openSides: 1 })).out, false)
})

test('the existing physical pit exit remains acknowledged', async () => {
  assert.equal((await receipt({ sky: false, pitExit: true })).out, true)
})
