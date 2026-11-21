'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { goals } from 'mineflayer-pathfinder'
import Move = require('mineflayer-pathfinder/lib/move')
import * as gameClock from '../src/game-clock'
import { gotoGoal } from '../src/movement/goto'
import { createDetector } from '../src/unstuck/watch'
import { bridgeWorth, waterBridge } from '../src/water-bridge'
import { stepSafe } from '../src/moves'
import { tuneMovements } from '../src/worlds'
import { isFiller, selectBlock } from '../src/clutch/blocks'
import { create as createClutch } from '../src/clutch/plan'
import { step as clutchStep } from '../src/clutch/guard-step'
import { openGuard } from '../src/clutch/guard-state'
import { COMMANDED_ESCAPE } from '../src/tactics/commanded-escape'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { EscapeProgress } from '../src/tactics/escape-progress'
import { lavaCapabilities, syncLavaClimbGoal } from '../src/tactics/lava-escape'
import { actionableInstantBlasts, dodgeBlast } from '../src/tactics/blast'
import { TacticalSystem, observeTactics } from '../src/tactics/minecraft'
import { commandedEscape } from '../src/tactics/minecraft/observe'
import { intentMethods } from '../src/rpc/intents'
import { refugeBody } from '../src/survival/refuge-body'
import type { TacticalState } from '../src/tactics/state'

const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
const { Physics } = require('prismarine-physics')
const pick = require('../src/pick') as typeof import('../src/pick')

const tacticalState = (changes: Partial<TacticalState> = {}): TacticalState => ({
  at: 0, health: 20, food: 20, armor: 0, weapon: true, shield: false, enemies: [], incomingProjectiles: 0,
  burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 16,
  water: false, edible: true, canFight: true, contact: false, shelter: null, protectedEncounter: false, ...changes
})

test('gotoGoal marks stripped partials and rebases climb/place continuation promptly instead of waiting 5s', async () => {
  const clock = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  let currentPath: any[] = []
  let setGoals = 0
  bot.pathfinder = {
    goal: null,
    isMoving: () => currentPath.length > 0,
    isMining: () => false,
    isBuilding: () => false,
    canMove: () => true,
    setGoal (g: any) { this.goal = g; setGoals++; bot.emit('goal_updated', g) }
  }
  const goal = new goals.GoalBlock(5, 68, 0)
  const walk = gotoGoal(bot, goal)
  walk.catch(() => {})
  try {
    const start = new Move(0, 64, 0, 5, 0)
    const step1 = new Move(1, 64, 0, 4, 1)
    const climb = new Move(1, 65, 0, 3, 2, [], [{ x: 1, y: 63, z: 0, dx: 0, dy: 1, dz: 0, jump: true }])
    const root = { data: start, parent: null }
    const n1 = { data: step1, parent: root }
    const n2 = { data: climb, parent: n1 }
    const ctx = { bestNode: n1 }
    const p1: any = { status: 'partial', path: [step1], context: ctx }
    bot.emit('path_update', p1)
    currentPath = p1.path
    currentPath.shift()
    bot.entity.position.set(1.5, 64, 0.5)
    ctx.bestNode = n2 as any

    const det = createDetector(bot, { goal, stillMs: 3000, now: () => clock.now() })
    const p2: any = { status: 'partial', path: [climb], context: ctx }
    bot.emit('path_update', p2)
    assert.equal(p2.path.length, 0)
    assert.equal(p2.ndStripped, true, 'stripped path must be flagged for unstuck')
    det.feed(p2)
    bot.emit('physicsTick')
    assert.equal(setGoals, 1, 'first stripped tick does not restart immediately')

    clock.advanceTicks(7) // 350ms
    const p3: any = { status: 'partial', path: [climb], context: ctx }
    bot.emit('path_update', p3)
    det.feed(p3)
    bot.emit('physicsTick')
    assert.equal(setGoals, 2, 'rebased promptly after 350ms instead of burning 5s thinkTimeout')

    // Verify unstuck is not blinded by stripped paths: after stillMs it triggers still.
    clock.advanceTicks(62) // +3100ms
    const stuck = det.check()
    assert.equal(stuck?.kind, 'still', 'stripped partial paths must not mask stillness in unstuck')
  } finally {
    walk.cancel()
    await assert.rejects(walk, { name: 'PathStopped' })
    clock.dispose()
    gameClock.activate(null)
  }
})

test('unstuck detector scales dig limit from native bot.digTime and resets buildT when placement stops', () => {
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, isInWater: false },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { isMining: () => true, isBuilding: () => false },
    targetDigBlock: { position: new Vec3(1, 64, 0), name: 'obsidian' },
    digTime: () => 12000
  }
  let t = 0
  const det = createDetector(bot, { goal: new goals.GoalNearXZ(20, 0, 1), now: () => t })
  det.feed({ status: 'success', path: [{ x: 1, y: 64, z: 0 }] })
  t = 1000; assert.equal(det.check(), null)
  t = 12000; assert.equal(det.check(), null, 'valid 12s obsidian dig must not abort at hardcoded 10s')
  t = 22000; assert.equal(det.check()?.kind, 'dig', 'stuck dig beyond scaled digTime still triggers')

  bot.pathfinder.isMining = () => false
  bot.targetDigBlock = null
  bot.pathfinder.isBuilding = () => true
  t = 23000; assert.equal(det.check(), null)
  t = 27000; assert.equal(det.check(), null)
  // Building stops briefly then restarts: buildT must have reset so it gets a fresh 6s window.
  bot.pathfinder.isBuilding = () => false
  t = 27100; det.check()
  bot.pathfinder.isBuilding = () => true
  t = 31000; assert.equal(det.check(), null, 'buildT reset after placement stopped')
  t = 37500; assert.equal(det.check()?.kind, 'still', 'continuous stalled build still triggers')
})

