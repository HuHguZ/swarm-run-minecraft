'use strict'
// Mineflayer keeps the vanilla 50 ms integrator. Only its gameplay scheduler
// and elapsed-time measurements use our clock. Modules are evaluated with
// lexical timer bindings, never by modifying globals or node_modules.
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { createHash }: typeof import('node:crypto') = require('node:crypto')
const { createRequire }: typeof import('node:module') = require('node:module')

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
  const version = (require('prismarine-physics/package.json') as typeof import('prismarine-physics/package.json')).version
  if (version !== '1.11.1') throw new Error(`Unsupported prismarine-physics ${version} for tick-plugins; reviewed version is 1.11.1`)
  const { filename, source } = reviewedSource(require.resolve('prismarine-physics'),
    '90f1c249a2a7b43f8e8cae8ef3a7f06b5f1fee5dad8d3efa09d8d9b2dd5a2719', 'prismarine-physics')
  const nativeRequire = createRequire(filename)
  const climbableData = (require('./paths') as typeof import('./paths')).repoJson('daemon/data/climbable-1.21.11.json')
  if (climbableData.version !== '1.21.11' || !Array.isArray(climbableData.climbable?.values) || climbableData.climbable.values.some(value => typeof value !== 'string' || !value.startsWith('minecraft:'))) throw new Error('Invalid reviewed vanilla climbable block tag')
  // LivingEntity.onClimbable uses BlockTags.CLIMBABLE. Upstream only knows the
  // two old ids; retain its clamps/acceleration and use the exact vanilla tag.
  const taggedSource = source.replace('  const vineId = blocksByName.vine.id', `  const vineId = blocksByName.vine.id
  const ndClimbableIds = new Set(mcData.version.minecraftVersion === '1.21.11'
    ? ndClimbableNames.map(name => blocksByName[name]?.id).filter(id => id !== undefined) : [])`)
    .replace('block.type === ladderId || block.type === vineId', 'block.type === ladderId || block.type === vineId || ndClimbableIds.has(block.type)')
  if (taggedSource === source || !taggedSource.includes('ndClimbableIds.has(block.type)')) throw new Error('Cannot apply reviewed climbable tag to native physics')
  // PowderSnowBlock.entityInside (javap 1.21.11): a living entity whose feet cell
  // (getInBlockState) is powder snow, without leather boots, is stuck like in a web
  // with multiplier (0.9f, 1.5, 0.9f); Entity.move then zeroes its velocity.
  const powderSource = taggedSource
    .replace('  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id', `  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id
  const ndPowderSnowId = blocksByName.powder_snow ? blocksByName.powder_snow.id : -1`)
    .replace(`            if (block.type === webId) {
              entity.isInWeb = true
            } else if (block.type === bubblecolumnId) {`, `            if (block.type === webId) {
              entity.isInWeb = true
            } else if (block.type === ndPowderSnowId && !entity.ndLeatherBoots && cursor.x === Math.floor(pos.x) && cursor.y === Math.floor(pos.y) && cursor.z === Math.floor(pos.z)) {
              entity.ndInPowderSnow = true
            } else if (block.type === bubblecolumnId) {`)
    .replace(`      entity.isInWeb = false
    }`, `      entity.isInWeb = false
    } else if (entity.ndInPowderSnow) {
      dx *= 0.8999999761581421
      dy *= 1.5
      dz *= 0.8999999761581421
      vel.x = 0
      vel.y = 0
      vel.z = 0
      entity.ndInPowderSnow = false
    }`)
    .replace('    this.isInWeb = bot.entity.isInWeb\n', `    this.isInWeb = bot.entity.isInWeb
    this.ndInPowderSnow = !!bot.entity.ndInPowderSnow
    this.ndLeatherBoots = bot.inventory?.slots?.[8]?.name === 'leather_boots'
`)
    .replace('    bot.entity.isInWeb = this.isInWeb\n', `    bot.entity.isInWeb = this.isInWeb
    bot.entity.ndInPowderSnow = this.ndInPowderSnow
`)
  if ((powderSource.match(/ndInPowderSnow/g) || []).length !== 7 || !powderSource.includes('const ndPowderSnowId')) throw new Error('Cannot apply reviewed powder snow movement to native physics')
  // Avatar 1.21.11: swimming is .6 high, crouching 1.5; Player.updatePlayerPose retains it
  // while the standing body cannot fit. Keep the dimension on each state, never
  // mutate a Physics instance shared by live integration and independent forecasts.
  const poseSource = powderSource
    .replace('function getPlayerBB (pos) {', 'function getPlayerBB (pos, entity) {')
    .replace('w, physics.playerHeight, w)', 'w, entity?.ndPoseHeight ?? physics.playerHeight, w)')
    .replaceAll('getPlayerBB(pos).', 'getPlayerBB(pos, entity).')
    .replace('let playerBB = getPlayerBB(pos)', 'let playerBB = getPlayerBB(pos, entity)')
    .replace('function doesNotCollide (world, pos) {', 'function doesNotCollide (world, pos, entity) {')
    .replace('const pBB = getPlayerBB(pos)', 'const pBB = getPlayerBB(pos, entity)')
    .replace('doesNotCollide(world, pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z))', 'doesNotCollide(world, pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z), entity)')
    .replace('physics.simulatePlayer = (entity, world) => {', `physics.simulatePlayer = (entity, world) => {
    if (mcData.version.minecraftVersion === '1.21.11' && !entity.elytraFlying) {
      const fits = height => {
        const box = getPlayerBB(entity.pos, { ndPoseHeight: height }).contract(1e-7, 1e-7, 1e-7)
        return !getSurroundingBBs(world, box).some(block => box.intersects(block))
      }
      // Entity.updateSwimming / Player.updatePlayerPose run on the client too.
      if (ndWaterBudget) {
        const eyeY = entity.pos.y + (entity.ndPoseHeight === .6 ? .4 : entity.ndPoseHeight === 1.5 ? 1.27 : 1.62)
        const eye = world.getBlock(entity.pos.offset(0, eyeY - entity.pos.y, 0)), depth = getRenderedDepth(eye)
        const height = depth >= 0 && getRenderedDepth(world.getBlock(eye.position.offset(0, 1, 0))) >= 0 ? 1 : 1 - (depth + 1) / 9
        const underWater = depth >= 0 && eyeY < eye.position.y + height
        entity.ndSwimming = entity.control.sprint && (entity.ndSwimming ? entity.isInWater : underWater && getRenderedDepth(world.getBlock(entity.pos)) >= 0)
      }
      const swim = ndWaterBudget && fits(.6) && (entity.ndSwimming || !fits(1.5))
      entity.ndPoseHeight = swim ? .6 : fits(1.5) && (entity.control.sneak || !fits(physics.playerHeight)) ? 1.5 : physics.playerHeight
    } else entity.ndPoseHeight = physics.playerHeight`)
    .replace('    this.isInWeb = bot.entity.isInWeb\n', `    this.isInWeb = bot.entity.isInWeb
    this.ndPoseHeight = bot.entity._ndPoseHeight ?? (ndWaterBudget && bot.entity.metadata?.[6] === 3 ? .6 : bot.entity.metadata?.[6] === 5 ? 1.5 : bot.physics?.playerHeight ?? 1.8)
    this.ndSwimming = bot.entity._ndSwimming ?? bot.entity.metadata?.[6] === 3
`)
    .replace('    bot.entity.isInWeb = this.isInWeb\n', `    bot.entity.isInWeb = this.isInWeb
    bot.entity._ndPoseHeight = this.ndPoseHeight
    bot.entity._ndSwimming = this.ndSwimming
`)
  if (!poseSource.includes('entity?.ndPoseHeight ?? physics.playerHeight') || (poseSource.match(/ndPoseHeight/g) || []).length !== 10) throw new Error('Cannot apply reviewed native crouching dimensions')
  // The old .401 vertical contraction inverts a .6 swimming box. Fluid checks use its actual height.
  const swimSource = poseSource.replace('contract(0.001, 0.401, 0.001)', 'contract(0.001, entity.ndPoseHeight === .6 ? .001 : .401, 0.001)')
    // FlowingFluid.getFlow reads FluidState.FALLING, not a waterlogged block's orientation bits.
    .replace('if (block.metadata >= 8) {', 'if (block.metadata >= 8 && (!ndWaterBudget || waterIds.includes(block.type))) {')
    // Player.travel steers vertical swimming velocity toward the look vector.
    .replace('    moveEntityWithHeading(entity, world, strafe, forward)', `    if (ndWaterBudget && entity.ndSwimming && entity.isInWater && !entity.elytraFlying) {
      const dy = Math.sin(entity.pitch || 0)
      if (dy <= 0 || entity.control.jump || getRenderedDepth(world.getBlock(pos.offset(0, .9, 0))) >= 0) vel.y += (dy - vel.y) * (dy < -.2 ? .085 : .06)
    }
    moveEntityWithHeading(entity, world, strafe, forward)`)
  if (!swimSource.includes('entity.ndPoseHeight === .6 ? .001 : .401') || !swimSource.includes('!ndWaterBudget || waterIds.includes(block.type)') || !swimSource.includes('const dy = Math.sin(entity.pitch || 0)')) throw new Error('Cannot apply reviewed swimming fluid bounds/flow/travel')
  // LivingEntity.jumpFromGround (1.21.11): retain a larger existing upward impulse.
  // Compare after Jump Boost, as getJumpPower includes the effect before Math.max.
  const jumpSource = swimSource
    .replace('        vel.y = Math.fround(0.42)', '        const ndBeforeJumpY = vel.y\n        vel.y = Math.fround(0.42)')
    .replace('        if (entity.control.sprint) {\n          const yaw = Math.PI - entity.yaw', `        if (mcData.version.minecraftVersion === '1.21.11') vel.y = Math.max(vel.y, ndBeforeJumpY)
        if (entity.control.sprint) {
          const yaw = Math.PI - entity.yaw`)
  if ((jumpSource.match(/ndBeforeJumpY/g) || []).length !== 2) throw new Error('Cannot apply reviewed native ground jump impulse')
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
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'ndClimbableNames', 'ndWaterBudget',
    `${jumpSource}\n//# sourceURL=${filename.replace(/\\/g, '/')}`)(scopedRequire, localModule, localModule.exports, filename, path.dirname(filename), climbableData.climbable.values.map(value => value.slice('minecraft:'.length)), process.env.ND_WATER_ESCAPE_BUDGET !== '0')
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
  const wall = clock.wall || (require('./game-clock') as typeof import('./game-clock')).wall
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
    // Блоки для физики тела — из кеша тела (fastblocks.ts, S9), когда он поднят: тот же Block, что bot.blockAt(pos, false)
    // (координаты — floor), без постройки Block на каждую клетку рамки каждый тик. Физика блоки не правит.
    const worldSource = '  const world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }'
    if (source.includes(worldSource)) {
      source = source.replace(worldSource, '  const world = { getBlock: (pos) => { const fb = bot._ndFastBlocks; return fb && fb.live ? fb.block(pos.x, pos.y, pos.z) : bot.blockAt(pos, false) } }')
    }
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
  if (name === 'digging') {
    // Rounded digTime gives conservative per-tick progress when landing, water or effects change mid-dig.
    source = source.replace('    waitTimeout = setTimeout(finishDigging, waitTime)', `    let progress = 0, creditedAt = Date.now(), previousDigTime = bot.digTime(block)
    let diggingItem = bot.heldItem
    const advanceDigging = () => {
      const item = bot.heldItem
      if (diggingItem !== item && (diggingItem?.type !== item?.type || diggingItem?.metadata !== item?.metadata ||
        !require('node:util').isDeepStrictEqual([diggingItem?.nbt, diggingItem?.components, diggingItem?.removedComponents], [item?.nbt, item?.components, item?.removedComponents]))) {
        if (process.env.ND_DIG_TRACE === '1') console.log('[dig-abort-item]', JSON.stringify({ from: diggingItem && [diggingItem.name, diggingItem.count, diggingItem.slot, diggingItem.components, diggingItem.nbt], to: item && [item.name, item.count, item.slot, item.components, item.nbt] }))
        // ND_DIG_RESTART=1 (ow 27.10): тот же предмет с новыми компонентами (урон кирки за прошлый блок пришёл, когда копка
        // следующего уже началась) или подобранный в пустую руку — ваниль (MultiPlayerGameMode.continueDestroyBlock: не
        // sameDestroyTarget → startDestroyBlock) начинает этот блок заново, а не бросает копку: прогресс 0, START снова.
        // Обрыв копки рвал каждый второй блок штрека/лестницы/колодца («Digging aborted»). Другой предмет в руке — обрыв, как был.
        if (process.env.ND_DIG_RESTART === '1' && (!diggingItem || diggingItem.type === item?.type)) {
          diggingItem = item; progress = 0; creditedAt = Date.now(); previousDigTime = bot.digTime(block)
          bot._client.write('block_dig', { status: 0, location: block.position, face: bot.targetDigFace })
          waitTimeout = setTimeout(advanceDigging, 50)
          return
        }
        bot.stopDigging()
        return
      }
      const now = Date.now(), digTime = bot.digTime(block), ticks = Math.floor((now - creditedAt) / 50)
      const delta = Math.fround(50 / Math.max(previousDigTime, digTime))
      for (let tick = 0; tick < ticks && delta > 0 && progress < 1; tick++) progress = Math.fround(progress + delta)
      creditedAt += ticks * 50
      previousDigTime = digTime
      if (progress >= 1) finishDigging()
      else waitTimeout = setTimeout(advanceDigging, 50)
    }
    waitTimeout = setTimeout(waitTime <= 0 ? finishDigging : advanceDigging, Math.min(50, waitTime))`)
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
  if (name === 'pathfinderPhysics') {
    // Симуляция бега pathfinder'а (canStraightLine/canSprintJump каждый тик хода) — блоки из кеша тела (fastblocks.ts, S9), как у
    // физики тела выше; без кеша — прежний bot.blockAt(pos, false).
    const worldSource = '    this.world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }'
    if (source.includes(worldSource)) source = source.replace(worldSource, '    this.world = { getBlock: (pos) => { const fb = bot._ndFastBlocks; return fb && fb.live ? fb.block(pos.x, pos.y, pos.z) : bot.blockAt(pos, false) } }')
    // Slow water/partial-block landings can still be airborne after the native dry jump horizon.
    source = source.replaceAll(/    const state = this.simulateUntil\(reached, this.getController\(path\[0\], true, (true|false), jumpAfter\), 20\)/g,
      '    let state = this.simulateUntil(reached, this.getController(path[0], true, $1, jumpAfter), 20)\n    if (!reached(state) && !state.isInLava && (state.isInWater || !state.onGround)) state = this.simulateUntil(reached, this.getController(path[0], true, $1), 180, state)')
  }
  // Native steering ignores this promise; cancellation at disconnect must not crash the daemon.
  // moveToEdge can leave back pressed when blockUpdate resets placement. Only
  // the ordinary walking branch owns the next steering command.
  if (name === 'pathfinder') source = source.replace('bot.look(Math.atan2(-dx, -dz), 0)',
    "bot.setControlState('back', false)\n    bot.look(Math.atan2(-dx, -dz), 0).catch(error => { if (error.code !== 'DISCONNECTED' && error.code !== 'REFLEX_CANCELLED') throw error })")
  // Reuse the executor's scoped Physics instance when a terminal A* result
  // replaces a held prefix. No second simulator or different jump horizon.
  if (name === 'pathfinder') source = source.replace('bot.pathfinder.isMoving = () => path.length > 0',
    `bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.canMove = path => path.length > 0 && (bot.entity.isInWater ||
    (stateMovements.allowSprinting && (physics.canStraightLine(path, true) || physics.canSprintJump(path))) ||
    physics.canStraightLine(path) || physics.canWalkJump(path))`)
  if (name === 'pathfinder') {
    // Native consumes toPlace before its server receipt. Preserve that Move's
    // planned support until completion; only its exact successful placement
    // belongs to the current path. Other world changes still invalidate A*.
    source = source.replace('  let placingBlock = null', '  let placingBlock = null\n  let ndPlacement = null')
      .replace('    placing = false\n    pathUpdated = false', '    placing = false\n    ndPlacement = null\n    pathUpdated = false')
      .replace('      const curPoint = path[i]', '      const curPoint = path[i]\n      if (ndPlacement?.node === curPoint) break')
      .replace('        placingBlock = nextPoint.toPlace.shift()\n        fullStop()',
        '        placingBlock = nextPoint.toPlace.shift()\n        ndPlacement = placingBlock?.useOne ? null : { node: nextPoint, receipt: null }\n        fullStop()')
      .replace('            bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))',
        `            const ndThisPlacement = ndPlacement
            if (ndThisPlacement?.node === nextPoint) ndThisPlacement.receipt = {
              pos: refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz), type: bot.registry.blocksByName[block.name]?.id
            }
            bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))`)
      .replace('                placing = false\n                lastNodeTime', '                placing = false\n                if (ndPlacement === ndThisPlacement) ndPlacement = null\n                lastNodeTime')
      .replace("      resetPath('block_updated', false)", `      if (ndPlacement?.node === path[0] && ndPlacement?.receipt && oldBlock.position.equals(ndPlacement.receipt.pos) && newBlock.type === ndPlacement.receipt.type) {
        ndPlacement.receipt = null
        return
      }
      resetPath('block_updated', false)`)
  }
  source = source.replaceAll('bot._client.write(', 'writePacket(')
  const nativeRequire = createRequire(filename)
  const scopedRequire = request => {
    if (request === 'prismarine-physics') return getPhysics()
    if (name === 'pathfinder' && request === './lib/physics') return compilePlugin(sources.pathfinderPhysics, scope, 'pathfinderPhysics', sources)
    if (name === 'pathfinder' && request === './lib/goto') {
      const nativeGoto = nativeRequire(request)
      return (bot, goal) => {
        const movement: typeof import('./movement') = require('./movement')
        return movement.gotoWaitOn() ? movement.gotoGoal(bot, goal) : nativeGoto(bot, goal)
      }
    }
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
  // Модули — один раз, не require() на каждый пакет движения (S9: 2 % CPU демона в профиле lockstep).
  let dropsMod, elytraMod
  const drops = () => dropsMod || (dropsMod = (require('./drops') as typeof import('./drops')))
  const elytra = () => elytraMod || (elytraMod = (require('./elytra') as typeof import('./elytra')))
  const nativeVelocity = (packet, meta, bytes) => {
    if (bot.version !== '1.21.11' || !packet || packet.entityId === bot.entity?.id ||
      (meta?.name !== 'spawn_entity' && meta?.name !== 'entity_velocity')) return
    const velocity = drops().velocityFromRaw(bytes, meta.name === 'spawn_entity' ? 'spawn' : 'velocity')
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
      elytra().gliding(entity) || entity._ndGlideObservedState)) return
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
      yaw: entity.yaw, pitch: entity.pitch, flying: elytra().gliding(entity), boosted: !!entity._ndGlideBoosted,
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
function defaultPlugins () { return defaults || (defaults = createTickPlugins((require('./game-clock') as typeof import('./game-clock')))) }
module.exports = { createTickPlugins, getPhysics }
export { createTickPlugins, getPhysics }
Object.defineProperties(module.exports, {
  plugins: { enumerable: true, get: () => defaultPlugins().plugins },
  pathfinder: { enumerable: true, get: () => defaultPlugins().pathfinder }
})
export declare const plugins: any, pathfinder: any
