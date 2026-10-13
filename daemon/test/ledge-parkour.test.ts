import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

function source(withRim = true) {
  const file = path.resolve(__dirname, '../src/navigation/parkour.ts'), module = { exports: {} as any }
  const input = readFileSync(file, 'utf8').replace(withRim ? /$^/ : /  const ledge = yield\* ledgeSearch\(bot, target, opts, world\)\r?\n  if \(ledge\) return ledge\r?\n/, '')
  const code = require('esbuild').transformSync(input, { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports, createRequire(file), module, file, path.dirname(file))
  return module.exports
}

function scene({ blocked = false, corner = false, drop = 4, hp = 20 } = {}) {
  const cells = new Map<string, string>()
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) cells.set(`${x},20,${z}`, 'stone')
  // A one-block exterior shelf underneath the roof lip, with the rest open to the abyss.
  const target = new Vec3(3.5, 21 - drop, corner ? 1.5 : 2.5)
  cells.set(`3,${target.y - 1},${Math.floor(target.z)}`, 'stone')
  if (corner) for (let y = 21; y < 24; y++) cells.set(`3,${y},1`, 'stone')
  if (blocked) cells.set(`3,${target.y},${Math.floor(target.z)}`, 'stone')
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384, dimension: 'overworld' },
    health: hp, food: 20, entities: {}, inventory: { slots: [], items: () => [] },
    entity: { id: 1, name: 'player', position: new Vec3(2.5, 21, 2.5), velocity: new Vec3(0, -.0784000015258789, 0),
      onGround: true, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: .6 },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  return { bot, world, target, cells }
}

test('a native walk-off goes beyond a roof rim and returns onto a one-block shelf below the overhang', () => {
  const p = source(), s = scene(), before = s.bot.entity.position.clone()
  assert.equal(source(false).planJump(s.bot, s.target, { allowWalk: true, maxTicks: 60, maxFallDamage: 1 }), null, 'the former direct/beam controller cannot make this descent')
  const plan = p.planJump(s.bot, s.target, { allowWalk: true, maxTicks: 60, maxFrames: 12000, maxFallDamage: 1 })
  assert.ok(plan, 'directly aiming at the shelf stops on its roof; the generic planner must include a rim launch')
  assert.ok(plan.states.some(st => !st.onGround && st.pos.x > 4.3))
  assert.ok(plan.steps.every(step => !step.control.jump), 'the accepted one-HP walk-off cannot add jump height')
  const end = p.simulatePlan(s.bot, plan.steps)
  assert.ok(p.settledLanding(s.bot, end, s.target, .22))
  assert.deepEqual(s.bot.entity.position, before)
})

test('a blocked shelf and an insufficient fall-damage budget cannot authorize leaving the roof', () => {
  const p = source(), blocked = scene({ blocked: true }), harmful = scene({ drop: 5 })
  assert.equal(p.planJump(blocked.bot, blocked.target, { allowWalk: true, maxTicks: 60, maxFrames: 12000 }), null)
  assert.equal(p.planJump(harmful.bot, harmful.target, { allowWalk: true, maxTicks: 60, maxFrames: 12000, maxFallDamage: 0 }), null)
})

test('a roof-rim obstacle needs a sideways airborne return around its corner', () => {
  const p = source(), s = scene({ corner: true })
  const plan = p.planJump(s.bot, s.target, { allowWalk: true, maxTicks: 60, maxFrames: 16000, maxFallDamage: 1 })
  assert.ok(plan)
  const air = plan.states.filter(st => !st.onGround)
  assert.ok(air.some(st => st.pos.x > 4.3))
  assert.ok(Math.max(...air.map(st => st.pos.z)) - Math.min(...air.map(st => st.pos.z)) > .2)
  assert.ok(p.settledLanding(s.bot, p.simulatePlan(s.bot, plan.steps), s.target, .22))
})

test('a three-block underlip descent uses the real crouching body instead of a globally smaller player', () => {
  const p = source()
  for (const corner of [false, true]) {
    const s = scene({ drop: 3, corner })
    const plan = p.planJump(s.bot, s.target, { allowWalk: true, maxTicks: 80, maxFallDamage: 0 })
    assert.ok(plan, 'standing misses the narrow native clearance window; crouching must be an explicit input variant')
    assert.ok(plan.states.some(st => !st.onGround && st.ndPoseHeight === 1.5 && st.control.sneak))
    assert.equal(s.bot.physics.playerHeight, 1.8)
    assert.ok(p.settledLanding(s.bot, p.simulatePlan(s.bot, plan.steps), s.target, .22))
  }
})

