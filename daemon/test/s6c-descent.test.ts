import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()
const descent = require('../src/navigation/descent')

// Terrain function over cells; the body stands at `at` (feet).
function worldOf(terrain: (x: number, y: number, z: number) => string, at = new Vec3(.5, 20, .5)) {
  const cache = new Map<string, any>()
  const world = { getBlock(p: Vec3) {
    const q = p.floored(); const k = `${q.x},${q.y},${q.z}`
    let b = cache.get(k)
    if (!b) { b = Block.fromStateId(registry.blocksByName[terrain(q.x, q.y, q.z)].defaultState); b.position = q; cache.set(k, b) }
    return b
  } }
  const bot: Record<string, any> = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384, dimension: 'overworld' }, inventory: { slots: [], items: () => [] }, health: 20, food: 20,
    entity: { position: at.clone(), velocity: new Vec3(0, 0, 0), onGround: true, eyeHeight: 1.62,
      isInWater: false, isInLava: false, isInWeb: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  // Honest sight ray over the same cells (sight.seesBlock uses world.raycast).
  const { RaycastIterator } = require('prismarine-world').iterators
  bot.world = { raycast(from: Vec3, dir: Vec3, range: number, match: (b: any, it: any) => boolean) {
    const it = new RaycastIterator(from, dir, range); let pos = it.next()
    while (pos) { const b = world.getBlock(new Vec3(pos.x, pos.y, pos.z)); if (b && match(b, it)) return b; pos = it.next() }
    return null
  } }
  return { world, bot }
}
// A 20-high cliff: plateau x <= 3 (top y 19), ground y -1 elsewhere, a 2x2 pool 2 deep at x 7..8.
const cliff = (pool = true) => (x: number, y: number, z: number) =>
  x <= 3 && y <= 19 ? 'stone' : y < -1 ? 'stone' : y === -1 ? (pool && x >= 7 && x <= 8 && z >= 0 && z <= 1 ? 'water' : 'stone') :
    pool && y === -2 && x >= 7 && x <= 8 && z >= 0 && z <= 1 ? 'water' : 'air'

test('a cliff jump into a pool below is forecast natively: water entered before any dry landing', () => {
  const { bot } = worldOf(cliff(), new Vec3(2.5, 20, .5))
  const waters = descent.waterBelow(bot)
  assert.ok(waters.some((w: any) => w.x === 7 && w.top === -1), 'the pool surface is found under the open drop')
  const pool = waters.find((w: any) => w.x === 7 && w.z === 0)
  let plan = null
  for (const v of descent.DROP_VARIANTS) { plan = descent.planWaterDrop(bot, pool, v); if (plan) break }
  assert.ok(plan, 'some run-up/jump variant reaches the water')
  const last = plan.states.at(-1)
  assert.ok(last.isInWater, 'the plan ends in the water')
  assert.ok(plan.drop > 18, 'a real 20-block drop')
  assert.ok(plan.states.every((s: any) => !s.onGround || s.pos.y > 19.9 || s.isInWater), 'no dry contact below the takeoff')
})

test('no water below: no water drop; dry stone is never accepted as a landing', () => {
  const { bot } = worldOf(cliff(false), new Vec3(2.5, 20, .5))
  assert.equal(descent.waterBelow(bot).length, 0)
  const fake = { x: 7, z: 0, top: -1, depth: 1 }
  for (const v of descent.DROP_VARIANTS) assert.equal(descent.planWaterDrop(bot, fake, v), null)
})

test('findWaterDrop picks a takeoff on the plateau and costs the jump against the goal', () => {
  const { bot } = worldOf(cliff(), new Vec3(-2.5, 20, .5))
  const best = descent.findWaterDrop(bot, { x: 12.5, y: 0, z: .5 }, { budgetMs: 2000 })
  assert.ok(best, 'a water drop is found')
  assert.ok(best.takeoff.x <= 4 && best.takeoff.y === 20, 'takeoff on the plateau top')
  assert.ok(best.plan.states.at(-1).isInWater)
  assert.ok(best.seconds < 10, `cheap: ${best.seconds}`)
})

test('wallStep: a sheer wall offers a step along it; a 3-block step is left to pathfinder', () => {
  const { bot } = worldOf(cliff(false), new Vec3(3.5, 20, .5))
  const step = descent.wallStep(bot, { x: 12.5, y: 0, z: .5 })
  assert.ok(step, 'step off the cliff edge, the cliff face is the wall')
  assert.equal(step.dir.x, 1)
  const low = worldOf((x, y, z) => x <= 3 && y <= 2 ? 'stone' : y < 0 ? 'stone' : 'air', new Vec3(3.5, 3, .5)).bot
  assert.equal(descent.wallStep(low, { x: 12.5, y: 0, z: .5 }), null, 'a 3-block drop is an ordinary pathfinder step')
})

