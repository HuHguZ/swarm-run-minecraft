import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createLastSeen } from '../src/pvp/last-seen'
import { swarmSightings } from '../src/swarm-senses'
import * as co from '../src/pvp/combat-observe'

function scene () {
  const bot: any = new EventEmitter(); bot._client = new EventEmitter()
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 0, .5), onGround: true }
  bot.health = 20; bot.inventory = { items: () => [], slots: [] }
  bot.blockAt = p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] })
  const raw: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Foe',
    position: new Vec3(2.5, 0, .5), equipment: [], metadata: [], height: 1.8, width: .6 })
  return { bot, raw, vision: createLastSeen(bot) }
}

test('duel tracking and swarm sightings lose an invisible opponent until a rendered layer reappears', () => {
  const { bot, raw, vision } = scene()
  bot.entities = { 2: raw }; raw.onGround = true
  const hpIndex = bot.registry.entitiesByName.player.metadataKeys.indexOf('health')
  Object.defineProperty(raw.metadata, hpIndex, { get() { throw Error('opponent health is private') } })
  try {
    const prior = vision.observe(raw)
    assert.equal(swarmSightings(bot)[0]?.visible, true)
    raw.metadata[0] = 0x20
    raw.position.x += 1
    bot.emit('physicsTick')
    assert.equal(vision.visible(prior), false)
    assert.equal(prior.position.x, 2.5, 'a hidden packet cannot refresh last seen coordinates')
    assert.deepEqual(swarmSightings(bot), [])
    raw.equipment[1] = { name: 'shield' }
    assert.equal(vision.visible(prior), true)
    assert.deepEqual(swarmSightings(bot), [], 'a floating shield alone cannot recover a lost name')
    raw.metadata[0] = 0
    assert.equal(swarmSightings(bot)[0]?.id, raw.username, 'the normal player name identifies the track again')
    raw.equipment = []
    raw.metadata[0] = 0x60
    assert.equal(vision.visible(prior), true, 'a glowing outline reveals an otherwise invisible opponent')
    assert.equal(swarmSightings(bot)[0]?.visible, true)
    raw.metadata[0] = 0x21
    assert.equal(vision.visible(prior), true, 'the client renders flames even on an invisible nonspectator')
  } finally { vision.close() }
})

test('hidden boots behind a slab cannot reveal an invisible player; glow behind a wall is only a location cue', () => {
  const { bot, raw, vision } = scene()
  bot.entity.position.x = -3.5; raw.position.x = 4.5; raw.onGround = true
  bot.entities = { 2: raw }; bot.physics = {}
  raw.metadata[0] = 0x20
  let wall = false, hiddenBootReads = 0
  Object.defineProperty(raw.equipment, 2, { get() { hiddenBootReads++; return { name: 'diamond_boots' } } })
  bot.blockAt = p => {
    const solid = p.x === 3 && (wall || p.y === 0)
    return { name: solid ? 'stone_slab' : 'air', position: p, boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, wall ? 1 : .5, 1]] : [] }
  }
  try {
    assert.equal(vision.observe(raw), null)
    assert.deepEqual(swarmSightings(bot), [])
    assert.equal(co.observe(bot, raw).los, false)
    assert.equal(hiddenBootReads, 0)
    raw.equipment[5] = { name: 'iron_helmet' }
    assert.equal(vision.observe(raw)?.equipment[5]?.name, 'iron_helmet')
    assert.deepEqual(swarmSightings(bot), [], 'an unseen name cannot be learned from a helmet')
    raw.metadata[0] = 0
    assert.equal(swarmSightings(bot)[0]?.id, raw.username)
    raw.metadata[0] = 0x20
    assert.deepEqual(swarmSightings(bot)[0]?.equipment.armor, ['iron_helmet'])
    const combat = co.observe(bot, raw)
    assert.equal(combat.los, true)
    assert.equal(combat.foe.armor[0], null)
    assert.equal(combat.foe.armor[3]?.name, 'iron_helmet')
    assert.equal(hiddenBootReads, 0, 'a visible helmet does not expose the boot slot behind the slab')
    wall = true; raw.metadata[0] |= 0x40
    assert.equal(vision.visible(raw), false, 'an outline cannot enable a shot through an opaque wall')
    assert.equal(co.observe(bot, raw).los, false)
    const cue = swarmSightings(bot)[0]
    assert.equal(cue?.visible, false)
    assert.equal(cue?.glowing, true)
    assert.ok(!cue.nametag, 'invisibility hides the name even with an outline')
    raw.metadata[0] = 0x20
    bot.emit('physicsTick') // no radio poll while the outline is missing
    raw.metadata[0] = 0x60
    assert.deepEqual(swarmSightings(bot), [], 'a fresh outline behind a wall cannot recover a lost name')
    const fresh = { ...raw, id: 3, username: 'New', position: raw.position.clone(), equipment: [] }
    bot.entities = { 3: fresh }
    assert.deepEqual(swarmSightings(bot), [], 'a first ever anonymous outline cannot publish a named track')
    assert.equal(hiddenBootReads, 0)
  } finally { vision.close() }
})

