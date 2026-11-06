import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

for (const sprinting of [false, true]) for (const ageTicks of [0, 3]) test(`recorded wind knockback keeps native airborne inertia unless sprint is visible (${sprinting}, age ${ageTicks})`, t => {
  const { bot, foe, cells } = fixture()
  const edges = require('../src/edges') as typeof import('../src/edges')
  const { enemyWindFrames } = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  // Native30 I, reactive-up-idle, c release1793789732337: received body after the first wind impulse.
  foe.position = new Vec3(596.417236328125, 133.814453125, 601.421875)
  foe.velocity = new Vec3(-.38374161149057645, -.07601604307940271, .08668749159280793)
  foe.metadata[0] = sprinting ? 8 : 0 // Entity.isSprinting/getSharedFlag(3), Paper1.21.11 Entity.class.
  // This pure body-physics control supplies its measured velocity explicitly; it is an uninstalled/raw caller.
  bot.entity.position = new Vec3(608.5, 120, 598.5)
  cells.clear()
  for (let x = 580; x <= 620; x++) for (let z = 580; z <= 620; z++) cells.set(`${x},119,${z}`, 'sand')
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ ...foe.velocity, ageTicks }))
  const yaw = Math.atan2(-foe.velocity.x, -foe.velocity.z)
  const control = { ...edges.IDLE, ...(sprinting ? { forward: true, sprint: true } : {}) }
  const entity = { position: foe.position.clone(), velocity: foe.velocity.clone(), onGround: false, yaw,
    pitch: 0, effects: {}, attributes: {}, _ndPoseHeight: 1.8 }
  const expected = edges.stateOf({ ...bot, entity }, control), simulate = edges.simOf(bot), world = edges.worldOf(bot)
  for (let tick = 0; tick < ageTicks; tick++) simulate(expected, world)
  const frames = enemyWindFrames(bot, foe, { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }, [], 0, true)
  for (let tick = 0; tick <= 13; tick++) {
    assert.ok(frames[tick].pos.distanceTo(expected.pos) < 1e-8, `tick${tick}: received wind drift cannot invent a running input`)
    simulate(expected, world)
  }
})

for (const sample of [
  { name: 'opposing wind', at: [598.801025390625, 131.21541014313698, 599.291259765625], yaw: 4.0987966652304335,
    velocity: { x: -.1226806640625, y: .006900679634399581, z: -.064697265625 }, end: [598.7741127004323, 129.66835295677728, 599.370108803487] },
  { name: 'through zero momentum', at: [598.95263671875, 130.77791014313698, 599.661865234375], yaw: 4.221515128261284,
    velocity: { x: .009103070803337847, y: -.023296557282340556, z: .02561561784195069 }, end: [599.5937823701138, 129.03186602609443, 600.1041136132089] }
]) test(`recorded X2 airborne sprint steers towards the centre ${sample.name}`, t => {
  const { bot, foe, cells } = fixture()
  cells.clear(); bot.entity.position = new Vec3(608.5, 120, 602.5)
  for (let x = 580; x <= 620; x++) for (let z = 580; z <= 620; z++) cells.set(`${x},119,${z}`, 'sand')
  // Actual 31r/31i seeds: seven native steps entirely before the next visible gust.
  foe.position = new Vec3(sample.at[0], sample.at[1], sample.at[2])
  foe.yaw = sample.yaw; foe.metadata[0] = 8
  const measured = { ...sample.velocity, ageTicks: 0 }
  Object.defineProperties(foe, {
    velocity: { get() { throw Error('raw foreign velocity is not observed momentum') } },
    health: { get() { throw Error('exact player health is private') } }
  })
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => measured)
  const { enemyWindFrames } = require('../src/combat/enemy-wind')
  const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }
  const frames = enemyWindFrames(bot, foe, arena, [], 0, true)
  const actual = new Vec3(sample.end[0], sample.end[1], sample.end[2])
  assert.ok(frames[7].pos.distanceTo(actual) < .2,
    `observed forward heading opposes the gust; native endpoint ${actual}, forecast ${frames[7].pos}`)
  for (let y = 120; y <= 140; y++) for (let z = 580; z <= 620; z++) cells.set(`604,${y},${z}`, 'stone')
  Object.defineProperty(foe, 'yaw', { get() { throw Error('hidden look is not observable') } })
  assert.deepEqual(enemyWindFrames(bot, foe, arena, [], 0, true), [], 'hidden look and motion cannot enter a forecast')
})

