import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { installWindOut } from '../src/combat/wind-out'
import { blockOnRay, rayBox } from '../src/pick'
import * as clock from '../src/game-clock'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry), Item = require('prismarine-item')(registry)
const birth = new Vec3(.5, 121.52, .5), initial = new Vec3(0, 0, 1.5)

function atRelease(offsetX = 0, age = 18) {
  let pos = birth.offset(offsetX, 0, 0), velocity = initial.clone()
  for (let t = 0; t < age; t++) {
    velocity = velocity.offset(0, -.03, 0).scaled(.99)
    pos = pos.plus(velocity)
  }
  return { pos, velocity }
}

// The older pearl ticks first. It sweeps against the younger charge's current box
// before the charge moves. Decode the actual item packet without using planner output.
function replay(bot, packet, dispersion = new Vec3(0, 0, 0), offsetX = 0, age = 18) {
  const { fromNotchianYaw, fromNotchianPitch } = require('mineflayer/lib/conversions')
  const yaw = fromNotchianYaw(packet.rotation.x), pitch = fromNotchianPitch(packet.rotation.y)
  const windDirection = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const windStep = windDirection.scaled(1.5).plus(dispersion), windLength = windStep.norm()
  let wind = bot.entity.position.offset(0, 1.62, 0), { pos, velocity } = atRelease(offsetX, age)
  const size = registry.entitiesByName.wind_charge
  const margin = Math.fround(.3), half = size.width / 2 + margin, dy = Math.fround(.15)
  for (let t = 1; t <= 25; t++) {
    const old = pos
    velocity = velocity.offset(0, -.03, 0).scaled(.99)
    const length = velocity.norm(), direction = velocity.scaled(1 / length)
    const block = blockOnRay(bot, pos, direction, length)
    const entry = rayBox(pos, direction, wind.offset(-half, -dy - margin, -half),
      wind.offset(half, size.height - dy + margin, half), length)
    if (entry !== null && entry > 0 && entry < length && (!block || entry < block.t)) return { tick: age + t, old }
    if (block || blockOnRay(bot, wind, windStep.scaled(1 / windLength), windLength)) return null
    pos = pos.plus(velocity); wind = wind.plus(windStep)
  }
  return null
}

function thrower(t, name = 'Blue', x = 5.5, id = 1) {
  const walls = new Set<string>([Math.floor(x) + ',119,34', '0,119,0'])
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), block = Block.fromStateId(registry.blocksByName[walls.has([q.x, q.y, q.z].join(',')) ? 'stone' : 'air'].defaultState)
    block.position = q; return block
  } }
  const producer = new clock.GameClock({ epoch: 0 }), packets = []
  producer.syncAge(482n); producer.observationNow = () => 5000
  const foe = { id: 2, username: 'Red', name: 'player', type: 'player', isValid: true, onGround: true,
    position: birth.offset(0, -1.52, 0), velocity: new Vec3(0,0,0), equipment: [], metadata: [], height: 1.8, width: .6 }
  const pearl = { id: 9, name: 'ender_pearl', isValid: true, width: .25, height: .25, position: atRelease().pos }
  const bot: any = Object.assign(new EventEmitter(), {
    username: name, version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    entity: { id, username: name, position: new Vec3(x, 120, 34.1), onGround: true, velocity: new Vec3(0,0,0),
      height: 1.8, width: .6, yaw: 0, pitch: 0, attributes: {}, effects: {} },
    players: { Red: { entity: foe, gamemode: 0 } }, entities: { 2: foe, 9: pearl },
    blockAt: p => world.getBlock(p), physics: require('../src/tick-plugins').getPhysics().Physics(registry, world),
    ndClock: producer, _client: new EventEmitter(), supportFeature: registry.supportFeature, getControlState: () => false
  })
  t.after(() => { bot.emit('end'); producer.dispose() })
  bot._client.write = (name, packet) => { if (name === 'use_item') packets.push(packet) }
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  bot.inventory.updateSlot(45, new Item(registry.itemsByName.wind_charge.id, 1))
  const arena = { x: 0, z: 0, r: 80, killY: 113 }
  const session: any = { bot, _rescue: { arena, killY: arena.killY } }
  installWindOut(session)
  // ClientboundAddEntityPacket with native LpVec3 (0, 0, 1.5); register the visible throw through the real tracker.
  bot._client.emit('packet', { entityId: 9, type: registry.entitiesByName.ender_pearl.id, ...birth, objectData: 2 }, { name: 'spawn_entity' },
    Buffer.from('0109000000000000000000000000000000092c3fe0000000000000405e6147ae147ae13fe0000000000000faffdffcfffd00000002', 'hex'))
  assert.equal(bot._ndThrown.get(9)?.owner, 2)
  producer.advanceTicks(18)
  producer.syncAge(500n)
  bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 0 })
  return { bot, producer, session, walls, packets, pearl, foe, arena }
}

