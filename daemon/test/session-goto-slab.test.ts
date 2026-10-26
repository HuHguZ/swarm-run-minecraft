'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
import * as tick from './tick-plugins-fixture'

// External server/clock only. Session.goto, installed pathfinder, shapes and physics are real.
function fixture(t, surface = 'smooth_sandstone_slab', y = 63.5, physicsEnabled = true) {
  t.mock.method(require('../src/edges/mlg'), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(require('../src/blockmoves'), 'on', () => false)
  const clock = tick.testClock(), bot = tick.install(clock, { pathfinder: true, physicsEnabled })
  bot.blockAt = p => tick.block(p.floored().y === 63 && p.x >= -2 && p.x <= 10 && p.z >= -2 && p.z <= 2 ? surface : 'air', p)
  bot.entity.position = new Vec3(.5, y, .5); bot.entity.onGround = true
  bot.health = bot.food = 20; bot.game.dimension = 'overworld'; bot.entity.metadata = []
  const session: any = Object.assign(Object.create(Session.prototype), {
    bot, mcData: tick.data, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_name, worker) => {
      const ctl = session.ctl = { aborted: false, onAbort: [] as Array<() => void>,
        abort() { if (this.aborted) return; this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
      try { return await worker(ctl) } finally { ctl.abort() }
    }
  })
  session.updateMovements(true)
  const paths: any[] = [], goals: any[] = []
  bot.on('path_update', p => paths.push(p))
  bot.on('goal_updated', g => { if (g) goals.push(g) })
  const params = { x: 4.5, y, z: .5, range: .8, timeoutSeconds: 15, sprint: false, sprintJump: false,
    bridge: false, pathWait: true, pearl: false, descent: false, unstuck: false, surface: false,
    arena: { x: 4.5, z: .5, r: 20, killY: 60 } }
  async function drive(promise) {
    let settled = false, value, error
    promise.then(v => { value = v; settled = true }, e => { error = e; settled = true })
    for (let i = 0; i < 320 && !settled; i++) await clock.advanceGame(50)
    if (!settled) { session.ctl?.abort(); throw Error('fixture did not settle within 320 native ticks') }
    if (error) throw error
    return value
  }
  return { session, bot, clock, params, paths, goals, drive, close: () => bot.emit('end') }
}

test('Session.goto reaches the requested lower-slab support with range .8 through native pathfinding and physics', async t => {
  const f = fixture(t)
  try {
    const result = await f.drive(f.session.goto(f.params))
    assert.ok(result.arrived, JSON.stringify(result))
    assert.ok(f.paths.some(p => p.status === 'success'))
    assert.ok(Math.abs(f.bot.entity.position.y - 63.5) < 1e-6)
    assert.ok(Math.abs(f.bot.entity.position.x - 4.5) < .8)
    assert.equal(f.bot._ndSprintJump?.jumps || 0, 0)
  } finally { f.close() }
})

for (const [surface, y] of [['stone', 64], ['smooth_sandstone_stairs', 64], ['white_carpet', 63.0625]] as const) {
  test(`Session.goto preserves native physical arrival on ${surface}`, async t => {
    const f = fixture(t, surface, y)
    try {
      const result = await f.drive(f.session.goto(f.params))
      assert.ok(result.arrived, JSON.stringify(result))
      assert.ok(f.paths.some(p => p.status === 'success'))
      assert.ok(Math.abs(f.bot.entity.position.y - y) < 1e-6)
      assert.ok(Math.abs(f.bot.entity.position.x - 4.5) < .8)
    } finally { f.close() }
  })
}

for (const [surface, y, nodeY] of [['smooth_sandstone_slab', 63.5, 64], ['oak_fence', 64.5, 64]] as const) {
  test(`Session.goto already at ${surface} accepts its native root without a needless route`, async t => {
    const f = fixture(t, surface, y)
    try {
      f.params.x = .5
      const result = await f.drive(f.session.goto(f.params))
      assert.ok(result.arrived, JSON.stringify(result))
      assert.equal(f.goals[0].y, nodeY)
      assert.ok(Math.abs(f.bot.entity.position.x - .5) < 1e-6)
      assert.ok(Math.abs(f.bot.entity.position.y - y) < 1e-6)
    } finally { f.close() }
  })
}

test('Session.goto survives native partial-node postprocessing on lower slabs and retains its goal predicate owner', async t => {
  const before = process.env.ND_ASTAR_SLICE_NODES
  process.env.ND_ASTAR_SLICE_NODES = '1'
  const f = fixture(t)
  try {
    const result = await f.drive(f.session.goto(f.params))
    assert.ok(result.arrived, JSON.stringify(result))
    assert.ok(f.paths.some(p => p.status === 'partial' && p.path.some(n => n.y === 63.5)))
    assert.ok(f.paths.some(p => p.status === 'success'))
    const goal = f.goals[0]
    assert.equal(Object.hasOwn(goal, 'isEnd'), true)
    assert.equal(goal.isEnd(new Vec3(4, 64, 0)), true)
    assert.equal(goal.isEnd(new Vec3(4.5, 63.5, .5)), true)
    assert.equal(goal.isEnd(new Vec3(4, 62, 0)), false)
    assert.ok(Math.abs(f.bot.entity.position.y - 63.5) < 1e-6)
  } finally { f.close(); if (before === undefined) delete process.env.ND_ASTAR_SLICE_NODES; else process.env.ND_ASTAR_SLICE_NODES = before }
})

for (const [correctedY, grounded] of [[63.1, false], [64.5, false], [62.5, true]] as const) {
  test(`Session.goto rejects a stale goal_reached after a server correction to Y${correctedY}`, async t => {
    const f = fixture(t)
    // Keep a refusal a refusal: the local parkour fallback must not recover the
    // deliberately frozen server correction while testing the arrival boundary.
    t.mock.method(require('../src/navigation/parkour/execute'), 'executeJump', async () => ({ ok: false }))
    let corrected = false
    f.bot.prependOnceListener('goal_reached', () => {
      corrected = true; f.bot.physicsEnabled = false
      f.bot._client.emit('position', { x: 4.5, y: correctedY, z: .5, yaw: 0, pitch: 0, flags: {}, teleportId: 2 })
      f.bot.entity.onGround = grounded
    })
    try {
      let result: any
      const running = f.session.goto(f.params)
      running.then(value => { result = value }, () => {})
      for (let i = 0; i < 80 && !corrected; i++) await f.clock.advanceGame(50)
      assert.equal(corrected, true, 'the actual native path must first reach its target')
      for (let i = 0; i < 5; i++) await f.clock.advanceGame(50)
      assert.equal(result?.arrived, undefined, 'a stale native goal event cannot attest the corrected body')
      assert.equal(f.bot.entity.position.y, correctedY)
      // A frozen corrected server may keep the retry pending; finish this caller
      // explicitly rather than mislabelling its fixture deadline as a refusal.
      f.session.ctl.abort()
      await running.catch(() => {})
    } finally { f.close() }
  })
}

for (const replacePredicate of [false, true]) {
  test(`Session.goto abort ${replacePredicate ? 'preserves a newer predicate owner' : 'restores its own fractional predicate'}`, async t => {
    const before = process.env.ND_ASTAR_SLICE_NODES
    process.env.ND_ASTAR_SLICE_NODES = '1'
    const f = fixture(t)
    try {
      const running = f.session.goto(f.params)
      const rejected = assert.rejects(running)
      await f.clock.advanceGame(50)
      const goal = f.goals[0], temporary = goal.isEnd, replacement = () => false
      if (replacePredicate) goal.isEnd = replacement
      f.session.ctl.abort()
      await rejected
      assert.equal(Object.hasOwn(goal, 'isEnd'), true)
      if (replacePredicate) assert.equal(goal.isEnd, replacement)
      else {
        assert.notEqual(goal.isEnd, temporary)
        assert.equal(goal.isEnd(new Vec3(4, 64, 0)), true)
        assert.equal(goal.isEnd(new Vec3(4.5, 63.5, .5)), true)
        assert.equal(goal.isEnd(new Vec3(4, 62, 0)), false)
      }
      assert.equal(f.session.gotoArena, undefined)
      assert.equal(f.session.pathGoalY, null)
    } finally { f.close(); if (before === undefined) delete process.env.ND_ASTAR_SLICE_NODES; else process.env.ND_ASTAR_SLICE_NODES = before }
  })
}