for (const mode of ['ground strafe', 'aligned air', 'missing air yaw', 'nonfinite air yaw', 'zero air sprint', 'slow air sprint', 'slow ground']) {
  test(`wind sprint heading preserves ${mode}`, t => {
    const { bot, foe, cells } = fixture(), edges = require('../src/edges')
    const ground = mode === 'ground strafe' || mode === 'slow ground'
    const velocity = mode === 'zero air sprint' ? new Vec3(0, .3, 0) : mode.startsWith('slow') ? new Vec3(.02, ground ? 0 : .3, .015) : new Vec3(-.25, ground ? 0 : .3, -.1)
    const heading = Math.atan2(-velocity.x, -velocity.z)
    foe.position = new Vec3(600, ground ? 120 : 130, 600); foe.onGround = ground; foe.metadata[0] = 8
    foe.yaw = ground ? heading + Math.PI / 2 : mode === 'aligned air' ? heading : mode.endsWith('air sprint') ? -2.1 : mode === 'nonfinite air yaw' ? NaN : undefined
    cells.clear(); bot.entity.position = new Vec3(608, 120, 602)
    for (let x = 580; x <= 620; x++) for (let z = 580; z <= 620; z++) cells.set(`${x},119,${z}`, 'sand')
    t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ ...velocity, ageTicks: 0 }))
    const expected = edges.stateOf({ ...bot, entity: { position: foe.position.clone(), velocity: velocity.clone(),
      onGround: ground, yaw: !ground && Number.isFinite(foe.yaw) ? foe.yaw : heading, pitch: 0, effects: {}, attributes: {}, _ndPoseHeight: 1.8 } },
    mode === 'slow ground' ? edges.IDLE : { ...edges.IDLE, forward: true, sprint: true })
    const frames = require('../src/combat/enemy-wind').enemyWindFrames(bot, foe, { x: 600.5, z: 600.5, r: 80 }, [], 0, true)
    for (let tick = 0; tick <= 7; tick++) {
      assert.ok(frames[tick].pos.distanceTo(expected.pos) < 1e-8, `tick${tick}: ${mode}`)
      edges.simOf(bot)(expected, edges.worldOf(bot))
    }
  })
}

function fixture() {
  const cells = new Map<string, string>()
  for (let x = -8; x <= 4; x++) for (let z = -5; z <= 5; z++) cells.set(`${x},0,${z}`, 'stone')
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: [], items: () => [] }, entities: {},
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, physics: native.Physics(registry, world)
  })
  const foe: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', isValid: true,
    position: new Vec3(3.5, 2.5, .5), velocity: new Vec3(.08, .2, 0), onGround: false, height: 1.8, width: .6,
    equipment: [], metadata: [] }
  bot.entities[2] = foe
  const throwers = [-2, -4, -6].map((x, i) => ({ id: String.fromCharCode(65 + i), position: { x, y: 1, z: [.5, -1, 2][i] }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  const options = { arena: { x: -1.5, z: .5, r: 6.5, killY: -10 }, startTick: 505, maxShots: 3 }
  return { bot, foe, throwers, options, cells }
}

test('enemy wind forecasts the native airborne body and schedules distinct throwers/arrival ticks', t => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  foe.position.x = 2 // Keep the native two-shot chain necessary under continued observed input; x3.5 now exits after one shot.
  const before = foe.position.clone()
  const plan = planEnemyWind(bot, foe, throwers, options)
  assert.ok(plan, 'a visible airborne target near the void is worth a wind chain')
  assert.ok(plan.shots.length >= 2, JSON.stringify(plan))
  assert.equal(new Set(plan.shots.map(s => s.thrower)).size, plan.shots.length)
  assert.equal(new Set(plan.shots.map(s => s.arrivalTick)).size, plan.shots.length)
  assert.ok(plan.shots.every(s => s.fireTick >= options.startTick && s.arrivalTick > s.fireTick))
  assert.ok(plan.shots.some(s => Math.abs(s.feet.y - (foe.position.y + foe.velocity.y * (s.arrivalTick - 500))) > .1), 'gravity is forecast by the body, not a constant vertical lead')
  assert.ok(plan.nominal.progress > plan.baseline.progress)
  assert.equal(plan.baseline.out, false)
  assert.equal(plan.nominal.out, true)
  assert.deepEqual(foe.position, before, 'planning cannot move the real enemy')
  t.diagnostic(JSON.stringify({ shots: plan.shots.map(s => ({ thrower: s.thrower, fireTick: s.fireTick, arrivalTick: s.arrivalTick })), baseline: plan.baseline, nominal: plan.nominal, worst: plan.worst }))
})

test('entity-hit burst is the actual intercepted body surface, with the age-dependent native margin', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers } = fixture()
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const shot = enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 })
  assert.ok(shot)
  const margin = Math.max(0, Math.min(.3, (shot.ticks - 2) / 20))
  assert.ok(Math.abs(shot.burst.x - (foe.position.x - .3 - margin)) < 1e-6)
  assert.ok(shot.burst.distanceTo(foe.position.offset(0, 1.4, 0)) > .3)
})

test('a distant native wind interception uses the supplied forecast beyond thirty ticks', () => {
  const { bot, foe, cells } = fixture(), core: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  bot.entity.position = new Vec3(-50, 1, .5); foe.position = new Vec3(3.5, 1, .5); foe.onGround = true; foe.velocity = new Vec3(0, 0, 0)
  for (let x = -55; x <= 4; x++) for (let z = -5; z <= 5; z++) cells.set(`${x},0,${z}`, 'stone')
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: true }))
  const owner = { id: 'A', position: { ...bot.entity.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  const shot = core.enemyWindShot(bot, foe, owner, frames, { height: .4 })
  assert.ok(shot && shot.ticks > 30, 'native charge lifetime is not thirty ticks')
  assert.equal(core.enemyWindShot(bot, foe, owner, frames.slice(0, 30), { height: .4 }), null, 'no hit can be invented beyond the available body forecast')
  const arena = { x: 3.5, z: .5, r: 80 }
  const changed = core.enemyWindFrames(bot, foe, arena, [shot], 0, true)
  assert.ok(changed[shot.ticks + 1].pos.distanceTo(foe.position) > .01, 'the native rollout applies that same late impact')
  cells.set('-25,1,0', 'stone'); cells.set('-25,2,0', 'stone')
  assert.equal(core.enemyWindShot(bot, foe, owner, frames, { height: .4 }), null, 'the longer native ray still stops at an opaque block')
})

