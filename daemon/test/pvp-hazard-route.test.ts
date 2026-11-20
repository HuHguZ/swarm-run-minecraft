import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Movements, goals } from 'mineflayer-pathfinder'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')
import { tuneMovements } from '../src/worlds'
import { createTerrain } from '../src/pvp/terrain'
import { hopTurn, repositionTurn } from '../src/pvp/turn-reach'
import { bodyClear, dimensions } from '../src/navigation/geometry'
import { drive, native, worldOf } from './parkour-fixture'
import { planJump, executePlan, IDLE } from '../src/navigation/parkour'
import { burnStepCost, combatMovement, priceBurnSteps } from '../src/pvp/movement'

const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(data as any)

test('captured fire cell keeps a native escape despite overlapping soft hazard prices', () => {
  // Native match L, 13.11: exact 5x5x5 states around (554,136,559), x/y/z order.
  const states = [
    13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,0,0,13279,13279,13279,0,0,13279,13279,13279,0,0,13279,13279,13279,
    13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,0,0,0,13279,13279,0,0,0,13279,13279,0,0,13279,13279,13279,
    13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,0,0,3205,0,0,0,0,0,0,0,0,13279,13279,13279,13279,
    13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,0,0,13279,13279,13279,0,0,13279,13279,13279,13279,20774,
    13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,13279,0,13279,13279,13279,13279,0,13279,13279,13279,13279,11122
  ]
  const bot: any = { registry: data, game: { minY: -64, dimension: 'overworld' },
    entity: { position: new Vec3(554.517506816051,136,559.688381102842), effects: {} },
    inventory: { items: () => [] }, pathfinder: { bestHarvestTool: () => null } }
  bot.blockAt = at => {
    const p = at.floored(), x = p.x - 552, y = p.y - 134, z = p.z - 557
    if ([x,y,z].some(v => v < 0 || v > 4)) return null
    const b = Block.fromStateId(states[x * 25 + y * 5 + z], 0); b.position = p; return b
  }
  const mv = bot.pathfinder.movements = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false
  const start = new Move(554,136,559,0,0)
  assert.equal(mv.getNeighbors(start).length, 5, 'the captured geometry has five ordinary exits')
  tuneMovements(bot,mv)
  const rawBurn = burnStepCost(bot)
  assert.equal(rawBurn(bot.blockAt(new Vec3(554,136,559))), 100)
  assert.equal(rawBurn(bot.blockAt(new Vec3(553,136,559))), 30)
  const stopBurn = priceBurnSteps(bot,mv), pricedNeighbors = mv.getNeighbors
  const scope = combatMovement(bot)
  try {
    assert.equal(mv.getNeighbors,pricedNeighbors,'combat reuses the burn price already installed for goto')
    const r = new AStar(start,mv,new goals.GoalBlock(553,136,559),5000).compute()
    assert.equal(r.status,'success', 'soft burn/contact prices must not strand the body in fire')
    assert.ok(mv.getNeighbors(new Move(553,136,559,0,0)).every(n => !n.toBreak.length && bot.blockAt(n)?.name !== 'fire'))
    assert.equal(rawBurn(bot.blockAt(new Vec3(554,136,559))),100,'direct burn remains forbidden')
    const heat = mv.exclusionStep(mv.getBlock(new Move(553,136,559,0,0),0,0,0))
    assert.ok(heat > 0 && Number.isFinite(heat),'worsening heat retains its finite price outside the expansion context')
    const read = bot.blockAt
    for (const name of ['fire','lava']) for (const y of [136,137]) {
      bot.blockAt = at => {
        const p = at.floored()
        if (p.x !== 553 || p.y !== y || p.z !== 559) return read(p)
        const b = Block.fromStateId(data.blocksByName[name].defaultState,0); b.position = p; return b
      }
      assert.equal(mv.getNeighbors(start).some(n => n.x === 553 && n.y === 136 && n.z === 559),false,`${name} at feet/head remains forbidden`)
    }
    bot.blockAt = read
  } finally { scope.restore(); stopBurn() }
  const combatOnly = combatMovement(bot,{ x: 600.5, y: 120, z: 600.5, r: 80, killY: 113 })
  try {
    assert.equal(new AStar(start,mv,new goals.GoalBlock(553,136,559),5000).compute().status,'success',
      'an arena combat wrapper also retains the newly installed origin price')
  } finally { combatOnly.restore() }
})

