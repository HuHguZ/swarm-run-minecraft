import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const native = require('../src/tick-plugins').getPhysics()
const clockMod = require('../src/game-clock')
const movement = require('../src/movement')
const edges = require('../src/edges')
const pick = require('../src/pick')
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

function scene({ oxygen = 20, blocks = 32, change = null }: any = {}) {
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 0 }))
  const cells = new Map<string, any>()
  const world: any = { getBlock(p: Vec3) {
    const q = p.floored(), key = q.toString()
    if (!cells.has(key)) {
      const pit = q.x >= 0 && q.x <= 2 && q.z >= 0 && q.z <= 2
      let name = q.y <= 0 || !pit && q.y < 3 ? 'stone' : pit && q.y < 3 ? 'water' : 'air'
      if (change) name = change(q, name)
      const block = name == null ? null : Block.fromStateId(registry.blocksByName[name].defaultState)
      if (block) block.position = q
      cells.set(key, block)
    }
    return cells.get(key)
  } }
  world.getColumn = (cx: number, cz: number) => ({ getBlockStateId: p => world.getBlock(new Vec3(cx * 16 + p.x, p.y, cz * 16 + p.z))?.stateId ?? -1 })
  const stack = new Item(registry.itemsByName.cobblestone.id, blocks); stack.slot = 36
  const sword = new Item(registry.itemsByName.iron_sword.id, 1); sword.slot = 37
  const slots = Array(46).fill(null); slots[36] = stack; slots[37] = sword
  let controls = { ...IDLE }, stopped = false
  const activeControls: string[] = [], positions: Vec3[] = [], placements: Vec3[] = []
  const ctl: any = { aborted: false, onAbort: [] }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { dimension: 'overworld', minY: -64, height: 384 },
    inventory: { slots, items: () => [stack, sword].filter(i => i.count > 0) }, heldItem: sword,
    health: 20, food: 20, oxygenLevel: oxygen, entities: {},
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: true, isInLava: false, isInWeb: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: .6 },
    world, blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world), pathfinder: { setGoal() {} },
    equip: async item => { bot.heldItem = item },
    setControlState(key: keyof typeof IDLE, value: boolean) { controls[key] = value; if (value) activeControls.push(key) },
    getControlState: (key: keyof typeof IDLE) => controls[key], clearControlStates: () => { controls = { ...IDLE } },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async (p: Vec3) => {
      const d = p.minus(pick.eyeOf(bot))
      bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    },
    _genericPlace: async (ref, face) => { placements.push(ref.position.plus(face)); throw new Error('swim should not place') }
  })
  require('../src/swimming').install(bot)
  const run = async (fn: () => Promise<any>, afterTick?: (tick: number) => void) => {
    let settled = false, result: any, error: any
    fn().then(v => { result = v; settled = true }, e => { error = e; settled = true })
    for (let tick = 0; tick < 500 && !settled; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (settled) break
      const state = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      positions.push(bot.entity.position.clone()); bot.emit('physicsTick')
      // Own breath feedback after the real body reaches air; physics alone does not simulate air_supply.
      if (world.getBlock(pick.eyeOf(bot))?.name === 'air') bot.oxygenLevel = Math.min(20, bot.oxygenLevel + 1)
      clock.advanceTicks(1); afterTick?.(tick)
    }
    assert.ok(settled, 'bounded skill completed within 25 seconds of actual physics')
    if (error) throw error
    return result
  }
  return { bot, ctl, clock, run, positions, placements, stack, activeControls, controls: () => controls,
    close() { if (!stopped) { stopped = true; clock.dispose() } } }
}

test('existing swim controller can leave the two-layer native-physics pit without placing', async () => {
  const s = scene()
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000 }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(s.bot.entity.position.y, 3)
    assert.equal(s.bot.entity.onGround, true)
    assert.deepEqual(s.placements, [])
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.close() }
})

for (const blocks of [32, 0]) test(`climbBack reuses swimming to reach the rim with ${blocks} filler blocks`, async () => {
  const s = scene({ blocks })
  const target = { id: 2, type: 'player', _ndVisible: true, position: new Vec3(10, 3, .5), equipment: [] }
  try {
    const r = await s.run(() => edges.climbBack(s.bot, s.ctl, target, { floorY: 3, maxMs: 8000 }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.placed, 0, 'swimming height is not a block-placement receipt')
    assert.equal(s.stack.count, blocks)
    assert.equal(s.bot.entity.position.y, 3)
    assert.equal(s.bot.entity.onGround, true)
    assert.deepEqual(s.placements, [])
  } finally { s.close() }
})

test('swim cancel arriving during look cannot send movement controls', async () => {
  const s = scene()
  s.bot.lookAt = async () => { s.ctl.aborted = true }
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000 }))
    assert.equal(r.ok, false)
    assert.deepEqual(s.activeControls, [])
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.close() }
})

test('climbBack keeps the caller risk cancellation live while swimming', async () => {
  const s = scene()
  let danger = false
  const guarded = { get aborted() { return danger }, onAbort: [] }
  const target = { position: new Vec3(10, 3, .5), equipment: [] }
  try {
    const r = await s.run(() => edges.climbBack(s.bot, guarded, target, { floorY: 3, maxMs: 8000 }), tick => {
      if (tick === 3) danger = true
    })
    assert.equal(r.ok, false)
    assert.match(r.why, /прерван/)
    assert.ok(s.clock.now() <= 400)
    assert.ok(s.activeControls.length > 0, 'risk changed after swimming had started')
    assert.deepEqual(s.controls(), IDLE)
    assert.deepEqual(s.placements, [])
  } finally { s.close() }
})

