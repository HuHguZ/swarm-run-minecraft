import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf } from '../src/elytra/physics'
const clock: typeof import('../src/game-clock') = require('../src/game-clock')

test('one collision box or floor column shares its clock observation across cells', t => {
  let reads = 0
  t.mock.method(clock, 'now', () => { reads++; return 1000 })
  const bot: any = Object.assign(new EventEmitter(), { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) })
  const W = worldOf(bot)
  reads = 0
  assert.equal(W.boxHit(1, 100, 1), false)
  assert.equal(reads, 1, 'one frame query needs one clock observation, including the fence support row')
  reads = 0
  assert.equal(W.floorBelow(1, 100, 1, 40), null)
  assert.equal(reads, 1, 'the 41-cell column must not repeatedly resolve the active game clock')
  reads = 0
  assert.equal(W.at(1, 100, 1), 0)
  assert.equal(W.solid(1, 100, 1), false)
  assert.equal(reads, 2, 'standalone cell queries retain fresh observations')
})

test('new geometry queries retain expiry, explicit clearing and block-update invalidation', t => {
  let now = 1000, solid = false, reads = 0
  t.mock.method(clock, 'now', () => now)
  const bot: any = Object.assign(new EventEmitter(), { blockAt: () => {
    reads++
    return solid ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  } })
  const W = worldOf(bot)
  assert.equal(W.boxHit(.5, 100, .5, .6), false)
  const first = reads
  solid = true
  assert.equal(W.boxHit(.5, 100, .5, .6), false)
  assert.equal(reads, first, 'a remembered cell retains its existing lifetime')
  now += 20001
  assert.equal(W.boxHit(.5, 100, .5, .6), true)
  solid = false
  bot.emit('blockUpdate', null, { position: new Vec3(0, 100, 0) })
  assert.equal(W.boxHit(.5, 100, .5, .6), false)
  solid = true
  W.clear()
  assert.equal(W.floorBelow(.5, 100, .5, 0)?.top, 101)
})
