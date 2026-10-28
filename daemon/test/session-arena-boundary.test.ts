import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
import * as parkour from '../src/navigation/parkour'
const arena = { x: .5, z: .5, r: 5, killY: 60 }

function fixture(t, mode = 'arrive') {
  t.mock.method((require('../src/edges/mlg') as typeof import('../src/edges/mlg')), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method((require('../src/blockmoves') as typeof import('../src/blockmoves')), 'on', () => false)
  const file = path.resolve(__dirname, '../src/session.ts'), local = createRequire(file), module = { exports: {} as any }
  const code = (require('esbuild') as typeof import('esbuild')).transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(module.exports, local, module, file, path.dirname(file))
  const calls = { starts: 0, cancels: 0, cleared: 0 }, items = [
    { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id, count: 1 },
    { name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 64 }
  ]
  const world = { getBlock(p) {
    const q = p.floored(), block = Block.fromStateId(registry.blocksByName[q.y === 63 ? 'stone' : 'air'].defaultState)
    block.position = q; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, health: 20, food: 20, entities: {},
    game: { dimension: 'overworld', minY: -64, height: 384 }, inventory: { slots: Array(46).fill(null), items: () => items },
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, -.0784, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, metadata: [], attributes: {} },
    blockAt: p => world.getBlock(p), controlState: { ...parkour.IDLE }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    clearControlStates: () => { calls.cleared++; bot.controlState = { ...parkour.IDLE } },
    physics: native.Physics(registry, world)
  })
  bot.pathfinder = { movements: null, goal: null, isMoving: () => false, isMining: () => false, isBuilding: () => false,
    setMovements(m) { this.movements = m },
    setGoal(goal) {
      this.goal = goal; bot.emit('goal_updated', goal); bot.emit('path_reset', 'goal_updated')
      if (goal && mode === 'arrive') setImmediate(() => {
        bot.entity.position = new Vec3(goal.x + .5, goal.y ?? 64, goal.z + .5); bot.emit('goal_reached', goal)
      })
    } }
  const s: any = Object.assign(Object.create(module.exports.Session.prototype), {
    bot, mcData: registry, require: () => bot, underSky: () => true, stuckCells: new Map(), surfaceStrict: false,
    surfaceWalk: false, pathGoalY: null, cancel: () => { calls.cancels++; bot.pathfinder.setGoal(null) },
    runIntent: async (_name, work) => {
      calls.starts++; s.cancel()
      const ctl = s.ctl = { aborted: false, onAbort: [] as Array<() => void>, abort() { if (this.aborted) return; this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
      try { return await work(ctl) } finally { ctl.abort() }
    }
  })
  s.updateMovements(true)
  const stepCost = p => bot.pathfinder.movements.exclusionAreasStep.reduce((n, fn) => n + fn(world.getBlock(p)), 0)
  return { s, bot, calls, items, stepCost }
}

test('an outside or snapped-edge arena goal is rejected before cancel, start, controls or movements change', t => {
  const f = fixture(t), old = f.bot.pathfinder.movements, oldGoal = f.bot.pathfinder.goal = { current: true }
  for (const at of [{ x: 6, z: 0 }, { x: 4, z: 0 }, { x: 0, y: 60, z: 0 }]) {
    assert.throws(() => f.s.goto({ ...at, arena }), (error: any) => error.code === 'ARENA_BOUNDARY')
  }
  assert.equal(f.calls.starts, 0); assert.equal(f.calls.cancels, 0); assert.equal(f.calls.cleared, 0)
  assert.equal(f.bot.pathfinder.movements, old); assert.equal(f.bot.pathfinder.goal, oldGoal)
})

test('arena A* rejects intermediate cells and an inventory rebuild preserves strict bounds until completion', async t => {
  const f = fixture(t, 'wait'), run = f.s.goto({ x: 2, y: 64, z: 0, arena, surface: false, bridge: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.stepCost(new Vec3(4, 64, 0)), Infinity)
  assert.ok(Number.isFinite(f.stepCost(new Vec3(2, 64, 0))))
  f.items[1] = { name: 'oak_planks', type: registry.itemsByName.oak_planks.id, count: 64 }
  f.s.updateMovements(true)
  assert.equal(f.stepCost(new Vec3(4, 64, 0)), Infinity)
  assert.equal(f.bot.pathfinder.movements.canDig, false); assert.deepEqual(f.bot.pathfinder.movements.scafoldingBlocks, [])
  const Move = require('mineflayer-pathfinder/lib/move')
  const neighbors = f.bot.pathfinder.movements.getNeighbors(new Move(3, 64, 0, 64, 0))
  assert.ok(neighbors.length > 0 && neighbors.every(n => parkour.withinArena(f.bot, { x: n.x + .5, y: n.y, z: n.z + .5 }, arena)))
  f.bot.entity.position = new Vec3(2.5, 64, .5); f.bot.emit('goal_reached', f.bot.pathfinder.goal)
  assert.ok((await run).arrived)
  assert.equal(f.s.gotoArena, undefined); assert.equal(f.s.surfaceStrict, false)
  assert.equal(f.bot.pathfinder.movements.canDig, true); assert.ok(Number.isFinite(f.stepCost(new Vec3(4, 64, 0))))
})

test('abort restores the arena scope immediately while its path promise unwinds', async t => {
  const f = fixture(t, 'wait'), run = f.s.goto({ x: 2, y: 64, z: 0, arena })
  await new Promise(resolve => setImmediate(resolve))
  f.s.ctl.abort()
  assert.equal(f.s.gotoArena, undefined); assert.equal(f.s.surfaceStrict, false)
  assert.equal(f.bot.pathfinder.movements.canDig, true)
  await assert.rejects(run)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

for (const kind of ['horizontal', 'kill plane']) test(`the actual next native ${kind} step is stopped before it crosses the arena boundary`, async t => {
  const f = fixture(t, 'wait'), run = f.s.goto({ x: 2, y: 64, z: 0, arena })
  await new Promise(resolve => setImmediate(resolve))
  if (kind === 'horizontal') f.bot.entity.velocity.x = 5
  else { f.bot.entity.position.y = 61; f.bot.entity.velocity.y = -2; f.bot.entity.onGround = false }
  const before = f.bot.entity.position.clone()
  f.bot.emit('physicsTick')
  assert.equal(f.bot.pathfinder.goal, null); assert.ok(f.calls.cleared)
  await assert.rejects(run, (error: any) => error.code === 'ARENA_BOUNDARY')
  assert.deepEqual(f.bot.entity.position, before, 'a forecast must never move the actual entity')
  assert.equal(f.s.gotoArena, undefined)
})


// Real 1.21.11 collision blocks, native mineflayer-pathfinder A*, Session.goto and native next-tick forecast.
function avoidSearch(f, corridor = false) {
  const AStar = require('mineflayer-pathfinder/lib/astar')
  const Move = require('mineflayer-pathfinder/lib/move')
  const blockAt = f.bot.blockAt
  if (corridor) f.bot.blockAt = p => {
    if (p.y === 63 && p.z !== 0) {
      const b = Block.fromStateId(registry.blocksByName.air.defaultState); b.position = p.floored(); return b
    }
    return blockAt(p)
  }
  const paths = [], budgets = []
  f.bot.pathfinder.thinkTimeout = 5000
  const originalGoal = f.bot.pathfinder.setGoal
  f.bot.pathfinder.setGoal = function(goal) {
    originalGoal.call(this, goal)
    if (!goal) return
    budgets.push(this.thinkTimeout)
    setImmediate(() => {
      if (this.goal !== goal) return
      const at = f.bot.entity.position.floored()
      const search = new AStar(new Move(at.x, at.y, at.z, 0, 0), this.movements, goal, this.thinkTimeout, 20)
      const step = () => {
        if (this.goal !== goal) return
        const r = search.compute()
        if (r.status === 'partial') { setImmediate(step); return }
        paths.push(r)
        f.bot.emit('path_update', r)
        if (r.status === 'success' && this.goal === goal) {
          for (const n of r.path) { f.bot.entity.position = new Vec3(n.x + .5, n.y, n.z + .5); f.bot.emit('physicsTick') }
          if (this.goal === goal) f.bot.emit('goal_reached', goal)
        }
      }
      step()
    })
  }
  return { paths, budgets }
}

test('avoid: withinArena excludes spheres, accepts the surface/zero radius and rejects malformed input without throwing', () => {
  const bot: any = { physics: { playerHalfWidth: .3 } }
  const a = { x: .5, z: .5, r: 30, killY: 60, minY: 64, avoid: [{ x: 5.5, y: 64, z: .5, r: 2 }] }
  assert.equal(parkour.withinArena(bot, { x: 5.5, y: 64, z: .5 }, a), false)
  assert.equal(parkour.withinArena(bot, { x: 3.5, y: 64, z: .5 }, a), true)
  assert.equal(parkour.withinArena(bot, { x: 5.5, y: 66, z: .5 }, a), true)
  assert.equal(parkour.withinArena(bot, { x: 0, y: 63.99, z: 0 }, a), false)
  for (const avoid of [null, {}, [null], [{ x: 0, y: 64, z: 0, r: NaN }], [{ x: 0, y: 64, z: 0, r: -1 }]] as any[])
    assert.equal(parkour.withinArena(bot, { x: 0, y: 64, z: 0 }, { ...a, avoid }), false)
  assert.equal(parkour.withinArena(bot, { x: 0, y: 64, z: 0 }, { ...a, avoid: [{ x: 0, y: 64, z: 0, r: 0 }] }), true)
})

test('avoid: an edge crossing the sphere is forbidden even when both endpoints are outside', () => {
  const a = { x: .5, z: .5, r: 30, avoid: [{ x: .5, y: 64, z: .5, r: 1 }] }
  const bot: any = { physics: { playerHalfWidth: .3 } }, from = { x: -1.5, y: 64, z: .5 }, to = { x: 2.5, y: 64, z: .5 }
  assert.equal(parkour.withinArena(bot, from, a), true)
  assert.equal(parkour.withinArena(bot, to, a), true)
  assert.equal(parkour.withinArena(bot, to, a, from), false)
})

test('avoid: goto A* detours around an enemy between safe endpoints', async t => {
  const f = fixture(t, 'search'), trace = avoidSearch(f)
  const foe = { x: 5.5, y: 64, z: .5, r: 2.5 }
  const run = await f.s.goto({ x: 10, y: 64, z: 0, range: .1, arena: { ...arena, r: 20, avoid: [foe] } })
  assert.ok(run.arrived)
  assert.equal(trace.paths[0].status, 'success')
  assert.ok(trace.paths[0].path.some(n => Math.abs(n.z) >= 3), 'A* must leave the direct lane')
  for (const n of trace.paths[0].path) assert.ok(Math.hypot(n.x + .5 - foe.x, n.y - foe.y, n.z + .5 - foe.z) >= foe.r - 1e-6)
  assert.equal(f.bot.pathfinder.thinkTimeout, 5000)
  assert.equal(f.s.gotoArena, undefined)
})

test('avoid: starting inside a zone, off cell centre, permits standing and a route away', async t => {
  const f = fixture(t, 'search'), trace = avoidSearch(f)
  f.bot.entity.position.x = .9
  const foe = { x: -3.5, y: 64, z: .5, r: 22 }, input = { ...arena, r: 30, avoid: [foe] }
  const run = f.s.goto({ x: 8, y: 64, z: 0, range: .1, arena: input })
  try {
    assert.equal(f.s.gotoArena.avoid[0].r, 4.4)
    assert.equal(parkour.withinArena(f.bot, f.bot.entity.position, f.s.gotoArena), true)
    assert.ok((await run).arrived)
    assert.ok(trace.paths[0].path.every(n => Math.hypot(n.x + .5 - foe.x, n.y - foe.y, n.z + .5 - foe.z) >= 4.4 - 1e-6))
    assert.equal(foe.r, 22, 'normalisation must not mutate the caller')
  } finally { f.s.ctl.abort(); await run.catch(() => {}) }
})

test('avoid: invalid input rejects before cancelling an existing action', async t => {
  for (const avoid of [null, {}, [null], [{ x: 4, y: 64, z: 0, r: '2' }], [{ x: 4, y: 64, z: 0, r: -1 }]]) {
    const f = fixture(t, 'wait'), old = f.bot.pathfinder.movements
    let error, run
    try { run = f.s.goto({ x: 2, y: 64, z: 0, arena: { ...arena, avoid } }) } catch (e) { error = e }
    if (run) { f.s.ctl.abort(); await run.catch(() => {}) }
    assert.equal(error?.code, 'ARENA_BOUNDARY')
    assert.equal(f.calls.starts, 0); assert.equal(f.calls.cancels, 0)
    assert.equal(f.bot.pathfinder.movements, old)
  }
})

test('avoid: the next native physical step cannot enter the enemy zone', async t => {
  const f = fixture(t, 'wait'), guarded = { ...arena, r: 20, avoid: [{ x: 2.5, y: 64, z: .5, r: 1.5 }] }
  const run = f.s.goto({ x: -3, y: 64, z: 0, arena: guarded })
  await new Promise(resolve => setImmediate(resolve))
  f.bot.entity.velocity.x = 1
  f.bot.emit('physicsTick')
  const stopped = f.bot.pathfinder.goal === null
  if (!stopped) f.s.ctl.abort()
  await assert.rejects(run)
  assert.equal(stopped, true)
  assert.ok(f.calls.cleared)
})

test('avoid: an impassable corridor fails once within the search budget without local jump/retry', async t => {
  const f = fixture(t, 'search'), trace = avoidSearch(f, true)
  const timer = setTimeout(() => f.s.ctl?.abort(), 1200)
  const started = performance.now()
  try {
    await assert.rejects(f.s.goto({ x: 10, y: 64, z: 0, range: .1, pathWait: true,
      arena: { ...arena, r: 20, avoid: [{ x: 5.5, y: 64, z: .5, r: 2.5 }] } }), (e: any) => e.code === 'AVOID_NO_PATH')
    assert.equal(trace.paths.length, 1)
    assert.ok(performance.now() - started < 1000)
    assert.equal(f.bot.pathfinder.goal, null)
    assert.equal(f.bot.pathfinder.thinkTimeout, 5000)
    assert.equal(f.bot.listenerCount('path_update'), 0)
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
  } finally { clearTimeout(timer); f.s.ctl?.abort() }
})

test('avoid: climb keeps the same excluded path cells while ordinary climb keeps its original arena', async t => {
  for (const avoid of [undefined, [{ x: 2.5, y: 64, z: .5, r: 1 }]]) {
    const f = fixture(t, 'wait'), a = { ...arena, r: 20, ...(avoid ? { avoid } : {}) }
    const run = f.s.goto({ x: -2, y: 64, z: 0, climb: true, exactY: true, arena: a })
    await new Promise(resolve => setImmediate(resolve))
    try {
      assert.equal(f.bot.pathfinder.movements.canDig, true)
      assert.equal(Number.isFinite(f.stepCost(new Vec3(2, 64, 0))), !avoid)
    } finally { f.s.ctl.abort(); await assert.rejects(run) }
  }
})

// cl28r (15×15, 28.10): бот сел на внешний гребень Колизея на волосок за границей арены — каждый goto боя давал noPath
// (visited 1: все соседи вне границ), 1032 раза у одного бота, «стоит 8–10 с — fight». Снаружи путь назад, внутрь, открыт; дальше наружу — нет.
test('a fighter standing just outside the arena may walk back in, never further out', async t => {
  const f = fixture(t, 'wait')
  f.bot.entity.position = new Vec3(4.6, 64, .5)
  assert.equal(parkour.withinArena(f.bot, f.bot.entity.position, arena), false, 'стоит за границей')
  const run = f.s.goto({ x: 1, y: 64, z: 0, arena, surface: false })
  await new Promise(resolve => setImmediate(resolve))
  f.bot.emit('physicsTick')
  assert.ok(Number.isFinite(f.stepCost(new Vec3(3, 64, 0))), 'внутрь — можно')
  assert.ok(Number.isFinite(f.stepCost(new Vec3(4, 64, 0))), 'своя клетка у края — можно')
  assert.equal(f.stepCost(new Vec3(6, 64, 0)), Infinity, 'дальше наружу — нет')
  const Move = require('mineflayer-pathfinder/lib/move')
  const neighbors = f.bot.pathfinder.movements.getNeighbors(new Move(4, 64, 0, 64, 0))
  assert.ok(neighbors.some(n => n.x === 3), 'шаг внутрь среди соседей')
  assert.ok(neighbors.every(n => n.x <= 4), 'наружу соседей нет')
  f.bot.entity.position = new Vec3(1.5, 64, .5); f.bot.emit('goal_reached', f.bot.pathfinder.goal)
  assert.ok((await run).arrived, 'поход не оборван проверкой границ на первом же тике')
})