for (const change of ['open', 'joined team', 'pearl gone', 'wall before release', 'ally in flight path', 'spectator in flight path', 'mace committed'] as const)
test('the wind reflex intercepts the pearl over the arena death plane: ' + change, async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const { bot, session, walls, packets, pearl, foe, arena } = thrower(t)
  bot.emit('physicsTick'); bot.emit('physicsTick')
  assert.ok(bot.listenerCount('ndMovementSent') > 0, 'post-movement decision queued on the original scene')
  if (change === 'joined team') bot._ndSwarmAllies = [foe.username]
  if (change === 'pearl gone') delete bot.entities[pearl.id]
  if (change === 'wall before release') for (let y = 115; y <= 120; y++) walls.add('3,' + y + ',34')
  if (change === 'ally in flight path' || change === 'spectator in flight path') {
    const ally = { ...foe, id: 7, username: 'Green', position: new Vec3(3, 116, 34.1) }
    bot._ndSwarmAllies = [ally.username]
    bot.entities[ally.id] = ally; bot.players.Green = { entity: ally, gamemode: change === 'spectator in flight path' ? 3 : 0 }
  }
  if (change === 'mace committed') bot._ndSmashNow = () => {}
  bot.emit('ndMovementSent'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(packets.length, change === 'open' || change === 'spectator in flight path' ? 1 : 0)
  assert.equal(session._windOut.log.filter(event => event.kind === 'pearl_intercept').length, packets.length)
  if (!packets.length) return
  assert.equal(packets[0].hand, 1, 'the offhand wind charge was released')
  const contact = replay(bot, packets[0])
  assert.ok(contact, 'sent angle intersects the native wind-charge box before either projectile hits a block')
  assert.equal(contact.tick, 26)
  assert.equal(replay(bot, packets[0], undefined, 0, 19), null, 'the old angle misses if the server has already moved the pearl one more tick')
  assert.ok(Math.abs(contact.old.y - 112.59718569586884) < .000001 && contact.old.y < arena.killY)
  const noise = .0172275 * 1.5
  for (const x of [-noise, noise]) for (const y of [-noise, noise]) for (const z of [-noise, noise]) {
    const extreme = replay(bot, packets[0], new Vec3(x, y, z))
    assert.equal(extreme?.tick, contact.tick, 'all eight corners enter a charge face on the same pearl tick')
  }
  let pos = birth.clone(), velocity = initial.clone()
  while (pos.y >= 0) {
    velocity = velocity.offset(0, -.03, 0).scaled(.99)
    const length = velocity.norm()
    assert.equal(blockOnRay(bot, pos, velocity.scaled(1 / length), length), null, 'without the charge the pearl misses the arena')
    pos = pos.plus(velocity)
  }
  assert.equal(foe.position.y, 120, 'the thrower started on the platform above the death plane')
})

