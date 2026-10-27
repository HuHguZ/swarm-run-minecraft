import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'
import { worldOf, drive } from './parkour-fixture'

test('clear_web walks off an overlapping corner before a twenty-second hand cut', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -1; x <= 2; x++) for (let z = -1; z <= 2; z++) cells.push([x, 0, z, 'stone'])
  cells.push([1, 1, 0, 'cobweb'])
  const { bot, world } = worldOf(cells)
  bot.entity.position = new Vec3(.7871815407606, 1, 1.1275060248888)
  bot.entity.velocity.y = -.0784000015258789
  bot.entity.isInWeb = true
  bot.entities = {}; bot.players = {}
  let cuts = 0
  bot.lookAt = async () => {}
  bot.stopDigging = () => {}
  bot.pathfinder = { setGoal() {} }
  bot.dig = async () => { cuts++; bot.blockAt = p => {
    const b = world.getBlock(p)
    return b.name === 'cobweb' ? world.getBlock(new Vec3(9, 1, 9)) : b
  } }
  drive(bot, world)
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const session = { require: () => bot, runIntent: async (_name, work) => ({ detail: await work(ctl) }) }
  const clock = { sleep: async () => {}, now: () => 0, setInterval: () => 1, clearInterval() {} }
  const result = await require('../src/rpc/hazards').hazardMethods({ session, gameClock: clock }).clear_web({})
  assert.equal(result.detail.how, 'walk', 'the actual hazard handler must choose the cheaper native movement')
  assert.equal(result.detail.ok, true)
  assert.equal(cuts, 0)
  assert.equal(world.getBlock(new Vec3(1, 1, 0)).name, 'cobweb')
  assert.equal(require('../src/hazards').webCells(bot).length, 0)
  assert.equal(bot.health, 20)
  assert.equal(bot.entity.position.y, 1)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(ctl.onAbort.length, 0)
})

test('web centering keeps native ground, visibility, cancellation and price guards', async () => {
  const { webExitPlan } = require('../src/navigation/web-exit')
  const cases = [
    ['hidden floor', bot => { bot.canSeeBlock = () => false }],
    ['unknown floor', bot => { const read = bot.blockAt; bot.blockAt = p => p.y < 1 ? null : read(p) }],
    ['airborne', bot => { bot.entity.onGround = false }],
    ['blocked centre', bot => { bot.entity.position = new Vec3(1.5, 1, .5) }]
  ] as const
  for (const [name, change] of cases) {
    const cells: Array<[number, number, number, string]> = []
    for (let x = -1; x <= 2; x++) for (let z = -1; z <= 2; z++) cells.push([x, 0, z, 'stone'])
    cells.push([1, 1, 0, 'cobweb'])
    const { bot } = worldOf(cells)
    bot.entity.position = new Vec3(.7871815407606, 1, 1.1275060248888)
    bot.entity.isInWeb = true
    change(bot)
    assert.equal(await webExitPlan(bot, { aborted: false }, 20000), null, name)
  }
  const { bot } = worldOf([[0, 0, 1, 'stone'], [1, 1, 0, 'cobweb']])
  bot.entity.position = new Vec3(.7871815407606, 1, 1.1275060248888)
  bot.entity.velocity.y = -.0784000015258789
  bot.entity.isInWeb = true
  assert.equal(await webExitPlan(bot, { aborted: true }, 20000), null)
  assert.equal(await webExitPlan(bot, { aborted: false }, 100), null, 'a faster cutter keeps its turn')
  const plan = await webExitPlan(bot, { aborted: false }, 20000)
  assert.ok(plan)
  assert.ok(plan.states.every(state => state.onGround && state.pos.y === 1))
  assert.ok(plan.steps.every(step => !step.control.jump))
  assert.ok(plan.ticks * 50 < 20000)
})

test('centering cannot escape a web over void or across hazardous ground', async () => {
  const { webExitPlan } = require('../src/navigation/web-exit')
  for (const material of ['air', 'lava', 'magma_block']) {
    const cells: Array<[number, number, number, string]> = [[1, 1, 0, 'cobweb']]
    for (let x = -1; x <= 2; x++) for (let z = -1; z <= 2; z++) cells.push([x, 0, z, material])
    const { bot } = worldOf(cells)
    bot.entity.position = new Vec3(.7871815407606, 1, 1.1275060248888)
    bot.entity.isInWeb = true
    assert.equal(await webExitPlan(bot, { aborted: false }, 20000), null, material)
  }
})

