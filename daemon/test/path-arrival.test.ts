'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')
import { goals } from 'mineflayer-pathfinder'
import { gotoGoal } from '../src/movement'

for (const [startZ, targetZ] of [[0, 4], [-5, -1]]) test(`progressive native AStar agrees with the physical final block at Z${targetZ}`, async () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(.5, 64, startZ + .5) }
  const goal = new goals.GoalNear(0, 64, targetZ, .8)
  let terminal
  let partials = 0
  bot.pathfinder = {
    isMoving: () => true,
    setGoal (g) {
      assert.equal(g, goal, 'reflex and waypoint continuations keep the same goal object')
      let search
      const movements = { getNeighbors (n) {
        search.tickTimeout = -1 // yield after each expansion, without waiting on wall time
        return [new Move(n.x, n.y, n.z + 1, 0, 1)]
      } }
      search = new AStar(new Move(0, 64, startZ, 0, 0), movements, g, 5000)
      let r
      for (let i = 0; i < 8; i++) {
        search.tickTimeout = Infinity
        r = search.compute()
        // Native index.js postProcessPath renders the SAME search nodes at block centres.
        for (const n of r.path) { n.x = Math.floor(n.x) + .5; n.z = Math.floor(n.z) + .5 }
        bot.emit('path_update', r)
        if (r.status !== 'partial') break
        partials++
      }
      assert.equal(r.status, 'success')
      terminal = r.path.at(-1)
      assert.equal(goal.isEnd(terminal.floored()), true, 'the search must finish in a block accepted by the executor')
      bot.entity.position = terminal.clone()
      setImmediate(() => bot.emit('goal_reached', g))
    }
  }
  await gotoGoal(bot, goal)
  assert.ok(partials >= 3)
  assert.equal(Math.floor(terminal.z), targetZ)
  assert.equal(goal.isEnd(new Vec3(.5, 64, targetZ - .5) as any), true, 'the caller goal is not modified')
  assert.equal(Object.hasOwn(goal, 'isEnd'), false)
  for (const name of ['path_update', 'goal_updated', 'physicsTick', 'goal_reached']) assert.equal(bot.listenerCount(name), 0)
})

for (const exit of ['cancel', 'death', 'end']) test(`gotoGoal restores an own goal predicate after ${exit}`, async () => {
  const bot: any = new EventEmitter()
  bot.pathfinder = { setGoal () {}, isMoving: () => false }
  const original = n => n.z === 1
  const goal = { isEnd: original }
  const p = gotoGoal(bot, goal)
  assert.notEqual(goal.isEnd, original)
  const rejected = assert.rejects(p, exit === 'cancel' ? /caller finished/ : /посреди пути/)
  if (exit === 'cancel') p.cancel()
  else bot.emit(exit)
  await rejected
  assert.equal(goal.isEnd, original)
  assert.equal(Object.hasOwn(goal, 'isEnd'), true)
  for (const name of ['end', 'death', 'path_update', 'goal_updated', 'physicsTick', 'goal_reached']) assert.equal(bot.listenerCount(name), 0)
})
