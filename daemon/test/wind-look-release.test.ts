import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as edges from '../src/edges'
import { activate, GameClock } from '../src/game-clock'
import { fireWind, install, windReady } from '../src/mace/hands'
import { windReleaseSafe } from '../src/combat/wind-safety'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()
const requested = { yaw: Math.PI, pitch: -Math.PI / 2 }

function fixture() {
  const controls = { ...edges.IDLE, sneak: true }, shots: any[] = [], slots: number[] = []
  const world = { getBlock(p: Vec3) {
    const b = Block.fromStateId(registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  } }
  const charge = { name: 'wind_charge', count: 16, slot: 37 }
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'Own', version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: Array(46).fill(null), items: () => [charge] }, quickBarSlot: 0, _client: new EventEmitter(),
    _ndSwarmAllies: ['Ally'], entity: { id: 1, username: 'Own', position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0),
      onGround: true, height: 1.8, width: .6, yaw: Math.PI, pitch: 0, effects: {}, attributes: {} },
    entities: { 2: { id: 2, username: 'Ally', type: 'player', position: new Vec3(.5, 1, 5.5), velocity: new Vec3(0, 0, 0),
      onGround: true, height: 1.8, width: .6, metadata: [], _ndVisible: true } },
    blockAt: (p: Vec3) => world.getBlock(p), physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, getControlState: key => controls[key],
    setQuickBarSlot: slot => { slots.push(slot); bot.quickBarSlot = slot },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    activateItem: () => shots.push({ yaw: bot.entity.yaw, pitch: bot.entity.pitch, slot: bot.quickBarSlot })
  })
  bot.inventory.slots[37] = charge
  Object.defineProperty(bot.entities[2].metadata, 9, { get() { throw Error('private allied HP') } })
  return { bot, controls, shots, slots }
}

for (const mode of ['blocked-look', 'intercepted-before-packet', 'nonfinite-look']) {
  test(`wind packet release rejects ${mode} without activation, slot/control or cooldown effects`, async () => {
    const f = fixture(), input = { ...f.controls }
    assert.equal(windReleaseSafe(f.bot, requested, new Vec3(0, 0, 0)), true, 'requested floor burst is safe')
    assert.equal(windReleaseSafe(f.bot, f.bot.entity, new Vec3(0, 0, 0)), false, 'actual horizontal ray hits the visible ally')
    if (mode === 'blocked-look') f.bot.look = async () => {}
    const pending = fireWind(f.bot, () => requested, { immediate: true, swap: true })
    if (mode === 'intercepted-before-packet') f.bot.entity.pitch = 0
    if (mode === 'nonfinite-look') f.bot.entity.yaw = NaN
    const result = await pending
    assert.equal(result.fired, false)
    assert.equal(f.shots.length, 0)
    assert.deepEqual(f.slots, [])
    assert.equal(f.bot.quickBarSlot, 0)
    assert.equal(f.bot._ndWindCd, undefined)
    assert.deepEqual(f.controls, input)
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
  })
}

for (const mode of ['clear', 'wrapped-yaw', 'vertical-yaw-change', 'native-small-look-rounding']) {
  test(`wind packet release preserves safe ${mode}`, async () => {
    const f = fixture()
    if (mode === 'wrapped-yaw') f.bot.look = async (yaw, pitch) => { f.bot.entity.yaw = yaw + 2 * Math.PI; f.bot.entity.pitch = pitch }
    if (mode === 'vertical-yaw-change') f.bot.look = async (yaw, pitch) => { f.bot.entity.yaw = yaw + 1; f.bot.entity.pitch = pitch }
    if (mode === 'native-small-look-rounding') f.bot.look = async (yaw, pitch) => { f.bot.entity.yaw = yaw + .001; f.bot.entity.pitch = pitch + .001 }
    const result = await fireWind(f.bot, () => requested, { immediate: true, swap: true })
    assert.equal(result.fired, true)
    assert.equal(f.shots.length, 1)
    assert.equal(f.shots[0].slot, 1)
    assert.deepEqual(f.slots, [1, 0])
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
    assert.ok(Number.isFinite(f.bot._ndWindCd))
    assert.equal(windReleaseSafe(f.bot, f.shots[0], new Vec3(0, 0, 0)), true, 'actual transmitted direction is safe too')
  })
}