test('waterBridge cost model supports partial bridge + jump/swim and uses steady blocks with speed-scaled sneak', async () => {
  assert.equal(bridgeWorth({ water: 4, shore: true, blocks: 2 }), true, '2 blocks + 2-block jump beats swimming 4')
  assert.equal(bridgeWorth({ water: 8, shore: true, blocks: 6 }), true, '6 blocks + 2-block jump beats swimming 8')
  assert.equal(bridgeWorth({ water: 8, shore: true, blocks: 5 }), false, '5 blocks + wet transition + 3 swim loses to 8 swim')
  assert.equal(bridgeWorth({ water: 20, shore: true, blocks: 12 }), true, '12 blocks + 8 swim saves time over 20 swim')

  const buildMod = require('../src/build')
  const prevPick = buildMod.pickFiller, prevPlace = buildMod.placeBlockAt
  const pickCalls: any[] = [], placeCalls: any[] = [], sneakLog: Array<{ left: number; sneak: boolean }> = []
  buildMod.pickFiller = (_bot: any, opts: any) => { pickCalls.push(opts); return { name: 'sandstone', count: 8 } }
  buildMod.placeBlockAt = async (_bot: any, _cell: any, opts: any) => { placeCalls.push(opts); return { ok: true } }
  try {
    const bot: any = {
      food: 20,
      entity: { position: new Vec3(0.2, 64, 0.5), velocity: new Vec3(0.28, 0, 0), isInWater: false },
      blockAt: (p: Vec3) => {
        const x = Math.floor(p.x), y = Math.floor(p.y)
        const name = y === 63 ? (x === 0 ? 'stone' : x === 1 ? 'water' : 'stone') : 'air'
        return { name, position: p.floored(), boundingBox: name === 'stone' ? 'block' : 'empty' }
      },
      look: async () => {},
      setControlState: (k: string, v: boolean) => { if (k === 'sneak') sneakLog.push({ left: 1 - bot.entity.position.x, sneak: v }) }
    }
    let ticks = 0
    const res = await waterBridge(bot, { aborted: false }, -Math.PI / 2, {
      maxBlocks: 1,
      sleep: async () => { ticks++; bot.entity.position.x += 0.25 }
    })
    assert.equal(res.placed, 1)
    assert.equal(pickCalls[0]?.steady, true, 'pickFiller must request steady blocks')
    assert.equal(placeCalls[0]?.steady, true)
    assert.equal(placeCalls[0]?.honest, true)
    assert.equal(placeCalls[0]?.exactAim, true)
    assert.ok(sneakLog.some(s => s.left > 0.5 && s.sneak), 'high forward speed engages sneak earlier than 0.45')
    assert.ok(ticks > 0)
  } finally {
    buildMod.pickFiller = prevPick
    buildMod.placeBlockAt = prevPlace
  }
})

test('stepSafe sweeps intermediate water moats, lava strips, and deep drops along me -> p', () => {
  const makeBot = (cellAt: (x: number, y: number, z: number) => string) => ({
    entity: { position: new Vec3(0.5, 64, 0.5) },
    physics: { playerHalfWidth: 0.3, playerHeight: 1.8 },
    blockAt: (p: Vec3) => {
      const f = p.floored()
      const name = cellAt(f.x, f.y, f.z)
      return { name, position: f, boundingBox: name === 'stone' ? 'block' : 'empty' }
    }
  })
  // 1-block water moat at x=1, solid stone at x=0 and x=2: reach=2 lands on stone at x=2.5.
  const moatBot = makeBot((x, y) => y < 63 ? 'stone' : y === 63 ? (x === 1 ? 'water' : 'stone') : 'air')
  assert.equal(stepSafe(moatBot, { x: 1, z: 0 }, { water: false, reach: 2.0 }), false, 'intermediate moat rejected with water:false')
  assert.equal(stepSafe(moatBot, { x: 1, z: 0 }, { water: true, reach: 2.0 }), true, 'intermediate moat allowed when water:true')

  // 1-block lava trench at x=1: endpoint x=2.5 is solid stone.
  const lavaBot = makeBot((x, y) => y < 63 ? 'stone' : y === 63 ? (x === 1 ? 'lava' : 'stone') : 'air')
  assert.equal(stepSafe(lavaBot, { x: 1, z: 0 }, { water: true, reach: 2.0 }), false, 'intermediate lava trench rejected')

  // 5-block deep pit at x=1: endpoint x=2.5 is solid stone.
  const pitBot = makeBot((x, y) => x === 1 ? (y < 58 ? 'stone' : 'air') : (y < 64 ? 'stone' : 'air'))
  assert.equal(stepSafe(pitBot, { x: 1, z: 0 }, { water: true, reach: 2.0 }), false, 'intermediate >3-block pit rejected')
})

