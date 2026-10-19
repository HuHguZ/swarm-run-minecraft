import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
import * as clockMod from '../src/game-clock'
import movement = require('../src/movement')
import edges = require('../src/edges')
import pick = require('../src/pick')
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

async function rescueEnabled(run: () => any) {
  const previous = process.env.ND_WATER_RESCUE
  process.env.ND_WATER_RESCUE = '1'
  try { return await run() } finally {
    if (previous === undefined) delete process.env.ND_WATER_RESCUE; else process.env.ND_WATER_RESCUE = previous
  }
}

function scene({ oxygen = 20, blocks = 32, change = null, placement = false }: any = {}) {
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
    _genericPlace: async (ref, face) => {
      const cell = ref.position.plus(face); placements.push(cell)
      if (!placement) throw new Error('swim should not place')
      assert.ok(bot.entity.position.y >= cell.y + 1 - 1e-7, 'server placement must not intersect the real player box')
      assert.ok(pick.faceAim(bot, ref.position, face), 'the real eye ray sees the reference face')
      const block = Block.fromStateId(registry.blocksByName.cobblestone.defaultState); block.position = cell
      const prev = world.getBlock(cell); cells.set(cell.toString(), block); stack.count--
      bot.emit('blockUpdate', prev, block)
    }
  })
  ;(require('../src/swimming') as typeof import('../src/swimming')).install(bot)
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
  return { bot, ctl, clock, run, positions, placements, stack, activeControls, cells, controls: () => controls,
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

test('A6 waterlogged recognition stays enabled with rescue off; both switches can be disabled', t => {
  const keys = ['ND_WATER_ESCAPE_BUDGET', 'ND_WATER_RESCUE'] as const
  const before = keys.map(key => process.env[key])
  t.after(() => keys.forEach((key, i) => {
    if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]
  }))
  const lichen = Block.fromProperties(registry.blocksByName.glow_lichen.id,
    { ...Block.fromStateId(registry.blocksByName.glow_lichen.defaultState).getProperties(), north: true, waterlogged: true }, 0)
  for (const budget of [undefined, '0', '1']) for (const rescue of [undefined, '0', '1']) {
    if (budget === undefined) delete process.env.ND_WATER_ESCAPE_BUDGET; else process.env.ND_WATER_ESCAPE_BUDGET = budget
    if (rescue === undefined) delete process.env.ND_WATER_RESCUE; else process.env.ND_WATER_RESCUE = rescue
    assert.equal(movement.waterCell(lichen), budget !== '0' || rescue === '1', `${budget}/${rescue}`)
  }
})

test('a stale dry physics flag cannot hide water at the real eye position', () => rescueEnabled(() => {
  const s = scene({ oxygen: 2, change: q => q.y < 1 ? 'stone' : q.y === 2 ? 'water' : 'air' })
  s.bot.entity.isInWater = false
  try { assert.equal(movement.inWater(s.bot), true) } finally { s.close() }
}))

test('a one-cell flooded shaft deeper than the visible air search with glow lichen is swum up without plugging source water', () => rescueEnabled(async () => {
  const s = scene({ oxygen: 8, change: q => {
    if (q.y <= 0 || q.x !== 0 || q.z !== 0) return 'stone'
    return q.y <= 20 ? 'water' : 'air'
  } })
  const lichen = Block.fromProperties(registry.blocksByName.glow_lichen.id,
    { ...Block.fromStateId(registry.blocksByName.glow_lichen.defaultState).getProperties(), north: true, waterlogged: true }, 0)
  lichen.position = new Vec3(0, 2, 0); s.cells.set(lichen.position.toString(), lichen)
  s.bot.placeBlock = async (ref, face) => { s.placements.push(ref.position.plus(face)) }
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    assert.ok(r.breathing || r.ok, JSON.stringify({ r, p: s.bot.entity.position }))
    assert.ok(s.bot.entity.position.y > 19.3, 'the body physically rose through the shaft')
    assert.deepEqual(s.placements, [], 'sealing over source water would leave the source cells submerged')
  } finally { s.close() }
}))

test('bubble column at the eyes is a breathing destination, while waterlogged blocks are not', () => rescueEnabled(async () => {
  for (const drag of [false, true]) {
    const s = scene({ oxygen: 2, change: q => q.y <= 0 || q.x !== 0 || q.z !== 0 || q.y > 3 ? 'stone' : 'water' })
    const bubble = Block.fromProperties(registry.blocksByName.bubble_column.id, { drag }, 0)
    bubble.position = new Vec3(0, 2, 0); s.cells.set(bubble.position.toString(), bubble)
    try {
      const route = movement.findSwimRoute(s.bot, { visibleOnly: true })
      assert.equal(route?.kind, 'air', 'jar LivingEntity excludes BUBBLE_COLUMN at eye position from drowning')
      assert.ok(route.target.equals(new Vec3(0, 1, 0)))
    } finally { s.close() }
  }
}))

