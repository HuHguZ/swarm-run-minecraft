'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')

// Only the external server and its clock are doubled. Physics, block digTime,
// Mineflayer injection and pathfinding use the installed production libraries.
function testClock (rate = 20) {
  let gameNow = 1000000
  let wallNow = 0
  let frozen = false
  let nextId = 0
  const timers = new Map()
  const wallTimers = new Map()
  function schedule (fn, ms, interval, args) {
    const handle = ++nextId
    timers.set(handle, { fn, due: gameNow + ms, interval, args })
    return handle
  }
  const clock = {
    now: () => gameNow,
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, 0, args),
    clearTimeout: handle => timers.delete(handle),
    setInterval: (fn, ms, ...args) => schedule(fn, ms, ms, args),
    clearInterval: handle => timers.delete(handle),
    freeze: value => { frozen = value },
    pending: () => timers.size + wallTimers.size,
    async advanceGame (ms, yieldTurns = true) {
      const end = gameNow + ms
      while (true) {
        let next = null
        for (const entry of timers) {
          if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry
        }
        if (!next) break
        const [handle, timer] = next
        gameNow = timer.due
        if (timer.interval) timer.due += timer.interval
        else timers.delete(handle)
        timer.fn(...timer.args)
        // Native timer turns allow promise continuations to change controls
        // before the next physics tick, including accelerated game time.
        if (yieldTurns) await new Promise<any>(resolve => setImmediate(resolve))
      }
      gameNow = end
    },
    async advanceWall (ms) {
      const end = wallNow + ms
      for (;;) {
        const next = [...wallTimers].filter(([, timer]: any) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        wallTimers.delete(next[0])
        wallNow = next[1].due
        next[1].fn(...next[1].args)
        await new Promise<any>(resolve => setImmediate(resolve))
      }
      wallNow = end
      if (!frozen) await clock.advanceGame(ms * rate / 20)
    },
    wall: {
      now: () => wallNow,
      setTimeout: (fn, ms, ...args) => {
        const handle = ++nextId
        wallTimers.set(handle, { fn, due: wallNow + ms, args })
        return handle
      },
      clearTimeout: handle => wallTimers.delete(handle)
    }
  }
  return clock
}

function block (name, position) {
  const b = Block.fromStateId(data.blocksByName[name].defaultState, 0)
  b.position = position.floored()
  return b
}

function testBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.packets = []
  bot._client.write = (name, packet) => bot.packets.push({ name, ...packet })
  bot.registry = data
  bot.version = '1.21.11'
  bot.supportFeature = data.supportFeature
  bot.entity = {
    id: 1, position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: 0, pitch: 0, effects: {} as Record<string, any>, attributes: {} as Record<string, any>, eyeHeight: 1.62, height: 1.8
  }
  bot.entities = {} as Record<string, any>
  bot.isAlive = true
  bot.game = { gameMode: 'survival', minY: -64 }
  bot.inventory = { slots: [], items: () => bot.inventory.slots.filter(Boolean) }
  bot.heldItem = { type: data.itemsByName.iron_pickaxe.id, enchants: [] }
  bot.getEquipmentDestSlot = () => 5
  bot.blockAt = p => block(p.y < 1 ? 'stone' : 'air', p)
  bot._updateBlockState = p => bot.emit(`blockUpdate:${p}`, block('stone', p), block('air', p))
  bot.swings = 0
  bot.swingArm = () => { bot.swings++ }
  return bot
}

function install (clock, { digging = false, pathfinder = false, physicsEnabled = true }: any = {} as Record<string, any>) {
  const { createTickPlugins } = require('../src/tick-plugins')
  const adapters = createTickPlugins(clock)
  const bot = testBot()
  adapters.plugins.physics(bot, { physicsEnabled })
  if (digging) adapters.plugins.digging(bot)
  if (pathfinder) adapters.pathfinder(bot)
  bot.emit('login')
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 1 })
  bot.entity.onGround = true
  return bot
}

