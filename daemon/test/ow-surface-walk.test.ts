import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { surfaceStepCost, priceSurfaceMoves, recoveryTarget, startSurfaceWalk, stopSurfaceWalk, surfaceDropGuard } from '../src/session/surface-walk'

function env(t, key, value) {
  const was = process.env[key]
  process.env[key] = value
  t.after(() => { if (was === undefined) delete process.env[key]; else process.env[key] = was })
}

function fixture(t) {
  env(t, 'ND_OW_SURFACE_WALK', '1')
  const bot: any = Object.assign(new EventEmitter(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(.5, 64, .5), onGround: true },
    // No registry: the only observation is the floor the body actually stands on.
    blockAt: p => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) })
  const scope = startSurfaceWalk(bot)
  t.after(() => stopSurfaceWalk(bot, scope))
  const cell = (x, y, z, level = null) => ({ position: new Vec3(x, y, z), name: level === null ? 'air' : 'water', getProperties: () => ({ level }) })
  return { bot, scope, cell }
}

test('surface cost is off by default and absent in Nether', t => {
  const f = fixture(t)
  env(t, 'ND_OW_SURFACE_WALK', '0')
  assert.equal(surfaceStepCost(f.bot, f.cell(1, 20, 0, 8)), 0)
  env(t, 'ND_OW_SURFACE_WALK', '1')
  f.bot.game.dimension = 'the_nether'
  assert.equal(surfaceStepCost(f.bot, f.cell(1, 20, 0, 8)), 0)
})

test('open sky ravine is expensive, natural slopes and remote valleys have no start-height floor', t => {
  const { bot, cell } = fixture(t)
  assert.equal(surfaceStepCost(bot, cell(1, 64, 0)), 0)
  assert.equal(surfaceStepCost(bot, cell(6, 58, 0)), 0)
  assert.ok(surfaceStepCost(bot, cell(2, 30, 0)) > 60)
  assert.equal(surfaceStepCost(bot, cell(30, 30, 0)), 0)
  assert.ok(Number.isFinite(surfaceStepCost(bot, cell(2, -60, 0))))
})

test('falling and descending water cost more than still water; no cost without observations', t => {
  const { bot, cell } = fixture(t)
  bot._ndOwSurfaceWalk.waterSeen.set('1,60,0', true)
  assert.ok(surfaceStepCost(bot, cell(1, 60, 0, 8)) > surfaceStepCost(bot, cell(1, 60, 0, 0)))
  assert.ok(surfaceStepCost(bot, cell(1, 60, 0, 3)) > surfaceStepCost(bot, cell(1, 60, 0)))
  delete bot._ndOwSurfaceWalk
  assert.equal(surfaceStepCost(bot, cell(1, 60, 0, 8)), 0)
})

test('hidden water flow does not affect the price of otherwise identical cells', t => {
  const { bot, cell } = fixture(t)
  bot._ndOwSurfaceWalk.waterSeen.set('1,60,0', false)
  assert.equal(surfaceStepCost(bot, cell(1, 60, 0, 8)), surfaceStepCost(bot, cell(1, 60, 0, 0)))
})

test('recovery retains a nearby observed rim after a fall, but not a distant mountain', t => {
  const { bot } = fixture(t)
  bot.entity.position = new Vec3(2.5, 42, .5)
  assert.deepEqual(recoveryTarget(bot), { x: 0, y: 64, z: 0 })
  bot.entity.position.x = 40
  assert.equal(recoveryTarget(bot), null)
})

test('a visible slope six blocks higher is no reason to pillar from a normal valley', t => {
  const { bot, cell } = fixture(t)
  bot._ndOwSurfaceWalk.samples = [{ x: 6, y: 70, z: 0 }]
  assert.equal(surfaceStepCost(bot, cell(0, 64, 0)), 0)
  assert.equal(recoveryTarget(bot), null)
})

test('drop guard signals before the path completes and removes its listener', async t => {
  const { bot } = fixture(t)
  env(t, 'ND_OW_SURFACE_RECOVER', '1')
  const before = bot.listenerCount('physicsTick')
  const guard = surfaceDropGuard(bot)
  const caught = assert.rejects(guard.promise, (e: any) => e.surfaceDrop === true)
  bot.entity.position.y = 56
  bot.emit('physicsTick')
  await caught
  guard.stop()
  assert.equal(bot.listenerCount('physicsTick'), before)
})

test('surface scopes restore prior context and stop observing on finish', t => {
  const { bot, scope } = fixture(t)
  const nested = startSurfaceWalk(bot)
  stopSurfaceWalk(bot, nested)
  assert.equal(bot._ndOwSurfaceWalk, scope.context)
  stopSurfaceWalk(bot, scope)
  assert.equal(bot._ndOwSurfaceWalk, undefined)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('a move costing over 100 remains a native pathfinder neighbor', t => {
  const { bot } = fixture(t)
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const { Movements } = require('mineflayer-pathfinder')
  const Move = require('mineflayer-pathfinder/lib/move')
  Object.assign(bot, { registry, entities: {}, inventory: { items: () => [] },
    pathfinder: { bestHarvestTool: () => null }, blockAt: p => {
      const b = Block.fromStateId(registry.blocksByName[p.y < 20 ? 'stone' : 'air'].defaultState)
      b.position = p.floored(); return b
    } })
  const mv = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = false
  const from = new Move(0, 20, 0, 0, 0)
  const before = mv.getNeighbors(from).map(n => [n.x, n.y, n.z])
  priceSurfaceMoves(bot, mv)
  const after = mv.getNeighbors(from)
  assert.deepEqual(after.map(n => [n.x, n.y, n.z]), before)
  assert.ok(after.some(n => n.cost > 100 && Number.isFinite(n.cost)))
})
