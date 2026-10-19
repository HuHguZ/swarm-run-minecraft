import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { acquireTarget } from '../src/pvp/search'

function scene (t) {
  const time = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(time)
  const goals = []
  const bot = {
    entity: { position: new Vec3(.5, 0, .5), yaw: 0, onGround: true }, health: 20,
    blockAt: p => ({ name: p.y < 0 ? 'stone' : 'air', position: p.floored(),
      boundingBox: p.y < 0 ? 'block' : 'empty', shapes: p.y < 0 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    canSeeBlock: () => true,
    pathfinder: { setGoal: goal => goals.push(goal) }, clearControlStates: () => {}
  }
  t.after(() => time.dispose())
  const ctl = { aborted: false, onAbort: [] }
  let visible = false
  // The search may ask the observer, but never read the hidden target itself.
  const raw = { get position () { throw new Error('hidden packet position') } }
  const seen = { position: new Vec3(3, 0, 0), _ndVisible: true }
  const vision = { observe: () => visible ? seen : null }
  const tick = async n => { time.advanceTicks(n); await new Promise(resolve => setImmediate(resolve)) }
  return { bot, ctl, raw, vision, seen, goals, time, tick, show: () => { visible = true } }
}

test('PvP searches visible ground when the target starts behind a wall, then stops on sight', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.ok(f.goals[0], 'a hidden start must cause a search step, not immediate lost')
  f.show(); await f.tick(2)
  const result = await running
  assert.strictEqual(result.entity, f.seen)
  assert.equal(f.goals.at(-1), null)
  assert.equal(result.search.legs, 1)
})

test('PvP acquisition does not start a route while airborne', async t => {
  const f = scene(t); f.bot.entity.onGround = false
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.equal(f.goals.length, 0)
  f.ctl.aborted = true; await f.tick(2)
  assert.equal((await running).entity, null)
})

test('PvP search respects cancellation and the original fight deadline', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
  await f.tick(4)
  const result = await running
  assert.equal(result.entity, null)
  assert.equal(result.search.seconds, .2)
  assert.equal(f.goals.at(-1), null)
})

for (const hidden of [true, false]) test(`PvP search rejects ${hidden ? 'unseen support' : 'points outside the agreed arena'}`, async t => {
  const f = scene(t); f.bot.canSeeBlock = () => !hidden
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw,
    { deadline: 1200, arena: { x: .5, y: 0, z: .5, r: hidden ? 24 : 2 } })
  assert.equal(f.goals.length, 0)
  await f.tick(4); await running
  assert.ok(f.goals.every(g => g === null))
})

test('PvP immediate visibility leaves path controls alone', async t => {
  const f = scene(t); f.show()
  const result = await acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.strictEqual(result.entity, f.seen)
  assert.equal(f.goals.length, 0)
  assert.equal(result.search.legs, 0)
})

test('PvP acquisition observes the same named player after an entity reload', async t => {
  const f = scene(t)
  const old = { username: 'Foe', isValid: false }
  const replacement = { username: 'Foe', get position () { throw new Error('hidden replacement position') } }
  ;(f.bot as any).players = { Foe: { entity: old } }
  ;(f.vision as any).observe = candidate => candidate === replacement ? f.seen : null
  let acquired
  const running = acquireTarget(f.bot, f.ctl, f.vision, old, { deadline: 10000 }).then(r => { acquired = r })
  ;(f.bot as any).players.Foe.entity = replacement
  await f.tick(2)
  assert.strictEqual(acquired?.entity, f.seen)
  await running
})

test('PvP search abort releases controls and timers even with a frozen native clock', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  f.ctl.aborted = true
  for (const cancel of [...f.ctl.onAbort]) cancel()
  const result: any = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('abort waited for game time')), 100))])
  assert.equal(result.entity, null)
  assert.equal(f.goals.at(-1), null)
  assert.equal(f.time.timers.size, 0)
  assert.equal(f.ctl.onAbort.length, 0)
})