test('a long native wind ray cannot hit a body after its world-ceiling explosion', () => {
  const { bot, foe } = fixture(), { enemyWindShot } = require('../src/combat/enemy-wind')
  bot.entity.position = new Vec3(-50, 348.2, .5)
  foe.position = new Vec3(3.5, 348.2, .5); foe.velocity = new Vec3(0, 0, 0)
  const owner = { id: 'A', position: { ...bot.entity.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: false }
  const frames = () => Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const legal = enemyWindShot(bot, foe, owner, frames(), { height: .4 })
  assert.ok(legal && legal.ticks > 30, 'a legal high target has no invented height veto')
  foe.position.y = 355
  assert.equal(enemyWindShot(bot, foe, owner, frames(), { height: .4 }), null, 'the native charge explodes at floorY350 before reaching this body')
})

test('a ready enemy shield does not cancel a long native gust when direct damage is blocked', () => {
  const { bot, foe, cells } = fixture(), core: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  bot.entity.position = new Vec3(-12.5, 1, .5); foe.position = new Vec3(3.5, 1, .5)
  foe.onGround = true; foe.velocity = new Vec3(0, 0, 0); foe.yaw = Math.PI / 2
  foe.equipment[1] = { name: 'shield' }
  const flags = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  foe.metadata[flags >= 0 ? flags : 8] = 3 // Already using the offhand shield towards the thrower.
  Object.defineProperty(foe, 'health', { get() { throw Error('shielded player HP is private') } })
  for (let x = -15; x <= 4; x++) for (let z = -5; z <= 5; z++) cells.set(`${x},0,${z}`, 'stone')
  const owner = { id: 'A', position: { ...bot.entity.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  assert.equal(require('../src/mace').shieldAtUs(bot, foe, owner.position), true)
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: true }))
  const shot = core.enemyWindShot(bot, foe, owner, frames, { height: .4 })
  assert.ok(shot && shot.ticks > 5, 'native entity collision still explodes after the shield blocking delay')
  const arena = { x: 3.5, z: .5, r: 80 }, baseline = core.enemyWindFrames(bot, foe, arena, [], 0, true)
  // Public rollout defaults to mask0: no ordinary direct-hit damage/knockback is accepted.
  const gustOnly = core.enemyWindFrames(bot, foe, arena, [shot], 0, true)
  assert.ok(gustOnly[shot.ticks + 1].pos.x > baseline[shot.ticks + 1].pos.x + .1, 'the independently certified gust moves the shielded body outward')
})

test('controlled score policy accepts positive half-centimetre gain and rejects exact zero', t => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  for (const gain of [.005, 0]) {
    const { bot, foe, throwers, options } = fixture()
    foe.position.y = 1; foe.onGround = true; foe.velocity = new Vec3(0, 0, 0)
    // Deliberately controlled body model tests selection policy, not native movement coefficients.
    const stub = t.mock.method(bot.physics, 'simulatePlayer', state => {
      if (state.vel.norm() > 0) state.pos.x += gain
      state.vel.update(new Vec3(0, 0, 0)); state.onGround = true
      return state
    })
    try {
      const plan = planEnemyWind(bot, foe, [throwers[0]], { ...options, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true })
      if (gain > 0) {
        assert.ok(plan, 'a positive useful score has no invented centimetre minimum')
        assert.ok(Math.abs(plan.nominal.progress - plan.baseline.progress - gain) < 1e-12)
      } else assert.equal(plan, null, 'an exactly zero useful score still spends no charge')
    } finally { stub.mock.restore() }
  }
})

test('wind entity collision needs a native AABB entry, not a ray beginning inside the body', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers } = fixture()
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  // ProjectileUtil.getEntityHitResult -> AABB.clip, verified with the real Paper1.21.11 AABB Java oracle.
  assert.ok(enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 }), 'entry from outside remains a hit')
  const overlapping = { ...throwers[0], position: { ...foe.position } }
  assert.equal(enemyWindShot(bot, foe, overlapping, frames, { height: 1.4 }), null, 'native clip has no entering face when the ray starts inside')
})

test('hostile release does not spend65native owner steps on a body excluded from its own projectile ray', t => {
  const { bot, foe, throwers } = fixture(), { enemyWindShot } = require('../src/combat/enemy-wind')
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const bare = enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 })
  const simulate = bot.physics.simulatePlayer
  let steps = 0
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return simulate(...args) })
  const own = enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4, allies: [throwers[0]] })
  assert.deepEqual(own, bare, 'the same native hostile ray must be retained')
  assert.equal(steps, 0, 'L2 measured50/58ms final calculation came from an unused65tick owner forecast')
})

