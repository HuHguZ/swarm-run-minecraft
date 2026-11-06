import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { pushPlan } from '../src/mace/push'
import { aerialMethods } from '../src/rpc/aerial'
import * as sight from '../src/pvp/last-seen'
import * as safety from '../src/combat/wind-safety'
import * as clock from '../src/game-clock'
import * as hands from '../src/mace/hands'
import * as enemy from '../src/combat/enemy-wind'
import * as executor from '../src/combat/enemy-wind-execute'
import { installWindOut } from '../src/combat/wind-out'
import { worldTick } from '../src/combat/team-wind'

function fixture(distance = 10, count = 1, mace = false) {
  const wind = { name: 'wind_charge', count, slot: 36 }, items = count ? [wind, ...(mace ? [{ name: 'mace', count: 1, slot: 37 }] : [])] : []
  const uses: any[] = [], bot: any = Object.assign(new EventEmitter(), {
    health: 20, username: 'Blue', inventory: { slots: [], items: () => items }, quickBarSlot: 0, heldItem: wind,
    entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, metadata: [] },
    _client: new EventEmitter(), blockAt: p => ({ name: 'air', boundingBox: 'empty', shapes: [], position: p }),
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }, activateItem: () => uses.push(bot.entity.yaw),
    setQuickBarSlot: slot => { bot.quickBarSlot = slot }
  })
  bot.inventory.slots[36] = count ? wind : null
  const foe: any = { id: 2, username: 'Enemy', type: 'player', position: new Vec3(distance, 64, 0), width: .6, height: 1.8, isValid: true }
  Object.defineProperty(foe, 'health', { get() { throw Error('private enemy HP') } })
  bot.players = { Enemy: { entity: foe }, Ally: { entity: { id: 3, position: foe.position.offset(.5, 0, 0) } } }
  return { bot, foe, uses }
}

test('a useful offensive push can spend the last charge at close or long range with a mace in inventory', () => {
  for (const distance of [1, 16, 80]) for (const mace of [false, true]) {
    const f = fixture(distance, 1, mace)
    assert.equal(pushPlan(f.bot, f.foe, { busy: 'ест или пьёт' })?.why, 'ест или пьёт', `${distance}m, mace ${mace}`)
    assert.equal(pushPlan(f.bot, f.foe, { theyUp: true })?.why, 'со столба')
    assert.equal(pushPlan(f.bot, f.foe), null, 'no tactical benefit still means no gratuitous throw')
  }
})

test('offensive push still needs a charge, native cooldown, visible target and useful knockback', () => {
  const f = fixture()
  assert.equal(pushPlan(f.bot, f.foe, { sees: false, busy: 'ест' }), null)
  assert.equal(pushPlan(fixture(10, 0).bot, f.foe, { busy: 'ест' }), null)
  f.bot._ndWindCd = Infinity
  assert.equal(pushPlan(f.bot, f.foe, { busy: 'ест' }), null)
  f.bot._ndWindCd = 0; f.bot.blockAt = () => ({ name: 'cobweb' })
  assert.equal(pushPlan(f.bot, f.foe, { busy: 'ест' })?.why, 'ест', 'a useful wind action is not categorically banned by the target web')
})

for (const safe of [false, true]) test(`wind_push RPC uses actual shared safety for a nearby ally (${safe})`, async t => {
  const f = fixture(), checks: any[] = []
  t.mock.method(sight, 'createLastSeen', () => ({ observe: e => e, visible: () => true, close() {} }) as any)
  t.mock.method(safety, 'windReleaseSafe', (...args) => { checks.push(args); return safe })
  const session = { require: () => f.bot, runIntent: (_name, body) => body({ aborted: false }) }
  const pending = aerialMethods({ session } as any).wind_push({ target: 'Enemy', allies: ['Ally'], force: true })
  await new Promise(resolve => setImmediate(resolve)); f.bot.emit('physicsTick')
  const result = await pending
  assert.equal(result.fired, safe)
  assert.equal(checks.length, 1, 'proximity alone does not replace the native blast/corridor check')
  assert.equal(f.uses.length, Number(safe))
})

