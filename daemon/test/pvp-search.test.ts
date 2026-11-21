import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { createLastSeen } from '../src/pvp/last-seen'
import { acquireTarget, observedCollision } from '../src/pvp/search'
import { targetTurn } from '../src/pvp/turn-target'

function scene (t) {
  const time = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(time)
  const goals = []
  const bot = {
    entity: { position: new Vec3(.5, 0, .5), yaw: 0, onGround: true }, health: 20,
    blockAt: p => ({ name: p.y < 0 ? 'stone' : 'air', position: p.floored(),
      boundingBox: p.y < 0 ? 'block' : 'empty', shapes: p.y < 0 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    canSeeBlock: () => true,
    pathfinder: { setGoal: goal => goals.push(goal) }, clearControlStates: () => {}
  }
  t.after(() => time.dispose())
  const ctl = { aborted: false, onAbort: [] }
  let visible = false
  // The search may ask the observer, but never read the hidden target itself.
  const raw = { get position () { throw new Error('hidden packet position') } }
  const seen = { position: new Vec3(3, 0, 0), _ndVisible: true }
  const vision = { observe: () => visible ? seen : null }
  const tick = async n => { time.advanceTicks(n); await new Promise(resolve => setImmediate(resolve)) }
  return { bot, ctl, raw, vision, seen, goals, time, tick, show: () => { visible = true } }
}

test('PvP searches visible ground when the target starts behind a wall, then stops on sight', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.ok(f.goals[0], 'a hidden start must cause a search step, not immediate lost')
  f.show(); await f.tick(2)
  const result = await running
  assert.strictEqual(result.entity, f.seen)
  assert.equal(f.goals.at(-1), null)
  assert.equal(result.search.legs, 1)
})

test('PvP acquisition does not start a route while airborne', async t => {
  const f = scene(t); f.bot.entity.onGround = false
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.equal(f.goals.length, 0)
  f.ctl.aborted = true; await f.tick(2)
  assert.equal((await running).entity, null)
})

test('PvP search respects cancellation and the original fight deadline', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
  await f.tick(4)
  const result = await running
  assert.equal(result.entity, null)
  assert.equal(result.search.seconds, .2)
  assert.equal(f.goals.at(-1), null)
})

for (const hidden of [true, false]) test(`PvP search rejects ${hidden ? 'unseen support' : 'points outside the agreed arena'}`, async t => {
  const f = scene(t); f.bot.canSeeBlock = () => !hidden
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw,
    { deadline: 1200, arena: { x: .5, y: 0, z: .5, r: hidden ? 24 : 2 } })
  assert.equal(f.goals.length, 0)
  await f.tick(4); await running
  assert.ok(f.goals.every(g => g === null))
})

test('PvP immediate visibility leaves path controls alone', async t => {
  const f = scene(t); f.show()
  const result = await acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  assert.strictEqual(result.entity, f.seen)
  assert.equal(f.goals.length, 0)
  assert.equal(result.search.legs, 0)
})

test('a scout can step onto one visible adjacent block to look around a corner', async t => {
  const f = scene(t), open = f.bot.blockAt
  f.bot.blockAt = p => p.y < 0 && !(p.z === 0 && (p.x === 0 || p.x === 1))
    ? { name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] } : open(p)
  const run = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 2500 })
  const first = f.goals[0]
  assert.ok(first, 'the only visible foothold is one block away')
  assert.equal(first.isEnd(f.bot.entity.position.floored()), false, 'the first step must actually leave cover')
  assert.equal(first.isEnd(new Vec3(1, 0, 0)), true)
  await f.tick(2)
  assert.equal(f.goals.length, 1, 'waiting for movement retains the same route')
  f.bot.entity.position.x += 1
  f.show(); await f.tick(2)
  assert.strictEqual((await run).entity, f.seen)
})

