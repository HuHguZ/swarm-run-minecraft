'use strict'
// Mineflayer keeps the vanilla 50 ms integrator. Only its gameplay scheduler
// and elapsed-time measurements use our clock. Modules are evaluated with
// lexical timer bindings, never by modifying globals or node_modules.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')

// Reviewed sources from Mineflayer 4.37.1 and pathfinder 2.4.5. Fail closed on
// upgrades (including local patches) so a changed scheduler cannot slip through.
const hashes = {
  physics: 'e6faedca2bab274c6d1ae5dc50e9ee7c57af9576174061b033da0cd50aec7dda',
  digging: 'e615773295934145c59dbcd8502316def235ff337ea77f42d5a5781a4474a85e',
  inventory: 'c670bd9caf47d7ad91054ef0f7a1fecbff4a986f08d43532342991bdedb585c5',
  bed: 'b35d8b8476bbb53e6dc306da28522a19eea0b9832f907a9af10f22149f0a8650',
  anvil: '3cb840aae6b70a70a40e9c41a91be5ac97e84b15da1481b5eba6509862cedffb',
  place_entity: '447d85fb13cb77cc9779b4340039a76bcce3ae8ab32506cdef9b4432cca616fc',
  creative: '4d9e201b26cce07edc245cf213af1bebdc546e6caf6312c8d4da15d90b9172b2',
  book: '9dcda2bff2e32209ccedfaff16da406654e1bc8a9614a17531c210848f401cf2',
  craft: 'bb58944902a220874e1815d8ff272d6b60286759a133c892709602fefe7fc4fc',
  enchantment_table: 'cf23cf6cb5aad875f215f768a86d473894115a55bc65fe813147a6bf10a5dc97',
  villager: 'e66e85cd726620c745d1c69a0aaa475c78e50f507f273dd2007aa5660f09ca35',
  place_block: '9a8a418c64419602dc6244884515b5031a7454c2cf6337de9d35701688bfea68',
  pathfinder: 'bfb62da3111470fa3f515ed89a95bc5018843d89b883ebafa97410d2f14d4fae',
  pathfinderPhysics: '0facdd741f6eab551a9d012f34d36c043181a743a6c855e19f72d8a482dec5fc'
}

function reviewedSource (filename, expected, name) {
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  if (createHash('sha256').update(source).digest('hex') !== expected) {
    throw new Error(`Unsupported ${name} source for tick-plugins; review the installed dependency before updating its signature`)
  }
  return { filename, source }
}

let cachedPhysics
function getPhysics () {
  if (cachedPhysics) return cachedPhysics
  const version = require('prismarine-physics/package.json').version
  if (version !== '1.11.1') throw new Error(`Unsupported prismarine-physics ${version} for tick-plugins; reviewed version is 1.11.1`)
  const { filename, source } = reviewedSource(require.resolve('prismarine-physics'),
    '90f1c249a2a7b43f8e8cae8ef3a7f06b5f1fee5dad8d3efa09d8d9b2dd5a2719', 'prismarine-physics')
  const nativeRequire = createRequire(filename)
  const climbableData = require('../data/climbable-1.21.11.json')
  if (climbableData.version !== '1.21.11' || !Array.isArray(climbableData.climbable?.values) || climbableData.climbable.values.some(value => typeof value !== 'string' || !value.startsWith('minecraft:'))) throw new Error('Invalid reviewed vanilla climbable block tag')
  // LivingEntity.onClimbable uses BlockTags.CLIMBABLE. Upstream only knows the
  // two old ids; retain its clamps/acceleration and use the exact vanilla tag.
  const taggedSource = source.replace('  const vineId = blocksByName.vine.id', `  const vineId = blocksByName.vine.id
  const ndClimbableIds = new Set(mcData.version.minecraftVersion === '1.21.11'
    ? ndClimbableNames.map(name => blocksByName[name]?.id).filter(id => id !== undefined) : [])`)
    .replace('block.type === ladderId || block.type === vineId', 'block.type === ladderId || block.type === vineId || ndClimbableIds.has(block.type)')
  if (taggedSource === source || !taggedSource.includes('ndClimbableIds.has(block.type)')) throw new Error('Cannot apply reviewed climbable tag to native physics')
  const modules = new Map()
  const data = new Map()
  const scopedRequire = request => {
    if (!modules.has(request)) {
      let value = nativeRequire(request)
      if (request === 'minecraft-data') {
        const factory = value
        // PlayerState resolves metadata on every construction. Keep the native
        // factory's exact cached object; effects/equipment still read the bot.
        value = version => {
          if (!data.has(version)) data.set(version, factory(version))
          return data.get(version)
        }
      }
      modules.set(request, value)
    }
    return modules.get(request)
  }
  const localModule = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'ndClimbableNames',
    `${taggedSource}\n//# sourceURL=${filename.replace(/\\/g, '/')}`)(scopedRequire, localModule, localModule.exports, filename, path.dirname(filename), climbableData.climbable.values.map(value => value.slice('minecraft:'.length)))
  return (cachedPhysics = localModule.exports)
}

