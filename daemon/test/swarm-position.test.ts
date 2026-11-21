import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { swarmPositions, pearlPositionPlan, pearlToPosition, observedWorld } from '../src/swarm-position'
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

test('a 20v20 terrace survey shares raw cells across rays while keeping every personal firing lane', async t => {
  const { bot, cells } = fixture([], { cobblestone: 5, bow: 1, arrow: 8 })
  for (let x = 3; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.delete(`${x},0,${z}`)
  const enemies = []
  for (let i = 0; i < 39; i++) {
    const username = (i < 20 ? 'Enemy' : 'Ally') + i
    const e = { id: i + 2, username, type: 'player', position: new Vec3(1.5 + i % 2, 1, -4.5 + i % 10),
      width: .6, height: 1.8, metadata: [i >= 10 && i < 20 ? 0x20 : 0], equipment: [] }
    bot.entities[e.id] = e; bot.players[username] = { entity: e, gamemode: 0 }
    if (i < 20) enemies.push({ id: username })
  }
  // Count one synchronous slice independently of scheduler speed.
  t.mock.method(performance, 'now', () => 1000)
  const read = bot.blockAt, rawCells = new Set<string>()
  let reads = 0
  bot.blockAt = p => { reads++; rawCells.add(p.floored().toString()); return read(p) }
  const query = () => swarmPositions(bot, { purpose: 'ranged', enemies, radius: 4, limit: 6, methods: ['walk', 'build'] })
  const before = await query()
  assert.deepEqual(before.candidates.map(c => [c.at.x, c.at.y, c.at.z]), [
    [.5, 5, .5], [.5, 4, .5], [.5, 3, .5], [.5, 2, .5], [-.5, 1, .5], [-1.5, 1, .5]
  ])
  for (const c of before.candidates) assert.deepEqual(c.sight, enemies.slice(0, 10).map(e => e.id))
  assert.ok(reads < rawCells.size * 2, `${reads} raw reads for ${rawCells.size} cells`)
  for (let y = 1; y <= 4; y++) for (let z = -8; z <= 8; z++) {
    cells.set(`1,${y},${z}`, 'stone'); bot.emit('blockUpdate', null, { position: new Vec3(1, y, z) })
  }
  const behindWall = await query()
  assert.ok(behindWall.candidates.length && behindWall.candidates.every(c => !c.sight.length))
  assert.deepEqual(behindWall.candidates.at(-1)?.at, { x: .5, y: 1, z: -.5 })
})

test('rays in the next slice of an active survey see a newly closed sightline', async () => {
  const { bot, cells } = fixture()
  const world = observedWorld(bot)
  assert.ok(world.blockAt(new Vec3(3, 2, 0)))
  await new Promise<void>(resolve => setImmediate(resolve))
  const p = new Vec3(2, 2, 0)
  cells.set('2,2,0', 'stone'); bot.emit('blockUpdate', null, { position: p })
  assert.equal(world.blockAt(new Vec3(4, 2, 0)), null)
})
async function rememberRoof(bot: any, top: Vec3) {
  const start = bot.entity.position.clone()
  bot.entity.position = top
  await swarmPositions(bot, { purpose: 'build', radius: 3, methods: ['walk'] })
  bot.entity.position = start
}

test('a bow user can request a wind landing on a remembered single-block perch using only a teammate charge', async () => {
  const { bot, cells } = fixture([[4, 1, 0, 'stone'], [4, 2, 0, 'stone'], [4, 3, 0, 'stone']], { bow: 1, arrow: 8 })
  const target = new Vec3(4.5, 4, .5)
  await rememberRoof(bot, target)
  const partner = { id: 'Helper', position: { x: -2.5, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  const query = { purpose: 'ranged' as const, radius: 5, limit: 6, windPartner: partner }
  const ledge = async q => (await swarmPositions(bot, q)).candidates.find(c => target.distanceTo(c.at as Vec3) < .01)
  assert.equal(await ledge({ ...query, windPartner: undefined }), undefined)
  const option = (await ledge(query))?.methods.find(m => m.skill === 'wind_receive')
  assert.ok(option, 'the receiver has no wind charge or pearl of its own')
  assert.ok(option.plan.receiver.settled && option.plan.thrower.safe)
  assert.ok(target.distanceTo(option.plan.receiver.land) < .22)
  assert.equal(option.plan.thrower.id, partner.id)
  const { windReceive, windBoost }: typeof import('../src/combat/team-wind') = require('../src/combat/team-wind')
  const receive = () => windReceive({ bot }, { aborted: false }, { thrower: partner, to: target, plan: option.plan, dryRun: true })
  const helper = fixture([[4, 1, 0, 'stone'], [4, 2, 0, 'stone'], [4, 3, 0, 'stone']], { wind_charge: 3 })
  helper.bot.entity.position = new Vec3(-2.5, 1, .5)
  helper.bot.entities[1] = { username: 'Archer', type: 'player', position: bot.entity.position, width: .6, height: 1.8 }
  const prepare = () => windBoost({ bot: helper.bot }, { aborted: false }, { ally: 'Archer', plan: option.plan, dryRun: true, startTick: 100 })
  assert.ok((await receive()).ok && (await prepare()).ok, 'both bodies can actually prepare the same perch')
  cells.delete('4,3,0'); bot.emit('blockUpdate', { position: target.offset(0, -1, 0).floored() }, null)
  helper.cells.delete('4,3,0')
  assert.equal((await receive()).ok, false, 'cached positive plan is refused by the receiver once the support vanishes')
  assert.equal((await prepare()).ok, false, 'the helper may not release on a cached success')
  assert.equal(await ledge(query), undefined, 'the remembered landing cannot survive a removed support')
})

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
  // Keep native-width clearance on the walking corridor past the cover's corner.
  bot.entity.position.x = .25
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

for (const change of ['arc_blocked', 'roof_removed', 'packet_motion', 'beside_arc'] as const) test(`pearl_to judges the selected roof throw at use_item after ${change}`, async t => {
  const { bot, cells } = fixture(roofBlocks(11), { ender_pearl: 1 })
  const to = new Vec3(3.5, 12, .5), arena = { x: .5, z: .5, r: 6, killY: 0 }
  for (let x = 2; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.delete([x, 0, z].join(','))
  bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  await rememberRoof(bot, to)
  const item = { name: 'ender_pearl', type: registry.itemsByName.ender_pearl.id, slot: 36, count: 1 }
  bot.heldItem = item; bot.inventory.slots[36] = item; bot.inventory.items = () => item.count ? [item] : []
  const edges = require('../src/edges'), projectile = require('../src/throw'), inputs = { ...edges.IDLE }
  bot.getControlState = k => !!inputs[k]
  bot.setControlState = (k, value) => { inputs[k] = value }
  bot.clearControlStates = () => Object.assign(inputs, edges.IDLE)
  bot.look = async (yaw, pitch) => Object.assign(bot.entity, { yaw, pitch })
  const movement = new Vec3(0, 0, 0)
  bot._ndLaunchMovement = () => movement.clone()
  const actualFlight = () => projectile.landing(bot, require('../src/pick').eyeOf(bot).offset(0, -.1, 0),
    bot.entity.yaw, bot.entity.pitch, projectile.KINDS.ender_pearl, movement, false)
  let edited = false, tick = 0, arrivalAt = 0, impact: any, report: any, predicted: any
  bot.activateItem = () => { item.count--; impact = actualFlight(); arrivalAt = tick + impact.ticks }
  const session = { bot, require: () => bot, runIntent: (_name, fn) => fn({ aborted: false, onAbort: [] }) }
  const rpc = require('../src/rpc/aerial').aerialMethods({ session })
  const run = rpc.pearl_to({ to, arena, observed: true }).then(result => { report = result })
  for (let i = 0; i < 360 && !report; i++) {
    if (bot.listenerCount('physicsTick')) {
      tick++
      if (tick === arrivalAt && impact && !impact.void) { bot.entity.position = impact.tp.clone(); bot.entity.onGround = false; bot.emit('forcedMove') }
      const body = edges.stateOf(bot, inputs); bot.physics.simulatePlayer(body, bot.world); body.apply(bot)
      bot.emit('physicsTick')
      if (!edited && bot.listenerCount('ndMovementSent')) {
        assert.equal(item.count, 1)
        if (change === 'packet_motion') movement.z = .45
        const changes = change === 'roof_removed' ? roofBlocks(11) : change === 'packet_motion' ? [] : [[change === 'arc_blocked' ? 0 : -2, 4, 0, 'sandstone']]
        for (const [x, y, z, name] of changes) {
          const at = new Vec3(Number(x), Number(y), Number(z)), key = [x, y, z].join(','), old = bot.blockAt(at)
          if (change === 'roof_removed') cells.delete(key)
          else cells.set(key, String(name))
          bot.emit('blockUpdate', old, bot.blockAt(at))
        }
        predicted = actualFlight(); edited = true
      }
      bot.emit('ndMovementSent')
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.ok(edited && report, 'the normal intent reached its final movement packet and completed')
  await run
  if (change === 'roof_removed' || change === 'packet_motion') assert.equal(predicted.void, true)
  else assert.equal(predicted.block.position.y, change === 'arc_blocked' ? 4 : 11)
  t.diagnostic(JSON.stringify({ change, released: 1 - item.count, ticks: tick, why: report.why, landing: report.at }))
  assert.equal(item.count, change === 'beside_arc' ? 0 : 1)
  if (change === 'beside_arc') { assert.ok(report.ok); assert.equal(bot.entity.position.y, 12) }
  else { assert.equal(report.why, 'pearl_not_released'); assert.equal(report.shot.thrown, false) }
})