test('a stationary scout does not raycast the same void every two ticks and reacts when a floor appears', async t => {
  const f = scene(t), bot: any = Object.assign(new EventEmitter(), f.bot)
  const open = bot.blockAt
  let floor = false, reads = 0, observations = 0
  bot.blockAt = p => {
    reads++
    if (p.y >= 0 || (p.z === 0 && (p.x === 0 || floor && p.x === 1))) return open(p)
    return { name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] }
  }
  const run = acquireTarget(bot, f.ctl, { observe: () => { observations++; return f.vision.observe() } }, f.raw, { deadline: 3500 })
  const firstScan = reads
  assert.ok(firstScan > 0)
  for (let i = 0; i < 8; i++) await f.tick(2)
  assert.equal(reads, firstScan)
  assert.ok(observations >= 9, 'checks for a visible player continue')
  floor = true
  const p = new Vec3(1, -1, 0)
  bot.emit('blockUpdate', null, open(p))
  await f.tick(2)
  assert.ok(f.goals.some(Boolean))
  f.show(); await f.tick(2); await run
  assert.equal(bot.listenerCount('blockUpdate'), 0)
  assert.equal(bot.listenerCount('chunkColumnLoad'), 0)
})

for (const closed of [false, true]) test(`native scout retraces the blind branch and ${closed ? 'stops after exploring both ends' : 'sees the player around the other corner'}`, async t => {
  const { worldOf, drive } = require('./parkour-fixture')
  const { fakeBot } = require('../scenes/infra/try-astar-bench')
  const cells = [[3, 0, 4, 'stone']]
  const floor = closed ? 'stone_slab' : 'stone'
  for (let x = 0; x <= 3; x++) cells.push([x, 0, 0, floor])
  for (let z = 1; z <= 3; z++) cells.push([0, 0, z, floor])
  for (let y = 1; y <= 4; y++) {
    for (let x = 1; x <= 4; x++) cells.push([x, y, 1, 'bedrock'])
    cells.push([1, y, 2, 'bedrock'])
    if (closed) cells.push([1, y, 3, 'bedrock'], [1, y, 4, 'bedrock'])
  }
  const { bot: body, world } = worldOf(cells)
  const surface = closed ? .5 : 1
  body.entity.position.y = surface
  world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  const bot = fakeBot(world, { at: body.entity.position, kit: [] })
  Object.assign(bot.entity, body.entity)
  bot.physics = body.physics
  bot.pathfinder.movements.canDig = false
  drive(bot, world)
  const f = scene(t), enemy = { id: 8, username: 'Foe', isValid: true, type: 'player',
    position: new Vec3(3.5, 1, 4.5), width: .6, height: 1.8, equipment: [], metadata: [] }
  bot.players = { Foe: { entity: enemy } }; bot.entities = { 8: enemy }
  const vision = createLastSeen(bot)
  t.after(() => vision.close())
  assert.ok(!vision.observe(enemy)?._ndVisible)
  const goals = [], entered = []
  bot.on('goal_updated', goal => { if (goal) goals.push(goal) })
  const run = acquireTarget(bot, f.ctl, vision, enemy, { deadline: clock.now() + 6500 })
  assert.equal(goals[0]?.x, 3)
  assert.equal(goals[0].y, 1, 'A* targets the node above either support')
  assert.equal(goals[0].isEnd(new Vec3(2, 1, 0)), false)
  for (let i = 0; i < 132; i++) {
    await bot.waitForTicks(1); await f.tick(1)
    const cell = bot.entity.position.floored().toString()
    if (cell !== entered.at(-1)) entered.push(cell)
  }
  const result = await run
  const y = Math.floor(surface)
  const eastFirst = entered[1] === new Vec3(1, y, 0).toString()
  const position = (out, side) => new Vec3(eastFirst ? out : side, y, eastFirst ? side : out).toString()
  const secondBranch = closed ? [1, 2, 3, 2, 1, 0] : [1, 2, 3]
  assert.deepEqual(entered, [...[0, 1, 2, 3, 2, 1, 0].map(n => position(n, 0)), ...secondBranch.map(n => position(0, n))])
  assert.equal(result.entity?.username ?? null, closed ? null : 'Foe')
})

