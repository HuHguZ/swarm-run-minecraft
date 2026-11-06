import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { testBot, testClock } from './tick-plugins-fixture'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()
const core: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
const edges: typeof import('../src/edges') = require('../src/edges')
const bow: typeof import('../src/bow/track') = require('../src/bow/track')
const clock: typeof import('../src/game-clock') = require('../src/game-clock')
const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }

function fixture(t: any, raw = false) {
  let now = 1000, age = 0
  const blockAt = (p: Vec3) => { const b = Block.fromStateId(registry.blocksByName[p.y < 119 ? 'sand' : 'air'].defaultState); b.position = p.floored(); return b }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, username: 'Blue', health: 20, food: 20,
    game: { minY: -64, height: 384 }, _client: new EventEmitter(), blockAt,
    inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { id: 1, username: 'Blue', position: new Vec3(608.5, 120, 602.5), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, attributes: {} },
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, physics: native.Physics(registry, { getBlock: blockAt }) })
  const foe: any = Object.assign(new EventEmitter(), { id: 2, username: 'Enemy', type: 'player', name: 'player',
    position: new Vec3(600, 130, 600), onGround: false, metadata: [], equipment: [], width: .6, height: 1.8,
    _ndObservationNow: () => now, ...(raw ? {} : { _ndVisible: true, _ndMotionEpoch: 0 }) })
  Object.defineProperty(foe, 'velocity', { get() { throw Error('raw foreign velocity is not an observed wind endpoint') } })
  bot.players = { Enemy: { entity: foe, gamemode: 0 } }; bot.entities = { 2: foe }
  const fallback = { x: -.2393507766346995, y: .3764426094184917, z: .05609454324654633 }
  t.mock.method(bow, 'observedVelocity', () => ({ ...fallback, ageTicks: age }))
  t.mock.method(bow, 'hasObservedPhysicalVelocity', () => true) // This fixture explicitly supplies the non-coast estimate.
  t.mock.method(clock, 'observationNow', () => now)
  // Explicitly observed open-world geometry: this test isolates native motion interval inference.
  t.mock.method(require('../src/pvp/search'), 'observedCollision', () => bot)
  t.after(() => { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners(); foe.removeAllListeners() })
  if (raw) core.installWindTracking(bot)
  const frame = () => core.enemyWindFrames(bot, foe, arena, [], 0, true)
  const pose = (position: Vec3, at: number, kind = 'rel_entity_move') => {
    now = at; foe.position = position.clone()
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1] || null, { ...position, t: at, kind, grounded: foe.onGround, flying: !!foe.elytraFlying, yaw: foe.yaw || 0, pitch: foe.pitch || 0 }]
    foe.emit('ndPositionObserved')
  }
  const state = (v = new Vec3(-.55, .75, .12)) => edges.stateOf({ ...bot,
    entity: { ...bot.entity, position: foe.position.clone(), velocity: v, onGround: false, _ndPoseHeight: 1.8 } }, edges.IDLE)
  const step = (s: any, ticks: number, at: number) => {
    for (let i = 0; i < ticks; i++) edges.simOf(bot)(s, edges.worldOf(bot))
    pose(new Vec3(...['x', 'y', 'z'].map(k => Math.floor(s.pos[k] * 4096) / 4096) as [number, number, number]), at)
  }
  return { bot, foe, fallback, frame, pose, state, step, setAge: (v: number) => { age = v } }
}

for (const input of [{ forward: true }, { left: true }, { forward: true, right: true }]) {
  test(`visible airborne receipts fit native ${Object.keys(input).join('+')} without the sprint flag`, t => {
    const f = fixture(t)
    f.foe.yaw = .63
    f.pose(f.foe.position, 1000, 'reacquired')
    const state = f.state(new Vec3(.15, .38, .07))
    state.yaw = f.foe.yaw; state.control = { ...edges.IDLE, ...input }
    f.step(state, 2, 1100); f.frame()
    f.step(state, 2, 1200)
    const view = core.observeEnemyWindMotion(f.bot, f.foe)
    assert.deepEqual(view?.run?.control, state.control)
    const frames = f.frame()
    for (let i = 0; i < 7; i++) edges.simOf(f.bot)(state, edges.worldOf(f.bot))
    assert.ok(frames[7].pos.distanceTo(state.pos) < .003)
  })
}