for (const second of [false, true]) test('two teammates coordinate per projectile; second visible pearl ' + second, async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const pair = [thrower(t, 'East', 5.5, 1), thrower(t, 'West', -4.5, 3)]
  const sw: any = { generation: 1, bots: pair, pos: {}, now: () => 0, alive: () => true, teamOf: () => 'blue', hostile: (_b, n) => n === 'Red' || n === 'Red2' }
  const { windBid } = require('../../farm/swarm/swarm-driver/wind').swarmWind(sw)
  const bids = []
  for (const self of pair) {
    const ally = pair.find(p => p !== self).bot
    self.bot._ndSwarmAllies = [ally.username]
    self.bot.players[ally.username] = { entity: ally.entity, gamemode: 0 }; self.bot.entities[ally.entity.id] = ally.entity
    if (second) {
      const foe = { ...self.foe, id: 4, username: 'Red2', position: self.foe.position.offset(-10, 0, 0) }
      self.walls.add('-10,119,0')
      self.bot.entities[4] = foe; self.bot.players.Red2 = { entity: foe, gamemode: 0 }
      self.bot.entities[10] = { ...self.pearl, id: 10, position: self.pearl.position.offset(-10, 0, 0) }
      self.bot._ndThrown.set(10, { ...self.bot._ndThrown.get(9), p: birth.offset(-10, 0, 0), owner: 4 })
    }
    self.session._windRadio = async bid => {
      bids.push(bid)
      const req = { ...bid, type: 'wind_bid', id: bids.length }
      return await windBid(self, req) ? shot => windBid(self, { ...req, type: 'wind_bid_done', shot }) : undefined
    }
    self.bot.emit('physicsTick'); self.bot.emit('physicsTick'); self.bot.emit('ndMovementSent')
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pair.flatMap(p => p.packets).length, second ? 2 : 1)
  assert.deepEqual(pair.flatMap(p => p.session._windOut.log.map(e => e.pearl)).sort((a, b) => a - b), second ? [9, 10] : [9])
  assert.equal(bids.filter(bid => bid.pearl === 9).length, 2, 'both independently had a safe shot at the first pearl')
  for (const winner of pair.filter(p => p.packets.length)) {
    const offset = winner.session._windOut.log[0].pearl === 9 ? 0 : -10
    assert.equal(replay(winner.bot, winner.packets[0], undefined, offset)?.tick, 26)
  }
})

for (const change of ['wall', 'hidden pearl', 'shield duty', 'ally crossed', 'late reply', 'stalled body tick', 'respawn']) test('a delayed pearl grant rechecks ' + change, async t => {
  let wall = 0
  t.mock.method(clock.wall, 'monotonic', () => wall)
  const { bot, session, packets, pearl, walls } = thrower(t)
  if (change === 'wall') {
    const World = require('prismarine-world')(registry), Chunk = require('prismarine-chunk')(registry)
    bot.world = new World(null, null).sync
    for (let z = 0; z <= 2; z++) bot.world.setColumn(0, z, new Chunk({ minY: -64, worldHeight: 384 }))
    for (const cell of walls) {
      const [x, y, z] = cell.split(',').map(Number)
      bot.world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName.stone.defaultState)
    }
    bot.blockAt = p => bot.world.getBlock(p)
  }
  if (change === 'ally crossed') {
    const entities = bot.entities, players = bot.players
    bot.supportFeature = registry.supportFeature
    require('mineflayer/lib/plugins/entities')(bot)
    Object.assign(bot, { entities, players })
    const fixture = require('./tick-plugins-fixture') as typeof import('./tick-plugins-fixture')
    require('../src/tick-plugins').createTickPlugins(fixture.testClock()).plugins.physics(bot, { physicsEnabled: false })
    t.after(() => bot.emit('end'))
    const ally = { ...bot.entity, id: 7, username: 'Green', type: 'player', position: new Vec3(16, 120, 34.1), velocity: new Vec3(0, 0, 0) }
    bot._ndSwarmAllies = [ally.username]
    bot.entities[7] = ally; bot.players.Green = { entity: ally, gamemode: 0 }
  }
  const receipts = []
  let grant
  session._windRadio = () => new Promise(resolve => { grant = () => resolve(shot => receipts.push(shot)) })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof grant, 'function')
  assert.equal(packets.length, 0)
  if (change === 'wall') for (let y = 115; y <= 120; y++) {
    bot.world.setBlockStateId(new Vec3(3, y, 34), registry.blocksByName.stone.defaultState)
  }
  if (change === 'hidden pearl') bot.entities[pearl.id]._ndVisible = false
  if (change === 'shield duty') bot.usingHeldItem = true
  if (change === 'ally crossed') {
    bot._client.emit('sync_entity_position', { entityId: 7, x: 3, y: 116, z: 34.1, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: true })
    assert.equal(bot.entities[7]._ndPositionReceipts[1].kind, 'sync_entity_position')
  }
  if (change === 'late reply') wall = 110
  if (change === 'stalled body tick') wall = 75
  if (change === 'respawn') bot.emit('respawn')
  grant(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(packets.length, 0)
  assert.deepEqual(receipts, [undefined], 'the driver releases the reservation for another teammate')
})