test('crouching collision dimensions belong to each native state and stay crouched while standing is blocked', () => {
  const p = source(), s = scene()
  const slab = Block.fromProperties('stone_slab', { type: 'top', waterlogged: false }); slab.position = new Vec3(3, 22, 2)
  const original = s.world.getBlock
  s.world.getBlock = pos => pos.floored().equals(slab.position) ? slab : original(pos)
  const standing = new native.PlayerState(s.bot, { ...p.IDLE, forward: true })
  const crouched = new native.PlayerState(s.bot, { ...p.IDLE, forward: true, sneak: true })
  for (let i = 0; i < 50; i++) { s.bot.physics.simulatePlayer(standing, s.world); s.bot.physics.simulatePlayer(crouched, s.world) }
  assert.ok(standing.pos.x <= 2.7 && crouched.pos.x > 3.3)
  assert.equal(standing.ndPoseHeight, 1.8); assert.equal(crouched.ndPoseHeight, 1.5); assert.equal(s.bot.physics.playerHeight, 1.8)
  crouched.control.forward = false; crouched.control.sneak = false
  s.bot.physics.simulatePlayer(crouched, s.world)
  assert.equal(crouched.ndPoseHeight, 1.5, 'releasing the key cannot force the body into the ceiling')
})

test('the whole body trajectory must stay inside the arena, including the air outside the rim', () => {
  const p = source(), s = scene(), arena = { x: 2, z: 2, r: 3.3, killY: 16 }
  assert.ok(p.withinArena(s.bot, s.bot.entity.position, arena) && p.withinArena(s.bot, s.target, arena))
  assert.equal(p.planJump(s.bot, s.target, { allowWalk: true, maxTicks: 60, maxFallDamage: 1, arena }), null)
  const roomy = { ...arena, r: 4 }
  const plan = p.planJump(s.bot, s.target, { allowWalk: true, maxTicks: 60, maxFallDamage: 1, arena: roomy })
  assert.ok(plan && plan.states.every(st => p.withinArena(s.bot, st.pos, roomy)))
  assert.equal(p.planJump(s.bot, s.target, { allowWalk: true, maxFallDamage: 1, arena: { ...roomy, killY: s.target.y } }), null)
})

function drive(bot: any, world: any, p: any, afterTick?: (tick: number) => void, receipts = true) {
  let control = { ...p.IDLE }, fallen = 0
  bot._client = new EventEmitter()
  bot.setControlState = (key, value) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...p.IDLE } }
  bot.look = async yaw => { bot.entity.yaw = yaw }
  bot.waitForTicks = async ticks => {
    for (let tick = 0; tick < ticks; tick++) {
      const before = bot.entity.position.clone(), state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      fallen += Math.max(0, before.y - state.pos.y)
      bot.emit('physicsTick')
      if (state.onGround && fallen > 3 && receipts) {
        bot.health -= Math.ceil(fallen - 3)
        bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 10, sourceCauseId: 0, sourceDirectId: 0 })
        bot.emit('health')
      }
      if (state.onGround) fallen = 0
      afterTick?.(tick + 1)
      if (!bot.listenerCount('physicsTick')) break
    }
  }
}

