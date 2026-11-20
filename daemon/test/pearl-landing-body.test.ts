import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { safeLanding, escapePick, landing, KINDS, throwAt } from '../src/throw'
import { bodyClear } from '../src/navigation/geometry'
import { worldOf } from './parkour-fixture'
import { burnStepCost } from '../src/pvp/movement'

function world(extra: (p: Vec3) => any = () => undefined) {
  const block = (p: Vec3, name: string, shapes: number[][] = []) => ({ name, position: p, shapes,
    boundingBox: shapes.length ? 'block' : 'empty' })
  const solid = (p: Vec3) => block(p, 'stone_bricks', [[0, 0, 0, 1, 1, 1]])
  const bot: any = { entity: { position: new Vec3(.5, 10, .5) }, blockAt(p: Vec3) {
    const override = extra(p)
    if (override !== undefined) return override === 'solid' ? solid(p) : override === null ? null : block(p, override)
    return p.y < 10 ? solid(p) : block(p, 'air')
  } }
  return bot
}

test('pearl landing rejects intersections that cannot fit even the native crawl pose', () => {
  for (const [tp, obstruction] of [
    [new Vec3(.5, 10.6, .5), new Vec3(0, 11, 0)],
    [new Vec3(.8, 10, .5), new Vec3(1, 10, 0)],
    [new Vec3(.5, 10, .2), new Vec3(0, 10, -1)]
  ]) {
    const bot = world(p => p.equals(obstruction) ? 'solid' : undefined)
    assert.equal(safeLanding(bot, tp), null, `body overlaps ${obstruction}`)
  }
})

test('unknown body space and hazards touching the side do not become safe pearl arrivals', () => {
  assert.equal(safeLanding(world(p => p.x === 1 && p.y === 10 ? null : undefined), new Vec3(.8, 10, .5)), null)
  assert.equal(safeLanding(world(p => p.x === 1 && p.y === 10 ? 'lava' : undefined), new Vec3(.8, 10, .5)), null)
})

test('clear dry and water arrivals remain available, including a wall outside the body', () => {
  assert.deepEqual(safeLanding(world(), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.x === 1 && p.y >= 10 ? 'solid' : undefined), new Vec3(.65, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.y === 10 ? 'water' : undefined), new Vec3(.5, 10, .5)), { floorY: 11, water: true })
  assert.deepEqual(safeLanding(world(p => p.y === 10 ? 'cobweb' : undefined), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.y === 11 ? 'solid' : undefined), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 }, 'native dry crawl under a low ceiling remains possible')
})

test('the actual escape selector prefers a clear arrival over a more distant side collision', () => {
  const bot = world(p => p.x === 21 && p.y === 10 ? 'solid' : undefined)
  const pick = escapePick(bot, tp => tp.x)
  const chosen = pick({ from: bot.entity.position, landing: yaw => ({
    tp: new Vec3(yaw === 0 ? 20.8 : 12.5, 10, .5)
  }) })
  assert.equal(chosen?.at.x, 12.5)
})

test('lava rescue finds a short downward native pearl landing from the captured after-water body', () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -3; x <= 5; x++) for (let z = -3; z <= 5; z++) cells.push([x, 0, z, 'stone'])
  cells.push([0, 1, 0, 'water'], [0, 2, 0, 'lava'], [1, 1, 0, 'cobweb'])
  const { bot, world } = worldOf(cells)
  const WorldSync = require('../node_modules/prismarine-world/src/worldsync')
  bot.world = { raycast: WorldSync.prototype.raycast.bind(world) }
  bot.entity.position = new Vec3(.779563335527, 1.64681796740524, .375886041333)
  const from = bot.entity.position.offset(0, 1.52, 0)
  const ctx = { from, landing: (yaw, pitch) => landing(bot, from, yaw, pitch, KINDS.ender_pearl) }
  assert.equal(escapePick(bot, tp => tp.distanceTo(from), { maxDrop: 4 })(ctx), null, 'the ordinary distant combat escape cannot land on this small platform')
  const selected = escapePick(bot, () => 0, { maxDrop: 4, rescue: true })(ctx)
  assert.ok(selected, 'a nearby safe descending throw must remain available during lava contact')
  const actual = ctx.landing(selected.yaw, selected.pitch)
  assert.ok(actual && safeLanding(bot, actual.tp))
  assert.equal(bodyClear(bot, actual.tp, { water: true }), true, 'the complete arriving body must clear lava and web')
  assert.ok(actual.ticks < 10, 'the existing flight model must confirm a quick arrival, not merely a released item')
})

