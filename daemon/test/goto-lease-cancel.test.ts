import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const filename = path.resolve(__dirname, '../src/session.ts'), local = createRequire(filename), sourceModule = { exports: {} as any }
vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap((require('esbuild') as typeof import('esbuild')).transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code), { filename })(sourceModule.exports, local, sourceModule, filename, path.dirname(filename))
const { Session } = sourceModule.exports
import reflex = require('../src/reflex-lock')
import * as clock from '../src/game-clock'
import '../src/navigation/parkour'
import * as parkour from '../src/navigation/parkour'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
const arena = { x: .5, z: .5, r: 6, killY: 60 }
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const timers = new Set<any>(), goals = [], controls: Record<string, boolean> = {}, runs = []
  t.mock.method(clock, 'now', () => 100000)
  t.mock.method(clock, 'setTimeout', fn => { const timer = { fn }; timers.add(timer); return timer })
  t.mock.method(clock, 'setInterval', fn => { const timer = { fn, interval: true }; timers.add(timer); return timer })
  t.mock.method(clock, 'clearTimeout', timer => timers.delete(timer))
  t.mock.method(clock, 'clearInterval', timer => timers.delete(timer))
  t.mock.method((require('../src/edges/mlg') as typeof import('../src/edges/mlg')), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method((require('../src/blockmoves') as typeof import('../src/blockmoves')), 'on', () => false)
  const world = { getBlock(p) {
    const cell = p.floored(), b = Block.fromStateId(registry.blocksByName[cell.y === 63 ? 'stone' : 'air'].defaultState)
    b.position = cell; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, health: 20, food: 20,
    entities: {}, game: { dimension: 'overworld', minY: -64, height: 384 }, inventory: { slots: Array(46).fill(null), items: () => [] },
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, -.0784, 0), onGround: true,
      yaw: 0, pitch: 0, effects: {}, metadata: [], attributes: {} },
    controlState: controls, blockAt: p => world.getBlock(p), physics: native.Physics(registry, world),
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false },
    setControlState(key, value) { controls[key] = value }
  })
  bot.pathfinder = { movements: null, goal: null, isMoving: () => false, isMining: () => false, isBuilding: () => false,
    setMovements(m) { this.movements = m },
    setGoal(g) { goals.push(g); this.goal = g; bot.emit('goal_updated', g); bot.emit('path_reset', 'goal_updated') } }
  const s: any = Object.assign(Object.create(Session.prototype), { bot, mcData: registry, require: () => bot,
    underSky: () => true, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_name, worker) => {
      const ctl = s.ctl = { aborted: false, onAbort: [] as Array<() => void>, abort() {
        if (this.aborted) return; this.aborted = true; for (const fn of [...this.onAbort]) fn()
      } }
      try { return await worker(ctl) } finally { ctl.abort() }
    } })
  let release
  const start = async () => {
    const run = s.goto({ x: 2, y: 64, z: 0, arena, timeoutSeconds: 5, pathWait: true }); runs.push(run)
    // Retain rejected workers so a failed RED assertion does not create an unhandled test rejection.
    run.catch(() => {})
    await turn()
    const goal = bot.pathfinder.goal
    const lease = reflex.start(s, () => new Promise(resolve => { release = resolve }), { owner: 'Emergency', source: 'fixture-fall', priority: 3 })
    await turn()
    assert.equal(bot.pathfinder.goal, null, 'the actual Emergency takeover suspended the old path')
    return { run, goal, lease }
  }
  const releaseLease = async () => { release?.(); await turn(); await turn() }
  const fireTimers = () => {
    for (const timer of [...timers]) if (!timer.interval) { timers.delete(timer); timer.fn() }
  }
  const clean = () => {
    for (const event of ['path_update', 'goal_updated', 'goal_reached', 'path_reset', 'physicsTick']) assert.equal(bot.listenerCount(event), 0, `${event} released`)
    assert.equal(timers.size, 0, 'no old guard or resume timer remains')
  }
  t.after(async () => { bot.emit('end'); await releaseLease(); fireTimers(); await Promise.allSettled(runs) })
  return { s, bot, goals, controls, timers, start, releaseLease, fireTimers, clean }
}

test('cancelling Session.goto during an actual Emergency lease releases its waiter before the defence ends', async t => {
  const f = fixture(t), old = await f.start()
  let settled = false
  old.run.finally(() => { settled = true }).catch(() => {})
  f.s.ctl.abort()
  await turn(); await turn()
  assert.equal(settled, true, 'the cancelled worker must not wait for or resume from the Emergency')
  f.clean()
  await f.releaseLease(); f.fireTimers(); await turn()
  assert.equal(f.bot.pathfinder.goal, null, 'the cancelled goal is not resurrected after release')
})

test('a failed arena forecast releases the paused goto before another intent takes the body', async t => {
  const f = fixture(t), old = await f.start()
  f.bot.entity.velocity.x = 10
  const before = f.bot.entity.position.clone()
  f.bot.emit('physicsTick')
  await assert.rejects(old.run, (error: any) => error.code === 'ARENA_BOUNDARY')
  assert.deepEqual(f.bot.entity.position, before, 'the native forecast does not move the real body')
  f.clean()
  await f.releaseLease()
  const replacement = { isEnd: () => false, replacement: true }
  f.bot.pathfinder.setGoal(replacement); f.bot.setControlState('back', true)
  f.fireTimers(); await turn()
  assert.equal(f.bot.pathfinder.goal, replacement)
  assert.equal(f.controls.back, true, 'no old continuation clears replacement intent controls')
  assert.equal(f.goals.filter(g => g === old.goal).length, 1, 'only the initial old goal was ever installed')
})

test('an uninterrupted Emergency lease still hands back the original goto and permits honest arrival', async t => {
  const f = fixture(t), old = await f.start()
  await f.releaseLease(); f.fireTimers(); await turn()
  assert.equal(f.bot.pathfinder.goal, old.goal)
  f.bot.entity.position = new Vec3(2.5, 64, .5)
  f.bot.emit('goal_reached', old.goal)
  assert.ok((await old.run).arrived)
  f.clean()
})