test('PvP acquisition protects intermediate arena nodes and floor, then restores movement settings', async t => {
  const f = scene(t)
  const neighbors = [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }]
  const mv = { canDig: true, allowParkour: true, maxDropDown: 9, allow1by1towers: true,
    scafoldingBlocks: [1], digCost: 1, exclusionAreasBreak: [], getNeighbors: () => neighbors }
  const original = { ...mv }
  ;(f.bot.pathfinder as any).movements = mv
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw,
    { deadline: 10000, arena: { x: .5, y: 0, z: .5, r: 12 } })
  assert.deepEqual(mv.getNeighbors(), [neighbors[0]])
  assert.equal(mv.exclusionAreasBreak.at(-1)({ position: new Vec3(0, -1, 0) }), 100)
  assert.equal(mv.allow1by1towers, false)
  assert.equal(mv.allowParkour, false)
  f.show(); await f.tick(2); await running
  assert.deepEqual(mv, original)
})

test('PvP route can leave a shallow crater along its current floor without digging the arena floor', () => {
  const { combatMovement }: typeof import('../src/pvp/movement') = require('../src/pvp/movement')
  const neighbors = [{ x: 589, y: 119, z: 594 }, { x: 590, y: 120, z: 593 }, { x: 589, y: 118, z: 594 }]
  const mv = { getNeighbors: () => neighbors, exclusionAreasBreak: [] }
  const bot = { entity: { position: new Vec3(589.7, 119, 593.3) }, pathfinder: { movements: mv } }
  const route = combatMovement(bot, { x: 600, y: 120, z: 600, r: 24 })
  try {
    assert.deepEqual(mv.getNeighbors(), neighbors.slice(0, 2))
    assert.equal(mv.exclusionAreasBreak[0]({ position: new Vec3(589, 118, 593) }), 100)
    bot.entity.position.y = 120
    assert.deepEqual(mv.getNeighbors(), [neighbors[1]], 'standing on the field retains its original floor limit')
  } finally { route.restore() }
})

test('PvP acquisition and route costs cannot inspect a hidden ceiling above visible ground', async t => {
  const results = []
  for (const roof of [false, true]) {
    const f = scene(t)
    const open = f.bot.blockAt
    const hidden = new Vec3(0, 1, -6)
    f.bot.blockAt = p => {
      const c = p.floored()
      if (c.equals(new Vec3(0, 1, -3)) || roof && c.equals(hidden)) return { name: 'obsidian', position: c, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return open(p)
    }
    assert.equal((require('../src/pick') as typeof import('../src/pick')).blockSeen(f.bot, hidden), false)
    const mv = { bot: f.bot, getBlock(pos, dx, dy, dz) { return pos ? this.bot.blockAt(pos.offset(dx, dy, dz)) : null },
      allowEntityDetection: true, exclusionAreasBreak: [] }
    const getBlock = mv.getBlock
    ;(f.bot.pathfinder as any).movements = mv
    const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    results.push({ goal: f.goals[0] && [f.goals[0].x, f.goals[0].y, f.goals[0].z], ceiling: mv.getBlock(hidden, 0, 0, 0)?.name || null })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, getBlock)
    assert.equal(mv.allowEntityDetection, true)
  }
  assert.deepEqual(results[0], results[1], 'an unseen roof must not alter the viewpoint or path geometry')
  assert.ok(results[0].goal, 'still searches the visible alternative')
  assert.equal(results[0].ceiling, null)
})

