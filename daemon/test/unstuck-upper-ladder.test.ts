import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { Session } from '../src/session'
import * as gameClock from '../src/game-clock'
import { RUNGS } from '../src/unstuck/rungs'
import * as tick from './tick-plugins-fixture'

// From the clear floor at Y132 the target is one block away in XZ and 21 up.
// The roof has an opening at x5 and the ladder is attached to its south wall.
function gallery(t, ladder: boolean) {
  t.mock.method(require('../src/edges/mlg'), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(require('../src/blockmoves'), 'on', () => false)
  const clock = tick.testClock(), game = new gameClock.GameClock({ manual: true, epoch: clock.now() })
  gameClock.activate(game)
  const bot = tick.install(clock, { pathfinder: true }), cells = new Map()
  bot.blockAt = p => {
    const q = p.floored(), key = q.toString()
    if (!cells.has(key)) {
      const floor = q.x >= -2 && q.x <= 7 && q.z >= -2 && q.z <= 2
      const column = q.x === 5 && q.z === 0
      const solid = floor && (q.y === 131 || q.y === 152 && !column) || q.x === 5 && q.z === 1 && q.y >= 132 && q.y < 153
      cells.set(key, tick.block(solid ? 'bedrock' : column && ladder && q.y >= 132 && q.y < 153 ? 'ladder' : 'air', q))
    }
    return cells.get(key)
  }
  bot.entity.position = new Vec3(.5, 132, .5)
  bot.entity.velocity = new Vec3(0, -.0784, 0)
  bot.entity.attributes = { [bot.physics.movementSpeedAttribute]: { value: .1, modifiers: [] } }
  bot.entity.metadata = []; bot.health = bot.food = 20; bot.game.dimension = 'overworld'
  const entries: any[] = []
  bot.on('nd_parkour', sample => entries.push(sample))
  const session: any = Object.assign(Object.create(Session.prototype), {
    bot, mcData: tick.data, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_name, worker) => {
      const ctl = session.ctl = { aborted: false, onAbort: [], abort() {
        if (this.aborted) return
        this.aborted = true
        for (const fn of [...this.onAbort]) fn()
      } }
      try { return await worker(ctl) } finally { ctl.abort() }
    }
  })
  session.updateMovements(true)
  t.after(() => { session.ctl?.abort(); bot.emit('end'); game.dispose(); gameClock.activate(null) })
  const arena = { x: .5, z: .5, r: 18, killY: 124 }
  const advance = async () => { game.advanceTicks(1); await clock.advanceGame(50) }
  async function goto(x, y) {
    for (let i = 0; i < 4; i++) await advance()
    let settled = false, result, error
    const reply = session.goto({ x, y, z: .5, range: 1, timeoutSeconds: 35, sprint: false, sprintJump: false,
      bridge: false, pathWait: true, pearl: false, descent: false, unstuck: true, surface: false, climb: true, exactY: true, arena })
    reply.then(value => { result = value; settled = true }, e => { error = e; settled = true })
    for (let i = 0; i < 740 && !settled; i++) await advance()
    assert.ok(settled, 'the bounded native route must settle')
    return { result, error }
  }
  return { bot, session, goto, arena, entries, advance }
}

test('exactY recovers at a visible side ladder and reaches the upper gallery through native movement', async t => {
  const f = gallery(t, true)
  let climbed = false
  f.bot.on('physicsTick', () => {
    const p = f.bot.entity.position
    if (p.y > 135 && p.y < 150 && f.bot.blockAt(p).name === 'ladder') climbed = true
  })
  const { result, error } = await f.goto(1.5, 153)
  assert.ifError(error)
  assert.ok(climbed, 'the body must ascend the ladder column')
  assert.equal(result.arrivedY, 153)
})

