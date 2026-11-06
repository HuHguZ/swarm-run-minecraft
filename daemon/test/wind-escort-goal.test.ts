import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as flight from '../src/elytra/flight'
import * as gameClock from '../src/game-clock'
import * as pick from '../src/pick'
import { wingOrbit } from '../src/combat/wing-orbit'
import { enemyWindShot } from '../src/combat/enemy-wind'
import { windImpulse, windOutward } from '../src/combat/team-wind'
import * as enemy from '../src/combat/enemy-wind'
import * as motion from '../src/bow/track'
import { choose } from '../src/elytra/control'
import { glideStep, worldOf } from '../src/elytra/physics'
import { evaluateAerial } from '../src/combat/aerial-graph'
import { reserveWindOrder } from '../src/combat/wind-coordination'
import { finishWindLance, lanceDamage, lanceHits } from '../src/combat/aerial-lance'
import { lookVec } from '../src/elytra/physics'
import { DAMAGE_TYPES } from '../src/gamedata'

const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
const air = p => { const b = Block.fromStateId(registry.blocksByName.air.defaultState); b.position = p.floored(); return b }
const arena = { x: 0, y: 120, z: 0, r: 80, ellipse: { a: 77, b: 65 } }

test('shared offensive direction preserves the native footprint tie and radial boundary', () => {
  for (const p of [new Vec3(0, 150, 0), new Vec3(.3, 150, -.3)]) assert.deepEqual(windOutward(arena, p), new Vec3(0, 0, 1))
  assert.deepEqual(windOutward({ ...arena, ellipse: { a: 65, b: 77 } }, new Vec3(0, 150, 0)), new Vec3(1, 0, 0))
  assert.deepEqual(windOutward({ ...arena, ellipse: { a: 65, b: 65 } }, new Vec3(0, 150, 0)), new Vec3(0, 0, 1))
  const p = new Vec3(.3000001, 150, -.3), radial = new Vec3(p.x, 0, p.z).normalize()
  assert.deepEqual(windOutward(arena, p), radial)
})

function fixture(at = new Vec3(20, 150, 0), me = new Vec3(30, 147, 0), ground = false) {
  const target: any = Object.assign(new EventEmitter(), { id: 2, username: 'Foe', type: 'player', name: 'player',
    position: at, onGround: ground, isValid: true, width: .6, height: 1.8, yaw: 0, pitch: 0, metadata: [0], equipment: [] })
  for (const key of ['health', 'hp', 'velocity', 'attributes', 'effects']) Object.defineProperty(target, key, { get() { throw Error('private enemy ' + key) } })
  const slots: any[] = []; slots[6] = { name: 'elytra' }
  const bot: any = Object.assign(new EventEmitter(), { registry, health: 20, entity: { id: 1, username: 'Blue', type: 'player', name: 'player',
    position: me, velocity: new Vec3(0, 0, 0), elytraFlying: true, onGround: false, width: .6, height: .6, metadata: [128] },
    players: { Foe: { entity: target } }, inventory: { slots, items: () => [{ name: 'wind_charge', count: 8 }, { name: 'firework_rocket', count: 8 }] }, blockAt: air })
  return { bot, target, session: { require: () => bot }, ctl: { aborted: false } }
}

async function capture(t, f: ReturnType<typeof fixture>, check, bounds: any = arena, lane?: number) {
  t.mock.method(flight, 'fly', async (_bot, owner, options) => { assert.equal(owner, f.ctl); check(options); return { why: 'goal control' } })
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, f.ctl); return { ok: true } })
  return wingOrbit(f.session, f.ctl, { target: 'Foe', radius: 8, floorY: 120, arena: bounds, lane })
}

test('an airborne arena escort aligns its muzzle with the public target eyes from the centre side', async t => {
  const f = fixture()
  await capture(t, f, options => {
    const goal = options.goal(), point = goal.at
    assert.notEqual(typeof point, 'function', 'unknown motion keeps a current visible fallback')
    assert.equal(goal.maxY, undefined, 'a visible airborne target does not impose a relative flight ceiling')
    assert.equal(point.y + pick.eyeHeight(f.bot), f.target.position.y + pick.eyeHeight(f.bot, f.target))
    assert.ok(point.x < f.target.position.x, 'an outside pilot approaches the inside arc instead of circling farther outside')
    assert.equal(options.rocketIf({ p: point.offset(0, .1, 0), v: new Vec3(1, 0, 0) }, null, goal), false)
    assert.equal(options.until(), null)
    f.target.onGround = true
    assert.equal(options.until(), null, 'inner support retains the accepted arena escort')
  })
})

test('central airborne escorts share the native planner positive short Z tie from every own side and enemy yaw', async t => {
  for (const yaw of [0, Math.PI]) for (const [x, z] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
    const f = fixture(new Vec3(.1, 150, -.1), new Vec3(x, 147, z)); f.target.yaw = yaw
    await capture(t, f, options => {
      const point = options.goal().at
      assert.ok(point.z < f.target.position.z, 'the pilot stays behind shared +Z instead of choosing a private radial side')
      assert.equal(point.y + .4, f.target.position.y + 1.62)
    })
  }
})

test('assigned wind escorts keep three distinct centre-side lanes through approach and inner landing', async t => {
  for (const lane of [-1, 0, 1]) {
    const f = fixture(new Vec3(0, 150, 0), new Vec3(0, 150, -20))
    await capture(t, f, options => {
      const angle = Math.atan2(3 * lane, 8)
      for (const ground of [false, true]) {
        f.target.onGround = ground
        for (const distance of [20, 10]) {
          f.bot.entity.position.z = -distance
          const point = options.goal().at
          assert.ok(Math.abs(point.x - 8 * Math.sin(angle)) < 1e-12, `lane ${lane}, ground ${ground}, distance ${distance}`)
          assert.ok(Math.abs(point.z + 8 * Math.cos(angle)) < 1e-12)
          assert.ok(Math.abs(point.y - (ground ? 152 : 151.22)) < 1e-12)
          assert.equal(options.until(), null)
        }
      }
    }, arena, lane)
  }
})

test('an airborne arena escort uses visible crouching eyes while floor clearance remains physical', async t => {
  const f = fixture(); f.target.metadata[6] = 5
  await capture(t, f, options => { assert.ok(Math.abs(options.goal().at.y - (150 + 1.27 - .4)) < 1e-12) })
  const low = fixture(new Vec3(20, 120.1, 0))
  await capture(t, low, options => { assert.equal(options.goal().at.y, 123, 'the existing three-block safe floor clearance can override the desired eye plane') })
})

test('ground ledge and ordinary non-arena orbit retain their previous height and side contracts', async t => {
  const ledge = fixture(new Vec3(20, 150, 0), new Vec3(30, 147, 0), true)
  await capture(t, ledge, options => { const g = options.goal(), p = g.at; assert.equal(p.y, 152); assert.ok(p.x < 20); assert.equal(g.maxY, 160) })
  const ordinary = fixture()
  await capture(t, ordinary, options => { const g = options.goal(), p = g.at; assert.equal(p.y, 153); assert.ok(p.x > 20); assert.equal(g.maxY, 162) }, null)
})

