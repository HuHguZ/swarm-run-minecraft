import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRecovery } from '../src/pvp/recovery'
const Vec3 = require('vec3')
const projectiles = require('../src/throw')
const registry = require('minecraft-data')('1.21.11')
const resistanceId = registry.effectsByName.Resistance.id
const fireResistanceId = registry.effectsByName.FireResistance.id

function fixture(hp = 7, name = 'ender_pearl') {
  const item = { name, type: 2, slot: 36, count: 1 }
  const bot: any = new EventEmitter()
  bot.health = hp
  bot.registry = registry
  bot.game = { gameMode: 'survival' }
  bot.entity = { type: 'player', position: new Vec3(0, 20, 0), onGround: false, metadata: [], effects: {} }
  bot.inventory = { slots: [], items: () => [item] }
  bot.heldItem = item
  bot.look = async () => {}
  bot.world = { raycast: () => null }
  const releases: number[] = []
  bot.activateItem = () => { releases.push(bot.health); item.count-- }
  const pick = () => ({ yaw: 1, pitch: 0, ticks: 10 })
  const ctx: Record<string, any> = { bot, entity: { position: new Vec3(2, 20, 0) }, aim: 'target',
    findItem: (_bot, predicate) => predicate(item) ? item : null, ready: () => true, rest() {},
    holdItem: async () => true, holdWeapon: async () => {}, used() {}, sleep: async () => {},
    tt: { threats: () => [] }, throwMod: { ...projectiles, escapePick: () => pick } }
  const aim = async () => { await Promise.resolve(); bot.emit('physicsTick'); bot.emit('physicsTick') }
  const release = () => bot.emit('ndMovementSent')
  return { bot, ctx, item, releases, pick, aim, release,
    throw: () => projectiles.throwAt(bot, null, { item, pick }), recovery: () => createRecovery(ctx).escapePearl() }
}

test('pearl release rejects damage received after aim, before the movement packet is sent', async () => {
  const f = fixture()
  const work = f.throw()
  await f.aim()
  assert.equal(f.releases.length, 0)
  f.bot.health = 4
  f.release()
  assert.equal((await work).thrown, false)
  assert.equal(f.item.count, 1)
  assert.deepEqual(f.releases, [])
})

test('the actual recovery caller refuses lethal HP learned while equipping its pearl', async () => {
  const f = fixture()
  f.ctx.holdItem = async () => { await Promise.resolve(); f.bot.health = 4; return true }
  const work = f.recovery()
  await Promise.resolve(); await f.aim()
  f.release()
  assert.equal(await work, null)
  assert.equal(f.ctx.aim, 'target')
  assert.equal(f.item.count, 1)
  assert.deepEqual(f.releases, [])
})

test('recovery prices actual pearl damage, including own enchantments and absorption', async () => {
  for (const state of [
    { hp: 6, expected: true }, { hp: 5, expected: false },
    { hp: 4, feather: 4, expected: true }, { hp: 4, absorption: 2, expected: true },
    { hp: 4, absorption: 1, expected: false }, { hp: 4.5, resistance: true, expected: true },
    { hp: 4.5, fireResistance: true, expected: false }
  ]) {
    const f = fixture(state.hp)
    f.bot.entity.metadata[17] = state.absorption || 0
    if (state.feather) f.bot.inventory.slots[8] = { name: 'diamond_boots', enchants: [{ name: 'feather_falling', lvl: state.feather }] }
    if (state.resistance) f.bot.entity.effects[resistanceId] = { id: resistanceId, amplifier: 0 }
    if (state.fireResistance) f.bot.entity.effects[fireResistanceId] = { id: fireResistanceId, amplifier: 0 }
    const work = f.recovery()
    await f.aim(); f.release()
    assert.equal(!!(await work)?.thrown, state.expected, JSON.stringify(state))
    assert.equal(f.releases.length, Number(state.expected), JSON.stringify(state))
  }
})

test('release rechecks absorption, worn enchantments and Resistance lost during aim', async () => {
  for (const kind of ['absorption', 'boots', 'resistance']) {
    const f = fixture(kind === 'resistance' ? 4.5 : 4)
    if (kind === 'absorption') f.bot.entity.metadata[17] = 2
    if (kind === 'boots') f.bot.inventory.slots[8] = { name: 'diamond_boots', enchants: [{ name: 'feather_falling', lvl: 4 }] }
    if (kind === 'resistance') f.bot.entity.effects[resistanceId] = { id: resistanceId, amplifier: 0 }
    const work = f.throw()
    await f.aim()
    f.bot.entity.metadata[17] = 0; f.bot.inventory.slots[8] = null; f.bot.entity.effects = {}
    f.release()
    assert.equal((await work).thrown, false, kind)
    assert.deepEqual(f.releases, [], kind)
  }
})

test('native FireResistance id cannot make a lethal pearl affordable', async () => {
  const f = fixture(4.5)
  f.bot.entity.effects[fireResistanceId] = { id: fireResistanceId, amplifier: 0 }
  const work = f.throw()
  await f.aim(); f.release()
  assert.equal((await work).thrown, false)
  assert.deepEqual(f.releases, [])
})

test('damage after a valid pearl release cannot retroactively cancel the projectile', async () => {
  const f = fixture()
  const work = f.throw()
  await f.aim(); f.release()
  assert.deepEqual(f.releases, [7])
  f.bot.health = 4
  assert.equal((await work).thrown, true)
  assert.equal(f.item.count, 0)
})

test('the pearl health guard leaves other throwables and creative use unchanged', async () => {
  for (const [name, gameMode] of [['snowball', 'survival'], ['ender_pearl', 'creative']]) {
    const f = fixture(1, name)
    f.bot.game.gameMode = gameMode
    const work = f.throw()
    await f.aim(); f.release()
    assert.equal((await work).thrown, true)
    assert.deepEqual(f.releases, [1])
  }
})