test('an asynchronous web forecast cannot press keys after body, terrain or cancellation changes', async () => {
  const search = require('../src/navigation/parkour/search'), original = search.planJumpAsync
  const { webExitPlan } = require('../src/navigation/web-exit')
  try {
    for (const name of ['position', 'velocity', 'health', 'attributes', 'terrain', 'abort']) {
      const { bot, world } = worldOf([[0, 0, 1, 'stone'], [1, 1, 0, 'cobweb']])
      bot.entity.position = new Vec3(.7871815407606, 1, 1.1275060248888)
      bot.entity.velocity.y = -.0784000015258789
      bot.entity.isInWeb = true
      const ctl = { aborted: false }
      search.planJumpAsync = async (...args) => {
        const plan = await original(...args)
        assert.ok(plan, 'the pre-change native trajectory exists')
        if (name === 'position') bot.entity.position.x += .5
        if (name === 'velocity') bot.entity.velocity.x = .4
        if (name === 'health') bot.health--
        if (name === 'attributes') bot.entity.attributes['minecraft:movement_speed'] = { value: .3 }
        if (name === 'terrain') bot.blockAt = p => p.y === 0 ? world.getBlock(new Vec3(9, 1, 9)) : world.getBlock(p)
        if (name === 'abort') ctl.aborted = true
        return plan
      }
      assert.equal(await webExitPlan(bot, ctl, 20000), null, name)
    }
  } finally { search.planJumpAsync = original }
})

async function clearCenteredWeb(guard = '') {
  const cells: Array<[number, number, number, string]> = [[0, 1, 0, 'cobweb'], [0, 0, 0, 'stone']]
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (!x && !z) continue
    if (guard !== 'void') cells.push([x, 0, z, 'stone'])
    if (guard === 'wall') cells.push([x, 1, z, 'stone'], [x, 2, z, 'stone'])
  }
  const { bot, world } = worldOf(cells), start = bot.entity.position.clone()
  bot.entity.velocity.y = -.0784000015258789
  bot.entity.isInWeb = true
  bot.entities = {}; bot.players = {}
  if (guard === 'hidden') bot.canSeeBlock = () => false
  if (guard === 'cut-cheaper') bot.inventory.items = () => [{ name: 'shears', type: bot.registry.itemsByName.shears.id, count: 1, enchants: [] }]
  const cutMs = require('../src/tools').bestFor(bot, bot.blockAt(new Vec3(0, 1, 0))).ms
  let cuts = 0, removed = false, jumped = false
  bot.lookAt = async () => {}
  bot.stopDigging = () => {}
  bot.pathfinder = { setGoal() {} }
  bot.blockAt = p => {
    const block = world.getBlock(p)
    return removed && block.name === 'cobweb' ? world.getBlock(new Vec3(9, 1, 9)) : block
  }
  // Only the external block-removal receipt is faked; movement/planning use real 1.21.11 native physics.
  bot.dig = async () => { cuts++; removed = true }
  drive(bot, world)
  const set = bot.setControlState
  bot.setControlState = (key, value) => { if (key === 'jump' && value) jumped = true; set(key, value) }
  const samples: Array<{ y: number; onGround: boolean }> = []
  const sample = () => samples.push({ y: bot.entity.position.y, onGround: bot.entity.onGround })
  bot.on('physicsTick', sample)
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const session = { require: () => bot, runIntent: async (_name, work) => ({ detail: await work(ctl) }) }
  const clock = { sleep: async () => {}, now: () => 0, setInterval: () => 1, clearInterval() {} }
  let result
  try { result = await require('../src/rpc/hazards').hazardMethods({ session, gameClock: clock }).clear_web({}) }
  finally { bot.removeListener('physicsTick', sample) }
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(ctl.onAbort.length, 0)
  return { bot, world, start, result: result.detail, cuts, cutMs, jumped, samples }
}