for (const mode of ['contact', 'short', 'no_spear', 'no_wind_receipt', 'reserved_order', 'wind_timeout', 'wind_expired', 'ringout', 'crossing', 'fall', 'empty_reposition', 'empty_no_window']) test(`arena wing uses a kinetic spear only for a certified pre-landing window: ${mode}`, async t => {
  const f = fixture(new Vec3(8, 153, .2), new Vec3(0, 151, 0))
  f.bot.entity.velocity.set(.5, -.05, 0)
  f.bot._client = new EventEmitter()
  f.bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0, now: () => 1000, observationNow: () => 1000 }
  Object.assign(f.session, { bot: f.bot })
  const items = f.bot.inventory.items()
  if (mode.startsWith('empty_')) items.shift()
  if (mode !== 'no_spear') items.push({ name: 'netherite_spear', count: 1 })
  f.bot.inventory.items = () => items
  let wall = 0
  const competingWind = mode === 'wind_timeout' || mode === 'wind_expired' || mode === 'ringout' || mode === 'crossing' || mode === 'fall'
  const hands: typeof import('../src/mace/hands') = require('../src/mace/hands')
  t.mock.method(hands, 'windReady', () => competingWind)
  if (competingWind) {
    t.mock.method(require('../src/combat/enemy-wind-execute'), 'enemyWindReport', () => ({ ok: true, ready: true, report: {} }))
    t.mock.method(require('../src/combat/wind-out'), 'windOutDecide', (_bot, _own, _arena, _lag, comparisonDeadline) => {
      if (mode === 'wind_timeout' || mode === 'wind_expired') {
        wall = mode === 'wind_timeout' ? comparisonDeadline + .01 : 51
        return null
      }
      return { kind: mode === 'fall' ? 'fall' : 'out?', plan: {
        nominal: { exited: mode !== 'fall', out: mode === 'ringout' }, worst: { out: false }, fallThreat: mode === 'fall'
      } }
    })
  }
  t.mock.method(gameClock.wall, 'monotonic', () => wall)
  const kernel = require('../src/combat/enemy-wind')
  const ticks = mode === 'short' ? 6 : 13
  const frames = Array.from({ length: ticks + 1 }, (_, i) => ({
    pos: new Vec3(8 + .12 * i, 153 - .16 * i - .025 * i * i, .2),
    vel: new Vec3(.12, -.16 - .05 * i, 0), onGround: i === ticks
  }))
  t.mock.method(kernel, 'windFinishOpportunity', () => mode === 'no_wind_receipt' || mode === 'empty_no_window' ? null : ({ target: 'Foe', at: frames[ticks].pos, frames, ticks, gameTick: 500 }))
  if (mode === 'empty_reposition') {
    let attempts = 0
    t.mock.method(require('../src/combat/aerial-lance'), 'windLancePlan', () => ++attempts === 1 ? null : items.at(-1))
  }
  if (mode === 'reserved_order') {
    assert.equal(reserveWindOrder(f.session, 'wind-before-spear', 'Foe', 500, 515), true)
    t.after(() => f.bot.emit('end'))
  }
  await capture(t, f, options => {
    if (mode === 'empty_reposition') {
      assert.equal(options.until(), null, 'a live spear window owns another steering tick with no charges')
      assert.equal(options.until(), 'таран после ветра')
    } else assert.equal(options.until(), mode === 'contact' || mode === 'crossing' || mode === 'wind_timeout' ? 'таран после ветра' : mode === 'empty_no_window' ? 'заряды закончились' : null)
  })
})

for (const mode of ['native_contact', 'lost_sight', 'cancelled', 'late_contact', 'late_wrong_source', 'late_cancelled', 'late_target_replaced', 'late_unarmed']) test(`short kinetic approach keeps the wing owner and validates its native contact: ${mode}`, async t => {
  const f = fixture(new Vec3(10, 153, .2), new Vec3(0, 151, 0)), bot = f.bot
  const item = { name: 'netherite_spear', count: 1 }
  const late = mode.startsWith('late_'), hit = mode === 'native_contact' || mode === 'late_contact'
  const closedAt = mode === 'late_unarmed' ? 1 : 9
  const damage = { entityId: 2, sourceCauseId: 2, sourceDirectId: 2, sourceTypeId: DAMAGE_TYPES.indexOf('spear') }
  let now = 1000, startUse = -1, tick = 0, accepted = false, landed = false, reads = 0
  t.mock.method(gameClock, 'now', () => now)
  t.mock.method(gameClock.wall, 'monotonic', () => 0)
  t.mock.method(flight, 'fly', async (_bot, owner, options) => {
    assert.equal(options.phase, 'таран: выход', 'a close finish skips the long run-up')
    assert.equal((owner as any)._ndFlightOwner, (f.ctl as any)._ndFlightOwner)
    landed = true
    return { why: 'вышел' }
  })
  bot.entity.velocity.set(.7, -.05, 0)
  bot.heldItem = item
  bot._client = new EventEmitter()
  bot._ndElytra = { fd: 0, driving: 0, startedAt: 0 }
  bot.look = async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }) }
  bot.activateItem = () => { assert.equal(startUse, -1); startUse = tick; bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  const aborts: (() => void)[] = []
  Object.assign(f.ctl, { onAbort: aborts })
  const foot = i => new Vec3(10 + .12 * i, 153 - .16 * i - .025 * i * i, .2)
  const velocity = i => new Vec3(.12, -.16 - .05 * i, 0)
  const read = () => {
    reads++
    if (mode === 'lost_sight' && tick > 0 || late && tick === closedAt) return null
    const ticks = 16 - tick
    return { ticks, frames: Array.from({ length: ticks + 1 }, (_, i) => ({ pos: foot(tick + i), vel: velocity(tick + i) })) }
  }
  const before = bot.listenerCount('physicsTick')
  const finish = finishWindLance(bot, f.ctl, f.target, item, read, arena, 2000)
  for (; tick <= 15; tick++) {
    now = 1000 + 50 * tick
    if (tick > 0) {
      if (mode === 'cancelled') { f.ctl.aborted = true; [...aborts].forEach(abort => abort()); break }
      const { position, velocity: ownV, yaw, pitch } = bot.entity, dir = lookVec(yaw, pitch)
      glideStep(position, ownV, yaw, pitch, false)
      f.target.position = foot(tick)
      if (!late && bot.usingHeldItem && tick - startUse >= 8 && lanceHits(position.offset(0, .4, 0), dir, ownV, f.target.position) &&
          lanceDamage(item.name, dir, ownV, velocity(tick)).dmg > 0) {
        accepted = true
        bot._client.emit('damage_event', damage)
      }
    }
    bot.emit('physicsTick')
    if (late && tick === closedAt) {
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(bot.usingHeldItem, false, 'no further attack after the planning window closes')
      assert.equal(bot._client.listenerCount('damage_event'), mode === 'late_unarmed' ? 0 : 1)
      if (mode === 'late_cancelled') { f.ctl.aborted = true; [...aborts].forEach(abort => abort()) }
      if (mode === 'late_target_replaced') bot.players.Foe.entity = { id: f.target.id }
      bot._client.emit('damage_event', mode === 'late_wrong_source' ? { ...damage, sourceDirectId: 3 } : damage)
      break
    }
    if (accepted || mode === 'lost_sight' && tick > 0) break
  }
  const result = await finish
  assert.equal(startUse, 0, 'the actual kinetic pass starts its held use without a separate run-up')
  assert.equal(result?.hit, hit)
  assert.equal(accepted, mode === 'native_contact')
  assert.equal(landed, hit)
  assert.ok(reads >= (mode === 'cancelled' ? 1 : 2))
  assert.equal(bot.usingHeldItem, false)
  assert.equal(bot._ndElytra.lance, undefined)
  assert.equal(bot._ndElytra.driving, 0)
  assert.equal(bot._client.listenerCount('damage_event'), 0)
  assert.equal(bot.listenerCount('physicsTick'), before)
  assert.equal(aborts.length, 0)
})