test('one hostile wind release checks each third body LOS once across its native projectile segments', t => {
  const { bot, foe, throwers } = fixture(), { enemyWindShot } = require('../src/combat/enemy-wind')
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const bare = enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 })
  assert.ok(bare && bare.ticks > 1)
  for (let i = 0; i < 19; i++) bot.entities[10 + i] = { id: 10 + i, username: `Blue${i}`, type: 'player',
    position: new Vec3(-3 + i / 10, 1, 3), width: .6, height: 1.8 }
  const pick = require('../src/pick'), canHit = pick.canHit, calls = new Map<any, number>()
  t.mock.method(pick, 'canHit', (body, entity, options) => {
    calls.set(entity, (calls.get(entity) || 0) + 1)
    return canHit(body, entity, options)
  })
  assert.deepEqual(enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 }), bare)
  assert.equal(calls.size, 19)
  assert.ok([...calls.values()].every(n => n === 1), `the synchronous snapshot cannot change LOS between segments: ${[...calls.values()]}`)
})

test('hostile wind LOS reuse retains hidden-body fairness and expires at the next call', t => {
  const { bot, foe, throwers } = fixture(), { enemyWindShot } = require('../src/combat/enemy-wind')
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const bare = enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 })
  let visible = false, calls = 0
  const ally: any = { id: 3, username: 'Ally', type: 'player', position: new Vec3(0, 1.5, .5) }
  for (const [key, value] of [['width', .6], ['height', 1.8]]) Object.defineProperty(ally, key, { get() {
    assert.ok(visible, 'hidden third-body dimensions cannot enter projectile geometry')
    return value
  } })
  bot.entities[3] = ally
  t.mock.method(require('../src/pick'), 'canHit', () => { calls++; return visible })
  assert.deepEqual(enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 }), bare)
  assert.equal(calls, 1, 'a negative LOS result is reused too')
  visible = true
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 }), null, 'the next call observes the newly visible interceptor')
  assert.equal(calls, 2)
  visible = false
  assert.deepEqual(enemyWindShot(bot, foe, throwers[0], frames, { height: 1.4 }), bare, 'a subsequent LOS gap cannot retain a visible body')
  assert.equal(calls, 3)
})

test('CC d #1177 refuses first-tick interception by a delayed visible flyer receipt', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const { bot, foe, cells } = fixture()
  cells.clear()
  const report = {
    id: 'A', position: new Vec3(546.3522582756651, 155.4121304570919, 577.7446825852749),
    velocity: new Vec3(.14183585523811065, 1.2596660285872983, -.01307068663895969),
    launchMovement: new Vec3(.1418358552381278, 1.2596660285873043, -.013070686638911866),
    onGround: false, gliding: true, eyeHeight: .4, gameTick: 500
  }
  bot.entity.position = report.position
  const frames = [
    [539.0564146912908, 162.3945436296198, 571.2432878685004],
    [538.9607160695926, 163.00566270654335, 571.1812719574376],
    [538.8913485139925, 163.52615941205875, 571.1332175582017],
    [538.8459422285416, 163.95784619186563, 571.0978681347284],
    [538.8223406989265, 164.30249924278428, 571.0740802391989],
    [538.818581497122, 164.56185923773242, 571.0608133340983],
    [538.832878813625, 164.7376320362026, 571.0571205302879],
    [538.8636075617881, 164.83148938053012, 571.0621401586517],
    [538.9092889127617, 164.84506957823538, 571.075088100294],
    [538.9686570302224, 164.7799751873417, 571.0957459568498]
  ].map(([x, y, z]) => ({ pos: new Vec3(x, y, z), vel: new Vec3(0, 0, 0), onGround: false }))
  const ally = {
    id: 'G', position: new Vec3(546.2096174071976, 153.57161131501198, 577.8930713953049),
    velocity: { x: -.7222162766650463, y: 1.1990966796875, z: -.35505084052823566, ageTicks: 4.90833984375 },
    onGround: false, gliding: true, pitch: .9572040116406404, yaw: 1.129009859883832, gameTick: 500
  }
  const clear = enemyWindShot(bot, foe, report, frames, { height: 1.6 })
  assert.ok(clear)
  assert.equal(clear.ticks, 7)
  assert.equal(clear.yaw, .9105073730688079)
  assert.equal(clear.pitch, .1425043459719716)
  // Same receipt while fresh: G is below the upward ray and the throw is legal.
  const fresh = { ...ally, velocity: { ...ally.velocity, ageTicks: 0 } }
  assert.deepEqual(enemyWindShot(bot, foe, report, frames, { height: 1.6, allies: [fresh] }), clear)
  const beside = { ...ally, position: ally.position.offset(0, 0, 3) }
  assert.deepEqual(enemyWindShot(bot, foe, report, frames, { height: 1.6, allies: [beside] }), clear)
  // Native first tick at 15782097 hit G's feet at (545.97556, 156.09427, 577.59943).
  assert.equal(enemyWindShot(bot, foe, report, frames, { height: 1.6, allies: [ally] }), null)
})

test('an unknown report or ally id cannot be mistaken for the excluded owner', t => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  for (const missing of ['owner', 'ally']) {
    const { bot, foe, throwers } = fixture(), report = { ...throwers[0] }, ally = { ...throwers[0] }
    if (missing === 'owner') report.id = undefined
    ally.id = undefined // Controls are unknown too: preserve the existing forecast instead of dropping this body.
    const simulate = bot.physics.simulatePlayer
    let steps = 0
    t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return simulate(...args) })
    const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
    enemyWindShot(bot, foe, report, frames, { height: 1.4, allies: [ally] })
    assert.ok(steps > 0, `unknown ${missing} id retains the real ally forecast`)
  }
})

