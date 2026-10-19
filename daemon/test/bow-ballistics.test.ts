import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import bow = require('../src/bow')
import sky = require('../src/elytra')
import * as ranged from '../src/ranged'

// An independent tick integrator catches changes in gravity/drag order and
// launch inheritance, including the fractional segment inside an entity box.
function arrowAt(from: any, sol: any, inherited: any, speed = 3) {
  const p = from.clone()
  const v = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch) * speed + inherited.x,
    y: Math.sin(sol.pitch) * speed + inherited.y,
    z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) * speed + inherited.z }
  let time = sol.ticks
  while (time > 0) {
    const f = Math.min(1, time)
    p.x += v.x * f; p.y += v.y * f; p.z += v.z * f
    const drag = Math.fround(.99)
    v.x *= drag; v.y = v.y * drag - .05; v.z *= drag
    time -= f
  }
  return p
}

test('bow intersects a crossing 3D target while shooter falls or glides', () => {
  const from = new Vec3(0, 120, 0)
  for (const own of [{ x: -.3, y: -.9, z: .15 }, { x: 1.5, y: -.55, z: -.3 }]) {
    const target = (t: number) => new Vec3(18 - .23 * t, 110 - .28 * t, 8 + .12 * t)
    const sol = bow.aimMoving(from, target, own, true)
    assert.ok(sol)
    assert.ok(arrowAt(from, sol, own).distanceTo(target(sol.ticks)) < 1e-7)
    assert.ok(arrowAt(from, sol, { ...own, y: 0 }).distanceTo(target(sol.ticks)) > 2)
  }
})

test('ground ignores vertical shooter motion; impossible intercept has no raw fallback', () => {
  const from = new Vec3(0, 80, 0)
  const target = () => new Vec3(25, 81, -8)
  const own = { x: .23, y: -3, z: -.11 }
  const sol = bow.aimMoving(from, target, own, false)
  assert.ok(arrowAt(from, sol, { ...own, y: 0 }).distanceTo(target()) < 1e-7)
  assert.equal(bow.aimMoving(from, target, { x: 20, y: 0, z: 0 }, true), null)
})

test('3D lead recomputes reversed strafe and integrates native falling motion', () => {
  const entity = { position: new Vec3(20, 110, 3), height: 1.8, onGround: false }
  const vel = { x: .24, y: -.42, z: .16 }
  const target = bow.leadTarget(entity, () => vel)
  const p = entity.position.clone()
  let vy = vel.y
  for (let i = 0; i < 8; i++) { p.y += vy; vy = (vy - .08) * Math.fround(.98) }
  assert.ok(Math.abs(target(8).y - (p.y + 1.8 * .55)) < 1e-9)
  assert.equal(target(8).x, 21.92)
  vel.x = -.24
  assert.equal(target(8).x, 18.08)
})

test('target tracker follows the latest observed reversal and native falling velocity', () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const originalNow = clock.now
  let now = 1000
  clock.now = () => now
  const entity = { position: new Vec3(0, 100, 0), onGround: false }
  const tracker = bow.trackTarget(entity, () => now)
  try {
    tracker.update()
    let vy = -.4
    for (let i = 0; i < 3; i++) { entity.position.x += .2; entity.position.y += vy; vy = (vy - .08) * Math.fround(.98); now += 50 }
    tracker.update()
    assert.ok(Math.abs(tracker.vel().y - vy) < 1e-10)
    assert.ok(Math.abs(tracker.vel().x - .2) < 1e-10)
    entity.onGround = true
    entity.position.x -= .3; now += 50; tracker.update()
    assert.ok(Math.abs(tracker.vel().x + .3) < 1e-10, 'old forward motion must not mask a new reverse')
  } finally { clock.now = originalNow }
})