test('an exhausted pearl frame yields before general wind planning and the next frame can plan again', t => {
  let now = 0, generalPlans = 0
  t.mock.method(clock.wall, 'monotonic', () => now)
  const { bot, producer, packets } = thrower(t)
  producer.setState({ tick_rate: 100 })
  t.mock.method(require('../src/combat/pearl-wind'), 'pearlWindIntercept', () => { now += 11; return null })
  t.mock.method(require('../src/combat/enemy-wind'), 'planEnemyWind', () => { generalPlans++; return null })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  assert.equal(generalPlans, 0)
  assert.equal(packets.length, 0)
  producer.advanceTicks(2)
  bot.entities[9].isValid = false
  bot._ndThrown.delete(9)
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  assert.ok(generalPlans > 0)
})

test('one wind interception builds each visible ally trajectory once for both projectiles', async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const { bot, packets } = thrower(t)
  const track = require('../src/bow/track'), original = track.leadTarget, predictions = new Map()
  let gearReads = 0
  for (let i = 0; i < 19; i++) {
    const username = 'Ally' + i, id = 100 + i
    const entity = { ...bot.entity, type: 'player', id, username, onGround: false, position: new Vec3(16 + i % 5, 120, 26 + i) }
    Object.defineProperty(entity, 'equipment', { get() { gearReads++; return [] } })
    bot.entities[id] = entity; bot.players[username] = { entity, gamemode: 0 }
  }
  bot._ndSwarmAllies = Object.keys(bot.players).filter(n => n.startsWith('Ally'))
  t.mock.method(track, 'leadTarget', (body, ...args) => {
    if (body.username?.startsWith('Ally')) predictions.set(body.id, (predictions.get(body.id) || 0) + 1)
    return original(body, ...args)
  })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replay(bot, packets[0])?.tick, 26)
  assert.equal(predictions.size, 19)
  assert.deepEqual([...predictions.values()], Array(19).fill(1))
  bot.emit('physicsTick')
  assert.equal(gearReads, 0, 'forecasting visible teammates does not register armour scans on later ticks')
})

test('a radio grant leaves time for one complete current collision forecast on a cold frame', async t => {
  let elapsed = 0, forecasts = 0
  t.mock.method(clock.wall, 'monotonic', () => elapsed)
  const { bot, producer, session, packets, foe } = thrower(t)
  foe.onGround = false
  producer.setState({ tick_rate: 100 })
  const track = require('../src/bow/track'), original = track.leadTarget
  t.mock.method(track, 'leadTarget', (...args) => {
    forecasts++; elapsed += 4
    return original(...args)
  })
  let beforeBid
  session._windRadio = async () => {
    beforeBid = forecasts
    elapsed += 3
    return () => {}
  }
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(packets.length, 1)
  assert.equal(replay(bot, packets[0])?.tick, 26)
  assert.equal(beforeBid, 0)
  assert.equal(forecasts, 1)
})

test('an ally in the first bidder’s line leaves the same pearl to the clear teammate', async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const pair = [thrower(t, 'East', 5.5, 1), thrower(t, 'West', -4.5, 3)]
  const { windBid } = require('../../farm/swarm/swarm-driver/wind').swarmWind({
    generation: 1, bots: pair, pos: {}, now: () => 0, alive: () => true, teamOf: () => 'Blue', hostile: (_, id) => id === 'Red'
  })
  const grants: string[] = [], released: string[] = []
  for (const self of pair) {
    const { bot } = self, other = pair.find(p => p !== self).bot.entity
    const helper = { ...other, id: 7, username: 'Helper', type: 'player', position: new Vec3(3, 116, 34.1) }
    for (const ally of [other, helper]) {
      bot.entities[ally.id] = ally; bot.players[ally.username] = { entity: ally, gamemode: 0 }
    }
    bot._ndSwarmAllies = [other.username, helper.username]
    self.session._windRadio = async bid => {
      const request = { ...bid, type: 'wind_bid', id: 1 }
      if (!await windBid(self, request)) return
      grants.push(bot.username)
      return shot => {
        if (shot) released.push(bot.username)
        windBid(self, { ...request, type: 'wind_bid_done', shot })
      }
    }
    bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(grants, ['East', 'West'])
  assert.deepEqual(released, ['West'])
  assert.equal(pair[0].packets.length, 0)
  assert.equal(replay(pair[1].bot, pair[1].packets[0])?.tick, 26)
})

