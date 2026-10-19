'use strict'
// Плагины тика: pathfinder — прогноз прыжка, частичный A* и обход, отказ от выдумки шага, отмена на отключении, бюджет застревания, терминальный A*.
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { repoJson } from '../src/paths'
import { Block, testClock, block, install } from './tick-plugins-fixture'

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