test('installed physics warns for external deprecated listeners but not marked late aim callbacks', async t => {
  const clock = testClock()
  const bot = install(clock)
  const warnings = []
  t.mock.method(console, 'warn', message => { warnings.push(String(message)) })
  let ownCalls = 0; let externalCalls = 0
  const own = require('node:async_hooks').AsyncResource.bind(() => { ownCalls++ })
  Object.defineProperty(own, '_ndLatePacketAim', { value: true })
  const external = () => { externalCalls++ }
  try {
    bot.on('physicTick', own)
    assert.equal(warnings.length, 0, 'the reviewed final aim boundary has no per-shot warning')
    bot.on('physicTick', external)
    assert.equal(warnings.length, 1, 'external deprecated listeners retain the upstream warning')
    assert.ok(warnings[0].includes('deprecated event (physicTick)'))
    await clock.advanceGame(50)
    assert.equal(ownCalls, 1)
    assert.equal(externalCalls, 1)
    assert.equal(warnings.length, 1, 'emitting the boundary does not warn again')
  } finally { bot.removeListener('physicTick', own); bot.removeListener('physicTick', external); bot.emit('end') }
})

test('confirmed world elapsed runs installed physics once after a blocked producer turn', () => {
  const { GameClock } = require('../src/game-clock')
  const clock = new GameClock({ epoch: 0 })
  const bot = install(clock)
  let frames = 0; let deadlines = 0; let intervals = 0
  bot.on('physicsTick', () => { frames++ })
  bot.setControlState('forward', true)
  clock.setTimeout(() => { deadlines++ }, 3000)
  clock.setInterval(() => { intervals++ }, 100)
  clock.syncAge(1000n)
  clock.syncAge(1060n)
  bot.packets.length = 0
  const reference = new GameClock({ manual: true, epoch: 0 })
  const referenceBot = install(reference)
  referenceBot.setControlState('forward', true)
  try {
    assert.equal(frames, 0, 'native receive stack does not emit physical frames')
    assert.equal(clock.now(), 0, 'confirmed time reconciles on the paced pulse')
    clock.pulse()
    reference.pulse()
    assert.equal(clock.now(), 3000, 'all sixty confirmed world ticks count as elapsed game time')
    assert.equal(deadlines, 1, 'a three-second game deadline expires on actual world elapsed')
    assert.equal(intervals, 1, 'missed timer intervals are coalesced rather than replayed')
    assert.equal(frames, 1)
    assert.equal(bot.packets.filter(packet => packet.name === 'tick_end').length, 1)
    assert.ok(bot.entity.position.distanceTo(referenceBot.entity.position) < 1e-12, 'installed native integrator advances one real step, not sixty')
    clock.pulse(); reference.pulse()
    assert.equal(frames, 2)
    assert.equal(deadlines, 1)
    assert.equal(intervals, 1)
    assert.ok(bot.entity.position.distanceTo(referenceBot.entity.position) < 1e-12)
    clock.syncAge(1080n)
    clock.pulse(); reference.pulse()
    assert.equal(clock.now(), 4000)
    assert.equal(frames, 3)
    assert.equal(intervals, 2)
    assert.ok(bot.entity.position.distanceTo(referenceBot.entity.position) < 1e-12)
  } finally {
    bot.emit('end'); referenceBot.emit('end')
    clock.dispose(); reference.dispose()
  }
  assert.equal(clock.timers.size, 0)
})

test('native entity movement carries ground contact before mineflayer observers see falling motion', () => {
  const bot = testBot()
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(testClock()).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(2); enemy.position = new Vec3(0, 20, 0)
  bot.entities[2] = enemy; bot.entities[1] = bot.entity
  const seen = []
  bot.on('entityMoved', e => { if (e === enemy) seen.push(e.onGround) })
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 0, dY: -4096, dZ: 0, onGround: false })
  assert.equal(enemy.position.y, 19)
  assert.deepEqual(seen, [false], 'actual upstream entityMoved sees the native airborne flag')
  bot._client.emit('entity_move_look', { entityId: 2, dX: 0, dY: -4096, dZ: 0, yaw: 0, pitch: 0, onGround: true })
  assert.deepEqual(seen, [false, true])
  bot._client.emit('rel_entity_move', { entityId: 1, dX: 0, dY: 0, dZ: 0, onGround: false })
  assert.equal(bot.entity.onGround, true, 'remote packets do not override self native physics contact')
  bot.emit('end')
  bot._client.emit('entity_look', { entityId: 2, yaw: 0, pitch: 0, onGround: false })
  assert.equal(enemy.onGround, true, 'observation listeners are removed on disconnect')
})