test('EM sprint #1180 fits the airborne endpoint from three visible relative receipts', t => {
  const f = fixture(t)
  const receipts = [
    [657.9079046158525, 198.9671565476053, 562.4046544925629, 2.1598449493429825, 101, 1000],
    [658.4298772721025, 197.9857112351053, 561.7742833988129, 2.1598449493429825, 101, 1093.2295],
    [658.7811956314775, 196.7327815476053, 561.3065099613129, 2.184388641949153, 102, 1179.8236]
  ]
  f.foe.metadata[0] = 8
  for (const [i, [x, y, z, yaw, revision, at]] of receipts.entries()) {
    f.foe.yaw = yaw; f.foe._ndGlideRevision = revision
    f.pose(new Vec3(x, y, z), at, i === 2 ? 'entity_move_look' : 'rel_entity_move')
    f.foe._ndPositionReceipts[1].revision = revision
    if (!i) f.foe._ndEarlierPositionReceipt = f.foe._ndPositionReceipts[1]
  }
  const observe = () => core.observeEnemyWindMotion(f.bot, f.foe)
  const motion = observe()
  assert.deepEqual(motion?.run?.control, { ...edges.IDLE, forward: true, sprint: true })
  const native = new Vec3(.1422441596202227, -.7249928592016566, -.19606497810306237)
  assert.ok(motion?.velocity && native.distanceTo(motion.velocity) < .001)
  f.foe._ndGlideRevision += 2
  assert.deepEqual({ ...observe()?.velocity }, f.fallback, 'a cached fit cannot survive an unobserved turn')
})

test('BJ walk #943 visible air-walk intervals preserve reversal through the release horizon', t => {
  const f = fixture(t)
  f.foe.yaw = 4.884194828627882
  f.pose(new Vec3(596.38818359375, 132.00634765625, 601.1923828125), 1000, 'reacquired')
  f.pose(new Vec3(596.15576171875, 131.583251953125, 601.198974609375), 1100); f.frame()
  f.pose(new Vec3(596.037109375, 130.866455078125, 601.19287109375), 1200); f.setAge(1)
  const frames = f.frame()
  assert.ok(core.observeEnemyWindMotion(f.bot, f.foe)?.run?.control.forward)
  assert.ok(frames[7].pos.distanceTo(new Vec3(596.3637895041226, 125.28754917227202, 601.1688816447174)) < .025)
})

for (const phaseChanged of [false, true]) test(`CD #1115 public turn receipts require the current body phase (${phaseChanged ? 'changed' : 'same'})`, t => {
  const f = fixture(t)
  // Positions and look revisions from the continuous public view of NeuroFarm31d.
  const packets = [
    [574.6671280151244, 127.53605803538322, 570.2742187380791, 3.840596805960635, 125, 1793884441964.43],
    [574.4732803588744, 129.15934905100823, 570.5137206912041, 3.877903431774901, 126, 1793884441991.9587],
    [574.1737198119994, 132.07512053538323, 570.9729492068291, 3.877903431774901, 126, 1793884442090.63]
  ]
  for (const [i, [x, y, z, yaw, revision, at]] of packets.entries()) {
    f.foe.yaw = yaw; f.foe._ndGlideRevision = revision
    f.pose(new Vec3(x, y, z), at, i === 1 ? 'entity_move_look' : 'rel_entity_move')
    f.foe._ndPositionReceipts[1].revision = revision
    if (!i) f.foe._ndEarlierPositionReceipt = f.foe._ndPositionReceipts[1]
  }
  f.setAge(2)
  if (phaseChanged) f.foe._ndGlideRevision += 2 // An intervening pose transition is not a measured turn.
  const motion = core.observeEnemyWindMotion(f.bot, f.foe)
  if (phaseChanged) { assert.equal(motion?.run, undefined); return }
  assert.deepEqual(motion?.run?.control, { ...edges.IDLE, forward: true })
  const atImpact = f.frame()[12]?.pos
  assert.ok(atImpact?.distanceTo(new Vec3(574.138552327251, 141.45962639919574, 573.70145047595)) < .035)
  f.foe._ndGlideRevision += 2
  assert.equal(core.observeEnemyWindMotion(f.bot, f.foe)?.run, undefined, 'a previously fitted turn cannot survive a new phase')
})

