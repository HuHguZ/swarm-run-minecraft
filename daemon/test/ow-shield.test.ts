import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3 = require('vec3')
const clock = require('../src/game-clock')
const ow = require('../src/ow-shield')
const mc = require('minecraft-data')('1.21.11')

function actor() {
  const bot: any = { game: { dimension: 'overworld' }, registry: mc,
    entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), width: .6, height: 1.8 }, entities: {},
    blockAt: p => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) }
  const e: any = { id: 2, name: 'skeleton', position: new Vec3(0, 64, -10), velocity: new Vec3(0, 0, 0), yaw: Math.PI,
    width: .6, height: 1.99, isValid: true, equipment: [{ name: 'bow' }], metadata: [] }
  e.metadata[mc.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 1
  bot.entities[2] = e
  return { bot, e }
}

test('first ingot buys the night shield when its price beats the existing route death price', () => {
  const inv = { iron_ingot: 1, oak_planks: 6, crafting_table: 1 }
  const p = ow.price({ inventory: inv, hp: 20, night: true, surface: true })
  assert.equal(p.take, true); assert.equal(p.replacementS, 66)
  assert.ok(p.avoidedS > p.costS)
  assert.equal(ow.price({ inventory: inv, hp: 20, night: false, surface: true }).take, false)
  assert.equal(ow.price({ inventory: inv, hp: 6, night: false, surface: false }).take, true)
  assert.equal(ow.price({ inventory: inv, hp: 20, night: true, surface: true, deathS: 60 }).take, false)
  assert.equal(ow.price({ inventory: inv, hp: 4, night: true, surface: true, exposedDps: 10 }).take, false, 'the exposed craft pays its own damage price')
})

test('raw ore, missing wood, existing offhand and the env control preserve the competing work', () => {
  for (const inventory of [{ raw_iron: 4, oak_planks: 6, crafting_table: 1 }, { iron_ingot: 1, oak_planks: 5, crafting_table: 1 },
    { iron_ingot: 1, oak_planks: 6, crafting_table: 1, shield: 1 }]) assert.equal(ow.price({ inventory, night: true }).take, false)
  assert.equal(ow.price({ inventory: { iron_ingot: 1, oak_planks: 6, crafting_table: 1 }, shield: true, night: true }).take, false)
  const previous = process.env.ND_OW_SHIELD
  try { process.env.ND_OW_SHIELD = '0'; assert.equal(ow.enabled(actor().bot), false) }
  finally { if (previous === undefined) delete process.env.ND_OW_SHIELD; else process.env.ND_OW_SHIELD = previous }
})

test('visible bow use raises protection before the arrow exists, LOS and facing end that reason', () => {
  const { bot, e } = actor()
  assert.equal(ow.rangedGuard(bot, [e], [])?.id, 2)
  e.yaw = 0; assert.equal(ow.rangedGuard(bot, [e], []), null)
  e.yaw = Math.PI; e.metadata[mc.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 0
  assert.equal(ow.rangedGuard(bot, [e], []), null)
  e.metadata[mc.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 1
  const flat = bot.blockAt
  bot.blockAt = p => p.z < -4 && p.z > -6 ? { position: p.floored(), name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : flat(p)
  assert.equal(ow.rangedGuard(bot, [e], []), null)
  bot.game.dimension = 'the_nether'; assert.equal(ow.rangedGuard(bot, [e], []), undefined)
})

test('incoming arrow/trident points at the projectile, even if its archer is on the opposite side', () => {
  const { bot, e } = actor()
  const point = new Vec3(4, 65, 0)
  for (const name of ['arrow', 'trident']) {
    const guard = ow.rangedGuard(bot, [e], [{ name, ticks: 6, entity: { id: 3, position: point } }])
    assert.deepEqual(guard.point, point); assert.equal(guard.id, 3)
  }
})

test('Drowned.startUsingItem lasts for its whole ranged goal and is not a player draw countdown', () => {
  const { bot, e } = actor(); e.name = 'drowned'; e.equipment = [{ name: 'trident' }]
  e.metadata[mc.entitiesByName.drowned.metadataKeys.indexOf('living_entity_flags')] = 1
  assert.equal(ow.rangedGuard(bot, [e], []), null, 'do not pin the body behind the shield between native throws')
})

test('unmeasured release keeps only its original ballistic ETA and crossing out of the line ends it', () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const { bot, e } = actor(), key = mc.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')
  try {
    ow.rangedGuard(bot, [e], []); e.metadata[key] = 0
    assert.equal(ow.rangedGuard(bot, [e], [])?.kind, 'unmeasured bow flight')
    for (let i = 0; i < 25; i++) { ow.rangedGuard(bot, [e], []); c.advanceTicks(1) }
    assert.equal(ow.rangedGuard(bot, [e], []), null)
    e.metadata[key] = 1; ow.rangedGuard(bot, [e], []); e.metadata[key] = 0
    assert.ok(ow.rangedGuard(bot, [e], [])); bot.entity.position.x = 2
    assert.equal(ow.rangedGuard(bot, [e], []), null)
  } finally { c.dispose() }
})

test('mob guard uses the jar box and twenty-tick attack cooldown, including the first unknown swing', () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const { bot, e } = actor(); e.name = 'zombie'; e.equipment = []; e.position = new Vec3(1, 64, 0)
  try {
    assert.equal(ow.meleeGuard(bot, e, 0), true, 'unknown cooldown can already strike')
    assert.equal(ow.meleeGuard(bot, e, clock.now()), false, 'the observed swing opened its actual cooldown')
    c.advanceTicks(14); assert.equal(ow.meleeGuard(bot, e, 1000), true, 'five raise ticks plus one delivery tick')
    e.position.x = 3; assert.equal(ow.meleeGuard(bot, e, 0), false, 'no three-block radial melee assumption')
    e.position.x = 1.7; assert.equal(ow.meleeGuard(bot, e, 0), false)
    assert.equal(ow.meleeGuard(bot, e, 0, true), true, 'the raised guard has a wider spatial exit boundary')
    e.position.x = 1; e.position.y = 67; assert.equal(ow.meleeGuard(bot, e, 0), false, 'no vertical reach through a pillar')
    e.equipment = [{ name: 'iron_spear' }]; assert.equal(ow.meleeGuard(bot, e, 0), null, 'spear goal retains its own model')
    e.name = 'drowned'; e.equipment = [{ name: 'trident' }]
    assert.equal(ow.meleeGuard(bot, e, 0), null, 'the native ranged trident goal is not a twenty-tick melee cycle')
  } finally { c.dispose() }
})