test('ledge_to executes the same per-tick native inputs and confirms a real typed fall receipt on the shelf', async () => {
  const p = source(), s = scene({ corner: true }), ctl = { aborted: false, onAbort: [] }
  drive(s.bot, s.world, p)
  const result = await p.ledgeTo({ require: () => s.bot }, ctl, { at: s.target, maxFallDamage: 1, arena: { x: 2, z: 2, r: 4, killY: 16 } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.landed, true); assert.equal(s.bot.health, 19)
  assert.ok(result.samples.length > 20)
  for (const sample of result.samples) assert.ok(Math.hypot(sample.pos.x - sample.expected.pos.x, sample.pos.y - sample.expected.pos.y, sample.pos.z - sample.expected.pos.z) < 1e-8)
  assert.ok(p.settledLanding(s.bot, { pos: s.bot.entity.position, vel: s.bot.entity.velocity, onGround: s.bot.entity.onGround }, s.target, .25))
  assert.equal(s.bot.listenerCount('physicsTick'), 0); assert.equal(s.bot._client.listenerCount('damage_event'), 0); assert.equal(ctl.onAbort.length, 0)
})

test('missing fall receipt cannot ACK a visually settled ledge landing', async () => {
  const p = source(), s = scene(), ctl = { aborted: false, onAbort: [] }
  drive(s.bot, s.world, p, undefined, false)
  const result = await p.ledgeTo({ require: () => s.bot }, ctl, { at: s.target, maxFallDamage: 1 })
  assert.equal(result.ok, false); assert.equal(result.why, 'fall_damage_not_confirmed')
})

test('an already accepted fall receipt remains bound to the actual shelf during small native stopping drift', async () => {
  const p = source(), s = scene({ corner: true }), ctl = { aborted: false, onAbort: [] }
  let changed = false
  drive(s.bot, s.world, p, () => {
    if (!changed && s.bot.health === 19) {
      changed = true; s.bot.entity.velocity.x += .02; s.bot.entity.velocity.z += .07
    }
  })
  const result = await p.ledgeTo({ require: () => s.bot }, ctl, { at: s.target, maxFallDamage: 1 })
  assert.ok(changed); assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.samples.some(sample => sample.hp === 19 && Math.hypot(sample.pos.x - sample.expected.pos.x, sample.pos.z - sample.expected.pos.z) > .1))
  assert.equal(s.bot.health, 19)
})

test('interruption releases owned controls and a low-HP body never leaves the roof', async () => {
  const p = source(), s = scene(), ctl = { aborted: false, onAbort: [] as Array<() => void> }
  drive(s.bot, s.world, p, tick => { if (tick === 3) { ctl.aborted = true; for (const cb of [...ctl.onAbort]) cb() } })
  const result = await p.ledgeTo({ require: () => s.bot }, ctl, { at: s.target, maxFallDamage: 1 })
  assert.equal(result.why, 'interrupted'); assert.equal(result.ticks, 3)
  assert.equal(s.bot._ndParkourForecast, undefined); assert.equal(ctl.onAbort.length, 0)
  const weak = scene({ hp: 12 }), before = weak.bot.entity.position.clone()
  drive(weak.bot, weak.world, p)
  const refused = await p.ledgeTo({ require: () => weak.bot }, { aborted: false, onAbort: [] }, { at: weak.target, maxFallDamage: 1 })
  assert.equal(refused.ok, false); assert.equal(refused.ticks, 0); assert.deepEqual(weak.bot.entity.position, before)
})

test('invalid target coordinates are refused before changing movement controls', async () => {
  const p = source(), s = scene()
  const result = await p.ledgeTo({ require: () => s.bot }, { aborted: false }, { at: { x: NaN, y: 17, z: 2.5 } })
  assert.equal(result.why, 'invalid_ledge_request')
})

test('an arena forecast rechecks actual velocity before applying the next input', async () => {
  const p = source(), s = scene(), arena = { x: 2, z: 2, r: 4, killY: 16 }
  const plan = p.planJump(s.bot, s.target, { allowWalk: true, maxFallDamage: 1, arena })
  assert.ok(plan)
  drive(s.bot, s.world, p)
  s.bot.entity.velocity.x = 4 // an observed external knockback after planning
  const before = s.bot.entity.position.clone()
  const result = await p.executePlan(s.bot, { aborted: false, onAbort: [] }, { ...plan, arena }, () => false)
  assert.equal(result.why, 'outside_arena'); assert.equal(result.ticks, 0)
  assert.deepEqual(s.bot.entity.position, before)
})

test('the local game deadline interrupts a descent and removes its timer and listeners', async () => {
  const clock = require('../src/game-clock'), manual = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(manual)
  try {
    const p = source(), s = scene(), ctl = { aborted: false, onAbort: [] }
    drive(s.bot, s.world, p, () => manual.advanceTicks(1))
    const result = await p.ledgeTo({ require: () => s.bot }, ctl, { at: s.target, maxFallDamage: 1, timeoutSeconds: .5 })
    assert.equal(result.ok, false); assert.equal(result.why, 'timeout'); assert.equal(result.ticks, 10)
    assert.equal(s.bot.listenerCount('physicsTick'), 0); assert.equal(ctl.onAbort.length, 0); assert.equal(manual.timers.size, 0)
  } finally { manual.dispose(); clock.activate(null) }
})
