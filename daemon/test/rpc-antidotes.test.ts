import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { eat } from '../src/actions/food'
import { Vec3 } from '../src/pvp/vec3'
import { ownAntidoteState, chooseAntidote } from '../src/pvp/antidotes'
import { antidoteMethods } from '../src/rpc/antidotes'

function body(name = 'honey_bottle') {
  const bot: any = new EventEmitter()
  const sword = { name: 'iron_sword', type: 1, count: 1 }
  const drink = { name, type: 2, count: 1 }
  const slots: any[] = []; slots[36] = sword; slots[10] = drink
  let use = 0
  Object.assign(bot, { health: 20, food: 20, heldItem: sword, entity: { id: 1, onGround: false, effects: {}, position: new Vec3(0, 151, 0) },
    registry: { effects: { 18: { name: 'Poison', id: 18 }, 19: { name: 'Wither', id: 19 } }, effectsByName: {}, entitiesByName: {} },
    entities: {}, ndClock: { now: () => Date.now() }, blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }),
    inventory: { slots, items: () => [sword, drink].filter(i => i.count > 0), emptySlotCount: () => 10 },
    equip: async (item: any) => { bot.heldItem = item },
    consume: async () => { if (bot.food === 20) throw new Error('Food is full'); bot.activateItem() },
    activateItem: () => { use++; drink.count-- }, deactivateItem: () => {} })
  return { bot, sword, drink, uses: () => use, session: { bot, mcData: { foodsByName: { honey_bottle: {} } }, current: { ctl: { aborted: false } } } }
}

function rpcBody(name = 'honey_bottle', effect = 18) {
  const f = body(name)
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
  const session: any = { ...f.session, eating: false, current: { ctl }, require: () => f.bot,
    runIntent: async (_name: string, worker: any) => worker(ctl) }
  ownAntidoteState(f.bot)
  const fx = { id: effect, amplifier: 3, duration: 3000 }
  f.bot.entity.effects[effect] = fx
  f.bot.emit('entityEffect', f.bot.entity, fx)
  return { ...f, ctl, session, call: (p: any = {}) => antidoteMethods({ session }).antidote(p) }
}

function visibleFoe(f: ReturnType<typeof rpcBody>) {
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true, position: new Vec3(0, 151, 5), metadata: [], equipment: [{ name: 'diamond_sword' }], height: 1.8, width: .6 }
  Object.defineProperty(foe, 'health', { get() { throw new Error('opponent health is private') } })
  f.bot.entities[2] = foe
  return foe
}

test('full-food honey uses native activation, confirms its spent bottle and restores the weapon', async () => {
  const f = body()
  const r = await eat(f.session, { item: 'honey_bottle' })
  assert.equal(r.ate, 'honey_bottle')
  assert.equal(r.spent, 1)
  assert.equal(f.uses(), 1)
  assert.equal(f.bot.heldItem, f.sword)
  assert.equal(f.bot.food, 20)
})

test('a STOP while equipping honey cannot send a new use packet', async () => {
  const f = body()
  f.bot.food = 16
  f.bot.equip = async (item: any) => { f.bot.heldItem = item; f.session.current.ctl.aborted = true }
  await eat(f.session, { item: 'honey_bottle' })
  assert.equal(f.uses(), 0)
  assert.equal(f.drink.count, 1)
})

test('antidote RPC is available through the swarm factory with a bounded, cancellable intent', async () => {
  const { swarmMethods } = require('../src/rpc/swarm')
  let call: any = null
  const methods = swarmMethods({ session: { runIntent: (name: string, worker: any, options: any) => { call = { name, worker, options }; return 'scheduled' } } })
  assert.equal(typeof methods.antidote, 'function')
  assert.equal(await methods.antidote({ item: 'milk_bucket' }), 'scheduled')
  assert.equal(call.name, 'antidote')
  assert.ok(call.options.timeoutMs >= 4000 && call.options.timeoutMs <= 10000)
  assert.deepEqual(call.options.interruptOn, ['death', 'kicked', 'disconnected'])
})