test('an exhausted swim budget cannot start the remaining shaft approach', async () => {
  const s = scene()
  const goals: any[] = []
  s.bot.pathfinder.setGoal = goal => { if (goal) goals.push(goal) }
  const target = { position: new Vec3(10, 3, .5), equipment: [] }
  try {
    const r = await s.run(() => edges.climbBack(s.bot, s.ctl, target, { floorY: 3, maxMs: 600 }))
    assert.equal(s.bot.blockAt(pick.eyeOf(s.bot))?.name, 'air', 'the expired swim reached breathable air')
    assert.equal(r.ok, false)
    assert.ok(s.clock.now() <= 650)
    assert.deepEqual(goals, [])
    assert.deepEqual(s.placements, [])
    assert.match(r.why, /время/)
  } finally { s.close() }
})

test('unavailable observed geometry is unknown and cannot claim a breathing pocket', async () => {
  const s = scene({ change: (q, name) => q.y === 2 ? null : name })
  delete s.bot.world
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }), null)
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    assert.equal(r.ok, false)
    assert.equal(r.breathing, false)
    assert.deepEqual(s.activeControls, [])
  } finally { s.close() }
})

test('shaft fallback after surfacing only receives the remaining climb budget', async () => {
  const s = scene({ change: (q, name) => (q.x < 0 || q.x > 2 || q.z < 0 || q.z > 2) && q.y < 6 ? 'stone' : name })
  const goals: any[] = []
  s.bot.pathfinder.setGoal = goal => { if (goal) goals.push(goal) }
  const target = { position: new Vec3(10, 6, .5), equipment: [] }
  try {
    const r = await s.run(() => edges.climbBack(s.bot, s.ctl, target, { floorY: 6, maxMs: 1000, exclude: new Set(['0,0']) }))
    assert.equal(r.ok, false)
    assert.ok(goals.length > 0, 'surface pocket resumed the existing shaft approach: ' + JSON.stringify(r))
    assert.ok(s.clock.now() <= 1100, `bounded approach ended at ${s.clock.now()}`)
    assert.deepEqual(s.placements, [])
  } finally { s.close() }
})

test('one final noPath receipt ends an unreachable shaft approach without waiting twenty seconds', async () => {
  const s = scene({ change: (_q, name) => name === 'water' ? 'air' : name })
  s.bot.entity.isInWater = false
  let noPaths = 0
  s.bot.pathfinder.setGoal = goal => {
    if (goal) clockMod.setTimeout(() => { noPaths++; s.bot.emit('path_update', { status: 'noPath', path: [] }) }, 50)
  }
  const target = { position: new Vec3(10, 3, .5), equipment: [] }
  try {
    const r = await s.run(() => edges.climbBack(s.bot, s.ctl, target, { floorY: 3, maxMs: 25000, exclude: new Set(['0,0']) }))
    assert.equal(noPaths, 1, 'pathfinder emits one final result; it does not promise a second failure')
    assert.equal(r.ok, false)
    assert.match(r.why, /не дошёл/)
    assert.ok(s.clock.now() <= 200, `unreachable approach took ${s.clock.now()} ms`)
    assert.deepEqual(s.placements, [])
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.close() }
})

test('low own breath takes the nearer air before continuing to a visible shore', async () => {
  const s = scene({ oxygen: 2 })
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }).kind, 'air')
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    const breathed = s.positions.findIndex(p => s.bot.blockAt(p.offset(0, 1.62, 0))?.name === 'air')
    // Own oxygenLevel=2 corresponds to about 30 native ticks of air_supply (gamedata.fixBreath).
    assert.ok(breathed >= 0 && breathed < 30, `first breath at tick ${breathed}`)
    assert.equal(r.ok, true)
    assert.equal(s.bot.entity.onGround, true)
    assert.equal(s.stack.count, 32)
  } finally { s.close() }
})

test('breathing in a water pocket is not a dry-shore arrival', async () => {
  const s = scene({ change: (q, name) => (q.x < 0 || q.x > 2 || q.z < 0 || q.z > 2) && q.y < 6 ? 'stone' : name })
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    assert.equal(r.ok, false)
    assert.equal(r.breathing, true)
    assert.ok(s.bot.entity.position.y < 3)
    assert.ok(s.clock.now() < 8000, 'air pocket is reported without waiting out the whole skill budget')
    assert.deepEqual(s.placements, [])
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.close() }
})

test('hidden shore changes cannot create a visible route around an opaque bend', () => {
  for (const open of [true, false]) {
    const s = scene({ change: q => {
      const corridor = q.z === 0 && q.x >= 0 && q.x <= 3 || q.x === 3 && q.z >= 0 && q.z <= 3
      if (corridor && q.y >= 1 && q.y <= 2) return 'water'
      if (open && (q.x === 3 || q.x === 4) && q.z === 3 && q.y >= 3 && q.y <= 4) return 'air'
      return 'stone'
    } })
    try {
      assert.equal(require('../src/perception/eyes').seesNow(s.bot, new Vec3(3, 3, 3)), false)
      assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }), null)
      assert.equal(movement.findSwimRoute(s.bot)?.kind ?? null, open ? 'land' : null,
        'raw world controls differ, so the hidden edit is causally relevant to an oracle search')
    } finally { s.close() }
  }
})

for (const cap of ['stone', 'lava', null]) test(`known swim planning does not cross ${cap ?? 'unknown'} headroom`, async () => {
  const s = scene({ change: (q, name) => q.y >= 3 ? cap : name })
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }), null)
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    assert.equal(r.ok, false)
    assert.equal(r.breathing, false)
    assert.deepEqual(s.activeControls, [])
    assert.deepEqual(s.placements, [])
  } finally { s.close() }
})