test('only an empty terminal result for the current search route makes the scout try another viewpoint', async t => {
  const f = scene(t), bot: any = Object.assign(new EventEmitter(), f.bot)
  bot.pathfinder.setGoal = goal => { f.goals.push(goal); bot.pathfinder.goal = goal }
  const run = acquireTarget(bot, f.ctl, f.vision, f.raw, { deadline: 5000 })
  const first = bot.pathfinder.goal
  bot.emit('path_update', { status: 'partial', path: [] })
  bot.emit('path_update', { status: 'timeout', path: [{ x: 1, y: 0, z: 1 }] })
  await f.tick(2)
  assert.equal(bot.pathfinder.goal, first)
  bot.emit('path_update', { status: 'noPath', path: [] })
  await f.tick(2)
  const second = bot.pathfinder.goal
  assert.notDeepEqual(second, first)
  assert.equal(f.goals.filter(Boolean).length, 2)
  f.show(); await f.tick(2); await run
  assert.equal(bot.listenerCount('path_update'), 0)
})

test('crossing the edge of a viewpoint waits for native arrival, and an emergency route keeps its controls', async t => {
  const f = scene(t), bot: any = Object.assign(new EventEmitter(), f.bot)
  let clears = 0
  bot.clearControlStates = () => { clears++ }
  bot.pathfinder.setGoal = goal => { f.goals.push(goal); bot.pathfinder.goal = goal; bot.emit('goal_updated', goal) }
  const run = acquireTarget(bot, f.ctl, f.vision, f.raw, { deadline: 3000 })
  const first = bot.pathfinder.goal
  bot.entity.position.set(first.x + .02, first.y, first.z + .02)
  await f.tick(2)
  assert.equal(bot.pathfinder.goal, first, 'native movement is still approaching the viewpoint')
  bot.emit('goal_reached', first); bot.pathfinder.goal = null
  await f.tick(2)
  assert.ok(bot.pathfinder.goal && bot.pathfinder.goal !== first)
  const emergency = { escape: true }, before = clears
  bot.pathfinder.setGoal(emergency)
  await f.tick(2)
  assert.equal((await run).entity, null)
  assert.equal(bot.pathfinder.goal, emergency)
  assert.equal(clears, before)
  assert.equal(bot.listenerCount('goal_reached') + bot.listenerCount('goal_updated'), 0)
})