for (const mode of ['occluded floor', 'block changed', 'column unloaded', 'hidden target', 'first window occluded', 'first window expired',
  'handoff occluded floor', 'handoff block changed', 'handoff column unloaded', 'handoff column loaded', 'handoff world changed',
  'handoff remote load', 'handoff remote unload', 'handoff remote block', 'handoff unknown column', 'handoff unknown block',
  'rejected preflight']) test(`wing spear reforecasts after ${mode}`, async t => {
  const beforePass = mode.startsWith('first window')
  const handoff = mode.startsWith('handoff')
  const approach = beforePass ? new Vec3(622.72381, 169.23369, 600.49429) : new Vec3(604.81557, 170.07424, 600.50790)
  const f = fixture(new Vec3(597.54745, 170.25138, 600.50906), approach)
  const { bot, target } = f
  const bounds = { ...arena, x: 600.5, z: 600.5, killY: 113 }, item = { name: 'netherite_spear', count: 1 }
  let now = 1000, covered = false
  t.mock.method(gameClock, 'now', () => now)
  t.mock.method(gameClock, 'observationNow', () => now)
  t.mock.method(gameClock.wall, 'monotonic', () => 0)
  bot._client = new EventEmitter()
  bot.version = '1.21.11'
  const world = bot.world = new EventEmitter()
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0, now: () => now, observationNow: () => now }
  bot.inventory.items = () => [item]
  bot.heldItem = item
  bot.blockAt = p => {
    const q = p.floored()
    const pad = (q.x === 602 || beforePass && q.x === 617) && q.z === 600 && (q.y === 161 || q.y === 162)
    const wall = covered && q.x === 600 && q.y >= 168 && q.y <= 172 && Math.abs(q.z - 600) <= 1
    const name = pad || wall ? 'cobblestone' : q.y < 120 ? 'sand' : 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState)
    block.position = q
    return block
  }
  const native = require('../src/tick-plugins').getPhysics()
  bot.physics = native.Physics(registry, { getBlock: bot.blockAt })
  target._ndObservationNow = () => now
  enemy.installWindTracking(bot)
  t.after(() => bot.emit('end'))
  bot._client.emit('explosion', { center: target.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  let velocity = new Vec3(-.046325, -.252751, 0)
  const move = () => {
    now += 50; bot.ndClock.ticks++
    target.position = target.position.plus(velocity)
    velocity = new Vec3(velocity.x * .91, (velocity.y - .08) * .98, 0)
    target._ndPositionReceipts = [target._ndPositionReceipts?.[1], { ...target.position, t: now, grounded: false, kind: 'rel_entity_move' }]
    bot.emit('physicsTick')
  }
  for (let i = 0; i < 3; i++) {
    move()
    const preflight = enemy.windFinishOpportunity(bot, target, bounds)
    assert.equal(preflight?.at.y, i === 2 ? 120 : undefined)
  }
  const lance = require('../src/combat/aerial-lance')
  let accepted: NonNullable<ReturnType<typeof enemy.windFinishOpportunity>>
  let proof: Parameters<typeof enemy.windFinishOpportunity>[5]
  const opportunity = enemy.windFinishOpportunity
  t.mock.method(enemy, 'windFinishOpportunity', (...args: Parameters<typeof opportunity>) => {
    proof = args[5]
    return opportunity(...args)
  })
  t.mock.method(lance, 'windLancePlan', (_bot, _target, window) => { accepted = window; return mode === 'rejected preflight' ? null : item })
  t.mock.method(lance, 'finishWindLance', async (_bot, _ctl, _foe, _item, read) => {
    const first = read(50)
    if (handoff) {
      if (mode === 'handoff occluded floor' || mode.startsWith('handoff remote ')) {
        assert.equal(first?.at.y, 120, 'the observed preflight support survives the first active recheck')
        assert.equal(proof, accepted, 'the exact accepted preflight reaches the active pass')
        assert.equal(first?.gameTick, accepted.gameTick + 1)
        assert.ok(first.frames[0].pos.y < accepted.frames[0].pos.y, 'the new visible receipt drives the active trajectory')
      } else {
        assert.equal(first, null, 'an invalidated preflight must not supply old support')
        assert.equal(proof, undefined)
      }
      return { hit: !!first }
    }
    assert.equal(first?.at.y, 120, 'the initial visible support is verified')
    if (beforePass) return { hit: true }
    if (mode === 'block changed') world.emit('blockUpdate', null, { position: first.at.offset(0, -1, 0).floored() })
    if (mode === 'column unloaded') world.emit('chunkColumnUnload', first.at.floored())
    if (mode === 'hidden target') covered = true
    bot.entity.position = new Vec3(603.13477, 169.74363, 600.50695)
    move()
    const next = read(50)
    if (mode === 'occluded floor') {
      assert.equal(next?.at.y, 120, 'previously observed support survives brief occlusion')
      assert.equal(next?.gameTick, first.gameTick + 1)
      assert.ok(next.frames[0].pos.y < first.frames[0].pos.y, 'new visible motion drives the new trajectory')
    } else assert.equal(next, null)
    return { hit: !!next }
  })
  let flights = 0
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    if (flights++) return { why: 'no fresh opportunity' }
    if (beforePass) {
      bot.entity.position = new Vec3(621.15511, 169.74720, 600.49567)
      if (mode === 'first window expired') now += 50 * (enemy.WIND_FORECAST_TICKS + 1)
      move()
      assert.equal(enemy.windFinishOpportunity(bot, target, bounds), null, 'there is no complete forecast on entry')
      if (mode === 'first window expired') {
        const why = options.until()
        assert.equal(why, 'заряды закончились')
        return { why }
      }
      assert.equal(options.until(), null, 'a witnessed gust keeps a charge-free wing in flight without attacking')
      bot.entity.position = new Vec3(619.58564, 170.26043, 600.49478)
      move()
    }
    const why = options.until()
    if (mode === 'rejected preflight') {
      assert.equal(why, null)
      assert.equal(world.listenerCount('chunkColumnLoad'), 0, 'discard observations from a rejected pass')
      bot.entity.position = new Vec3(603.13477, 169.74363, 600.50695)
      move()
      assert.equal(enemy.windFinishOpportunity(bot, target, bounds), null)
      assert.equal(options.until(), null, 'the occluded retry cannot reuse rejected preflight terrain')
      return { why: 'no fresh opportunity' }
    }
    assert.equal(why, 'таран после ветра')
    if (handoff) {
      bot.entity.position = new Vec3(603.13477, 169.74363, 600.50695)
      move()
      assert.equal(enemy.windFinishOpportunity(bot, target, bounds), null, 'the new viewpoint alone cannot see landing support')
      if (mode === 'handoff block changed') world.emit('blockUpdate', null, { position: accepted.at.offset(0, -1, 0).floored() })
      if (mode === 'handoff column unloaded') world.emit('chunkColumnUnload', accepted.at.floored())
      if (mode === 'handoff column loaded') world.emit('chunkColumnLoad', accepted.at.floored())
      if (mode === 'handoff remote load') world.emit('chunkColumnLoad', new Vec3(768, 0, 560))
      if (mode === 'handoff remote unload') world.emit('chunkColumnUnload', new Vec3(768, 0, 592))
      if (mode === 'handoff remote block') world.emit('blockUpdate', null, { position: new Vec3(768, 119, 560) })
      if (mode === 'handoff unknown column') world.emit('chunkColumnLoad', null)
      if (mode === 'handoff unknown block') world.emit('blockUpdate', null, null)
      if (mode === 'handoff world changed') bot.world = new EventEmitter()
    }
    return { why }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  await wingOrbit(f.session, f.ctl, { target: 'Foe', radius: 8, floorY: 120, arena: bounds })
  for (const event of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']) assert.equal(world.listenerCount(event), 0)
})

test('CH active spear uses only the fresh native prefix before the first unknown cell', t => {
  const f = fixture(new Vec3(599.5, 163, 600.5), new Vec3(620.8590432942586, 168.042042001498, 600.517258640401))
  const { bot, target } = f, bounds = { ...arena, x: 600.5, z: 600.5, killY: 113, ellipse: { ...arena.ellipse } }
  let now = 1000
  t.mock.method(gameClock, 'now', () => now)
  t.mock.method(gameClock, 'observationNow', () => now)
  t.mock.method(motion, 'observedVelocity', () => ({ x: 0, y: 0, z: 0, ageTicks: 0 }))
  bot._client = new EventEmitter()
  bot.world = new EventEmitter()
  bot.version = '1.21.11'
  bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  bot.blockAt = p => {
    const q = p.floored(), b = Block.fromStateId(registry.blocksByName[q.y < 120 ? 'sand' : 'air'].defaultState)
    b.position = q
    return b
  }
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: bot.blockAt })
  target._ndObservationNow = () => now
  target.yaw = Math.PI
  bot.entities = { 2: target }
  enemy.installWindTracking(bot)
  t.after(() => bot.emit('end'))
  const gust = () => bot._client.emit('explosion', { center: target.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  gust()
  const receive = () => {
    for (const p of [
      new Vec3(598.9018652846677, 164.89124514477786, 600.4859221921217),
      new Vec3(598.2893164565427, 166.81922366040286, 600.4783538327467),
      new Vec3(597.7822363784177, 168.36023928540286, 600.4751800046217)
    ]) {
      now += 100
      target.position = p
      target._ndPositionReceipts = [target._ndPositionReceipts?.[1], { ...p, t: now, kind: 'rel_entity_move', grounded: false, revision: 0, yaw: Math.PI }]
      target.emit('ndPositionObserved')
    }
  }
  receive()
  const known = { blockAt: bot.blockAt, physics: bot.physics, game: bot.game }
  const earlyUnknown = { ...known, blockAt: p => p.y >= 167 ? null : known.blockAt(p) }
  const hiddenFloor = { ...known, blockAt: p => {
    const q = p.floored()
    return q.y < 120 || q.x === 595 && q.y === 161 && q.z === 600 ? null : known.blockAt(p)
  } }
  const full = enemy.windFinishOpportunity(bot, target, bounds, known, Infinity, 'preflight')
  assert.equal(full?.at.y, 120)
  assert.equal(full.ticks, 49)
  bot.ndClock.ticks++
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor), null, 'ground finish still requires a certified landing')
  const prefix = enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full)
  assert.equal(prefix?.ticks, 23, 'the recorded inside spear course has a usable exact prefix before forecast step 23')
  assert.equal(prefix.frames.length, 23)
  assert.equal(prefix.frames.at(-1).onGround, false)
  const { chooseLance } = require('../src/combat/aerial-lance')
  const v = new Vec3(-1.6595638514240492, -.005528295180483273, .001470123185027617)
  const W = { boxHit: (_x, y) => y < 120, floorBelow: () => null }
  const plan = chooseLance(W, { p: bot.entity.position, v, boost: 17, fd: 0 }, i => prefix.frames[i].pos, {
    h: 1.8, name: 'netherite_spear', H: 16, readyIn: 9, arena: bounds, safeReady: true, velocityAt: i => prefix.frames[i].vel
  })
  assert.ok(plan?.ready && plan.hitT + 1 < prefix.ticks, 'actual native contact and safe escape fit before uncertainty')
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, earlyUnknown, Infinity, full), null)
  const shortGeometry = { ...hiddenFloor, blockAt: p => p.floored().y === 172 ? null : hiddenFloor.blockAt(p) }
  const short = enemy.windFinishOpportunity(bot, target, bounds, shortGeometry, Infinity, full)
  const item = { name: 'netherite_spear', count: 1 }
  bot.inventory.items = () => [item]
  bot.heldItem = item
  assert.ok(short && short.ticks > 1 && short.ticks < 9)
  assert.equal(require('../src/combat/aerial-lance').windLancePlan(bot, target, short, bounds, Infinity), null,
    'the prefix cannot arm a spear before the native use delay')

  const origin = prefix.frames[0].pos.offset(2, 1, 0), windVelocity = new Vec3(-1.5, 0, 0)
  bot.entities[3] = { id: 3, name: 'wind_charge', position: origin }
  bot._ndThrown.set(3, { name: 'wind_charge', p: origin, v: windVelocity, owner: bot.entity.id, observedAt: now })
  t.mock.method(require('../src/threats'), 'projectileView', () => ({
    position: origin, _ndPositionReceipts: [null, { ...origin, t: now }],
    _ndWindMotion: { position: origin, velocity: windVelocity, t: now }, _ndObservationNow: () => now
  }))
  assert.equal(enemy.pendingWindHit(bot, target, prefix.frames, [], hiddenFloor)?.id, 3)
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full), null, 'known pending contact invalidates the active spear path')
  bot._ndThrown.delete(3)
  delete bot.entities[3]

  const oldWorld = bot.world, oldEntity = bot.entity
  bot.world = new EventEmitter()
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full), null)
  bot.world = oldWorld
  bot.entity = { ...oldEntity }
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full), null)
  bot.entity = oldEntity
  const a = bounds.ellipse.a
  bounds.ellipse.a = 1
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full), null, 'a projected exit still has priority')
  bounds.ellipse.a = a
  gust()
  receive()
  assert.equal(enemy.windFinishOpportunity(bot, target, bounds, hiddenFloor, Infinity, full), null, 'a new gust invalidates the old inside certificate')
})

