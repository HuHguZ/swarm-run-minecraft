import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as clock from '../src/game-clock'
import { swapChest } from '../src/elytra/kit'
import { installFallGuard } from '../src/edges/mlg'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function fixture(t, rate = 20) {
  let wallMs = 0
  t.mock.method(clock.wall, 'monotonic', () => wallMs)
  const producer = new clock.GameClock({ epoch: 0 })
  producer.setState({ tick_rate: rate }); producer.syncAge(500n); clock.activate(producer)
  const item = { name: 'elytra', count: 1, slot: 36 }, slots: any[] = []
  slots[36] = item
  const bot: any = Object.assign(new EventEmitter(), { ndClock: producer, _client: new EventEmitter(), quickBarSlot: 0,
    entity: { onGround: true, velocity: { y: -.0784 } }, heldItem: item,
    inventory: { slots, items: () => slots[36] ? [slots[36]] : [] },
    uses: 0, activateItem() { this.uses++ }, usingHeldItem: false })
  producer.attach(bot)
  t.after(() => { producer.dispose(); clock.activate(null) })
  return { producer, bot, at: n => { wallMs = n }, ack: () => { slots[6] = item; slots[36] = null; bot.heldItem = null } }
}

test('new equipment use keeps its observation budget when native world-age catchup consumes 15 old ticks', async t => {
  const f = fixture(t)
  // Native GameClock has a confirmed backlog before this new action. pulse()
  // reconciles it without replaying body physics, as in I31o's +750game/38wall.
  f.producer.syncAge(515n)
  let result: any
  const pending = swapChest(f.bot, 'elytra').then(r => { result = r; return r })
  await flush(); assert.equal(f.bot.uses, 1)
  f.at(38); f.producer.pulse(); await flush()
  const premature = result
  f.at(100); f.ack(); f.producer.pulse(); await flush()
  const outcome = await pending
  assert.equal(premature, undefined, '38ms after a new use is not an expired 400 nominal-ms budget')
  assert.equal(outcome.ok, true, 'native slot readiness arrives inside the actual observation budget')
})

for (const rate of [5, 20, 40]) test(`equipment timeout retains 400 nominal game-ms at confirmed ${rate} TPS`, async t => {
  const f = fixture(t, rate)
  let result: any
  const pending = swapChest(f.bot, 'elytra').then(r => { result = r; return r })
  await flush()
  const deadline = 400 * 20 / rate
  f.at(deadline - 1); f.producer.syncAge(508n); f.producer.pulse(); await flush()
  const premature = result
  f.at(deadline + 1); f.producer.pulse(); await flush()
  const outcome = await pending
  assert.equal(premature, undefined, 'the confirmed age jump does not shorten the new action budget')
  assert.deepEqual(outcome, { ok: false, why: 'сервер не надел' })
})

test('equipment ack inside the budget still succeeds without a world-age catchup', async t => {
  const f = fixture(t)
  const pending = swapChest(f.bot, 'elytra')
  await flush(); f.at(100); f.ack(); f.producer.pulse(); await flush()
  assert.equal((await pending).ok, true)
})

for (const change of ['respawn', 'clock', 'abort']) test(`equipment wait ends safely on ${change}`, async t => {
  const f = fixture(t), ctl = { aborted: false }
  let result: any
  const pending = swapChest(f.bot, 'elytra', { ctl }).then(r => { result = r; return r })
  await flush()
  if (change === 'respawn') { f.bot.emit('respawn'); f.producer.syncAge(500n) }
  if (change === 'clock') f.bot.ndClock = new clock.GameClock({ epoch: 0 })
  if (change === 'abort') ctl.aborted = true
  f.at(50); f.producer.pulse(); await flush()
  const completed = result
  // Keep the pre-fix RED finite: this is cleanup, not simulated readiness.
  f.at(500); f.producer.advanceTicks(9); await flush(); await pending
  if (change === 'clock') f.bot.ndClock.dispose()
  assert.equal(completed?.ok, false, 'an obsolete wait must resolve at its next existing clock turn')
  assert.equal(completed?.why, change === 'abort' ? 'flight_superseded' : 'world_changed')
  assert.equal(f.bot.listenerCount('respawn'), 1, 'only the native clock lifecycle listener remains')
})