test('ledgeOptions: lower ledges within reach, deeper and closer to the goal first; flex damage widens the drop', () => {
  // Ledges: x 4..5 top 16 (3 below), x 7..8 top 13; the plateau top 19.
  const t = (x: number, y: number, z: number) => x <= 3 && y <= 19 || x >= 4 && x <= 5 && y <= 16 || x >= 7 && x <= 8 && y <= 13 || y < 0 ? 'stone' : 'air'
  const { bot } = worldOf(t, new Vec3(3.5, 20, .5))
  const opts = descent.ledgeOptions(bot, { x: 12.5, y: 0, z: .5 })
  assert.ok(opts.length && opts[0].y === 17, 'the 3-block ledge')
  assert.ok(opts.every((p: any) => 20 - p.y <= 3.01))
  const flex = descent.ledgeOptions(bot, { x: 12.5, y: 0, z: .5 }, { maxFallDamage: 2 })
  assert.ok(flex.some((p: any) => p.y === 15) === false && flex.length >= opts.length, 'a 5-block budget keeps reachable lower supports')
})

test('surfaceY reads the top of the goal column (goals without y)', () => {
  const { bot } = worldOf(cliff(), new Vec3(2.5, 20, .5))
  assert.equal(descent.surfaceY(bot, 12, 0, 20), 0)
  assert.equal(descent.surfaceY(bot, 7, 0, 20), -1, 'water surface cell')
  assert.equal(descent.surfaceY(bot, 1, 0, 20), 20)
})

test('clutch deep: from the safe single-block plans the deepest (fall up to 3) wins, the ordinary rule keeps the shallowest', () => {
  const { Physics } = require('prismarine-physics')
  const data = require('minecraft-data')('1.21.11')
  const B = require('prismarine-block')('1.21.11')
  const pick = require('../src/pick')
  const clutch = require('../src/clutch')
  const mk = (name: string, p: Vec3) => { const b = B.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p.floored(); return b }
  const world = { getBlock: (p: Vec3) => mk(p.x < 0 || p.y < 0 ? 'stone' : 'air', p) }
  const physics = Physics(data, world)
  const api = clutch.create({ Vec3, faceAim: pick.faceAim, simulate: (s: any, w: any) => physics.simulatePlayer(s, w), makeBlock: (p: Vec3) => mk('cobblestone', p) })
  const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  // Walked off a 30-high wall (x < 0) half a block ago.
  const s = { pos: new Vec3(.5, 29.5, .5), vel: new Vec3(0, -.3, 0), onGround: false, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {}, yaw: 0, pitch: 0, control: { ...IDLE }, jumpBoost: 0, speed: 0, slowness: 0,
    dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false }
  const shallow = api.plan({ state: s, world, peak: 30, blockCount: 3 })
  const deep = api.plan({ state: s, world, peak: 30, blockCount: 3, deep: true })
  assert.ok(shallow && deep)
  assert.ok(deep.fall <= 3 && deep.chain.length === 1)
  assert.ok(deep.fall > shallow.fall + .5, `deep ${deep.fall} vs shallow ${shallow.fall}`)
})

test('edgeNear: from inside the plateau, the cliff edge toward the goal; ledges are judged from there', () => {
  const t = (x: number, y: number, z: number) => x <= 3 && x >= -10 && y <= 19 || x >= 5 && x <= 6 && y <= 16 || y < 0 ? 'stone' : 'air'
  const { bot } = worldOf(t, new Vec3(-3.5, 20, .5))
  const goal = { x: 15.5, y: 0, z: .5 }
  const edge = descent.edgeNear(bot, goal)
  assert.ok(edge && edge.x === 3.5 && edge.y === 20, JSON.stringify(edge))
  assert.equal(descent.ledgeOptions(bot, goal).length, 0, 'nothing below within reach of the body itself')
})