function recordedCoastFixture() {
  const f = fixture(), { bot, foe, cells } = f
  cells.clear()
  for (let x = 580; x <= 620; x++) for (let z = 580; z <= 620; z++) cells.set(`${x},119,${z}`, 'sand')
  bot.entity.position = new Vec3(612.5, 120, 602.5)
  const prev = { x: 600.557373046875, y: 130.08740234375, z: 600.3740234375, t: 1793791502212.5962, kind: 'rel_entity_move', grounded: false }
  const cur = { x: 599.333740234375, y: 130.771240234375, z: 600.084228515625, t: 1793791502312.3652, kind: 'rel_entity_move', grounded: false }
  Object.assign(foe, { position: new Vec3(cur.x, cur.y, cur.z), _ndVisible: true, _ndPositionReceipts: [prev, cur], _ndObservationNow: () => cur.t })
  return { ...f, prev, cur, arena: { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 } }
}

test('recorded d75 coast starts at the native endpoint speed instead of the two-tick displacement average', t => {
  const { bot, foe, cur, arena } = recordedCoastFixture(), { enemyWindFrames } = require('../src/combat/enemy-wind'), edges = require('../src/edges')
  const nativeSim = bot.physics.simulatePlayer
  let steps = 0
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { steps++; return nativeSim(...args) })
  assert.deepEqual(enemyWindFrames(bot, foe, arena), [], 'the first interval alone does not prove its physical count')
  const expected = edges.stateOf({ ...bot, entity: { ...foe, effects: {}, attributes: {},
    velocity: new Vec3(-.5305339437221511, .21455395872691194, -.12565809680766651) } }, edges.IDLE)
  edges.simOf(bot)(expected, edges.worldOf(bot)); edges.simOf(bot)(expected, edges.worldOf(bot))
  // Next actual received d75 pose, same capture. The native state above is an endpoint oracle, not an input to the fit.
  const next = { x: 598.3203125, y: 131.11767578125, z: 599.84423828125, t: 1793791502413.1187, kind: 'rel_entity_move', grounded: false }
  foe.position = new Vec3(next.x, next.y, next.z); foe._ndPositionReceipts = [cur, next]; foe._ndObservationNow = () => next.t
  const frame = enemyWindFrames(bot, foe, arena)[0]
  assert.ok(frame.vel.distanceTo(expected.vel) < .001, `current native endpoint, got ${frame.vel}`)
  const first = steps
  enemyWindFrames(bot, foe, arena)
  assert.ok(steps - first < first, 'the same fair receipt pair reuses its fitted velocity across aim candidates')
})

for (const mode of ['ground', 'sprint', 'glider', 'absolute', 'old', 'unknown', 'collision']) test(`native coast fit keeps the existing estimate for ${mode}`, t => {
  const { bot, foe, prev, cur, cells, arena } = recordedCoastFixture()
  const measured = { x: -.61, y: .21, z: -.145, ageTicks: 0 }
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => measured)
  t.mock.method(require('../src/bow/track'), 'hasObservedPhysicalVelocity', () => true) // The non-coast estimate is supplied by this fixture.
  if (mode === 'ground') foe.onGround = true
  if (mode === 'sprint') foe.metadata[0] = 8
  if (mode === 'glider') { foe.metadata[0] = 128; foe.elytraFlying = true }
  if (mode === 'absolute') prev.kind = 'entity_teleport'
  if (mode === 'old') prev.t = cur.t - 550
  if (mode === 'unknown' || mode === 'collision') {
    require('../src/combat/enemy-wind').enemyWindFrames(bot, foe, arena)
    const next = { x: 598.3203125, y: 131.11767578125, z: 599.84423828125, t: 1793791502413.1187, kind: 'rel_entity_move', grounded: false }
    foe.position = new Vec3(next.x, next.y, next.z); foe._ndPositionReceipts = [cur, next]; foe._ndObservationNow = () => next.t
  }
  if (mode === 'unknown' || mode === 'collision') bot.entity.position = new Vec3(593.5, 128, 598.5)
  if (mode === 'collision') cells.set('600,130,600', 'stone')
  if (mode === 'unknown') {
    const blockAt = bot.blockAt
    bot.blockAt = p => p.floored().equals(new Vec3(600, 130, 600)) ? null : blockAt(p)
  }
  const frame = require('../src/combat/enemy-wind').enemyWindFrames(bot, foe, arena)[0]
  if (['absolute', 'old', 'unknown', 'collision'].includes(mode)) { assert.equal(frame, undefined, 'an unverified fair coast is unknown, never a zero/mean trajectory'); return }
  assert.ok(frame, 'the target remains honestly visible')
  assert.equal(frame.vel.x, measured.x); assert.equal(frame.vel.z, measured.z)
})