for (const [oxygen, timeoutMs, maxMs] of [[8, 2000, 2200], [3, 8000, 8200]]) test(`rescue keeps the A6 roof-dig RPC deadline (${oxygen} bubbles)`, () => rescueEnabled(async () => {
  const s = scene({ oxygen, change: q => q.x !== 0 || q.z !== 0 || q.y <= 0 || q.y >= 3 ? 'stone' : 'water' })
  let digs = 0, stops = 0
  s.bot.canDigBlock = () => true
  s.bot.dig = async (b: any) => {
    assert.ok(pick.blockAim(s.bot, b.position, { range: 4.5 }), 'dig is on a visible reachable ceiling face')
    digs++
    return new Promise(() => {})
  }
  s.bot.stopDigging = () => { stops++ }
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs, visibleOnly: true }))
    assert.equal(digs, 1)
    assert.equal(stops, 1)
    assert.equal(r.ok, false, 'a started dig is not proof of an exit')
    assert.ok(clockMod.now() <= maxMs, 'the rescue flag preserves the A6 caller deadline')
  } finally { s.close() }
}))

test('only a flowing shaft is plugged overhead; client water updates must prove that air appeared', () => rescueEnabled(async () => {
  const s = scene({ oxygen: 8, change: q => q.x !== 0 || q.z !== 0 || q.y <= 0 ? 'stone' : 'water' })
  for (const y of [1, 2]) {
    const falling = Block.fromProperties(registry.blocksByName.water.id, { level: 8 }, 0)
    falling.position = new Vec3(0, y, 0); s.cells.set(falling.position.toString(), falling)
  }
  let placed = false
  s.bot.placeBlock = async (ref: any, face: any) => {
    const p = ref.position.plus(face)
    assert.ok(pick.faceAim(s.bot, ref.position, face), 'placement uses an observed reference face')
    assert.ok(p.y >= s.bot.entity.position.y + 1.8, 'plug does not intersect the player')
    s.placements.push(p); placed = true
    const stone = Block.fromStateId(registry.blocksByName.cobblestone.defaultState); stone.position = p
    const previous = s.bot.blockAt(p); s.cells.set(p.toString(), stone); s.bot.emit('blockUpdate', previous, stone)
  }
  try {
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 3000, visibleOnly: true }), tick => {
      if (!placed || tick < 10) return
      // Server block-update contract, not a fluid solver: flowing cells drained after closing their only inlet.
      for (const y of [1, 2]) {
        const air = Block.fromStateId(registry.blocksByName.air.defaultState); air.position = new Vec3(0, y, 0)
        s.cells.set(air.position.toString(), air)
      }
    })
    assert.ok(s.placements.some(p => p.equals(new Vec3(0, 3, 0))), JSON.stringify({ r, placements: s.placements }))
    assert.equal(r.breathing, true, 'placement alone is not counted as breathing: ' + JSON.stringify({ r, p: s.bot.entity.position }))
  } finally { s.close() }
}))

test('surface swims to a connected bank beyond the first breathing pocket', async () => {
  // A long flooded cave has breathable air below its roof, but the supported
  // bank is twelve cells away. Breathing alone must not end surface progress.
  const s = scene({ change: q => {
    if (q.y <= 0) return 'stone'
    if (q.z < 0 || q.z > 2 || q.x < 0 || q.x > 12) return 'stone'
    if (q.x === 12) return q.y < 3 ? 'stone' : 'air'
    if (q.x === 11 && q.y >= 3) return 'air'
    return q.y < 3 ? 'water' : q.y === 3 ? 'air' : 'stone'
  } })
  try {
    assert.equal(movement.findSwimRoute(s.bot).kind, 'air', 'the old eight-cell search sees only a breathing pocket')
    assert.equal(movement.findSwimRoute(s.bot, { radius: 16 }).kind, 'land')
    const r = await s.run(() => (require('../src/survival/out-of-water') as typeof import('../src/survival/out-of-water')).outOfWater(s.bot, s.ctl, 16000))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(movement.inWater(s.bot), false)
    assert.equal(s.bot.entity.onGround, true, 'actual physics confirms a supported landing')
    assert.ok(s.bot.entity.position.x >= 12)
    assert.deepEqual(s.placements, [], 'a connected swim costs no blocks or excavation')
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

test('a shaft flooded from above with no air in reach is plugged over the head (cl-n 14.10 drowned)', async () => {
  const s = scene({ change: q => q.y <= 0 || q.x !== 0 || q.z !== 0 ? 'stone' : q.y < 20 ? 'water' : 'air' })
  for (const y of [1, 2]) {
    const water = Block.fromProperties(registry.blocksByName.water.id, { level: 8 }, 0)
    water.position = new Vec3(0, y, 0); s.cells.set(water.position.toString(), water)
  }
  try {
    assert.equal(movement.findSwimRoute(s.bot), null, 'no breath within the bounded search')
    s.bot.placeBlock = async (ref, face) => { s.placements.push(ref.position.plus(face)) }
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 3000 }))
    assert.ok(s.placements.some(p => p.equals(new Vec3(0, 3, 0))), JSON.stringify({ r, placements: s.placements }))
  } finally { s.close() }
})