for (const terminal of ['outside landing', 'hidden']) test(`the Colosseum escort follows a native inner landing until ${terminal}`, async t => {
  const f = fixture(new Vec3(0, 122, 0), new Vec3(0, 124, 10))
  const native = require('../src/tick-plugins').getPhysics()
  const { IDLE } = require('../src/edges')
  const read = p => {
    const block = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sandstone' : 'air'].defaultState)
    block.position = p.floored()
    return block
  }
  f.bot.version = '1.21.11'
  f.bot.blockAt = read
  f.bot.physics = native.Physics(registry, { getBlock: read })
  const fall = new native.PlayerState({ version: '1.21.11', inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: f.target.position.clone(), velocity: new Vec3(0, -.4, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} } }, IDLE)
  for (let tick = 0; tick < 10 && !fall.onGround; tick++) f.bot.physics.simulatePlayer(fall, { getBlock: read })
  assert.equal(fall.onGround, true)
  assert.equal(fall.pos.y, 120)

  const result = await capture(t, f, options => {
    assert.equal(options.until(), null)
    f.target.position = fall.pos.clone()
    delete f.target.onGround
    f.target.emit('ndPositionObserved')
    assert.equal(options.until(), null, 'inner native support still has a live pursuit')
    assert.ok(options.goal().at.z < 0, 'the central ground approach shares the shortest-axis +Z wind direction')

    if (terminal === 'outside landing') {
      f.target.position.z = 65.1
      assert.equal(options.until(), null, 'the whole visible footprint still overlaps the ellipse')
      f.target.position.z = 65.31
      f.target.onGround = false
      assert.equal(options.until(), null, 'an explicit airborne receipt overrides touching a surface')
      delete f.target.onGround
      assert.equal(options.until(), 'цель за ареной')
    } else {
      f.bot.blockAt = () => null
      assert.equal(options.until(), 'цели не видно')
    }
    assert.equal(options.goal(), null)
  })
  assert.equal(result.ok, true)
})

