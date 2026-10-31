import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { incomingGliders } from '../src/threats'

function scene(t) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = Object.assign(new EventEmitter(), { registry: require('minecraft-data')('1.21.11'), ndClock: timer,
    entity: { id: 1, position: new Vec3(0, 64, 0), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0 },
    entities: {}, _client: new EventEmitter() })
  let barrier = null, reads = 0
  bot.blockAt = p => {
    reads++
    const blocked = barrier && p.z === barrier.z && p.y >= 64 && p.y < 68
    return blocked && barrier.name === 'unknown' ? null : { name: blocked ? barrier.name : p.y < 64 ? 'stone' : 'air', position: p,
      boundingBox: blocked || p.y < 64 ? 'block' : 'empty', shapes: blocked || p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const spawn = (id = 2, z = -20) => {
    const metadata = Array(10).fill(0), flags = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
    metadata[flags] = 1
    const e: any = Object.assign(new EventEmitter(), { id, type: 'player', name: 'player', username: 'Flyer' + id,
      position: new Vec3(0, 64.5, z), height: .6, width: .6, yaw: Math.PI, pitch: 0,
      metadata, equipment: [{ name: 'iron_spear' }], elytraFlying: true, isValid: true })
    Object.defineProperty(metadata, 9, { get() { throw new Error('private enemy HP') } })
    bot.entities[id] = e
    return e
  }
  const forecast = (foes = null) => incomingGliders(bot, { foes })
  const step = (e, delta = 1.5, foes = null) => { timer.advanceTicks(1); e.position.z += delta; return forecast(foes) }
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  return { bot, timer, spawn, forecast, step, reads: () => reads, wall: (name, z = -6) => { barrier = name ? { name, z } : null } }
}

test('ordinary ground players require no additional collision or gear rays', t => {
  const f = scene(t), e = f.spawn()
  e.elytraFlying = false
  assert.deepEqual(f.forecast(), [])
  assert.equal(f.reads(), 0)
})

test('incoming lance needs two visible observations and uses neither private HP nor per-enemy tick listeners', t => {
  const f = scene(t), a = f.spawn(), b = f.spawn(3, -18)
  assert.deepEqual(f.forecast(), [])
  const listeners = f.bot.listenerCount('physicsTick')
  f.timer.advanceTicks(1); a.position.z += 1.5; b.position.z += 1.5
  const hits = f.forecast()
  assert.equal(hits.length, 2); assert.ok(hits.every(h => h.kind === 'lance' && h.blockable))
  assert.ok(hits[0].ticks < hits[1].ticks)
  assert.equal(f.bot.listenerCount('physicsTick'), listeners)
  assert.equal(listeners, 1, 'one shared LastSeen observer, no tracker listeners')
  f.bot.emit('end')
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(a.listenerCount('ndPositionObserved'), 0); assert.equal(b.listenerCount('ndPositionObserved'), 0)
})

test('allied and out-of-scope gliders do not cause a defensive action', t => {
  const f = scene(t), e = f.spawn()
  f.bot._ndSwarmAllies = [e.username]
  f.forecast(); assert.deepEqual(f.step(e), [])
  f.bot._ndSwarmAllies = []
  assert.deepEqual(f.forecast([]), [])
  assert.deepEqual(f.step(e, 1.5, []), [])
  assert.deepEqual(f.forecast([e.username]), [], 'newly allowed target starts with a fresh baseline')
  assert.ok(f.step(e, 1.5, [e.username]).length)
})

test('hidden motion and reacquisition cannot become a charged glider velocity', t => {
  const f = scene(t), e = f.spawn()
  f.forecast(); assert.ok(f.step(e).length)
  f.wall('stone')
  assert.deepEqual(f.step(e, 5), [])
  f.wall(null)
  assert.deepEqual(f.step(e), [])
  assert.ok(f.step(e).length)
})

test('collider and unknown geometry stop both spear reach and the subsequent body forecast', t => {
  for (const material of ['glass', 'stone', 'unknown']) for (const z of [-6, -3]) {
    const f = scene(t), e = f.spawn()
    f.wall(material, z)
    f.forecast()
    assert.deepEqual(f.step(e), [], material + ':' + z)
  }
})

test('an away-moving glider and a defender leaving the spear line do not invent lance hits', t => {
  const f = scene(t), e = f.spawn()
  f.forecast()
  assert.deepEqual(f.step(e, -1.5), [])
  f.bot.entity.velocity.x = .8
  assert.ok(f.step(e).every(h => h.kind !== 'lance'))
})

test('death and a new entity with a reused id require a fresh observation pair', t => {
  const f = scene(t), e = f.spawn()
  f.forecast(); assert.ok(f.step(e).length)
  f.bot.emit('death')
  assert.deepEqual(f.forecast(), [])
  assert.ok(f.step(e).length)
  const next = f.spawn(e.id, -18)
  assert.deepEqual(f.forecast(), [])
  assert.ok(f.step(next).length)
})

test('resuming after another movement owner requires fresh velocity observations', t => {
  const f = scene(t), e = f.spawn()
  f.forecast(); assert.ok(f.step(e).length)
  f.timer.advanceTicks(8); e.position.z += 5
  assert.deepEqual(f.forecast(), [])
  assert.ok(f.step(e).length)
})

test('current spear contact survives a floor immediately stopping the next forecast step', t => {
  const f = scene(t), e = f.spawn(2, -5.5)
  f.forecast()
  e.position.y -= .5
  const [threat] = f.step(e)
  assert.equal(threat?.kind, 'lance')
  assert.equal(threat.ticks, 0)
})

test('fresh visible movement receipts survive a delayed flight forecast without inventing hidden speed', t => {
  const f = scene(t), e = f.spawn()
  let observedAt = 1000
  const receipt = kind => ({ ...e.position, t: observedAt, kind, grounded: false, flying: true, yaw: e.yaw, pitch: e.pitch, boosted: false })
  e._ndObservationNow = () => observedAt
  e._ndPositionReceipts = [null, receipt('sync_entity_position')]
  assert.deepEqual(f.forecast(), [])
  const move = () => {
    observedAt += 50; e.position.z += 1.5
    e._ndPositionReceipts = [e._ndPositionReceipts[1], receipt('rel_entity_move')]
    e.emit('ndPositionObserved')
  }
  f.timer.advanceTicks(8)
  for (let i = 0; i < 8; i++) move()
  const threat = f.forecast().find(p => p.kind === 'lance')
  assert.ok(threat, 'eight visible packets remain usable even though the flight owner missed its 160ms sampling window')
  assert.ok(Math.abs(threat.vel.z - 1.5) < .01)
  observedAt += 400; f.timer.advanceTicks(8)
  assert.deepEqual(f.forecast(), [], 'an old receipt cannot keep an incoming velocity alive without new visible motion')
  f.wall('stone', -3)
  move(); assert.deepEqual(f.forecast(), [])
  f.wall(null)
  assert.deepEqual(f.forecast(), [], 'reacquisition must not turn the hidden displacement into velocity')
  f.timer.advanceTicks(1); move()
  assert.equal(f.forecast()[0]?.kind, 'lance', 'a new visible packet restores the measured approach')
})

test('a flying defender treats a charged close pass as a turning lance even when linear escape misses the ray', t => {
  const f = scene(t), e = f.spawn(), velocity = new Vec3(.3649870336630497, -.1462146808747633, -1.8094755712020658)
  // CO native packet witness: the defender brakes at its waypoint after this apparent linear escape.
  f.bot.entity.position.set(7.0702262521736, 69.85724216810806, .5)
  f.bot.entity.velocity.set(1.4174973682202574, .8143720715916289, 0)
  e.position.set(2.251708984375 - velocity.x, 71.39924803376198 - velocity.y, 12.98681640625 - velocity.z)
  e.yaw = 6.086835766330225; e.pitch = -.24543692606170264
  f.forecast(); f.timer.advanceTicks(1); e.position.add(velocity)
  assert.equal(f.forecast()[0]?.kind, 'dive', 'the ground prediction retains its existing semantics')
  f.bot.entity.elytraFlying = true
  const threat = f.forecast()[0]
  assert.equal(threat?.kind, 'lance', 'the charging glider can turn its spear into a braking or circling flyer')
  assert.ok(threat.ticks > 0 && threat.ticks <= 12, 'the warning must precede the current-contact tick')
  f.bot.entity.velocity = velocity.scaled(1.5)
  assert.ok(f.forecast().every(p => p.kind !== 'lance'), 'a faster defender travelling with the attacker cannot take kinetic damage')
  f.bot.entity.velocity.set(1.4174973682202574, .8143720715916289, 0)
  e.metadata[f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = 0
  assert.ok(f.forecast().every(p => p.kind !== 'lance'), 'an unraised spear does not become a charged threat')
})

test('a driven flight dodges a visible incoming spear across its line and then resumes the route', async t => {
  const f = scene(t), e = f.spawn()
  Object.assign(f.bot, { health: 20, _ndFoes: [e.username] })
  Object.assign(f.bot.entity, { elytraFlying: true, onGround: false })
  const goals: any[] = [], states: any[] = [], state = { driving: 0, fd: 0, moveFd: 8 }
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ at: () => 0 }))
  t.mock.method(require('../src/elytra/install'), 'install', () => state)
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_bot, ctl) => ctl)
  t.mock.method(require('../src/elytra/install'), 'steer', () => {})
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => 0)
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
  const threats = require('../src/threats'), forecast = threats.incomingGliders
  let missing = false, observed: any[] = null
  t.mock.method(threats, 'incomingGliders', (...args) => missing ? [] : observed ?? forecast(...args))
  t.mock.method(require('../src/elytra/control'), 'choose', (_world, _state, goal) => {
    states.push(_state)
    goals.push(typeof goal.at === 'function' ? goal.at(0) : goal.at)
    return { c: 0, yaw: 0, pitch: 0, r: {} }
  })
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const { fly } = require('../src/elytra/flight')
  const ctl = { aborted: false }, target = new Vec3(20, 64, 0)
  let kind = 'point'
  const flying = fly(f.bot, ctl, { goal: () => ({ kind, at: () => target }) })
  const flightTick = f.bot.listeners('physicsTick').at(-1)
  try {
    f.forecast()
    f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, 20, 'one observation cannot invent incoming speed')
    f.step(e)
    assert.equal(f.forecast()[0]?.kind, 'lance', 'the fixture really predicts a native spear contact')
    f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, -5, 'a nearby transverse waypoint escapes the spear instead of barely bending the distant route')
    assert.equal(goals.at(-1).z, 0)
    assert.deepEqual(target, new Vec3(20, 64, 0), 'the route target itself is unchanged')
    missing = true
    f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, -5, 'one missing forecast does not turn back into the approaching spear')
    f.bot.entity.position.z = -40
    f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, 20, 'passing the remembered approach releases the manoeuvre')
    f.bot.entity.position.z = 0
    missing = false
    e.elytraFlying = false
    f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, 20, 'clear sky resumes the original route')
    e.elytraFlying = true; f.forecast(); f.step(e)
    assert.equal(f.forecast()[0]?.kind, 'lance')
    kind = 'land'; f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, -5, 'a landing flight still evades an incoming spear before touchdown')
    assert.equal(states.at(-1).fd, 8, 'the emergency manoeuvre preserves the server movement fall-distance price')
    e.elytraFlying = false; f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, 20, 'clear sky resumes the same selected landing point')
    for (const reset of ['ally', 'scope', 'replacement', 'expired']) {
      e.elytraFlying = true; f.forecast(); f.step(e)
      f.bot.emit('physicsTick')
      assert.equal(goals.at(-1).x, -5, 'fresh approach before ' + reset)
      missing = true
      if (reset === 'ally') f.bot._ndSwarmAllies = [e.username]
      if (reset === 'scope') f.bot._ndFoes = []
      if (reset === 'replacement') f.spawn(e.id, -18)
      f.timer.advanceTicks(reset === 'expired' ? 25 : 1); f.bot.emit('physicsTick')
      assert.equal(goals.at(-1).x, 20, 'the episode is discarded on ' + reset)
      f.bot._ndSwarmAllies = []; f.bot._ndFoes = [e.username]; f.bot.entities[e.id] = e
      missing = false; e.elytraFlying = false; f.forecast()
    }
    kind = 'point'
    f.bot.entity.velocity.set(0, 0, -2)
    e.elytraFlying = true; e.position.set(1, 64.5, -8)
    observed = [{ id: e.id, kind: 'lance', ticks: 4, from: { ...e.position }, vel: { x: .1, y: 0, z: 0 }, side: { x: 0, z: 1 } }]
    f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).z, 5)
    missing = true; f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).z, 5, 'own approach keeps the evasion alive across a transverse spear forecast gap')
    f.bot.entity.position.z = -16
    f.timer.advanceTicks(1); f.bot.emit('physicsTick')
    assert.equal(goals.at(-1).x, 20, 'crossing the relative approach plane releases the manoeuvre')
    assert.deepEqual(target, new Vec3(20, 64, 0))
    assert.equal(state.driving, 1, 'the existing flight owns the steering throughout')
  } finally {
    ctl.aborted = true; f.bot.emit('physicsTick'); await flying
  }
  assert.equal(state.driving, 0)
  assert.ok(!f.bot.listeners('physicsTick').includes(flightTick))
})