test('native position receipts give identical target lead and projectile threats with trace on or off', async t => {
  const gameClock = require('../src/game-clock')
  const bow = require('../src/bow')
  const threats = require('../src/threats')
  const Entity = require('prismarine-entity')('1.21.11')
  let currentClock: any
  t.mock.method(gameClock, 'observationNow', () => currentClock.now())
  t.mock.method(gameClock, 'now', () => currentClock.now())
  const results = []
  for (const trace of [false, true]) {
    currentClock = testClock(750)
    const bot = testBot()
    require('mineflayer/lib/plugins/entities')(bot)
    require('../src/tick-plugins').createTickPlugins(currentClock).plugins.physics(bot, { physicsEnabled: false })
    const enemy = new Entity(2); enemy.position = new Vec3(0, 100, 0); enemy.metadata[0] = 128
    const arrow = new Entity(trace ? 4 : 3); arrow.name = 'arrow'; arrow.position = new Vec3(.5, 1.5, 6)
    bot.entities[enemy.id] = enemy; bot.entities[arrow.id] = arrow
    bot.emit('entitySpawn', enemy); bot.emit('entitySpawn', arrow)
    const tracker = bow.trackTarget(enemy)
    assert.equal(bow.trackTarget(enemy), tracker, 'PvP and ranged share one receipt observer for the same entity')
    tracker.update(); threats.incoming(bot)
    if (trace) bot.on('entityMoved', e => { if (e === enemy) tracker.vel(); threats.incoming(bot) })
    await currentClock.advanceGame(50)
    bot._client.emit('rel_entity_move', { entityId: enemy.id, dX: 1229, dY: -410, dZ: 0, onGround: false })
    bot._client.emit('rel_entity_move', { entityId: arrow.id, dX: 0, dY: 0, dZ: -4096, onGround: false })
    await currentClock.advanceGame(50)
    bot._client.emit('rel_entity_move', { entityId: enemy.id, dX: -2048, dY: -819, dZ: 0, onGround: false })
    bot._client.emit('rel_entity_move', { entityId: arrow.id, dX: 0, dY: 0, dZ: -4096, onGround: false })
    // Rotation-only entityMoved must not refresh the position's age.
    await currentClock.advanceGame(50)
    bot._client.emit('entity_head_rotation', { entityId: enemy.id, headYaw: 0 })
    const incoming = threats.incoming(bot)
    assert.equal(bow.observedVelocity(enemy).x, tracker.vel().x, 'default bow/crossbow reads use the same receipt velocity')
    results.push({ velocity: tracker.vel(), receipt: enemy._ndPositionReceipts[1], known: tracker.hasVelocity(),
      lead: tracker.at(3), defaultLead: bow.leadTarget(enemy, null)(3), threats: incoming.map(hit => ({ name: hit.name, vel: hit.vel, ticks: hit.ticks })) })
    await currentClock.advanceGame(50)
    bot._client.emit('rel_entity_move', { entityId: arrow.id, dX: 0, dY: 0, dZ: 0, onGround: true })
    assert.deepEqual(threats.incoming(bot), [], 'an actual stationary position packet ends the projectile threat')
    bot.emit('end')
  }
  assert.deepEqual(results[0], results[1], 'diagnostic reads must neither supply extra movement samples nor erase threats')
  assert.equal(results[0].velocity.x, -.5, 'latest actual reversal must be retained before the aim read')
  assert.equal(results[0].velocity.ageTicks, 1, 'look-only events must not make a stale position fresh')
  assert.equal(results[0].threats[0].vel.z, -1)
})