test('wrapPlaceBlock recomputes fresh aim synchronously on minor mid-jump motion instead of throwing place_error', async () => {
  const bot: any = new EventEmitter()
  const ref = new Vec3(0, 0, 0), dest = ref.offset(0, 1, 0)
  let placed = false
  const packets: Array<{ name: string; data: any }> = []
  bot.registry = data; bot.entities = {}; bot.game = { dimension: 'overworld' }
  bot.entity = { id: 1, name: 'player', position: new Vec3(0.5, 2.05, 0.5), width: 0.6, height: 1.8, onGround: false, yaw: 0, pitch: 0 }
  bot.heldItem = { name: 'cobblestone', type: data.itemsByName.cobblestone.id }
  bot.inventory = { items: () => [bot.heldItem], slots: [] }
  bot.blockAt = (p: Vec3) => {
    const at = p.floored()
    const name = at.equals(ref) ? 'stone' : placed && at.equals(dest) ? 'cobblestone' : 'air'
    const b = Block.fromStateId(data.blocksByName[name].defaultState); b.position = at; return b
  }
  // Simulate slight upward/lateral motion during lookAt while still clear of dest and facing ref.
  bot.lookAt = async () => { bot.entity.position.x = 0.55; bot.entity.position.y = 2.15 }
  bot.waitForTicks = async () => {}; bot.swingArm = () => {}
  bot.supportFeature = (name: string) => name === 'blockPlaceHasInsideBlock'
  bot._client = {
    write: (name: string, packet: any) => {
      packets.push({ name, data: packet })
      if (name === 'block_place') placed = true
    }
  }
  require('mineflayer/lib/plugins/generic_place')(bot)
  tuneMovements(bot, {})
  await bot.placeBlock(bot.blockAt(ref), new Vec3(0, 1, 0))
  assert.equal(placed, true, 'minor mid-jump drift must place cleanly')
  assert.ok(packets.some(p => p.name === 'look'), 'look synced for shifted position')
  assert.ok(packets.some(p => p.name === 'block_place'), 'block_place sent')
})