test('a far pool below a low cliff needs the run-up jump: the walk-off variant falls short, sprint+jump reaches it', () => {
  // Plateau x <= 3 top 9 (feet 10); 1x1 pool at x 9 (6 out), ground y -1; drop ~10.
  const t = (x: number, y: number, z: number) => x <= 3 && y <= 9 ? 'stone' : y < -1 ? 'stone' : y === -1 ? (x === 9 && z === 0 ? 'water' : 'stone') : 'air'
  const { bot } = worldOf(t, new Vec3(-.5, 10, .5))
  const pool = { x: 9, z: 0, top: -1, depth: 1 }
  const walk = descent.planWaterDrop(bot, pool, { sprint: false, jump: false, coast: 6 })
  const jump = descent.planWaterDrop(bot, pool, { sprint: true, jump: true, coast: 6 })
  assert.equal(walk, null, 'walking off the edge does not carry 6 blocks out over a 10-block fall')
  assert.ok(jump && jump.states.at(-1).isInWater, 'a sprint run-up and an edge jump do')
  assert.ok(jump.steps.some((s: any) => s.control.jump), 'the jump key is pressed on the last ground tick')
})

test('soft landings: a cobweb catches the 20-block drop; hay only within the explicit damage budget', () => {
  const t = (soft: string) => (x: number, y: number, z: number) => x <= 3 && y <= 19 ? 'stone' : y < 0 ? 'stone' : y === 0 && x >= 7 && x <= 8 && z >= 0 && z <= 1 ? soft : 'air'
  const web = worldOf(t('cobweb'), new Vec3(2.5, 20, .5)).bot
  const cols = descent.waterBelow(web)
  const col = cols.find((c: any) => c.kind === 'cobweb' && c.x === 7 && c.z === 0)
  assert.ok(col, 'the web column is a soft target')
  let plan = null
  for (const v of descent.DROP_VARIANTS) { plan = descent.planWaterDrop(web, col, v); if (plan) break }
  assert.ok(plan && plan.states.at(-1).isInWeb && plan.damage === 0)
  const hay = worldOf(t('hay_block'), new Vec3(2.5, 20, .5)).bot
  const hcol = descent.waterBelow(hay).find((c: any) => c.kind === 'hay_block' && c.x === 7 && c.z === 0)
  assert.ok(hcol)
  // 20 blocks onto hay: floor((19 - 3) * 0.2) = 3 HP — refused at budget 2, accepted at 4 with the damage in the plan.
  for (const v of descent.DROP_VARIANTS) assert.equal(descent.planWaterDrop(hay, hcol, v, 160, 2), null)
  let paid = null
  for (const v of descent.DROP_VARIANTS) { paid = descent.planWaterDrop(hay, hcol, v, 160, 4); if (paid) break }
  assert.ok(paid && paid.damage === 3, JSON.stringify(paid && paid.damage))
})

test('tactics: a clutch block placed under the Emergency fall-controller lease does not abort the walking skill (descent by blocks)', () => {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const locks = require('../src/reflex-lock')
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 20; bot.food = 20; bot.oxygenLevel = 20
  bot.inventory = { slots: [], items: () => [{ name: 'cobblestone', count: 32 }] }
  bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 70, .5), height: 1.8, eyeHeight: 1.62, onGround: false, isInWater: false, effects: {}, metadata: [], yaw: 0, pitch: 0, velocity: new Vec3(0, -.3, 0) }
  bot.entities = {}; bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.blockAt = (p: any) => p.y < 64 ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', position: p.floored(), shapes: [] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.clearControlStates = () => {}; bot.setControlState = () => {}
  bot._ndClutch = { lastDecision: { action: 'clutch' } }
  const ctl: any = { aborted: false, onAbort: [], abort () { this.aborted = true } }
  const s: any = { bot, current: { name: 'goto', ctl }, reflex: null, bus: { emit: () => {} }, tempo: null }
  const t = s.tactics = new TacticalSystem(s)
  t.execute = () => new Promise(() => {})
  locks.start(s, () => new Promise(() => {}), { source: 'fall-controller', owner: 'Emergency', priority: 3, preempt: true, immediate: true })
  try {
    t.attach(bot); t.update(true); assert.equal(t.snapshot().threatLevel, 4); assert.equal(ctl.aborted, false, 'the fall reflex owns the body; nothing for tactics to select')
    // Landed on the block: lease over, on the ground, the clutch idle — the incident ends without cutting the walk.
    locks.cancel(s); bot.entity.onGround = true; bot.entity.velocity = new Vec3(0, 0, 0); bot._ndClutch = { lastDecision: { action: 'none' } }
    t.update(true)
    assert.equal(t.snapshot().threatLevel, 0)
    assert.equal(ctl.aborted, false, 'a pure fall incident is not "substantive": release() keeps the goto (MLG, blocks)')
  } finally { t.detach() }
})

