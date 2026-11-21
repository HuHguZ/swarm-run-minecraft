import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { bodySource, transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'
import * as clock from '../src/game-clock'
import * as enemy from '../src/combat/enemy-wind'
import { windOutDecide } from '../src/combat/wind-out'
import { windPush } from '../src/mace/push'
import { throwAt } from '../src/throw'
import { hopTo } from '../src/pearl-hop'
import { swarmPositions, pearlToPosition } from '../src/swarm-position'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

function flatBot(extra: Map<string, string> = new Map()) {
  const world = {
    getBlock(p: Vec3) {
      const q = p.floored()
      const name = extra.get(`${q.x},${q.y},${q.z}`) ?? (q.y < 64 ? 'stone' : 'air')
      const block = Block.fromStateId(registry.blocksByName[name].defaultState)
      block.position = q
      return block
    }
  }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, username: 'Blue', health: 20, food: 20,
    game: { minY: -64, height: 384, gameMode: 'survival' },
    entity: { id: 1, username: 'Blue', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
      onGround: true, yaw: 0, pitch: 0, width: .6, height: 1.8, effects: {}, attributes: {}, metadata: [] },
    entities: {}, players: {}, quickBarSlot: 0,
    inventory: { slots: Array(46).fill(null), items: () => [] },
    _client: new EventEmitter(),
    blockAt: (p: Vec3) => world.getBlock(p),
    physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    getControlState: () => false, setControlState() {}, clearControlStates() {},
    setQuickBarSlot(s: number) { bot.quickBarSlot = s },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async () => {},
    activateItem() {}, deactivateItem() {}
  })
  return { bot, world }
}

test('windOutDecide refuses negative matchedProgress without exit/fall payoff, but permits actual exits', t => {
  const { bot } = flatBot()
  const foe: any = { id: 2, username: 'Red', type: 'player', isValid: true, position: new Vec3(6, 64, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, metadata: [], equipment: [] }
  bot.entities[2] = foe
  bot.players = { Red: { entity: foe, gamemode: 0 } }
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  const own = { id: 'Blue', position: { x: .5, y: 64, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }
  const arena = { x: 0, z: 0, r: 80, ellipse: { a: 77, b: 65 }, killY: 50 }
  let matchedProgress = -1.5
  let exited = false
  t.mock.method(enemy, 'planEnemyWind', () => ({
    target: 'Red', targetAt: foe.position, gameTick: 500, resistance: { lo: 0, hi: 0 }, tried: 1,
    fallThreat: false, repriceRim: false, earlyLift: false, lateLift: false, matchedProgress,
    shots: [{ thrower: 'Blue', fireDelay: 0, ticks: 4, from: new Vec3(.5, 65.62, .5), aim: foe.position,
      yaw: 0, pitch: 0, velocity: new Vec3(1.5, 0, 0), burst: foe.position, feet: foe.position }],
    baseline: { out: false, exited: false, progress: 0, ticks: null, position: foe.position, air: 0, clear: Infinity, reach: Infinity, outwardEffect: 0, fallDamage: 0 },
    nominal: { out: false, exited, progress: -1.5, ticks: null, position: foe.position, air: 0, clear: Infinity, reach: Infinity, outwardEffect: .1, fallDamage: 0 },
    worst: { out: false, exited: false, progress: -2, ticks: null, position: foe.position, air: 0, clear: Infinity, reach: Infinity, fallDamage: 0 }
  } as any))
  assert.equal(windOutDecide(bot, own, arena, 0), null, 'negative matchedProgress with no exit/fall payoff is refused')
  exited = true
  assert.equal(windOutDecide(bot, own, arena, 0)?.kind, 'out?', 'actual exit keeps priority')
  exited = false; matchedProgress = .5
  assert.equal(windOutDecide(bot, own, arena, 0)?.kind, 'chain', 'positive matchedProgress is accepted')
})

test('windAllyTailSafe catches pre-impact dispersion-cone FF and moving teammates crossing the flight lane', () => {
  const { bot } = flatBot()
  const from = new Vec3(.5, 65.62, .5)
  const velocity = new Vec3(1.5, 0, 0)
  const foe: any = { id: 2, username: 'Red', type: 'player', position: new Vec3(30.5, 64, .5), width: .6, height: 1.8 }
  const shot: enemy.EnemyWindShot = {
    thrower: 'Blue', fireDelay: 0, ticks: 20, from, aim: foe.position.offset(0, 1.4, 0),
    yaw: -Math.PI / 2, pitch: 0, velocity, burst: foe.position.offset(-.3, 1.4, 0), feet: foe.position
  }
  const collision = { blockAt: bot.blockAt, physics: bot.physics, game: bot.game } as any
  // Stationary ally 10 blocks in front of foe, 0.7 blocks off center — center ray misses, dispersion corner hits!
  const beside = { id: 'Ally1', position: { x: 20.5, y: 64, z: 1.2 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, eyeHeight: 1.62 }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [beside], collision, Infinity), false)
  // Same ally far off to the side is safe
  const clear = { id: 'Ally2', position: { x: 20.5, y: 64, z: 6.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, eyeHeight: 1.62 }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [clear], collision, Infinity), true)
  // Running ally starting off-lane at z=3.5 moving -z into the corridor at arrival tick ~13
  const crossing = { id: 'Ally3', position: { x: 20.5, y: 64, z: 3.5 }, velocity: { x: 0, y: 0, z: -.25 }, onGround: true, eyeHeight: 1.62 }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [crossing], collision, Infinity), false)
})