// A three-block descent has two exits: a direct hot landing and a dry detour.
function ledge (landing = 'magma_block', height = 3, hazard: [number, number] = [1, 0]) {
  const bot: any = { registry: data, game: { minY: -8, dimension: 'overworld' },
    entity: { position: new Vec3(.5, height, .5), effects: {} }, inventory: { items: () => [] },
    pathfinder: { bestHarvestTool: () => null } }
  bot.blockAt = at => {
    const p = at.floored()
    const name = p.y === height - 1 && p.x === 0 && p.z === 0 ? 'stone' :
      p.y === -1 ? p.x === hazard[0] && p.z === hazard[1] ? landing : 'stone' : 'air'
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0)
    block.position = p
    return block
  }
  const movements = bot.pathfinder.movements = new Movements(bot)
  movements.canDig = false
  movements.allowParkour = false
  movements.maxDropDown = 4
  tuneMovements(bot, movements)
  return { bot, movements, start: new Move(0, height, 0, 0, 0) }
}

test('a native three-block descent prices its actual magma landing and chooses the dry detour', () => {
  const hot = ledge(), dry = ledge('stone')
  const landing = ({ movements, start }) => movements.getNeighbors(start).find(m => m.x === 1 && m.y === 0 && m.z === 0)
  assert.ok(landing(hot), 'magma remains a possible route')
  assert.ok(landing(hot).cost > landing(dry).cost, 'the landing has a contact cost despite being below the checked departure cells')
  assert.ok(Number.isFinite(landing(hot).cost))
  const route = new AStar(hot.start, hot.movements, new goals.GoalBlock(2, 0, 0), 1000, 1000).compute()
  assert.equal(route.status, 'success')
  assert.ok(route.path.every(m => m.x !== 1 || m.z !== 0), JSON.stringify(route.path))
})

test('a native descent still rejects lava rather than treating it as support', () => {
  const { movements, start } = ledge('lava')
  assert.equal(movements.getNeighbors(start).some(m => m.x === 1 && m.y === 0 && m.z === 0), false)
})

test('a native one-block diagonal descent prices its lower magma landing', () => {
  const hot = ledge('magma_block', 1, [1, 1]), dry = ledge('stone', 1, [1, 1])
  const landing = ({ movements, start }) => movements.getNeighbors(start).find(m => m.x === 1 && m.y === 0 && m.z === 1)
  assert.ok(landing(hot), 'the diagonal remains possible')
  assert.ok(landing(hot).cost > landing(dry).cost, 'the diagonal checks departure Y but lands one block lower')
})

test('a native one-block cardinal descent keeps its existing landing price exactly once', () => {
  const hot = ledge('magma_block', 1), dry = ledge('stone', 1)
  const landing = ({ movements, start }) => movements.getNeighbors(start).find(m => m.x === 1 && m.y === 0 && m.z === 0)
  assert.equal(landing(hot).cost - landing(dry).cost, 20)
})

test('a flat native diagonal prices the magma corner swept between dry nodes, while parallel walking stays free', () => {
  const hot = ledge('magma_block', 0), dry = ledge('stone', 0)
  const diagonal = ({ movements, start }) => movements.getNeighbors(start).find(m => m.x === 1 && m.y === 0 && m.z === 1)
  assert.ok(diagonal(hot).cost > diagonal(dry).cost, 'the body clips magma (1,-1,0) between dry centres (.5,.5) and (1.5,1.5)')
  const parallel = ({ movements }) => movements.getNeighbors(new Move(0, 0, 1, 0, 0)).find(m => m.x === 1 && m.y === 0 && m.z === 1)
  assert.equal(parallel(hot).cost, parallel(dry).cost, 'a parallel body stays .2 blocks clear of the same adjacent magma')
})