function supportedSources () {
  for (const [name, expected] of [['mineflayer', '4.37.1'], ['mineflayer-pathfinder', '2.4.5']]) {
    const actual = require(`${name}/package.json`).version
    if (actual !== expected) throw new Error(`Unsupported ${name} ${actual} for tick-plugins; reviewed version is ${expected}`)
  }
  return Object.fromEntries((Object.entries(hashes) as [string, any][]).map(([name, expected]) => {
    const filename = require.resolve(name === 'pathfinder' ? 'mineflayer-pathfinder' : name === 'pathfinderPhysics' ? 'mineflayer-pathfinder/lib/physics' : `mineflayer/lib/plugins/${name}`)
    return [name, reviewedSource(filename, expected, name)]
  }))
}

function disconnected () {
  const error: any = new Error('Disconnected while waiting for game ticks')
  error.code = 'DISCONNECTED'
  return error
}

function createScope (bot, clock) {
  const timers = new Map()
  const cleanups = new Set()
  const wall = clock.wall || require('./game-clock').wall
  const scope: any = { closed: false, now: () => clock.now(), observationNow: () => clock.observationNow?.() ?? clock.now(), cleanups }
  function clear (handle) {
    if (!timers.has(handle)) return
    const { interval, owner } = timers.get(handle)
    timers.delete(handle)
    if (interval) owner.clearInterval(handle)
    else owner.clearTimeout(handle)
  }
  function schedule (fn, ms, interval, args, owner = clock) {
    if (scope.closed) return null
    let handle
    const callback = (...values: any[]) => {
      if (!interval) timers.delete(handle)
      if (!scope.closed) fn(...values)
    }
    handle = interval ? owner.setInterval(callback, ms, ...args) : owner.setTimeout(callback, ms, ...args)
    timers.set(handle, { interval, owner })
    return handle
  }
  scope.setTimeout = (fn, ms, ...args: any[]) => schedule(fn, ms, false, args)
  scope.setInterval = (fn, ms, ...args: any[]) => schedule(fn, ms, true, args)
  scope.clearTimeout = clear
  scope.clearInterval = clear
  scope.wall = { now: () => wall.now(), setTimeout: (fn, ms, ...args: any[]) => schedule(fn, ms, false, args, wall) }
  scope.Date = class extends Date { static now () { return clock.now() } }
  scope.writePacket = (...args: any[]) => { if (!scope.closed) bot._client.write(...args) }
  bot.once('end', () => {
    scope.closed = true
    for (const cleanup of ([...cleanups] as any)) cleanup()
    for (const handle of [...timers.keys()]) clear(handle)
    cleanups.clear()
  })
  // Explicitly scoped Promise helpers. Upstream blocks/chat still import their
  // original wall-time helpers for network and chunk/CPU watchdogs.
  function createTask () {
    const task: any = { done: false }
    let resolve, reject
    task.promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
    task.finish = value => { if (!task.done) { task.done = true; resolve(value) } }
    task.cancel = error => { if (!task.done) { task.done = true; reject(error) } }
    const cancelOnEnd = () => task.cancel(disconnected())
    cleanups.add(cancelOnEnd)
    task.promise.then(() => cleanups.delete(cancelOnEnd), () => cleanups.delete(cancelOnEnd))
    if (scope.closed) cancelOnEnd()
    return task
  }
  function sleep (ms) {
    const task: any = createTask()
    const timer = scope.setTimeout(task.finish, ms)
    task.promise.then(() => clear(timer), () => clear(timer))
    return task.promise
  }
  function onceWithCleanup (emitter, event, { timeout = 0, checkCondition }: any = {}) {
    const task: any = createTask()
    const listener = (...args: any[]) => {
      if (typeof checkCondition !== 'function' || checkCondition(...args)) task.finish(args)
    }
    emitter.on(event, listener)
    const error = new Error(`Event ${event} did not fire within timeout of ${timeout}ms`)
    const timer = timeout > 0 ? scope.setTimeout(() => task.cancel(error), timeout) : null
    const cleanup = () => { emitter.removeListener(event, listener); clear(timer) }
    task.promise.then(cleanup, cleanup)
    return task.promise
  }
  function withTimeout (promise, ms) {
    const task: any = createTask()
    const timer = scope.setTimeout(() => task.cancel(new Error('Promise timed out.')), ms)
    Promise.resolve(promise).then(task.finish, task.cancel)
    task.promise.then(() => clear(timer), () => clear(timer))
    return task.promise
  }
  scope.promiseUtils = {
    createTask,
    createDoneTask: () => ({ done: true, promise: Promise.resolve(), finish: () => {}, cancel: () => {} }),
    sleep, onceWithCleanup, once: (emitter, event, timeout = 20000) => onceWithCleanup(emitter, event, { timeout }), withTimeout
  }
  return scope
}