test('the escort follows a high outside crossing and re-entry until an actual outside fall', async t => {
  for (const startingZ of [64.9, 65.31]) {
    const f = fixture(new Vec3(0, 168, startingZ), new Vec3(0, 162, 57))
    const result = await capture(t, f, options => {
      f.target.position.z = 65.31
      assert.equal(options.until(), null, 'the whole hull is outside but still in flight')
      assert.ok(options.goal().at.z < 65, 'the escort remains on the centre side')
      f.bot.players.Foe.gamemode = 3
      assert.equal(options.until(), 'цели не видно')
      assert.equal(options.goal(), null)
      f.bot.players.Foe.gamemode = 0
      f.target.position.set(0, 158, 64.9)
      assert.equal(options.until(), null, 'the target can return inside')
      assert.ok(options.goal())
      f.target.position.set(0, 113, 65.31)
      assert.equal(options.until(), null, 'the fall line is strict')
      f.target.position.set(0, 112.99, 64.9)
      assert.equal(options.until(), null, 'height alone never counts as outside')
      f.target.position.z = 65.31
      assert.equal(options.until(), 'цель за ареной')
      assert.equal(options.goal(), null)
    }, { ...arena, killY: 113 }, 0)
    assert.equal(result.ok, true)
  }
})

test('a gliding wind-only escort can coast after the target opens elytra', async t => {
  const f = fixture(new Vec3(20, 150, 0), new Vec3(12, 151, 0))
  const native = require('../src/tick-plugins').getPhysics()
  f.bot.version = '1.21.11'
  f.bot.physics = native.Physics(registry, { getBlock: air })
  let kit = [{ name: 'wind_charge', count: 1 }, { name: 'netherite_sword', count: 1 }]
  f.bot.inventory.items = () => kit
  const actor = (id, position) => ({ id, position, velocity: { x: .55, y: 0, z: 0 }, flying: true, grounded: false, alive: true })
  const decision = evaluateAerial({ self: actor(1, f.bot.entity.position), target: actor(2, f.target.position), health: 20,
    interrupted: false, safeLanding: { x: 12, y: 120, z: 0 }, corridorClear: true,
    equipment: { elytra: true, rockets: 0, chestplate: false, mace: false, spear: false, ranged: false, pearls: 0 },
    maceReady: false, maceDropReady: false, spearReady: false, fallDistance: 0, pearlDamage: 0 })
  assert.equal(decision.node, 'SafeLanding', 'the ordinary aerial handoff would give up a working wind escort')

  let observedAt = 1000
  f.target._ndObservationNow = () => observedAt
  f.target._ndPositionReceipts = [null, { kind: 'rel_entity_move', t: observedAt, grounded: false, flying: false }]
  t.mock.method(motion, 'hasObservedVelocity', () => true)
  t.mock.method(motion, 'observedVelocity', () => ({ x: .55, y: 0, z: 0, ageTicks: 0 }))
  const move = () => {
    f.target.position = f.target.position.offset(.55, 0, 0)
    observedAt += 50
    f.target._ndPositionReceipts = [f.target._ndPositionReceipts[1], { kind: 'rel_entity_move', t: observedAt, grounded: false, flying: true }]
    f.target.emit('ndPositionObserved')
  }
  await capture(t, f, options => {
    assert.equal(options.until(), null)
    f.target.metadata[0] = 128
    f.target.yaw = -Math.PI / 2
    move()
    assert.equal(options.until(), null)
    assert.notEqual(typeof options.goal().at, 'function', 'a mixed falling/gliding receipt pair uses the current public pose')
    move()
    const at = options.goal().at
    assert.equal(typeof at, 'function', 'two visible gliding receipts enable the existing native forecast')
    assert.ok(at(12).x > at(0).x && at(0).x < f.target.position.x)
    for (const name of ['firework_rocket', 'iron_spear', 'ender_pearl']) {
      kit = [{ name: 'wind_charge', count: 1 }, { name, count: 1 }]
      assert.equal(options.until(), 'цель на элитрах', `${name} retains the ordinary aerial handoff`)
    }
  })
})