test('lava rescue rejects a faster crawl-only arrival with a head-height lava source', () => {
  const bot = world(p => p.equals(new Vec3(0, 11, 0)) ? 'lava' : undefined)
  const low = new Vec3(.5, 10, .5)
  assert.ok(safeLanding(bot, low), 'ordinary pearl landing still permits the existing crawl pose')
  const selected = escapePick(bot, () => 0, { rescue: true })({ from: bot.entity.position, landing: yaw => ({
    tp: yaw === 0 ? low : new Vec3(12.5, 10, .5), ticks: yaw === 0 ? 1 : 3
  }) })
  assert.equal(selected?.at.x, 12.5, 'emergency arrival must clear the full body and actual lava hull')
})

test('equally quick native rescue landings prefer the bank without known neighbouring head lava', () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.push([x, 0, z, 'stone'])
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) cells.push([x, 2, z, 'lava'])
  cells.push([0, 1, 0, 'water'], [1, 1, 0, 'cobweb'])
  const { bot, world } = worldOf(cells)
  const WorldSync = require('../node_modules/prismarine-world/src/worldsync')
  bot.world = { raycast: WorldSync.prototype.raycast.bind(world) }
  bot.entity.position = new Vec3(.828187999996, 1, .5)
  const from = bot.entity.position.offset(0, 1.52, 0), moved = { x: .04132799999933923, y: 0, z: 0 }
  const ctx = { from, landing: (yaw, pitch, entities = false) => landing(bot, from, yaw, pitch, KINDS.ender_pearl, moved, false, entities) }
  const north = ctx.landing(0, -15 * Math.PI / 180), east = ctx.landing(3 * Math.PI / 2, -15 * Math.PI / 180)
  assert.equal(north.ticks, 4); assert.equal(east.ticks, 4, 'the safer bank costs no additional flight or lava exposure')
  const risk = tp => burnStepCost(bot)({ position: tp.floored().offset(0, 1, 0) })
  assert.equal(risk(north.tp), 30); assert.equal(risk(east.tp), 0)
  const selected = escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)
  assert.ok(selected)
  assert.equal(selected.ticks, 4)
  assert.equal(risk(selected.at), 0, 'do not choose the equally quick shore that the already observed lava can cover next')
  const target = { id: 2, username: 'PassiveAlly', type: 'player', position: new Vec3(4.5, 1, .5), width: .6, height: 1.8, metadata: [], isValid: true }
  bot.entities = { 2: target }; bot.players = { PassiveAlly: { gamemode: 1 } }
  const intercepted = ctx.landing(3 * Math.PI / 2, -15 * Math.PI / 180, true)
  assert.equal(intercepted.entity?.id, 2, 'a creative visible ally can intercept the real projectile before the safe bank')
  assert.ok(intercepted.tp.x < 4, 'native pearl teleport uses the beginning of the entity-hit tick')
  assert.ok(ctx.landing(3 * Math.PI / 2, -15 * Math.PI / 180).tp.x > 5, 'ordinary block-only trajectory behavior stays unchanged')
  bot.players.PassiveAlly.gamemode = 3
  assert.ok(ctx.landing(3 * Math.PI / 2, -15 * Math.PI / 180, true).tp.x > 5, 'spectators are not projectile obstacles')
  bot.players.PassiveAlly.gamemode = 1; bot.health = 12
  const safe = escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)
  assert.equal(safe?.ticks, 7, 'one worst-phase lava hit plus the pearl still leaves HP; prefer the stable bank')
  assert.equal(risk(safe.at), 0)
  bot.health = 6
  assert.equal(escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)?.ticks, 4, 'when the conservative bound fits nothing, retain the fastest physically safe last chance')
  bot.entity.type = 'player'; bot.entity.metadata = { 17: 5 }
  assert.equal(escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)?.ticks, 7, 'our live absorption makes the stable arrival affordable')
  bot.entity.metadata = {}
  bot.entity.effects[bot.registry.effectsByName.FireResistance.id] = { amplifier: 0, duration: 200 }
  assert.equal(escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)?.ticks, 7, 'live fire resistance removes lava flight exposure, but not pearl damage')
})