test('observations before pricing use the same movement packet deadline as the pearl grant', async t => {
  let wall = 0, bids = 0
  t.mock.method(clock.wall, 'monotonic', () => wall)
  const { bot, producer, session, packets } = thrower(t)
  producer.setState({ tick_rate: 100 })
  const exec = require('../src/combat/enemy-wind-execute'), original = exec.enemyWindReport
  t.mock.method(exec, 'enemyWindReport', (...args) => { wall += 11; return original(...args) })
  session._windRadio = async () => { bids++; return () => {} }
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bids, 0, 'an observation that took the whole tick cannot start a new physical frame')
  assert.equal(packets.length, 0)
})

test('switching to a hotbar charge cannot release after the pearl movement frame ends', async t => {
  let wall = 0
  t.mock.method(clock.wall, 'monotonic', () => wall)
  const { bot, producer, packets } = thrower(t)
  producer.setState({ tick_rate: 100 })
  const item = bot.inventory.slots[45]
  bot.inventory.updateSlot(45, null); bot.inventory.updateSlot(37, item)
  bot.quickBarSlot = 0
  const switches = []
  bot.setQuickBarSlot = slot => { switches.push(slot); bot.quickBarSlot = slot; wall += 11 }
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(switches, [1, 0])
  assert.equal(packets.length, 0)
})

test('a cold radio bid checks its visible lane before reserving and prices full wind dispersion once on release', async t => {
  let elapsed = 0, fullChecks = 0, beforeGrant
  t.mock.method(clock.wall, 'monotonic', () => elapsed)
  const { bot, producer, session, packets } = thrower(t)
  producer.setState({ tick_rate: 100 })
  const wind = require('../src/combat/enemy-wind'), original = wind.windCoverClear
  t.mock.method(wind, 'windCoverClear', (...args) => { fullChecks++; elapsed += 4; return original(...args) })
  session._windRadio = async () => { beforeGrant = fullChecks; elapsed += 3; return () => {} }
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(packets.length, 1)
  assert.equal(replay(bot, packets[0])?.tick, 26)
  assert.equal(beforeGrant, 0)
  assert.equal(fullChecks, 1)
})

for (const observedAge of [18, 8]) test('a new block on the already observed pearl path, last visible age ' + observedAge, async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const { bot, packets, walls, pearl } = thrower(t)
  pearl.position = atRelease(0, observedAge).pos
  walls.add('0,119,17') // the pearl crossed this cell at age 12; it is off the line to its owner
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(packets.length, observedAge === 18 ? 1 : 0)
  if (packets.length) assert.equal(replay(bot, packets[0])?.tick, 26)
})

test('a newly seen stationary bystander starts its velocity tracker on the next public movement', async t => {
  t.mock.method(clock.wall, 'monotonic', () => 0)
  const { bot, packets } = thrower(t)
  const ally = { ...bot.entity, id: 7, username: 'Helper', type: 'player', position: new Vec3(12, 120, 32) }
  bot.entities[7] = ally; bot.players.Helper = { entity: ally, gamemode: 0 }; bot._ndSwarmAllies = ['Helper']
  const track = require('../src/bow/track'), original = track.observedVelocity
  let prices = 0
  t.mock.method(track, 'observedVelocity', body => {
    if (body.username === 'Helper') prices++
    return original(body)
  })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replay(bot, packets[0])?.tick, 26)
  assert.equal(prices, 0, 'one sighting has no velocity interval to price')
  ally.position.x -= .5
  bot.emit('physicsTick')
  assert.ok(prices > 0, 'following motion still starts the ordinary observed tracker')
})