test('a level wing prices a rocket when its visible route anchor pulls away', async t => {
  const f = fixture(new Vec3(22, 150, 0), new Vec3(0, 151.22, 0))
  const movingGoal = speed => ({ kind: 'point', at: tick => new Vec3(14 + speed * tick, 151.22, 0), minY: 123, gap: 3, speedMin: .4, arena })
  const goal = movingGoal(.86)
  const own = { p: f.bot.entity.position, v: new Vec3(.7, 0, 0), boost: 0, fd: 0 }
  const world = worldOf(f.bot), coast = choose(world, own, goal)!, rocket = choose(world, own, goal, { rocketNow: true })!
  assert.equal(coast.r.kind, null)
  assert.equal(rocket.r.kind, null)
  assert.ok(rocket.c < coast.c - 4, 'the existing optional rocket comparison has a safe catch-up profile')
  await capture(t, f, options => {
    assert.equal(options.rocketIf(own, coast, goal), undefined, 'a receding anchor requests ordinary optional pricing')
    assert.equal(options.rocketIf({ ...own, v: new Vec3(0, 0, .7) }, coast, goal), false, 'sideways speed does not request a catch-up boost')
    assert.equal(options.rocketIf(own, coast, movingGoal(.5)), false, 'a closing escort keeps its rocket')
    assert.equal(options.rocketIf(own, coast, { ...goal, at: goal.at(0) }), false, 'a fixed anchor does not trigger catch-up pricing')
  })
})

test('a rising native eye forecast is not priced against a contradictory current-height ceiling', async t => {
  const f = fixture(new Vec3(0, 150, 0), new Vec3(-8, 160, 0))
  const native = require('../src/tick-plugins').getPhysics()
  const read = p => {
    const b = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sandstone' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  f.bot.version = '1.21.11'; f.bot.blockAt = read
  f.bot.physics = native.Physics(registry, { getBlock: read })
  f.bot.entity.velocity = new Vec3(1.5, .2, 0)
  const velocity = new Vec3(0, 2, 0), idle = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const state = new native.PlayerState({ version: '1.21.11', inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: f.target.position.clone(), velocity, onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} } }, idle)
  const frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
  for (let tick = 0; tick < 65; tick++) {
    f.bot.physics.simulatePlayer(state, { getBlock: read })
    frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
  }
  // This goal test supplies a public-motion certificate and real native frames; raw foreign fields remain trapped.
  let observedAt = 1000
  f.target._ndObservationNow = () => observedAt
  f.target._ndPositionReceipts = [{ kind: 'rel_entity_move', t: 950, grounded: false }, { kind: 'rel_entity_move', t: 1000, grounded: false }]
  t.mock.method(motion, 'hasObservedVelocity', () => true)
  t.mock.method(motion, 'observedVelocity', () => ({ x: 0, y: 2, z: 0, ageTicks: 0 }))
  t.mock.method(enemy, 'enemyWindFrames', () => frames)
  f.target.position.y = 148
  await capture(t, f, options => {
    // The shared fair view first acquires a baseline, then receives the new public rise.
    observedAt = 1050; f.target.position.y = 150
    f.target._ndPositionReceipts = [f.target._ndPositionReceipts[1], { kind: 'rel_entity_move', t: observedAt, grounded: false }]
    f.target.emit('ndPositionObserved')
    const goal = { ...options.goal(), arena }
    assert.equal(typeof goal.at, 'function')
    assert.ok(goal.at(18).y > f.target.position.y + 12)
    const W = worldOf(f.bot), own = { p: f.bot.entity.position, v: f.bot.entity.velocity, boost: 0, fd: 0 }
    const actual = choose(W, own, goal)!, relativeCap = choose(W, own, { ...goal, maxY: f.target.position.y + 12 })!
    const distance = p => new Vec3(p.r.p.x, p.r.p.y, p.r.p.z).distanceTo(goal.at(p.r.t))
    assert.equal(actual.r.kind, null)
    assert.ok(actual.r.p.y > f.target.position.y + 12, 'the existing safe native profile can climb above the old relative ceiling')
    assert.ok(distance(actual) < distance(relativeCap), 'a current-height policy must not beat the supplied future eye goal')
    assert.equal(goal.maxY, undefined)
  }, { ...arena, x: 0, z: 0 })
})

test('a rising target keeps the wing at crest height until the observed descent', async t => {
  const bounds = { ...arena, x: 600.5, z: 600.5, killY: 113 }
  // BA +43.479 s: a gust sent red outward above the outer terrace while blue was still below it.
  const start = new Vec3(667.5588954956606, 158.31380093977347, 591.0777521108134)
  const f = fixture(start.offset(-.9, -.64, .09), new Vec3(658.3743498178991, 152.39509764313698, 589.396240234375))
  const native = require('../src/tick-plugins').getPhysics(), { IDLE } = require('../src/edges')
  const { observedCollision } = require('../src/pvp/search'), { bodyClear } = require('../src/navigation/geometry')
  const read = p => {
    const q = p.floored(), name = q.y < 120 || q.x >= 670 && q.y < 153 ? 'sandstone' : q.x >= 670 && q.y === 153 ? 'sandstone_slab' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
  }
  const velocity = new Vec3(.8725412192747668, .6395086826576993, -.09058301025266775)
  const state = new native.PlayerState({ version: '1.21.11', inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: start, velocity, onGround: false, yaw: Math.atan2(start.x - bounds.x, start.z - bounds.z), pitch: 0, effects: {}, attributes: {} } },
  { ...IDLE, forward: true, sprint: true })
  f.bot.version = '1.21.11'; f.bot.blockAt = read
  f.bot.physics = native.Physics(registry, { getBlock: read })
  const frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
  while (frames.length < 33 && !state.onGround) {
    f.bot.physics.simulatePlayer(state, { getBlock: read })
    frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
  }
  const crest = frames.findIndex((frame, i) => i > 0 && frame.pos.y > frames[i + 1]?.pos.y)
  assert.ok(crest > 6 && frames.at(-1)!.onGround)
  let observedAt = 1000, forecast = frames
  f.target._ndObservationNow = () => observedAt
  f.target._ndPositionReceipts = [null, { kind: 'rel_entity_move', t: observedAt, grounded: false }]
  const update = p => {
    f.target.position = p; observedAt += 50
    f.target._ndPositionReceipts = [f.target._ndPositionReceipts[1], { kind: 'rel_entity_move', t: observedAt, grounded: false }]
    f.target.emit('ndPositionObserved')
  }
  t.mock.method(motion, 'hasObservedVelocity', () => true)
  t.mock.method(enemy, 'enemyWindFrames', () => forecast)
  const lastVisible = path => {
    const known = observedCollision(f.bot), blocked = path.findIndex(frame => !bodyClear(known, frame.pos))
    return blocked < 0 ? path.length - 1 : blocked - 1
  }
  await capture(t, f, options => {
    update(start)
    const eye = pick.eyeHeight(f.bot, f.target) - pick.eyeHeight(f.bot), goal = { ...options.goal(), arena: bounds }
    const last = lastVisible(frames)
    const oldAt = tick => {
      const point = goal.at(tick)
      return point.offset(0, frames[Math.min(tick + 6, last)].pos.y + eye - point.y, 0)
    }
    assert.equal(goal.at(0).y, frames[6].pos.y + eye, 'rocket admission sees the same immediate height')
    assert.equal(goal.at(18).y, frames[crest].pos.y + eye)
    assert.ok(goal.at(18).y > oldAt(18).y)
    const world = worldOf(f.bot), own = { p: f.bot.entity.position, v: new Vec3(.38, 0, .2), boost: 10, fd: 0 }
    const old = choose(world, own, { ...goal, at: oldAt })!, selected = choose(world, own, goal)!
    const nextY = plan => { const p = { ...own.p }; glideStep(p, { ...own.v }, plan.yaw, plan.pitch, true); return p.y }
    assert.equal(selected.r.kind, null)
    assert.ok(nextY(selected) > nextY(old), 'the existing safe pilot climbs sooner instead of pricing the later touchdown')

    forecast = frames.slice(crest + 1)
    update(forecast[0].pos)
    assert.equal(options.goal().at(18).y, forecast[Math.min(24, lastVisible(forecast))].pos.y + eye, 'the observed descent releases the crest')
  }, bounds, 0)
})

