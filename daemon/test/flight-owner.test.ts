import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as L from '../src/combat/aerial-lance'
import sky = require('../src/elytra')
import flight = require('../src/elytra/flight')

test('новый полёт отзывает руль фоновой посадки отменённого тарана', async t => {
  const bot: any = new EventEmitter(), spear = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
  bot.entity = { id: 1, position: new Vec3(.5, 110, .5), velocity: new Vec3(.6, 0, 0), elytraFlying: true, onGround: false }
  bot.health = 20; bot.heldItem = spear
  bot.inventory = { items: () => [spear, rocket], slots: [] }
  bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
  bot._client = new EventEmitter(); bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
  bot.fireworkRocketDuration = 0; bot.activateItem = () => {}; bot.deactivateItem = () => {}
  bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' })
  let looks = 0, chest = 0
  bot.look = async () => { looks++ }
  t.mock.method(flight, 'chestDown', async () => { chest++; return { ok: true } })
  const enemy = { id: 2, type: 'player', username: 'foe', position: new Vec3(5, 100, .5), onGround: true, isValid: true }
  await L.lance(bot, { aborted: true }, enemy, { passes: 1, telemetryHp: () => null })
  assert.equal(bot._ndElytra.driving, 1)
  const current = { aborted: false }
  const done = sky.fly(bot, current, { goal: { kind: 'point', at: new Vec3(30, 110, .5) }, noRocket: () => true })
  try {
    bot.emit('physicsTick')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(looks, 1)
    assert.equal(bot._ndElytra.driving, 1)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(chest, 0)
  } finally {
    bot.health = 0; bot.emit('physicsTick'); await done
    await new Promise(resolve => setTimeout(resolve, 350))
  }
})

test('chest swap cannot send use_item after its flight owner is revoked', async () => {
  for (const hand of ['main', 'off']) for (const revoke of [false, true]) {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const item = { name: 'diamond_chestplate', count: 1, slot: 10 }
    const slots: any[] = []
    slots[6] = { name: 'elytra' }; slots[10] = item
    let activated = 0
    const bot: any = {
      health: 20, _ndElytra: {}, quickBarSlot: 1, currentWindow: null,
      inventory: { slots, items: () => [item] },
      moveSlotItem: async (from, to) => {
        await pending
        slots[to] = item; slots[from] = null
      },
      equip: async (selected, destination) => {
        await pending
        slots[destination === 'off-hand' ? 45 : 36 + bot.quickBarSlot] = selected
        slots[selected.slot] = null
      },
      setQuickBarSlot: i => { bot.quickBarSlot = i },
      activateItem: () => { activated++; slots[6] = item }
    }
    Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })
    const old = sky.flightControl(bot, { aborted: false })
    const done = sky.swapChest(bot, 'chest', { hand, ctl: old, waitMs: 0 })
    if (revoke) sky.flightControl(bot, { aborted: false })
    release()
    const result = await done
    assert.equal(result.ok, !revoke, hand)
    assert.equal(activated, revoke ? 0 : 1, hand)
    if (revoke) assert.equal(result.why, 'flight_superseded')
  }
})

for (const replace of [false, true]) test(`fly_to stops a pending chest swap after ${replace ? 'another flight takes ownership' : 'its intent is cancelled'}`, async t => {
  const { bot, parent, counters, run } = rpcFlight(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  bot.moveSlotItem = async (from, to) => {
    entered(); await pending
    bot.inventory.slots[to] = bot.inventory.slots[from]; bot.inventory.slots[from] = null
  }
  const done = run()
  await waiting
  if (replace) sky.flightControl(bot, { aborted: false })
  else parent.aborted = true
  release()
  const result = await done
  assert.equal(result.ok, false)
  assert.match(result.why, /flight_superseded/)
  assert.deepEqual(counters, { use: 0, glide: 0, route: 0 })
})

test('fly_to leaves a newer flight equipment alone after its route returns', async t => {
  const { bot, counters, run } = rpcFlight(t, () => { sky.flightControl(bot, { aborted: false }) })
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.entity.elytraFlying = true
  const result = await run()
  assert.equal(result.ok, false)
  assert.match(result.why, /flight_superseded/)
  assert.equal(bot.inventory.slots[6].name, 'elytra')
  assert.deepEqual(counters, { use: 0, glide: 0, route: 1 })
})

test('fly_to still restores armour after its own completed route', async t => {
  const { bot, counters, run } = rpcFlight(t)
  const result = await run()
  assert.equal(result.ok, true)
  assert.equal(bot.inventory.slots[6].name, 'iron_chestplate')
  assert.deepEqual(counters, { use: 2, glide: 1, route: 1 })
})

test('an already cancelled fly_to cannot revoke another flight before equipment preparation', async t => {
  const { bot, parent, counters, run } = rpcFlight(t)
  const current = sky.flightControl(bot, { aborted: false })
  parent.aborted = true
  const result = await run()
  assert.equal(result.ok, false)
  assert.equal(current.aborted, false)
  assert.deepEqual(counters, { use: 0, glide: 0, route: 0 })
})

function rpcFlight(t: any, afterRoute = () => {}) {
  const bot: any = new EventEmitter(), parent = { aborted: false }
  const counters = { use: 0, glide: 0, route: 0 }, slots: any[] = []
  const chest = { name: 'iron_chestplate', slot: 6 }, elytra = { name: 'elytra', slot: 10 }
  slots[6] = chest; slots[10] = elytra; slots[36] = { name: 'iron_spear' }
  Object.assign(bot, { health: 20, _ndElytra: {}, quickBarSlot: 0, currentWindow: null,
    entity: { position: new Vec3(.5, 120, .5), onGround: false, elytraFlying: false },
    inventory: { slots, items: () => slots.filter(Boolean) },
    moveSlotItem: async (from, to) => { slots[to] = slots[from]; slots[from] = null },
    setQuickBarSlot: i => { bot.quickBarSlot = i },
    activateItem: () => { counters.use++; const i = 36 + bot.quickBarSlot; [slots[6], slots[i]] = [slots[i], slots[6]] }
  })
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 20 }))
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ solid: (_x, y) => y < 120,
    boxHit: () => false, floorBelow: () => ({ top: 120 }) }))
  t.mock.method(require('../src/elytra/install'), 'startGlide', () => { counters.glide++; bot.entity.elytraFlying = true; return true })
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async () => {
    counters.route++; bot.entity.elytraFlying = false; bot.entity.onGround = true
    afterRoute()
    return { ok: true }
  })
  const session: any = { require: () => bot, runIntent: (_name, action) => action(parent) }
  const run = () => require('../src/rpc/aerial').aerialMethods({ session }).fly_to({ at: { x: 20.5, y: 120, z: .5 } })
  return { bot, parent, counters, run }
}
