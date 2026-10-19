import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { functionSource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const Chunk: any = (require('prismarine-chunk') as typeof import('prismarine-chunk').default)('1.21.11')

function reader() {
  const context: any = {}
  vm.runInNewContext(functionSource(path.join(__dirname, '../src/session.js'), 'skyLightAt') + '\nthis.read = skyLightAt', cjsContext(context))
  return context.read
}
const sky = reader()
const point = new Vec3(-1.2, 171, -16.2)
function body(column, fast = false) {
  return { world: { getColumnAt: () => column }, _ndFastBlocks: fast,
    blockAt: p => column?.getBlock(new Vec3(Math.floor(p.x) & 15, Math.floor(p.y), Math.floor(p.z) & 15)) }
}

for (const fast of [false, true]) test(`an absent native 1.21.11 sky section reads zero with fastBlocks=${fast}`, () => {
  const column = new Chunk({ minY: -64, worldHeight: 384 })
  assert.equal(column.skyLightSections[15], null)
  assert.equal(column.getSkyLight(new Vec3(14, 171, 15)), 0)
  assert.equal(sky(body(column, fast), point), 0)
})

test('native zero-light and full-light updates retain their actual light values', () => {
  const column = new Chunk({ minY: -64, worldHeight: 384 })
  const index = 15, mask = 2 ** index
  column.loadParsedLight([], [], [[0, 0]], [[0, 0]], [[0, mask]], [[0, 0]])
  assert.equal(column.emptySkyLightMask.get(index), 1)
  assert.equal(sky(body(column), point), 0)
  column.loadParsedLight([Buffer.alloc(2048, 0xff)], [], [[0, mask]], [[0, 0]], [[0, 0]], [[0, 0]])
  assert.equal(column.emptySkyLightMask.get(index), 0)
  assert.equal(sky(body(column), point), 15)
})

test('column getter receives floored local coordinates without constructing a Block', () => {
  let received
  const bot = { world: { getColumnAt: () => ({ getSkyLight(p) { received = p; return 3 } }) },
    blockAt() { throw Error('column light getter needs no Block') } }
  assert.equal(sky(bot, point), 3)
  assert.deepEqual(JSON.parse(JSON.stringify(received)), { x: 14, y: 171, z: 15 })
})

test('older columns fall back to the observed Block light instead of assumed full sky', () => {
  assert.equal(sky({ world: { getColumnAt: () => ({}) }, blockAt: () => ({ skyLight: 6 }) }, point), 6)
})

test('unloaded columns and unreadable legacy Block light remain unknown', () => {
  assert.equal(sky({ world: { getColumnAt: () => null } }, point), null)
  assert.equal(sky({ world: { getColumnAt: () => ({}) }, blockAt: () => null }, point), null)
})