test('raw wind entry reacquires a fair baseline and cannot fit motion receipts from behind the wall', () => {
  const { bot, foe, cur, arena } = recordedCoastFixture(), core = require('../src/combat/enemy-wind'), edges = require('../src/edges')
  bot._client = new EventEmitter()
  delete foe._ndVisible
  let time = cur.t
  foe._ndObservationNow = () => time
  const clear = bot.blockAt
  try {
    core.installWindTracking(bot)
    core.enemyWindFrames(bot, foe, arena)
    bot.blockAt = p => {
      if (p.floored().x !== 606) return clear(p)
      const block = Block.fromStateId(registry.blocksByName.stone.defaultState); block.position = p.floored(); return block
    }
    bot.emit('physicsTick')
    const hidden = [null, { ...cur, t: time += 100 }]
    Object.defineProperty(hidden, '0', { get() { throw new Error('hidden previous raw receipt must not enter a wind forecast') } })
    foe._ndPositionReceipts = hidden
    bot.blockAt = clear
    bot.emit('physicsTick')
    assert.deepEqual(core.enemyWindFrames(bot, foe, arena), [], 'reacquiring one visible point does not reveal any velocity')
    const state = edges.stateOf({ ...bot, entity: { ...foe, position: foe.position.clone(), velocity: new Vec3(-.4, .2, .1), effects: {}, attributes: {} } }, edges.IDLE)
    const simulate = edges.simOf(bot), world = edges.worldOf(bot)
    simulate(state, world); simulate(state, world)
    foe.position = state.pos.clone(); time += 100
    foe._ndPositionReceipts = [hidden[1], { ...state.pos, t: time, kind: 'rel_entity_move', grounded: false }]
    bot.emit('physicsTick')
    assert.deepEqual(core.enemyWindFrames(bot, foe, arena), [], 'one new visible interval remains ambiguous')
    simulate(state, world); simulate(state, world)
    foe.position = state.pos.clone(); time += 100
    foe._ndPositionReceipts = [foe._ndPositionReceipts[1], { ...state.pos, t: time, kind: 'rel_entity_move', grounded: false }]
    bot.emit('physicsTick')
    const fresh = core.enemyWindFrames(bot, foe, arena)[0]
    assert.ok(Math.abs(fresh.vel.x - state.vel.x) < 1e-8, 'two compatible visible intervals restore the native coast fit')
  } finally { bot.emit('end') }
  assert.equal(bot.listenerCount('physicsTick'), 0, 'the shared observation hooks are released')
})

test('a delayed wind launch starts at the moving thrower position at release', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers } = fixture()
  const frames = Array.from({ length: 40 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const report = { ...throwers[0], velocity: { x: .25, y: 0, z: 0 }, yaw: -Math.PI / 2, control: { forward: true, sprint: true } }
  const before = JSON.stringify(report)
  const shot = enemyWindShot(bot, foe, report, frames, { fireDelay: 5, height: 1.4 })
  assert.ok(shot)
  assert.ok(shot.from.x > report.position.x + .8, 'the projectile is not launched five ticks behind its running owner')
  assert.equal(JSON.stringify(report), before, 'forecast does not rewrite the observed report')
})

test('a delayed own glider launch retains flight physics through its radio report', () => {
  const { enemyWindReport } = require('../src/combat/enemy-wind-execute')
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe } = fixture()
  Object.assign(bot.entity, { position: new Vec3(-2, 8, .5), velocity: new Vec3(1, 0, 0), onGround: false, elytraFlying: true })
  bot.getControlState = () => false
  const { report } = enemyWindReport({ bot }, { flying: true })
  const frames = Array.from({ length: 40 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const shot = enemyWindShot(bot, foe, report, frames, { fireDelay: 5, height: 1.4 })
  assert.ok(shot)
  assert.ok(shot.from.x > 1, 'the flying owner advances before release')
  assert.ok(shot.from.y > 8, 'the lowered gliding eye follows flight, not free fall')
})

test('wind forecasts advance an aged visible glider observation before the next shot', t => {
  const { enemyWindFrames } = require('../src/combat/enemy-wind')
  const { bot, foe, options } = fixture()
  Object.assign(foe, { position: new Vec3(-1, 30, -40), velocity: new Vec3(0, -.2, 1.4), elytraFlying: true, yaw: Math.PI, pitch: -.2 })
  const before = foe.position.clone()
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ ...foe.velocity, ageTicks: 5 }))
  const frames = enemyWindFrames(bot, foe, options.arena)
  assert.ok(frames.length)
  assert.ok(frames[0].pos.z > before.z + 6, 'five observed ticks at 1.4 blocks/tick cannot leave the target at the old packet position')
  assert.deepEqual(foe.position, before, 'age compensation does not move the real enemy')
})

test('walls, unknown ray cells and honestly visible friendly interception prevent a direct hostile shot', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, cells } = fixture()
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  for (let y = 1; y <= 5; y++) cells.set(`0,${y},0`, 'stone')
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
  cells.clear()
  bot.entities[3] = { id: 3, username: 'Ally', type: 'player', position: new Vec3(0, 1.5, .5), width: .6, height: 1.8 }
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
  delete bot.entities[3]
  bot.blockAt = () => null
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
})

test('release revalidation includes an earlier projectile still in flight after the shared epoch advances', () => {
  const { enemyWindFrames, enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const frames = enemyWindFrames(bot, foe, options.arena)
  const shot = enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: .4 })
  assert.ok(shot && shot.ticks > 2)
  foe.position = frames[2].pos; foe.velocity = frames[2].vel; foe.onGround = frames[2].onGround
  const without = enemyWindFrames(bot, foe, options.arena)
  const inflight = enemyWindFrames(bot, foe, options.arena, [{ ...JSON.parse(JSON.stringify(shot)), fireDelay: -2 }])
  assert.ok(inflight[shot.ticks + 2].pos.distanceTo(without[shot.ticks + 2].pos) > .1, 'the second launch forecasts the first burst instead of cancelling the chain as a changed trajectory')
})