test('compressed nongliding relative moves retain their tick lower bound and absolute corrections reset target speed', () => {
  const bot = testBot()
  const clock: any = testClock()
  let at = 1000
  clock.observationNow = () => at
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(2); enemy.position = new Vec3(0, 100, 0); enemy.metadata[0] = 0
  bot.entities[enemy.id] = enemy
  bot.emit('entitySpawn', enemy)
  const tracker = require('../src/bow').trackTarget(enemy)
  assert.equal(tracker.hasVelocity(), false, 'spawn is a position baseline, not a measured velocity')
  at = 1050
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 2048, dY: 0, dZ: 0, onGround: false })
  bot._client.emit('entity_move_look', { entityId: 2, dX: 1024, dY: 0, dZ: 0, yaw: 0, pitch: 0, onGround: false })
  assert.equal(enemy._ndPositionReceipts[1].kind, 'entity_move_look')
  assert.equal(tracker.vel().x, .375, 'two distinct relative packets require at least two native ticks')
  assert.equal(tracker.hasVelocity(), true)
  bot._client.emit('rel_entity_move', { entityId: 2, dX: -1024, dY: 0, dZ: 0, onGround: false })
  assert.ok(tracker.vel().x < 0, 'a same-arrival reversal changes direction before the next aim read')
  assert.equal(tracker.vel().ageTicks, 0, 'the latest receipt remains the source of age')
  bot._client.emit('sync_entity_position', { entityId: 2, x: 100, y: 100, z: 0,
    dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: false })
  assert.equal(enemy._ndPositionReceipts[1].kind, 'sync_entity_position')
  assert.deepEqual(tracker.vel(), { x: 0, y: 0, z: 0, ageTicks: 0 }, 'a server position correction is not a hundred-block velocity')
  assert.equal(tracker.hasVelocity(), false)
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 1024, dY: 0, dZ: 0, onGround: false })
  assert.equal(tracker.vel().x, .25, 'the first relative move after a correction owns a new baseline')
  bot._client.emit('sync_entity_position', { entityId: 2, x: 100.25, y: 100, z: 0,
    dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: false })
  assert.equal(tracker.hasVelocity(), false, 'a fresh absolute correction resets measurement even at the same position and timestamp')
  bot.emit('end')
})

test('Air35 native flying metadata does not turn the last fall step into measured glide velocity', () => {
  const bot = testBot()
  const clock: any = testClock()
  let at = 1000
  clock.observationNow = () => at
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(2); enemy.name = 'player'
  enemy.position = new Vec3(4100.5, 180, 3117.4850214545527)
  bot.entities[2] = enemy; bot.emit('entitySpawn', enemy)
  const previousReceipt = enemy._ndPositionReceipts[1]
  const previousRevision = enemy._ndGlideRevision || 0
  bot._client.emit('entity_look', { entityId: 2, yaw: 32, pitch: 8, onGround: false })
  bot._client.emit('entity_look', { entityId: 2, yaw: 0, pitch: 0, onGround: false })
  assert.equal(enemy._ndPositionReceipts[1], previousReceipt, 'rotation changes do not pretend the position was refreshed')
  assert.ok(enemy._ndGlideRevision > previousRevision, 'observed rotation reversal remains an invalidation')
  const tracker = require('../src/bow').trackTarget(enemy)
  bot._client.emit('sync_entity_position', { entityId: 2, x: enemy.position.x, y: 180, z: enemy.position.z,
    dx: 0, dy: 0, dz: 0, yaw: 180, pitch: 0, onGround: false })
  bot._client.emit('entity_metadata', { entityId: 2, metadata: [{ key: 0, type: 'byte', value: 128 }] })
  assert.equal(enemy.elytraFlying, true, 'the installed native metadata handler owns the new flight phase')
  at += 50
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 0, dY: -321, dZ: -1094, onGround: false })
  assert.equal(tracker.hasVelocity(), false, 'Air35 first relative fall displacement starts the glide baseline')
  at += 50
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 0, dY: -633, dZ: -655, onGround: false })
  assert.equal(tracker.hasVelocity(), false, 'one glide displacement does not identify its physical endpoint')
  assert.equal(tracker.vel().y, -633 / 4096, 'the next interval measures the actual glide slope')
  assert.equal(tracker.vel().ageTicks, 0)
  bot._client.emit('entity_metadata', { entityId: 2, metadata: [{ key: 0, type: 'byte', value: 0 }] })
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 0, dY: 0, dZ: 0, onGround: false })
  assert.equal(tracker.hasVelocity(), true, 'a real stationary relative remains measured across a phase change')
  assert.deepEqual(tracker.vel(), { x: 0, y: 0, z: 0, ageTicks: 0 })
  bot.emit('end')
})

