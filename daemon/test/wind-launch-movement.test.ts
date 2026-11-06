import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { testClock, install } from './tick-plugins-fixture'

test('plain clients without the core adapter retain only the legacy movement estimate', () => {
  const { windMovement } = require('../src/combat/team-wind')
  const bot = { entity: { velocity: new Vec3(.1, -.2, .3), onGround: true } }
  assert.deepEqual(windMovement(bot), new Vec3(.1, 0, .3))
  bot.entity.onGround = false
  assert.deepEqual(windMovement(bot), bot.entity.velocity)
  windMovement(bot).x = 999
  assert.equal(bot.entity.velocity.x, .1)
})

test('N1608 inherits the sent position delta, while the own report retains native post-drag velocity', async () => {
  const clock = testClock(), bot = install(clock, { physicsEnabled: false })
  const { windMovement, WIND } = require('../src/combat/team-wind')
  const { enemyWindReport } = require('../src/combat/enemy-wind-execute')
  Object.assign(bot, { username: 'NeuroFarm31', health: 20, ndClock: { age: 500n, serverTicks: 20, ticks: 20 } })
  const previous = new Vec3(605.7502648640278, 120, 598.4998461943381)
  const current = new Vec3(605.4977337705899, 120, 598.5793965299927)
  bot._client.emit('position', { ...previous, yaw: 0, pitch: 0, flags: {}, teleportId: 2 })
  bot.entity.position = current.clone()
  bot.entity.velocity = new Vec3(-.13788197701709198, -.0784000015258789, .0434344832673651)
  try {
    await clock.advanceGame(50)
    const moved = current.minus(previous), report = enemyWindReport({ bot }).report
    assert.deepEqual(windMovement(bot), bot.entity.position.minus(previous))
    assert.deepEqual(report.launchMovement, { ...moved })
    assert.deepEqual(report.velocity, { ...bot.entity.velocity }, 'body physics keeps its post-drag state')
    const yaw = 1.6796627196972753, pitch = .18116848982467174
    const mean = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(WIND.speed).plus(windMovement(bot))
    const native = new Vec3(-1.7091397882760109, .2725086024455326, .2461039237081677)
    assert.ok(native.minus(mean).norm() < WIND.speed * WIND.dispersion * Math.sqrt(3), 'captured LP velocity fits native dispersion only with the accepted movement')
  } finally { bot.emit('end') }
})

test('native movement is available before the packet and retained after tick_end without changing physics', async () => {
  const clock = testClock(), bot = install(clock), { windMovement } = require('../src/combat/team-wind')
  bot.setControlState('forward', true)
  const previous = bot.entity.position.clone()
  let pending: Vec3, sent: Vec3
  bot.once('physicsTick', () => { pending = windMovement(bot) })
  bot.once('ndMovementSent', () => { sent = windMovement(bot) })
  try {
    await clock.advanceGame(50)
    const expected = bot.entity.position.minus(previous); expected.y = 0
    assert.ok(expected.norm() > 0)
    assert.deepEqual(pending!, expected)
    assert.deepEqual(sent!, expected)
    assert.notDeepEqual(bot.entity.velocity, sent, 'the integrator still applies native drag')
    const clone = windMovement(bot); clone.x = 999
    assert.deepEqual(windMovement(bot), expected, 'callers cannot mutate the saved movement')
  } finally { bot.emit('end') }
  assert.equal(bot._ndLaunchMovement, undefined, 'the physical getter does not survive disconnect')
})

