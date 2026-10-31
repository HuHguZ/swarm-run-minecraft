import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'

test('flight forecasts reuse the arena module while checking every trajectory boundary', () => {
  const filename = require.resolve('../src/elytra/physics'), load = createRequire(filename), exported: any = {}
  const team = load('../combat/team-wind')
  let loads = 0, checks = 0
  runInNewContext(readFileSync(filename, 'utf8'), { exports: exported, require: name => {
    if (name !== '../combat/team-wind') return load(name)
    loads++
    return { windInside: (...args) => { checks++; return team.windInside(...args) } }
  } }, { filename })
  const W = { boxHit: () => false, floorBelow: () => null }
  const arena = { x: 0, z: 0, r: 8, killY: 0 }
  const run = (p, v, yaw, pitch) => exported.rollout(W, p, v, yaw, pitch, 0, 18, { arena })
  assert.equal(run({ x: 0, y: 10, z: 0 }, { x: .2, y: 0, z: 0 }, -Math.PI / 2, 0).kind, null)
  assert.equal(run({ x: 7, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, -Math.PI / 2, 0).kind, 'outside')
  assert.equal(run({ x: 0, y: .1, z: 0 }, { x: 0, y: -.5, z: 0 }, 0, -1).kind, 'outside')
  assert(checks > 20, 'reusing the module cannot skip body clearance or the void boundary')
  assert.equal(loads, 1, 'module lookup belongs to initialization, not each simulated position')
})

test('a synchronous flight forecast bounds raw Block retention before its microtask runs', () => {
  const maps: any[] = [], callbacks: Array<() => void> = []
  class CountedMap extends Map {
    peak = 0
    constructor () { super(); maps.push(this) }
    set (key, value) { super.set(key, value); this.peak = Math.max(this.peak, this.size); return this }
  }
  const filename = require.resolve('../src/elytra/physics'), load = createRequire(filename), exported: any = {}
  runInNewContext(readFileSync(filename, 'utf8'), { exports: exported, Map: CountedMap,
    queueMicrotask: callback => callbacks.push(callback), require: name =>
      name === '../game-clock' ? { now: () => 0 }
        : name === '../fastblocks' ? { install: () => null }
          : name === '../pvp/search' ? { observedCollision: (_bot, read) => ({ blockAt: read }) } : load(name) }, { filename })
  let reads = 0
  const bot: any = Object.assign(new EventEmitter(), { blockAt: () => {
    reads++; return { name: 'air', boundingBox: 'empty', shapes: [] }
  } })
  const world = exported.worldOf(bot, { observed: true }), raw = maps[0]
  for (let x = 0; x <= 120000; x++) assert.equal(world.at(x, 10, 0), 0)
  assert(raw.peak <= 120000, 'raw must respect the existing body-cache capacity even during one synchronous call')
  assert.equal(callbacks.length, 1, 'eviction does not schedule a microtask per insertion')
  world.clear(); const before = reads
  world.at(120000, 10, 0); assert.equal(reads, before, 'the most recent raw cell is reused')
  world.at(0, 10, 0); assert.equal(reads, before + 1, 'evicted cells are fetched again instead of becoming unknown')
  callbacks[0](); assert.equal(raw.size, 0, 'the original end-of-pass release still runs')
})

test('observed flight reuses unknown cells for one observation tick without accepting them as supports', () => {
  const filename = require.resolve('../src/elytra/physics'), load = createRequire(filename), exported: any = {}
  let now = 0, queries = 0, visible = false, peak = 0
  class CountedSet extends Set {
    add (value) { super.add(value); peak = Math.max(peak, this.size); return this }
  }
  runInNewContext(readFileSync(filename, 'utf8'), { exports: exported, queueMicrotask, Set: CountedSet,
    require: name => name === '../game-clock' ? { now: () => now }
      : name === '../fastblocks' ? { install: () => null }
        : name === '../pvp/search' ? { observedCollision: () => ({ blockAt: () => {
          queries++
          return visible ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : null
        } }) } : load(name) }, { filename })
  const bot: any = new EventEmitter(), W = exported.worldOf(bot, { observed: true })
  for (let i = 0; i < 100; i++) {
    assert.equal(W.at(2, 10, 3), 1)
    assert.equal(W.floorBelow(2.5, 10, 3.5, 0), null)
  }
  assert.equal(queries, 1, 'one visibility lookup for repeated unknown collision/support queries')
  visible = true; now = 50
  assert.equal(W.floorBelow(2.5, 10, 3.5, 0)?.top, 11, 'a newly visible support is reconsidered next tick')
  assert.equal(queries, 2)
  visible = false; W.clear()
  assert.equal(W.at(2, 10, 3), 1)
  assert.equal(W.floorBelow(2.5, 10, 3.5, 0), null)
  assert.equal(queries, 3, 'explicit clearing also clears negative observations')
  bot.emit('blockUpdate', null, { position: { x: 2, y: 10, z: 3 } })
  W.at(2, 10, 3)
  assert.equal(queries, 4, 'a block update invalidates the short negative cache')
  for (let x = 0; x < 250010; x++) W.at(x, 10, 3)
  assert(peak <= 250001, 'unknown observations share the existing cell-capacity bound')
})
