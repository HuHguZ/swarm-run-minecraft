import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { observedCollision } from '../src/pvp/search'
import { Block, block, data, testBot } from './tick-plugins-fixture'

function scene(t) {
  const time = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(time)
  t.after(() => time.dispose())
  const bot = testBot(); bot.entity.position.set(.5, 0, .5)
  const states = new Map<string, number | null>(), reads = new Map<string, number>()
  const raw = p => {
    const cell = p.floored(), key = cell.toString()
    reads.set(key, (reads.get(key) || 0) + 1)
    const state = states.has(key) ? states.get(key) : data.blocksByName.air.defaultState
    if (state === null) return null
    const b = Block.fromStateId(state, 0); b.position = cell; return b
  }
  bot.blockAt = raw
  const put = (p: Vec3, name: string | null) => states.set(p.toString(), name === null ? null : block(name, p).stateId)
  return { bot, raw, reads, states, put, view: observedCollision(bot) }
}

function once(reads: Map<string, number>) {
  assert.ok(reads.size > 1, 'the real ray must traverse several cells')
  assert.deepEqual([...reads].filter(([, count]) => count > 1), [], 'one synchronous query must read each raw cell at most once')
}

test('a visible cell reuses the real LOS read for its final raw block', t => {
  const f = scene(t), target = new Vec3(4, 1, 0)
  f.put(target, 'stone')
  assert.equal(f.view.blockAt(target)?.name, 'stone')
  assert.equal(f.reads.get(target.toString()), 1, 'the final visible block was already read by the ray')
  once(f.reads)
})

for (const obstruction of ['stone', null]) test(`all nine LOS rays share raw reads without seeing through ${obstruction ?? 'unloaded terrain'}`, t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  f.put(wall, obstruction); f.put(target, 'stone')
  assert.equal(f.view.blockAt(target), null)
  assert.equal(f.reads.has(target.toString()), false, 'packet-only target behind the obstruction stays unread')
  once(f.reads)
})

for (const transparent of ['glass', 'glass_pane']) test(`raw read reuse preserves sight through ${transparent}`, t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  f.put(wall, transparent); f.put(target, 'stone')
  assert.equal(f.view.blockAt(target)?.name, 'stone')
  once(f.reads)
})

test('the corner rays still reveal a cell whose centre ray hits a real top slab', t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  const slab = Block.fromProperties(data.blocksByName.oak_slab.id, { type: 'top', waterlogged: 'false' }, 0)
  f.states.set(wall.toString(), slab.stateId)
  assert.deepEqual(slab.shapes, [[0, .5, 0, 1, 1, 1]])
  assert.equal(f.view.blockAt(target)?.name, 'air')
  once(f.reads)
})

test('different queries in the same clock tick read new walls and the current eye position', t => {
  const f = scene(t), wall = new Vec3(2, 1, 0)
  assert.equal(f.view.blockAt(new Vec3(4, 1, 0))?.name, 'air')
  const firstWallReads = f.reads.get(wall.toString())
  f.put(wall, 'stone')
  assert.equal(f.view.blockAt(new Vec3(5, 1, 0)), null, 'the next target cannot reuse the previous open corridor')
  assert.ok(f.reads.get(wall.toString())! > firstWallReads!)
  f.bot.entity.position.set(3.5, 0, .5)
  assert.equal(f.view.blockAt(new Vec3(6, 1, 0))?.name, 'air', 'the eye moved to the other side of the wall')
  f.bot.entity.position.set(.5, 0, .5)
  assert.equal(f.view.blockAt(new Vec3(7, 1, 0)), null)
})

test('a transient raw ray error is retried by the next corner rather than cached as unknown', t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  let attempts = 0
  const view = observedCollision(f.bot, p => {
    if (p.equals(wall) && ++attempts === 1) throw Error('transient raw cell error')
    return f.raw(p)
  })
  assert.equal(view.blockAt(target)?.name, 'air')
  assert.equal(attempts, 2, 'throwing reads cannot poison the shared ray cache')
})

test('an error reading the final visible raw cell still propagates and is not cached', t => {
  const f = scene(t), target = new Vec3(0, 1, 0), sentinel = Error('raw target error')
  let attempts = 0
  const view = observedCollision(f.bot, p => {
    if (p.equals(target)) { attempts++; throw sentinel }
    return f.raw(p)
  })
  assert.throws(() => view.blockAt(target), error => error === sentinel)
  assert.equal(attempts, 2, 'ray fallback catches its read, while the final raw read must throw')
  assert.throws(() => view.blockAt(target), error => error === sentinel)
  assert.equal(attempts, 4, 'a failed query cannot create an outer cached result')
})
