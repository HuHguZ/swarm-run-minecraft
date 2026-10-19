'use strict'
const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const { EventEmitter }: typeof import('node:events') = require('node:events')
const fs: typeof import('node:fs') = require('node:fs')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')
const { Vec3 }: typeof import('vec3') = require('vec3')
const { repoJson }: typeof import('../src/paths') = require('../src/paths')
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')

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
  const bot: any = new EventEmitter()
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
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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

test('native jump prediction traverses a water landing beyond its dry twenty-tick horizon', async () => {
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  const cells = repoJson('daemon/test/fixtures/water-landing-1.21.11.json')
  bot.blockAt = p => {
    const x = Math.floor(p.x) - 206, y = Math.floor(p.y) - 58, z = Math.floor(p.z) - 113
    const state = x >= 0 && x < 7 && y >= 0 && y < 8 && z >= 0 && z < 9 ? cells[(x * 8 + y) * 9 + z] : 0
    const b = Block.fromStateId(state, 0); b.position = p.floored(); return b
  }
  bot.entity.position = new Vec3(209.46764459511138, 61, 119.49874620143578)
  bot.entity.velocity = new Vec3(0, -0.0784000015258789, 0)
  const { Movements, goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const mv = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false
  bot.pathfinder.setMovements(mv)
  const walk = (require('../src/movement') as typeof import('../src/movement')).gotoGoal(bot, new goals.GoalNearXZ(209, 116, .5))
  let arrived = null
  walk.then(() => { arrived = bot.entity.position.clone() }, () => {})
  try {
    await clock.advanceGame(3000)
    assert.ok(arrived, `a physically reachable water landing must not leave every control released: ${bot.entity.position}`)
    assert.equal(Math.floor(arrived.z), 116, 'arrival must be reported inside the actual goal cell')
  } finally { walk.cancel(); bot.pathfinder.setGoal(null); bot.emit('end') }
})

test('empty partial A* traverses a known detour while the goal search continues', async () => {
  require('../src/fastblocks')
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  bot.blockAt = p => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    const floor = y === 0 && (z === 0 && x >= 0 && x <= 50 || x === 50 && z >= 0 && z <= 1000 || z === 1000 && x >= 0 && x <= 50)
    const wall = z === 1 && x >= 0 && x < 50 && y >= 1 && y <= 3
    return block(floor || wall ? 'stone' : 'air', p)
  }
  const { Movements, goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const mv = new Movements(bot)
  mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false; mv.maxDropDown = 1
  ;(require('../src/worlds') as typeof import('../src/worlds')).tuneMovements(bot, mv)
  const nativeNeighbors = mv.getNeighbors.bind(mv)
  mv.getNeighbors = node => {
    const until = performance.now() + .03
    while (performance.now() < until) {}
    return nativeNeighbors(node)
  }
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.tickTimeout = .01
  const goal = new goals.GoalBlock(0, 1, 1000)
  const walk = (require('../src/movement') as typeof import('../src/movement')).gotoGoal(bot, goal)
  walk.catch(() => {})
  let slicedWhileMoving = false
  bot.on('path_update', r => {
    if (r.status === 'partial' && bot.entity.position.x > 1) slicedWhileMoving = true
  })
  try {
    await clock.advanceGame(1000)
    assert.ok(bot.entity.position.x > 2, `ready sideways detour must move while the heuristic best is still the start: x=${bot.entity.position.x}`)
    assert.ok(slicedWhileMoving, 'native A* continues slicing while the executor walks')
    assert.equal(bot.pathfinder.goal, goal, 'partial progress must not claim arrival')
    walk.cancel(); bot.pathfinder.setGoal(null)
    await assert.rejects(walk, { name: 'PathStopped' })
    const at = bot.entity.position.clone()
    await clock.advanceGame(200)
    assert.ok(bot.entity.position.distanceTo(at) < .5, 'cancelled partial must not restart its search or controls')
  } finally { walk.cancel(); bot.emit('end') }
})

test('frontier fallback does not invent a step at an unexpanded start or a dead end', () => {
  const bot = install(testClock(), { pathfinder: true, physicsEnabled: false })
  const { Movements, goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  bot.blockAt = p => block(Math.floor(p.x) === 0 && Math.floor(p.z) === 0 && Math.floor(p.y) === 0 ? 'stone' : 'air', p)
  const mv = new Movements(bot)
  mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false; mv.maxDropDown = 1
  bot.pathfinder.setMovements(mv)
  const goal = new goals.GoalBlock(0, 1, 20)
  try {
    for (const [tickTimeout, status] of [[-1, 'partial'], [40, 'noPath']]) {
      const search = bot.pathfinder.getPathFromTo(mv, bot.entity.position, goal, { tickTimeout })
      const result = search.next().value.result
      assert.equal(result.status, status)
      assert.equal(result.path.length, 0)
      assert.equal(result.ndPartialNode, undefined, 'a native node must have a real parent before it can supply a step')
      search.return()
    }
  } finally { bot.emit('end') }
})

for (const support of ['soul_sand', 'oak_slab']) test(`native partial A* expands the original cell above ${support}`, () => {
  const bot = install(testClock(), { pathfinder: true, physicsEnabled: false })
  const { Movements, goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const Move = require('mineflayer-pathfinder/lib/move')
  bot.blockAt = p => block(p.y < 1 ? support : 'air', p)
  const movements = new Movements(bot)
  movements.canDig = true
  movements.allowParkour = false
  movements.allow1by1towers = false
  ;(require('../src/worlds') as typeof import('../src/worlds')).tuneMovements(bot, movements)
  bot.pathfinder.setMovements(movements)
  const search = bot.pathfinder.getPathFromTo(movements, bot.entity.position, new goals.GoalBlock(1000, 1, 0), {
    tickTimeout: .1, timeout: 10000, startMove: new Move(0, 1, 0, 0, 0)
  })
  try {
    let partial
    for (let i = 0; i < 100; i++) {
      partial = search.next().value
      if (partial?.result.path.length) break
    }
    assert.equal(partial.result.status, 'partial')
    const physical = partial.result.path.at(-1)
    assert.equal(partial.astarContext.bestNode.data, physical, 'native executor and continuing search share this Move')
    const position = physical.clone()
    const [x, y, z] = physical.hash.split(',').map(Number)
    assert.ok(physical.y < y, 'native postProcessPath uses the lower physical support top')
    const original = new Move(x, y, z, physical.remainingBlocks, physical.cost)
    assert.deepEqual(movements.getNeighbors(physical), movements.getNeighbors(original), 'postprocessing must preserve search costs, cells and required block actions')
    assert.deepEqual(physical.clone(), position, 'search normalization must not move the executor waypoint')
    const expand = movements.getNeighbors.bind(movements)
    let continued = false
    movements.getNeighbors = node => { if (node === physical) continued = true; return expand(node) }
    for (let i = 0; i < 100 && !continued; i++) search.next()
    assert.ok(continued, 'the native AStar continues expanding the postprocessed best node')
  } finally { search.return(); bot.emit('end') }
})

for (const api of ['helper', 'native']) for (const endpoint of [1000, 5]) test(`${api} goto keeps the partial A* detour before a wall: ${endpoint === 1000 ? 'search continues' : 'search succeeds mid-prefix'}`, async () => {
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  // The first move jumps across a two-cell gap. Later nodes turn back behind
  // a wall, closer to the start in Euclidean distance but unreachable directly.
  bot.blockAt = p => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    const wall = z === 1 && x >= -1 && x <= 2 && y >= 1 && y <= 3
    const floor = y === 0 && (x === 0 && z === 0 || x === 3 && z >= 0 && z <= 2 || z === 2 && x >= 0 && x <= 3 || x === 0 && z >= 2 && z <= 1000)
    return block(wall || floor ? 'stone' : 'air', p)
  }
  const { goals, Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const { gotoGoal, pathKeepAlive }: typeof import('../src/movement') = require('../src/movement')
  const mv = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false; mv.maxDropDown = 1
  mv.exclusionAreasStep.push(() => .001)
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.tickTimeout = .01
  const keep = pathKeepAlive(bot)
  let first = null; let partials = 0; let searchingWhileWalking = false
  const onPath = r => {
    if (r.status !== 'partial') return
    partials++
    if (!first && r.path.length) first = r.path[0].clone()
    if (bot.entity.position.z > 4) searchingWhileWalking = true
  }
  const goal = new goals.GoalBlock(0, 1, endpoint)
  const walk = api === 'native' ? bot.pathfinder.goto(goal) : gotoGoal(bot, goal)
  walk.catch(() => {})
  // Installed after gotoGoal: inspect the prefix the native executor receives.
  bot.on('path_update', onPath)
  try {
    await clock.advanceGame(6000)
    assert.deepEqual(first, new Vec3(3.5, 1, .5), 'the jump before the wall must survive native nearest-node trimming')
    if (endpoint === 1000) {
      assert.ok(bot.entity.position.z > 8, `the body must traverse the prefix; z=${bot.entity.position.z}`)
      assert.ok(partials > 20 && searchingWhileWalking, 'walking must overlap continued native A* slices')
      assert.equal(bot.pathfinder.goal !== null, true, 'the far goal remains pending, rather than claiming partial arrival')
    } else {
      await walk
      assert.ok(goal.isEnd(bot.entity.position.floored()), 'finish the active prefix and then the final path')
      assert.equal(bot.pathfinder.goal, null)
    }
  } finally { walk.cancel?.(); bot.pathfinder.setGoal(null); keep.stop(); bot.removeListener('path_update', onPath); bot.emit('end') }
})

test('native goto opt-out keeps the reviewed upstream goal contract', async () => {
  const previous = process.env.ND_GOTO_WAIT
  process.env.ND_GOTO_WAIT = '0'
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  const goal = new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals.GoalBlock)(0, 1, 0)
  const walk = bot.pathfinder.goto(goal)
  walk.catch(() => {})
  try {
    assert.equal(Object.hasOwn(goal, 'isEnd'), false, 'disabled helper must not replace the native goal predicate')
    await clock.advanceGame(50)
    await walk
    assert.equal(bot.pathfinder.goal, null)
  } finally {
    bot.pathfinder.setGoal(null); bot.emit('end')
    if (previous === undefined) delete process.env.ND_GOTO_WAIT
    else process.env.ND_GOTO_WAIT = previous
  }
})

test('pathfinder cancels detached steering on disconnect and awaited look still rejects', async () => {
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  ;(require('../src/reflex-lock') as typeof import('../src/reflex-lock')).install({ bot })
  const look = bot.look
  let steered = 0
  bot.look = (...args) => { steered++; return look(...args) }
  bot.pathfinder.setGoal(new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals.GoalBlock)(0, 1, 8))
  await clock.advanceGame(50)
  assert.ok(steered > 0, 'the production pathfinder has an unawaited steering call')
  bot.emit('end')
  await assert.rejects(bot.look(2, 0), { code: 'DISCONNECTED' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(clock.pending(), 0)
})

test('installed physics warns for external deprecated listeners but not marked late aim callbacks', async t => {
  const clock = testClock()
  const bot = install(clock)
  const warnings = []
  t.mock.method(console, 'warn', message => { warnings.push(String(message)) })
  let ownCalls = 0; let externalCalls = 0
  const own = (require('node:async_hooks') as typeof import('node:async_hooks')).AsyncResource.bind(() => { ownCalls++ })
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
  const { GameClock }: typeof import('../src/game-clock') = require('../src/game-clock')
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
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(testClock()).plugins.physics(bot, { physicsEnabled: false })
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
  const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
  const bow: typeof import('../src/bow') = require('../src/bow')
  const threats: typeof import('../src/threats') = require('../src/threats')
  const Entity = require('prismarine-entity')('1.21.11')
  let currentClock: any
  t.mock.method(gameClock, 'observationNow', () => currentClock.now())
  t.mock.method(gameClock, 'now', () => currentClock.now())
  const results = []
  for (const trace of [false, true]) {
    currentClock = testClock(750)
    const bot = testBot()
    require('mineflayer/lib/plugins/entities')(bot)
    ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(currentClock).plugins.physics(bot, { physicsEnabled: false })
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
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11')
  const enemy = new Entity(2); enemy.position = new Vec3(0, 100, 0); enemy.metadata[0] = 0
  bot.entities[enemy.id] = enemy
  bot.emit('entitySpawn', enemy)
  const tracker = (require('../src/bow') as typeof import('../src/bow')).trackTarget(enemy)
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
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
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
  const tracker = (require('../src/bow') as typeof import('../src/bow')).trackTarget(enemy)
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
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
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
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(testClock()).plugins.physics(bot, { physicsEnabled: false })
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
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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
  const { AsyncLocalStorage, AsyncResource }: typeof import('node:async_hooks') = require('node:async_hooks')
  const owner = new AsyncLocalStorage()
  const clock = testClock(750)
  const bot = install(clock)
  const afterPacket = (require('../src/edges') as typeof import('../src/edges')).afterPacket
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

test('native physics walks a partial route while accelerated AStar continues computing', async t => {
  require('../src/fastblocks')
  const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
  t.mock.method(gameClock, 'snapshot', () => ({ tickRate: 750 }))
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  const keepAlive = (require('../src/movement') as typeof import('../src/movement')).pathKeepAlive(bot)
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  bot.pathfinder.movements.canDig = false
  bot.pathfinder.movements.allow1by1towers = false
  const updates = []
  bot.on('path_update', r => updates.push(r.status))
  bot.pathfinder.setGoal(new goals.GoalBlock(5000, 1, 0))
  try {
    await clock.advanceGame(600)
    assert.ok(updates.length > 2)
    assert.ok(updates.every(status => status === 'partial'), 'the long route has not finished computing')
    assert.ok(bot.entity.position.x > 1, 'actual prismarine physics moved along the partial prefix')
    assert.ok(bot.packets.some(packet => packet.name === 'position' || packet.name === 'position_look'), 'movement reached the packet boundary before the final route')
  } finally { keepAlive.stop(); bot.pathfinder.setGoal(null); bot.emit('end') }
  assert.equal(clock.pending(), 0)
})

test('pathfinder stuck budget counts game time while AStar keeps wall CPU time', async () => {
  const clock = testClock(200)
  const bot = install(clock, { pathfinder: true, physicsEnabled: false })
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
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
  const original = { Date, now: Date.now, performance: (require('node:perf_hooks') as typeof import('node:perf_hooks')).performance, setTimeout, setInterval }
  const clock = testClock()
  const bot = install(clock, { digging: true, pathfinder: true })
  await clock.advanceGame(50)
  assert.equal(Date, original.Date)
  assert.equal(Date.now, original.now)
  assert.equal((require('node:perf_hooks') as typeof import('node:perf_hooks')).performance, original.performance)
  assert.equal(setTimeout, original.setTimeout)
  assert.equal(setInterval, original.setInterval)
  bot.emit('end')
})

function installInventory (clock) {
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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
  const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(data)
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
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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
  const { createTickPlugins }: typeof import('../src/tick-plugins') = require('../src/tick-plugins')
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

test('native executor continues a jump around a soul sand stair corner', async () => {
  const clock = testClock(750)
  const bot = install(clock, { pathfinder: true })
  // W24's actual 7x7x6 block box, translated to the origin. Layers are Y,
  // rows X, columns Z; s=soul sand, r=netherrack, .=air. No seed knowledge.
  const layers = [
    ['sss.ss', 'rrsssr', 'rrssrr', 'rrrrrr', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['ss....', 'rs....', 'rrssrr', 'rrrsrr', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['s.....', 'sss...', 'rss...', 'rrssrr', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['s.....', 'ss....', 'sss...', 'rs..rr', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['......', 'ss....', 'ss....', 'sr..rr', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['......', 's.....', 'ss....', 'srr...', 'rrrrrr', 'rrrrrr', 'rrrrrr'],
    ['......', '......', 's.....', 'rr....', 'rrrrrr', 'rrrrrr', 'rrrrrr']
  ]
  bot.blockAt = p => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    const cell = layers[y + 1]?.[x + 2]?.[z + 3]
    return cell ? block(cell === 's' ? 'soul_sand' : cell === 'r' ? 'netherrack' : 'air', p) : null
  }
  bot.entity.position.set(.5, .875, .48956619325173)
  const { Movements, goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const mv = new Movements(bot)
  mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false
  ;(require('../src/worlds') as typeof import('../src/worlds')).tuneMovements(bot, mv)
  bot.pathfinder.setMovements(mv)
  const goal = new goals.GoalNearXZ(1, -1, .25)
  const walk = (require('../src/movement') as typeof import('../src/movement')).gotoGoal(bot, goal)
  walk.catch(() => {})
  try {
    await clock.advanceGame(3000)
    assert.ok(goal.isEnd(bot.entity.position.floored()),
      `the known stair must be walked rather than rejected after one simulated second: ${bot.entity.position}`)
    await walk
    assert.ok(goal.isEnd(bot.entity.position.floored()), 'arrival still requires the body at the actual landing')
  } finally { walk.cancel(); bot.pathfinder.setGoal(null); bot.emit('end') }
})


function blockedBastionPrefix () {
  const bot = install(testClock(750), { pathfinder: true, physicsEnabled: false })
  const cells = repoJson('daemon/test/fixtures/bastion-head-jump-1.21.11.json')
  bot.blockAt = p => {
    const x = Math.floor(p.x) + 111, y = Math.floor(p.y) - 92, z = Math.floor(p.z) - 40
    const state = x >= 0 && x < 9 && y >= 0 && y < 8 && z >= 0 && z < 8 ? cells[(x * 8 + y) * 8 + z] : 0
    const b = Block.fromStateId(state, 0); b.position = p.floored(); return b
  }
  bot.entity.position = new Vec3(-107.3727390983362, 95.875, 43.987427419565556)
  bot.entity.velocity = new Vec3(0, 0, 0)
  const mv = new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).Movements)(bot)
  mv.canDig = false; mv.allow1by1towers = false
  bot.pathfinder.setMovements(mv)
  const move = (x, y, z): import('vec3').Vec3 & Record<string, any> => Object.assign(new Vec3(x, y, z), { hash: [Math.floor(x), Math.ceil(y), Math.floor(z)].join(','), toBreak: [], toPlace: [] })
  const first = move(-108.5, 96.875, 44.5)
  const detour = [move(-108.5, 96.875, 43.5), move(-108.5, 95, 42.5), move(-109.5, 94, 42.5), move(-110.5, 94, 42.5), move(-111.5, 94, 42.5)]
  const start = { data: bot.entity.position, parent: null }
  const best = { data: first, parent: start }
  let terminal = start
  for (const data of detour) terminal = { data, parent: terminal }
  const context = { bestNode: best, openDataMap: new Map([[detour.at(-1).hash, terminal]]) }
  // Only the search publications are controlled: physical eligibility uses the
  // same installed Physics instance and terrain captured from the native stall.
  bot.pathfinder.setGoal = () => {}
  const goal = new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals.GoalNearXZ)(-114, 44, 3)
  const walk = (require('../src/movement') as typeof import('../src/movement')).gotoGoal(bot, goal)
  walk.catch(() => {})
  bot.emit('path_update', { status: 'partial', context, path: [first] })
  const finish = () => {
    const result = { status: 'success', context, path: detour.slice(1) }
    bot.emit('path_update', result)
    return result.path
  }
  return { bot, first, detour, context, finish, walk, close: () => { walk.cancel(); bot.emit('end') } }
}

test('terminal A* replaces a head-blocked held prefix with its actual ready parent chain', () => {
  const scene = blockedBastionPrefix()
  try {
    assert.equal(scene.bot.pathfinder.canMove?.([scene.first]), false, 'the native executor rejects the low-headroom diagonal jump')
    assert.equal(scene.bot.pathfinder.canMove(scene.detour), true, 'the terminal cardinal jump is physically executable')
    assert.deepEqual(scene.finish(), scene.detour, 'retain the intermediate jump trimmed out of the terminal publication, not the old bestNode')
  } finally { scene.close() }
})

for (const condition of ['working jump', 'airborne', 'mining', 'building', 'break', 'place', 'bridge', 'descend', 'missing predicate']) test('terminal A* keeps the held prefix during ' + condition, () => {
  const scene = blockedBastionPrefix()
  try {
    if (condition === 'working jump') scene.bot.pathfinder.canMove = () => true
    if (condition === 'missing predicate') delete scene.bot.pathfinder.canMove
    if (condition === 'airborne') scene.bot.entity.onGround = false
    if (condition === 'mining') scene.bot.pathfinder.isMining = () => true
    if (condition === 'building') scene.bot.pathfinder.isBuilding = () => true
    if (condition === 'break') scene.first.toBreak.push(new Vec3(-108, 98, 44))
    if (condition === 'place') scene.first.toPlace.push({ x: -108, y: 95, z: 44 })
    if (condition === 'bridge') scene.first.ndBridge = true
    if (condition === 'descend') scene.first.ndDescend = true
    assert.deepEqual(scene.finish(), [scene.first])
  } finally { scene.close() }
})

test('terminal A* cannot invent an alternative chain or complete a physically unconsumed goal', async () => {
  const scene = blockedBastionPrefix()
  try {
    scene.context.openDataMap.clear()
    assert.deepEqual(scene.finish(), [scene.first], 'a different bestNode is not the successful terminal node')
    let done = false; scene.walk.then(() => { done = true }, () => {})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(done, false, 'ready A* success is not physical arrival')
  } finally { scene.close() }
})
