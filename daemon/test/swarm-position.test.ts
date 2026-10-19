import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { swarmPositions, pearlPositionPlan, pearlToPosition } from '../src/swarm-position'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

function fixture(extra: Array<[number, number, number, string]> = [], inventory: Record<string, number> = {}) {
  const cells = new Map<string, string>()
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.set(`${x},0,${z}`, 'stone')
  for (const [x, y, z, name] of extra) cells.set(`${x},${y},${z}`, name)
  const world = { getBlock(p: Vec3) {
    const at = p.floored(), name = cells.get(`${at.x},${at.y},${at.z}`) || 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = at; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    inventory: { slots: [], items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    entities: {}, players: {}, blockAt: (p: Vec3) => world.getBlock(p), clearControlStates() {},
    physics: native.Physics(registry, world), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0
  })
  return { bot, cells }
}

const roofBlocks = (y: number): Array<[number, number, number, string]> => {
  const blocks: Array<[number, number, number, string]> = []
  for (let x = 2; x <= 4; x++) for (let z = -1; z <= 1; z++) blocks.push([x, y, z, 'stone'])
  return blocks
}
async function rememberRoof(bot: any, top: Vec3) {
  const start = bot.entity.position.clone()
  bot.entity.position = top
  await swarmPositions(bot, { purpose: 'build', radius: 3, methods: ['walk'] })
  bot.entity.position = start
}

test('swarm positions derive real supports, prefer a firing height with own bow, and keep feet/body inside arena', async () => {
  const { bot } = fixture(roofBlocks(2), { bow: 1, arrow: 16, ender_pearl: 4, wind_charge: 4 })
  await rememberRoof(bot, new Vec3(3.5, 3, .5))
  const arena = { x: .5, z: .5, r: 5, killY: -2 }
  const result = await swarmPositions(bot, { purpose: 'ranged', arena, radius: 5, limit: 12 })
  assert.equal(result.observed, true)
  assert.ok(result.candidates.length)
  for (const candidate of result.candidates) {
    assert.ok(Math.abs(candidate.at.x - arena.x) + .3 <= arena.r)
    assert.ok(Math.abs(candidate.at.z - arena.z) + .3 <= arena.r)
    assert.ok(candidate.at.y > arena.killY)
    assert.ok(candidate.methods.length)
  }
  const high = result.candidates.find(c => c.at.x === 3.5 && c.at.z === .5 && c.at.y === 3)
  assert.ok(high, JSON.stringify(result))
  assert.ok(high!.highGround > 0)
  assert.ok(high!.methods.some(method => ['wind', 'pearl'].includes(method.kind)))
  const naked = fixture(roofBlocks(2), { wind_charge: 4 }).bot
  await rememberRoof(naked, new Vec3(3.5, 3, .5))
  const noBow = await swarmPositions(naked, { purpose: 'ranged', arena, radius: 5, limit: 12 })
  const nakedHigh = noBow.candidates.find(c => c.at.x === 3.5 && c.at.z === .5 && c.at.y === 3)
  assert.ok(!nakedHigh || nakedHigh.score < high!.score, 'equipment changes the price, not a no-armor/no-bow gate')
})

test('swarm positions never use supplied hidden coordinates, enemy HP or packet-only terrain behind a wall', async () => {
  const { bot } = fixture(Array.from({ length: 5 }, (_, y) => [2, y + 1, 0, 'stone'] as [number, number, number, string]))
  const hidden: any = { id: 'hidden' }
  for (const key of ['position', 'health', 'hp', 'inventory']) Object.defineProperty(hidden, key, { get() { throw new Error(`hidden ${key}`) } })
  bot.entities[1] = { id: 1, username: 'hidden', type: 'player', position: new Vec3(5.5, 1, .5), height: 1.8, width: .6 }
  const result = await swarmPositions(bot, { purpose: 'escape', enemies: [hidden], radius: 6, methods: ['walk'], limit: 40 })
  assert.ok(result.candidates.every(c => !c.sight.includes('hidden')))
  assert.ok(result.candidates.every(c => !(c.at.x > 2.9 && Math.abs(c.at.z - .5) < .1)), 'wall shadow stays unknown')
  const empty = await swarmPositions(bot, { purpose: 'escape', radius: 6, methods: ['walk'], limit: 40 })
  assert.deepEqual(result.candidates, empty.candidates)
})

test('swarm positions price cover and escape distance from honestly seen enemies', async () => {
  const { bot } = fixture([[0, 1, 2, 'stone'], [0, 2, 2, 'stone']])
  bot.entities[1] = { id: 1, username: 'enemy', type: 'player', position: new Vec3(4.5, 1, .5), height: 1.8, width: .6 }
  const result = await swarmPositions(bot, { purpose: 'escape', enemies: [{ id: 'enemy' }], radius: 4, methods: ['walk'], limit: 12 })
  assert.ok(result.candidates.length)
  assert.ok(result.candidates[0].at.x < bot.entity.position.x, JSON.stringify(result))
  const recovered = await swarmPositions(bot, { purpose: 'recover', enemies: [{ id: 'enemy' }], radius: 4, methods: ['walk'], limit: 12 })
  assert.ok(recovered.candidates.some(c => c.cover > 0))
})

test('swarm build extensions reserve own material, publish one honest supported cell, and reject lethal/outside/unknown floor', async () => {
  const { bot, cells } = fixture([], { cobblestone: 2 })
  for (let x = 2; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.delete(`${x},0,${z}`)
  const result = await swarmPositions(bot, { purpose: 'build', radius: 3, limit: 30, methods: ['walk', 'build'], reserve: { cobblestone: 1 } })
  const extension = result.candidates.find(c => c.methods.some(method => method.kind === 'build' && method.skill === 'swarm_work'))
  assert.ok(extension, JSON.stringify(result))
  const method = extension!.methods.find(method => method.kind === 'build' && method.skill === 'swarm_work')!
  assert.equal(method.skill, 'swarm_work')
  assert.equal(method.params.kind, 'place')
  assert.equal(method.params.item, 'cobblestone')
  assert.equal(method.params.at.y + 1, extension!.at.y)
  const reserved = await swarmPositions(bot, { purpose: 'build', radius: 3, methods: ['build'], reserve: { cobblestone: 2 } })
  assert.equal(reserved.candidates.length, 0)
  const lethal = await swarmPositions(bot, { purpose: 'build', radius: 3, methods: ['build'], arena: { x: .5, z: .5, r: 1, killY: 1 } })
  assert.equal(lethal.candidates.length, 0)
})

test('swarm positions inspect bounded high columns cooperatively and return executable parameter shapes', async () => {
  const { bot } = fixture(roofBlocks(11), { bow: 1, arrow: 16, ender_pearl: 4 })
  await rememberRoof(bot, new Vec3(3.5, 12, .5))
  let interleaved = false
  setImmediate(() => { interleaved = true })
  const result = await swarmPositions(bot, { purpose: 'ranged', radius: 6, limit: 30, methods: ['pearl', 'walk'] })
  assert.ok(interleaved, 'a terrain query must let native ticks run during exploration')
  const roof = result.candidates.find(c => c.at.x === 3.5 && c.at.z === .5 && c.at.y === 12)
  assert.ok(roof, JSON.stringify(result))
  const pearl = roof!.methods.find(m => m.kind === 'pearl')!
  assert.deepEqual(pearl.params.to, roof!.at)
  assert.equal(pearl.skill, 'pearl_to')
  assert.equal(pearl.params.observed, true)
})

test('observed pearl selects a descending roof arc, cannot traverse unknown cells or cross arena, and cannot spend fatal health', async () => {
  const { bot } = fixture(roofBlocks(11), { ender_pearl: 4 })
  const to = new Vec3(3.5, 12, .5)
  await rememberRoof(bot, to)
  const planned = await pearlPositionPlan(bot, { to, arena: { x: .5, z: .5, r: 5, killY: -2 } })
  assert.ok(planned.best)
  assert.ok(planned.best!.pitch > 80 * Math.PI / 180, 'the default low arc strikes the underside')
  assert.ok(Math.hypot(planned.best!.land.x - to.x, planned.best!.land.z - to.z) < .22)
  assert.equal((await pearlPositionPlan(bot, { to, arena: { x: .5, z: .5, r: 3, killY: -2 } })).best, null)
  bot.health = 1
  assert.equal((await pearlPositionPlan(bot, { to })).best, null)
  bot.health = 20
  const unknown = fixture(roofBlocks(11), { ender_pearl: 4 }).bot
  const read = unknown.blockAt; unknown.blockAt = p => p.y > 16 ? null : read(p)
  await rememberRoof(unknown, to)
  assert.equal((await pearlPositionPlan(unknown, { to })).best, null, 'an unobserved arc is not promised')
})

test('a narrow pearl support is refused before release or inventory spending; observed roof memory is invalidated by changes', async () => {
  const { bot } = fixture([[3, 11, 0, 'stone']], { ender_pearl: 16 })
  const to = new Vec3(3.5, 12, .5), count = bot.inventory.items()[0].count
  await rememberRoof(bot, to)
  assert.equal((await pearlPositionPlan(bot, { to })).tried, 0)
  const attempt = await pearlToPosition({ bot }, { aborted: false, onAbort: [] }, { to })
  assert.equal(attempt.ok, false)
  assert.equal(bot.inventory.items()[0].count, count)
  const wide = fixture(roofBlocks(11), { ender_pearl: 16 })
  await rememberRoof(wide.bot, to)
  assert.ok((await pearlPositionPlan(wide.bot, { to })).best)
  wide.cells.delete('4,11,0')
  wide.bot.emit('blockUpdate', null, { position: new Vec3(4, 11, 0) })
  assert.equal((await pearlPositionPlan(wide.bot, { to })).best, null)
})