test('the landing price preserves the magma option with fire resistance or crouching', () => {
  for (const protectedBy of ['fire_resistance', 'sneak']) {
    const { bot, movements, start } = ledge()
    if (protectedBy === 'fire_resistance') bot.entity.effects[data.effectsByName.FireResistance.id] = { amplifier: 0, duration: 200 }
    bot.getControlState = key => key === 'sneak' && protectedBy === 'sneak'
    const landing = movements.getNeighbors(start).find(m => m.x === 1 && m.y === 0 && m.z === 0)
    assert.ok(landing && Number.isFinite(landing.cost), protectedBy)
  }
})

function overheadLava (sourceZ = 0) {
  const f = ledge('stone', 0), read = f.bot.blockAt
  f.bot.blockAt = p => {
    if (p.x === 0 && p.y === 1 && p.z === sourceZ) {
      const b = Block.fromStateId(data.blocksByName.lava.defaultState, 0); b.position = p; return b
    }
    return read(p)
  }
  f.bot.entity.position = new Vec3(-2.5, 0, .5)
  return f
}

test('the real reposition stage must not replace a safe path with a direct shortcut below head lava', async () => {
  const { bot } = overheadLava(), calls: boolean[] = [], read = bot.blockAt
  bot.blockAt = p => {
    if (p.floored().equals(new Vec3(0, 0, 0))) {
      const b = Block.fromStateId(data.blocksByName.cobblestone.defaultState, 0); b.position = p.floored(); return b
    }
    return read(p)
  }
  bot.entity.position = new Vec3(-.778105010748, .129673781664, .737370107392)
  bot.entity.yaw = 2.382374428972
  bot.getControlState = () => false
  const ctx: any = { bot, Vec3, blockName: (_bot, p) => bot.blockAt(p).name,
    entity: { id: 1, position: new Vec3(4.5, 0, .5) }, pathing: true,
    reposition: { from: bot.entity.position.clone(), at: 0, target: 1 }, losGoal: null,
    miningProgress: () => false, pathTo: on => calls.push(on), routeInputs: () => 'unchanged',
    clear() {}, st: {}, used() {}, sleep: async () => {} }
  ctx.hazardOnLine = createTerrain(ctx).hazardOnLine
  await repositionTurn(ctx, { me: bot.entity.position, now: 100, dy: 0, r: 4.5, seesBody: true } as any)
  assert.deepEqual(calls, [], 'head lava must keep the established detour instead of pathTo(false)')
  assert.equal(ctx.pathing, true)
})

test('the existing direct-line sampler returns the real head-lava cell at the body edge', () => {
  const { bot } = overheadLava(1)
  bot.entity.position = new Vec3(-2, 0, .8)
  const ctx: any = { bot, Vec3, blockName: (_bot, p) => bot.blockAt(p).name, entity: { position: new Vec3(4.5, 0, .8) } }
  const terrain = createTerrain(ctx), hit = terrain.hazardOnLine()
  assert.ok(hit)
  assert.deepEqual(hit.cell, new Vec3(0, 1, 1), 'unblockPath must receive the actual source, not a projected floor cell')
  bot.entity.position.z = -.8; ctx.entity.position.z = -.8
  assert.equal(terrain.hazardOnLine(), null, 'a clear parallel body corridor keeps the direct option')
})