test('lava rescue keeps a short last chance but rejects a flight fatal even in the best hurt phase', () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -1; x <= 14; x++) for (let z = -1; z <= 1; z++) cells.push([x, 0, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.71, 1, .5); bot.health = 16
  let ticks = 173
  const ctx = { from: bot.entity.position.offset(0, 1.52, 0), landing: () => ({ tp: new Vec3(12.5, 1, .5), ticks }) }
  const rescue = () => escapePick(bot, () => 0, { rescue: true, maxDrop: 4 })(ctx)
  assert.equal(rescue(), null, 'the captured 173-tick flight cannot outlive continuous lava at 16 HP, even with the best initial iframe')
  bot.health = 6; ticks = 4
  assert.equal(rescue()?.ticks, 4, 'unknown hurt phase must not forbid the only short physical chance')
  ticks = 11
  assert.equal(rescue(), null, 'one unavoidable lava hit plus the pearl already exceeds 6 HP')
  assert.ok(escapePick(bot, () => 0)(ctx), 'ordinary chased combat throws retain their previous contract')
  bot.entity.effects[bot.registry.effectsByName.FireResistance.id] = { amplifier: 0, duration: 200 }
  ticks = 173
  assert.equal(rescue()?.ticks, 173, 'live fire resistance removes the lava exposure, leaving the real pearl cost')
  delete bot.entity.effects[bot.registry.effectsByName.FireResistance.id]
  bot.entity.type = 'player'; bot.entity.metadata = { 17: 100 }
  assert.equal(rescue()?.ticks, 173, 'our actual absorption can also make a longer flight survivable')
})

test('the actual rescue throw receipt preserves its selected early entity collision', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -1; x <= 8; x++) for (let z = -1; z <= 1; z++) cells.push([x, 0, z, 'stone'])
  const { bot, world } = worldOf(cells), WorldSync = require('../node_modules/prismarine-world/src/worldsync')
  bot.world = { raycast: WorldSync.prototype.raycast.bind(world) }
  bot.entities = { 2: { id: 2, username: 'VisiblePlayer', type: 'player', position: new Vec3(3.5, 1, .5), height: 1.8, width: .6, metadata: [] } }
  const item = { name: 'ender_pearl', type: 1, slot: 36 }
  bot.heldItem = item; bot.inventory.items = () => [item]
  bot.look = async () => {}; let used = 0, expected
  bot.activateItem = () => { used++ }
  const work = throwAt(bot, null, { item, pick: ctx => {
    const yaw = -Math.PI / 2, pitch = -15 * Math.PI / 180
    const early = ctx.landing(yaw, pitch, true)
    assert.ok(early.entity, 'the real flight has an early visible-body hit')
    expected = early.tp
    return { yaw, pitch, ticks: early.ticks, entityCollision: true, at: early.tp }
  } })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('physicsTick')
  const result = await work
  assert.equal(result.thrown, true); assert.equal(used, 1)
  assert.ok(new Vec3(result.land.x, result.land.y, result.land.z).distanceTo(expected) < .02, 'recovery must receive the early physical teleport, not the farther block-only prediction')
})