test('clutch accepts steady ARENA_FILLER under ND_SCAFFOLD_ANY=1 (rejecting falling sand) and plans/fires cobweb clutch', () => {
  const prev = process.env.ND_SCAFFOLD_ANY
  process.env.ND_SCAFFOLD_ANY = '1'
  try {
    assert.equal(isFiller('sandstone'), true)
    assert.equal(isFiller('smooth_quartz'), true)
    assert.equal(isFiller('stone_bricks'), true)
    assert.equal(isFiller('sand'), false, 'falling sand must never be used for clutch')
    assert.equal(isFiller('red_sand'), false)
    assert.equal(isFiller('gravel'), false)
    const slots: any[] = []
    slots[36] = { name: 'sand', count: 64, slot: 36 }
    slots[37] = { name: 'smooth_sandstone', count: 16, slot: 37 }
    assert.equal(selectBlock(slots)?.name, 'smooth_sandstone')

    // Cobweb-only clutch: plan + fire succeeds without full-cube rejection.
    const cells = new Map<string, any>()
    const mk = (name: string, p: Vec3) => { const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p.floored(); return b }
    const world = { getBlock: (p: Vec3) => cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || mk(p.y < 0 ? 'stone' : 'air', p) }
    const physics = Physics(data, world)
    const api = createClutch({ Vec3, faceAim: pick.faceAim, simulate: (s: any, w: any) => physics.simulatePlayer(s, w), makeBlock: (p: Vec3, id?: number) => {
      const b = Block.fromStateId(id ?? data.blocksByName.cobblestone.defaultState, 0); b.position = p.floored(); return b
    } })
    const st: any = {
      pos: new Vec3(0.5, 2.6, 0.5), vel: new Vec3(0, -0.8, 0), onGround: false, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, jumpTicks: 0, jumpQueued: false,
      fireworkRocketDuration: 0, attributes: {}, yaw: 0, pitch: 0,
      control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
      jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
    }
    const plan = api.plan({
      state: st, world, peak: 20, blockCount: 1, maxBlocks: 1, cobweb: true,
      blockFor: (cell: Vec3) => mk('cobweb', cell)
    })
    assert.ok(plan && plan.cobweb, 'cobweb plan should be found above floor')
    assert.equal(plan.fall, 0)

    // Verify full guard step + fire places cobweb on move event.
    const bot: any = new EventEmitter()
    let placedCalls = 0
    const invSlots: any[] = Array(46).fill(null)
    invSlots[36] = { name: 'cobweb', count: 2, slot: 36 }
    Object.assign(bot, {
      registry: data, health: 20, quickBarSlot: 0, entities: {},
      game: { dimension: 'overworld', gameMode: 'survival' },
      entity: { id: 1, position: new Vec3(0.5, 2.6, 0.5), velocity: new Vec3(0, -0.8, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
      inventory: { slots: invSlots, items: () => [invSlots[36]] },
      world: { setBlockStateId: (p: Vec3, id: number) => { const b = Block.fromStateId(id, 0); b.position = p.floored(); cells.set(`${b.position.x},${b.position.y},${b.position.z}`, b) } },
      blockAt: (p: Vec3) => world.getBlock(p),
      physics,
      getControlState: () => false, setControlState: () => {}, setQuickBarSlot: () => {},
      look: async () => {},
      _client: { write: () => {} },
      _genericPlace: async () => { placedCalls++ }
    })
    const g = openGuard({ bot }, {
      Vec3, PlayerState: function (_b: any, c: any) { return { ...st, pos: bot.entity.position.clone(), vel: bot.entity.velocity.clone(), control: c } },
      faceAim: pick.faceAim, hand: { hold: () => {}, as: (fn: () => void) => fn(), on: () => false },
      makeBlock: (p: Vec3, id?: number) => { const b = Block.fromStateId(id ?? data.blocksByName.cobblestone.defaultState, 0); b.position = p.floored(); return b }
    })
    g.st.peak = 20
    g.st.expire = () => {}
    const dec = clutchStep(g)
    assert.equal(dec.action, 'clutch')
    assert.ok(g.scheduled?.cobweb, 'guard-step scheduled cobweb placement')
    bot.emit('move')
    assert.equal(placedCalls, 1, 'guard-fire must place non-cube cobweb')
    assert.equal(g.st.flight?.cobweb, true)
  } finally {
    if (prev === undefined) delete process.env.ND_SCAFFOLD_ANY; else process.env.ND_SCAFFOLD_ANY = prev
  }
})

test('COMMANDED_ESCAPE unification + pearl_to stop protection + wing_orbit hazard yielding', async () => {
  for (const name of ['lava_escape', 'clear_water', 'boost_lance', 'boost_shot', 'pearl_ambush', 'pearl_trap', 'pearl_test_up', 'jump_down', 'wing_orbit', 'cut_ally_web']) {
    assert.equal(COMMANDED_ESCAPE.test(name), true, `${name} must be in COMMANDED_ESCAPE`)
  }
  const flyingSession: any = { bot: { entity: { elytraFlying: true } }, current: { name: 'wing_orbit', ctl: { aborted: false } } }
  assert.equal(commandedEscape(flyingSession, tacticalState({ incomingProjectiles: 1 })), true)
  assert.equal(commandedEscape(flyingSession, tacticalState({ explosion: true })), false)
  assert.equal(commandedEscape(flyingSession, tacticalState({ burning: true, water: true })), false)
  flyingSession.bot.entity.elytraFlying = false
  assert.equal(commandedEscape(flyingSession, tacticalState({ incomingProjectiles: 1 })), false)

  let stopped = false
  const session: any = {
    current: { name: 'pearl_to', params: { rescue: true }, ctl: { aborted: false } },
    stop: async () => { stopped = true; return { status: 'done' } }
  }
  const rpc = intentMethods({ session, bus: { drain: () => [] }, vision: { close: async () => {} } } as any)
  const res: any = await rpc.stop()
  assert.equal(stopped, false, 'stop must not cancel active pearl_to rescue')
  assert.match(res.detail.ignored, /жемчугом/)
})

test('TacticalArbiter never self-restarts identical action on escalation, gates sealed on validity, and TacticalSystem filters onDamage', () => {
  const arbiter = new TacticalArbiter()
  // UseFireResistance running at L3 (hotFloor, low hp) -> escalates to L4 (lava): must NOT self-restart!
  const magma = tacticalState({ health: 8, hotFloor: true, fireResistancePotion: true })
  const first = arbiter.decide(magma)
  assert.equal(first.selected?.id, 'UseFireResistance')
  const inLava = arbiter.decide({ ...magma, at: 300, lava: true })
  assert.equal(inLava.selected?.id, 'UseFireResistance')
  assert.equal(inLava.change, false, 'L3->L4 escalation must not restart UseFireResistance mid-drink')

  // sealed must NOT keep BlockOff when playerFoe / drowning / blocks=0 without cover invalidates it.
  const boxArbiter = new TacticalArbiter()
  const foe = { id: 2, kind: 'zombie', distance: 5, player: false, threatening: true, hit: 2 }
  assert.equal(boxArbiter.decide(tacticalState({ contact: true, canFight: false, enemies: [foe], shelter: 'BlockOff', blocks: 8 })).selected?.id, 'BlockOff')
  const playerShowsUp = boxArbiter.decide(tacticalState({ at: 200, contact: true, canFight: false, enemies: [{ id: 9, kind: 'Player', distance: 5, player: true, threatening: true, hit: 4 }], shelter: null, blocks: 8 }))
  assert.notEqual(playerShowsUp.selected?.id, 'BlockOff', 'sealed must not resurrect BlockOff against a player foe')

  // onDamage filters strictly to bot.entity.id
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 10, position: new Vec3(0.5, 64, 0.5) }
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.inventory = { slots: [], items: () => [] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.clearControlStates = () => {}
  let observes = 0
  const session: any = { bot, current: null, reflex: null, bus: { emit: () => {} } }
  const sys = new TacticalSystem(session, { observe: () => { observes++; return tacticalState() }, record: () => {} })
  sys.attach(bot)
  try {
    bot._client.emit('damage_event', { entityId: 99, sourceTypeId: 0 })
    assert.equal(observes, 0, 'foreign entity damage_event must not trigger observeTactics')
    bot._client.emit('damage_event', { entityId: 10, sourceTypeId: 0 })
    assert.equal(observes, 1, 'own entity damage_event triggers observeTactics')
  } finally { sys.detach() }
})

test('EscapeProgress does not mark completed stationary shelters as failed', () => {
  const ep = new EscapeProgress()
  const obs = { at: 0, position: { x: 0, y: 64, z: 0 }, threatDistance: 3, exits: 'wall', available: true, actions: ['BlockOff', 'Hide', 'DigDown'] as any }
  for (const act of ['BlockOff', 'Hide', 'DigDown'] as const) {
    ep.begin(act, obs)
    ep.finish(act, { ...obs, at: 2000 }, 'completed')
    const state = ep.observe({ ...obs, at: 2000 })
    assert.equal(state.exhausted, false, `${act} completed in place must not exhaust escapes`)
    assert.deepEqual(state.failed, [])
  }
  ep.begin('BlockOff', obs)
  ep.finish('BlockOff', { ...obs, at: 3000 }, 'failed')
  assert.deepEqual(ep.observe({ ...obs, at: 3000 }).failed, ['BlockOff'])
})

test('stale _tacticalLavaClimbGoal clears on dry escape away from target or dimension change', () => {
  const goal = { at: new Vec3(0.5, 65, 0.5), deadline: gameClock.now() + 12000, startY: 60, placed: 1, dimension: 'the_nether' }
  const bot: any = {
    health: 20,
    game: { dimension: 'the_nether' },
    entity: { position: new Vec3(12.5, 65, 0.5), onGround: true, isInLava: false, effects: {} },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  }
  const session: any = { bot, _tacticalLavaClimbGoal: goal }
  assert.equal(syncLavaClimbGoal(session), null, 'escaping onto dry land >4 bl away clears climb goal')
  assert.equal(session._tacticalLavaClimbGoal, undefined)

  session._tacticalLavaClimbGoal = { ...goal }
  bot.entity.position = new Vec3(0.5, 63, 0.5)
  bot.game.dimension = 'overworld'
  assert.equal(lavaCapabilities(session).climb, false)
  assert.equal(session._tacticalLavaClimbGoal, undefined, 'dimension transfer clears stale lava climb goal')
})

test('actionableInstantBlasts scope precedence, observeTactics instant blasts, and monotonic dodgeBlast until', async () => {
  const clock = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  try {
    const pos = new Vec3(3, 64, 0)
    const cells = new Map<string, number>([[pos.toString(), Block.fromProperties(data.blocksByName.respawn_anchor.id, { charges: 1 }, 0).stateId]])
    const bot: any = Object.assign(new EventEmitter(), {
      game: { dimension: 'overworld', gameMode: 'survival' }, registry: data, username: 'Bot', health: 20, food: 20, version: '1.21.11',
      _ndFoes: [], // empty _ndFoes must NOT shadow explicit enemies!
      entity: { id: 1, username: 'Bot', position: new Vec3(0.5, 64, 0.5), height: 1.8, eyeHeight: 1.62, width: 0.6, onGround: true, yaw: 0, pitch: 0, effects: {}, metadata: [] },
      entities: {}, players: {}, inventory: { slots: [], items: () => [] },
      blockAt: (p: Vec3) => { const f = p.floored(); const b = Block.fromStateId(cells.get(f.toString()) ?? (f.y < 64 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState), 0); b.position = f; return b },
      findBlocks: ({ matching }: any) => [...cells.keys()].map(k => new Vec3(...(k.slice(1, -1).split(',').map(Number) as [number, number, number]))).filter(p => bot.blockAt(p).type === matching)
    })
    const enemy: any = { id: 2, type: 'player', username: 'Miner', isValid: true, position: new Vec3(4.5, 64, 0.5), height: 1.8, width: 0.6, yaw: 0, pitch: 0, metadata: [], equipment: [] }
    bot.entities[2] = enemy
    bot.players.Miner = { entity: enemy, gamemode: 0 }

    assert.equal(actionableInstantBlasts(bot, ['Miner']).length, 1, 'explicit enemies overrides empty bot._ndFoes')
    bot._ndFoes = undefined
    assert.equal(actionableInstantBlasts(bot).length, 1, 'missing scope defaults to null (detects non-ally players)')

    const session: any = { bot, bus: { emit: () => {} }, _ndFoes: ['Miner'] }
    const st = observeTactics(session)
    assert.equal(st?.explosion, true, 'observeTactics detects actionable respawn_anchor')
    assert.equal(st?.blast, 'respawn_anchor')

    // Monotonic until in dodgeBlast when a second later-lit TNT appears after the first expires.
    cells.clear(); delete bot.entities[2]; bot.players = {}
    const tnt1: any = { id: 10, name: 'tnt', position: new Vec3(3.5, 64, 0.5), isValid: true, metadata: [] }
    const fuseIdx = data.entitiesByName.tnt.metadataKeys.indexOf('fuse')
    tnt1.metadata[fuseIdx] = 4 // expires quickly -> initial until = 4*50 + 1000 = 1200ms
    bot.entities[10] = tnt1
    bot.pathfinder = { setGoal: () => {} }
    bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
    bot.setControlState = () => {}
    let step = 0
    const run = dodgeBlast({ bot }, { aborted: false, onAbort: [] })
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setImmediate(r))
      step++
      clock.advanceTicks(2)
      if (step === 6) {
        delete bot.entities[10]
        const tnt2: any = { id: 11, name: 'tnt', position: new Vec3(3.5, 64, 0.5), isValid: true, metadata: [] }
        tnt2.metadata[fuseIdx] = 60 // newly lit TNT -> extends until past 1200ms!
        bot.entities[11] = tnt2
      }
      if (step === 20) delete bot.entities[11] // cleared at t=2000ms (past original 1200ms bound!)
    }
    const res = await run
    assert.equal(res.ended, 'clear', 'second newly lit TNT extended until past first TNT bound')
    assert.ok(res.seconds >= 1.8)
  } finally {
    clock.dispose()
    gameClock.activate(null)
  }
})