for (const change of ['coast', 'reverse', 'ambiguous'] as const) test(`a public air turn does not invent held input across ${change}`, t => {
  const f = fixture(t)
  f.foe.yaw = .63
  f.pose(f.foe.position, 1000)
  const earlier = f.foe._ndPositionReceipts[1]
  earlier.revision = 0
  const state = f.state(new Vec3(.15, .38, .07))
  state.control = { ...edges.IDLE, forward: change !== 'coast' }
  const turn = change === 'ambiguous' ? Math.PI / 2 : 2 * Math.PI / 256
  for (let i = 1; i <= 2; i++) {
    state.yaw = f.foe.yaw += turn
    f.step(state, 2, 1000 + 100 * i)
    Object.assign(f.foe._ndPositionReceipts[1], { revision: i, kind: 'entity_move_look' })
    if (change === 'reverse') state.control = { ...edges.IDLE, back: true }
  }
  f.foe._ndGlideRevision = 2
  f.foe._ndEarlierPositionReceipt = earlier
  assert.equal(core.observeEnemyWindMotion(f.bot, f.foe)?.run, undefined)
})

test('recorded V postgust compressed receipts cannot become the confident half-speed fallback', t => {
  const f = fixture(t)
  f.pose(new Vec3(600.116455078125, 129.63997069001198, 600.44140625), 1793816203522.0273)
  f.pose(new Vec3(599.562255859375, 130.48958006501198, 600.5712890625), 1793816203540.7932)
  f.setAge(1)
  const frames = f.frame()
  assert.equal(frames.length, 0, `18.7659ms is not a known zero/one-tick interval; V used ${JSON.stringify(frames[0])}`)
  assert.equal(core.planEnemyWind(f.bot, f.foe, [{ id: 'Blue', position: { ...f.bot.entity.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }], { arena, juggle: true }), null)
  f.pose(new Vec3(598.599365234375, 131.90486326813698, 600.796630859375), 1793816203678.9219)
  f.setAge(0)
  assert.equal(bow.observedFallTicks(.849609375, 1.415283203125), 2, 'one tick followed by two, never an equal-interval assumption')
  const fresh = f.frame()[0]
  assert.ok(fresh)
  assert.ok(fresh.vel.distanceTo(new Vec3(-.41751595965329913, .5692244834353247, .0977439037416835)) < .001, JSON.stringify(fresh))
})

test('recorded X apex zero tick cannot halve the native interval and double airborne drift', t => {
  const f = fixture(t)
  f.pose(new Vec3(596.98095703125, 126.88166990876198, 597.91552734375), 1000)
  f.pose(new Vec3(596.11474609375, 127.29402342438698, 597.50830078125), 1001)
  assert.equal(f.frame().length, 0)
  f.pose(new Vec3(595.3974609375, 127.37678709626198, 597.17138671875), 1002)
  const frame = f.frame()[0]
  const native = new Vec3(-.31100040299700915, -.0784000015258789, -.14616600366965762)
  assert.ok(!frame || frame.vel.distanceTo(native) < .001,
    `native vy=.0027168 was zeroed before the second step; X instead used ${JSON.stringify(frame)}`)
})

test('recorded AA fair packet gap preserves a compatible native endpoint between forecast calls', t => {
  const f = fixture(t)
  for (const [y, at] of [[129.60627928376198, 1793826502013.9924], [128.49495115876198, 1793826502110.483]]) f.pose(new Vec3(600.45703125, y, 600.330078125), at)
  assert.equal(f.frame().length, 0)
  f.pose(new Vec3(600.45703125, 127.11726561188698, 600.330078125), 1793826502388.3115)
  f.pose(new Vec3(600.45703125, 125.48347654938698, 600.330078125), 1793826502389.653)
  const frame = f.frame()[0]
  assert.ok(frame, 'both missing-middle endpoints were already fair observations')
  assert.ok(frame.vel.distanceTo(new Vec3(0, -.9096742761915659, 0)) < 1e-8)
})

test('the first wind query can use both previously received fair airborne displacements', t => {
  const f = fixture(t, true), vision = require('../src/pvp/last-seen').createLastSeen(f.bot)
  t.after(() => vision.close())
  vision.observe(f.foe)
  f.pose(new Vec3(600.5, 130, 600.5), 1000)
  const body = f.state(new Vec3(-.31, .61, .08))
  f.step(body, 2, 1100)
  f.step(body, 2, 1200)
  const frame = f.frame()[0]
  assert.ok(frame, 'trajectory must not depend on a wind query between native receipts')
  assert.ok(frame.vel.distanceTo(body.vel) < .001)
})

for (const phaseChanged of [false, true]) test(`first coast forecast uses only current-phase receipts (metadata change: ${phaseChanged})`, async t => {
  const nativeClock = testClock(), bot = testBot()
  bot.entity.position.set(608.5, 130, 602.5)
  bot.health = bot.food = 20
  require('mineflayer/lib/plugins/entities')(bot)
  require('../src/tick-plugins').createTickPlugins(nativeClock).plugins.physics(bot, { physicsEnabled: false })
  const Entity = require('prismarine-entity')('1.21.11'), raw = new Entity(2)
  Object.assign(raw, { username: 'Enemy', type: 'player', name: 'player', position: new Vec3(600.5, 130, 600.5),
    onGround: false, height: 1.8, width: .6, yaw: 0, pitch: 0 })
  raw.metadata[0] = raw.metadata[6] = 0
  bot.entities[2] = raw; bot.players.Enemy = { entity: raw, gamemode: 0 }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  t.after(() => { vision.close(); bot.emit('end') })
  bot.emit('entitySpawn', raw)
  vision.observe(raw)
  const state = edges.stateOf({ ...bot, entity: { ...bot.entity, position: raw.position.clone(),
    velocity: new Vec3(-.31, .61, .08), onGround: false, _ndPoseHeight: 1.8 } }, edges.IDLE)
  const move = async () => {
    const simulate = edges.simOf(bot), world = edges.worldOf(bot)
    simulate(state, world); simulate(state, world)
    await nativeClock.advanceGame(100, false)
    const dx = Math.floor(state.pos.x * 4096) - Math.round(raw.position.x * 4096)
    const dy = Math.floor(state.pos.y * 4096) - Math.round(raw.position.y * 4096)
    const dz = Math.floor(state.pos.z * 4096) - Math.round(raw.position.z * 4096)
    bot._client.emit('rel_entity_move', { entityId: raw.id, dX: dx, dY: dy, dZ: dz, onGround: false })
  }
  for (let i = 0; i < 3; i++) await move()
  const receipt = raw._ndPositionReceipts[1]
  if (phaseChanged) for (const flag of [128, 0]) bot._client.emit('entity_metadata', { entityId: raw.id,
    metadata: [{ key: 0, value: flag }, { key: 6, value: flag ? 1 : 0 }] })
  const view = vision.observe(raw)
  assert.equal(raw._ndPositionReceipts[1], receipt, 'the metadata updates do not stamp position')
  assert.equal(view._ndGlideRevision ?? 0, phaseChanged ? 2 : 0)
  assert.equal(view._ndEarlierPositionReceipt.revision, 0)
  assert.deepEqual(view._ndPositionReceipts.map(r => r.revision), [0, 0])
  const frames = core.enemyWindFrames(bot, view, arena, [], 0, true)
  if (phaseChanged) assert.equal(frames.length, 0, 'the old triple cannot certify the current public phase')
  else assert.ok(frames[0]?.vel.distanceTo(state.vel) < .001)
})

for (const obstacle of ['known', 'unseen']) test(`a ${obstacle} obstacle beside the measured coast affects the unit probe differently`, t => {
  const f = fixture(t), blockAt = f.bot.blockAt
  f.bot.entity.position.set(596.5, 130, 600.5)
  f.bot.blockAt = (p: Vec3) => {
    if (Math.floor(p.x) !== 601) return blockAt(p)
    if (obstacle === 'unseen') return null
    const block = Block.fromStateId(registry.blocksByName.stone.defaultState)
    block.position = p.floored()
    return block
  }
  f.pose(new Vec3(600.5, 130, 600.5), 1000)
  const body = f.state(new Vec3(-.035, .44, .11))
  f.step(body, 2, 1100); f.frame()
  f.step(body, 2, 1200)
  const observed = f.frame()[0]
  if (obstacle === 'unseen') { assert.equal(observed, undefined); return }
  assert.ok(observed, 'observed path has no contact with the wall')
  assert.ok(observed.vel.distanceTo(body.vel) < .001)
})

test('recorded AA native horizontal clipping fits the packet quantization interval', t => {
  const f = fixture(t)
  f.pose(new Vec3(600.45703125, 131.22932615876198, 600.343994140625), 1793826501857.2583)
  f.pose(new Vec3(600.45703125, 130.98518553376198, 600.336181640625), 1793826501858.8857); f.frame()
  f.pose(new Vec3(600.45703125, 130.44026365876198, 600.330078125), 1793826502010.7332)
  const clipped = f.frame()[0]
  assert.ok(clipped, 'linear inverse misses the native .003 horizontal reset by .002908 blocks')
  assert.ok(Math.abs(clipped.vel.z) < f.bot.physics.negligeableVelocity)
  f.pose(new Vec3(600.45703125, 129.60627928376198, 600.330078125), 1793826502013.9924)
  const stopped = f.frame()[0]
  assert.ok(stopped && stopped.vel.z === 0)
})

for (const mode of ['hidden', 'absolute', 'reacquired', 'target life', 'observer life', 'revision', 'stale bridge', 'legacy epoch']) {
  test(`a skipped fair coast interval cannot bridge ${mode}`, t => {
    const f = fixture(t)
    f.pose(new Vec3(600.45703125, 129.60627928376198, 600.330078125), 1000)
    f.pose(new Vec3(600.45703125, 128.49495115876198, 600.330078125), 1100); f.frame()
    if (mode === 'hidden') { f.foe._ndVisible = false; f.frame(); f.foe._ndVisible = true }
    f.pose(new Vec3(600.45703125, 127.11726561188698, 600.330078125), mode === 'stale bridge' ? 1601 : 1200)
    f.pose(new Vec3(600.45703125, 125.48347654938698, 600.330078125), mode === 'stale bridge' ? 1602 : 1201)
    if (mode === 'absolute') f.foe._ndPositionReceipts[0].kind = 'entity_teleport'
    if (mode === 'reacquired') f.foe._ndPositionReceipts[0].kind = 'reacquired'
    if (mode === 'target life') f.bot.players.Enemy.entity = { id: 2 }
    if (mode === 'observer life') f.bot.entity = { ...f.bot.entity }
    if (mode === 'revision') f.foe._ndPositionReceipts.forEach(r => { r.revision = 1 })
    if (mode === 'legacy epoch') delete f.foe._ndMotionEpoch
    assert.equal(f.frame().length, 0)
  })
}

test('a different fair vision cache cannot bridge a gust after the freshness barrier was acknowledged', t => {
  const f = fixture(t, true)
  const foreign: any = { id: 2, username: 'Enemy', type: 'player', _ndVisible: true, onGround: false, metadata: [], equipment: [] }
  const frame = () => { foreign.position = f.foe.position; foreign._ndPositionReceipts = f.foe._ndPositionReceipts; return core.enemyWindFrames(f.bot, foreign, arena, [], 0, true) }
  f.pose(new Vec3(600.45703125, 129.60627928376198, 600.330078125), 1000)
  f.pose(new Vec3(600.45703125, 128.49495115876198, 600.330078125), 1100); frame()
  f.bot._client.emit('explosion', { center: f.foe.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  f.pose(new Vec3(600.45703125, 127.11726561188698, 600.330078125), 1200)
  f.pose(new Vec3(600.45703125, 125.48347654938698, 600.330078125), 1201)
  assert.equal(core.windMotionFresh(f.bot, f.foe), true)
  assert.equal(frame().length, 0, 'the other view still needs its first two postgust coast intervals')
  f.pose(new Vec3(600.45703125, 123.60408201813698, 600.330078125), 1250)
  assert.ok(frame()[0], 'the same fair view recovers with compatible postgust observations')
})

for (const mode of ['LOS reacquisition', 'absolute position', 'continuous visibility']) test(`a skipped coast interval preserves the fair epoch across ${mode}`, t => {
  const f = fixture(t, true), vision = require('../src/pvp/last-seen').createLastSeen(f.bot)
  t.after(() => vision.close())
  vision.observe(f.foe)
  f.pose(new Vec3(600.45703125, 129.60627928376198, 600.330078125), 1000)
  f.pose(new Vec3(600.45703125, 128.49495115876198, 600.330078125), 1100); f.frame()
  if (mode === 'LOS reacquisition') {
    const read = f.bot.blockAt
    f.bot.blockAt = p => {
      if (Math.floor(p.x) !== 604) return read(p)
      const b = Block.fromStateId(registry.blocksByName.stone.defaultState); b.position = p.floored(); return b
    }
    assert.equal(vision.observe(f.foe)._ndVisible, false)
    f.bot.blockAt = read
  }
  if (mode !== 'continuous visibility') f.pose(f.foe.position, 1150, 'entity_teleport')
  f.pose(new Vec3(600.45703125, 127.11726561188698, 600.330078125), 1200)
  f.pose(new Vec3(600.45703125, 125.48347654938698, 600.330078125), 1201)
  assert.equal(f.frame().length, mode === 'continuous visibility' ? 66 : 0,
    'two later relative packets preserve a continuous epoch and cannot erase a discontinuity')
})

for (const velocity of [-.0034, -.0031, -.0029, .0029, .0031, .0034]) test(`horizontal native reset retains honest future motion (${velocity})`, t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  const state = f.state(new Vec3(velocity, -.2, -velocity))
  f.step(state, 1, 1001); f.frame(); f.step(state, 2, 1002)
  const frames = f.frame()
  if (frames.length) {
    assert.ok(frames[0].vel.distanceTo(state.vel) < 2 / 4096)
    edges.simOf(f.bot)(state, edges.worldOf(f.bot))
    assert.ok(frames[1].pos.distanceTo(state.pos) < 2 / 4096)
  }
})

for (const velocity of [-.0029, 0, .0029, .0031, .08277227746955339]) {
  test(`native near-apex zeroing preserves honest endpoint confidence (${velocity})`, t => {
    const f = fixture(t); f.pose(f.foe.position, 1000)
    const state = f.state(new Vec3(-.55, velocity, .12))
    f.step(state, 2, 1001); f.frame(); f.step(state, 2, 1002)
    const frame = f.frame()[0]
    assert.ok(!frame || frame.vel.distanceTo(state.vel) < .001, `native ${state.vel}, forecast ${frame?.vel}`)
    // Once clear of the native zero plateau, a fresh overlapping interval recovers.
    f.step(state, 2, 1003)
    const recovered = f.frame()[0]
    assert.ok(recovered && recovered.vel.distanceTo(state.vel) < .001, `native ${state.vel}, forecast ${recovered?.vel}`)
  })
}

for (const intervals of [[1, 1], [1, 2], [2, 1], [2, 2]]) test(`compressed native intervals ${intervals.join('/')} recover their full endpoint without trusting receive time`, t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  const state = f.state()
  f.step(state, intervals[0], 1001)
  assert.equal(f.frame().length, 0, 'two positions cannot identify an unknown physical interval')
  f.step(state, intervals[1], 1002)
  const frame = f.frame()[0]
  assert.ok(frame)
  assert.ok(frame.vel.distanceTo(state.vel) < .001, `expected ${state.vel}, got ${frame.vel}`)
  const simulate = f.bot.physics.simulatePlayer
  let steps = 0
  t.mock.method(f.bot.physics, 'simulatePlayer', (...args) => { steps++; return simulate(...args) })
  f.frame()
  assert.equal(steps, 65, 'the same pair reuses the native fit, including its inferred interval')
})

test('ambiguous native intervals stay unknown rather than selecting the packet receive duration', t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  f.pose(f.foe.position.offset(.2, .5498046875, 0), 1100); f.frame()
  f.pose(f.foe.position.offset(.2, 1.4443359375, 0), 1200)
  assert.equal(bow.observedFallTicks(.5498046875, 1.4443359375), null)
  assert.equal(f.frame().length, 0)
})

