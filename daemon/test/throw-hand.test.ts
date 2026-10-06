import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { throwHand } from '../src/combat/throw-hand'
const Vec3 = require('vec3')
const { throwAt } = require('../src/throw')

test('offhand throws preserve melee weapons and respect an active use action', () => {
  const state = { item: 'ender_pearl', mainItem: 'mace', usingItem: false, preferOffhand: true }
  assert.equal(throwHand(state), 'off-hand')
  assert.equal(throwHand({ ...state, usingItem: true }), 'hand')
  assert.equal(throwHand({ ...state, mainItem: 'bow' }), 'hand')
  assert.equal(throwHand({ ...state, item: 'cooked_beef' }), 'hand')
})
test('flight pearl uses offhand, correct launch eye and restores shield after use', async () => {
  const bot: any = new EventEmitter()
  const weapon = { name: 'mace', type: 1, slot: 36 }
  const item = { name: 'ender_pearl', type: 2, slot: 10 }
  const shield = { name: 'shield', type: 3, slot: 45 }
  const slots: any[] = []; slots[45] = shield
  const packets: any[] = []
  bot.inventory = { slots, items: () => [weapon, item, shield] }
  bot.entity = { position: new Vec3(0, 20, 0), velocity: new Vec3(1, 0, 0), elytraFlying: true, onGround: false }
  bot.heldItem = weapon
  bot.equip = async (chosen, hand) => { if (hand === 'off-hand') slots[45] = chosen; else bot.heldItem = chosen }
  bot.look = async () => {}
  bot.world = { raycast: () => null }
  bot.activateItem = (offhand) => packets.push({ packet: 'use_item', hand: offhand ? 1 : 0 })
  let launchY = 0
  const ticks = setInterval(() => bot.emit('physicsTick'), 5)
  try {
    const result = await throwAt(bot, null, { item, preferOffhand: true,
      pick: context => { launchY = context.from.y; return { yaw: 0, pitch: 0, ticks: 10 } } })
    assert.equal(result.thrown, true)
    assert.equal(result.hand, 'off-hand')
    assert.equal(bot.heldItem, weapon)
    assert.equal(slots[45], shield)
    assert.equal(launchY, 20.3)
    assert.deepEqual(packets, [{ packet: 'use_item', hand: 1 }])
  } finally { clearInterval(ticks) }
})

test('a catch-up burst releases the projectile before later ticks can change its shot', async () => {
  const bot: any = new EventEmitter()
  const item = { name: 'ender_pearl', type: 2, slot: 36 }
  bot.inventory = { slots: [], items: () => [item] }
  bot.entity = { position: new Vec3(0, 20, 0), onGround: false }
  bot.heldItem = item
  bot.world = { raycast: () => null }
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const used: number[] = []
  bot.activateItem = () => used.push(bot.entity.position.x)
  const throwing = throwAt(bot, null, { item, pick: () => ({ yaw: 1, pitch: 0, ticks: 10 }) })
  bot.entity.position.x = 1; bot.emit('physicsTick')
  bot.entity.position.x = 2; bot.emit('physicsTick')
  bot.entity.position.x = 3; bot.emit('physicsTick')
  assert.deepEqual(used, [3], 'use is sent after the previous movement packet inside the synchronous burst')
  bot.entity.position.x = 4; bot.emit('physicsTick')
  assert.equal((await throwing).thrown, true)
  assert.deepEqual(used, [3], 'the final setImmediate must not fire a second delayed projectile')
})

test('the packet callback keeps the emergency lease when physics events arrive outside it', async () => {
  const locks = require('../src/reflex-lock')
  const bot: any = new EventEmitter()
  const item = { name: 'ender_pearl', type: 2, slot: 36 }
  bot.inventory = { slots: [], items: () => [item] }
  bot.entity = { position: new Vec3(0, 20, 0), onGround: false }
  bot.heldItem = item
  bot.world = { raycast: () => null }
  bot.look = async () => {}
  let used = 0
  bot.activateItem = () => { used++ }
  const session: any = { bot, current: null, reflex: null }
  let shot: any
  const work = locks.start(session, async () => { shot = await throwAt(bot, null, { item, pick: () => ({ yaw: 1, pitch: 0, ticks: 10 }) }) }, { owner: 'Emergency' })
  await Promise.resolve(); await Promise.resolve()
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('physicsTick')
  await work
  assert.equal(shot.thrown, true)
  assert.equal(used, 1, 'the actual protected activateItem must execute inside its original lease')
})

test('a clock catch-up that fires the stall timer with the first physics tick still throws (750 TPS, s5)', async () => {
  const clock = require('../src/game-clock')
  const c = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(c)
  try {
    const bot: any = new EventEmitter()
    const item = { name: 'ender_pearl', type: 2, slot: 36 }
    bot.inventory = { slots: [], items: () => [item] }
    bot.entity = { position: new Vec3(0, 20, 0), onGround: true }
    bot.heldItem = item
    bot.world = { raycast: () => null }
    bot.look = async () => {}
    let used = 0
    bot.activateItem = () => { used++ }
    c.on('tick', () => bot.emit('physicsTick'))
    const throwing = throwAt(bot, null, { item, pick: () => ({ yaw: 1, pitch: 0, ticks: 10 }) })
    await Promise.resolve()
    c.ticks += 30; c.advanceTicks(1) // reconcile jump: first physics tick and the overdue 400 ms timer in one pulse
    for (let i = 0; i < 3; i++) { c.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) }
    const shot = await throwing
    assert.equal(shot.thrown, true, shot.why)
    assert.equal(used, 1)
  } finally { c.dispose() }
})

test('use_item уносит взгляд броска, даже если bot.look ещё не применён (750 TPS, s5)', async () => {
  const clock = require('../src/game-clock')
  const c = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(c)
  try {
    const bot: any = new EventEmitter()
    const item = { name: 'ender_pearl', type: 2, slot: 36 }
    bot.inventory = { slots: [], items: () => [item] }
    bot.entity = { position: new Vec3(0, 20, 0), onGround: true, yaw: 0, pitch: 0 }
    bot.heldItem = item
    bot.world = { raycast: () => null }
    bot.look = () => new Promise(() => {}) // под замком: поворот так и не применён
    let seen = null
    bot.activateItem = () => { seen = [bot.entity.yaw, bot.entity.pitch] }
    c.on('tick', () => bot.emit('physicsTick'))
    const throwing = throwAt(bot, null, { item, pick: () => ({ yaw: 1.5, pitch: 0.4, ticks: 10 }) })
    for (let i = 0; i < 4; i++) { c.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) }
    const shot = await throwing
    assert.equal(shot.thrown, true, shot.why)
    assert.deepEqual(seen, [1.5, 0.4])
  } finally { c.dispose() }
})