test('the related hop consumer keeps its real native safety check and does not repeat an unchanged refusal', async () => {
  for (const blocked of [false, true]) {
    const cells: Array<[number, number, number, string]> = [[0, 1, 0, 'cobblestone'], [0, 2, 0, 'lava']]
    if (blocked) cells.push([-1, 0, 0, 'stone'])
    else for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) cells.push([x, 0, z, 'stone'])
    const { bot, world } = worldOf(cells), pathCalls: boolean[] = [], samples: any[] = []
    bot.entity.position = new Vec3(-.778105, 1, .73737); bot.entity.velocity.y = -.0784000015258789
    drive(bot, world)
    bot.on('physicsTick', () => samples.push({ pos: bot.entity.position.clone(), lava: bot.entity.isInLava }))
    const ctx: any = { bot, Vec3, blockName: (_bot, p) => bot.blockAt(p).name, entity: { position: new Vec3(4.5, 1, .5) }, aim: 'target',
      HOP: true, prof: { player: true }, ctl: { aborted: false, onAbort: [] }, pathing: true,
      miningProgress: () => false, pathTo: on => pathCalls.push(on), routeInputs: () => 'unchanged-head-source',
      clear: () => bot.clearControlStates(), st: {}, used() {}, sleep: ms => bot.waitForTicks(Math.ceil(ms / 50)) }
    ctx.hazardOnLine = createTerrain(ctx).hazardOnLine
    const ownedAim: string[] = []
    bot.on('physicsTick', () => { if (bot._ndParkourForecast) ownedAim.push(ctx.aim) })
    const frame: any = { d: 5.28, dy: 0, r: 4.98, meInWeb: false }
    await hopTurn(ctx, frame)
    assert.equal(ctx.st.hops, 1, 'the newly visible head hazard reaches the existing hop planner')
    assert.ok(samples.every(s => !s.lava && bodyClear(bot, s.pos)), 'native execution must not jump through the source')
    assert.ok(ownedAim.every(aim => aim === 'free'), 'the real combat hop must own yaw while its native trajectory executes')
    assert.equal(ctx.aim, 'target', 'the preceding combat aim owner must resume after the hop')
    if (blocked) {
      assert.equal(ctx.failedHop?.why, 'no_short_hop', 'the only forward landing is inside lava and must be refused')
      const before = pathCalls.length
      await hopTurn(ctx, frame)
      assert.equal(pathCalls.length, before, 'the same failed native option must not stop the route again')
    } else assert.equal(ctx.st.hopEff, 1)
  }
})

test('an admitted native walk yields before its next body enters newly observed head lava', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 1; z++) cells.push([x, 0, z, 'stone'])
  const { bot, world } = worldOf(cells), original = world.getBlock.bind(world)
  let spread = false, contacts = 0, ticks = 0, control = { ...IDLE }
  const lavaCell = new Vec3(3, 2, 0)
  world.getBlock = p => {
    if (!spread || !p.floored().equals(lavaCell)) return original(p)
    const b = Block.fromStateId(data.blocksByName.lava.defaultState, 0); b.position = lavaCell; return b
  }
  const plan = planJump(bot, new Vec3(4.5, 1, .5), { allowWalk: true })
  assert.ok(plan, 'the original observed corridor really has a safe native walk')
  bot.setControlState = (key, value) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async yaw => { bot.entity.yaw = yaw }
  bot.waitForTicks = async count => {
    for (let tick = 0; tick < count; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); ticks++
      if (!bodyClear(bot, bot.entity.position)) contacts++
      if (ticks === 1) spread = true
      bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  const result = await executePlan(bot, { aborted: false }, plan, () => true)
  for (let tick = 0; tick < 6; tick++) {
    const state = new native.PlayerState(bot, control)
    bot.physics.simulatePlayer(state, world); state.apply(bot)
    if (!bodyClear(bot, bot.entity.position)) contacts++
  }
  assert.equal(result.ok, false, 'a newly visible liquid must invalidate the dry forecast before damage')
  assert.equal(contacts, 0, 'the real native body and its remaining stopping momentum must stay outside the new head-lava cell')
  assert.equal(control.forward, false)
})


