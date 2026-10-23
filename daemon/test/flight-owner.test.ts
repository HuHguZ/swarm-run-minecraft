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
      equip: async () => { await pending },
      setQuickBarSlot: i => { bot.quickBarSlot = i },
      activateItem: () => { activated++; slots[6] = item }
    }
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