test('Air37 consecutive falling displacements recover endpoint velocity despite aliased receipt intervals', () => {
  let at = 1791248848748.286
  const entity: any = Object.assign(new EventEmitter(), { type: 'player', onGround: false, metadata: [],
    position: new Vec3(4105.781978536276, 179.9215999984741, 3120.5), _ndObservationNow: () => at })
  entity._ndPositionReceipts = [null, { ...entity.position, t: at, grounded: false, kind: 'sync_entity_position' }]
  const tracker = bow.trackTarget(entity)
  // Native Air37 physical intervals are 2, 1, 2, 3 ticks. The arrival clock
  // instead dates them 1.43, 1.87, 2.31, 3.32 ticks; no phase0 is supplied.
  const points = [
    [4106.134517598776, 179.5358578109741, 1791248848820.03, null],
    [4106.324947286276, 179.2314144515991, 1791248848913.4492, -.37663049823865513],
    [4106.730220723776, 178.4074398422241, 1791248849029.0315, -.5169479491049732],
    [4107.388423848776, 176.6537777328491, 1791248849195.218, -.7170746714356033]
  ]
  for (const [x, y, t, vy] of points) {
    entity.position = new Vec3(x, y, 3120.5); at = t
    entity._ndPositionReceipts = [entity._ndPositionReceipts[1], { ...entity.position, t: at, grounded: false, kind: 'rel_entity_move' }]
    entity.emit('ndPositionObserved')
    if (vy !== null) assert.ok(Math.abs(tracker.vel().y - vy) < 1 / 4096, 'the recovered next velocity stays within native position quantization')
  }
  at += 50
  entity._ndPositionReceipts = [entity._ndPositionReceipts[1], { ...entity.position, t: at, grounded: false, kind: 'rel_entity_move' }]
  entity.emit('ndPositionObserved')
  assert.equal(tracker.hasVelocity(), true)
  assert.deepEqual(tracker.vel(), { x: 0, y: 0, z: 0, ageTicks: 0 }, 'a measured stationary target clears previous fall intervals')
})

test('ambiguous falling intervals retain the existing observation fallback without assuming a start phase', () => {
  let at = 1000
  const entity: any = Object.assign(new EventEmitter(), { type: 'player', onGround: false, metadata: [],
    position: new Vec3(0, 100, 0), _ndObservationNow: () => at })
  entity._ndPositionReceipts = [null, { ...entity.position, t: at, grounded: false, kind: 'sync_entity_position' }]
  const tracker = bow.trackTarget(entity)
  const fallback = bow.trackTarget(entity, () => at); fallback.update()
  // Both native interval pairs (1,1) and (3,2) fit these displacements with
  // different unknown initial velocities. Their final tick count is ambiguous.
  for (const dy of [-.8906806115075168, -.9512670177916298]) {
    entity.position.y += dy; at += 100
    entity._ndPositionReceipts = [entity._ndPositionReceipts[1], { ...entity.position, t: at, grounded: false, kind: 'rel_entity_move' }]
    entity.emit('ndPositionObserved'); fallback.update()
  }
  assert.deepEqual(tracker.vel(), fallback.vel())
  assert.equal(tracker.hasVelocity(), true, 'two actual displacements permit the honest fallback when their final interval is ambiguous')
})

test('batched native ground moves stabilize speed while a reversal updates direction immediately', () => {
  let now = 0
  const entity = { position: new Vec3(0, 140, 0), onGround: true }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update()
  for (let i = 1; i <= 10; i++) { now = i * 100; entity.position.x = i * .56; tracker.update() }
  now += 1; entity.position.x += .56; tracker.update()
  assert.ok(tracker.vel().x > .25 && tracker.vel().x < .35, 'packet batching must not create a 28-block/tick runner')
  now += 1; entity.position.x -= .56; tracker.update()
  assert.ok(tracker.vel().x < -.25 && tracker.vel().x > -.35, 'magnitude smoothing must not delay the latest reversed direction')
})

test('air31 delayed then compressed falling receipts retain native-scale velocity and fresh age', () => {
  // Native world14065288 ->89/90 ->91/92, quantized positions from air31.
  // The last two native steps arrived only 0.2422 wall ms apart. Their observed
  // elapsed game time cannot be treated as an independent physics interval.
  let now = 0
  const entity = { position: new Vec3(4105.953240531268, 179.76636799395752, 3120.5), onGround: false }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update()
  now = 160.720947265625
  entity.position.set(4106.134637015643, 179.53589924395752, 3120.5); tracker.update()
  now = 169.187744140625
  entity.position.set(4106.524041312518, 178.85499104083252, 3120.5); tracker.update()
  const velocity = tracker.vel()
  // Native horizontal displacement~.19 and next falling velocity−.4475.
  assert.ok(velocity.x > .15 && velocity.x < .25, `batching must not invent ${velocity.x} blocks/tick horizontal motion`)
  assert.ok(Math.abs(velocity.y + .44749789698341763) < .08, `falling estimate must remain within one native gravity step: ${velocity.y}`)
  now += 50
  assert.equal(tracker.vel().ageTicks, 1, 'velocity sampling must not change the latest position receipt age')
})

