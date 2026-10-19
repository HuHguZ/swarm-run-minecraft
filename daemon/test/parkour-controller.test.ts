// Паркур: исполнитель — клавиши по тикам, установленный контроллер Mineflayer, сторож края, отказ с кадрами, зависший тик.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { registry, native, worldOf, drive } from './parkour-fixture'

test('an optimistic climb refusal preserves its assigned contact and bounded observed body geometry without moving', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 1; y <= 4; y++) cells.push([3, y, 0, 'stone'], [2, y, 0, 'ladder', { facing: 'west', waterlogged: false }])
  for (let y = 1; y <= 6; y++) for (let z = -3; z <= 3; z++) cells.push([1, y, z, 'stone'])
  const { bot } = worldOf(cells); const before = bot.entity.position.clone()
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.waitForTicks = async () => assert.fail('a refused optimistic climb may not execute any motion')
  const result = await route(bot, { aborted: false }, { toward: new Vec3(3.5, 5, .5), maxLandings: 1 })
  const refused: any = result.rejected.find((receipt: any) => receipt.mode === 'climb')
  assert.ok(refused, 'the loaded tag column creates an optimistic graph edge, then full native body clearance refuses its blocked catch')
  assert.equal(refused.ticks, 0); assert.equal(refused.why, 'no_safe_native_trajectory')
  assert.deepEqual(refused.climb, { x: 2.5, y: 1, z: .5 })
  assert.deepEqual(refused.waypoints[0].climb, refused.climb)
  const observation = refused.forecast.observation
  assert.deepEqual(observation.start.at, { x: .5, y: 1, z: .5 })
  assert.deepEqual(observation.climb.at, refused.climb)
  assert.ok(observation.climb.cells.some((cell: any) => cell.loaded && cell.name === 'ladder' && cell.position.y === 1 && cell.properties.facing === 'west' && cell.shapes.length > 0))
  assert.ok(observation.target.cells.some((cell: any) => cell.loaded && cell.name === 'stone' && cell.position.y === 4))
  assert.ok(Object.values(observation).reduce<number>((count, entry: any) => count + entry.cells.length, 0) <= 64, 'refusal geometry is limited to a few native body neighbourhoods')
  assert.deepEqual(bot.entity.position, before); assert.equal(bot.health, 20); assert.equal(control.forward, false)
})
test('native movement changes controls between every tick of a synchronous catch-up batch', async () => {
  const { planJump, executePlan, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const plan = planJump(bot, new Vec3(2.5, 2, .5))
  assert.ok(plan)
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < Math.ceil(ticks / 4) * 4; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      bot.emit('physicsTick')
    }
  }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const result = await executePlan(bot, ctl, plan, (state: { pos: Vec3; onGround: boolean }) => state.onGround && state.pos.distanceTo(new Vec3(2.5, 2, .5)) < .25)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ticks, plan.steps.length)
  result.samples.forEach((sample: { pos: { x: number; y: number; z: number } }, tick: number) => {
    assert.ok(new Vec3(sample.pos.x, sample.pos.y, sample.pos.z).distanceTo(plan.states[tick].pos) < 1e-6, `native tick ${tick + 1} must receive its forecast control`)
  })
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount('end'), 0)
  assert.equal(ctl.onAbort.length, 0)
  assert.equal(bot._ndParkourForecast, undefined)
  assert.equal(control.forward, false); assert.equal(control.sneak, true)
})
test('the shared controller executes through installed Mineflayer look, queued jump, input and tick plugins', async () => {
  const { planJump, executePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const callbacks: Array<() => void> = []; let elapsed = 0
  const clock = { now: () => elapsed, setInterval: (fn: () => void) => { callbacks.push(fn); return fn }, clearInterval() {}, setTimeout: () => null, clearTimeout() {} }
  const packets: string[] = []
  bot._client = Object.assign(new EventEmitter(), { state: 'play', write: (name: string) => { packets.push(name) } })
  bot.supportFeature = registry.supportFeature; bot.entity.id = 1; bot.entities = {}; bot.isAlive = true
  bot.game = { gameMode: 'survival', minY: -64 }
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: true })
  bot.emit('login'); bot._client.emit('position', { x: .5, y: 1, z: .5, yaw: 90, pitch: 0, flags: {}, teleportId: 1 })
  for (let tick = 0; tick < 2; tick++) { elapsed += 50; callbacks[0]() } // Actual floor contact after the airborne position receipt.
  const plan = planJump(bot, new Vec3(2.5, 2, .5))
  assert.ok(plan, JSON.stringify(new native.PlayerState(bot, { ...(require('../src/navigation/parkour') as typeof import('../src/navigation/parkour')).IDLE })))
  try {
    const work = executePlan(bot, { aborted: false }, plan, (state: { pos: Vec3; onGround: boolean }) => state.onGround && state.pos.distanceTo(new Vec3(2.5, 2, .5)) < .25)
    for (let tick = 0; tick < plan.steps.length; tick++) { elapsed += 50; callbacks[0]() }
    const result = await work
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.ticks, plan.steps.length)
    assert.ok(packets.includes('player_input')); assert.ok(packets.includes('tick_end'))
    assert.equal(bot.getControlState('forward'), false); assert.equal(bot.getControlState('sneak'), true)
  } finally { bot.emit('end') }
})
test('a loaded connected route still executes native movement when the next floor is not visible', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  let control = { ...IDLE }
  bot.canSeeBlock = () => false
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world)
      state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(2.5, 1, .5), maxLandings: 4 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.landings.length, 'a known hidden floor must reach the native movement controller')
  assert.ok(bot.entity.position.distanceTo(new Vec3(2.5, 1, .5)) < .25)
})
test('real edge guard retains native simulation for a confirmed plan and resumes after drift, damage or expiry', () => {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true }); clockModule.activate(clock)
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  const control = { ...(require('../src/navigation/parkour') as typeof import('../src/navigation/parkour')).IDLE, forward: true }
  const nativeSim = bot.physics.simulatePlayer.bind(bot.physics); let calls = 0
  bot.physics.simulatePlayer = (state: any, terrain: any) => { calls++; return nativeSim(state, terrain) }
  const guard = (require('../src/edges') as typeof import('../src/edges')).guard(bot)
  const run = () => { calls = 0; return bot.physics.simulatePlayer(new native.PlayerState(bot, control), world) }
  try {
    for (let tick = 0; tick < 3; tick++) { clock.advanceTicks(1); run() }
    bot._ndParkourForecast = { from: { ...bot.entity.position }, until: clockModule.now() + 100, hp: 20 }
    const result = run()
    assert.equal(calls, 1, 'the installed guard keeps the one actual native integration without a second planner')
    assert.ok(result.vel.y < 0, 'native gravity still advances the actual state')
    bot._ndParkourForecast.from.x += .2; run(); assert.ok(calls > 1, 'drift restores normal edge forecasts')
    bot._ndParkourForecast.from = { ...bot.entity.position }; bot.health = 19; run(); assert.ok(calls > 1, 'damage restores normal edge forecasts')
    bot.health = 20; clock.advanceTicks(3); run(); assert.ok(calls > 1, 'stale ownership restores normal edge forecasts')
  } finally { guard.stop(); clock.dispose(); clockModule.activate(null) }
})
test('a refused execution retains native expected frames and the observed fluid layer below the actual body', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'lava'], [2, 1, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  bot._ndClutch = { stats: { water_saved: 0 }, forecast: { landing: { lava: true, top: 0 }, guardAllow: false, intentional: false } }
  let control = { ...IDLE }; let ticks = 0
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (count: number) => {
    for (let tick = 0; tick < count; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot)
      if (++ticks === 2) { bot.entity.position.x += .1; bot.health = 16 }
      bot.emit('physicsTick')
      if (bot.health < 20) break
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(2.5, 2, .5), maxLandings: 1 })
  assert.equal(result.ok, false); assert.equal(result.why, 'hurt_during_trajectory')
  const last = (result.landings[0] as any).trajectory.at(-1)
  assert.equal(last.tick, 2); assert.equal(last.hp, 16)
  assert.ok(Math.abs(last.pos.x - last.expected.pos.x - .1) < 1e-8, 'small real corrections must stay visible even below the controller divergence threshold')
  assert.ok(last.observation.actual.cells.some((cell: any) => cell.name === 'lava' && cell.position.y === 0 && cell.loaded), 'the receipt records actual loaded blocks below the now-rising body')
  assert.equal(last.observation.actual.body.minY, last.pos.y)
  assert.equal(last.fallReflex.marker.hp, 20, 'the failed frame keeps its exact owner before cleanup')
  assert.ok(last.fallReflex.marker.from && last.fallReflex.marker.next)
  assert.deepEqual(last.fallReflex.position, last.pos)
  assert.equal(last.fallReflex.forecast.landing.lava, true)
  assert.equal(last.fallReflex.forecast.guardAllow, false)
  assert.equal(bot._ndParkourForecast, undefined)
})
test('installed edge guard keeps only actual physics for a stationary grounded body and resumes for movement or knockback', () => {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true }); clockModule.activate(clock)
  const { bot, world } = worldOf([[0, 0, 0, 'stone']])
  const control = { ...(require('../src/navigation/parkour') as typeof import('../src/navigation/parkour')).IDLE, sneak: true }
  const nativeSim = bot.physics.simulatePlayer.bind(bot.physics); let calls = 0
  bot.physics.simulatePlayer = (state: unknown, terrain: unknown) => { calls++; return nativeSim(state, terrain) }
  const guard = (require('../src/edges') as typeof import('../src/edges')).guard(bot)
  const run = () => { calls = 0; return bot.physics.simulatePlayer(new native.PlayerState(bot, control), world) }
  try {
    for (let tick = 0; tick < 3; tick++) { clock.advanceTicks(1); run() }
    const actual = run()
    assert.equal(calls, 1, 'idle ground cannot need a 5-block hazard scan and another native motion forecast on every accelerated tick')
    assert.ok(actual.vel.y < 0, 'the one actual integration still applies vanilla gravity')
    control.forward = true; run(); assert.ok(calls > 1, 'requested movement restores guard forecasting')
    control.forward = false; bot.entity.velocity.x = .1; run(); assert.ok(calls > 1, 'actual horizontal knockback restores guard forecasting')
    bot.entity.velocity.x = 0; bot.jumpQueued = true; run(); assert.ok(calls > 1, 'a queued jump cannot use the stationary path')
  } finally { guard.stop(); clock.dispose(); clockModule.activate(null) }
})
test('a stalled native tick wait ends the edge with its samples instead of rejecting the route', async () => {
  const { executeJump }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [3, 0, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const step = bot.waitForTicks
  bot.waitForTicks = async (ticks: number) => { await step(3); throw new Error('Timeout waiting for game ticks') }
  const result = await executeJump(bot, { aborted: false }, new Vec3(3.5, 1, .5), { allowWalk: true, maxTicks: 38 })
  assert.equal(result.ok, false)
  assert.equal(result.why, 'tick_wait_timeout')
  assert.equal(result.ticks, 3)
})
