import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { install } from '../src/melee'
import { release } from '../src/combat/wind-out'
import { strikeTurn } from '../src/pvp/turn-melee'

function fixture(t, brand = 'Paper') {
  const time = clock.activate(new clock.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter(), packets: any[] = []
  const slots = Array(46).fill(null)
  slots[36] = { name: 'netherite_sword', slot: 36, count: 1 }
  slots[37] = { name: 'wind_charge', slot: 37, count: 64 }
  slots[38] = { name: 'netherite_sword', slot: 38, count: 1, enchanted: true }
  Object.assign(bot, { game: { serverBrand: brand }, quickBarSlot: 0, health: 20,
    entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    inventory: { slots }, _client: new EventEmitter(), getControlState: () => false, supportFeature: () => false })
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })
  bot.updateHeldItem = () => bot.emit('heldItemChanged', bot.heldItem)
  bot._client.write = (name, data) => { packets.push({ name, data }); return 'sent' }
  bot.activateItem = off => bot._client.write('use_item', { hand: off ? 1 : 0 })
  // The real Mineflayer setter changes quickBarSlot, writes the packet, then updates the held item.
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  const M = install(bot)
  t.after(() => { bot.removeAllListeners(); bot._client.removeAllListeners(); time.dispose(); clock.activate(null) })
  return { bot, M, time, packets, wind: () => release(bot, { yaw: 0, pitch: 0 }) }
}

test('the actual Paper wind release resets sword charge even when no physics tick sees the changed hand', t => {
  const f = fixture(t)
  assert.equal(f.M.charge(), 1)
  assert.equal(f.wind(), true)
  assert.deepEqual(f.packets.map(p => [p.name, p.data.slotId ?? p.data.hand]),
    [['held_item_slot', 1], ['use_item', 0], ['held_item_slot', 0]])
  assert.equal(f.bot.heldItem.name, 'netherite_sword')
  assert.equal(f.M.charge(), .04, 'native sword→wind→sword resets to (.5 / 12.5), not full charge')
  f.time.advanceTicks(6)
  const partial = f.M.charge()
  f.bot.emit('physicsTick')
  assert.equal(f.M.charge(), partial, 'the next tick must not count the same held change twice')
  f.time.advanceTicks(7)
  assert.equal(f.M.charge(), 1)
})

test('same slot, same item type and invalid slot packets do not invent a Paper charge reset', t => {
  const f = fixture(t)
  assert.equal(f.bot._client.write('held_item_slot', { slotId: 0 }), 'sent')
  f.bot.setQuickBarSlot(2)
  assert.equal(f.M.charge(), 1, 'native isSameItem ignores enchantment/count differences of the same item type')
  for (const slotId of [-1, 9, 1.5]) f.bot._client.write('held_item_slot', { slotId })
  assert.equal(f.M.charge(), 1)
  f.bot.setQuickBarSlot(1)
  assert.equal(f.M.charge(), .1, 'a real different item type resets the wind hand too')
})

test('vanilla still samples same-tick held changes on its ordinary physics tick', t => {
  const f = fixture(t, 'vanilla')
  f.wind()
  assert.equal(f.M.charge(), 1)
  f.bot.setQuickBarSlot(1)
  assert.equal(f.M.charge(), 1)
  f.bot.emit('physicsTick')
  assert.equal(f.M.charge(), .1)
})

for (const edge of [false, true]) test(`an actual same-tick wind swap ${edge ? 'preserves the explicit edge knockback' : 'invalidates the ordinary ready strike'} guard`, async t => {
  const f = fixture(t), hits: number[] = []
  const ctx: any = { bot: f.bot, entity: { id: 2 }, weapon: f.bot.heldItem, prof: { player: true },
    mf: { clock: f.M, hit: () => hits.push(f.M.charge()) }, combo: { note() {} }, st: { swings: 0 },
    guard: { stats: { worn: false }, async raise() { f.wind() } }, ready: () => false, rest() {}, used() {}, hitKind: 'plain' }
  const turn: any = { now: f.time.now(), canHit: !edge, edgeHit: edge ? 'hit' : null, iframes: 0, r: 2, theirR: 4,
    inSight: true, intoShield: false, owMelee: false, cooldownLeft: edge ? 500 : 0, race: false, closing: 0 }
  await strikeTurn(ctx, turn)
  assert.deepEqual(hits, edge ? [.04] : [], 'only the explicit physical edge opportunity may keep its partial attack')
})