test('refuge breakAway does not throw TypeError when a.nearest is null under elevated owRanged fire', async () => {
  const holdOut = require('../src/survival/hold-out')
  const prevLook = holdOut.refugeLook, prevChoose = holdOut.chooseRefuge, prevOutrun = holdOut.outrun
  const prevBuildMs = holdOut.buildMsOf, prevTakeBox = holdOut.takeBox, prevHoldOut = holdOut.holdOut, prevLeaveBox = holdOut.leaveBox
  const fleeMod = require('../src/flee')
  const prevFlee = fleeMod.smartFlee, prevHostiles = fleeMod.hostilesAround
  const fortify = require('../src/fortify')
  const prevLanded = fortify.landed
  let ranFlee = 0
  const steps: string[] = []
  try {
    fortify.landed = async () => {}
    holdOut.refugeLook = () => ({
      dim: 'overworld', nether: false, water: false, lava: false, foes: 1, walkers: 0, shooters: 1,
      nearest: null, creeper: null, foeClose: true, blocks: 16, filler: 'cobblestone', pickaxe: true, canBreakOut: true,
      hole: null, pillar: null, pocket: 0, cell: { blocks: 4, walls: 0, dist: 0, cell: new Vec3(0, 64, 0) }, niche: null,
      owRanged: { health: 6, shots: [{ hit: 4, everyMs: 1000 }], meleeEtaMs: Infinity }, ms: 1
    })
    holdOut.chooseRefuge = () => ({ how: 'box', why: 'box' })
    holdOut.outrun = (_a: any, _how: string) => ranFlee === 0
    holdOut.buildMsOf = () => 2000
    holdOut.takeBox = async () => null
    holdOut.holdOut = async () => ({ why: 'healed', ate: [] })
    holdOut.leaveBox = async () => ({ ok: true })
    fleeMod.hostilesAround = () => []
    fleeMod.smartFlee = async () => { ranFlee++; return { mode: 'оторвался', ran: 6, cornered: true } }

    const bot: any = {
      health: 16, food: 20,
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
      inventory: { items: () => [], slots: [] },
      pathfinder: { setGoal: () => {} },
      clearControlStates: () => {}
    }
    const session: any = { bot, journal: { append: () => {} }, playPolicy: { mode: 'other' } }
    const out: any = { how: 'none', code: 'OK', hp0: 6, steps: [] }
    await refugeBody(session, { aborted: false, onAbort: [] }, {
      t0: gameClock.now(), minHp: 16, deadline: gameClock.now() + 10000, out,
      step: (s: string) => steps.push(s), hurts: []
    })
    assert.ok(ranFlee >= 1, 'breakAway ran smartFlee without crashing on null nearest')
    assert.ok(steps.some(s => /обстрел/.test(s)), 'logged ranged fire step safely')
  } finally {
    holdOut.refugeLook = prevLook; holdOut.chooseRefuge = prevChoose; holdOut.outrun = prevOutrun
    holdOut.buildMsOf = prevBuildMs; holdOut.takeBox = prevTakeBox; holdOut.holdOut = prevHoldOut; holdOut.leaveBox = prevLeaveBox
    fleeMod.smartFlee = prevFlee; fleeMod.hostilesAround = prevHostiles; fortify.landed = prevLanded
  }
})

