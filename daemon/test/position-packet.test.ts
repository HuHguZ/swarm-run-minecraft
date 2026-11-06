import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { install, testBot, testClock } from './tick-plugins-fixture'
import { positionPhysics } from '../src/position-packet'

const conv = require('mineflayer/lib/conversions')
// Golden values are direct calls into Paper 1.21.11 PositionMoveRotation.calculateAbsolute,
// not a second implementation. Reproducer: codex-lab/human-arena-20261104/position-protocol.
const cases = [
  { name: 'absolute', flags: {}, p: [1, 2, 3], v: [.25, -.5, .75] },
  { name: 'position_relative', flags: { x: true, y: true, z: true }, p: [11, 66, 23], v: [.25, -.5, .75] },
  { name: 'delta_relative', flags: { dx: true, dy: true, dz: true }, p: [1, 2, 3], v: [1.25, 1.5, 3.75] },
  { name: 'mixed', flags: { x: true, dy: true }, p: [11, 2, 3], v: [.25, 1.5, .75] },
  { name: 'rotate_delta', flags: { dx: true, dy: true, dz: true, yawDelta: true }, p: [1, 2, 3], v: [-1.989020927648169, 1.2309728935360909, 3.1973227255787715] },
  { name: 'reset_zero', flags: {}, zero: true, p: [1, 2, 3], v: [0, 0, 0] },
  { name: 'clamp_pitch', flags: {}, inputPitch: 120, p: [1, 2, 3], v: [.25, -.5, .75], pitch: 90 },
  { name: 'rotation_relative', flags: { yaw: true, pitch: true }, p: [1, 2, 3], v: [.25, -.5, .75], yaw: 120, pitch: 25 },
  { name: 'rotation_relative_delta', flags: { yaw: true, pitch: true, dx: true, dy: true, dz: true, yawDelta: true }, p: [1, 2, 3], v: [-3.1652671694755554, .6555631756782532, 1.75], yaw: 120, pitch: 25 },
  { name: 'zero_position_relative', flags: { x: true, y: true, z: true }, zero: true, p: [11, 66, 23], v: [0, 0, 0] },
  { name: 'preserve_delta_zero', flags: { dx: true, dy: true, dz: true }, zero: true, p: [1, 2, 3], v: [1, 2, 3] }
]

function previous(bot) {
  bot.entity.position.set(10, 64, 20); bot.entity.velocity.set(1, 2, 3)
  bot.entity.yaw = conv.fromNotchianYaw(30); bot.entity.pitch = conv.fromNotchianPitch(10)
  bot.packets.length = 0
}
function packet(c: typeof cases[number]) {
  return { teleportId: 7, x: 1, y: 2, z: 3, dx: c.zero ? 0 : .25, dy: c.zero ? 0 : -.5,
    dz: c.zero ? 0 : .75, yaw: 90, pitch: c.inputPitch ?? 15, flags: c.flags }
}
function near(actual: number[], expected: number[]) {
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} != ${expected} at ${i}`))
}
function check(bot, c: typeof cases[number]) {
  near(bot.entity.position.toArray(), c.p); near(bot.entity.velocity.toArray(), c.v)
  near([conv.toNotchianYaw(bot.entity.yaw), conv.toNotchianPitch(bot.entity.pitch)], [c.yaw ?? 90, c.pitch ?? 15])
}

for (const mode of ['body', 'stock NPC']) for (const c of cases) test(`${mode} modern position agrees with native ${c.name} before forcedMove`, () => {
  const bot = mode === 'body' ? install(testClock()) : testBot()
  if (mode === 'stock NPC') { positionPhysics(bot, { physicsEnabled: true }); bot.emit('login') }
  previous(bot)
  let forced = 0
  bot.on('forcedMove', () => {
    forced++; check(bot, c)
    assert.deepEqual(bot.packets.map(p => p.name), ['teleport_confirm', 'position_look'])
    near([bot.packets[1].yaw, bot.packets[1].pitch], [c.yaw ?? 90, c.pitch ?? 15])
  })
  try {
    assert.equal(bot._client.listenerCount('position'), 1, 'one stock handler owns position and teleport acknowledgement')
    bot._client.emit('position', packet(c))
    assert.equal(forced, 1)
    assert.equal(bot.entity.onGround, false)
  } finally { bot.emit('end') }
})

test('position packets without delta retain both legacy flag branches', () => {
  const bot = install(testClock())
  try {
    for (const flags of [1 | 4 | 8 | 16, { x: true, z: true, yaw: true, pitch: true }]) {
      previous(bot)
      bot._client.emit('position', { teleportId: 8, x: 1, y: 2, z: 3, yaw: 90, pitch: 15, flags })
      near(bot.entity.position.toArray(), [11, 2, 23]); near(bot.entity.velocity.toArray(), [1, 0, 3])
      near([conv.toNotchianYaw(bot.entity.yaw), conv.toNotchianPitch(bot.entity.pitch)], [120, 25])
      assert.deepEqual(bot.packets.map(p => p.name), ['teleport_confirm', 'position_look'])
    }
  } finally { bot.emit('end') }
})

test('modern respawn preserves delayed reply and applies native velocity before its forcedMove', async () => {
  const clock = testClock(); clock.freeze(true); await clock.advanceWall(1)
  const bot = install(clock); previous(bot)
  const gameNow = clock.now(); let forced = 0
  bot.on('forcedMove', () => { forced++; check(bot, cases[0]) })
  try {
    bot.emit('death'); bot.emit('respawn')
    bot._client.emit('position', packet(cases[0]))
    check(bot, cases[0])
    assert.deepEqual(bot.packets.map(p => p.name), ['teleport_confirm'])
    await clock.advanceWall(1499); assert.equal(forced, 0)
    await clock.advanceWall(1); assert.equal(forced, 1)
    assert.deepEqual(bot.packets.map(p => p.name), ['teleport_confirm', 'position_look'])
    assert.equal(clock.now(), gameNow)
  } finally { bot.emit('end') }
})

test('NPC adapter retains one stock physics scheduler and removes it on end', t => {
  let now = 0; const scheduled = []; const cleared = []
  const performance = (require('node:perf_hooks') as typeof import('node:perf_hooks')).performance
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const timer = { fn, ms }; scheduled.push(timer); return timer })
  t.mock.method(globalThis, 'clearInterval', timer => { cleared.push(timer) })
  const bot = testBot(); positionPhysics(bot, { physicsEnabled: true })
  bot.emit('login'); bot.emit('login')
  bot._client.emit('position', { teleportId: 1, x: .5, y: 4, z: .5, dx: 0, dy: .5, dz: 0, yaw: 0, pitch: 0, flags: {} })
  let frames = 0; bot.on('physicsTick', () => { frames++ })
  try {
    assert.equal(scheduled.length, 1); assert.equal(scheduled[0].ms, 50)
    assert.equal(bot.ndClock, undefined, 'packet compatibility does not install a gameplay clock')
    now = 50; scheduled[0].fn()
    assert.equal(frames, 1); assert.ok(bot.entity.position.y > 4, 'one ordinary installed integration consumes native velocity')
  } finally { bot.emit('end') }
  assert.deepEqual(cleared, [scheduled[0]])
})
