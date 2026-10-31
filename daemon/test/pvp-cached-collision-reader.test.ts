import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'

function scene() {
  let allocations = 0, wall = 'air', now = 0
  class CountedMap extends Map { constructor() { super(); allocations++ } }
  const filename = require.resolve('../src/pvp/search'), load = createRequire(filename), exported: any = {}
  runInNewContext(readFileSync(filename, 'utf8'), { exports: exported, Map: CountedMap, queueMicrotask,
    require: name => name === '../game-clock' ? { now: () => now } : load(name) }, { filename })
  const bot = { entity: { position: new Vec3(.5, 0, .5) } }
  const read = p => ({ name: p.x === 2 ? wall : 'air', position: p.clone(),
    boundingBox: p.x === 2 && wall === 'stone' ? 'block' : 'empty',
    shapes: p.x === 2 && wall === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [] })
  const view = exported.observedCollision(bot, read, true)
  return { view, allocations: () => allocations, wall: value => { wall = value }, tick: () => { now += 50 } }
}

test('a supplied cached flight reader avoids a second raw map per observed cell', () => {
  const f = scene()
  for (let x = 3; x < 30; x++) assert.equal(f.view.blockAt(new Vec3(x, 1, 0))?.name, 'air')
  assert.equal(f.allocations(), 1, 'keep only the existing visibility-result map; the supplied reader owns raw caching')
})

test('a cached reader still certifies LOS after its source changes', async () => {
  const f = scene()
  assert.equal(f.view.blockAt(new Vec3(4, 1, 0))?.name, 'air')
  f.wall('stone')
  assert.equal(f.view.blockAt(new Vec3(5, 1, 0)), null, 'raw reuse cannot bypass the real visibility ray')
  await Promise.resolve()
  f.wall('air'); f.tick()
  assert.equal(f.view.blockAt(new Vec3(5, 1, 0))?.name, 'air', 'new observations must still expire the hidden-cell result')
})
