import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as boom from '../src/boom'

function fixture() {
  const bot: any = new EventEmitter(), slots: any[] = []
  bot._client = new EventEmitter(); bot.username = 'Me'; bot.health = 20; bot.food = 20
  bot.registry = require('minecraft-data')('1.21.11'); bot.game = { minY: -64, height: 384 }
  const player = (id, username, x, z): any => ({ id, username, name: 'player', type: 'player', isValid: true,
    position: new Vec3(x, 64, z), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, equipment: [], metadata: [] })
  bot.entity = player(1, 'Me', 0, .5)
  const foe = player(2, 'Foe', 14, .5), ally = player(3, 'Ally', 0, 40)
  Object.defineProperty(ally.metadata, 9, { get() { throw Error('private allied HP') } })
  Object.defineProperty(ally, 'equipment', { get() { throw Error('hidden allied enchantments are not a safety budget') } })
  bot.entities = { 1: bot.entity, 2: foe, 3: ally }; bot.players = {}
  bot.teamMap = { Me: { team: 'blue' }, Ally: { team: 'blue' }, Foe: { team: 'red' } }
  const bow = { name: 'bow', count: 1, slot: 36, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:flame', level: 1 }] } }]]) }
  slots[36] = bow; slots[37] = { name: 'arrow', count: 32, slot: 37 }
  for (const [i, name] of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'].entries())
    slots[5 + i] = { name, count: 1, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:blast_protection', level: 4 }] } }]]) }
  bot.inventory = { slots, items: () => slots.filter(Boolean) }; bot.heldItem = bow; bot.quickBarSlot = 0
  bot.equip = async item => { bot.heldItem = item }; bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.heldItem = slots[36 + slot] }
  bot.setControlState = () => {}; bot.look = async () => {}; bot.lookAt = async () => {}
  bot.blockAt = p => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { raycast: () => null }
  const cart = { id: 4, name: 'tnt_minecart', position: new Vec3(14, 64, .5), velocity: new Vec3(0, 0, 0), width: .98, height: .7, isValid: true }
  bot.entities[4] = cart
  const bm = boom.create(bot, { enemy: () => foe, crystals: false, foeHp: () => 20, telemetryHp: () => null })
  return { bot, foe, ally, cart, bm }
}

test('legacy minecart offense rejects an otherwise winning blast with an off-ray teammate in native blast range', () => {
  const f = fixture()
  try {
    assert.equal(f.bm.plan()?.kind, 'shoot', 'the real legacy caller is reachable with its Flame bow and an enemy cart')
    f.ally.position = new Vec3(14, 64, 2.5)
    assert.equal(f.bm.plan(), null)
  } finally { f.bm.close() }
})

test('legacy explosive offense retains a safe teammate outside the native blast radius', () => {
  const f = fixture()
  try { assert.equal(f.bm.plan()?.kind, 'shoot') } finally { f.bm.close() }
})

test('the native cart speed cap protects a teammate beyond the old eleven-block radius', () => {
  const f = fixture(); f.ally.position = new Vec3(14, 64, 20.5)
  try { assert.equal(f.bm.plan(), null) } finally { f.bm.close() }
})

test('the native cart speed cap rejects a lethal own blast outside the old eleven-block radius', () => {
  const f = fixture()
  for (let slot = 5; slot <= 8; slot++) f.bot.inventory.slots[slot] = null
  try { assert.equal(f.bm.plan(), null) } finally { f.bm.close() }
})

test('a teammate entering after legacy bow draw cancels the explosive shot at the release predicate', async t => {
  const f = fixture(); let releases = 0
  const plan = f.bm.plan(); assert.equal(plan?.kind, 'shoot')
  t.mock.method(require('../src/bow/shoot'), 'shoot', async (_bot, _entity, options) => {
    f.ally.position = new Vec3(14, 64, 2.5)
    if (options.shouldStop()) return { shot: false }
    releases++; return { shot: true }
  })
  try {
    const result = await f.bm.run({ aborted: false }, plan)
    assert.equal(result.ok, false); assert.equal(releases, 0)
  } finally { f.bm.close() }
})

test('legacy cart release refuses its real worst native blast when own HP changed after planning', async t => {
  const f = fixture(); let releases = 0
  const plan = f.bm.plan(); assert.equal(plan?.kind, 'shoot')
  t.mock.method(require('../src/bow/shoot'), 'shoot', async (_bot, _entity, options) => {
    f.bot.health = 1
    if (options.shouldStop()) return { shot: false }
    releases++; return { shot: true }
  })
  try { assert.equal((await f.bm.run({ aborted: false }, plan)).ok, false); assert.equal(releases, 0) } finally { f.bm.close() }
})

test('a stationary cart remains a legal harmless melee defuse beside an ally', async () => {
  const f = fixture(); let hits = 0
  f.cart.position = new Vec3(2, 64, .5); f.ally.position = new Vec3(2, 64, 2)
  f.bot.attack = () => { hits++ }
  try {
    const result = await f.bm.defend({ aborted: false }, { ex: f.cart, my: { dmg: 10 }, P: 11.5 })
    assert.equal(hits, 1); assert.match(result, /вагонетку/)
  } finally { f.bm.close() }
})

test('a cart starting to move during the awaited melee look cannot prime a fuse beside an ally', async () => {
  const f = fixture(); let hits = 0
  f.cart.position = new Vec3(2, 64, .5); f.ally.position = new Vec3(2, 64, 2)
  f.bot.attack = () => { hits++ }
  f.bot.lookAt = async () => { f.cart.velocity = new Vec3(.2, 0, 0) }
  try {
    assert.equal(await f.bm.defend({ aborted: false }, { ex: f.cart, my: { dmg: 10 }, P: 11.5 }), null)
    assert.equal(hits, 0)
  } finally { f.bm.close() }
})

test('legacy crystal melee rechecks allied blast safety after its awaited look', async () => {
  const f = fixture(); let hits = 0
  const crystal = { id: 5, name: 'end_crystal', position: new Vec3(2.5, 64, .5), height: 2, width: 2, isValid: true }
  f.bot.inventory.slots[36] = { name: 'end_crystal', slot: 36, count: 1 }
  f.bot._genericPlace = async () => { f.bot.entities[5] = crystal; f.bot.emit('entitySpawn', crystal) }
  f.bot.attack = () => { hits++ }
  f.bot.lookAt = async () => { f.ally.position = new Vec3(2.5, 64, 2) }
  try {
    const result = await f.bm.run({ aborted: false }, { kind: 'crystal-hit', spot: { base: new Vec3(2, 63, 0), cell: new Vec3(2, 64, 0) }, j: { him: { dmg: 20 }, mine: { dmg: 0 } } })
    assert.equal(hits, 0); assert.equal(result.ok, false)
  } finally { f.bm.close() }
})