test('native foreign rocket attachment invalidates glide confidence and lasts until its final rocket disappears', () => {
  const bot = testBot(); const clock = testClock()
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(2); enemy.name = 'player'; enemy.position = new Vec3(0, 100, 0)
  bot.entities[2] = enemy; bot.emit('entitySpawn', enemy)
  const previousRevision = enemy._ndGlideRevision || 0
  const attach = id => {
    const rocket = new Entity(id); rocket.name = 'firework_rocket'; bot.entities[id] = rocket
    bot._client.emit('entity_metadata', { entityId: id, metadata: [{ key: 9, type: 'optional_varint', value: 3 }] })
    return rocket
  }
  const first = attach(3); const second = attach(4)
  assert.equal(enemy._ndGlideBoosted, true, 'actual OptVarInt target id + 1 owns the foreign boost')
  bot._client.emit('rel_entity_move', { entityId: 2, dX: 1, dY: -1, dZ: 0, onGround: false })
  assert.equal(enemy._ndPositionReceipts[1].boosted, true)
  bot.emit('entityGone', first)
  assert.equal(enemy._ndGlideBoosted, true, 'another attached native rocket remains')
  bot._client.emit('entity_metadata', { entityId: second.id, metadata: [{ key: 9, type: 'optional_varint', value: 0 }] })
  assert.equal(enemy._ndGlideBoosted, false, 'native detachment clears the final boost')
  assert.ok(enemy._ndGlideRevision >= previousRevision + 2, 'the transient rocket interval remains observed after detachment')
  assert.equal(bot.entity._ndGlideBoosted, undefined, 'self physics remains the existing native owner')
  bot.emit('end')
  assert.equal(bot.listenerCount('entityUpdate'), 0)
  assert.equal(bot.listenerCount('entityGone'), 0)
})

test('native remote velocity packets reach installed entity observers in blocks per tick', () => {
  const bot = testBot()
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(testClock()).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(526); enemy.position = new Vec3(0, 100, 0)
  bot.entities[enemy.id] = enemy
  const packet = { entityId: enemy.id, velocity: { x: 1, y: .99, z: -.45 } }
  // Native 1.21.11 receipt: LPVec3 big-endian encodes (0, -.12, 0).
  const bytes = Buffer.from('638e04f9ff7ffee145', 'hex')
  bot._client.emit('packet', packet, { name: 'entity_velocity' }, bytes)
  bot._client.emit('entity_velocity', packet)
  assert.ok(Math.abs(enemy.velocity.x) < .0001)
  assert.ok(Math.abs(enemy.velocity.y + .12) < .0001, `native vertical velocity ${enemy.velocity.y}`)
  assert.ok(Math.abs(enemy.velocity.z) < .0001)
  const born = { entityId: 42, objectUUID: '00000000-0000-0000-0000-000000000042', type: data.entitiesByName.arrow.id,
    x: 0, y: 100, z: 0, yaw: 0, pitch: 0, velocity: { x: -1, y: .02, z: -.15 } }
  const xyz = Buffer.alloc(24); xyz.writeDoubleBE(100, 8)
  const spawnBytes = Buffer.concat([Buffer.from([1, 42, ...Array(16).fill(0), born.type]), xyz, Buffer.from('f9ff5c290f59', 'hex')])
  let spawnVelocity: any
  bot.once('entitySpawn', entity => { spawnVelocity = entity.velocity.clone() })
  bot._client.emit('packet', born, { name: 'spawn_entity' }, spawnBytes)
  bot._client.emit('spawn_entity', born)
  assert.ok(Math.abs(spawnVelocity.y - .06) < .0001, 'spawn observers receive actual initial velocity')
  assert.ok(Math.abs(spawnVelocity.z + .28) < .0001)
  const selfPacket = { entityId: bot.entity.id, velocity: { x: 1, y: .99, z: -.45 } }
  bot._client.emit('packet', selfPacket, { name: 'entity_velocity' }, bytes)
  assert.deepEqual(selfPacket.velocity, { x: 1, y: .99, z: -.45 }, 'remote correction leaves native self physics untouched')
  bot.emit('end')
  const endedPacket = { entityId: enemy.id, velocity: { x: 1, y: .99, z: -.45 } }
  bot._client.emit('packet', endedPacket, { name: 'entity_velocity' }, bytes)
  assert.deepEqual(endedPacket.velocity, { x: 1, y: .99, z: -.45 }, 'codec observer is removed on disconnect')
})

test('20 and 200 TPS produce identical movement in twenty fixed physics steps', async () => {
  const endPositions = []
  for (const rate of [20, 200]) {
    const clock = testClock(rate)
    const bot = install(clock)
    let ticks = 0
    bot.on('physicsTick', () => { ticks++ })
    bot.setControlState('forward', true)
    await clock.advanceWall(rate === 20 ? 1000 : 100)
    assert.equal(ticks, 20)
    assert.ok(bot.entity.position.z > 4, 'actual prismarine physics moved the player')
    endPositions.push(bot.entity.position)
    bot.emit('end')
    assert.equal(clock.pending(), 0)
  }
  assert.deepEqual(endPositions[0], endPositions[1])
})