test('own honey RPC consumes at full food and returns real before/after effect receipts', async () => {
  const f = rpcBody()
  const nativeUse = f.bot.activateItem
  f.bot.activateItem = () => { nativeUse(); delete f.bot.entity.effects[18] }
  const r = await f.call({ item: 'honey_bottle' })
  assert.equal(r.consumed, true)
  assert.equal(r.before[0].name, 'poison')
  assert.deepEqual(chooseAntidote(JSON.parse(JSON.stringify(r.quoteState))), r.choice)
  assert.deepEqual(r.after, [])
  assert.equal(f.bot.heldItem, f.sword)
  assert.equal(f.bot._ndAntidoteDrinking, undefined)
  assert.equal(f.session.eating, false)
})

test('interrupted milk has no consumption receipt and preserves the own fire-resistance clock', async () => {
  const f = rpcBody('milk_bucket', 19)
  f.bot._ndFrUntil = Date.now() + 10000
  f.bot.consume = async () => { f.ctl.abort() }
  const before = f.bot._ndFrUntil
  const r = await f.call({ item: 'milk_bucket' })
  assert.equal(r.consumed, false)
  assert.equal(f.drink.count, 1)
  assert.equal(f.bot._ndFrUntil, before)
  assert.equal(f.bot._ndAntidoteDrinking, undefined)
})

test('death inventory loss and a later live health packet cannot masquerade as consumed milk', async () => {
  const f = rpcBody('milk_bucket', 19)
  f.bot._ndFrUntil = Date.now() + 10000
  const before = f.bot._ndFrUntil
  f.bot.consume = async () => { f.bot.health = 0; f.bot.emit('death'); f.drink.count = 0; f.bot.health = 20 }
  const r = await f.call({ item: 'milk_bucket' })
  assert.equal(r.consumed, false)
  assert.equal(f.bot._ndFrUntil, before)
})

test('confirmed milk clears its own cached fire resistance after actual item depletion', async () => {
  const f = rpcBody('milk_bucket', 19)
  f.bot._ndFrUntil = Date.now() + 10000
  f.bot.consume = async () => { f.drink.count--; f.bot.entity.effects = {} }
  const r = await f.call({ item: 'milk_bucket' })
  assert.equal(r.consumed, true)
  assert.equal(f.bot._ndFrUntil, 0)
})

test('requested antidote does not force consumption without a worthwhile own negative effect', async () => {
  const f = rpcBody()
  f.bot.entity.effects = {}
  const r = await f.call({ item: 'honey_bottle' })
  assert.equal(r.consumed, false)
  assert.equal(f.uses(), 0)
})

test('refusing a busy body cannot release its existing bow use', async () => {
  const f = rpcBody()
  let releases = 0
  f.bot._ndUse = { cur: { name: 'bow' } }
  f.bot.deactivateItem = () => { releases++ }
  const r = await f.call()
  assert.equal(r.consumed, false)
  assert.equal(releases, 0)
})

test('a new visible direct threat cancels a pending sip without consuming it', async () => {
  const f = rpcBody()
  f.bot.activateItem = () => {
    f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true, position: new Vec3(0, 151, 2), metadata: [], equipment: [{ name: 'diamond_sword' }], height: 1.8, width: .6 }
    f.bot.emit('physicsTick')
  }
  const r = await f.call({ item: 'honey_bottle', allies: [] })
  assert.equal(r.consumed, false)
  assert.equal(r.why, 'new_direct_threat')
  assert.equal(f.drink.count, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.ctl.onAbort.length, 0)
})

test('a requested milk bucket still loses the price comparison when own Strength is more valuable', async () => {
  const f = rpcBody('milk_bucket', 19)
  f.bot.registry.effects[4] = { name: 'Strength', id: 4 }
  const strength = { id: 4, amplifier: 1, duration: 3000 }
  f.bot.entity.effects[4] = strength; f.bot.emit('entityEffect', f.bot.entity, strength)
  const r = await f.call({ item: 'milk_bucket' })
  assert.equal(r.consumed, false)
  assert.equal(f.drink.count, 1)
})

test('a cover name with an inactive shield cannot hide an imminent visible threat', async () => {
  const f = rpcBody(); visibleFoe(f)
  f.bot.entities[3] = { id: 3, type: 'player', username: 'Guard', position: new Vec3(0, 151, 2.5), metadata: [], equipment: [null, { name: 'shield' }], yaw: Math.PI }
  const r = await f.call({ item: 'honey_bottle', cover: 'Guard', allies: ['Guard'], enemies: ['Foe'] })
  assert.equal(r.consumed, false)
  assert.equal(f.uses(), 0)
})