for (const mode of ['ground', 'air', 'glider', 'stationary', 'look-only', 'unloaded']) test(`native launch movement respects ${mode} packets`, async () => {
  const clock = testClock(), bot = install(clock, { physicsEnabled: false }), { windMovement } = require('../src/combat/team-wind')
  const previous = bot.entity.position.clone()
  bot.entity.onGround = mode !== 'air' && mode !== 'glider'
  bot.entity.elytraFlying = mode === 'glider'
  const moved = ['ground', 'air', 'glider', 'unloaded'].includes(mode) ? new Vec3(.2, mode === 'air' || mode === 'glider' ? -.3 : 0, .1) : new Vec3(0, 0, 0)
  bot.entity.position = previous.plus(moved)
  if (mode === 'look-only') await bot.look(.4, .2, true)
  if (mode === 'unloaded') bot.blockAt = () => null
  try {
    await clock.advanceGame(50)
    assert.deepEqual(windMovement(bot), mode === 'unloaded' ? new Vec3(0, 0, 0) : bot.entity.position.minus(previous))
    bot.entity.position = bot.entity.position.clone()
    await clock.advanceGame(50)
    assert.deepEqual(windMovement(bot), new Vec3(0, 0, 0), 'no new accepted movement cannot inherit the previous tick')
  } finally { bot.emit('end') }
})

test('native correction resets launch movement instead of inheriting the teleport displacement', async () => {
  const clock = testClock(), bot = install(clock, { physicsEnabled: false }), { windMovement } = require('../src/combat/team-wind')
  bot.entity.position.x += .2
  try {
    await clock.advanceGame(50)
    assert.ok(windMovement(bot).x > 0)
    bot._client.emit('position', { x: 100, y: 20, z: 100, yaw: 0, pitch: 0, flags: {}, teleportId: 2 })
    assert.deepEqual(windMovement(bot), new Vec3(0, 0, 0))
    await clock.advanceGame(50)
    assert.deepEqual(windMovement(bot), new Vec3(0, 0, 0))
  } finally { bot.emit('end') }
})

test('hostile wind uses launch movement while delayed body forecasts keep post-drag velocity', async () => {
  const clock = testClock(), bot = install(clock, { physicsEnabled: false })
  const { enemyWindShot, windReportAt } = require('../src/combat/enemy-wind'), edges = require('../src/edges')
  const { WIND } = require('../src/combat/team-wind')
  bot.ndClock = { age: 500n, serverTicks: 20, ticks: 20 }
  const foe = { id: 2, username: 'Enemy', type: 'player', width: .6, height: 1.8, position: new Vec3(8, 3, .5), metadata: [] }
  const frames = Array.from({ length: 40 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const report = { id: 'A', position: { ...bot.entity.position }, velocity: { x: .1, y: 0, z: 0 },
    launchMovement: { x: .25, y: 0, z: .05 }, onGround: true, yaw: 0, gameTick: 500 }
  try {
    const immediate = enemyWindShot(bot, foe, report, frames, { height: 1.4 })
    assert.ok(immediate)
    assert.ok(Math.abs(immediate.velocity.minus(new Vec3(.25, 0, .05)).norm() - WIND.speed) < 1e-12)
    const state = edges.stateOf({ ...bot, entity: { ...bot.entity, position: new Vec3(report.position.x, report.position.y, report.position.z),
      velocity: new Vec3(.1, 0, 0), onGround: true, yaw: 0 } }, edges.IDLE), simulate = edges.simOf(bot), world = edges.worldOf(bot)
    let movement: Vec3
    for (let tick = 0; tick < 3; tick++) { const previous = state.pos.clone(); simulate(state, world); movement = state.pos.minus(previous) }
    const dated = windReportAt(bot, report, 503)
    assert.ok(new Vec3(dated.launchMovement.x, dated.launchMovement.y, dated.launchMovement.z).distanceTo(movement!) < 1e-12)
    assert.deepEqual(dated.velocity, { ...state.vel })
    const delayed = enemyWindShot(bot, foe, report, frames, { fireDelay: 3, height: 1.4 })
    assert.ok(delayed)
    const inherited = movement!.clone(); if (state.onGround) inherited.y = 0
    assert.ok(Math.abs(delayed.velocity.minus(inherited).norm() - WIND.speed) < 1e-12, 'future release inherits the final native step displacement')
  } finally { bot.emit('end') }
})
