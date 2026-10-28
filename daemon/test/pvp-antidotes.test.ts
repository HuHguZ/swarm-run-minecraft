import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chooseAntidote, ownAntidoteState, antidoteReport, antidoteTurn, finishAntidote } from '../src/pvp/antidotes'
import { healTurn } from '../src/pvp/turn-heal'

const effect = (name: string, remainingTicks = 200, amplifier = 0) => ({ name, remainingTicks, amplifier })
const state = (effects: any[], extra: any = {}) => ({ health: 16, maxHealth: 20, absorption: 0, burning: false,
  effects, inventory: { honey_bottle: 1, milk_bucket: 1 }, ...extra })

function scene() {
  let now = 10000
  const bot: any = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.entity = { id: 1, effects: {}, metadata: [], onGround: true }
  bot.health = 16; bot.ndClock = { now: () => now }
  const items: any[] = [{ name: 'honey_bottle', count: 1, slot: 36 }, { name: 'milk_bucket', count: 1, slot: 37 }]
  bot.inventory = { items: () => items }
  ownAntidoteState(bot)
  const add = (name: string, duration = 200, amplifier = 0) => {
    const id = bot.registry.effectsByName[name].id, fx = { id, duration, amplifier }
    bot.entity.effects[id] = fx; bot.emit('entityEffect', bot.entity, fx)
  }
  const remove = (name: string) => {
    const id = bot.registry.effectsByName[name].id, fx = bot.entity.effects[id]
    delete bot.entity.effects[id]; bot.emit('entityEffectEnd', bot.entity, fx)
  }
  let calls = 0, held = 0
  const ctx: any = { bot, ctl: { aborted: false }, st: {}, clear() {}, pathTo() {}, used() {},
    holdWeapon: async () => { held++ }, consumeItem: async (item, abort) => {
      calls++; assert.equal(bot._ndAntidoteDrinking.item, item.name); assert.equal(abort(), false)
      item.count--; remove('Poison'); return true
    } }
  return { bot, items, ctx, add, remove, advance: (ticks: number) => { now += ticks * 50 }, calls: () => calls, held: () => held }
}

test('selective honey beats milk when Poison removal preserves valuable own buffs', () => {
  const x = state([effect('poison', 250), effect('strength', 600), effect('fire_resistance', 600)], { burning: true })
  const pick = chooseAntidote(x)
  assert.equal(pick?.item, 'honey_bottle'); assert.equal(pick?.drinkTicks, 40)
  assert.equal(pick?.buffLoss, 0); assert.ok(pick!.savedHp > 0 && pick!.utility > 0)
})

test('milk prices combined Wither Slowness Weakness and can beat buff loss', () => {
  const pick = chooseAntidote(state([effect('wither', 400, 1), effect('slowness', 200, 2), effect('weakness', 200, 1), effect('speed', 80)]))
  assert.equal(pick?.item, 'milk_bucket'); assert.equal(pick?.drinkTicks, 32)
  assert.ok(pick!.buffLoss > 0); assert.ok(pick!.savedHp > 0 && pick!.tempoGain > 0)
  assert.equal(chooseAntidote(state([effect('weakness')], { inventory: { honey_bottle: 1, milk_bucket: 0 } })), null)
})

test('short remaining effects and delayed delivery are priced below ordinary action', () => {
  assert.equal(chooseAntidote(state([effect('poison', 20), effect('weakness', 20)])), null)
  assert.ok(chooseAntidote(state([effect('poison', 100)])))
  assert.equal(chooseAntidote(state([effect('poison', 100)], { deliveryTicks: 100 })), null)
  assert.equal(chooseAntidote(state([effect('wind_charged', 1000)])), null)
})

test('real PascalCase effect receipt ages in own game time; old raw duration stays unknown', () => {
  const s = scene(); s.add('Poison', 80); s.advance(30)
  const own = ownAntidoteState(s.bot)
  assert.equal(own.effects.find(x => x.name === 'poison')?.remainingTicks, 50)
  const id = s.bot.registry.effectsByName.Wither.id
  s.bot.entity.effects[id] = { id, duration: 500, amplifier: 0 }
  assert.equal(ownAntidoteState(s.bot).effects.find(x => x.name === 'wither')?.remainingTicks, null)
  s.bot.emit('respawn')
  assert.equal(ownAntidoteState(s.bot).effects.find(x => x.name === 'poison')?.remainingTicks, null)
  s.bot.emit('end'); assert.equal(s.bot.listenerCount('entityEffect'), 0)
})