test('a compressed glider reversal changes the last horizontal direction before the aim read', () => {
  let now = 0
  const entity = { position: new Vec3(0, 100, 0), onGround: false, metadata: [128] }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update()
  for (let i = 0; i < 3; i++) { now += 50; entity.position.x += .3; entity.position.y -= .1; entity.position.z += .1; tracker.update() }
  now += 5; entity.position.x -= .3; entity.position.y -= .1; entity.position.z += .1; tracker.update()
  const velocity = tracker.vel()
  assert.ok(velocity.x < 0 && velocity.z > 0 && velocity.y < 0, 'bounded magnitude observations must retain the latest actual 3D direction')
  assert.ok(Math.hypot(velocity.x, velocity.z) < 1, 'sub-tick packet arrival must not invent a 3-block/tick glider')
})

test('a runner that starts after frozen readiness does not average its speed over idle time', () => {
  let now = 0
  const entity = { position: new Vec3(0, 140, 0), onGround: true }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update()
  now = 4000; entity.position.x = .28; tracker.update()
  now += 100; entity.position.x += .56; tracker.update()
  assert.ok(Math.abs(tracker.vel().x - .28) < 1e-10, 'only actual moving observations define the new runner speed')
  now += 100; entity.position.x -= .56; tracker.update()
  assert.ok(Math.abs(tracker.vel().x + .28) < 1e-10, 'a fresh reversed vector remains current after the new baseline')
})

test('ballistic lead includes the age of a received position without mistaking packet delay for a stop', () => {
  let now = 1000
  const entity = { position: new Vec3(0, 140, 0), height: 1.8, onGround: true }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update()
  now += 100; entity.position.x = .4; tracker.update()
  now += 200
  assert.equal(tracker.vel().x, .2)
  assert.equal(tracker.vel().ageTicks, 4)
  assert.ok(Math.abs(bow.leadTarget(entity, tracker.vel)(5).x - 2.2) < 1e-10)
  assert.ok(Math.abs(tracker.at(5).x - 2.2) < 1e-10)
})

test('glider lead uses native glide step and interpolates fractional server ticks', () => {
  const entity = { position: new Vec3(20, 110, 3), height: 1.8, elytraFlying: true, yaw: -.8, pitch: -.1 }
  const vel = { x: .7, y: -.12, z: -.3 }
  const p = { ...entity.position }; const v = { ...vel }
  for (let i = 0; i < 5; i++) sky.glideStep(p, v, entity.yaw, entity.pitch, false)
  const next = { ...p }; sky.glideStep(next, v, entity.yaw, entity.pitch, false)
  const actual = bow.leadTarget(entity, () => vel)(5.4)
  const expected = new Vec3(p.x + (next.x - p.x) * .4, p.y + (next.y - p.y) * .4 + .6 * .55, p.z + (next.z - p.z) * .4)
  assert.ok(actual.distanceTo(expected) < 1e-9)
})

test('trajectory collision checks retain the airborne vertical inherited velocity', () => {
  let observed: any
  const bot = { entity: { onGround: false }, world: { raycast: (_p: any, direction: any) => { observed = direction; return { position: new Vec3(1, 1, 1) } } } }
  bow.blockedAt(bot, new Vec3(0, 10, 0), { yaw: 0, pitch: 0, ticks: 2 }, { x: 0, y: -1, z: 0 })
  assert.ok(observed.y < -.3)
})