const mkNode = (x: number, y: number, z: number) => Object.assign(new Vec3(x, y, z), { toBreak: [], toPlace: [], parkour: false })

test('gotoGoal stagnant-frontier early commit caps arena A* timeout without cutting improving or small searches', async () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  let moving = true
  bot.pathfinder = {
    goal: null,
    isMoving: () => moving,
    isMining: () => false,
    isBuilding: () => false,
    canMove: () => true,
    setGoal(g: any) { this.goal = g; bot.emit('goal_updated', g) }
  }
  const goal = { isEnd: () => false }
  const walk = gotoGoal(bot, goal, { boundedArena: true })
  walk.catch(() => {})
  const root = { data: mkNode(0.5, 64, 0.5), parent: null }
  const n1 = mkNode(1.5, 64, 0.5), n2 = mkNode(2.5, 64, 0.5)
  const best = { data: n2, h: 20, parent: { data: n1, h: 21, parent: root } }
  const context: any = { bestNode: best, timeout: 5000, closedDataSet: { size: 1500 } }
  try {
    // First partial establishes prefix and bestNode at t=100ms
    bot.emit('path_update', { status: 'partial', context, path: [n1, n2], visitedNodes: 120, time: 100 })
    assert.equal(context.timeout, 5000, 'small initial search must not be capped')
    // 23 stagnant ticks (<24) at visited=1400 still wait
    for (let i = 1; i <= 23; i++) {
      bot.emit('path_update', { status: 'partial', context, path: [n1, n2], visitedNodes: 1400 + i * 50, time: 100 + i * 50 })
    }
    assert.equal(context.timeout, 5000, 'before 24 stagnant ticks / 1200ms threshold, search continues')
    // 24th stagnant tick at stagMs=1200ms caps context.timeout cleanly
    bot.emit('path_update', { status: 'partial', context, path: [n1, n2], visitedNodes: 2600, time: 1300 })
    assert.equal(context.timeout, 1300, 'stagnant arena search caps context.timeout early')
    // Next tick emits timeout; bot finishes walking prefix cleanly
    bot.emit('path_update', { status: 'timeout', context, path: [n1, n2], visitedNodes: 2600, time: 1301 })
    moving = false
    bot.emit('physicsTick')
    await walk
  } finally {
    walk.cancel(); await walk.catch(() => {})
  }
})