test('stationary air without a visible sprint cannot invent a forward-input forecast', t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  f.pose(f.foe.position, 1001); f.frame(); f.pose(f.foe.position, 1002)
  assert.equal(f.frame().length, 0, 'neither a physical coast interval nor a visible running input was measured')
})

test('co-timestamped relative packets still need a unique native interval', t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  const state = f.state(); f.step(state, 1, 1000)
  assert.equal(f.frame().length, 0)
  f.step(state, 2, 1000)
  assert.ok(f.frame()[0].vel.distanceTo(state.vel) < .001)
})

test('a changed gravity cannot carry a prior coast fit into incompatible visible displacements', t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  const state = f.state(new Vec3(-.55, -.05, .12))
  f.step(state, 1, 1001); f.frame(); f.step(state, 2, 1002)
  assert.ok(f.frame()[0])
  const id = registry.effectsByName.SlowFalling.id
  const changed = edges.stateOf({ ...f.bot, entity: { ...f.bot.entity, position: state.pos.clone(), velocity: state.vel.clone(),
    onGround: false, effects: { [id]: { id, amplifier: 0, duration: 100 } }, _ndPoseHeight: 1.8 } }, edges.IDLE)
  f.step(changed, 1, 1003); f.frame()
  f.step(changed, 1, 1004)
  assert.equal(f.frame().length, 0, 'unobserved effects are not read; incompatible standard-gravity intervals stay unknown')
})