test('captured native hop rejects a known lava corner swept between two clear endpoint bodies', async () => {
  const cells: Array<[number, number, number, string]> = [[3, 1, -4, 'lava']]
  for (let x = -1; x <= 6; x++) for (let z = -6; z <= 1; z++) cells.push([x, -1, z, 'stone'])
  const { bot, world } = worldOf(cells)
  const from = new Vec3(4.144510534406, 1.2491870787446, -4.30945948412)
  bot.entity.position = from.clone(); bot.entity.velocity = new Vec3(.1708153252344207, .0030162615090425808, .11142394078982004)
  bot.entity.onGround = false; bot.entity.yaw = -2.2377081717403207
  const control = { ...IDLE, forward: true, sprint: true }
  const next = new native.PlayerState(bot, control)
  bot.physics.simulatePlayer(next, world)
  assert.ok(bodyClear(bot, from) && bodyClear(bot, next.pos), 'both real native tick endpoints miss the source')
  assert.equal(bodyClear(bot, next.pos, { from }), false, 'Entity.collidedAlongVector also checks the moving body between endpoints')
  const edge = new Vec3(4 + dimensions(bot).half, 1.2, -3.5)
  assert.ok(bodyClear(bot, edge.offset(.2, 0, 0), { from: edge }), 'a body touching the boundary may move away')
  assert.ok(bodyClear(bot, edge.offset(0, 0, .2), { from: edge }), 'parallel tangency is not a fluid intersection')
  let forward = false
  bot.setControlState = (key, value) => { if (key === 'forward') forward ||= value }
  bot.clearControlStates = () => {}
  bot.waitForTicks = async () => { next.apply(bot); bot.emit('physicsTick') }
  const result = await executePlan(bot, { aborted: false }, { steps: [{ yaw: bot.entity.yaw, control }], states: [next], ticks: 1, target: next.pos }, () => true)
  assert.equal(result.ok, false)
  assert.equal(forward, false, 'the executor must reject the swept source before emitting acceleration')
})


function capturedEdgeFallback(t, { lava = true, fireResistance = false, arenaRadius = 8 } = {}) {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true }); clockModule.activate(clock)
  const cells: Array<[number, number, number, string]> = []
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.push([x, -1, z, 'stone'])
  if (lava) for (const [x, y, z] of [[4, 0, -3], [4, 0, -2], [4, 0, -1], [5, 0, -2], [5, 0, -1], [4, 1, -3], [4, 1, -2], [4, 1, -1]]) cells.push([x, y, z, 'lava'])
  const { bot, world } = worldOf(cells)
  bot.entity.position = new Vec3(5.84732281386, 0, -2.55041039963)
  bot.entity.velocity = new Vec3(.08236057948020035, -.0784000015258789, .007669730622275841)
  bot.entity.yaw = 3.0394908923479846; bot.entity.onGround = true
  if (fireResistance) bot.entity.effects[data.effectsByName.FireResistance.id] = { amplifier: 0, duration: 200 }
  const control = { ...IDLE, left: true }
  const guard = (require('../src/edges') as typeof import('../src/edges')).guard(bot, { margin: () => .35, arena: { x: 0, y: 0, z: 0, r: arenaRadius } })
  t.after(() => { guard.stop(); clock.dispose(); clockModule.activate(null) })
  for (let tick = 0; tick < 3; tick++) { clock.advanceTicks(1); bot.physics.simulatePlayer(new native.PlayerState(bot, control), world) }
  return bot.physics.simulatePlayer(new native.PlayerState(bot, control), world).control
}

test('captured edge fallback chooses the existing dry back step instead of idling beside spreading lava', t => {
  const actual = capturedEdgeFallback(t)
  assert.equal(actual.back, true, 'BACK improves existing burn cost30→0 and clearance.35→.9 without entering known lava')
  assert.equal(actual.forward || actual.left || actual.right, false)
})

test('ordinary dry-floor edge physics retains the requested strafe', t => {
  const actual = capturedEdgeFallback(t, { lava: false })
  assert.equal(actual.left, true)
  assert.equal(actual.back, false)
})

test('live fire resistance preserves the previous idle edge fallback beside lava', t => {
  const actual = capturedEdgeFallback(t, { fireResistance: true })
  assert.equal(actual.forward || actual.back || actual.left || actual.right, false)
})


test('an edge fallback without an improved in-arena candidate keeps the previous stop', t => {
  const actual = capturedEdgeFallback(t, { arenaRadius: 7.3 })
  assert.equal(actual.forward || actual.back || actual.left || actual.right, false)
})