test('gotoGoal preserves pathKeepAlive ndKeep marker near prefix and rebases when knocked >6 bl off prefix', async () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  let moving = true, setGoalCalls = 0
  bot.pathfinder = {
    goal: null,
    isMoving: () => moving,
    isMining: () => false,
    isBuilding: () => false,
    canMove: () => true,
    setGoal(g: any) { this.goal = g; setGoalCalls++; bot.emit('goal_updated', g) }
  }
  const goal = { isEnd: () => false }
  const walk = gotoGoal(bot, goal, { boundedArena: true })
  walk.catch(() => {})
  const root = { data: mkNode(0.5, 64, 0.5), parent: null }
  const n1 = mkNode(1.5, 64, 0.5), n2 = mkNode(2.5, 64, 0.5)
  const context: any = { bestNode: { data: n2, h: 10, parent: { data: n1, h: 11, parent: root } }, timeout: 5000 }
  try {
    bot.emit('path_update', { status: 'partial', context, path: [n1, n2], visitedNodes: 100, time: 40 })
    // Simulate pathKeepAlive prepending ndKeep on the next partial update while bot is near n1
    const keep: any = Object.assign(new Vec3(0.9, 64, 0.5), { toBreak: [], toPlace: [], parkour: false, ndKeep: true })
    bot.entity.position.set(0.9, 64, 0.5)
    const r2: any = { status: 'partial', context, path: [keep, n1, n2], visitedNodes: 200, time: 90 }
    bot.emit('path_update', r2)
    assert.equal(r2.path[0]?.ndKeep, true, 'ndKeep marker preserved across prefix splice so active walking avoids false stuck')
    assert.equal(r2.path[1], n1)
    // Consume ndKeep like native pathfinder does on the same tick
    r2.path.shift()
    // Now knock bot 10 blocks away from every node of prefix -> strips and rebases!
    bot.entity.position.set(12.5, 64, 0.5)
    const r3: any = { status: 'partial', context, path: [n1, n2], visitedNodes: 300, time: 140 }
    bot.emit('path_update', r3)
    assert.equal(r3.path.length, 0, 'far off-prefix grounded body strips stale prefix')
    assert.equal(r3.ndStripped, true)
    moving = false
    bot.emit('physicsTick')
    assert.equal(setGoalCalls, 2, 'off-prefix body immediately rebases search from actual position')
  } finally {
    walk.cancel(); await walk.catch(() => {})
  }
})

test('bounded arena goto caps thinkTimeout to 2000ms and restores previous budget on finish', async () => {
  const { Session } = require('../src/session')
  const { EventBus } = require('../src/events')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 120, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 }
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: Array(46).fill(null), items: () => [] }
  bot.blockAt = (p: Vec3) => ({ name: p.y < 120 ? 'stone' : 'air', boundingBox: p.y < 120 ? 'block' : 'empty', position: p.floored(), type: p.y < 120 ? 1 : 0, shapes: p.y < 120 ? [[0,0,0,1,1,1]] : [] })
  bot.clearControlStates = () => {}
  let observedThink = -1
  bot.pathfinder = {
    thinkTimeout: 5000,
    movements: { emptyBlocks: new Set([0]), canDig: true, scafoldingBlocks: [1] },
    isMoving: () => false,
    setMovements() {},
    setGoal(g: any) {
      if (g) {
        observedThink = this.thinkTimeout
        setImmediate(() => { bot.entity.position.set(2.5, 120, 0.5); bot.emit('goal_reached', g) })
      }
    }
  }
  const session: any = new Session({}, new EventBus(), { state: {}, append() {} })
  session.bot = bot
  session.require = () => bot
  session.underSky = () => false
  session.updateMovements = () => {}
  session.runIntent = async (_name: string, fn: any) => {
    const ctl = { aborted: false, onAbort: [] as any[] }
    try { return await fn(ctl) } finally { for (const f of ctl.onAbort) f() }
  }
  const res = await session.goto({ x: 2, y: 120, z: 0, range: 1, arena: { x: 0, y: 120, z: 0, r: 40, killY: 110 }, surface: false, pathWait: true, descent: false, pearl: false, unstuck: false })
  assert.ok(res.arrived, 'arena goto arrived')
  assert.equal(observedThink, 2000, 'bounded arena goto capped thinkTimeout to 2000ms')
  assert.equal(bot.pathfinder.thinkTimeout, 5000, 'previous thinkTimeout restored after bounded arena goto')
})