test('own sealed hole flooded under a pond: the roof is opened, not plugged again (tw-a-s1-3 15.10 drowned)', async () => {
  // Пруд: вода в y=3 над каменным дном y<=2; своя нора 1x1 в (0,0): вода y=0..1, потолок из булыжника y=2; берег — камень до y=3.
  const s = scene({ oxygen: 10, change: q => {
    const pond = Math.abs(q.x) <= 6 && Math.abs(q.z) <= 6
    if (q.x === 0 && q.z === 0 && q.y >= 0 && q.y <= 1) return 'water'
    if (q.x === 0 && q.z === 0 && q.y === 2) return 'cobblestone'
    if (pond) return q.y <= 2 ? 'stone' : q.y === 3 ? 'water' : 'air'
    return q.y <= 3 ? 'stone' : 'air'
  } })
  s.bot.entity.position = new Vec3(.5, 0, .5)
  const dug: Vec3[] = []
  s.bot.canDigBlock = () => true
  s.bot.dig = async (b: any) => {
    dug.push(b.position.clone())
    const w = Block.fromStateId(registry.blocksByName.water.defaultState); w.position = b.position.clone()
    s.cells.set(b.position.toString(), w) // пруд сверху затекает в вскрытую клетку
  }
  s.bot.placeBlock = async (ref, face) => { s.placements.push(ref.position.plus(face)) }
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }), null, 'sealed: no air in reach')
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 12000, visibleOnly: true }))
    assert.deepEqual(dug.map(String), [String(new Vec3(0, 2, 0))], 'the roof over the head is opened once')
    assert.deepEqual(s.placements, [], 'no plug over an opened roof')
    assert.equal(r.breathing || r.ok, true, JSON.stringify({ r, at: s.bot.entity.position }))
  } finally { s.close() }
})

test('deep open water with no air in the bounded search: swims straight up (tw-cr2-s1-3 15.10 drowned)', async () => {
  // Озеро 11×11 глубиной 20 (вода y=1..20), берег — камень до y=20; бот на дне. Поиск (подъём ≤ 12/16) воздуха не видит.
  const s = scene({ oxygen: 20, change: q => {
    if (q.y <= 0) return 'stone'
    const lake = Math.abs(q.x) <= 5 && Math.abs(q.z) <= 5
    if (lake) return q.y <= 20 ? 'water' : 'air'
    return q.y <= 20 ? 'stone' : 'air'
  } })
  s.bot.entity.position = new Vec3(.5, 1, .5)
  s.bot.placeBlock = async (ref, face) => { s.placements.push(ref.position.plus(face)) }
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true }), null, 'no air within the bounded search')
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 20000, visibleOnly: true }))
    assert.deepEqual(s.placements, [], 'open water is not plugged')
    assert.ok(s.bot.entity.position.y > 15, 'rose toward the surface: ' + s.bot.entity.position + ' ' + JSON.stringify(r))
  } finally { s.close() }
})

test('surfaced in a wide lake with no shore in 8 blocks: swims to the visible bank instead of sinking (j1k1-s2 15.10 drowned x3)', async () => {
  // Озеро 31×31 глубиной 2 (вода y=1..2, воздух выше), берег — камень до y=2 за |x|,|z| > 15; тело в центре, голова над водой.
  const s = scene({ oxygen: 8, change: q => {
    if (q.y <= 0) return 'stone'
    const lake = Math.abs(q.x) <= 15 && Math.abs(q.z) <= 15
    if (lake) return q.y <= 2 ? 'water' : 'air'
    return q.y <= 2 ? 'stone' : 'air'
  } })
  s.bot.entity.position = new Vec3(.5, 1.6, .5)
  try {
    assert.equal(movement.findSwimRoute(s.bot, { visibleOnly: true })?.kind, 'air', 'no bank within the old 8-block search')
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 20000, visibleOnly: true }))
    assert.equal(r.ok, true, JSON.stringify({ r, at: s.bot.entity.position }))
    assert.ok(Math.max(Math.abs(s.bot.entity.position.x), Math.abs(s.bot.entity.position.z)) > 15, 'reached the bank')
  } finally { s.close() }
})