test('trajectory checks stop at an intercept just after a whole tick, before the floor behind it', () => {
  const from = new Vec3(0, 19.77, 0)
  const own = { x: .015, y: -1.2, z: .25 }
  const sol = bow.aimMoving(from, () => new Vec3(5, .99, 19), own, true)
  assert.ok(sol.ticks % 1 > 0 && sol.ticks % 1 < .05)
  const bot = { entity: { onGround: false }, world: { raycast: (p: any, dir: any, reach: number) => {
    const distance = -p.y / dir.y
    return dir.y < 0 && distance >= 0 && distance <= reach ? { position: new Vec3(5, -1, 19) } : null
  } } }
  assert.equal(bow.blockedAt(bot, from, sol, own), null)
  // A floor between the shooter and the target must still reject the shot.
  bot.world.raycast = (p: any, dir: any, reach: number) => {
    const distance = (10 - p.y) / dir.y
    return dir.y < 0 && distance >= 0 && distance <= reach ? { position: new Vec3(2, 9, 9) } : null
  }
  assert.deepEqual(bow.blockedAt(bot, from, sol, own), new Vec3(2, 9, 9))
})

test('airborne crossbow uses gliding eyes, no inherited motion, and a fresh observation after collision work', async () => {
  const bot: any = new EventEmitter()
  const owner = new AsyncLocalStorage<string>()
  const owners: any[] = []
  const item = { name: 'crossbow', slot: 36, components: [{ type: 'charged_projectiles', data: { projectiles: [{ itemCount: 1, itemId: 1 }] } }] }
  // Use native component reader's object format from the existing ranged tests.
  const read: typeof import('../src/read') = require('../src/read')
  const saved = read.crossbowInfo
  read.crossbowInfo = () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }) as any
  const entity = { id: 2, type: 'player', position: new Vec3(20, 100, 0), height: 1.8, onGround: true }
  bot.entity = { id: 1, position: new Vec3(0, 100, 0), velocity: new Vec3(1, -.8, 0), metadata: { 6: 1 }, onGround: false }
  let age = 0
  bot.registry = {}; bot.world = { raycast: () => { age = 3; return null } }; bot.inventory = { slots: [item] }; bot.inventory.slots[36] = item
  bot.quickBarSlot = 0; bot.look = (yaw: number, pitch: number) => { owners.push(owner.getStore()); bot.entity.yaw = yaw; bot.entity.pitch = pitch; return Promise.resolve() }
  bot.setQuickBarSlot = () => {}; bot.activateItem = () => owners.push(owner.getStore())
  try {
    const result = owner.run('aerial crossbow', () => ranged.fire(bot, entity, item, { velFn: () => ({ x: .2, y: 0, z: 0, ageTicks: age }) }))
    bot.emit('physicsTick'); bot.emit('physicTick')
    const fired = await result
    assert.equal(fired.fired, true)
    const speed = Math.fround(3.15)
    const sol = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, ticks: fired.ticks }
    const future = entity.position.offset(.2 * (fired.ticks + 3), .99, 0)
    assert.ok(arrowAt(new Vec3(0, 100.3, 0), sol, { x: 0, y: 0, z: 0 }, speed).distanceTo(future) < 1e-7)
    assert.ok(owners.length >= 2 && owners.every(value => value === 'aerial crossbow'))
  } finally { read.crossbowInfo = saved }
})

test('crossbow release precedes later movement packets in a synchronous catch-up burst', async () => {
  const bot: any = new EventEmitter()
  const order: string[] = []
  ranged.afterPacket(bot, () => order.push('release'))
  order.push('movement 1')
  for (let i = 2; i <= 4; i++) { bot.emit('physicsTick'); order.push('movement ' + i) }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['movement 1', 'release', 'movement 2', 'movement 3', 'movement 4'])
})