test('dated own radio reports advance with their real controls and refuse an unknown or stale epoch', () => {
  const { windReportAt, planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const report = { ...throwers[0], yaw: -Math.PI / 2, gameTick: 500, control: { forward: true, sprint: true } }
  const current = windReportAt(bot, report, 502)
  assert.ok(current.position.x > report.position.x)
  assert.equal(current.gameTick, 502)
  assert.equal(windReportAt(bot, report, 521), null)
  assert.equal(windReportAt(bot, report, 499), null)
  assert.equal(windReportAt(bot, { ...throwers[0], gameTick: undefined }, 502), null)
  assert.equal(planEnemyWind(bot, foe, throwers.map(r => ({ ...r, gameTick: 470 })), options), null)
})

test('a reported ally moving into the future projectile segment intercepts before the hostile body burst', () => {
  const { enemyWindFrames, enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const ally = { id: 'Crossing', position: { x: 1.5, y: 1, z: 3 }, velocity: { x: 0, y: 0, z: -.3 },
    onGround: true, yaw: 0, gameTick: 500, control: { forward: true, sprint: true } }
  const entity: any = { id: 3, username: ally.id, type: 'player', position: new Vec3(1.5, 1, 3), width: .6, height: 1.8, _ndReportedAlly: true }
  bot.entities[3] = entity
  const frames = enemyWindFrames(bot, foe, options.arena)
  assert.ok(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 5, height: .4 }), 'its old pose is clear of the shot')
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 5, height: .4, allies: [ally] }), null, 'the native future body occupies the actual flight segment')
})

test('blast resistance is a bound from visible glint, never exact opponent attributes, HP or enchantment levels', () => {
  const { windResistance, planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  assert.deepEqual(windResistance(foe), { lo: 0, hi: 0 })
  const gear: any = { name: 'netherite_boots', componentMap: new Map([['enchantments', { get data() { throw new Error('hidden enchantment levels') } }]]) }
  foe.equipment = [null, null, gear]
  assert.deepEqual(windResistance(foe), { lo: 0, hi: .6 })
  foe.equipment.push({ ...gear, name: 'netherite_leggings' })
  assert.deepEqual(windResistance(foe), { lo: 0, hi: 1 })
  Object.defineProperty(foe, 'attributes', { get() { throw new Error('hidden enemy attributes') } })
  Object.defineProperty(foe.metadata, 9, { get() { throw new Error('exact HP') } })
  const plan = planEnemyWind(bot, foe, throwers, options)
  assert.ok(plan)
  assert.equal(plan.resistance.hi, 1)
  assert.equal(plan.worst.out, false, 'fully resistant gear cannot be called a guaranteed wind kill')
})

test('a blast volume that would carry a nearby ally into the void is rejected even off the projectile ray', () => {
  const { windTeamSafe } = require('../src/combat/enemy-wind')
  const { bot, options } = fixture()
  const ally = { id: 'B', position: { x: 4.5, y: 2, z: 1.5 }, velocity: { x: .1, y: .1, z: 0 }, onGround: false }
  const shot = { ticks: 2, burst: new Vec3(4, 2.2, 1.5) }
  assert.equal(windTeamSafe(bot, [ally], [shot], options.arena), false)
  const safe = { ...ally, position: { x: -3, y: 1, z: 1.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  assert.equal(windTeamSafe(bot, [safe], [shot], options.arena), true, 'allies outside the burst are not blocked by an arbitrary distance gate')
})

test('planner work stays bounded with thirty reports and shares each ally native forecast', t => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const crowd = [...throwers, ...Array.from({ length: 27 }, (_, i) => ({
    id: 'Ally' + i, position: { x: -7 + i % 9 * 1.2, y: 1, z: [-4.5, 4.5, -3][Math.floor(i / 9)] },
    velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500, control: { forward: false, jump: false }
  }))]
  for (const [name, reports] of [['three', throwers], ['thirty', crowd]] as const) {
    const times: number[] = []
    for (let i = 0; i < 6; i++) {
      const start = performance.now(), plan = planEnemyWind(bot, foe, reports, options)
      times.push(performance.now() - start)
      if (plan) assert.ok(plan.tried <= reports.length * 4 * Math.min(3, options.maxShots), 'ready throwers expand candidate work linearly within the exact chain certification budget')
    }
    t.diagnostic(JSON.stringify({ reports: name, coldMs: times[0], warmMeanMs: times.slice(1).reduce((a, b) => a + b, 0) / 5, maxMs: Math.max(...times) }))
  }
})

test('a running enemy keeps running until the burst: the forecast does not stop him on the spot', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  // Бег со «Скоростью II» по полу к краю (0.39 бл/т): до попадания он бежит дальше и сам уходит за край — заряд не нужен (baseline.out).
  const run = fixture()
  run.foe.position = new Vec3(0.5, 1, 1.5); run.foe.onGround = true; run.foe.velocity = new Vec3(0, 0, .39)
  const p1 = planEnemyWind(run.bot, run.foe, run.throwers, { ...run.options, reactAfterHit: true })
  assert.ok(!p1 || p1.baseline.out, JSON.stringify(p1?.baseline))
  // Стоящий там же — сам не вылетает.
  const still = fixture()
  still.foe.position = new Vec3(0.5, 1, 1.5); still.foe.onGround = true; still.foe.velocity = new Vec3(0, 0, 0)
  const p2 = planEnemyWind(still.bot, still.foe, still.throwers, { ...still.options, reactAfterHit: true })
  assert.ok(p2 && !p2.baseline.out, JSON.stringify(p2?.baseline))
})

test('colosseum edge is the outer-wall ellipse, not the square: minor axis and diagonal rims are at the edge', () => {
  const { arenaRoom } = require('../src/combat/team-wind') as typeof import('../src/combat/team-wind')
  const arena = { x: 600, z: 600, r: 80, ellipse: { a: 77, b: 65 } }
  assert.ok(Math.abs(arenaRoom(arena, { x: 600, z: 662.5 }) - 2.5) < 1e-6)
  assert.ok(arenaRoom(arena, { x: 647.5, z: 647.5 }) < 8)
  assert.ok(arenaRoom(arena, { x: 600, z: 600 }) >= 65)
  assert.ok(arenaRoom(arena, { x: 600, z: 670 }) < 0)
  assert.equal(arenaRoom({ x: 0, z: 0, r: 10 }, { x: 3, z: -7 }), 3)
})

test('one synchronous enemy wind plan shares raw sight cells and the next plan sees same-tick block updates', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const fixed = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(fixed)
  try {
    for (const unknown of [false, true]) {
      const f = fixture(), read = f.bot.blockAt, cells = new Set<string>(); let reads = 0
      f.bot.blockAt = (p: Vec3) => {
        reads++; cells.add(p.floored().toString())
        return unknown && (p.x >= 5 || p.y >= 5) ? null : read(p)
      }
      const before = planEnemyWind(f.bot, f.foe, f.throwers, f.options)
      assert.ok(before)
      assert.ok(reads < cells.size * 2, `shared raw LOS reads: ${reads} reads / ${cells.size} cells`)
      const firstReads = reads
      f.cells.clear()
      const after = planEnemyWind(f.bot, f.foe, f.throwers, f.options)
      assert.notDeepEqual(after, before, 'cache must end with the synchronous call, even without a game tick')
      assert.ok(reads > firstReads, 'new forecast must reread terrain')
    }
  } finally { clock.activate(null); fixed.dispose() }
})

