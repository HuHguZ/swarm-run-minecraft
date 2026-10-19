// Паркур: маршрут по опорам — видимость посадок, граф опор, обход гребня, лестницы и лозы, сроки, отказы, широкий граф, дверь.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Block, native, worldOf, drive } from './parkour-fixture'

test('landing visibility uses the exposed collision top when neighbouring floor hides block centers', () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  bot.canSeeBlock = () => false
  let endY = 0
  bot.world = { raycast(from: Vec3, direction: Vec3, distance: number) { endY = from.y + direction.y * distance; return endY < 1 ? {} : null } }
  const { visibleLanding, localOptions }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  assert.equal(visibleLanding(bot, new Vec3(2.5, 1, .5)), true)
  assert.ok(endY > 1 && endY < 1.03)
  assert.ok(localOptions(bot, { toward: new Vec3(2.5, 1, .5) }).some((option: any) => option.target.x === 2.5))
  bot.world.raycast = () => ({ position: new Vec3(1, 1, 0) })
  assert.equal(visibleLanding(bot, new Vec3(2.5, 1, .5)), false, 'solid cover still refuses an unobserved landing')
})
test('support routing approaches around a ridge taller than the native jump instead of repeatedly targeting behind it', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -7; x <= 7; x++) for (let z = 0; z <= 7; z++) cells.push([x, 0, z, 'stone'])
  for (let x = -4; x <= 4; x++) for (const y of [1, 2]) cells.push([x, y, 2, 'stone'])
  for (let x = -7; x <= 7; x++) for (let z = 4; z <= 7; z++) cells.push([x, 1, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.velocity.y = -.0784000015258789
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const path = await supportRoute(bot, bot.entity.position, new Vec3(.5, 2, 6.5), new Set(), 8)
  assert.ok(path.length)
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  for (const option of path) {
    const plan = await planJumpAsync(bot, { aborted: false }, option.target, { allowWalk: true, planningMs: 180 })
    assert.ok(plan, `the chosen approach must have a real native trajectory to ${option.target}`)
    const landed = plan.states[plan.states.length - 1]
    bot.entity.position = landed.pos; bot.entity.velocity = landed.vel; bot.entity.onGround = landed.onGround
  }
})
test('a nearby lower goal can require intermediate supports above its height', async () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'stone'], [2, 2, 0, 'stone'], [3, 3, 0, 'stone'], [4, 4, 0, 'stone'], [5, 3, 0, 'stone'], [6, 2, 0, 'stone'], [7, 1, 0, 'stone']])
  const path = await (require('../src/navigation/support-route') as typeof import('../src/navigation/support-route')).supportRoute(bot, bot.entity.position, new Vec3(7.5, 2, .5), new Set(), 8)
  assert.ok(path.some((option: any) => option.target.y >= 4), 'the bounded graph must retain the higher intermediate approach')
})
test('support discovery derives stable exposed edges from collision shapes above the floor block', () => {
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [0, 1, 0, 'oak_fence', { north: false, south: false, east: true, west: true, waterlogged: false }]])
  const { standPositions, bodyClear, supportAt }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const choices = standPositions(bot, new Vec3(0, 1, 0), { rise: 0, drop: 0 })
  assert.ok(choices.length, 'the observed floor has exposed support beside the elevated rail even though its center clips it')
  for (const p of choices) {
    assert.equal(bodyClear(bot, p), true); assert.ok(supportAt(bot, p, .01))
    bot.entity.position = p; bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
    const state = new native.PlayerState(bot, { ...(require('../src/navigation/parkour') as typeof import('../src/navigation/parkour')).IDLE, sneak: true })
    for (let tick = 0; tick < 6; tick++) bot.physics.simulatePlayer(state, world)
    assert.equal(state.onGround, true); assert.equal(state.pos.y, 1); assert.ok(state.pos.distanceTo(p) < 1e-6)
  }
})
test('routing can recognise an actual stable partial top within native step height while refusing unsupported or airborne poses', () => {
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [0, 1, 0, 'daylight_detector']])
  const { settledLanding, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  bot.entity.position = new Vec3(-.05, 1.375, .64); bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
  const state = new native.PlayerState(bot, { ...IDLE, sneak: true })
  for (let tick = 0; tick < 6; tick++) {
    bot.physics.simulatePlayer(state, world)
    assert.equal(settledLanding(bot, state, new Vec3(-.3, 1, .5)), true)
  }
  assert.equal(settledLanding(bot, { ...state, pos: new Vec3(-.8, 1.375, .5) }, new Vec3(-.8, 1, .5)), false)
  assert.equal(settledLanding(bot, { ...state, onGround: false }, new Vec3(-.3, 1, .5)), false)
  assert.equal(settledLanding(bot, state, new Vec3(-.3, 0, .5)), false)
})
test('edge support follows actual 1.21.11 shapes, including narrow centers and fence height', () => {
  const { bot } = worldOf([[0, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  const support = (require('../src/edges') as typeof import('../src/edges')).support
  assert.equal(support(bot, new Vec3(.5, 1.5, .5)).drop, 0)
  assert.ok(support(bot, new Vec3(.05, 1.5, .05)).drop > 3, 'the corners of the cell are air, not fence support')
})
test('geometry selects shape tops and tests the entire player body against rotated states', () => {
  const { supportAt, bodyClear, standPositions }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  for (const [name, properties, height] of [
    ['skeleton_skull', { rotation: 0 }, .5],
    ['oak_slab', { type: 'bottom', waterlogged: false }, .5],
    ['oak_slab', { type: 'top', waterlogged: false }, 1],
    ['oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }, 1.5],
    ['glass_pane', { north: false, south: false, east: false, west: false, waterlogged: false }, 1],
    ['pointed_dripstone', { vertical_direction: 'up', thickness: 'tip', waterlogged: false }, .6875]
  ] as const) {
    const { bot } = worldOf([[0, 0, 0, name, properties]])
    assert.equal(supportAt(bot, new Vec3(.5, height, .5), .01)?.top, height, name)
    assert.ok(standPositions(bot, new Vec3(0, height, 0), { rise: 1, drop: 1 }).some((p: Vec3) => p.y === height), name)
  }
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'stone']])
  assert.equal(bodyClear(bot, new Vec3(.8, 1, .5)), false, 'body edge clips the adjacent wall')
  assert.equal(bodyClear(bot, new Vec3(.69, 1, .5)), true)
  for (const facing of ['east', 'west', 'north', 'south']) {
    const stairs = worldOf([[0, 0, 0, 'jungle_stairs', { facing, half: 'bottom', shape: 'straight', waterlogged: false }]])
    assert.ok(standPositions(stairs.bot, new Vec3(0, .5, 0), { rise: .5, drop: 0 }).some((p: Vec3) => p.y === .5), `${facing} lower tread needs an offset body center`)
  }
})
test('shared route motion walks continuous floor and discovers visible shape landings', () => {
  const { planJump, localOptions }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'skeleton_skull', { rotation: 0 }]])
  const plan = planJump(bot, new Vec3(1.5, 1, .5), { allowWalk: true, beam: 16 })
  assert.ok(plan)
  assert.ok(plan.steps.every((step: { control: { jump: boolean } }) => !step.control.jump), 'ordinary walking does not force a jump')
  bot.canSeeBlock = (block: { position: Vec3 }) => block.position.x === 2
  const options = localOptions(bot, { toward: new Vec3(3, 1, .5) })
  assert.ok(options.length > 0)
  assert.ok(options.every((option: { support: string; target: Vec3 }) => option.support === 'skeleton_skull' && option.target.y === .5))
})
test('ascending routes try actual higher supports even when the route initially bends away from the goal', () => {
  const { localOptions }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[-2, 0, 0, 'stone'], [-1, 0, 0, 'stone'], [0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const options = localOptions(bot, { toward: new Vec3(-10, 7, .5) })
  assert.equal(options[0].target.y, 2, 'flat floor closer to a distant checkpoint must not starve its climbing approach')
})
test('cooperative native search shares the block cache with body geometry and keeps timers running', async () => {
  const { planJumpAsync, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [0, 0, -1, 'stone'], [1, 1, 0, 'stone'], [1, 2, 0, 'stone'],
    [2, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  const idle = new native.PlayerState(bot, IDLE)
  bot.physics.simulatePlayer(idle, { getBlock: bot.blockAt }); bot.entity.velocity = idle.vel
  const read = bot.blockAt; let reads = 0; let heartbeats = 0
  bot.blockAt = (p: Vec3) => { reads++; return read(p) }
  const timer = setInterval(() => { heartbeats++ }, 1)
  try {
    const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 1.5, .5), { beam: 60 })
    assert.ok(plan)
    assert.ok(heartbeats > 20, 'the async search must allow the physical clock to run')
    assert.ok(reads < 500, `body geometry must reuse observed blocks, got ${reads} reads`)
  } finally { clearInterval(timer) }
})
export { worldOf }
test('loaded support graph chooses a chain around the goal and removes refused native edges', async () => {
  const { supportRoute, landingKey }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone'], [4, 2, 1, 'stone'], [2, 3, 3, 'stone'], [0, 4, 4, 'stone'], [-2, 5, 4, 'stone']])
  const goal = new Vec3(-1.5, 6, 4.5)
  const path = await supportRoute(bot, bot.entity.position, goal, new Set())
  assert.ok(path.length >= 5, 'a distant ascent uses intermediate actual supports')
  assert.equal(path[0].target.y, 2)
  assert.ok(path[0].target.x > bot.entity.position.x, 'the first waypoint may move away from the checkpoint')
  assert.ok(path[path.length - 1].target.distanceTo(goal) < .8)
  const blocked = new Set([`${landingKey(bot.entity.position)}>${path[0].key}`])
  const retry = await supportRoute(bot, bot.entity.position, goal, blocked)
  assert.ok(!retry.length || retry[0].key !== path[0].key, 'refused edges must not be selected repeatedly')
})
test('a refused optimistic gap leaves loaded short ascents available behind a sight obstruction and away from the goal', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, -1, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone'], [1, 0, 1, 'stone'],
    [-5, 1, 0, 'stone'], [2, 1, -3, 'stone'], [3, 1, -3, 'stone'], [3, 1, -2, 'stone'], [3, 2, -5, 'stone']])
  bot.entity.position = new Vec3(.470686, 1, .471266); bot.entity.velocity.y = -.0784000015258789
  bot.canSeeBlock = () => false
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(-4.5, 2, .5), maxLandings: 3 })
  assert.ok(result.rejected.length, 'the direct gap has no executable native trajectory')
  assert.ok(result.landings.some((landing: any) => landing.ok && landing.at.x > 2 && landing.at.y >= 2), 'a short observed ascent must reach the same native controller before repeated speculative gap edges exhaust the route')
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})
test('a refused wide gap explores an unvisited flat approach instead of returning to the same inner raised ledge', async () => {
  const cells: Array<[number, number, number, string]> = [[0, 0, 0, 'stone'], [-1, 1, 0, 'stone'], [-7, 1, 0, 'stone']]
  for (let x = 1; x <= 4; x++) cells.push([x, 1, 0, 'stone'])
  for (let z = 1; z <= 5; z++) cells.push([4, 1, z, 'stone'])
  for (let x = -7; x < 4; x++) cells.push([x, 1, 5, 'stone'])
  for (let z = 1; z < 5; z++) cells.push([-7, 1, z, 'stone'])
  cells.push([-7, 2, -2, 'stone'], [-7, 3, -4, 'stone'])
  const { bot, world } = worldOf(cells)
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  bot.entity.velocity.y = -.0784000015258789; bot.canSeeBlock = () => false
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(-6.5, 2, .5), maxLandings: 4 })
  assert.ok(result.landings.some((landing: any) => landing.ok && landing.at.x > 1.5 && landing.at.y === 2), JSON.stringify(result.landings))
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})
test('a macro route replans from six real supported stopping frames after a bounded landing correction without claiming its exact target', async () => {
  const { bot, world } = worldOf(Array.from({ length: 9 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  bot.entity.velocity.y = -.0784000015258789
  let control = { ...IDLE }; let corrected = false
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot)
      if (!corrected && control.sneak && bot.entity.onGround) { bot.entity.position.z += .4; corrected = true }
      bot.emit('physicsTick')
    }
  }
  const target = new Vec3(8.5, 1, .5)
  const result = await route(bot, { aborted: false }, { toward: target, maxLandings: 8 })
  assert.equal(corrected, true)
  assert.equal(result.ok, true, JSON.stringify(result.landings))
  assert.ok(result.landings.some((landing: any) => landing.ok === false && landing.why === 'landing_not_confirmed' && landing.actualLanding?.confirmed === true), 'the exact requested landing stays unconfirmed while the observed stable support lets routing continue')
  assert.ok(bot.entity.position.distanceTo(target) < .35); assert.equal(bot.entity.onGround, true); assert.equal(bot.health, 20)
  assert.equal(bot._ndParkourForecast, undefined)
})
test('loaded support graph connects a real climbable column to its upper platform', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 1; y < 6; y++) cells.push([1, y, 0, 'stone'], [0, y, 0, 'ladder', { facing: 'west', waterlogged: false }])
  const { bot } = worldOf(cells)
  const path = await supportRoute(bot, bot.entity.position, new Vec3(1.5, 6, .5), new Set())
  assert.ok(path.length)
  assert.equal(path[0].mode, 'climb')
  assert.equal(path[0].target.y, 6)
})
test('a translated observed closed door and wooden ladder room cannot create a climb graph connection from outside', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  // Author39: translated by (+21,-102,-41). The exact door state is native;
  // the remaining room shell was read from the official unchanged map copy.
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  for (let x = -3; x <= 3; x++) for (let z = -2; z <= 3; z++) cells.push([x, 0, z, 'white_concrete_powder'])
  for (let y = 1; y <= 4; y++) {
    for (const x of [-1, 1]) for (let z = 0; z <= 2; z++) cells.push([x, y, z, 'birch_wood', { axis: 'y' }])
    cells.push([0, y, 0, y <= 2 ? 'iron_door' : 'birch_wood', y <= 2 ? { facing: 'north', half: y === 1 ? 'lower' : 'upper', hinge: 'left', open: false, powered: false } : { axis: 'y' }])
    cells.push([0, y, 2, y === 2 ? 'white_stained_glass_pane' : 'birch_wood', y === 2 ? { east: true, west: true, north: false, south: false, waterlogged: false } : { axis: 'y' }])
    cells.push([0, y, 1, 'ladder', { facing: 'east', waterlogged: false }])
  }
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.426236141557414, 1, -.50526270235978)
  const path = await supportRoute(bot, bot.entity.position, new Vec3(-.5, 5, .5), new Set(), 6)
  assert.ok(path.every((option: any) => !option.climb), 'a free tagged column behind the closed shape enclosure is not an accessible climb contact')
})
test('a complete observed long ladder or vine connects its actual exit and retains a native stable landing', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  for (const name of ['ladder', 'vine']) {
    const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
    // The open lower shaft of the map copy, translated from Y94..106 to Y1..13.
    // This does not prove the unobserved approach from the current native pose.
    for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
    for (let y = 1; y <= 13; y++) cells.push([0, y, 0, name, name === 'ladder' ? { facing: 'east', waterlogged: false } : { west: true }])
    const { bot } = worldOf(cells); bot.entity.velocity.y = -.0784000015258789
    const before = bot.entity.position.clone(); const target = new Vec3(-.5, 14, .5)
    const path = await supportRoute(bot, before, target, new Set(), 6)
    assert.ok(path.some((option: any) => option.climb && option.target.distanceTo(target) < .8), 'the observed column exit must not disappear above the ordinary eight-block support scan')
    const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: { x: .5, y: 1, z: .5 }, maxTicks: 180, planningMs: 180, allowWalk: true })
    assert.ok(plan, 'the full loaded climb must use the existing native direct profile instead of an eight-block height refusal')
    assert.deepEqual(bot.entity.position, before)
    const landed = simulatePlan(bot, plan.steps)
    assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 14)
    assert.ok(landed.pos.distanceTo(target) < .22)
    assert.ok(plan.states.slice(-6).every((state: any) => state.onGround && state.pos.y === 14 && state.pos.distanceTo(target) < .22))
  }
})
test('the shared route executes a full observed long climb through the existing controller and releases its owner', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
  for (let y = 1; y <= 13; y++) cells.push([0, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot, world } = worldOf(cells); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(-.5, 14, .5); let control = { ...IDLE }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const result = await route(bot, ctl, { toward: target, maxLandings: 3 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.landings.some((receipt: any) => receipt.mode === 'climb' && receipt.ok && receipt.at.y === 14))
  assert.equal(bot.entity.onGround, true); assert.ok(bot.entity.position.distanceTo(target) < .22)
  assert.equal(bot._ndParkourForecast, undefined); assert.equal(ctl.onAbort.length, 0)
  assert.equal(control.forward, false); assert.equal(control.jump, false)
})
test('a long climb refuses an unknown column end or a solid roof before native movement', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
  for (let y = 1; y <= 13; y++) cells.push([0, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const target = new Vec3(-.5, 14, .5); const contact = { x: .5, y: 1, z: .5 }
  const unknown = worldOf(cells); const observed = unknown.bot.blockAt
  unknown.bot.blockAt = (p: Vec3) => p.x >= 0 && p.x < 1 && p.z >= 0 && p.z < 1 && p.y >= 14 ? null : observed(p)
  const missing = await supportRoute(unknown.bot, unknown.bot.entity.position, target, new Set(), 6)
  assert.ok(missing.every((option: any) => option.target.y < 14))
  assert.equal(await planJumpAsync(unknown.bot, { aborted: false }, target, { climb: contact, maxTicks: 180, planningMs: 180 }), null)
  for (let x = -2; x <= 1; x++) for (let z = -1; z <= 1; z++) cells.push([x, 14, z, 'stone'])
  const roof = worldOf(cells)
  const closed = await supportRoute(roof.bot, roof.bot.entity.position, target, new Set(), 6)
  assert.ok(closed.every((option: any) => option.target.y < 14))
  assert.equal(await planJumpAsync(roof.bot, { aborted: false }, target, { climb: contact, maxTicks: 180, planningMs: 180 }), null)
  assert.deepEqual(roof.bot.entity.position, new Vec3(.5, 1, .5))
})
test('complete column observation respects actual world bounds, cancellation and a CPU budget', () => {
  const { climbColumn }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { bot } = worldOf([[0, 1, 0, 'ladder', { facing: 'east', waterlogged: false }]])
  const ladder = bot.blockAt(new Vec3(0, 1, 0)); let reads = 0
  bot.game = { minY: 0, height: 32 }
  bot.blockAt = (p: Vec3) => { reads++; assert.ok(p.y < 32, 'the scan cannot query beyond the observed dimension'); return { ...ladder, position: p } }
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }), null)
  assert.equal(reads, 31, 'an endless fake column must stop at the real dimension bound')
  reads = 0
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }, () => reads >= 3), null)
  assert.equal(reads, 3)
  reads = 0
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }, undefined, 0), null)
  assert.equal(reads, 0)
})
test('a real side approach around a tall corner remains a native climb connection when the direct body path is blocked', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 2, 'stone']]
  for (let y = 0; y <= 2; y++) cells.push([0, y, 0, 'stone'])
  for (let y = 0; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  for (let y = 1; y <= 2; y++) cells.push([1, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, 2.5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(.5, 3, .5)
  const path = await supportRoute(bot, bot.entity.position, target, new Set(), 6)
  assert.ok(path.some((option: any) => option.climb), 'a blocked straight ray must not hide the observed side catch')
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(1.5, 1, .5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan)
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 3); assert.ok(landed.pos.distanceTo(target) < .22)
})
test('a native jump over a low enclosure can catch its ladder from a higher approach plane', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  for (let x = -2; x <= 2; x++) for (let z = -3; z <= 3; z++) cells.push([x, 0, z, 'stone'])
  for (const x of [-1, 1]) for (let z = 0; z <= 2; z++) cells.push([x, 1, z, 'stone'])
  cells.push([0, 1, 0, 'stone'], [0, 1, 2, 'stone'])
  for (let y = 1; y <= 3; y++) cells.push([-1, y, 1, 'stone'], [0, y, 1, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, -1.5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(-.5, 4, 1.5)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(.5, 1, 1.5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan, 'the native integrator earns a real jump over the one-block front wall before ladder contact')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 4)
  const path = await supportRoute(bot, bot.entity.position, target, new Set(), 6)
  assert.ok(path.some((option: any) => option.climb), 'a ground-only enclosure cannot remove a native reachable elevated catch')
})
test('route returns its completed landings and interrupted trajectory at its own game deadline before the outer RPC timeout', async () => {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { navigate, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf(Array.from({ length: 5 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  let control = { ...IDLE }; let completed = 0
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.on('nd_parkour_route', (receipt: { ok: boolean }) => {
    if (receipt.ok && ++completed === 1) clock.advanceTicks(19997 - clock.ticks)
  })
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      clock.advanceTicks(1); bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  try {
    const result: any = await navigate(bot, ctl, { mode: 'route', target: new Vec3(4.5, 1, .5), waypoints: [new Vec3(2.5, 1, .5)], maxLandings: 8, timeoutSeconds: 1000 })
    assert.equal(result.ok, false); assert.equal(result.why, 'route_deadline')
    assert.equal(result.landings.length, 2, 'the report keeps the completed landing and the motion interrupted at the deadline')
    assert.equal(result.landings[0].ok, true)
    const interrupted = result.landings[1]
    assert.equal(interrupted.why, 'interrupted'); assert.ok(interrupted.ticks > 0)
    assert.ok(interrupted.trajectory.at(-1).expected)
    assert.ok(interrupted.trajectory.at(-1).observation.actual.cells.length)
    assert.equal(clock.now(), 1000000); assert.ok(clock.now() < 1020000)
    assert.equal(ctl.aborted, false); assert.equal(ctl.onAbort.length, 0)
    assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('end'), 0)
    assert.equal(bot._ndParkourForecast, undefined); assert.equal(control.forward, false)
  } finally { clock.dispose(); clockModule.activate(null) }
})
test('a support graph stops reading loaded blocks when cancellation arrives at its cooperative yield', async () => {
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { bot } = worldOf(Array.from({ length: 13 }, (_, i) => Array.from({ length: 13 }, (_, j) => [i - 6, 0, j - 6, 'stone'] as [number, number, number, string])).flat())
  let cancelled = false; let reads = 0; let readsAfterCancellation = 0
  const observed = { physics: bot.physics, blockAt(p: Vec3) { reads++; if (cancelled) readsAfterCancellation++; return bot.blockAt(p) } }
  const cancellation = setImmediate(() => { cancelled = true })
  try {
    const path = await supportRoute(observed, new Vec3(.5, 1, .5), new Vec3(6.5, 1, 6.5), new Set(), 6, {}, undefined, () => cancelled)
    assert.ok(reads > 0, 'cancellation must reach an already-running graph scan')
    assert.equal(readsAfterCancellation, 0, 'resuming a cancelled scan may not keep reading the remaining radius')
    assert.equal(path.length, 0)
  } finally { clearImmediate(cancellation) }
})
test('a route deadline reached inside the next support scan retains the preceding physical landing without launching another edge', async () => {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { navigate, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf(Array.from({ length: 9 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  let control = { ...IDLE }; let expiry: ReturnType<typeof setImmediate> | undefined; let readsAfterDeadline = 0
  const read = bot.blockAt
  bot.blockAt = (p: Vec3) => { if (clock.now() >= 1000000) readsAfterDeadline++; return read(p) }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.once('nd_parkour_route', () => { expiry = setImmediate(() => clock.advanceTicks(20000 - clock.ticks)) })
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      clock.advanceTicks(1); bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  try {
    const result: any = await navigate(bot, ctl, { mode: 'route', target: new Vec3(8.5, 1, .5), waypoints: [new Vec3(2.5, 1, .5)], maxLandings: 8, timeoutSeconds: 1000 })
    assert.equal(result.why, 'route_deadline'); assert.equal(result.ok, false)
    assert.equal(result.landings.length, 1); assert.equal(result.landings[0].ok, true)
    assert.equal(result.reachedGoals.length, 1); assert.equal(result.rejected.length, 0)
    assert.equal(readsAfterDeadline, 0, 'a cancelled graph returns the report before geometry fallback or another motion forecast')
    assert.equal(ctl.aborted, false); assert.equal(ctl.onAbort.length, 0)
    assert.equal(bot._ndParkourForecast, undefined); assert.equal(control.forward, false)
  } finally { if (expiry) clearImmediate(expiry); clock.dispose(); clockModule.activate(null) }
})
test('failed long bounce forecasts do not blacklist a support reachable after a shorter real bounce', async () => {
  const { route, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[-4, 3, 0, 'stone'], [0, 0, 2, 'slime_block'], [1, 0, 2, 'slime_block'],
    [4, 3, 2, 'spruce_slab'], [5, 3, 2, 'spruce_slab'], [6, 3, 2, 'spruce_slab'], [8, 3, -1, 'spruce_slab']])
  bot.entity.position = new Vec3(-3.41, 4, .49855); bot.entity.velocity.y = -.0784000015258789
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(8.5, 3.5, -.5), maxLandings: 16 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.rejected.filter((attempt: any) => attempt.target.x === 6.5 && attempt.bounce && attempt.ticks === 0).length >= 2)
  assert.ok(result.landings.some((landing: any) => landing.target.x === 6.5 && !landing.bounce && landing.ok), 'the same observed support remains reachable from the actual intermediate landing')
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})
test('a route can jump a gap to a slightly lower platform instead of only trying to walk off its edge', async () => {
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'dirt_path']])
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, .9375, .5), { allowWalk: true, planningMs: 180 })
  assert.ok(plan)
  assert.ok(plan.steps.some((step: { control: { jump: boolean } }) => step.control.jump))
})
test('native search CPU budget excludes time yielded to the physical clock', async () => {
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  // A busy clock callback runs while the planner cooperatively yields. It must
  // not turn a short valid native profile into a false unreachable landing.
  const callback = setImmediate(() => { const until = performance.now() + 35; while (performance.now() < until) {} })
  try {
    const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, .5), { planningMs: 20 })
    assert.ok(plan)
  } finally { clearImmediate(callback) }
})
test('a route edge refused only by its frame budget is retried once with a larger budget', async () => {
  const { route }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [3, 0, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const result = await route(bot, { aborted: false }, { toward: new Vec3(3.5, 1, .5), maxLandings: 6, frames: 40 })
  assert.equal(result.ok, true, JSON.stringify(result.rejected?.map((r: any) => r.why)))
  assert.ok(result.rejected.some((r: any) => r.why === 'planning_budget'), 'the first bounded attempt exhausts its frames')
  assert.ok(bot.entity.position.distanceTo(new Vec3(3.5, 1, .5)) < .25)
})
test('a near goal unreachable inside the local graph widens the routing disc instead of wandering below it', async () => {
  const { route }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  // An enclosed pad one block above the floor (CP18 shape): reachable only by a
  // staircase at x 16..19 and a bridge back west, outside the 14-block disc.
  const cells: Array<[number, number, number, string]> = []
  for (let x = 0; x <= 16; x++) cells.push([x, 0, 0, 'stone'])
  for (let step = 1; step <= 4; step++) cells.push([15 + step, step, 0, 'stone'])
  cells.push([19, 4, 1, 'stone'], [19, 4, 2, 'stone'])
  for (let x = 1; x <= 19; x++) cells.push([x, 4, 3, 'stone'])
  cells.push([0, 1, 3, 'stone'])
  for (let y = 1; y <= 3; y++) cells.push([-1, y, 3, 'stone'], [1, y, 3, 'stone'], [0, y + 1, 2, 'stone'], [0, y + 1, 4, 'stone'])
  const { bot, world } = worldOf(cells)
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const result = await route(bot, { aborted: false }, { toward: new Vec3(.5, 2, 3.5), maxLandings: 60, timeoutSeconds: 600 })
  assert.equal(result.ok, true, `${result.why} at ${JSON.stringify(result.at)}`)
})
test('a goal whose only approach leaves the 24-block disc is reached through the one-off wide support graph', async () => {
  const { route }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  // CP21→CP22 shape: an enclosed pad near the start, reachable only by stairs at
  // x 30..33 (outside the 24-block disc) and a bridge back over its enclosure.
  const cells: Array<[number, number, number, string]> = []
  for (let x = 0; x <= 30; x++) cells.push([x, 0, 0, 'stone'])
  for (let step = 1; step <= 4; step++) cells.push([29 + step, step, 0, 'stone'])
  cells.push([33, 4, 1, 'stone'], [33, 4, 2, 'stone'])
  for (let x = 1; x <= 33; x++) cells.push([x, 4, 3, 'stone'])
  cells.push([0, 1, 3, 'stone'])
  for (let y = 1; y <= 3; y++) cells.push([-1, y, 3, 'stone'], [1, y, 3, 'stone'], [0, y + 1, 2, 'stone'], [0, y + 1, 4, 'stone'])
  const { bot, world } = worldOf(cells)
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const result = await route(bot, { aborted: false }, { toward: new Vec3(.5, 2, 3.5), maxLandings: 90, timeoutSeconds: 1200 })
  assert.equal(result.ok, true, `${result.why} at ${JSON.stringify(result.at)}`)
})
test('a closed wooden door in the way is a route edge that opens it by hand first; an iron door is a wall (CP28 house)', async () => {
  const { route }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  for (const kind of ['oak_door', 'iron_door']) {
    // Floor x 0..4, wall x = 2 (z -2..2, two high) with a door at (2, 1..2, 0).
    const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
    for (let x = 0; x <= 4; x++) for (let z = -2; z <= 2; z++) cells.push([x, 0, z, 'stone'])
    for (const z of [-2, -1, 1, 2]) for (const y of [1, 2, 3]) cells.push([2, y, z, 'stone'])
    cells.push([2, 3, 0, 'stone'])
    cells.push([2, 1, 0, kind, { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false }], [2, 2, 0, kind, { facing: 'east', half: 'upper', hinge: 'left', open: false, powered: false }])
    const { bot, world } = worldOf(cells)
    const overrides = new Map<string, unknown>()
    const base = world.getBlock.bind(world)
    world.getBlock = (p: Vec3) => { const q = p.floored(); return overrides.get(`${q.x},${q.y},${q.z}`) ?? base(p) }
    bot.blockAt = (p: Vec3) => world.getBlock(p)
    let uses = 0
    bot.lookAt = async () => {}
    bot.activateBlock = async (block: any) => {
      uses++
      if (block.name === 'iron_door') return
      const lower = block.getProperties().half === 'upper' ? block.position.offset(0, -1, 0) : block.position
      for (const p of [lower, lower.offset(0, 1, 0)]) {
        const old = world.getBlock(p); const next = Block.fromProperties(old.name, { ...old.getProperties(), open: true }); next.position = p
        overrides.set(`${p.x},${p.y},${p.z}`, next); bot.emit('blockUpdate', old, next)
      }
    }
    bot.entity.position = new Vec3(.5, 1, .5); bot.entity.velocity.y = -.0784000015258789
    drive(bot, world)
    const edges = await supportRoute(bot, bot.entity.position, new Vec3(4.5, 1, .5), new Set(), 8)
    const result = await route(bot, { aborted: false }, { toward: new Vec3(4.5, 1, .5), maxLandings: 12, timeoutSeconds: 60 })
    if (kind === 'oak_door') {
      assert.ok(edges.some((o: any) => o.door && o.door.x === 2 && o.door.y === 1 && o.door.z === 0), JSON.stringify(edges.map((o: any) => [o.target, o.door])))
      assert.equal(result.ok, true, `${result.why} ${JSON.stringify(result.at)}`)
      assert.equal(uses, 1, 'one hand use on the visible door')
      assert.equal(String(world.getBlock(new Vec3(2, 1, 0)).getProperties().open), 'true')
    } else {
      assert.ok(!edges.some((o: any) => o.door), 'an iron door needs redstone, not a hand')
      assert.equal(result.ok, false)
      assert.equal(uses, 0)
    }
  }
})