test('bow release preserves its control owner and first movement origin through a catch-up burst', async () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const c = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(c)
  const owner = new AsyncLocalStorage<string>()
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  const item = { name: 'bow', slot: 36 }
  bot.inventory = { items: () => [item, { name: 'arrow' }] }; bot.heldItem = item
  bot.entity = { id: 1, position: new Vec3(0, 20, 0), velocity: new Vec3(.1, 0, 0), onGround: false }
  bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }; bot.world = { raycast: () => null }
  bot.quickBarSlot = 0; bot.setQuickBarSlot = () => {}
  const owners: any[] = []
  bot.look = (yaw: number, pitch: number) => { owners.push(owner.getStore()); bot.entity.yaw = yaw; bot.entity.pitch = pitch; return Promise.resolve() }
  bot.activateItem = () => { owners.push(owner.getStore()); bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] }) }
  let sentPosition = bot.entity.position.clone()
  const releases: any[] = []
  bot.deactivateItem = () => { owners.push(owner.getStore()); releases.push(sentPosition.clone()) }
  const target = { id: 2, position: new Vec3(1, 20, 0), height: 1.8, onGround: true }
  c.attach(bot); bot._client.emit('update_time', { age: 1000n })
  const shooting = owner.run('aerial action', () => bow.shoot(bot, target, { drawMs: 0, follow: false }))
  for (let i = 1; i <= 4; i++) {
    bot.entity.position.x = i * .1
    bot.emit('physicsTick'); bot.emit('physicTick')
    sentPosition = bot.entity.position.clone()
  }
  const result = await shooting
  assert.equal(result.shot, true)
  assert.equal(result.from.x, .1)
  assert.deepEqual(releases.map(p => p.x), [.1], 'release uses the first sent movement, before packets 2–4')
  assert.ok(owners.length >= 3 && owners.every(value => value === 'aerial action'))
  bot.emit('end'); c.dispose()
})

