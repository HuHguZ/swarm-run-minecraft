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

test('long real LOS rays do not build a string key for every raw cell', t => {
  const f = scene(t), original = Vec3.prototype.toString
  let strings = 0, reads = 0
  t.mock.method(Vec3.prototype, 'toString', function () { strings++; return original.call(this) })
  const view = observedCollision(f.bot, p => { reads++; return { name: 'air', boundingBox: 'empty', shapes: [], position: p.clone() } })
  assert.equal(view.blockAt(new Vec3(40, 1, 0))?.name, 'air')
  assert.ok(reads >= 40, 'use the real DDA, not a mocked visibility result')
  assert.equal(strings, 1, 'only the outer target cell uses its existing string key')
})

test('numeric ray-cache collisions cannot substitute a different raw cell', t => {
  const f = scene(t), low = new Vec3(2, 1, 0), high = new Vec3(2, 1025, -1)
  const pick = require('../src/pick')
  t.mock.method(pick, 'blockOnRay', W => {
    assert.equal(W.blockAt(low).name, 'air')
    assert.equal(W.blockAt(high).name, 'stone')
    assert.equal(W.blockAt(low).name, 'air')
    return null
  })
  f.put(high, 'stone')
  assert.equal(f.view.blockAt(new Vec3(4, 1, 0))?.name, 'air')
})

for (const obstruction of ['stone', null]) test(`all nine LOS rays share raw reads without seeing through ${obstruction ?? 'unloaded terrain'}`, t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  f.put(wall, obstruction); f.put(target, 'stone')
  assert.equal(f.view.blockAt(target), null)
  assert.equal(f.reads.has(target.toString()), false, 'packet-only target behind the obstruction stays unread')
  once(f.reads)
})

test('one known full cube can occlude the remaining corner rays without repeating their world traversal', t => {
  const f = scene(t), wall = new Vec3(2, 1, 0), target = new Vec3(4, 1, 0)
  f.put(wall, 'stone'); f.put(target, 'stone')
  const pick = require('../src/pick'), original = pick.blockOnRay
  let rays = 0
  t.mock.method(pick, 'blockOnRay', (...args) => { rays++; return original(...args) })
  assert.equal(f.view.blockAt(target), null)
  assert.equal(rays, 1, 'all sampled target points lie behind the same observed full cube')
  assert.equal(f.reads.has(target.toString()), false)
})

test('one synchronous forecast reuses an observed wall across different hidden cells without hiding the wall itself', t => {
  const f = scene(t), wall = new Vec3(2, 1, 0)
  f.put(wall, 'stone')
  const pick = require('../src/pick'), original = pick.blockOnRay
  let rays = 0
  t.mock.method(pick, 'blockOnRay', (...args) => { rays++; return original(...args) })
  for (const x of [4, 5, 6]) assert.equal(f.view.blockAt(new Vec3(x, 1, 0)), null)
  assert.equal(rays, 1, 'the same known cube occludes all three cells in this forecast')
  assert.equal(f.view.blockAt(wall)?.name, 'stone', 'the occluder is itself visible')
})

test('alternating walls retain both real occluders during the same forecast', t => {
  const f = scene(t)
  f.put(new Vec3(2, 1, 0), 'stone'); f.put(new Vec3(0, 1, 2), 'stone')
  const pick = require('../src/pick'), original = pick.blockOnRay
  let rays = 0
  t.mock.method(pick, 'blockOnRay', (...args) => { rays++; return original(...args) })
  for (let d = 4; d < 16; d++) {
    assert.equal(f.view.blockAt(new Vec3(d, 1, 0)), null)
    assert.equal(f.view.blockAt(new Vec3(0, 1, d)), null)
  }
  assert.equal(rays, 2, 'each known wall needs its real DDA only once, even when the other wall intervenes')
})

for (const axis of ['x', 'z']) test(`the most recently used ${axis} wall is tested first on subsequent corner rays`, t => {
  const f = scene(t)
  f.put(new Vec3(2, 1, 0), 'stone'); f.put(new Vec3(0, 1, 2), 'stone')
  f.view.blockAt(new Vec3(4, 1, 0)); f.view.blockAt(new Vec3(0, 1, 4))
  const target = d => axis === 'x' ? new Vec3(d, 1, 0) : new Vec3(0, 1, d)
  assert.equal(f.view.blockAt(target(5)), null)
  const pick = require('../src/pick'), original = pick.rayBox
  let boxes = 0
  t.mock.method(pick, 'rayBox', (...args) => { boxes++; return original(...args) })
  assert.equal(f.view.blockAt(target(6)), null)
  assert.equal(boxes, 9, 'each of the nine hidden sample points needs only its nearest cached test')
})

test('a two-cube occluder cache evicts its oldest cube without losing its newest wall', t => {
  const f = scene(t), pick = require('../src/pick'), original = pick.blockOnRay
  let rays = 0
  t.mock.method(pick, 'blockOnRay', (...args) => { rays++; return original(...args) })
  for (let i = 0; i < 3; i++) {
    f.bot.entity.position.set(.5, i * 3, .5)
    f.put(new Vec3(2, i * 3 + 1, 0), 'stone')
    assert.equal(f.view.blockAt(new Vec3(4, i * 3 + 1, 0)), null)
  }
  const before = rays
  f.bot.entity.position.set(.5, 0, .5)
  assert.equal(f.view.blockAt(new Vec3(5, 1, 0)), null)
  assert.equal(rays, before + 1, 'the evicted first wall is retraced')
  f.bot.entity.position.set(.5, 6, .5)
  assert.equal(f.view.blockAt(new Vec3(5, 7, 0)), null)
  assert.equal(rays, before + 1, 'the newest observed wall remains cached')
})

test('several remembered cubes preserve fresh exact LOS around mixed walls and gaps', t => {
  const f = scene(t)
  for (let d = -3; d <= 3; d++) for (let y = 0; y < 4; y++) {
    f.put(new Vec3(2, y, d), 'stone')
    f.put(new Vec3(d, y, 2), 'stone')
  }
  f.put(new Vec3(2, 1, 0), 'glass'); f.put(new Vec3(2, 2, 0), 'oak_slab')
  f.put(new Vec3(0, 1, 2), null)
  for (let x = -6; x <= 6; x += 3) for (let z = -6; z <= 6; z += 3) for (const y of [0, 2, 4]) {
    const at = new Vec3(x, y, z)
    const exact = observedCollision(f.bot).blockAt(at)
    assert.equal(f.view.blockAt(at)?.stateId ?? null, exact?.stateId ?? null, `visibility differs at ${at}`)
  }
})

test('occluders expire after the synchronous forecast even without a clock tick', async t => {
  const f = scene(t), wall = new Vec3(2, 1, 0)
  f.put(wall, 'stone')
  assert.equal(f.view.blockAt(new Vec3(4, 1, 0)), null)
  await Promise.resolve()
  f.put(wall, 'air')
  assert.equal(f.view.blockAt(new Vec3(5, 1, 0))?.name, 'air')
})

test('a reused wall cannot hide the visible ray which only grazes its corner', t => {
  const f = scene(t)
  f.put(new Vec3(4, 1, -1), 'stone'); f.put(new Vec3(7, 1, 0), null)
  assert.equal(f.view.blockAt(new Vec3(8, 1, -1)), null)
  const target = new Vec3(9, 1, -1)
  assert.equal(observedCollision(f.bot).blockAt(target)?.name, 'air', 'the real DDA sees the centre past the corner')
  assert.equal(f.view.blockAt(target)?.name, 'air', 'reusing a cube must preserve that exact visible centre ray')
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