test('play ticks end after movement, including unloaded terrain, and stop outside play', async () => {
  const clock = testClock(200)
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  bot._client.state = 'configuration'
  createTickPlugins(clock).plugins.physics(bot, {} as Record<string, any>)
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets, [], 'the adapter sends nothing before login')
  bot.emit('login')
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets, [], 'the configuration state has no play packets')
  bot._client.state = 'play'
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 1 })
  bot.entity.onGround = true
  bot.packets.length = 0
  bot.setControlState('forward', true)
  for (let tick = 0; tick < 3; tick++) {
    const start = bot.packets.length
    await clock.advanceGame(50)
    const names = bot.packets.slice(start).map(packet => packet.name)
    assert.equal(names.at(-1), 'tick_end')
    assert.equal(names.filter(name => name === 'tick_end').length, 1)
    assert.ok(names.slice(0, -1).some(name => ['position', 'position_look', 'look', 'flying'].includes(name)),
      'movement is sent before that tick ends')
  }
  bot.blockAt = () => null
  let start = bot.packets.length
  await clock.advanceGame(50)
  assert.deepEqual(bot.packets.slice(start).map(packet => packet.name), ['tick_end'])
  bot._client.state = 'configuration'
  start = bot.packets.length
  await clock.advanceGame(50)
  assert.equal(bot.packets.length, start)
  bot.emit('end')
  bot._client.state = 'play'
  await clock.advanceGame(50)
  assert.equal(bot.packets.length, start)
  assert.equal(clock.pending(), 0)
})

test('packet-bound actions release after the same native movement and tick end in a synchronous physics burst', async () => {
  const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks')
  const owner = new AsyncLocalStorage()
  const clock = testClock(750)
  const bot = install(clock)
  const afterPacket = require('../src/edges').afterPacket
  bot.packets.length = 0
  bot.setControlState('forward', true)
  let plannedPosition
  const releases = []
  owner.run('airborne release', () => bot.once('physicsTick', AsyncResource.bind(() => {
    plannedPosition = bot.entity.position.clone()
    afterPacket(bot, () => {
      const lastMove = bot.packets.filter(p => /^position(_look)?$/.test(p.name)).at(-1)
      releases.push({ position: bot.entity.position.clone(), sent: new Vec3(lastMove.x, lastMove.y, lastMove.z), owner: owner.getStore(), previous: bot.packets.at(-1).name })
      bot._client.write('use_item', {})
    })
  })))
  try {
    await clock.advanceGame(200, false)
    assert.equal(releases.length, 1)
    assert.deepEqual(releases[0].position, plannedPosition, 'another simulatePlayer must not advance the shooter before release')
    assert.deepEqual(releases[0].sent, plannedPosition, 'the native movement establishing the muzzle precedes release')
    assert.equal(releases[0].previous, 'tick_end', 'the same native client frame has finished its movement packets')
    assert.equal(releases[0].owner, 'airborne release', 'the original control lease survives the packet boundary')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(releases.length, 1, 'fallback and native packet boundary cannot release twice')
  } finally { bot.emit('end') }
})

test('respawn transport response uses wall time while frozen and cancels on disconnect', async () => {
  const clock = testClock(200)
  clock.freeze(true)
  await clock.advanceWall(1)
  const bot = install(clock)
  let forced = 0
  let physicsTicks = 0
  bot.on('forcedMove', () => { forced++ })
  bot.on('physicsTick', () => { physicsTicks++ })
  const gameNow = clock.now()
  bot.emit('death')
  bot.emit('respawn')
  bot._client.emit('position', { x: 2.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 2 })
  await clock.advanceWall(1499)
  assert.equal(forced, 0)
  await clock.advanceWall(1)
  assert.equal(forced, 1, 'the server receives its respawn response even without ticking')
  assert.equal(bot.packets.at(-1).name, 'position_look')
  assert.equal(bot.packets.at(-1).x, 2.5)
  assert.equal(clock.now(), gameNow)
  assert.equal(physicsTicks, 0)
  await clock.advanceGame(50)
  assert.equal(physicsTicks, 1, 'the first granted tick can simulate after the transport response')
  bot.emit('death')
  bot._client.emit('position', { x: 3.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 3 })
  bot.emit('end')
  const packetsAtEnd = bot.packets.length
  assert.equal(clock.pending(), 0)
  await clock.advanceWall(1500)
  assert.equal(bot.packets.length, packetsAtEnd)
  assert.equal(forced, 1)
})

