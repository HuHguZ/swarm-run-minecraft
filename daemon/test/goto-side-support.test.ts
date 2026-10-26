import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
import * as gameClock from '../src/game-clock'
import * as tick from './tick-plugins-fixture'

type Mode = 'side' | 'centred' | 'cube' | 'airborne' | 'unknown' | 'void' | 'hazard'

// Real Session, installed pathfinder, collision shapes and native physics; only the server clock is external.
function fixture(t, mode: Mode = 'side') {
  t.mock.method(require('../src/edges/mlg'), 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(require('../src/blockmoves'), 'on', () => false)
  const clock = tick.testClock(), game = new gameClock.GameClock({ manual: true, epoch: clock.now() })
  gameClock.activate(game)
  const bot = tick.install(clock, { pathfinder: true })
  const y = mode === 'cube' ? 151 : mode === 'hazard' ? 150.4375 : 150.5
  bot.blockAt = p => {
    const q = p.floored()
    if (mode === 'unknown' && q.x === 533 && q.y === 150 && q.z === 609) return null
    const floor = q.y === 150 && q.x >= 522 && q.x <= 532 && q.z >= 608 && q.z <= 610
    return tick.block(floor && mode !== 'void' ? mode === 'hazard' ? 'campfire' : mode === 'cube' ? 'stone' : 'smooth_sandstone_slab' : 'air', q)
  }
  bot.entity.position = new Vec3(mode === 'centred' ? 532.5 : 533.2591661231949, y, 609.3093884351136)
  bot.entity.velocity = new Vec3(0, -.0784, 0)
  bot.entity.onGround = mode !== 'airborne'
  bot.entity.attributes = { [bot.physics.movementSpeedAttribute]: { value: .1, modifiers: [] } }
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
  const paths: any[] = [], centering: any[] = [], firstGoals: Vec3[] = []
  bot.on('path_update', p => paths.push(p))
  bot.on('nd_parkour', p => centering.push(p))
  bot.on('goal_updated', g => { if (g) firstGoals.push(bot.entity.position.clone()) })
  const params: any = { x: 525.5, y, z: 609.5, range: .8, timeoutSeconds: 10,
    sprint: false, sprintJump: false, bridge: false, pathWait: true, pearl: false,
    descent: false, unstuck: false, surface: false, walkOnly: true,
    arena: { x: 530.5, z: 609.5, r: 20, killY: 145 } }
  async function drive(promise) {
    let settled = false, value, error
    promise.then(v => { value = v; settled = true }, e => { error = e; settled = true })
    for (let i = 0; i < 280 && !settled; i++) { game.advanceTicks(1); await clock.advanceGame(50) }
    if (!settled) { session.ctl?.abort(); await promise.catch(() => {}); throw Error('side-support fixture did not settle') }
    return { value, error }
  }
  async function settle() {
    for (let i = 0; i < 2; i++) { game.advanceTicks(1); await clock.advanceGame(50) }
  }
  const close = () => { session.ctl?.abort(); bot.emit('end'); game.dispose(); gameClock.activate(null) }
  return { bot, session, params, paths, centering, firstGoals, drive, settle, close }
}

test('goto leaves the observed side-supported lower slab by native walking before searching the distant route', async t => {
  const f = fixture(t)
  try {
    await f.settle()
    const result = await f.drive(f.session.goto(f.params))
    assert.ifError(result.error)
    assert.ok(result.value?.arrived, JSON.stringify({ result: result.value, paths: f.paths.map(p => ({ status: p.status, visited: p.visitedNodes })) }))
    assert.ok(f.firstGoals[0].x < 533, 'the first native search starts after physically reaching the supporting column')
    assert.ok(f.paths.some(p => p.status === 'success'))
    assert.ok(f.centering.length > 0, 'the shared native controller performed the short approach')
    assert.ok(f.centering.every(s => !s.control.jump && !s.control.sprint && Math.abs(s.pos.y - 150.5) < .04 && s.hp === 20))
    assert.ok(Math.abs(f.bot.entity.position.x - 525.5) < .8)
    assert.equal(f.bot.health, 20)
  } finally { f.close() }
})

for (const mode of ['centred', 'cube'] as const) test(`goto preserves native routing without a centering detour on ${mode}`, async t => {
  const f = fixture(t, mode)
  try {
    await f.settle()
    const result = await f.drive(f.session.goto(f.params))
    assert.ifError(result.error); assert.ok(result.value?.arrived, JSON.stringify(result.value))
    assert.equal(f.centering.length, 0)
    assert.ok(f.paths.some(p => p.status === 'success'))
    assert.equal(f.bot.health, 20)
  } finally { f.close() }
})

for (const change of ['body', 'health', 'obstruction', 'abort'] as const) test(`goto discards a native centering forecast invalidated during planning: ${change}`, async t => {
  const f = fixture(t)
  const search: typeof import('../src/navigation/parkour/search') = require('../src/navigation/parkour/search')
  const geometry: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const actualPlan = search.planJumpAsync
  let planned = 0, pressedBeforePath = 0
  const setControl = f.bot.setControlState.bind(f.bot)
  f.bot.setControlState = (key, value) => {
    if (!f.firstGoals.length && value && ['forward', 'back', 'left', 'right', 'jump', 'sprint'].includes(key)) pressedBeforePath++
    setControl(key, value)
  }
  t.mock.method(search, 'planJumpAsync', async (...args: Parameters<typeof actualPlan>) => {
    const liveAttributes = structuredClone(f.bot.entity.attributes)
    const plan = await actualPlan(...args)
    assert.deepEqual(f.bot.entity.attributes, liveAttributes, 'forecasting cannot mutate the real body attributes')
    assert.ok(plan, 'the unchanged world first produces a real native centering plan')
    planned++
    if (change === 'body') {
      f.bot.entity.position.x += .02
      f.bot.entity.velocity.z += .01
    } else if (change === 'health') f.bot.health = 19
    else if (change === 'abort') f.session.ctl.abort()
    else {
      const blockAt = f.bot.blockAt
      f.bot.blockAt = p => {
        const q = p.floored()
        return q.x === 532 && q.y === 151 && q.z === 609 ? tick.block('oak_fence', q) : blockAt(p)
      }
      assert.ok(geometry.supportAt(f.bot, f.bot.entity.position, .04), 'the original supporting slab remains')
      assert.ok(geometry.bodyClear(f.bot, f.bot.entity.position), 'the new fence obstructs the future approach, not the starting body')
      assert.ok(plan.states.some(st => !geometry.bodyClear(f.bot, st.pos)), 'the real planned path became obstructed')
    }
    return plan
  })
  // Stop at the first ordinary path request; later pathfinding is unrelated to stale-plan rejection.
  f.bot.on('goal_updated', g => { if (g) f.session.ctl.abort() })
  try {
    await f.settle()
    await f.drive(f.session.goto(f.params))
    assert.equal(planned, 1, 'the actual asynchronous planner and invalidation barrier were reached once')
    if (change === 'abort') assert.equal(f.firstGoals.length, 0, 'an aborted preparation cannot start ordinary pathfinding')
    else assert.ok(f.firstGoals.length > 0, 'an invalidated forecast leaves the ordinary path request available')
    assert.equal(pressedBeforePath, 0, 'no stale movement controls are applied')
    assert.equal(f.centering.length, 0, 'no stale trajectory is executed')
    assert.equal(f.bot._ndParkourForecast, undefined)
    assert.ok(Object.values(f.bot.controlState).every(v => !v), 'cancellation releases controls')
  } finally { f.close() }
})

for (const mode of ['airborne', 'unknown', 'void', 'hazard'] as const) test(`goto does not invent a supported centering walk for ${mode}`, async t => {
  const f = fixture(t, mode)
  // Observe only preparation: the later ordinary route/recovery is outside this safety assertion.
  f.bot.on('goal_updated', g => { if (g) f.session.ctl.abort() })
  try {
    await f.drive(f.session.goto(f.params))
    assert.ok(f.firstGoals.length > 0, 'preparation hands control to the ordinary path request')
    assert.equal(f.centering.length, 0)
    assert.equal(f.bot._ndParkourForecast, undefined)
    assert.ok(Object.values(f.bot.controlState).every(v => !v), 'cancellation releases controls')
  } finally { f.close() }
})