test('an arena wing anticipates a witnessed allied lift and releases it when the charge disappears', async t => {
  const f = fixture(new Vec3(20, 150, 0), new Vec3(12, 150, -3))
  const { bot, target } = f
  const native = require('../src/tick-plugins').getPhysics(), threats = require('../src/threats')
  const thrower = { id: 3, username: 'Ally', position: new Vec3(16.15, 148.63, 0) }
  const birth = new Vec3(16.15, 150.25, 0), velocity = new Vec3(1.5, 0, 0), charge = { id: 4, position: birth.plus(velocity) }
  let now = 1000, visible = true
  const thrown = new Map()
  Object.assign(bot, { version: '1.21.11', entities: { 2: target, 3: thrower, 4: charge }, _ndSwarmAllies: ['Ally'], _ndThrown: thrown,
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, physics: native.Physics(registry, { getBlock: air }) })
  target.metadata[0] = 8
  target._ndObservationNow = () => now
  const receipt = (p: Vec3, t: number) => ({ ...p, t, kind: 'rel_entity_move', grounded: false, flying: false, yaw: 0, pitch: 0, revision: 1 })
  target._ndPositionReceipts = [null, receipt(target.position, now)]
  t.mock.method(gameClock, 'observationNow', () => now)
  t.mock.method(gameClock.wall, 'monotonic', () => 0)
  t.mock.method(motion, 'hasObservedVelocity', () => true)
  t.mock.method(motion, 'hasObservedPhysicalVelocity', () => true)
  t.mock.method(motion, 'observedVelocity', () => ({ x: 0, y: .035, z: 0, ageTicks: 0 }))
  t.mock.method(threats, 'thrownTracker', () => thrown)
  t.mock.method(threats, 'projectileView', () => visible ? { position: charge.position, _ndPositionReceipts: [null, { t: 1050 }],
    _ndWindMotion: { position: charge.position, velocity, t: 1050 }, _ndObservationNow: () => now } : null)
  await capture(t, f, options => {
    now = 1050; bot.ndClock.ticks++
    target.position = target.position.offset(0, .08 + .035 / Math.fround(.98), 0)
    target._ndPositionReceipts = [target._ndPositionReceipts[1], receipt(target.position, now)]
    target.emit('ndPositionObserved')
    const baselineGoal = options.goal().at, baseline = baselineGoal(0)
    thrown.set(charge.id, { name: 'wind_charge', owner: thrower.id, p: birth, observedAt: 1000 })
    const advanced = options.goal().at
    assert.ok(advanced(0).y > baseline.y + 1)
    assert.ok(advanced(18).y > baselineGoal(18).y + 1, 'the short pre-hit crest must not cap the post-hit approach')
    assert.equal(advanced(18).x, baselineGoal(18).x)
    assert.equal(advanced(18).z, baselineGoal(18).z)
    bot._ndSwarmAllies = []
    assert.deepEqual(options.goal().at(0), baseline)
    bot._ndSwarmAllies = ['Ally']
    visible = false
    assert.deepEqual(options.goal().at(0), baseline)
    thrown.delete(charge.id)
    assert.deepEqual(options.goal().at(0), baseline)
  }, arena, 0)
})

test('an arena escort uses its future separation instead of carrying present sideways momentum into the goal', async t => {
  // AQ d +4243 ms establishes the centre arc side, then +5270 ms supplies the observed bodies and movement.
  const bounds = { ...arena, x: 600.5, z: 600.5 }
  const f = fixture(new Vec3(592.785400390625, 171.571044921875, 604.924560546875),
    new Vec3(601.6173297269245, 144.8550790003828, 605.8412203124158))
  const target = new Vec3(590.4267578125, 172.578857421875, 601.160888671875)
  const moved = new Vec3(-.31404594893365356, .8842419850214185, -1.1665428216175542)
  const native = require('../src/tick-plugins').getPhysics()
  const read = p => {
    const block = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sandstone' : 'air'].defaultState)
    block.position = p.floored()
    return block
  }
  f.bot.version = '1.21.11'
  f.bot.blockAt = read
  f.bot.physics = native.Physics(registry, { getBlock: read })
  f.bot._ndLaunchMovement = () => moved
  const seed = new Vec3(-.0362548828125, -.21786149945573896, -.1988525390625), yaw = 4.7860200582032
  const input = { forward: true, back: false, left: false, right: false, jump: false, sprint: true, sneak: false }
  const state = new native.PlayerState({ version: '1.21.11', inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: target, velocity: seed, onGround: false, yaw, pitch: 0, effects: {}, attributes: {} } }, input)
  const frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: false }]
  for (let tick = 0; tick < 32; tick++) {
    f.bot.physics.simulatePlayer(state, { getBlock: read })
    frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
  }
  // Supply the forecast prefix from native physics over known air. The goal still acquires a real fair view.
  assert.ok(Math.abs(frames[6].pos.y - 170.19022315817963) < 1e-10)
  assert.ok(Math.abs(frames[32].pos.y - 135.27137766319206) < 1e-10)
  let observedAt = 1000
  f.target._ndObservationNow = () => observedAt
  f.target._ndPositionReceipts = [null, { kind: 'rel_entity_move', t: observedAt, grounded: false }]
  t.mock.method(motion, 'hasObservedVelocity', () => true)
  t.mock.method(enemy, 'enemyWindFrames', () => frames)
  await capture(t, f, options => {
    options.goal() // The recorded first pose forces the negative arc side.
    f.bot.entity.position = new Vec3(598.7004391897881, 152.68768241806845, 599.5690694222659)
    f.bot.entity.velocity = moved.clone()
    f.target.position = target
    f.target.yaw = yaw
    observedAt += 50
    f.target._ndPositionReceipts = [f.target._ndPositionReceipts[1], { kind: 'rel_entity_move', t: observedAt, grounded: false }]
    f.target.emit('ndPositionObserved')
    const goal = { ...options.goal(), arena: bounds }
    assert.equal(typeof goal.at, 'function')
    const offset = pick.eyeHeight(f.bot, f.target) - pick.eyeHeight(f.bot)
    assert.equal(goal.at(0).y, frames[6].pos.y + offset, 'the current movement must not skip the airborne intercept and select the last frame')
    assert.equal(goal.at(18).y, frames[24].pos.y + offset)

    // Twenty boost ticks are a controlled input. The recorded expiry is unknown.
    const W = worldOf(f.bot), own = { p: f.bot.entity.position, v: f.bot.entity.velocity, boost: 20, fd: 0 }
    const lastPoint = goal.at(0).plus(frames[32].pos.minus(frames[6].pos))
    const old = choose(W, own, { ...goal, at: () => lastPoint })!, selected = choose(W, own, goal)!
    const nextY = plan => {
      const p = { ...own.p }, v = { ...own.v }
      glideStep(p, v, plan.yaw, plan.pitch, true)
      return p.y
    }
    assert.equal(selected.r.kind, null)
    assert.ok(nextY(old) < own.p.y && nextY(selected) > own.p.y, 'the same pilot can climb toward the reachable escort point instead of diving')
  }, bounds)
})