for (const mode of ['ground', 'sprint', 'glider', 'absolute', 'reacquired']) test(`a prior coast fit cannot survive ${mode}`, t => {
  const f = fixture(t); f.pose(f.foe.position, 1000)
  const state = f.state(); f.step(state, 1, 1001); f.frame(); f.step(state, 2, 1002)
  assert.ok(f.frame()[0])
  if (mode === 'ground') f.foe.onGround = true
  if (mode === 'sprint') f.foe.metadata[0] = 8
  if (mode === 'glider') { f.foe.metadata[0] = 128; f.foe.elytraFlying = true }
  if (mode === 'absolute') f.foe._ndPositionReceipts[0].kind = 'entity_teleport'
  if (mode === 'reacquired') f.foe._ndPositionReceipts = [null, { ...f.foe._ndPositionReceipts[1], kind: 'reacquired' }]
  const frame = f.frame()[0]
  if (mode === 'absolute' || mode === 'reacquired') assert.equal(frame, undefined, 'a fair synchronization baseline has no observed motion yet')
  else { assert.ok(frame, 'the existing non-coast forecast remains available'); assert.equal(frame.vel.x, f.fallback.x) }
  f.foe.onGround = false; f.foe.metadata[0] = 0; f.foe.elytraFlying = false
  if (mode === 'absolute') f.foe._ndPositionReceipts[0].kind = 'rel_entity_move'
  if (mode === 'reacquired') { f.step(state, 1, 1003) }
  assert.equal(f.frame().length, 0, 'fresh physical history is required after the changed phase')
})

test('a newly observed gust discards old coast history and waits for two compatible postgust intervals', t => {
  const f = fixture(t, true); f.pose(f.foe.position, 1000); f.frame()
  const state = f.state(); f.step(state, 1, 1010); f.frame(); f.step(state, 2, 1020)
  assert.ok(f.frame()[0])
  f.bot._client.emit('explosion', { center: f.foe.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  assert.equal(f.frame().length, 0, 'a prior physical fit cannot cross the visible impulse')
  state.vel = new Vec3(-.8, .9, .25)
  for (let i = 1; i <= 3; i++) {
    f.step(state, 1, 1020 + i * 10)
    const ready = core.windMotionFresh(f.bot, f.foe), frames = f.frame()
    assert.equal(ready, i >= 2, 'the existing public burst observation barrier is preserved')
    if (i < 3) assert.equal(frames.length, 0)
    else assert.ok(frames[0].vel.distanceTo(state.vel) < .001)
  }
})