for (const weapon of ['bow', 'crossbow']) test(`aerial ${weapon} waits for velocity after absolute synchronization or a glide transition`, async t => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const read: typeof import('../src/read') = require('../src/read')
  t.mock.method(read, 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  for (const outcome of ['reversal', 'stationary', 'timeout', 'glide-reversal', 'glide-stationary', 'glide-timeout', 'fall-first', 'fall-first-timeout']) await t.test(outcome, async child => {
    const c = new clock.GameClock({ manual: true, epoch: 1000 })
    clock.activate(c); child.after(() => c.dispose())
    const target: any = Object.assign(new EventEmitter(), { id: 2, type: 'player',
      position: outcome.startsWith('fall-first') ? new Vec3(4105.781978536276, 179.9215999984741, 3120.5)
        : new Vec3(4105.953240531268, 179.76636799395752, 3120.5), height: 1.8,
      onGround: false, yaw: 0, pitch: 0, metadata: [], _ndObservationNow: () => c.now() })
    // Exact Air34 crossbow/both-falling release had only this absolute
    // receipt: its zero velocity was a reset baseline, not a measured stop.
    target._ndPositionReceipts = [null, { ...target.position, t: c.now(), grounded: false, kind: 'sync_entity_position' }]
    const tracker = bow.trackTarget(target)
    const bot: any = new EventEmitter()
    bot._client = new EventEmitter()
    const item = { name: weapon, slot: 36 }
    let releases = 0; let drawCalls = 0
    bot.inventory = { items: () => [item, { name: 'arrow' }], slots: [] }; bot.inventory.slots[36] = item
    bot.heldItem = item; bot.quickBarSlot = 0; bot.setQuickBarSlot = value => { bot.quickBarSlot = value }
    bot.entity = { id: 1, position: target.position.offset(-1, -.5, 0), velocity: new Vec3(.1, -.4, 0), onGround: false }
    bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }; bot.world = { raycast: () => null }; bot.blockAt = () => null
    bot.controls = { forward: true }
    bot.look = (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; return Promise.resolve() }
    bot.activateItem = () => {
      if (weapon === 'crossbow') releases++
      else bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] })
    }
    bot.deactivateItem = () => { releases++ }
    c.attach(bot); bot._client.emit('update_time', { age: 1000n })
    const shooting = weapon === 'bow'
      ? bow.shoot(bot, target, { follow: false, onDraw: () => { drawCalls++ } })
      : ranged.fire(bot, target, item)
    const frame = () => {
      c.advanceTicks(1); bot._client.emit('update_time', { age: 1000n + BigInt(c.ticks) })
      bot.entity.position.x += .1; bot.entity.position.y -= .4
      bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
    }
    if (weapon === 'bow') {
      for (let tick = 0; tick < bow.DRAW_MS / 50; tick++) {
        await new Promise(resolve => setImmediate(resolve)); frame()
      }
      await new Promise(resolve => setImmediate(resolve))
      target._ndPositionReceipts = [target._ndPositionReceipts[1],
        { ...target.position, t: c.now(), grounded: false, kind: 'sync_entity_position' }]
      target.emit('ndPositionObserved')
    }
    frame()
    assert.equal(releases, 0, 'an absolute baseline alone must not release an airborne shot')
    assert.equal(bot.controls.forward, true, 'waiting for a receipt must preserve flight controls')
    const relative = (dx, dy, dz = 0, at = c.now()) => {
      target.position = target.position.offset(dx, dy, dz)
      target._ndPositionReceipts = [target._ndPositionReceipts[1],
        { ...target.position, t: at, grounded: false, kind: 'rel_entity_move',
          yaw: target.yaw, pitch: target.pitch, flying: !!target.elytraFlying, boosted: false }]
      target.emit('ndPositionObserved')
    }
    let fallBaseline = 0
    if (outcome.startsWith('fall-first')) {
      fallBaseline = target._ndPositionReceipts[1].t
      // Air38 crossbow/both-falling released after this first displacement.
      // The next real receipt, 0.5125 wall ms after use_item, was the first
      // pair that could recover its physical interval and endpoint velocity.
      relative(1444 / 4096, -1580 / 4096, 0, fallBaseline + 107.944091796875)
      frame()
      assert.equal(tracker.hasVelocity(), false, 'a single falling displacement has no observed physical endpoint yet')
      assert.equal(releases, 0, 'the first falling displacement must not release an airborne shot')
      assert.equal(bot.controls.forward, true)
    }
    if (outcome.startsWith('glide-')) {
      target.elytraFlying = true
      if (outcome !== 'glide-stationary') {
        // Air35 crossbow/opposite-gliders: the first movement after the
        // native flying flag still carried the last ordinary fall step.
        relative(0, -321 / 4096, -1094 / 4096)
        frame()
        assert.equal(tracker.hasVelocity(), false, 'a moving interval spanning a flight phase change is a new baseline')
        assert.equal(releases, 0, 'the old fall displacement must not release a glide prediction')
      }
    }
    if (outcome.endsWith('timeout')) {
      for (let tick = 0; tick < 9; tick++) frame()
      const result = await shooting
      assert.equal(weapon === 'bow' ? result.shot : result.fired, false)
      assert.equal(releases, 0, 'the bounded wait must cancel without consuming an arrow')
      assert.equal(bot.listenerCount('physicsTick'), 0, 'timed-out observation waits remove their movement observers')
      assert.equal(bot.listenerCount('physicTick'), 0, 'timed-out observation waits remove the late final aim listener')
      return
    }
    if (outcome === 'fall-first') relative(2440 / 4096, -4622 / 4096, 0, fallBaseline + 254.65673828125)
    else if (outcome.endsWith('stationary')) relative(0, 0)
    else if (outcome === 'glide-reversal') {
      target.yaw = Math.PI
      relative(0, -.15, .05) // The changed native heading starts a fresh phase.
      const p = { ...target.position }; const v = { x: 0, y: -.3, z: .2 }
      for (let interval = 0; interval < 2; interval++) {
        for (let i = 0; i < 2; i++) sky.glideStep(p, v, target.yaw, 0, false)
        relative(p.x - target.position.x, p.y - target.position.y, p.z - target.position.z)
      }
    }
    else { relative(.2, -.15); relative(-.4, -.15) }
    frame()
    const result = await shooting
    assert.equal(weapon === 'bow' ? result.shot : result.fired, true)
    assert.equal(releases, 1, 'the next measured relative observation permits exactly one release')
    if (outcome === 'fall-first') assert.ok(Math.abs(tracker.vel().y - (-.5169479491049732)) < 1 / 4096, 'the next real Air38 displacement recovers the native endpoint')
    else if (outcome.endsWith('stationary')) assert.equal(tracker.vel().x, 0, 'a measured stationary target may be shot')
    else if (outcome === 'glide-reversal') assert.ok(tracker.vel().z > 0 && result.aimAt.z > target.position.z, 'new glide intervals follow the latest actual reversed direction')
    else assert.ok(tracker.vel().x < 0 && result.aimAt.x < target.position.x, 'release follows the actual latest reversal')
    if (weapon === 'bow') assert.ok(drawCalls >= 1, 'standalone bow draw movement continues during the bounded wait')
    assert.equal(bot.controls.forward, true)
  })
})