function safetyHand(t, holdMs) {
  const f = fixture(t), slots = f.bot.inventory.slots, calls: any[] = []
  const chest = { name: 'netherite_chestplate', count: 1, slot: 36 }
  slots[6] = { name: 'elytra' }; slots[36] = chest; slots[38] = { name: 'diamond_spear', count: 1, slot: 38 }
  f.bot.quickBarSlot = 2
  Object.defineProperty(f.bot, 'heldItem', { get: () => slots[36 + f.bot.quickBarSlot], configurable: true })
  f.bot.setQuickBarSlot = slot => { f.bot.quickBarSlot = slot; calls.push({ kind: 'slot', at: clock.now() }) }
  f.bot.equip = async item => { f.bot.setQuickBarSlot(item.slot - 36) }
  f.bot.activateItem = off => {
    const used = off ? slots[45] : f.bot.heldItem
    calls.push({ kind: 'use', held: used?.name, off: !!off, at: clock.now() })
    if (used?.name === chest.name) { slots[6] = chest; slots[off ? 45 : 36] = { name: 'elytra' } }
  }
  t.mock.method(console, 'log', () => {})
  installFallGuard({ bot: f.bot })
  const hand = f.bot._ndHandLock
  hand.hold(holdMs)
  return { ...f, calls, hand }
}
async function physicalTicks(f, start, ticks) {
  for (let i = start + 1; i <= start + ticks; i++) {
    f.at(i * 50); f.producer.syncAge(500n + BigInt(i)); f.producer.pulse(); await flush()
  }
}

test('chest preparation waits for actual MLG hand release, preserving safety priority before the use', async t => {
  const f = safetyHand(t, 250), pending = swapChest(f.bot, 'chest')
  await flush(); await physicalTicks(f, 0, 4)
  assert.equal(f.calls.length, 0, 'active MLG ownership keeps both the slot and use')
  await physicalTicks(f, 4, 6)
  assert.equal((await pending).ok, true)
  const uses = f.calls.filter(x => x.kind === 'use')
  assert.equal(uses.length, 1); assert.equal(uses[0].held, 'netherite_chestplate')
  assert.ok(uses[0].at >= 250)
  assert.equal(f.hand.blocked.slot, 0); assert.equal(f.hand.blocked.use, 0)
})

test('continuous MLG ownership returns a bounded preparation refusal without attempting another use', async t => {
  const f = safetyHand(t, 1000), pending = swapChest(f.bot, 'chest')
  await flush(); await physicalTicks(f, 0, 10)
  assert.deepEqual(await pending, { ok: false, why: 'рука занята спасением' })
  assert.equal(f.calls.length, 0)
})

test('abort while MLG holds the hand prevents deferred slot selection and use', async t => {
  const f = safetyHand(t, 250), ctl = { aborted: false }, pending = swapChest(f.bot, 'chest', { ctl })
  await flush(); await physicalTicks(f, 0, 2); ctl.aborted = true
  await physicalTicks(f, 2, 8)
  assert.deepEqual(await pending, { ok: false, why: 'flight_superseded' })
  assert.equal(f.calls.length, 0)
})

test('unavailable actual selected item is detected before item activation', async t => {
  const f = safetyHand(t, 0)
  t.mock.method(f.bot, 'setQuickBarSlot', () => {})
  const pending = swapChest(f.bot, 'chest')
  await flush(); await physicalTicks(f, 0, 10)
  assert.deepEqual(await pending, { ok: false, why: 'нужный предмет не в руке' })
  assert.equal(f.calls.filter(x => x.kind === 'use').length, 0)
})

test('unlocked main hand keeps the immediate slot/use path', async t => {
  const f = safetyHand(t, 0)
  let result: any
  const pending = swapChest(f.bot, 'chest').then(r => { result = r; return r })
  await flush()
  assert.equal(result?.ok, true)
  assert.equal(f.calls.filter(x => x.kind === 'slot').length, 1)
  assert.equal(f.calls.filter(x => x.kind === 'use').length, 1)
  await pending
})

test('offhand chest use retains the native MLG permission while the main hand stays locked', async t => {
  const f = safetyHand(t, 1000), slots = f.bot.inventory.slots
  slots[45] = { name: 'netherite_chestplate', count: 1, slot: 45 }; slots[36] = null
  const pending = swapChest(f.bot, 'chest', { hand: 'off' })
  await flush()
  assert.equal((await pending).ok, true)
  assert.equal(f.bot.quickBarSlot, 2)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].off, true)
  assert.equal(f.hand.blocked.use, 0)
})

for (const change of ['respawn', 'clock', 'abort']) test(`obsolete hand preparation cannot select or use after ${change}`, async t => {
  const f = safetyHand(t, 250), ctl = { aborted: false }, pending = swapChest(f.bot, 'chest', { ctl })
  await flush(); await physicalTicks(f, 0, 2)
  if (change === 'respawn') { f.bot.emit('respawn'); f.producer.syncAge(500n) }
  if (change === 'clock') f.bot.ndClock = new clock.GameClock({ epoch: 0 })
  if (change === 'abort') ctl.aborted = true
  await physicalTicks(f, 2, 8)
  assert.equal((await pending).why, change === 'abort' ? 'flight_superseded' : 'world_changed')
  assert.equal(f.calls.length, 0)
  if (change === 'clock') f.bot.ndClock.dispose()
})