test('short of breath in a flooded tunnel, air beyond 8 blocks is still found (cl-ac/cl-ai 14.10 drowned)', async () => {
  const s = scene({ oxygen: 4, change: q => q.y >= 1 && q.y <= 2 && q.z === 0 && q.x >= 0 && q.x <= 14 ? (q.x <= 11 ? 'water' : 'air') : 'stone' })
  try {
    assert.equal(movement.findSwimRoute(s.bot), null, 'no breath within 8 blocks')
    const r = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 15000 }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(s.bot.entity.position.x >= 12, `out at ${s.bot.entity.position}`)
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
      assert.equal((require('../src/perception/eyes') as typeof import('../src/perception/eyes')).seesNow(s.bot, new Vec3(3, 3, 3)), false)
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

test('polar bear shore choice reaches dry ground with native player physics', async () => {
  const s = scene()
  try {
    const polar: typeof import('../src/polar-bear') = require('../src/polar-bear')
    s.bot.entity.position.y = 2.3; s.bot.entity.onGround = false
    s.bot.entities[2] = { id: 2, name: 'polar_bear', position: new Vec3(18, 3, .5), height: 1.4, width: 1.4,
      isValid: true, metadata: { 15: 4, 16: false } }
    const choice = polar.plan({ bot: s.bot })
    assert.equal(choice.action, 'Surface')
    const result = await s.run(() => movement.escapeWater(s.bot, s.ctl, { timeoutMs: 8000, visibleOnly: true }))
    assert.equal(result.ok, true)
    assert.equal(s.bot.entity.isInWater, false)
    assert.equal(s.bot.entity.onGround, true)
  } finally { s.close() }
})

test('polar bear pillar clears a three-block support under native player physics', async () => {
  const s = scene({ placement: true, change: q => q.y <= 0 ? 'stone' : 'air' })
  try {
    s.bot.entity.isInWater = false
    s.bot.entities[2] = { id: 2, name: 'polar_bear', position: new Vec3(14, 1, .5), height: 1.4, width: 1.4,
      isValid: true, metadata: { 15: 4, 16: false } }
    const polar: typeof import('../src/polar-bear') = require('../src/polar-bear'), session = { bot: s.bot }
    const plan = polar.plan(session)
    assert.equal(plan.action, 'PillarUp')
    const result = await s.run(() => polar.pillar(session, s.ctl, plan))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(s.bot.entity.position.y, 4)
    assert.equal(s.placements.length, 3)
    assert.equal(polar.canReach(s.bot, s.bot.entities[2]), false)
  } finally { s.close() }
})

test('a refused bear pillar is not attempted again until its physical cause changes', async () => {
  const s = scene({ placement: true, change: q => q.y <= 0 ? 'stone' : 'air' })
  try {
    s.bot.entity.isInWater = false
    s.bot.entities[2] = { id: 2, name: 'polar_bear', position: new Vec3(14, 1, .5), height: 1.4, width: 1.4,
      isValid: true, metadata: { 15: 4, 16: false } }
    const polar: typeof import('../src/polar-bear') = require('../src/polar-bear'), session = { bot: s.bot }
    s.bot._genericPlace = async () => { s.placements.push(s.bot.entity.position.clone()); throw new Error('placement refused') }
    const result = await s.run(() => polar.pillar(session, s.ctl, polar.plan(session)))
    assert.equal(result.failed, true)
    assert.equal(s.placements.length, 1, 'one physical refusal ends this construction')
    assert.notEqual(polar.plan(session).action, 'PillarUp')
    assert.notEqual(polar.plan(session).action, 'PillarUp', 'waiting alone does not reopen it')
    const dirt = Block.fromStateId(registry.blocksByName.dirt.defaultState); dirt.position = new Vec3(0, 0, 0)
    s.cells.set(dirt.position.toString(), dirt)
    assert.equal(polar.plan(session).action, 'PillarUp', 'a changed support reopens the failed physical plan')
  } finally { s.close() }
})