test('clear_web walks from the centre of a body web onto visible adjacent floor before a barehand cut', async () => {
  const { bot, world, start, result, cuts, cutMs, jumped, samples } = await clearCenteredWeb()
  assert.equal(cutMs, 20000, 'the alternative is a real native barehand cobweb cut')
  assert.equal(result.how, 'walk', 'a centred web needs a reachable adjacent target, not the occupied cell centre')
  assert.equal(result.ok, true)
  assert.equal(cuts, 0)
  assert.equal(world.getBlock(new Vec3(0, 1, 0)).name, 'cobweb', 'walking must leave the original web intact')
  assert.equal(require('../src/hazards').webCells(bot).length, 0)
  assert.ok(bot.entity.position.distanceTo(start) > .7, 'the body must actually leave its web')
  assert.ok(samples.length > 0 && samples.every(state => state.onGround && state.y === 1))
  assert.equal(jumped, false)
  assert.equal(bot.health, 20)
  assert.ok(result.ticks * 50 < cutMs)
})

test('centred web walking keeps adjacent void, hidden floor, walls and a cheaper cutter out of the route', async () => {
  for (const guard of ['void', 'hidden', 'wall', 'cut-cheaper']) {
    const { bot, start, result, cuts, cutMs, samples } = await clearCenteredWeb(guard)
    assert.equal(result.how, 'cut', guard)
    assert.equal(result.ok, true, guard)
    assert.equal(cuts, 1, guard)
    assert.ok(bot.entity.position.equals(start), guard)
    assert.equal(samples.length, 0, guard)
    assert.equal(bot.health, 20, guard)
    if (guard === 'cut-cheaper') assert.ok(cutMs < 1000, 'real shears keep the cheaper turn')
  }
})

test('web-exit trace is silent when off and records one actual completed walk when on', async () => {
  const original = console.log, previous = process.env.ND_SWARM_TRACE, logs: unknown[][] = []
  console.log = (...args) => { if (args[0] === '[web-exit]') logs.push(args); else original(...args) }
  try {
    process.env.ND_SWARM_TRACE = '0'
    const quiet = await clearCenteredWeb()
    assert.equal(quiet.result.how, 'walk')
    assert.equal(quiet.result.ok, true)
    assert.equal(logs.length, 0)
    process.env.ND_SWARM_TRACE = '1'
    const traced = await clearCenteredWeb()
    assert.equal(traced.result.how, 'walk')
    assert.equal(traced.result.ok, true)
    assert.equal(logs.length, 1, 'one receipt belongs to one actual executePlan return')
    const receipt = JSON.parse(String(logs[0][1])), at = traced.bot.entity.position
    assert.deepEqual({ ok: receipt.ok, left: receipt.left, ticks: receipt.ticks, at: receipt.at },
      { ok: true, left: 0, ticks: traced.result.ticks, at: { x: at.x, y: at.y, z: at.z } })
    assert.ok(receipt.ticks > 0)
    const target = new Vec3(receipt.target.x, receipt.target.y, receipt.target.z)
    assert.ok(at.distanceTo(target) < .12 && target.distanceTo(traced.start) > .7, 'logged target must match the actual adjacent landing')
  } finally {
    console.log = original
    if (previous === undefined) delete process.env.ND_SWARM_TRACE
    else process.env.ND_SWARM_TRACE = previous
  }
})

test('adjacent web candidates share one native frame budget and never press controls while planning', async () => {
  const search = require('../src/navigation/parkour/search'), original = search.planJumpAsync
  const { ROUTE_FRAMES } = require('../src/navigation/parkour/model')
  const cells: Array<[number, number, number, string]> = [[0, 1, 0, 'cobweb']]
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cells.push([x, 0, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.isInWeb = true
  let calls = 0, controls = 0
  bot.setControlState = () => { controls++ }
  search.planJumpAsync = async (_bot, _ctl, _target, options) => {
    calls++
    ;(options.diagnostics ??= { frames: 0, profiles: 0 }).frames = ROUTE_FRAMES
    return null
  }
  try {
    assert.equal(await require('../src/navigation/web-exit').webExitPlan(bot, { aborted: false }, 20000), null)
    assert.equal(calls, 1, 'exhausted first candidate must not start eight more native searches')
    assert.equal(controls, 0)
  } finally { search.planJumpAsync = original }
})