test('wind packet release preserves caller cancellation through its existing before hook', async () => {
  const f = fixture(), ctl = { aborted: true }
  const result = await fireWind(f.bot, () => requested, { immediate: true, before() { if (ctl.aborted) throw Error('cancelled') } })
  assert.equal(result.fired, false)
  assert.equal(f.shots.length, 0)
  assert.deepEqual(f.slots, [])
  assert.equal(f.bot._ndWindCd, undefined)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('an owned self-launch uses the sent movement and native packet aim before an async look can run', async () => {
  const f = fixture(), oldPitch = f.bot.entity.pitch, moved = new Vec3(.12, 0, 0)
  f.bot.inventory.slots[45] = f.bot.inventory.slots[37]
  f.bot._ndLaunchMovement = () => moved.clone()
  f.bot.look = async (yaw, pitch) => { await Promise.resolve(); f.bot.entity.yaw = yaw; f.bot.entity.pitch = pitch }
  let atAim: Vec3 | undefined
  const pending = fireWind(f.bot, m => { atAim = m; return requested }, { packetAim: true, hand: 'off' })
  f.bot.emit('physicsTick'); f.bot.emit('ndMovementSent')
  assert.equal((await pending).fired, true)
  assert.deepEqual(atAim, moved)
  assert.equal(f.shots[0]?.pitch, requested.pitch)
  assert.equal(f.bot.entity.pitch, oldPitch, 'the view outside the use packet belongs to its current owner')
  assert.deepEqual(f.slots, [])
})

test('the owned self-launch still respects a cancelled or defending body at the packet boundary', async () => {
  const f = fixture()
  let allowed = true
  const pending = fireWind(f.bot, () => requested, { packetAim: true, canFire: () => allowed })
  f.bot.emit('physicsTick'); allowed = false; f.bot.emit('ndMovementSent')
  assert.equal((await pending).fired, false)
  assert.deepEqual(f.shots, [])
  assert.deepEqual(f.slots, [])
})

test('native wind cooldown survives body catch-up, world transition and Paper death until the server clears it', async t => {
  const f = fixture(), clock = activate(new GameClock({ manual: true }))
  t.after(() => clock.dispose())
  install(f.bot)
  const cooldown = cooldownTicks => f.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks })
  cooldown(10)
  // The body can process ten predicted frames before ten native cooldown ticks have elapsed.
  clock.ticks += 10
  f.bot.emit('respawn')
  assert.equal(windReady(f.bot), false)
  assert.equal((await fireWind(f.bot, () => requested, { immediate: true })).fired, false)
  assert.equal(f.shots.length, 0)
  cooldown(0)
  assert.equal(windReady(f.bot), true)
  assert.equal((await fireWind(f.bot, () => requested, { immediate: true })).fired, true)
  assert.equal(windReady(f.bot), false, 'a just-sent use retains its fallback until the first acknowledgement')
  cooldown(0)
  assert.equal(windReady(f.bot), true, 'a negative server confirmation clears the optimistic fallback')
  cooldown(10)
  f.bot.emit('death')
  f.bot.emit('respawn')
  clock.ticks += 10
  assert.equal(windReady(f.bot), false, 'Paper respawns the same server player with its cooldown')
  cooldown(0)
  assert.equal(windReady(f.bot), true)
  cooldown(10)
  f.bot.emit('end')
  assert.equal(f.bot._client.listenerCount('set_cooldown'), 0)
  assert.equal(windReady(f.bot), true, 'the closed session releases its local state')
})

test('a native cooldown starting after aim prevents the pending wind release', async t => {
  const f = fixture(), clock = activate(new GameClock({ manual: true }))
  t.after(() => clock.dispose())
  install(f.bot)
  const pending = fireWind(f.bot, () => requested, { immediate: true })
  f.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 })
  assert.equal((await pending).fired, false)
  assert.equal(f.shots.length, 0)
  assert.deepEqual(f.slots, [])
})