test('hidden block updates do not reopen an unreachable viewpoint and a visible change permits a retry', async t => {
  const f = scene(t), bot: any = Object.assign(new EventEmitter(), f.bot)
  const open = bot.blockAt, hidden = new Vec3(3, 0, 0), visible = new Vec3(-1, -1, 0)
  const stone = position => ({ position, name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
  bot.blockAt = p => {
    if (p.x === 2 || p.equals(hidden)) return stone(p)
    if (p.y >= 0 || (p.z === 0 && (p.x === 0 || p.x === -1))) return open(p)
    return { name: 'air', position: p, boundingBox: 'empty', shapes: [] }
  }
  bot.pathfinder.setGoal = goal => { f.goals.push(goal); bot.pathfinder.goal = goal }
  const run = acquireTarget(bot, f.ctl, f.vision, f.raw, { deadline: 3000 })
  const first = bot.pathfinder.goal
  assert.ok(first?.isEnd(new Vec3(-1, 0, 0)))
  bot.emit('path_update', { status: 'noPath', path: [] })
  await f.tick(2)
  assert.equal(bot.pathfinder.goal, null)
  bot.emit('blockUpdate', open(hidden), stone(hidden))
  await f.tick(2)
  assert.equal(bot.pathfinder.goal, null, 'a packet behind the wall grants no new route')
  bot.emit('blockUpdate', { ...stone(visible), name: 'dirt' }, stone(visible))
  await f.tick(2)
  assert.deepEqual(bot.pathfinder.goal, first)
  f.show(); await f.tick(2); await run
})

function lostPlayer(t) {
  const f = scene(t)
  const bot: any = Object.assign(new EventEmitter(), f.bot)
  const raw: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', username: 'Foe', isValid: true,
    position: new Vec3(6.5, 0, .5), height: 1.8, width: .6, equipment: [], metadata: [] })
  bot.players = { Foe: { entity: raw } }; bot.entities = { 2: raw }
  const open = bot.blockAt
  bot.blockAt = p => p.floored().x === 8 && p.y >= 0 ? { name: 'stone', position: p.floored(),
    boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : open(p)
  const source = createLastSeen(bot)
  const last = source.observe(raw)
  assert.equal(last?._ndVisible, true)
  raw.position = new Vec3(13.5, 0, .5)
  bot.emit('physicsTick')
  assert.equal(last._ndVisible, false)
  assert.equal(last.position.x, 6.5)
  t.after(() => source.close())
  return { ...f, bot, raw, last, source }
}

test('a solo duel searches toward its last public sighting when another observer still remembers the hidden player', async t => {
  const f = lostPlayer(t)
  const duel = require('../src/pvp').duel
  const running = duel({ bot: f.bot }, f.ctl, f.raw, { timeoutSeconds: .2, guard: { safety: {} } })
    .then(result => ({ result }), error => ({ error }))
  await f.tick(4)
  const out = await running
  assert.ok(f.goals[0]?.x > f.bot.entity.position.x + 2, 'search visible ground toward the last sighting')
  assert.ok(f.goals[0].x < 8, 'do not route to the hidden packet position behind the wall')
  assert.equal(out.result?.search.legs, 1, out.error?.message)
  assert.match(out.result.lost, /не найден/)
  assert.equal(f.goals.at(-1), null)
})

test('solo search keeps following a distant sighting until the scout can inspect it', async t => {
  async function nextLeg(edge: number | null, hiddenZ = 5, behindCorner: boolean | null = null) {
    const f = lostPlayer(t), { bot, raw, source } = f
    const last = new Vec3(-17.5, 0, .5)
    raw.position = last.clone()
    assert.equal(source.observe(raw)._ndVisible, true)
    const terrain = bot.blockAt
    bot.blockAt = p => {
      const { x, y, z } = p.floored()
      const wall = edge !== null && x === -11 && z >= edge && z < 2
      const corner = behindCorner !== null && x === -9 && z >= 1 && z <= 4
      const extension = behindCorner === true && x === -11 && z === 2
      return (wall || corner || extension) && y >= 0 && y < 4
        ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : terrain(p)
    }
    raw.position = new Vec3(15.5, 0, hiddenZ) // Behind the permanent eastern wall.
    assert.equal(source.observe(raw)._ndVisible, false)
    const running = acquireTarget(bot, f.ctl, source, raw, { deadline: 5000 })
    const first = f.goals[0]
    assert.ok(first.x < -4)
    bot.entity.position.set(first.x + .5, first.y, first.z + .5)
    if (behindCorner !== null) assert.equal(observedCollision(bot).blockAt(new Vec3(-11, 1, 2)), null)
    await f.tick(2)
    const second = f.goals.at(-1)
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel())
    assert.equal((await running).search.legs, 2)
    const next = new Vec3(second.x + .5, second.y, second.z + .5)
    if (edge !== null) assert.ok(next.distanceTo(last) < bot.entity.position.distanceTo(last), 'an intermediate stop still cannot see the old position')
    return { x: second.x, z: second.z }
  }
  const shortWall = await nextLeg(-1)
  assert.deepEqual(shortWall, await nextLeg(-1, -9), 'two unseen packet positions yield the same search')
  assert.notDeepEqual(shortWall, await nextLeg(null), 'seeing the empty position frees the next leg to explore')
  assert.ok((await nextLeg(-8)).z > 0, 'the observed opening gives a shorter way to look behind the wall')
  assert.deepEqual(await nextLeg(-8, 5, true), await nextLeg(-8, 5, false), 'an unseen opening and an unseen wall yield the same search')
})

function unloadedDuel(t) {
  const f = lostPlayer(t)
  f.raw.isValid = false; f.bot.emit('entityGone', f.raw)
  delete f.bot.entities[2]; f.bot.players.Foe.entity = null
  const ctx: any = { bot: f.bot, ctl: f.ctl, entity: f.last, deadline: 2000, prof: { player: true }, opts: {},
    vision: f.source, edgeTally() {}, kills: [], label: 'Foe', st: {}, clear() {}, pathTo() {}, otherAttacker: () => null,
    finish: result => result, retarget: e => { ctx.entity = e }, async holdWeapon() {} }
  return { ...f, ctx }
}