test('respawn delay eligibility expires on wall time while game time is frozen', async () => {
  const clock = testClock(200)
  clock.freeze(true)
  await clock.advanceWall(1)
  const bot = install(clock)
  bot.emit('death')
  await clock.advanceWall(2000)
  let forced = 0
  bot.on('forcedMove', () => { forced++ })
  bot._client.emit('position', { x: 2.5, y: 1, z: 0.5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 2 })
  assert.equal(forced, 1, 'an old death stamp does not delay later transport replies')
  bot.emit('end')
  assert.equal(clock.pending(), 0)
})

test('frozen clock preserves waitForTicks and stepping advances exactly the requested ticks', async () => {
  const clock = testClock(200)
  const bot = install(clock)
  let completed = false
  const waiting = bot.waitForTicks(5).then(() => { completed = true })
  const initialPosition = bot.entity.position.clone()
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(completed, false)
  assert.deepEqual(bot.entity.position, initialPosition)
  await clock.advanceGame(200)
  assert.equal(completed, false)
  await clock.advanceGame(50)
  await waiting
  assert.equal(completed, true)
  bot.emit('end')
  assert.equal(clock.pending(), 0)
})

test('promise continuations can release movement before the next accelerated physics tick', async () => {
  const clock = testClock(200)
  const bot = install(clock)
  const controls = []
  bot.setControlState('forward', true)
  bot.on('physicsTick', () => controls.push(bot.getControlState('forward')))
  const waiting = bot.waitForTicks(1).then(() => bot.setControlState('forward', false))
  await clock.advanceWall(10)
  await waiting
  assert.deepEqual(controls, [true, false])
  bot.emit('end')
})

test('stone mining uses eight game ticks at both rates and freezes its finish and arm swing', async () => {
  for (const rate of [20, 200]) {
    const clock = testClock(rate)
    const bot = install(clock, { digging: true })
    const stone = block('stone', new Vec3(1, 1, 0))
    assert.equal(bot.digTime(stone), 400)
    const digging = bot.dig(stone, 'ignore')
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0])
    await clock.advanceWall(rate === 20 ? 350 : 35)
    assert.equal(bot.swings, 2)
    clock.freeze(true)
    await clock.advanceWall(60000)
    assert.equal(bot.swings, 2)
    assert.equal(bot.targetDigBlock, stone)
    await clock.advanceGame(50)
    await digging
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 2])
    assert.equal(bot.lastDigTime, clock.now())
    assert.equal(bot.targetDigBlock, null)
    bot.emit('end')
    assert.equal(clock.pending(), 0)
  }
})

test('disconnect rejects waiting and mining and removes their timers and block listeners', async () => {
  const clock = testClock()
  const bot = install(clock, { digging: true })
  const stone = block('stone', new Vec3(1, 1, 0))
  const mining = bot.dig(stone, 'ignore')
  const waiting = bot.waitForTicks(10)
  const miningRejected = assert.rejects(mining, /aborted|disconnect/i)
  const waitingRejected = assert.rejects(waiting, /disconnect/i)
  bot.emit('end')
  await Promise.all([miningRejected, waitingRejected])
  assert.equal(clock.pending(), 0)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount(`blockUpdate:${stone.position}`), 0)
  const sent = bot.packets.length
  await clock.advanceGame(10000)
  assert.equal(bot.packets.length, sent)
  await assert.rejects(bot.dig(stone, 'ignore'), /disconnect/i)
})

test('pathfinder stuck budget counts game time while AStar keeps wall CPU time', async () => {
  const clock = testClock(200)
  const bot = install(clock, { pathfinder: true, physicsEnabled: false })
  const { goals } = require('mineflayer-pathfinder')
  const resets = []
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.setGoal(new goals.GoalBlock(6, 1, 0))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMoving(), true)
  clock.freeze(true)
  await clock.advanceWall(60000)
  bot.emit('physicsTick')
  assert.deepEqual(resets, [])
  const search = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(12, 1, 0))
  assert.equal(search.status, 'success')
  assert.ok(search.time > 0, 'AStar reports real CPU time even when the game clock is frozen')
  await clock.advanceGame(3500)
  bot.emit('physicsTick')
  assert.deepEqual(resets, [])
  await clock.advanceGame(50)
  bot.emit('physicsTick')
  assert.deepEqual(resets, ['stuck'])
  bot.emit('end')
})