test('clutch prepare evicts low-priority/duplicate hotbar items and deduplicates no_bar_slot on unchanged hotbar', async () => {
  const { openGuard, prepare } = require('../src/clutch/guard-state')
  const prevSwap = process.env.ND_CLUTCH_SWAP
  delete process.env.ND_CLUTCH_SWAP
  let t = 0
  const mkGuard = (hotbar: string[], backpack: Array<{ name: string; count: number; slot: number }>, held = 0) => {
    const slots: any[] = Array(46).fill(null)
    hotbar.forEach((name, idx) => { slots[36 + idx] = { name, count: name === 'cooked_beef' && idx === 8 ? 2 : 16, slot: 36 + idx } })
    for (const it of backpack) slots[it.slot] = it
    const moves: Array<[number, number]> = []
    const events: any[] = []
    const bot: any = new EventEmitter()
    bot.quickBarSlot = held
    bot.inventory = { slots, items: () => slots.filter(Boolean) }
    bot.moveSlotItem = async (a: number, b: number) => { moves.push([a, b]) }
    bot.world = { setBlockStateId() {} }
    bot._genericPlace = async () => {}
    bot.physics = { simulatePlayer: () => {} }
    bot.blockAt = () => null
    bot.on('nd_clutch', (e: any) => events.push(e))
    const g = openGuard({ bot }, {
      Vec3, PlayerState: class {}, faceAim: () => null, makeBlock: () => null,
      hand: { as: (fn: any) => fn(), hold() {}, on: () => false },
      now: () => t
    })
    return { g, bot, moves, events }
  }
  try {
    // Pass 2: all 9 hotbar items match KEEP, arrow in slot 41 -> evicted for sandstone/cobblestone
    const a = mkGuard(['diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'bow', 'ender_pearl', 'arrow', 'water_bucket', 'cooked_beef', 'golden_apple'], [{ name: 'cobblestone', count: 32, slot: 10 }])
    t = 2000; prepare(a.g)
    await new Promise(r => setImmediate(r))
    assert.deepEqual(a.moves, [[10, 41]], 'arrow in hotbar evicted in pass 2')

    // Pass 3: all 9 high-priority KEEP, duplicate cooked_beef in slots 43 (16) and 44 (2) -> smaller duplicate slot 44 evicted
    const b = mkGuard(['diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'bow', 'ender_pearl', 'shield', 'water_bucket', 'cooked_beef', 'cooked_beef'], [{ name: 'cobblestone', count: 32, slot: 11 }])
    t = 4000; prepare(b.g)
    await new Promise(r => setImmediate(r))
    assert.deepEqual(b.moves, [[11, 44]], 'smaller duplicate cooked_beef stack evicted in pass 3')

    // Pass 1b: obsidian on hotbar + 8 unique high-priority KEEP -> upgrade obsidian slot 43 in place with cobblestone
    const c = mkGuard(['diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'bow', 'ender_pearl', 'shield', 'water_bucket', 'obsidian', 'golden_apple'], [{ name: 'cobblestone', count: 32, slot: 12 }])
    t = 6000; prepare(c.g)
    await new Promise(r => setImmediate(r))
    assert.deepEqual(c.moves, [[12, 43]], 'hotbar obsidian upgraded in place with backpack cobblestone')

    // True full hotbar of 9 unique high-priority KEEP -> emits no_bar_slot ONCE, not every second
    const d = mkGuard(['diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'bow', 'ender_pearl', 'shield', 'water_bucket', 'cooked_beef', 'golden_apple'], [{ name: 'cobblestone', count: 32, slot: 13 }])
    t = 8000; prepare(d.g)
    t = 9500; prepare(d.g)
    t = 11000; prepare(d.g)
    assert.equal(d.events.filter(e => e.what === 'no_bar_slot').length, 1, 'no_bar_slot emitted once for unchanged full hotbar')
    // Changing hotbar state allows re-evaluation (and new emit if still full)
    d.bot.inventory.slots[44] = { name: 'potion', count: 1, slot: 44 }
    t = 12500; prepare(d.g)
    assert.equal(d.events.filter(e => e.what === 'no_bar_slot').length, 2, 'hotbar change re-evaluates prepare')
  } finally {
    if (prevSwap === undefined) delete process.env.ND_CLUTCH_SWAP; else process.env.ND_CLUTCH_SWAP = prevSwap
  }
})