test('wind_push RPC cannot turn a hidden enemy into a forced throw', async t => {
  const f = fixture()
  t.mock.method(sight, 'createLastSeen', () => ({ observe: e => e, visible: () => false, close() {} }) as any)
  const session = { require: () => f.bot, runIntent: (_name, body) => body({ aborted: false }) }
  const result = await aerialMethods({ session } as any).wind_push({ target: 'Enemy', force: true })
  assert.equal(result.fired, false); assert.equal(f.uses.length, 0)
})

test('wind_push RPC rejects malformed explicit ally names', async t => {
  const f = fixture()
  t.mock.method(sight, 'createLastSeen', () => ({ observe: e => e, visible: () => true, close() {} }) as any)
  const session = { require: () => f.bot, runIntent: (_name, body) => body({ aborted: false }) }
  for (const allies of ['Ally', [{}], ['']]) {
    const result = await aerialMethods({ session } as any).wind_push({ target: 'Enemy', allies, force: true })
    assert.equal(result.fired, false)
  }
  assert.equal(f.uses.length, 0)
})

for (const web of [false, true]) for (const unsafe of [false, true]) test(`explicit RPC allies retain native corridor and blast safety without team configuration (unsafe ${unsafe}, web ${web})`, async t => {
  const f = fixture(), registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock(p) {
    const inWeb = web && Math.floor(p.x) === 10 && Math.floor(p.z) === 0 && p.y >= 64 && p.y < 66
    const b = Block.fromStateId(registry.blocksByName[inWeb ? 'cobweb' : p.y < 64 && p.x < 11 ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  } }
  Object.assign(f.bot, { version: '1.21.11', registry, game: { minY: -64, height: 384 }, food: 20,
    blockAt: p => world.getBlock(p), physics: require('../src/tick-plugins').getPhysics().Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, getControlState: () => false })
  Object.assign(f.foe, { velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, metadata: [], equipment: [] })
  const ally: any = { id: 3, username: 'Ally', type: 'player', name: 'player', isValid: true,
    // In the web case the original ally shares its drag, so put only that control at the actual support lip.
    position: unsafe ? new Vec3(web ? 11.29 : 10.5, 64, 0) : new Vec3(10, 64, 2.8), velocity: new Vec3(0, 0, 0),
    onGround: true, width: .6, height: 1.8, yaw: 0, metadata: [], equipment: [] }
  Object.defineProperty(ally, 'health', { get() { throw Error('private allied HP') } })
  f.bot.entities = { 1: f.bot.entity, 2: f.foe, 3: ally }; f.bot.players.Ally.entity = ally
  assert.equal(f.bot._ndSwarmAllies, undefined); assert.equal(f.bot.teamMap, undefined)
  assert.ok(ally.position.distanceTo(f.foe.position) < 3, 'both cases failed the old static proximity ban')
  t.mock.method(sight, 'createLastSeen', () => ({ observe: e => e, visible: () => true, close() {} }) as any)
  const session = { require: () => f.bot, runIntent: (_name, body) => body({ aborted: false }) }
  const pending = aerialMethods({ session } as any).wind_push({ target: 'Enemy', allies: ['Ally'], force: true })
  await new Promise(resolve => setImmediate(resolve)); f.bot.emit('physicsTick')
  const result = await pending
  assert.equal(result.fired, !unsafe, unsafe ? 'the actual splash would push the ally off the observed edge' : 'the nearby ally is outside the actual projectile and splash')
  assert.equal(f.uses.length, Number(!unsafe))
  assert.equal(f.bot._ndSwarmAllies, undefined, 'explicit names never mutate persistent team membership')
})

for (const condition of ['fresh', 'cooldown', 'pending', 'later pending', 'ally'] as const) test(`a fresh useful same-position wind plan after a miss retains ${condition} release conditions`, t => {
  const f = fixture(4, 64), { bot, foe } = f
  let now = 1000, useful = true, pending = false, safe = true, plans = 0
  Object.assign(foe, { onGround: true, yaw: 0, metadata: [], equipment: [] })
  bot.entities = { 2: foe }; bot.getControlState = () => false
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0, observationNow: () => now, observationRate: () => 20 }
  const session: any = { bot, current: null, _rescue: { arena: { x: 0, y: 0, z: 0, r: 80 } } }
  const own = () => ({ id: bot.username, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity },
    onGround: true, eyeHeight: 1.62, gameTick: worldTick(bot) })
  const shot = () => ({ thrower: bot.username, fireDelay: 0, ticks: 1, yaw: 0, pitch: 0,
    from: bot.entity.position.offset(0, 1.62, 0), aim: foe.position.offset(0, foe.yaw ? 1.6 : .4, 0), aimHeight: foe.yaw ? 1.6 : .4,
    feet: foe.position.clone(), burst: foe.position.offset(-.3, .4, 0), velocity: new Vec3(1.5, 0, 0) })
  t.mock.method(clock, 'now', () => now); t.mock.method(clock.wall, 'monotonic', () => 0)
  t.mock.method(hands, 'afterPacket', (_bot, callback) => callback())
  t.mock.method(executor, 'enemyWindReport', () => ({ ok: true, ready: hands.windReady(bot), report: own() }))
  t.mock.method(enemy, 'installWindTracking', () => {})
  t.mock.method(enemy, 'windMotionFresh', () => true)
  t.mock.method(enemy, 'windCollisionWorld', () => bot)
  t.mock.method(enemy, 'planEnemyWind', (_bot, _foe, _reports, options) => {
    plans++
    return useful ? { targetAt: foe.position.clone(), gameTick: worldTick(bot), resistance: { lo: 0, hi: 0 }, baseline: { out: false, progress: 0, air: 0 },
      nominal: { out: false, exited: false, progress: 1, air: 0 }, worst: { out: false, exited: false },
      shots: [{ ...shot(), fireDelay: options.delays[0] }] } as any : null
  })
  t.mock.method(enemy, 'enemyWindFrames', () => [{}] as any)
  t.mock.method(enemy, 'enemyWindShot', () => shot())
  t.mock.method(enemy, 'pendingWindHit', () => pending ? { id: 99, ticks: condition === 'later pending' ? 2 : 1 } as any : null)
  t.mock.method(enemy, 'windTeamSafe', () => safe)
  t.mock.method(enemy, 'observeOwnWindBurst', () => () => {})
  t.mock.method(sight, 'seesPlayer', () => true)
  const activate = bot.activateItem
  bot.activateItem = () => { activate(); useful = false }
  const ticks = count => { for (let n = 0; n < count; n++) { now += 50; bot.ndClock.ticks++; bot.emit('physicsTick') } }
  t.after(() => { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners() })
  installWindOut(session)
  const initialOwn = bot.entity.position.clone(), initialFoe = foe.position.clone()
  ticks(2); assert.equal(f.uses.length, 1)
  ticks(30) // The first forecast/receipt window ends without displacement or a confirmed burst.
  assert.equal(session._windOut.log[0]?.burst, undefined)
  assert.equal(f.uses.length, 1)
  assert.equal(hands.windReady(bot), true, 'the native cooldown has expired before a repeat is considered')
  const before = plans
  foe.yaw = Math.PI / 2 // A new public input and useful high-body plan, at exactly the same two positions.
  useful = true
  if (condition === 'cooldown') bot._ndWindCd = now + 500
  if (condition === 'pending' || condition === 'later pending') pending = true
  if (condition === 'ally') safe = false
  ticks(2)
  assert.deepEqual(bot.entity.position, initialOwn); assert.deepEqual(foe.position, initialFoe)
  const expected = condition === 'fresh' || condition === 'later pending' ? 2 : 1
  assert.equal(f.uses.length, expected)
  if (condition !== 'cooldown') assert.ok(plans > before, 'fresh public plans are priced again without a half-block displacement rule')
  assert.equal(session._windOut.fired, expected)
})