test('an active solo duel searches after entityGone and reacquires a reloaded player only when visible', async t => {
  const f = unloadedDuel(t), { ctx } = f
  let settled = false
  const running = targetTurn(ctx, {} as any).then(result => { settled = true; return result })
  const next = Object.assign(new EventEmitter(), { id: 3, type: 'player', username: 'Foe', isValid: true,
    position: new Vec3(17.5, 0, .5), height: 1.8, width: .6, metadata: [], equipment: [] })
  f.bot.players.Foe.entity = next; f.bot.entities[3] = next
  await f.tick(2)
  assert.equal(settled, false, 'packet-only entity reload does not finish the search')
  assert.ok(f.goals[0]?.x > 2)
  next.position = new Vec3(4.5, 0, .5)
  await f.tick(2)
  assert.equal(await running, 'next')
  assert.equal(ctx.entity.id, next.id)
  assert.equal(ctx.entity._ndVisible, true)
  assert.equal(ctx.st.search.legs, 1)
  assert.equal(f.goals.at(-1), null)
})

for (const cause of ['public death', 'left server', 'other attacker', 'abort']) test(`solo reacquisition yields to ${cause}`, async t => {
  const f = unloadedDuel(t), { ctx } = f
  let attacker = null
  ctx.otherAttacker = () => attacker
  const running = targetTurn(ctx, {} as any)
  assert.ok(f.goals[0])
  if (cause === 'public death') ctx.killed = true
  if (cause === 'left server') delete f.bot.players.Foe
  if (cause === 'other attacker') attacker = { e: { id: 7, username: 'Visible attacker' } }
  if (cause === 'abort') {
    f.ctl.aborted = true
    f.ctl.onAbort.forEach(cancel => cancel())
  } else await f.tick(2)
  const result: any = await running
  if (cause === 'left server') assert.match(result.end.lost, /пропал из виду/)
  else assert.equal(result, 'next')
  assert.equal(ctx.entity.id, cause === 'other attacker' ? 7 : 2)
  assert.equal(f.goals.at(-1), null)
  assert.equal(f.ctl.onAbort.length, 0)
})

test('PvP acquisition observes the same named player after an entity reload', async t => {
  const f = scene(t)
  const old = { username: 'Foe', isValid: false }
  const replacement = { username: 'Foe', get position () { throw new Error('hidden replacement position') } }
  ;(f.bot as any).players = { Foe: { entity: old } }
  ;(f.vision as any).observe = candidate => candidate === replacement ? f.seen : null
  let acquired
  const running = acquireTarget(f.bot, f.ctl, f.vision, old, { deadline: 10000 }).then(r => { acquired = r })
  ;(f.bot as any).players.Foe.entity = replacement
  await f.tick(2)
  assert.strictEqual(acquired?.entity, f.seen)
  await running
})

test('PvP search abort releases controls and timers even with a frozen native clock', async t => {
  const f = scene(t)
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 10000 })
  f.ctl.aborted = true
  for (const cancel of [...f.ctl.onAbort]) cancel()
  const result: any = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('abort waited for game time')), 100))])
  assert.equal(result.entity, null)
  assert.equal(f.goals.at(-1), null)
  assert.equal(f.time.timers.size, 0)
  assert.equal(f.ctl.onAbort.length, 0)
})

test('PvP acquisition protects intermediate arena nodes and floor, then restores movement settings', async t => {
  const f = scene(t)
  const neighbors = [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }]
  const mv = { canDig: true, allowParkour: true, maxDropDown: 9, allow1by1towers: true,
    scafoldingBlocks: [1], digCost: 1, exclusionAreasBreak: [], getNeighbors: () => neighbors }
  const original = { ...mv }
  ;(f.bot.pathfinder as any).movements = mv
  const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw,
    { deadline: 10000, arena: { x: .5, y: 0, z: .5, r: 12 } })
  assert.deepEqual(mv.getNeighbors(), [neighbors[0]])
  assert.equal(mv.exclusionAreasBreak.at(-1)({ position: new Vec3(0, -1, 0) }), 100)
  assert.equal(mv.allow1by1towers, false)
  assert.equal(mv.allowParkour, false)
  f.show(); await f.tick(2); await running
  assert.deepEqual(mv, original)
})