function compilePlugin ({ filename, source }: any, scope, name, sources) {
  if (name === 'physics') {
    // The game clock already schedules one turn per tick. Reusing the upstream
    // wall-time accumulator would permit burst catchup and skip microtask turns.
    source = source.replace(/  function doPhysics \(\) \{[\s\S]*?\n  function tickPhysics \(now\)/,
      '  function doPhysics () {\n    tickPhysics(performance.now())\n  }\n\n  function tickPhysics (now)')
    // Backport the reviewed tick boundary from Mineflayer PR #4137. The end
    // packet follows movement even if terrain isn't loaded or simulation is off.
    source = source.replace(/  function tickPhysics \(now\) \{[\s\S]*?\n  \/\/ remove this/,
      `  const sendsTickEnd = bot.supportFeature('sendsClientTickEndPacket')
  function tickPhysics (now) {
    if (bot._client.state !== 'play') return
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return
    if (bot.blockAt(bot.entity.position) != null) {
      if (bot.physicsEnabled && shouldUsePhysics) {
        physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
        bot.emit('physicsTick')
        bot.emit('physicTick')
      }
      if (shouldUsePhysics) updatePosition(now)
    }
    if (sendsTickEnd) writePacket('tick_end', {})
    bot.emit('ndMovementSent')
  }

  // remove this`)
    // Only our marked late aim callbacks intentionally use this boundary.
    // External deprecated listeners keep the upstream warning.
    source = source.replace("bot.on('newListener', (name) => {", "bot.on('newListener', (name, listener) => {")
      .replace("if (name === 'physicTick') console.warn", "if (name === 'physicTick' && listener?._ndLatePacketAim !== true) console.warn")
    // Respawn's delayed position reply completes a network handshake even when
    // the world is frozen. Keep only its eligibility stamp and response on wall.
    source = source.replace('Date.now() - respawnTimer', 'scopedWall.now() - respawnTimer')
      .replace('respawnTimer = Date.now()', 'respawnTimer = scopedWall.now()')
      .replace('      setTimeout(() => {\n        sendPacketPositionAndLook(delayedPos',
        '      scopedWall.setTimeout(() => {\n        sendPacketPositionAndLook(delayedPos')
  }
  if (name === 'inventory') source = source.replace('new Date() - bot.lastDigTime', 'Date.now() - bot.lastDigTime')
  if (name === 'bed') {
    source = source.replace(/  async function waitUntilSleep \(\) \{[\s\S]*?\n  bot\._client\.on/,
      `  async function waitUntilSleep () {
    try { await scopedPromiseUtils.once(bot, 'sleep', 3000) } catch (error) {
      if (error.code === 'DISCONNECTED') throw error
      throw new Error('bot is not sleeping')
    }
  }

  bot._client.on`)
  }
  if (name === 'place_entity') {
    source = source.replace('function waitForEntitySpawn (', 'async function waitForEntitySpawn (')
    // An unrelated spawn must not remove our listener. The shared helper also
    // cancels both the listener and watchdog on success or disconnect.
    source = source.replace(/    return new Promise\(\(resolve, reject\) => \{[\s\S]*?\n    \}\)\n  \}/,
      `    try {
      const [entity] = await scopedPromiseUtils.onceWithCleanup(bot, 'entitySpawn', {
        timeout: 5000,
        checkCondition: entity => entity.name === mobName && entity.position.distanceTo(placePosition) < maxDistance
      })
      return entity
    } catch (error) {
      if (error.code === 'DISCONNECTED') throw error
      throw new Error('Failed to place entity')
    }
  }`)
  }
  source = source.replaceAll('bot._client.write(', 'writePacket(')
  const nativeRequire = createRequire(filename)
  const scopedRequire = request => {
    if (request === 'prismarine-physics') return getPhysics()
    if (name === 'pathfinder' && request === './lib/physics') return compilePlugin(sources.pathfinderPhysics, scope, 'pathfinderPhysics', sources)
    if (request === 'perf_hooks' || request === 'node:perf_hooks') return { performance: { now: scope.now } }
    if (request === '../promise_utils') return scope.promiseUtils
    // AStar's native performance.now measures CPU work, not gameplay duration.
    return nativeRequire(request)
  }
  const localModule: any = { exports: {} }
  const evaluate = new Function('require', 'module', 'exports', '__filename', '__dirname',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'writePacket', 'scopedPromiseUtils', 'scopedWall',
    `${source}\n//# sourceURL=${filename.replace(/\\/g, '/')}`)
  evaluate(scopedRequire, localModule, localModule.exports, filename, path.dirname(filename),
    scope.setTimeout, scope.clearTimeout, scope.setInterval, scope.clearInterval, scope.Date, scope.writePacket, scope.promiseUtils, scope.wall)
  return name === 'pathfinder' ? localModule.exports.pathfinder : localModule.exports
}

function installTickWait (bot, scope) {
  bot.waitForTicks = async ticks => {
    if (ticks <= 0) return
    if (!Number.isSafeInteger(ticks)) throw new RangeError('waitForTicks requires an integer tick count')
    const task = scope.promiseUtils.createTask()
    const listener = () => { if (--ticks === 0) task.finish() }
    bot.on('physicsTick', listener)
    const timer = scope.setTimeout(() => task.cancel(new Error('Timeout waiting for game ticks')), ticks * 50 + 5000)
    try { await task.promise } finally { bot.removeListener('physicsTick', listener); scope.clearTimeout(timer) }
  }
}

function observeEntityGround (bot, scope) {
  let bornVelocity = null
  const nativeVelocity = (packet, meta, bytes) => {
    if (bot.version !== '1.21.11' || !packet || packet.entityId === bot.entity?.id ||
      (meta?.name !== 'spawn_entity' && meta?.name !== 'entity_velocity')) return
    const velocity = require('./drops').velocityFromRaw(bytes, meta.name === 'spawn_entity' ? 'spawn' : 'velocity')
    // Raw events precede the installed entities plugin. Its legacy conversion
    // divides by 8000; supply the exact native LPVec3 in those expected units.
    if (!velocity) return
    if (meta.name === 'spawn_entity') bornVelocity = { id: packet.entityId, ...velocity }
    else packet.velocity = { x: velocity.x * 8000, y: velocity.y * 8000, z: velocity.z * 8000 }
  }
  bot._client.on('packet', nativeVelocity)
  // Mineflayer's entities plugin reads position/look, but drops the native
  // onGround field. Set it before that plugin emits entityMoved; self contact
  // remains owned by the unchanged player physics integration.
  const names = ['rel_entity_move', 'entity_move_look', 'entity_look', 'entity_teleport', 'sync_entity_position']
  const rockets = new Map()
  const glideState = entity => {
    if (!entity || entity === bot.entity || !(entity.name === 'player' || entity.type === 'player' ||
      require('./elytra').gliding(entity) || entity._ndGlideObservedState)) return
    const state = { yaw: entity.yaw, pitch: entity.pitch, flag: (entity.metadata?.[0] ?? 0) & 128,
      pose: entity.metadata?.[6], boosted: !!entity._ndGlideBoosted }
    const previous = entity._ndGlideObservedState
    if (previous && Object.keys(state).some(key => state[key] !== previous[key])) entity._ndGlideRevision = (entity._ndGlideRevision || 0) + 1
    entity._ndGlideObservedState = state
  }
  const updateBoost = id => {
    const entity = bot.entities?.[id]
    if (entity && entity !== bot.entity) { entity._ndGlideBoosted = [...rockets.values()].includes(id); glideState(entity) }
  }
  const rocketUpdate = entity => {
    glideState(entity)
    if (entity?.name !== 'firework_rocket') return
    const index = bot.registry?.entitiesByName?.firework_rocket?.metadataKeys?.indexOf('attached_to_target') ?? -1
    const attached = index < 0 ? null : entity.metadata?.[index]
    const previous = rockets.get(entity.id)
    // 1.21.11 OptVarInt is zero for none, otherwise entity id + 1.
    if (typeof attached === 'number' && attached > 0) rockets.set(entity.id, attached - 1)
    else rockets.delete(entity.id)
    if (previous !== undefined) updateBoost(previous)
    if (rockets.has(entity.id)) updateBoost(rockets.get(entity.id))
  }
  const rocketGone = entity => {
    const previous = rockets.get(entity?.id)
    rockets.delete(entity?.id)
    if (previous !== undefined) updateBoost(previous)
  }
  bot.on('entityUpdate', rocketUpdate); bot.on('entityGone', rocketGone)
  const listeners = names.map(name => {
    const observe = packet => {
      const entity = bot.entities?.[packet.entityId]
      if (!entity || entity === bot.entity) return
      if (typeof packet.onGround === 'boolean') entity.onGround = packet.onGround
      if (name !== 'entity_look') entity._ndPositionPacket = name
    }
    bot._client.prependListener(name, observe)
    return [name, observe]
  })
  const stamp = (entity, spawned = false) => {
    // Look/metadata changes invalidate a model even if they reverse before the
    // next move. They never create or redate a position receipt.
    glideState(entity)
    if (!entity?.position || entity === bot.entity || (!spawned && !entity._ndPositionPacket)) return
    // The installed spawn_entity handler omits initial velocity entirely.
    if (spawned && bornVelocity?.id === entity.id) {
      entity.velocity.set(bornVelocity.x, bornVelocity.y, bornVelocity.z)
      bornVelocity = null
    }
    const kind = spawned ? 'spawn_entity' : entity._ndPositionPacket
    if (spawned) updateBoost(entity.id)
    delete entity._ndPositionPacket
    const previous = entity._ndPositionReceipts?.[1] ?? null
    entity._ndPositionReceipts = [previous, { x: entity.position.x, y: entity.position.y, z: entity.position.z,
      t: scope.observationNow(), grounded: entity.onGround === true, kind,
      yaw: entity.yaw, pitch: entity.pitch, flying: require('./elytra').gliding(entity), boosted: !!entity._ndGlideBoosted,
      revision: entity._ndGlideRevision || 0 }]
    entity._ndObservationNow = scope.observationNow
    entity.emit?.('ndPositionObserved')
  }
  const spawned = entity => stamp(entity, true)
  // Run after upstream changed position, before any diagnostic/aim consumer.
  bot.prependListener('entityMoved', stamp)
  bot.prependListener('entitySpawn', spawned)
  scope.cleanups.add(() => {
    bot._client.removeListener('packet', nativeVelocity)
    for (const [name, observe] of listeners) bot._client.removeListener(name, observe)
    bot.removeListener('entityMoved', stamp); bot.removeListener('entitySpawn', spawned)
    bot.removeListener('entityUpdate', rocketUpdate); bot.removeListener('entityGone', rocketGone)
    rockets.clear()
  })
}

function createTickPlugins (clock) {
  const sources = supportedSources()
  const scopes = new WeakMap()
  function inject (name) {
    return (bot, options: any = {}) => {
      let scope = scopes.get(bot)
      if (!scope) { scope = createScope(bot, clock); scopes.set(bot, scope) }
      compilePlugin(sources[name], scope, name, sources)(bot, options)
      if (name === 'physics') { installTickWait(bot, scope); observeEntityGround(bot, scope) }
      if (name === 'digging') {
        scope.cleanups.add(() => { if (bot.targetDigBlock) bot.stopDigging() })
        const dig = bot.dig
        bot.dig = (...args: any[]) => scope.closed ? Promise.reject(disconnected()) : dig(...args)
      }
    }
  }
  return {
    plugins: Object.fromEntries(Object.keys(hashes).filter(name => !name.startsWith('pathfinder')).map(name => [name, inject(name)])),
    pathfinder: inject('pathfinder')
  }
}

let defaults
function defaultPlugins () { return defaults || (defaults = createTickPlugins(require('./game-clock'))) }
module.exports = { createTickPlugins, getPhysics }
Object.defineProperties(module.exports, {
  plugins: { enumerable: true, get: () => defaultPlugins().plugins },
  pathfinder: { enumerable: true, get: () => defaultPlugins().pathfinder }
})