// 29.10: прогноз заряда по таранщику — летящего на элитрах считали падающим телом (бег по земле к центру, сопротивление ×0.91):
// за 10 т. он «тормозил» до шага, а на деле планирует на скорости. Физика полёта — та же, что у нас (prismarine elytraFlying по взгляду).
test('летящий на элитрах в прогнозе планирует, а не падает и не бежит к центру', () => {
  const f = fixture()
  const { enemyWindFrames } = require('../src/combat/enemy-wind')
  Object.assign(f.foe, { position: new Vec3(-1, 30, -40), velocity: new Vec3(0, -.2, 1.4), elytraFlying: true, yaw: Math.PI, pitch: -.2 })
  f.foe.metadata[0] = 0x80
  const frames = enemyWindFrames(f.bot, f.foe, { ...f.options.arena, r: 80 })
  assert.ok(frames.length > 10)
  const v = frames[10].vel
  assert.ok(Math.hypot(v.x, v.z) > 1, `планирует на скорости: ${Math.hypot(v.x, v.z).toFixed(2)} бл/т`)
  assert.ok(frames[10].pos.z - frames[0].pos.z > 10, 'летит туда же, куда летел')
})

// 29.10: заряд против таранщика — порыв сбивает его с линии подлёта на меня/своих (отвод), а не выносит за край.
test('таранщик идёт на меня — план броска с отводом уводит его тело от моих глаз', () => {
  const f = fixture()
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  Object.assign(f.foe, { position: new Vec3(-2, 3, -14), velocity: new Vec3(0, 0, 1.2), elytraFlying: true, yaw: Math.PI, pitch: 0 })
  f.foe.metadata[0] = 0x80
  // On the centreline the approaching box swallows the segment origin; the native clip has no entry.
  const me = { id: 'A', position: { x: -2, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }
  const options = { arena: { ...f.options.arena, r: 80 }, startTick: 500, maxShots: 1, delays: [0], protect: [{ x: -2, y: 2.6, z: .5 }] }
  assert.equal(planEnemyWind(f.bot, f.foe, [me], options), null, 'an inside-origin interception is not a native hit')
  // A teammate two blocks to the side has a real entry and can deflect the same ram from the protected line.
  f.bot.entity.position.x = 0; me.position.x = 0
  const plan = planEnemyWind(f.bot, f.foe, [me], options)
  assert.ok(plan, 'план есть')
  assert.ok(plan.baseline.clear < 3.5, `без броска проходит вплотную: ${plan.baseline.clear?.toFixed(1)}`)
  assert.ok(plan.nominal.clear > plan.baseline.clear, `порыв уводит: ${plan.nominal.clear?.toFixed(1)}`)
  assert.ok(Number.isFinite(plan.baseline.reach) && plan.nominal.reach > plan.baseline.reach, `удар достаёт позже или никогда: ${plan.baseline.reach} → ${plan.nominal.reach}`)
})