test('PvP route can leave a shallow crater along its current floor without digging the arena floor', () => {
  const { combatMovement }: typeof import('../src/pvp/movement') = require('../src/pvp/movement')
  const neighbors = [{ x: 589, y: 119, z: 594 }, { x: 590, y: 120, z: 593 }, { x: 589, y: 118, z: 594 }]
  const mv = { getNeighbors: () => neighbors, exclusionAreasBreak: [] }
  const bot = { entity: { position: new Vec3(589.7, 119, 593.3) }, pathfinder: { movements: mv } }
  const route = combatMovement(bot, { x: 600, y: 120, z: 600, r: 24 })
  try {
    assert.deepEqual(mv.getNeighbors(), neighbors.slice(0, 2))
    assert.equal(mv.exclusionAreasBreak[0]({ position: new Vec3(589, 118, 593) }), 100)
    bot.entity.position.y = 120
    assert.deepEqual(mv.getNeighbors(), [neighbors[1]], 'standing on the field retains its original floor limit')
  } finally { route.restore() }
})

test('PvP acquisition and route costs cannot inspect a hidden ceiling above visible ground', async t => {
  const results = []
  for (const roof of [false, true]) {
    const f = scene(t)
    const open = f.bot.blockAt
    const hidden = new Vec3(0, 1, -6)
    f.bot.blockAt = p => {
      const c = p.floored()
      if (c.equals(new Vec3(0, 1, -3)) || roof && c.equals(hidden)) return { name: 'obsidian', position: c, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return open(p)
    }
    assert.equal((require('../src/pick') as typeof import('../src/pick')).blockSeen(f.bot, hidden), false)
    const mv = { bot: f.bot, getBlock(pos, dx, dy, dz) { return pos ? this.bot.blockAt(pos.offset(dx, dy, dz)) : null },
      allowEntityDetection: true, exclusionAreasBreak: [] }
    const getBlock = mv.getBlock
    ;(f.bot.pathfinder as any).movements = mv
    const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    results.push({ goal: f.goals[0] && [f.goals[0].x, f.goals[0].y, f.goals[0].z], ceiling: mv.getBlock(hidden, 0, 0, 0)?.name || null })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, getBlock)
    assert.equal(mv.allowEntityDetection, true)
  }
  assert.deepEqual(results[0], results[1], 'an unseen roof must not alter the viewpoint or path geometry')
  assert.ok(results[0].goal, 'still searches the visible alternative')
  assert.equal(results[0].ceiling, null)
})

test('an existing burn cost uses only visible lava during acquisition and restores its ordinary cost', async t => {
  const { priceBurnSteps } = require('../src/pvp/movement')
  for (const covered of [true, false]) {
    const f = scene(t), open = f.bot.blockAt
    const lava = new Vec3(2, -1, 0), cover = lava.offset(0, 1, 0)
    f.bot.blockAt = p => {
      if (p.equals(lava)) return { name: 'lava', position: p, boundingBox: 'empty', shapes: [] }
      if (covered && p.equals(cover)) return { name: 'stone', position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return open(p)
    }
    const mv: any = { getBlock(pos, x, y, z) { return this.bot.blockAt(pos.offset(x,y,z)) }, bot: f.bot,
      exclusionAreasStep: [], exclusionAreasBreak: [], getNeighbors: () => [] }
    ;(f.bot.pathfinder as any).movements = mv
    ;(f.bot as any)._ndFastBlocks = { live: true, ver: 1 }
    const strip = priceBurnSteps(f.bot, mv) // ordinary arena navigation installs the price before a duel
    const next = open(new Vec3(1, 0, 0)), cost = () => mv.exclusionAreasStep.reduce((sum, price) => sum + price(next), 0)
    assert.equal(cost(), 30)
    const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 3000 })
    const during = cost()
    f.show(); await f.tick(2); await running
    assert.equal(during, covered ? 0 : 30)
    assert.equal(cost(), 30)
    strip()
  }
})