test('PvP acquisition hides cached packet geometry from fastblocks route candidates and restores the cache', async t => {
  const { Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const Move = require('mineflayer-pathfinder/lib/move')
  const bench: typeof import('../scenes/infra/try-astar-bench') = require('../scenes/infra/try-astar-bench')
  const fastblocks: typeof import('../src/fastblocks') = require('../src/fastblocks')
  const before = process.env.ND_S9
  process.env.ND_S9 = '1'
  t.after(() => { if (before === undefined) delete process.env.ND_S9; else process.env.ND_S9 = before })
  const observations = []
  const packetGeometry = []
  for (const roof of [false, true]) {
    const f = scene(t)
    const hidden = new Vec3(0, 1, -6)
    const world = bench.syntheticWorld((x, y, z) => y < 0 ? 'stone'
      : x === 0 && y === 1 && (z === -3 || roof && z === -6) ? 'obsidian' : null, -1, 0, -1, 3)
    const native = bench.fakeBot(world, { at: f.bot.entity.position, kit: ['diamond_pickaxe'] })
    const bot = Object.assign(native, { canSeeBlock: f.bot.canSeeBlock })
    bot.entity.yaw = 0
    bot.pathfinder.setGoal = goal => f.goals.push(goal)
    const mv: any = new Movements(bot)
    bot.pathfinder.setMovements(mv)
    fastblocks.wrapMovements(bot, mv)
    const cachedGetBlock = mv.getBlock
    const cache = mv._ndFast
    assert(cache, 'exercise the real fastblocks wrapper')
    assert.notEqual(cachedGetBlock, Movements.prototype.getBlock)
    assert.equal((require('../src/pick') as typeof import('../src/pick')).blockSeen(bot, hidden), false)
    // Seed the real block cache before acquisition: observed reads must not reuse this hidden value.
    assert.equal(mv.getBlock(hidden, 0, 0, 0).name, roof ? 'obsidian' : 'air')
    const candidates = () => mv.getNeighbors(new Move(0, 0, -5, 0, 0)).map(m => ({
      pos: [m.x, m.y, m.z], cost: m.cost, dig: m.toBreak.map(p => [p.x, p.y, p.z])
    }))
    const beforeCandidates = candidates()
    packetGeometry.push(beforeCandidates)
    const running = acquireTarget(bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    observations.push({ goal: f.goals[0] && [f.goals[0].x, f.goals[0].y, f.goals[0].z],
      ceiling: mv.getBlock(hidden, 0, 0, 0).name ?? null, candidates: candidates() })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, cachedGetBlock)
    assert.equal(mv._ndFast, cache)
    assert.equal(mv.allowEntityDetection, true)
    assert.deepEqual(candidates(), beforeCandidates, 'ordinary movement retains its prior candidates and costs')
    const hits = cache.stats.hits
    mv.getBlock(hidden, 0, 0, 0)
    assert(cache.stats.hits > hits, 'normal movement resumes the same cache')
  }
  assert.notDeepEqual(packetGeometry[0], packetGeometry[1], 'the hidden roof really changes the unfiltered route')
  assert.deepEqual(observations[0], observations[1], 'unknown packet geometry must not change acquisition candidates or costs')
  assert.ok(observations[0].goal, 'visible alternative remains available')
  assert.equal(observations[0].ceiling, null)
})

test('PvP LOS and acquisition cannot see packet cells beyond an unknown plane', async t => {
  const { observedCollision }: typeof import('../src/pvp/search') = require('../src/pvp/search')
  const results = []
  for (const stone of [false, true]) {
    const f = scene(t)
    const open = f.bot.blockAt
    const hidden = new Vec3(3, 1, 0)
    f.bot.blockAt = p => {
      const c = p.floored()
      if (c.x === 1) return null // Missing world/chunk data is not visible air.
      if (stone && c.equals(hidden)) return { name: 'stone', position: c, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return open(p)
    }
    const view = observedCollision(f.bot)
    assert.equal(view.blockAt(new Vec3(0, 1, 0))?.name, 'air', 'known cell before the gap stays visible')
    const mv = { bot: f.bot, getBlock(pos, dx, dy, dz) { return this.bot.blockAt(pos.offset(dx, dy, dz)) },
      allowEntityDetection: true, exclusionAreasBreak: [] }
    const getBlock = mv.getBlock
    ;(f.bot.pathfinder as any).movements = mv
    const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    results.push({ los: view.blockAt(hidden)?.name ?? null, route: mv.getBlock(hidden, 0, 0, 0)?.name ?? null })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, getBlock)
  }
  assert.deepEqual(results, [{ los: null, route: null }, { los: null, route: null }])
})