test('descent.watch fires once at a cliff with water below a lower goal; a skipped place stays quiet; a level goal never fires', () => {
  const { bot } = worldOf(cliff(), new Vec3(2.5, 20, .5))
  let fired = 0
  const w = descent.watch(bot, { x: 12, y: 0, z: 0 }, () => fired++, { every: 5 })
  for (let i = 0; i < 20; i++) bot.emit('physicsTick')
  assert.equal(fired, 1, 'one event per arming')
  w.skip(bot.entity.position)
  for (let i = 0; i < 20; i++) bot.emit('physicsTick')
  assert.equal(fired, 1, 'decided to walk here: not again within 8 blocks')
  w.stop()
  let level = 0
  const w2 = descent.watch(bot, { x: -20, y: 20, z: 0 }, () => level++, { every: 5 })
  for (let i = 0; i < 20; i++) bot.emit('physicsTick')
  w2.stop()
  assert.equal(level, 0)
})

test('lava: no wall step down a column ending in lava, no ledge next to lava (Nether: careful near lava)', () => {
  const t = (lava: boolean) => (x: number, y: number, z: number) => x <= 3 && y <= 19 ? 'netherrack' : y < -1 ? 'netherrack' : y === -1 ? (lava && x >= 4 && x <= 6 ? 'lava' : 'netherrack') : 'air'
  const dry = worldOf(t(false), new Vec3(3.5, 20, .5)).bot
  assert.ok(descent.wallStep(dry, { x: 12.5, y: 0, z: .5 }))
  const wet = worldOf(t(true), new Vec3(3.5, 20, .5)).bot
  assert.equal(descent.wallStep(wet, { x: 12.5, y: 0, z: .5 }), null, 'a lava floor under the fall column')
  const ledge = (x: number, y: number, z: number) => x <= 3 && y <= 19 || x === 5 && y <= 16 ? 'netherrack' : x === 6 && y === 16 ? 'lava' : y < 0 ? 'netherrack' : 'air'
  const lb = worldOf(ledge, new Vec3(3.5, 20, .5)).bot
  assert.ok(!descent.ledgeOptions(lb, { x: 12.5, y: 0, z: .5 }).some((p: any) => p.x === 5.5 && p.y === 17), 'the ledge beside a lava cell is refused')
})

test('restSeconds: a lake across the way to the goal is swum, not run', () => {
  const lake = (x: number, y: number, z: number) => y < -1 ? 'stone' : y === -1 ? (x >= 2 && x <= 21 ? 'water' : 'stone') : 'air'
  const { bot } = worldOf(lake, new Vec3(0.5, 0, .5))
  const dry = worldOf((x, y) => y < 0 ? 'stone' : 'air', new Vec3(0.5, 0, .5)).bot
  const wet = descent.restSeconds(bot, { x: .5, y: -1, z: .5 }, { x: 24.5, y: 0, z: .5 })
  const run = descent.restSeconds(dry, { x: .5, y: 0, z: .5 }, { x: 24.5, y: 0, z: .5 })
  assert.ok(Math.abs(run - 24 / 5) < .01)
  assert.ok(wet > run * 1.8, `${wet} vs ${run}`)
})

test('planLedgeDrop: down 8 ledges 3 lower across 1-block gaps, no damage, ~1 s a hop (executeJump found none of them)', () => {
  const solid = (x: number, y: number, z: number) => {
    if (y < 0 || x >= 0 && x <= 10 && z >= -5 && z <= 5 && y <= 23) return true
    for (let i = 0; i < 8; i++) { const lx = 12 + 3 * i; const top = 24 - 3 * (i + 1) - 1; if (top >= 0 && x >= lx && x <= lx + 1 && z >= -1 && z <= 1 && y <= top) return true }
    return false
  }
  const { bot } = worldOf((x, y, z) => solid(x, y, z) ? 'stone' : 'air', new Vec3(10.5, 24, .5))
  const goal = { x: 38.5, y: 0, z: .5 }; let ticks = 0; let hops = 0
  while (bot.entity.position.y > .5 && hops < 12) {
    let plan = null
    for (const t of descent.ledgeOptions(bot, goal).slice(0, 3)) { for (const v of descent.DROP_VARIANTS) if ((plan = descent.planLedgeDrop(bot, t, v, 0))) break; if (plan) break }
    assert.ok(plan, `hop ${hops} from ${bot.entity.position}`)
    assert.equal(plan.damage, 0)
    bot.entity.position = plan.states.at(-1).pos.clone(); ticks += plan.ticks; hops++
  }
  assert.equal(hops, 8)
  assert.ok(ticks < 8 * 25, `${ticks} ticks`)
})