test('smashShield skips broken shield while axe-disabled and dodges instead of freezing', () => {
  const file = path.resolve(__dirname, '../src/combat/wind-out.js'), module = { exports: {} as any }
  const { bot } = flatBot()
  const shieldItem = { name: 'shield', count: 1 }
  bot.inventory.slots[45] = shieldItem
  bot.inventory.items = () => [shieldItem]
  bot._ndShieldDisabledUntil = 5000
  const controls: Record<string, boolean> = {}
  let activated = 0, deactivated = 0
  bot.setControlState = (k: string, v: boolean) => { controls[k] = v }
  bot.activateItem = () => { activated++ }
  bot.deactivateItem = () => { deactivated++ }
  const req = stubRequire(file, {
    '../game-clock': { now: () => 1000, wall: { monotonic: () => 0 } },
    '../mace/hands': { install() {}, windReady: () => false, windCooling: () => true, offWind: () => false, hotbarIndex: () => -1 },
    './enemy-wind': { installWindTracking() {}, windMotionFresh: () => true, windCollisionWorld: () => bot, planEnemyWind: () => null },
    '../threats': { smashes: () => [{ name: 'Red', ticks: 10, at: new Vec3(0.5, 64, 0.5), from: new Vec3(0.5, 74, 0.5) }] },
    '../flee': { runLength: () => ({ len: 4 }) },
    '../reflex-lock': { allowed: () => true, shieldHold: () => false },
    './shield': { SMASH_SHIELD_HORIZON: 25 }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const session: any = { bot, _ndFoes: ['Red'], _rescue: { arena: { x: 0, z: 0, r: 40 } } }
  module.exports.installWindOut(session)
  bot.emit('physicsTick')
  assert.equal(activated, 0, 'must not raise an axe-disabled shield')
  assert.equal(controls.sprint, true, 'must dodge out of the mace smash instead of freezing')
  assert.equal(controls.forward, true)
  assert.equal(deactivated, 0)
  bot.emit('end')
})

test('wind-out backs off repeated wind_relay_busy on a moving target and drops cold-start lag to 0 after fast plan', async () => {
  const file = path.resolve(__dirname, '../src/combat/wind-out.js'), module = { exports: {} as any }
  const { bot } = flatBot()
  let wallMs = 0
  const foe: any = { id: 2, username: 'Enemy', type: 'player', isValid: true, position: new Vec3(5, 64, .5),
    velocity: new Vec3(.1, 0, 0), onGround: true, width: .6, height: 1.8, metadata: [], equipment: [] }
  bot.entities[2] = foe
  bot.players = { Enemy: { entity: foe, gamemode: 0 } }
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0, frozen: false, disposed: false, observationNow: () => 1000 + wallMs, observationRate: () => 20 }
  const delays: number[] = [], bids: string[] = []
  const req = stubRequire(file, {
    '../game-clock': { now: () => 1000 + wallMs, wall: { monotonic: () => wallMs } },
    '../mace/hands': { install() {}, windReady: () => true, windCooling: () => false, offWind: () => true, hotbarIndex: () => 0, afterPacket: (_b: any, fn: any) => fn() },
    './enemy-wind-execute': { enemyWindReport: () => ({ ok: true, ready: true, report: { id: 'Blue', position: { ...bot.entity.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, eyeHeight: 1.62, gameTick: Number(bot.ndClock.age) + bot.ndClock.ticks } }) },
    './enemy-wind': { installWindTracking() {}, windMotionFresh: () => true, windCollisionWorld: () => bot,
      planEnemyWind: (_b: any, _f: any, _r: any, opts: any) => {
        delays.push(opts.delays[0])
        wallMs += 10
        return { targetAt: foe.position.clone(), gameTick: Number(bot.ndClock.age) + bot.ndClock.ticks,
          resistance: { lo: 0, hi: 0 }, earlyLift: true, lateLift: false, fallThreat: false, repriceRim: false, matchedProgress: 1.2,
          baseline: { out: false, exited: false, progress: 0, air: 0, outwardEffect: 0 },
          nominal: { out: false, exited: false, progress: 1.2, air: 0, outwardEffect: 1 },
          worst: { out: false, exited: false, progress: 0 },
          shots: [{ thrower: 'Blue', fireDelay: opts.delays[0], ticks: 4, from: new Vec3(.5, 65.62, .5), aim: foe.position, yaw: 0, pitch: 0, velocity: new Vec3(1.5, 0, 0), burst: foe.position, feet: foe.position }] }
      } },
    './ally-safety': { isAlly: () => false },
    '../pvp/last-seen': { seesPlayer: () => true },
    '../bow/track': { observedVelocity: () => ({ x: .1, y: 0, z: 0 }) },
    '../elytra/track': { gliding: () => false },
    '../threats': { smashes: () => [] }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const session: any = { bot, current: null, _rescue: { arena: { x: 0, z: 0, r: 80 } },
    _windRadio: async (bid: any) => { bids.push(bid.target); return undefined } }
  module.exports.installWindOut(session)
  for (let i = 0; i < 4; i++) {
    bot.ndClock.ticks += 2
    foe.position = foe.position.offset(.2, 0, 0)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    await Promise.resolve()
  }
  assert.equal(delays[0], 1, 'cold-start preserves initial lag=1')
  assert.equal(delays[1], 0, 'fast 10ms plan drops lag to 0 immediately instead of clinging to 40ms')
  assert.equal(bids.length, 2, 'repeated wind_relay_busy on same moving target backs off instead of hammering every tick')
  bot.emit('end')
})

test('enemyWindPlan tolerates a monotonic 2-tick catch-up jump and enemyWindExecute replans coordinated multi-shot chains', async () => {
  const file = path.resolve(__dirname, '../src/combat/enemy-wind-execute.js'), module = { exports: {} as any }
  let tick = 100
  const from = new Vec3(0, 65.62, 0), feet = new Vec3(6, 65, 0), burst = new Vec3(5.7, 66, 0)
  const shot1 = { thrower: 'Other', fireTick: 100, arrivalTick: 103, fireDelay: 0, ticks: 3, from, aim: feet.offset(0, 1, 0), feet, burst, velocity: new Vec3(1.5, 0, 0), yaw: 0, pitch: 0 }
  const shot2 = { thrower: 'Blue', fireTick: 102, arrivalTick: 106, fireDelay: 2, ticks: 4, from, aim: feet.offset(0, 1, 0), feet, burst, velocity: new Vec3(1.5, 0, 0), yaw: 0, pitch: 0 }
  const plan = { target: 'Red', targetAt: feet, gameTick: 100, resistance: { lo: 0, hi: 0 }, shots: [shot1, shot2], nominal: { progress: 3 }, baseline: { progress: 0 } }
  const foe: any = { id: 2, username: 'Red', position: feet, velocity: new Vec3(0, 0, 0), onGround: false, width: .6, height: 1.8, equipment: [] }
  const { bot } = flatBot()
  bot.players = { Red: { entity: foe } }
  bot.entities = { 2: foe }
  bot._ndThrown = new Map([[9, { name: 'wind_charge', owner: 99, p: from, observedAt: 1000 }]])
  bot.ndClock = Object.assign(new EventEmitter(), { get age() { return BigInt(tick) }, ticks: 0, serverTicks: 0, frozen: false, disposed: false })
  const calls: number[] = [], planOpts: any[] = []
  bot.activateItem = () => { calls.push(tick); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
  const req = stubRequire(file, {
    './team-wind': { ...require('../src/combat/team-wind'), worldTick: () => tick, windInside: () => true },
    './enemy-wind': { WIND_FORECAST_TICKS: 65,
      windCollisionWorld: () => ({ blockAt: bot.blockAt }),
      planEnemyWind: (_b: any, _e: any, _r: any, opts: any) => {
        planOpts.push(opts)
        return { ...plan, gameTick: tick, relayPrefix: opts.visiblePrefix ? 9 : undefined, shots: [{ ...shot2, fireDelay: 0, ticks: 4 }] }
      },
      installWindTracking() {}, windMotionFresh: () => true,
      enemyWindFrames: () => [{}], enemyWindShot: () => null,
      pendingWindHit: () => ({ id: 9, ticks: 2 }),
      observeOwnWindBurst: () => () => {},
      windTeamSafe: () => true, windReportAt: (_b: any, r: any) => ({ ...r, gameTick: tick }) },
    '../pvp/last-seen': { seesPlayer: () => true, createLastSeen: () => ({ observe: (e: any) => e, visible: () => true, close() {} }) },
    '../mace/hands': { install() {}, windCount: () => 4, windReady: () => true, hotbarIndex: () => 0, offWind: () => true, ensureHotbar: async () => true },
    '../reflex-lock': { owner: () => null },
    '../edges': { afterPacket: (_b: any, f: any) => setImmediate(f), worldOf: (w: any) => ({ getBlock: (p: Vec3) => w.blockAt(p) }) },
    '../pvp/search': { observedCollision: () => ({ blockAt: bot.blockAt }) },
    '../pick': { eyeHeight: () => 1.62 },
    '../game-clock': { now: () => tick * 50, wall: { monotonic: () => 1000, setTimeout: () => 1, clearTimeout() {} } }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const session: any = { bot, current: { name: 'fight', ctl: { aborted: false, onAbort: [] } } }
  const report = { id: 'Blue', position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 102 }
  // 1) Monotonic 2-tick jump (100 -> 102) succeeds instead of clock_sync_changed
  const planned = module.exports.enemyWindPlan(session, { target: 'Red', throwers: [report], allies: [report], arena: { x: 0, z: 0, r: 40 }, leadTicks: 4 })
  tick = 102; bot.ndClock.ticks = 2; bot.emit('physicsTick')
  const planRes = await planned
  assert.equal(planRes.ok, true, planRes.why)
  // 2) Coordinated 2-shot chain arriving 1 tick late (103 > fireTick 102) replans with visiblePrefix instead of aborting
  assert.equal(module.exports.enemyWindReport(session, { target: 'Red', coordination: 'chain2' }).ok, true)
  tick = 103
  const ctl = { aborted: false, onAbort: [] as (() => void)[], waitReflex: async () => {} }
  const execPromise = module.exports.enemyWindExecute(session, ctl, { plan, arena: { x: 0, z: 0, r: 40 }, allies: [report], coordination: 'chain2' })
  for (let i = 0; i < 10; i++) { await new Promise<void>(r => setImmediate(r)); tick++; bot.emit('physicsTick') }
  const execRes = await execPromise
  assert.equal(execRes.fired, true, execRes.why)
  assert.equal(planOpts.at(-1)?.visiblePrefix, true, 'multi-shot replan uses live _ndThrown prefix')
  assert.deepEqual(calls, [103])
  bot.emit('end')
})

test('windPush compensates shooter movement, leads airborne target Y, uses packetAim, and refuses shooting into walls', async () => {
  const { bot } = flatBot()
  const charge = { name: 'wind_charge', count: 8, slot: 36 }
  bot.inventory.slots[36] = charge
  bot.inventory.items = () => [charge]
  bot.heldItem = charge
  const fired: Array<{ yaw: number; pitch: number }> = []
  bot.activateItem = () => fired.push({ yaw: bot.entity.yaw, pitch: bot.entity.pitch })
  bot.entity.position = new Vec3(.5, 64, .5)
  bot.entity.yaw = 1.23; bot.entity.pitch = -.45
  bot._ndLaunchMovement = () => new Vec3(0, 0, .5) // Shooter moving +Z at 0.5 b/t
  const foe: any = { id: 2, username: 'Red', type: 'player', isValid: true,
    position: new Vec3(10.5, 66, .5), velocity: new Vec3(0, .4, 0), onGround: false, width: .6, height: 1.8 }
  bot.entities[2] = foe
  const run = async (extraBot = bot) => {
    const p = windPush(extraBot, foe, { vel: () => ({ x: 0, y: .4, z: 0 }) })
    await new Promise(r => setImmediate(r))
    extraBot.emit('physicsTick')
    extraBot.emit('ndMovementSent')
    return await p
  }
  const r = await run()
  assert.equal(r.fired, true, r.why)
  assert.equal(fired.length, 1)
  // Because shooter moves +Z at 0.5, launch yaw must steer toward -Z (atan2(-1, +dz) > -pi/2) to cancel lateral drift
  assert.ok(fired[0].yaw > -Math.PI / 2 + .15 && fired[0].yaw < 0, `expected lateral lead yaw > -pi/2, got ${fired[0].yaw}`)
  // Because airborne foe is above eye and rising (vy=+0.4), pitch must aim upward (> 0.1 rad)
  assert.ok(fired[0].pitch > .1, `expected upward Y-lead pitch > 0.1, got ${fired[0].pitch}`)
  // packetAim preserves original look after use_item
  assert.equal(bot.entity.yaw, 1.23)
  assert.equal(bot.entity.pitch, -.45)

  // Now put a solid stone wall between shooter (x=0.5) and foe (x=10.5) at x=5
  const wall = new Map<string, string>()
  for (let y = 64; y <= 72; y++) for (let z = -3; z <= 3; z++) wall.set(`5,${y},${z}`, 'stone')
  const blocked = flatBot(wall).bot
  blocked.inventory.slots[36] = charge
  blocked.inventory.items = () => [charge]
  blocked.heldItem = charge
  blocked.entity.position = new Vec3(.5, 64, .5)
  blocked._ndLaunchMovement = () => new Vec3(0, 0, 0)
  const rWall = await run(blocked)
  assert.equal(rWall.fired, false, 'windPush must not shoot into a blocking wall')
})

test('throwAt clears usingHeldItem on main-hand throws and aborts if held item changed before release', async () => {
  const { bot } = flatBot()
  const pearl = { name: 'ender_pearl', type: 1, slot: 36, count: 2 }
  bot.heldItem = pearl
  bot.inventory.slots[36] = pearl
  bot.inventory.items = () => [pearl]
  bot.world = { raycast: () => null }
  bot.activateItem = () => { bot.usingHeldItem = true }
  const p1 = throwAt(bot, null, { item: pearl, pick: () => ({ yaw: 0, pitch: 0, ticks: 5 }) })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(r => setImmediate(r))
  const r1 = await p1
  assert.equal(r1.thrown, true)
  assert.equal(bot.usingHeldItem, false, 'main-hand throw must clear usingHeldItem')

  // Swap held item away before afterPacket fires
  let used = 0
  bot.activateItem = () => { used++ }
  const p2 = throwAt(bot, null, { item: pearl, pick: () => {
    bot.heldItem = { name: 'netherite_sword', type: 2, slot: 37, count: 1 }
    return { yaw: 0, pitch: 0, ticks: 5 }
  } })
  bot.emit('physicsTick'); bot.emit('physicsTick'); bot.emit('ndMovementSent')
  await new Promise(r => setImmediate(r))
  const r2 = await p2
  assert.equal(r2.thrown, false, 'must cancel throw if held item swapped before release')
  assert.equal(used, 0)
})

test('pearl-hop waitTeleport honors abortIf immediately instead of stalling', async t => {
  const { bot } = flatBot()
  const pearl = { name: 'ender_pearl', count: 2 }
  bot.inventory.items = () => [pearl]
  let aborted = false
  t.mock.method(require('../src/throw'), 'throwAt', async () => {
    aborted = true
    return { thrown: true, ticks: 40 }
  })
  const t0 = Date.now()
  const res = await hopTo(bot, new Vec3(20.5, 64, .5), {
    maxHops: 1, reserve: 0, minGain: -999, hpSec: 0, mustArrive: true, walkSec: 999,
    abortIf: () => aborted, log() {}
  })
  const elapsed = Date.now() - t0
  assert.equal(res.stop, 'прервано')
  assert.ok(elapsed < 500, `aborted waitTeleport must exit promptly, took ${elapsed}ms`)
})

test('swarmHold races shield.wear() and webSmash() against interrupt and keeps coverAlly lane against closer melee foe', async () => {
  const file = path.resolve(__dirname, '../src/swarm-position-work.js')
  const load = (overrides: Record<string, any>) => {
    const module = { exports: {} as any }
    const req = stubRequire(file, overrides)
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${bodySource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
    return module.exports
  }
  const baseClock = () => {
    let time = 0
    return { now: () => time, sleep: async (ms: number) => { time += ms }, setTimeout: () => null, clearTimeout() {} }
  }

  // 1) shield.wear() hangs (not whileWebbed) — abort breaks out immediately
  {
    const { bot } = flatBot()
    const ctl: any = { aborted: false, onAbort: [] as (() => void)[], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
    const work = load({
      './game-clock': baseClock(),
      './combat': { makeShield: () => ({ wear: () => new Promise(() => {}), raise: async () => {}, blocking: () => false, close() {}, report: () => null, nativeUse: () => ({}) }) },
      './swarm-work': { directThreat: () => null }
    })
    const pending = work.swarmHold({ bot }, ctl, { seconds: 3, shield: true })
    await new Promise(r => setImmediate(r))
    ctl.abort()
    const r = await pending
    assert.equal(r.why, 'cancelled', 'normal shield hold must interrupt during shield.wear()')
  }

  // 2) webSmash() hangs — abort breaks out immediately
  {
    const { bot } = flatBot()
    const ctl: any = { aborted: false, onAbort: [] as (() => void)[], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
    const work = load({
      './game-clock': baseClock(),
      './mace/web': { webSmash: () => new Promise(() => {}) },
      './swarm-work': { directThreat: () => null }
    })
    const pending = work.swarmHold({ bot }, ctl, { seconds: 3, shield: false, whileSmash: 'Red', webSmash: 'Red' })
    await new Promise(r => setImmediate(r))
    ctl.abort()
    const r = await pending
    assert.equal(r.why, 'cancelled', 'swarmHold must interrupt during webSmash()')
  }

  // 3) coverAlly keeps screening archer whileDraw even when a closer melee foe is visible
  {
    const { bot } = flatBot()
    bot.entity.position = new Vec3(0, 64, 0)
    bot.inventory.slots[45] = { name: 'shield', count: 1 }
    const ally = { id: 2, username: 'Ward', type: 'player', position: new Vec3(-2, 64, 0), width: .6, height: 1.8, isValid: true }
    const melee = { id: 3, username: 'Melee', type: 'player', position: new Vec3(0, 64, 3), width: .6, height: 1.8, isValid: true }
    const archer = { id: 4, username: 'Archer', type: 'player', position: new Vec3(10, 64, 0), width: .6, height: 1.8, isValid: true }
    bot.entities = { 2: ally, 3: melee, 4: archer }
    bot.players = { Ward: { entity: ally, gamemode: 0 }, Melee: { entity: melee, gamemode: 0 }, Archer: { entity: archer, gamemode: 0 } }
    const looked: Vec3[] = []
    bot.lookAt = async (p: Vec3) => { looked.push(p) }
    const ctl: any = { aborted: false, onAbort: [] as (() => void)[] }
    const work = load({
      './game-clock': baseClock(),
      './pvp/last-seen': { seesPlayer: () => true, createLastSeen: () => ({ observe: (e: any) => e, close() {} }) },
      './combat': { makeShield: () => ({ wear: async () => true, raise: async () => {}, blocking: () => true, failure: () => null, close() {}, report: () => null, nativeUse: () => ({}) }) },
      './threats': { dangers: () => ({ aims: [{ name: 'Archer', weapon: 'bow' }], arrows: [] }) },
      './swarm-work': { directThreat: () => null }
    })
    const r = await work.swarmHold({ bot, current: { name: 'swarm_hold' } }, ctl, {
      seconds: .2, shield: true, whileDraw: 'Archer', coverAlly: 'Ward', allies: ['Ward']
    })
    assert.notEqual(r.why, 'cover_lane_lost', 'closer melee foe must not break coverAlly lane against whileDraw')
    assert.equal(r.ok, true)
    assert.ok(looked.length > 0 && looked.every(p => Math.abs(p.x - 10) < .1), 'must keep facing Archer, not Melee')
  }
})

test('swarmPositions recognizes spectral_arrow/tipped_arrow for build scoring and pearlToPosition bounds sync fallback', async t => {
  const { bot } = flatBot()
  bot.inventory.items = () => [{ name: 'dirt', count: 6 }, { name: 'bow', count: 1 }, { name: 'spectral_arrow', count: 8 }]
  const spectral = await swarmPositions(bot, { purpose: 'ranged', methods: ['build'], radius: 1, limit: 3, reserve: { dirt: 1 } })
  bot.inventory.items = () => [{ name: 'dirt', count: 6 }, { name: 'bow', count: 1 }, { name: 'arrow', count: 8 }]
  const normal = await swarmPositions(bot, { purpose: 'ranged', methods: ['build'], radius: 1, limit: 3, reserve: { dirt: 1 } })
  assert.ok(spectral.candidates.length > 0)
  assert.equal(spectral.candidates[0].score, normal.candidates[0].score, 'spectral_arrow scores identically to arrow on pillar/build')

  // Verify pearlToPosition synchronous fallback in pick() runs <=10 landing trials instead of 360
  const roof = new Map<string, string>()
  for (let x = 2; x <= 4; x++) for (let z = -1; z <= 1; z++) roof.set(`${x},75,${z}`, 'stone')
  const { bot: pBot } = flatBot(roof)
  const pearl = { name: 'ender_pearl', count: 4, slot: 36 }
  pBot.inventory.items = () => [pearl]
  pBot.heldItem = pearl
  // Prime observed terrain memory on the roof
  const start = pBot.entity.position.clone()
  pBot.entity.position = new Vec3(3.5, 76, .5)
  await swarmPositions(pBot, { purpose: 'build', radius: 3, methods: ['walk'] })
  pBot.entity.position = start
  let landingCalls = 0
  const proj = require('../src/throw') as typeof import('../src/throw')
  const origLanding = proj.landing
  t.mock.method(proj, 'landing', (...args: any[]) => { landingCalls++; return (origLanding as any)(...args) })
  t.mock.method(proj, 'throwAt', async (_b: any, _t: any, opts: any) => {
    landingCalls = 0
    // Pass impossible moved velocity so proposal.best fails and fallback runs
    opts.pick({ from: pBot.entity.position.offset(0, 1.52, 0), moved: new Vec3(5, 0, 5), airborne: false })
    return { thrown: false, why: 'test' }
  })
  await pearlToPosition({ bot: pBot }, { aborted: false, onAbort: [] }, { to: { x: 3.5, y: 76, z: .5 } })
  assert.ok(landingCalls <= 12, `sync pearlToPosition fallback must be bounded (<=10 trials), ran ${landingCalls}`)
})

test('windAllyTailSafe catches long-range dead-center allies between dispersion corners and diagonal walking allies', () => {
  const { bot } = flatBot()
  const collision: any = { blockAt: (p: Vec3) => bot.blockAt(p) }
  const foe: any = { id: 3, username: 'Enemy', type: 'player', position: new Vec3(70.5, 64, .5), width: .6, height: 1.8 }
  const shot: any = {
    thrower: 'A', fireDelay: 0, ticks: 46,
    from: new Vec3(.5, 65.52, .5),
    velocity: new Vec3(1.5, 0, 0),
    feet: new Vec3(70.5, 64, .5),
    aim: new Vec3(70.5, 64.9, .5),
    burst: new Vec3(70.5, 64.9, .5)
  }
  // 1) At t = 40 (x = 60.5), 8 dispersion corners are +-1.03 bl apart; centre ray catches dead-ahead ally.
  const deadCenter: any = { id: 'CenterAlly', position: new Vec3(60.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, eyeHeight: 1.62 }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [deadCenter], collision, Infinity), false,
    'dead-center ally at t=40 must not slip through the gap between the 8 dispersion corners')

  // 2) Walking ally starting off-beam crosses the midpoint at t* = 20 (x = 30.5, z = 0.5) on a diagonal goto.
  const diagonalWalker: any = {
    id: 'DiagAlly', position: new Vec3(33.5, 64, 3.5), velocity: new Vec3(-0.15, 0, -0.15), onGround: true, eyeHeight: 1.62,
    control: { forward: true, sprint: false }
  }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [diagonalWalker], collision, Infinity), false,
    'diagonally walking ally crossing the mid-flight beam at t* must be caught')

  // 3) Ally walking away from the beam stays safe.
  const walkingAway: any = {
    id: 'AwayAlly', position: new Vec3(33.5, 64, 3.5), velocity: new Vec3(0.15, 0, 0.15), onGround: true, eyeHeight: 1.62,
    control: { forward: true, sprint: false }
  }
  assert.equal(enemy.windAllyTailSafe(bot, foe, shot, [walkingAway], collision, Infinity), true,
    'ally walking away from the flight lane remains safe')
})

test('pitPearl confirms short forcedMove rescues during throwAt and allows side-wall hits above solid deck', async t => {
  const { pitPearl } = require('../src/combat/emergency-escape') as typeof import('../src/combat/emergency-escape')
  const proj = require('../src/throw') as typeof import('../src/throw')

  // 1) Short 2-tick rescue pearl emits forcedMove (1.8 bl jump < 3 bl threshold) DURING throwAt.
  {
    const { bot } = flatBot()
    bot.entity.position = new Vec3(10, 120.2, 10)
    bot.entity.velocity = new Vec3(0, -0.45, 0)
    const pearl = { name: 'ender_pearl', count: 2, slot: 36 }
    bot.inventory.items = () => [pearl]
    t.mock.method(proj, 'throwAt', async () => {
      bot.entity.position = new Vec3(11.6, 121.2, 10.6)
      bot.emit('forcedMove')
      return { thrown: true, ticks: 2, land: { tp: new Vec3(11.6, 121.2, 10.6) } }
    })
    const res: any = await pitPearl(bot, { aborted: false }, { killY: 113 })
    assert.equal(res.ok, true, 'short 2-tick forcedMove during throwAt must confirm rescue')
    assert.equal(res.pearl, true)
    assert.equal(bot.listenerCount('forcedMove'), 0, 'must clean up forcedMove listener')
  }

  // 2) Side-wall hit right above solid non-edge deck is accepted, while side hit over void is rejected.
  {
    const deck = new Map<string, string>()
    for (let x = 0; x <= 6; x++) for (let z = -3; z <= 3; z++) deck.set(`${x},120,${z}`, 'stone')
    deck.set('4,121,0', 'stone') // wall sitting on solid deck
    const { bot } = flatBot(deck)
    bot.blockAt = (p: Vec3) => {
      const f = p.floored()
      const name = deck.get(`${f.x},${f.y},${f.z}`) ?? 'air'
      const b = Block.fromStateId(registry.blocksByName[name].defaultState)
      b.position = f; return b
    }
    bot.entity.position = new Vec3(0.5, 121.5, 0.5)
    bot.entity.velocity = new Vec3(0, -0.4, 0)
    const pearl = { name: 'ender_pearl', count: 2, slot: 36 }
    bot.inventory.items = () => [pearl]

    let pickedSolid: any = null
    let pickedVoid: any = null
    t.mock.method(proj, 'throwAt', async (_b: any, _t: any, opts: any) => {
      pickedSolid = opts.pick({
        landing: (yaw: number, pitch: number) => Math.abs(yaw) < 1e-6 && Math.abs(pitch - 5 * Math.PI / 180) < 1e-6
          ? { tp: new Vec3(3.5, 121.4, 0.5), block: { position: new Vec3(4, 121, 0) }, ticks: 4, void: false }
          : { void: true }
      })
      pickedVoid = opts.pick({
        landing: (yaw: number, pitch: number) => Math.abs(yaw) < 1e-6 && Math.abs(pitch - 5 * Math.PI / 180) < 1e-6
          ? { tp: new Vec3(20.5, 121.4, 0.5), block: { position: new Vec3(21, 121, 0) }, ticks: 4, void: false }
          : { void: true }
      })
      return { thrown: false, why: 'test' }
    })
    await pitPearl(bot, { aborted: false }, { killY: 113 })
    assert.ok(pickedSolid, 'side-face hit directly above solid non-edge deck should be accepted')
    assert.equal(pickedVoid, null, 'side-face hit over open void must still be rejected')
  }
})

test('pearl-hop waitTeleport confirms short (< 2.5 bl) forcedMove packets and cleans up listener', async () => {
  const { waitTeleport } = require('../src/pearl-hop') as typeof import('../src/pearl-hop')
  const { bot } = flatBot()
  const from = new Vec3(0.5, 64, 0.5)
  bot.entity.position = from.clone()
  setTimeout(() => {
    bot.entity.position = new Vec3(2.0, 64.5, 0.5) // 1.58 bl < 2.5 bl
    bot.emit('forcedMove')
  }, 20)
  const ok = await waitTeleport(bot, from, 2000)
  assert.equal(ok, true, 'forcedMove must confirm short pearl teleport')
  assert.equal(bot.listenerCount('forcedMove'), 0, 'waitTeleport must remove forcedMove listener')
})

test('installWindOut multiplexes shot wait watchers without stacking physicsTick listeners across a rapid volley', t => {
  const { bot } = flatBot()
  bot._client.write = () => {}
  bot.activateItem = () => {}
  const charge = { name: 'wind_charge', count: 64, slot: 36 }
  bot.inventory.slots[45] = charge
  bot.inventory.items = () => [charge]
  let gameTick = 100
  bot.ndClock = { age: 0n, ticks: gameTick, serverTicks: 0, frozen: false, disposed: false, observationNow: () => gameTick * 50, observationRate: () => 20 }
  const foe: any = { id: 2, username: 'Target', type: 'player', position: new Vec3(12.5, 64, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, isValid: true, _ndVisible: true, metadata: [], equipment: [] }
  bot.players = { Target: { entity: foe, gamemode: 0 } }
  bot.entities = { 2: foe }
  const arena = { x: 0, z: 0, r: 16, killY: 50 }
  const session: any = { bot, current: { name: 'wing_orbit', ctl: { aborted: false } }, _rescue: { arena, killY: 50 } }
  const file = path.resolve(__dirname, '../src/combat/wind-out.js')
  const mod = { exports: {} as any }
  const shot = {
    thrower: 'Blue', fireDelay: 0, ticks: 35, yaw: 0, pitch: 0, aimHeight: 1,
    from: new Vec3(.5, 65.52, .5), velocity: new Vec3(1.5, 0, 0),
    feet: foe.position.clone(), aim: foe.position.offset(-0.5, 1, 0), burst: foe.position.offset(-0.5, 1, 0)
  }
  let ready = true
  const req = stubRequire(file, {
    '../mace/hands': {
      install() {}, windReady: () => ready, windCooling: () => false, offWind: () => true, hotbarIndex: () => 0,
      afterPacket: (_b: any, fn: () => void) => fn()
    },
    './enemy-wind-execute': {
      enemyWindReport: () => ({ ok: true, ready: true, report: { id: 'Blue', position: bot.entity.position.clone(), velocity: new Vec3(0, 0, 0), onGround: true, gameTick } })
    },
    './enemy-wind': {
      ...enemy,
      installWindTracking() {},
      windMotionFresh: () => true,
      enemyWindFrames: () => [{ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: true }],
      pendingWindHit: () => null,
      enemyWindShot: () => shot,
      windTeamSafe: () => true,
      windAllyTailSafe: () => true,
      observeOwnWindBurst: () => () => {},
      planEnemyWind: (_b: any, _f: any, _r: any, opts: any) => ({
        gameTick, shots: [{ ...shot, fireDelay: opts.delays[0] }], baseline: { out: false, progress: 0, air: 0, exited: false },
        nominal: { out: false, progress: 3, air: 2, exited: false, outwardEffect: 1 }, worst: { out: false, progress: 2, air: 1, exited: false },
        matchedProgress: 3, resistance: { lo: 0, hi: 0 }
      })
    },
    './ally-safety': { isAlly: () => false },
    '../pvp/last-seen': { seesPlayer: () => true },
    '../bow/track': { observedVelocity: () => ({ x: 0, y: 0, z: 0 }) },
    '../elytra/track': { gliding: () => false },
    '../threats': { smashes: () => [] }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${bodySource(file)}\n})`, { filename: file })(
    req, mod, mod.exports, file, path.dirname(file))
  t.after(() => bot.emit('end'))
  mod.exports.installWindOut(session)
  const baseline = bot.listenerCount('physicsTick')
  // Fire 6 consecutive rapid-volley shots while earlier shots' 35+8 tick wait watchers are still active.
  for (let i = 0; i < 6; i++) {
    gameTick += 2
    bot.ndClock.ticks = gameTick
    bot.emit('physicsTick')
    bot.emit('physicsTick')
    assert.equal(bot.listenerCount('physicsTick'), baseline, `shot #${i + 1} must not add any extra physicsTick listener`)
  }
  assert.equal(session._windOut.fired, 6, `all 6 rapid-volley shots should fire: ${JSON.stringify(session._windOut)}`)
  assert.equal(bot.listenerCount('physicsTick'), baseline)
  // Stop firing new shots and advance ticks to settle all 6 multiplexed watchers cleanly.
  ready = false
  for (let i = 0; i < 50; i++) { gameTick++; bot.ndClock.ticks = gameTick; bot.emit('physicsTick') }
  assert.equal(session._windOut.log.length, 6, 'all 6 multiplexed watchers must complete and log')
  assert.equal(bot.listenerCount('physicsTick'), baseline)
})