test('PvP acquisition hides cached packet geometry from fastblocks route candidates and restores the cache', async t => {
  const { Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const Move = require('mineflayer-pathfinder/lib/move')
  const bench: typeof import('../scenes/infra/try-astar-bench') = require('../scenes/infra/try-astar-bench')
  const fastblocks: typeof import('../src/fastblocks') = require('../src/fastblocks')
  const before = process.env.ND_S9
  process.env.ND_S9 = '1'
  t.after(() => { if (before === undefined) delete process.env.ND_S9; else process.env.ND_S9 = before })
  const observations = []
  const packetGeometry = []
  for (const roof of [false, true]) {
    const f = scene(t)
    const hidden = new Vec3(0, 1, -6)
    const world = bench.syntheticWorld((x, y, z) => y < 0 ? 'stone'
      : x === 0 && y === 1 && (z === -3 || roof && z === -6) ? 'obsidian' : null, -1, 0, -1, 3)
    const native = bench.fakeBot(world, { at: f.bot.entity.position, kit: ['diamond_pickaxe'] })
    const bot = Object.assign(native, { canSeeBlock: f.bot.canSeeBlock })
    bot.entity.yaw = 0
    bot.pathfinder.setGoal = goal => f.goals.push(goal)
    const mv: any = new Movements(bot)
    bot.pathfinder.setMovements(mv)
    fastblocks.wrapMovements(bot, mv)
    const cachedGetBlock = mv.getBlock
    const cache = mv._ndFast
    assert(cache, 'exercise the real fastblocks wrapper')
    assert.notEqual(cachedGetBlock, Movements.prototype.getBlock)
    assert.equal((require('../src/pick') as typeof import('../src/pick')).blockSeen(bot, hidden), false)
    // Seed the real block cache before acquisition: observed reads must not reuse this hidden value.
    assert.equal(mv.getBlock(hidden, 0, 0, 0).name, roof ? 'obsidian' : 'air')
    const candidates = () => mv.getNeighbors(new Move(0, 0, -5, 0, 0)).map(m => ({
      pos: [m.x, m.y, m.z], cost: m.cost, dig: m.toBreak.map(p => [p.x, p.y, p.z])
    }))
    const beforeCandidates = candidates()
    packetGeometry.push(beforeCandidates)
    const running = acquireTarget(bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    observations.push({ goal: f.goals[0] && [f.goals[0].x, f.goals[0].y, f.goals[0].z],
      ceiling: mv.getBlock(hidden, 0, 0, 0).name ?? null, candidates: candidates() })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, cachedGetBlock)
    assert.equal(mv._ndFast, cache)
    assert.equal(mv.allowEntityDetection, true)
    assert.deepEqual(candidates(), beforeCandidates, 'ordinary movement retains its prior candidates and costs')
    const hits = cache.stats.hits
    mv.getBlock(hidden, 0, 0, 0)
    assert(cache.stats.hits > hits, 'normal movement resumes the same cache')
  }
  assert.notDeepEqual(packetGeometry[0], packetGeometry[1], 'the hidden roof really changes the unfiltered route')
  assert.deepEqual(observations[0], observations[1], 'unknown packet geometry must not change acquisition candidates or costs')
  assert.ok(observations[0].goal, 'visible alternative remains available')
  assert.equal(observations[0].ceiling, null)
})

test('PvP LOS and acquisition cannot see packet cells beyond an unknown plane', async t => {
  const { observedCollision }: typeof import('../src/pvp/search') = require('../src/pvp/search')
  const results = []
  for (const stone of [false, true]) {
    const f = scene(t)
    const open = f.bot.blockAt
    const hidden = new Vec3(3, 1, 0)
    f.bot.blockAt = p => {
      const c = p.floored()
      if (c.x === 1) return null // Missing world/chunk data is not visible air.
      if (stone && c.equals(hidden)) return { name: 'stone', position: c, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return open(p)
    }
    const view = observedCollision(f.bot)
    assert.equal(view.blockAt(new Vec3(0, 1, 0))?.name, 'air', 'known cell before the gap stays visible')
    const mv = { bot: f.bot, getBlock(pos, dx, dy, dz) { return this.bot.blockAt(pos.offset(dx, dy, dz)) },
      allowEntityDetection: true, exclusionAreasBreak: [] }
    const getBlock = mv.getBlock
    ;(f.bot.pathfinder as any).movements = mv
    const running = acquireTarget(f.bot, f.ctl, f.vision, f.raw, { deadline: 1200 })
    results.push({ los: view.blockAt(hidden)?.name ?? null, route: mv.getBlock(hidden, 0, 0, 0)?.name ?? null })
    f.ctl.aborted = true; f.ctl.onAbort.forEach(cancel => cancel()); await running
    assert.equal(mv.getBlock, getBlock)
  }
  assert.deepEqual(results, [{ los: null, route: null }, { los: null, route: null }])
})