test('report quotes delayed supply without pretending an item is owned', () => {
  const s = scene(); s.add('Wither', 400); s.items.length = 0
  const report = antidoteReport(s.bot, { damagePerTick: .01 })
  assert.equal(report.choice, null); assert.equal(report.state.inventory.milk_bucket, 0)
  assert.equal(report.need?.item, 'milk_bucket'); assert.ok(report.need!.utility > 0)
  assert.equal(report.using, false)
})

test('turn uses house consume and confirms decrement plus effect removal without enemy HP', async () => {
  const s = scene(); s.add('Poison', 250); s.add('Strength', 400)
  s.ctx.entity = Object.defineProperty({}, 'health', { get() { throw Error('enemy HP leak') } })
  const acted = await antidoteTurn(s.ctx, {})
  assert.equal(acted, true); assert.equal(s.calls(), 1); assert.equal(s.held(), 1)
  assert.equal(s.ctx.st.antidote.consumed, true); assert.equal(s.ctx.st.antidote.cleared, true)
  assert.equal(s.bot._ndAntidoteDrinking, undefined)
})

test('STOP, interrupted use and wrong item never report a cleanse or clear FR cache', async () => {
  const s = scene(); s.add('Poison', 250); s.bot._ndFrUntil = 999999
  s.ctx.ctl.aborted = true
  assert.equal(await antidoteTurn(s.ctx, {}), false); assert.equal(s.calls(), 0)
  s.ctx.ctl.aborted = false
  s.ctx.consumeItem = async () => false
  assert.equal(await antidoteTurn(s.ctx, {}), false); assert.equal(s.bot._ndFrUntil, 999999)
  s.ctx.consumeItem = async () => { s.items[1].count--; return true }
  assert.equal(await antidoteTurn(s.ctx, {}), false); assert.equal(s.ctx.st.antidote.cleared, false)
  assert.equal(s.bot._ndAntidoteDrinking, undefined)
})

test('confirmed milk invalidates only FR clock; honey and false receipts preserve it', () => {
  const s = scene(); s.bot._ndFrUntil = 999999; s.bot.kitAppleAt = 123
  finishAntidote(s.bot, 'milk_bucket', false); assert.equal(s.bot._ndFrUntil, 999999)
  finishAntidote(s.bot, 'honey_bottle', true); assert.equal(s.bot._ndFrUntil, 999999)
  finishAntidote(s.bot, 'milk_bucket', true); assert.equal(s.bot._ndFrUntil, 0)
  assert.equal(s.bot.kitAppleAt, 123)
})

test('own death during consume cannot turn inventory loss into successful milk', async () => {
  const s = scene(); s.add('Wither', 400); s.items[0].count = 0; s.bot._ndFrUntil = 999999
  s.ctx.consumeItem = async () => { s.bot.emit('death'); s.bot.health = 0; s.items[1].count = 0; return true }
  assert.equal(await antidoteTurn(s.ctx, {}), false); assert.equal(s.bot._ndFrUntil, 999999)
  assert.equal(s.held(), 0); assert.equal(s.bot._ndAntidoteDrinking, undefined)
})

test('healTurn takes the house antidote path before its ordinary healing branches', async () => {
  const s = scene(); s.add('Poison', 250); s.add('Strength', 400)
  assert.equal(await healTurn(s.ctx, {} as any), 'next')
  assert.equal(s.calls(), 1); assert.equal(s.ctx.st.antidote.cleared, true)
})

test('a ready reachable ordinary hit is priced above drinking; distant contact lowers that price', async () => {
  const s = scene(); s.add('Poison', 250); s.add('Strength', 400)
  s.ctx.weapon = { name: 'diamond_sword' }; s.ctx.entity = Object.defineProperty({}, 'health', { get() { throw Error('enemy HP leak') } })
  assert.equal(await antidoteTurn(s.ctx, { seesBody: true, r: 2.5, meleeDmg: 7 }), false)
  assert.equal(s.calls(), 0)
  assert.equal(await antidoteTurn(s.ctx, { seesBody: true, r: 20, meleeDmg: 7 }), true)
  assert.equal(s.calls(), 1)
})

test('confirmed consumption without a removal receipt does not claim an effect clear', async () => {
  const s = scene(); s.add('Wither', 400, 1); s.items[0].count = 0; s.bot._ndFrUntil = 999999
  s.ctx.pvpSkills = { consumeItem: async item => { item.count--; return true } }; delete s.ctx.consumeItem
  assert.equal(await antidoteTurn(s.ctx, {}), true)
  assert.equal(s.bot._ndFrUntil, 0); assert.equal(s.ctx.st.antidote.consumed, true)
  assert.equal(s.ctx.st.antidote.cleared, false)
})
