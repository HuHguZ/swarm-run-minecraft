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