test('PvP player view copies rendered gear without reading hidden item getters or enchant levels', () => {
  const f = scene()
  const hidden = { get data () { throw new Error('hidden enchantment levels') } }
  const sword: any = { name: 'diamond_sword', componentMap: new Map([['enchantments', hidden]]) }
  Object.defineProperties(sword, { count: { enumerable: true, get () { throw new Error('hidden stack') } },
    nbt: { enumerable: true, get () { throw new Error('hidden NBT') } } })
  const armor: any = { name: 'diamond_chestplate' }
  Object.defineProperty(armor, 'componentMap', { enumerable: true, get () { throw new Error('hidden component getter') } })
  f.raw.equipment = [sword, null, armor]
  try {
    const e = f.vision.observe(f.raw)
    assert.ok(e)
    assert.equal(e.equipment[0].name, 'diamond_sword')
    assert.equal(e.equipment[0].count, 1)
    assert.equal(e.equipment[0].enchanted, true)
    assert.equal(e.equipment[0].nbt, undefined)
    assert.deepEqual(co.itemObs(f.bot, e.equipment[0]).ench, {})
    assert.equal(e.equipment[2].name, 'diamond_chestplate')
    assert.deepEqual(co.itemObs(f.bot, e.equipment[2]).ench, {})
  } finally { f.vision.close() }
})

test('PvP player enchantment and stack changes cannot change attack observations; own enchantments remain available', () => {
  const f = scene()
  const sharp = f.bot.registry.enchantmentsByName.sharpness.id
  const armor = f.bot.registry.enchantmentsByName.protection.id
  const item = (name, id, level, count) => ({ name, count, componentMap: new Map([['enchantments', { data: { enchantments: [{ id, level }] } }]]) })
  try {
    const observed = []
    for (const level of [1, 99]) {
      f.raw.equipment = [item('diamond_sword', sharp, level, level), null, item('diamond_chestplate', armor, level, level)]
      const e = f.vision.observe(f.raw)
      observed.push(co.observe(f.bot, e).foe)
      assert.deepEqual(co.observe(f.bot, f.raw).foe, observed.at(-1), 'raw player adapter has the same visible item boundary')
    }
    assert.deepEqual(observed[0], observed[1])
    assert.equal(co.itemObs(f.bot, item('diamond_sword', sharp, 5, 1)).ench.sharpness, 5)
  } finally { f.vision.close() }
})

test('PvP loaded crossbow and potion visuals do not carry ammunition count, stars or potion strength', () => {
  const f = scene()
  f.raw.equipment = [{ name: 'crossbow', componentMap: new Map([['charged_projectiles', { data: { projectiles: [
    { name: 'firework_rocket', get components () { throw new Error('hidden rocket stars') } }, {}, {}] } }]]) },
    { name: 'potion', componentMap: new Map([['potion_contents', { data: { potion: 'strong_healing', customColor: 12345, customEffects: [{ amplifier: 9 }] } }]]) }]
  try {
    const e = f.vision.observe(f.raw)
    const loaded = co.itemObs(f.bot, e.equipment[0]).crossbow
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.count, 1)
    assert.equal(loaded.ammo, 'unknown')
    assert.equal(loaded.stars, null)
    assert.deepEqual(e.equipment[1].componentMap.get('potion_contents').data, { customColor: 12345 })
    assert.equal((require('../src/pvp') as typeof import('../src/pvp')).potionOf(e.equipment[1]), null)
  } finally { f.vision.close() }
})

test('PvP sight reuses unchanged block shapes and immediately sees world changes', () => {
  const f = scene(), world: any = new EventEmitter()
  world.getColumn = () => ({})
  f.bot.world = world
  let wall = false, reads = 0
  f.bot.blockAt = p => {
    reads++
    const solid = wall && Math.floor(p.x) === 1
    return { name: solid ? 'stone' : 'air', position: p.clone(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  try {
    assert.equal(f.vision.observe(f.raw)._ndVisible, true)
    const firstReads = reads
    for (let k = 0; k < 20; k++) assert.equal(f.vision.observe(f.raw)._ndVisible, true)
    assert.equal(reads, firstReads, 'unchanged rays must reuse the existing world cache')
    wall = true
    for (let y = 0; y < 3; y++) world.emit('blockUpdate', null, { position: new Vec3(1, y, 0) })
    assert.equal(f.vision.observe(f.raw)._ndVisible, false, 'a newly built wall immediately hides the opponent')
    wall = false
    world.emit('chunkColumnUnload', new Vec3(0, 0, 0))
    assert.equal(f.vision.observe(f.raw)._ndVisible, true)
  } finally { f.vision.close() }
})
