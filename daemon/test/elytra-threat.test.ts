import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import sky = require('../src/elytra')
import clock = require('../src/game-clock')

function approach(weapon: string, x = 0, speed = 1.5, velocity = new Vec3(0, 0, 0), using = true) {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 100, 0), height: 1.8, width: 0.6, velocity }
  const enemy = { id: 2, position: new Vec3(x, 100.5, 8 + speed), yaw: 0, pitch: 0,
    elytraFlying: true, equipment: [{ name: weapon }], metadata: { 8: using ? 1 : 0 } }
  const oldNow = clock.now
  let now = 1000
  clock.now = () => now
  const tracker = sky.track(bot, { enemy: () => enemy })
  try {
    bot.emit('physicsTick')
    now += 50
    enemy.position.z = 8
    bot.emit('physicsTick')
    return tracker.threat()
  } finally { tracker.close(); clock.now = oldNow }
}

test('ground defender sees spear contact before the glider reaches the body', () => {
  const threat = approach('iron_spear')
  assert.equal(threat?.kind, 'lance')
  assert.ok(threat.eta <= 2, `the extended spear ray reaches in two ticks, got ${threat.eta}`)
})

test('an off-axis spear keeps body-approach warning, without inventing a ray hit', () => {
  assert.equal(approach('iron_spear', 2)?.kind, 'dive')
})

test('ordinary glider keeps dive prediction and a stationary spear is not a charge', () => {
  assert.equal(approach('mace')?.kind, 'dive')
  assert.equal(approach('iron_spear', 0, 0), null)
})

test('an unused spear and a defender already leaving the line do not predict a lance hit', () => {
  assert.equal(approach('iron_spear', 0, 1.5, new Vec3(0, 0, 0), false)?.kind, 'dive')
  assert.equal(approach('iron_spear', 0, 1.5, new Vec3(.35, 0, 0))?.kind, 'dive')
})

test('hidden and reacquired positions cannot create an observed glider velocity', () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0) }
  const enemy: any = { id: 2, position: new Vec3(0, 100.5, 20), elytraFlying: true, _ndVisible: true }
  const oldNow = clock.now
  let now = 1000
  clock.now = () => now
  const tracker = sky.track(bot, { enemy: () => enemy })
  const tick = () => { now += 50; bot.emit('physicsTick') }
  try {
    tick(); enemy.position.z--; tick()
    assert.equal(tracker.vel().z, -1)
    enemy._ndVisible = false
    for (let i = 0; i < 10; i++) tick()
    assert.equal(tracker.threat(), null)
    enemy._ndVisible = true
    enemy.position.z -= 10
    enemy._ndPositionReceipts = [null, { kind: 'reacquired' }]
    tick()
    assert.equal(tracker.vel().z, 0)
    enemy.position.z--; enemy._ndPositionReceipts = [null, { kind: 'relative' }]; tick()
    assert.equal(tracker.vel().z, -1)
  } finally { tracker.close(); clock.now = oldNow }
})

test('a visibly raised iron spear cannot hit during its native twelve-tick delay', () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0) }
  const enemy: any = { id: 2, position: new Vec3(0, 100.5, 9.5), yaw: 0, pitch: 0,
    elytraFlying: true, equipment: [{ name: 'iron_spear' }], metadata: { 8: 0 } }
  const oldNow = clock.now
  let now = 1000
  clock.now = () => now
  const tracker = sky.track(bot, { enemy: () => enemy })
  try {
    bot.emit('physicsTick')
    now += 50; enemy.position.z = 8; enemy.metadata[8] = 1; bot.emit('physicsTick')
    assert.equal(tracker.threat()?.kind, 'dive', 'the uncharged spear will pass before it becomes damaging')
  } finally { tracker.close(); clock.now = oldNow }
})