test('adapter does not replace process Date, performance or native timers', async () => {
  const original = { Date, now: Date.now, performance: require('node:perf_hooks').performance, setTimeout, setInterval }
  const clock = testClock()
  const bot = install(clock, { digging: true, pathfinder: true })
  await clock.advanceGame(50)
  assert.equal(Date, original.Date)
  assert.equal(Date.now, original.now)
  assert.equal(require('node:perf_hooks').performance, original.performance)
  assert.equal(setTimeout, original.setTimeout)
  assert.equal(setInterval, original.setInterval)
  bot.emit('end')
})

function installInventory (clock) {
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.inventory(bot, {} as Record<string, any>)
  bot.QUICK_BAR_START = 36
  bot.quickBarSlot = 0
  bot.food = 10
  return bot
}

test('post-dig inventory click waits 500 game milliseconds and stays pending while frozen', async () => {
  const clock = testClock(200)
  const bot = installInventory(clock)
  bot.lastDigTime = clock.now()
  const clicking = bot.clickWindow(36, 0, 0)
  await clock.advanceGame(450)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), false)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), false)
  await clock.advanceGame(50)
  assert.equal(bot.packets.some(p => p.name === 'window_click'), true)
  bot.emit('end')
  await clicking.catch(() => {})
  assert.equal(clock.pending(), 0)
})

test('consume watchdog uses game time and is cancelled with its task on disconnect', async () => {
  const clock = testClock(200)
  const bot = installInventory(clock)
  const Item = require('prismarine-item')(data)
  bot.inventory.updateSlot(36, new Item(data.itemsByName.bread.id, 1))
  const consuming = bot.consume()
  const rejected = assert.rejects(consuming, /disconnect/i)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.usingHeldItem, true)
  bot.emit('end')
  await rejected
  assert.equal(clock.pending(), 0)
})

test('bed sleep keeps its listener while frozen and releases it on disconnect', async () => {
  const clock = testClock()
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.bed(bot)
  bot.time = { timeOfDay: 13000 }
  bot.canDigBlock = () => true
  bot.activateBlock = async () => {}
  const bed = block('white_bed', new Vec3(1, 1, 0))
  bot.blockAt = p => block('white_bed', p)
  const sleeping = bot.sleep(bed)
  sleeping.catch(() => {})
  assert.equal(bot.listenerCount('sleep'), 1)
  clock.freeze(true)
  await clock.advanceWall(60000)
  assert.equal(bot.listenerCount('sleep'), 1)
  bot.emit('end')
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('sleep'), 0)
  await assert.rejects(sleeping, /disconnect/i)
  assert.equal(clock.pending(), 0)
})

test('entity placement ignores unrelated spawns and clears its watchdog after success', async () => {
  const clock = testClock()
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  await new Promise<any>(resolve => setImmediate(resolve))
  bot.emit('entitySpawn', { name: 'cow', position: new Vec3(1, 1, 0) })
  assert.equal(bot.listenerCount('entitySpawn'), 1)
  const boat = { name: 'boat', position: new Vec3(1, 1, 0) }
  bot.emit('entitySpawn', boat)
  assert.equal(await placing, boat)
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  assert.equal(clock.pending(), 0)
  bot.emit('end')
})

test('entity placement rejects and removes its listener on disconnect', async () => {
  const clock = testClock()
  const { createTickPlugins } = require('../src/tick-plugins')
  const bot = testBot()
  createTickPlugins(clock).plugins.place_entity(bot)
  bot.heldItem = { name: 'oak_boat', type: data.itemsByName.oak_boat.id }
  bot._genericPlace = async reference => reference.position
  const placing = bot.placeEntity(block('stone', new Vec3(1, 0, 0)), new Vec3(0, 1, 0))
  placing.catch(() => {})
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 1)
  bot.emit('end')
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  await assert.rejects(placing, /disconnect/i)
  assert.equal(clock.pending(), 0)
})

test('unsupported Mineflayer updates fail before injecting plugins', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tick-plugins-'))
  try {
    fs.copyFileSync(path.join(__dirname, '../src/tick-plugins.js'), path.join(temporary, 'tick-plugins.js'))
    const packageDir = path.join(temporary, 'node_modules', 'mineflayer')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '4.37.2' }))
    const { createTickPlugins } = require(path.join(temporary, 'tick-plugins.js'))
    assert.throws(() => createTickPlugins(testClock()), /unsupported.*mineflayer.*4\.37\.2/i)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