test('native body rays show less lift at the eye plane and reverse an outside gust into an outward one', () => {
  const foe = { id: 2, type: 'player', name: 'player', position: new Vec3(20, 150, 0), height: 1.8, width: .6, metadata: [0] }
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const impulse = (position: Vec3, height: number) => {
    const bot: any = { registry, game: { minY: -64, height: 384 }, ndClock: { age: 100n, ticks: 0, serverTicks: 0 },
      entity: { id: 1, username: 'Blue', position }, entities: { 2: foe }, blockAt: air }
    const report = { id: 'Blue', position, velocity: new Vec3(0, 0, 0), onGround: false, gliding: true, eyeHeight: .4 }
    const shot = enemyWindShot(bot, foe, report, frames, { height })!
    assert.ok(shot)
    return windImpulse(bot, shot.feet, shot.burst, { resistance: 0, height: 1.8, eyeHeight: 1.62 })
  }
  const low = impulse(new Vec3(12, 149.4, 0), .4), below = impulse(new Vec3(12, 149.4, 0), 1.6)
  const level = impulse(new Vec3(12, 151.22, 0), 1.6), outside = impulse(new Vec3(28, 149.4, 0), 1.6)
  assert.ok(low.y > Math.abs(low.x))
  // The native float width and age margin locate the burst at the front of the player collider.
  assert.ok(Math.abs(below.x - .40819055847774943) < 1e-12 && Math.abs(below.y - .10817049751002482) < 1e-12)
  assert.ok(Math.abs(level.x - .3670135755403913) < 1e-12 && Math.abs(level.y - .013763008645252916) < 1e-12)
  assert.ok(level.y < below.y && level.x > 20 * level.y)
  assert.ok(level.x < below.x, 'lower lift does not imply a universally stronger horizontal magnitude')
  assert.ok(outside.x < 0 && level.x > 0)
})

for (const mode of ['contact', 'after_body', 'same_slot_reuse', 'manual_cycle', 'ally_spawn']) test(`an already sent kinetic contact owns one phase: ${mode}`, async t => {
  const current = new Vec3(595.902737, 168.851788, 600.541585)
  const f = fixture(current, new Vec3(599.253834, 168.495588, 600.532115)), { bot, target, ctl } = f
  const bounds = { ...arena, x: 600.5, z: 600.5 }, item = { name: 'netherite_spear', count: 1 }
  const use = { hand: 0, name: item.name, since: 300, confirmed: true }
  const client = new EventEmitter(), timers = new Set<() => void>()
  let now = 1000, reads = 0, steers = 0, released = 0, exits = 0
  t.mock.method(gameClock, 'now', () => now)
  t.mock.method(gameClock.wall, 'monotonic', () => 0)
  t.mock.method(gameClock.wall, 'setTimeout', callback => { timers.add(callback); return callback })
  t.mock.method(gameClock.wall, 'clearTimeout', callback => timers.delete(callback))
  t.mock.method(flight, 'fly', async () => { exits++; return { why: 'вышел' } })
  Object.assign(bot, { _client: client, _ndUse: { cur: use, stats: { uses: 1 } }, heldItem: item, quickBarSlot: 1, fireworkRocketDuration: 2,
    _ndElytra: { fd: 0, driving: 0, startedAt: 0 },
    ndClock: { now: () => now, observationNow: () => now, observationRate: () => 20 },
    look: async (yaw, pitch) => { steers++; Object.assign(bot.entity, { yaw, pitch }) },
    activateItem: () => assert.fail('the armed movement needs no new use'),
    deactivateItem: () => { released++; bot._ndUse.cur = null } })
  bot.inventory.items = () => [item]
  bot.entity.velocity.set(-1.683944, -.236128, .005462)
  const frames = [{ pos: current, vel: new Vec3(-.048297, -.613196, 0) }]
  for (let i = 1; i <= 16; i++) {
    const { pos, vel } = frames.at(-1)!
    frames.push({ pos: pos.plus(vel), vel: new Vec3(vel.x * .91, (vel.y - .08) * .98, 0) })
  }
  const finish = finishWindLance(bot, ctl, target, item, () => {
    const forecast = reads++ === 0 ? frames : [frames[0], ...frames.slice(2)]
    return { ticks: forecast.length - 1, frames: forecast }
  }, bounds, 2000)
  bot.emit('physicsTick')
  assert.equal(steers, 1)
  bot.entity.position.set(597.564414, 168.267437, 600.537282)
  bot.entity.velocity.set(-1.689420, -.228151, .005167)
  bot.fireworkRocketDuration = 1
  now += 50
  bot.emit('physicsTick')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(bot._ndUse.cur, use, 'the last armed movement is still available to the native item phase')
  const nextUse = { ...use, since: now }
  if (mode === 'same_slot_reuse') bot._ndUse.cur = nextUse
  if (mode === 'after_body' || mode === 'manual_cycle') {
    bot.emit('physicsTick')
    assert.equal(released, 1, 'the next movement starts with the spear released')
    if (mode === 'manual_cycle') bot._ndUse.stats.uses++
  }
  if (mode === 'ally_spawn') {
    const ally = { ...target, id: 3, username: 'Ally', position: new Vec3(594, 167.3, 600.54), onGround: true }
    Object.assign(bot, { _ndSwarmAllies: ['Ally'], entities: { [ally.id]: ally } })
    bot.emit('entitySpawn', ally)
    assert.equal(released, 1, 'the visible ally stops use without another physics tick')
  }
  client.emit('damage_event', { entityId: 2, sourceCauseId: 2, sourceDirectId: mode === 'ally_spawn' ? 3 : 2, sourceTypeId: DAMAGE_TYPES.indexOf('spear') })
  for (const timer of timers) timer()
  const confirmed = mode === 'contact' || mode === 'after_body'
  assert.equal((await finish)?.hit, confirmed)
  assert.equal(exits, confirmed ? 1 : 0)
  assert.equal(released, mode === 'same_slot_reuse' ? 0 : 1)
  if (mode === 'same_slot_reuse') assert.equal(bot._ndUse.cur, nextUse)
  assert.equal(steers, 1)
  assert.equal(timers.size, 0)
  assert.equal(client.listenerCount('damage_event'), 0)
})