test('a priced refusal exposes the exact serializable own-state input for replay', async () => {
  const f = rpcBody(); visibleFoe(f)
  const r = await f.call({ item: 'honey_bottle', enemies: ['Foe'] })
  assert.equal(r.why, 'not_worth_consuming')
  assert.equal(r.consumed, false)
  const quoted = JSON.parse(JSON.stringify(r.quoteState))
  assert.equal(quoted.health, 20)
  assert.deepEqual(quoted.inventory, { honey_bottle: 1 })
  assert.equal(quoted.effects[0].name, 'poison')
  assert.ok(quoted.exposurePerTick > 0)
  assert.equal(quoted.damagePerTick, undefined, 'the RPC leaves the selector default unchanged')
  assert.equal(chooseAntidote(quoted), null)
  assert.equal(chooseAntidote({ ...quoted, exposurePerTick: 0 })?.item, 'honey_bottle')
  assert.equal(f.uses(), 0)
})

test('loss of an actual visible shield overlap cancels its paid drinking window', async () => {
  const f = rpcBody(); visibleFoe(f)
  f.bot.registry.entitiesByName.player = { metadataKeys: ['', '', '', '', '', '', 'pose', '', 'living_entity_flags'] }
  const guard = { id: 3, type: 'player', name: 'player', username: 'Guard', position: new Vec3(0, 151, 2.5), metadata: [], equipment: [null, { name: 'shield' }], yaw: Math.PI }
  guard.metadata[8] = 3; f.bot.entities[3] = guard
  f.bot.activateItem = () => { guard.metadata[8] = 0; f.bot.emit('physicsTick') }
  const r = await f.call({ item: 'honey_bottle', cover: 'Guard', allies: ['Guard'], enemies: ['Foe'] })
  assert.equal(r.covered, true)
  assert.equal(r.consumed, false)
  assert.equal(r.why, 'cover_lost')
})

test('an own physical clutch interrupts the sip and releases all RPC listeners', async () => {
  const f = rpcBody()
  f.bot.activateItem = () => { f.bot._ndHandLock = { on: () => true }; f.bot.emit('physicsTick') }
  const r = await f.call({ item: 'honey_bottle' })
  assert.equal(r.consumed, false)
  assert.equal(r.why, 'interrupted')
  assert.equal(f.bot._ndAntidoteDrinking, undefined)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('antidote pause checks drinking inside the delayed immediate worker before cancellation', async () => {
  const f = rpcBody(); let work: any, cancelled = 0
  f.session.immediate = (worker: any) => new Promise(resolve => { work = () => resolve(worker()) })
  f.session.cancel = () => { cancelled++ }
  const pending = antidoteMethods({ session: f.session }).antidote_pause()
  f.bot._ndAntidoteDrinking = { item: 'honey_bottle' }
  work()
  assert.deepEqual(await pending, { ready: false, why: 'drinking' })
  assert.equal(cancelled, 0)
})

test('antidote pause synchronously cancels a nonbusy body exactly once', async () => {
  const f = rpcBody(); const cancelled: string[] = []
  f.session.immediate = (worker: any) => Promise.resolve().then(worker)
  f.session.cancel = (why: string) => { cancelled.push(why) }
  assert.deepEqual(await antidoteMethods({ session: f.session }).antidote_pause(), { ready: true })
  assert.deepEqual(cancelled, ['antidote_transfer'])
})

test('antidote pause preserves actual hand lock, clutch and active rescue intents', async () => {
  for (const kind of ['hand', 'clutch', 'fly_to', 'pearl_to']) {
    const f = rpcBody(); let cancelled = 0
    f.session.immediate = (worker: any) => Promise.resolve().then(worker)
    f.session.cancel = () => { cancelled++ }
    if (kind === 'hand') f.bot._ndHandLock = { on: () => true }
    else if (kind === 'clutch') f.bot._ndClutch = { lastDecision: { action: 'clutch' } }
    else f.session.current = { name: kind, params: { rescue: true }, ctl: { aborted: false } }
    assert.deepEqual(await antidoteMethods({ session: f.session }).antidote_pause(), { ready: false, why: 'rescuing' })
    assert.equal(cancelled, 0)
  }
})
