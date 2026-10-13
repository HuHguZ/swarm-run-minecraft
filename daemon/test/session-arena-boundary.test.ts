import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()
const parkour = require('../src/navigation/parkour')
const arena = { x: .5, z: .5, r: 5, killY: 60 }

function fixture(t, mode = 'arrive') {
  t.mock.method(require('../src/edges'), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(require('../src/blockmoves'), 'on', () => false)
  const file = path.resolve(__dirname, '../src/session.ts'), local = createRequire(file), module = { exports: {} as any }
  const code = require('esbuild').transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports, local, module, file, path.dirname(file))
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
