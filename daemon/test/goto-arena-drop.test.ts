import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { worldOf, native, registry } from './parkour-fixture'
import * as clock from '../src/game-clock'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')

const file = path.resolve(__dirname, '../src/session.ts'), local = createRequire(file), source = { exports: {} as any }
vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap((require('esbuild') as typeof import('esbuild')).transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code), { filename: file })(source.exports, local, source, file, path.dirname(file))

// V-j's isolated cobblestone: immediate landings are 11.5 below, a diagonal slab is 8.5 below.
async function stranded(mode: 'drop' | 'walk' | 'disabled' | 'low' | 'lava' | 'abort' | 'xz' | 'expired') {
  const cells: any[] = [[0, 161, 0, 'cobblestone']]
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    const high = x >= 2 && z >= 2
    cells.push([x, high ? 153 : 150, z, mode === 'lava' ? 'lava' : 'smooth_sandstone_slab', mode === 'lava' ? undefined : { type: 'bottom', waterlogged: false }])
  }
  const { bot, world } = worldOf(cells), game = new clock.GameClock({ manual: true, epoch: 100000 })
  clock.activate(game)
  bot.entity.position = new Vec3(.8183214831841, 162, .6126661470262)
  bot.entity.velocity = new Vec3(0, -.0784, 0); bot.entity.type = 'player'; bot.entity.eyeHeight = 1.62; bot.entity.metadata = []
  bot.game.dimension = 'overworld'; bot.entities = {}; bot.players = {}; bot.supportFeature = () => false
  bot.health = mode === 'low' ? 4 : 20
  bot.inventory.slots[6] = { name: 'elytra', slot: 6, durabilityUsed: 0, maxDurability: 432 }
  bot.inventory.slots[36] = { name: 'diamond_spear', count: 3, slot: 36 }
  bot.inventory.slots[45] = { name: 'firework_rocket', count: 3, slot: 45 }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.heldItem = bot.inventory.slots[36]
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.controlState = controls; bot.getControlState = key => controls[key]
  bot.setControlState = (key, value) => { controls[key] = value }
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) controls[key] = false }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const searches: any[] = []
  bot.pathfinder = { goal: null, movements: null, thinkTimeout: 5000,
    setMovements(m) { this.movements = m }, isMoving: () => false, isMining: () => false, isBuilding: () => false,
    setGoal(g) {
      this.goal = g; bot.emit('goal_updated', g); bot.emit('path_reset', 'goal_updated')
      if (!g) return
      setImmediate(() => {
        if (this.goal !== g) return
        const p = bot.entity.position.floored()
        const search = new AStar(new Move(p.x, p.y, p.z, 0, 0), this.movements, g, 5000, 40)
        let r; do { r = search.compute() } while (r.status === 'partial')
        searches.push({ status: r.status, visited: r.visitedNodes, cap: this.movements.maxDropDown })
        if (mode === 'expired') game.advanceTicks(210)
        bot.emit('path_update', r)
      })
    } }
  const s: any = Object.assign(Object.create(source.exports.Session.prototype), {
    bot, mcData: registry, require: () => bot, underSky: () => true, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_name, fn) => {
      const ctl = s.ctl = { aborted: false, onAbort: [], abort() { if (this.aborted) return; this.aborted = true; for (const callback of [...this.onAbort]) callback() } }
      try { return await fn(ctl) } finally { ctl.abort() }
    }
  })
  const arena = { x: 0, y: 120, z: 0, r: 20, killY: 110 }
  let settled = false, reply: any, error: any, lowest = 162, fall = 0, contact: number | null = null
  const run = s.goto({ x: -15, ...(mode === 'xz' ? {} : { y: 125 }), z: -15, range: 2, timeoutSeconds: 10, arena, climb: true, pathWait: true, unstuck: false,
    ...(mode === 'walk' ? { walkOnly: true } : {}), ...(mode === 'disabled' ? { descent: false } : {}) })
    .then(r => { reply = r; settled = true }, e => { error = e; settled = true })
  try {
    for (let tick = 0; tick < 500 && !settled; tick++) {
      const oldY = bot.entity.position.y, st = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(st, world); st.apply(bot)
      lowest = Math.min(lowest, st.pos.y); fall += Math.max(0, oldY - st.pos.y)
      if (st.onGround && st.pos.y < 160 && contact === null) {
        contact = (require('../src/navigation/landing') as typeof import('../src/navigation/landing')).landingDamage(world.getBlock(st.pos.offset(0, -.01, 0)), fall, bot.entity.attributes)
        bot.health -= contact
      }
      game.advanceTicks(1); bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
      if (mode === 'abort' && lowest < 161 && !s.ctl.aborted) s.ctl.abort()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (!settled) { s.ctl.abort(); await new Promise<void>(resolve => setImmediate(resolve)) }
    await run
    assert.equal(searches[0].status, 'noPath'); assert.equal(searches[0].visited, 1)
    assert.ok(searches.length <= 3, `a local descent cannot retry the same failed goto indefinitely: ${JSON.stringify(searches)}`)
    assert.equal(reply?.arrived, undefined, 'safe local progress does not claim the distant goal was reached')
    assert.equal(bot.inventory.slots[45].count, 3, 'the rescue rocket reserve stays intact')
    if (mode === 'drop') {
      assert.equal(searches[0].cap, 9, 'ordinary native movement keeps its real health-based drop cap')
      assert.ok(lowest < 160, 'failed native path hands off to the existing safe-drop controller')
      assert.ok(contact !== null && contact <= 5); assert.ok(bot.health >= 15)
    } else if (mode === 'abort') {
      assert.ok(lowest < 161, 'the actual drop started before cancellation')
      assert.ok(error); assert.ok(Object.values(controls).every(v => !v))
    } else assert.equal(lowest, 162, 'walk-only, disabled descent and unaffordable/hazardous landings stay guarded')
    bot.emit('end')
    for (const event of ['path_update', 'goal_updated', 'goal_reached', 'path_reset', 'physicsTick']) assert.equal(bot.listenerCount(event), 0, `${event} released`)
  } finally { game.dispose(); clock.activate(null) }
}

for (const mode of ['drop', 'walk', 'disabled', 'low', 'lava', 'abort', 'xz', 'expired'] as const) test(`stranded arena goto: ${mode}`, () => stranded(mode))