test('wallStep: no step off into the void (no floor within 128)', () => {
  const { bot } = worldOf((x, y) => x <= 3 && y <= 19 && y >= -40 ? 'end_stone' : 'air', new Vec3(3.5, 20, .5))
  assert.equal(descent.wallStep(bot, { x: 12.5, y: -100, z: .5 }), null)
})

test('planLedgeDrop: a 5-block ledge drop costs 2 HP — refused at budget 0, planned with allowDamage at budget 2', () => {
  const solid = (x: number, y: number, z: number) => y < 0 || x <= 3 && y <= 19 || x >= 5 && x <= 7 && y <= 14
  const { bot } = worldOf((x, y, z) => solid(x, y, z) ? 'stone' : 'air', new Vec3(3.5, 20, .5))
  const target = new Vec3(6.5, 15, .5)
  for (const v of descent.DROP_VARIANTS) assert.equal(descent.planLedgeDrop(bot, target, v, 0), null)
  let plan = null
  for (const v of descent.DROP_VARIANTS) if ((plan = descent.planLedgeDrop(bot, target, v, 2))) break
  assert.ok(plan && plan.damage === 2 && plan.allowDamage && plan.allowDamage.damage === 2 && !plan.fall, JSON.stringify(plan && plan.allowDamage))
})

test('wallStep from a placed block reads the support, not floor(position): the body at the far edge of the block still steps along the wall', () => {
  const t = (x: number, y: number, z: number) => y < 0 || x <= 3 && y <= 19 || x === 4 && y === 16 && z === 0 ? 'stone' : 'air'
  const { bot } = worldOf(t, new Vec3(5.2, 17, .5)) // over column 5, standing on the block (4,16,0) by its edge
  const step = descent.wallStep(bot, { x: 12.5, y: 0, z: .5 }, new Vec3(1, 0, 0))
  assert.ok(step && step.cell.x === 4 && step.dir.x === 0, JSON.stringify(step))
})

test('executePlan accepts the planned ledge damage after the landing tick (allowDamage), refuses more', async () => {
  const { executePlan, IDLE } = require('../src/navigation/parkour')
  const solid = (x: number, y: number, z: number) => y < 0 || x <= 3 && y <= 19 || x >= 5 && x <= 7 && y <= 14
  const run = async (lost: number) => {
    const { bot, world } = worldOf((x, y, z) => solid(x, y, z) ? 'stone' : 'air', new Vec3(3.5, 20, .5))
    bot.entities = {}; bot.players = {}; bot.inventory = { slots: [], items: () => [] }; bot.entity.id = 1; bot.entity.height = 1.8; bot.entity.metadata = []
    let plan = null
    for (const v of descent.DROP_VARIANTS) if ((plan = descent.planLedgeDrop(bot, new Vec3(6.5, 15, .5), v, 2))) break
    assert.ok(plan && plan.allowDamage)
    let control = { ...IDLE }; let hurt = false
    bot.setControlState = (key: string, value: boolean) => { control[key] = value }
    bot.clearControlStates = () => { control = { ...IDLE } }
    bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
    bot.waitForTicks = async (ticks: number) => {
      for (let tick = 0; tick < ticks; tick++) {
        const state = new native.PlayerState(bot, control)
        bot.physics.simulatePlayer(state, world); state.apply(bot)
        if (!hurt && bot.entity.onGround && bot.entity.position.y < 15.1) { hurt = true; bot.health = 20 - lost }
        bot.emit('physicsTick')
      }
    }
    return executePlan(bot, { aborted: false, onAbort: [] }, plan, (st: any) => st.onGround && Math.abs(st.pos.y - 15) < .06)
  }
  const ok = await run(2)
  assert.equal(ok.ok, true, JSON.stringify(ok.why))
  const bad = await run(4)
  assert.equal(bad.ok, false)
  assert.equal(bad.why, 'hurt_during_trajectory')
})

test('descent.watch checks on the next ground tick when the due tick is airborne (sprint jumping)', () => {
  const { bot } = worldOf(cliff(), new Vec3(2.5, 20, .5))
  let fired = 0
  const w = descent.watch(bot, { x: 12, y: 0, z: 0 }, () => { fired++; return true }, { every: 5 })
  for (let i = 0; i < 12; i++) { bot.entity.onGround = i % 13 === 12; bot.emit('physicsTick') } // airborne on the due ticks 5 and 10
  assert.equal(fired, 0)
  bot.entity.onGround = true; bot.emit('physicsTick')
  assert.equal(fired, 1, 'the deferred check runs at landing')
  w.stop()
})