test('waypoint walks from the stalled approach into the visible ladder on native physics ticks', async t => {
  const f = gallery(t, true)
  f.bot.entity.position = new Vec3(4.46, 132, .5)
  f.session.gotoArena = f.arena
  const goal = new Vec3(1, 153, 0)
  const entry = RUNGS.waypoint({ bot: f.bot, session: f.session, ctl: { aborted: false }, goal, toward: goal,
    deadline: gameClock.now() + 600 })
  for (let i = 0; i < 12; i++) await f.advance()
  assert.ok((await Promise.race([entry, Promise.resolve(null)]))?.applied, 'enter within the twelve-tick budget')
  assert.ok(f.entries.length > 0 && f.entries.length <= 12)
  assert.ok(f.entries.every(step => step.onGround && step.pos.y === 132 && !step.control.jump && step.hp === 20))
  assert.equal(Math.floor(f.entries[f.entries.length - 1].pos.x), 5)
})

test('a roof with no climbing column stays unreachable and a horizontal walk uses the original route', async t => {
  const f = gallery(t, false)
  assert.ok((await f.goto(1.5, 153)).error)
  assert.equal(f.entries.length, 0)
  f.bot.entity.position = new Vec3(.5, 132, .5)
  const { result, error } = await f.goto(4.5, 132)
  assert.ifError(error)
  assert.equal(result.arrivedY, 132)
  assert.equal(f.entries.length, 0)
})

test('the short ladder entry rejects an expired budget and an approach crossing a forbidden area', async t => {
  const f = gallery(t, true), { bot, session } = f
  bot.entity.position = new Vec3(4.45, 132, .5)
  const goal = new Vec3(1, 153, 0), ctx = { bot, session, ctl: { aborted: false }, goal, toward: goal, now: () => 1000, deadline: 1000 }
  assert.equal((await RUNGS.waypoint(ctx)).applied, false)
  ctx.deadline += 10000
  session.gotoArena = { ...f.arena, avoid: [{ x: 5.2, y: 132, z: .5, r: .5 }] }
  assert.equal((await RUNGS.waypoint(ctx)).applied, false)
  assert.equal(f.entries.length, 0)
})

test('a distant intermediate walking goal releases the pathfinder when the parent route runs out of time', async t => {
  const game = new gameClock.GameClock({ manual: true, epoch: 1000 })
  gameClock.activate(game)
  t.after(() => { game.dispose(); gameClock.activate(null) })
  const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(.5, 132, .5) } })
  const changes = []
  bot.pathfinder = { setGoal(goal) { this.goal = goal; changes.push(goal); bot.emit('goal_updated', goal) } }
  let result
  const follow = RUNGS.waypoint({ bot, toward: new Vec3(40, 132, .5), deadline: gameClock.now() + 9000 })
    .then(r => { result = r })
  assert.equal(changes.length, 1)
  game.advanceTicks(179)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(bot.pathfinder.goal)
  game.advanceTicks(1)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(result?.applied, false)
  assert.deepEqual(changes.slice(1), [null])
  await follow
})

for (const slice of [4, 13]) test(`a completed ladder route replaces a walkable dead-end prefix with ${slice} A* nodes per slice`, async t => {
  const previous = process.env.ND_ASTAR_SLICE_NODES
  process.env.ND_ASTAR_SLICE_NODES = String(slice)
  t.after(() => {
    if (previous === undefined) delete process.env.ND_ASTAR_SLICE_NODES
    else process.env.ND_ASTAR_SLICE_NODES = previous
  })
  const f = gallery(t, true)
  let partials = 0, climbed = false
  f.bot.on('path_update', r => { if (r.status === 'partial' && r.path.length) partials++ })
  f.bot.on('physicsTick', () => {
    const p = f.bot.entity.position
    if (p.y > 135 && p.y < 150 && f.bot.blockAt(p).name === 'ladder') climbed = true
  })
  const { result, error } = await f.goto(1.5, 153)
  assert.ifError(error)
  assert.ok(partials > 0 && climbed)
  assert.equal(result.arrivedY, 153)
})