test('a tactical flight keeps its hand lease when physics callbacks emit outside the action', async t => {
  const f = scene(t), b = f.bot, looks = []
  Object.assign(b, { health: 20, inventory: { slots: [], items: () => [] }, pathfinder: { setGoal() {} },
    look: (yaw, pitch) => { looks.push({ yaw, pitch }); return Promise.resolve() } })
  b._client.write = () => {}
  Object.assign(b.entity, { elytraFlying: true, onGround: false })
  const lock = require('../src/reflex-lock'), session = { bot: b }
  lock.install(session)
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ at: () => 0 }))
  t.mock.method(require('../src/elytra/control'), 'choose', () => ({ c: 0, yaw: 1, pitch: .2, r: { kind: 'floor' } }))
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const { fly } = require('../src/elytra/flight')
  let flight
  const work = lock.start(session, ctl => flight = fly(b, ctl, { goal: { kind: 'point', at: new Vec3(10, 64, 0) } }), { immediate: true })
  try {
    b.emit('physicsTick')
    await new Promise(setImmediate)
    assert.deepEqual([...looks], [{ yaw: 1, pitch: .2 }], 'the active tactical owner turns now, rather than queuing looks until its lease ends')
  } finally {
    lock.cancel(session); b.emit('physicsTick'); await work; await flight
  }
  const count = looks.length
  b.emit('physicsTick'); await new Promise(setImmediate)
  assert.equal(looks.length, count, 'the finished flight leaves no steering callback')
})
