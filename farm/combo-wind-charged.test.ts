import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { targetRespawnFilter, classifyDeathBoost, windChargedPhase } from './swarm/swarm-driver/combo-wind-charged'

function actor(name: string, id: number) {
  const bot: any = new EventEmitter(); bot.username = name; bot.health = 100
  bot.entity = { id, position: { x: 0, y: 151, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  bot.registry = { effectsByName: { WindCharged: { id: 35 } } }; bot._client = new EventEmitter(); bot.writes = []
  bot._client.write = function (...args) { assert.equal(this, bot._client); bot.writes.push(args); return 'sent' }
  bot.clearControlStates = () => {}; bot.deactivateItem = () => {}; bot.quit = () => bot.emit('end')
  return bot
}

test('held target suppresses only its own PERFORM_RESPAWN and restores the exact write method; auto forwards it', () => {
  for (const held of [false, true]) {
    const t = actor('target', 2), other = actor('other', 3), original = t._client.write
    const filter = targetRespawnFilter(t, held)
    t._client.write('client_command', { payload: 0 }); t._client.write('client_command', { actionId: 0 })
    assert.equal(t._client.write('client_command', { payload: 1 }), 'sent')
    assert.equal(t._client.write('keep_alive', { keepAliveId: 1 }), 'sent')
    other._client.write('client_command', { payload: 0 })
    assert.equal(t.writes.length, held ? 2 : 4); assert.equal(other.writes.length, 1)
    assert.equal(filter.requests.length, 2); assert.ok(filter.requests.every(row => row.blocked === held))
    filter.close(); assert.equal(t._client.write, original)
  }
})

test('one actual toss and one ordinary strike are retained even on missed delivery, with capture after death and cleanup before reset', async () => {
  const a = actor('A', 1), t = actor('T', 2), b = actor('B', 3), original = t._client.write, calls: string[] = []
  const phase = await windChargedPhase({ attacker: a, target: t, receiver: b }, 'held', () => false, {
    target: () => ({ id: 2, position: t.entity.position, isValid: true }), visible: () => true,
    throwPotion: async () => { calls.push('toss'); return { thrown: false, ticks: 4.2, why: 'delivery_missed' } },
    waitTicks: async (_bot, n) => { calls.push(`wait${n}`) },
    strike: async () => { calls.push('strike'); t.emit('death'); t._client.write('client_command', { payload: 0 })
      b._client.emit('explosion', { center: { x: 0, y: 151.9, z: 0 }, playerKnockback: { x: 1, y: .4, z: 0 } })
      b.entity.velocity = { x: 1, y: .4, z: 0 }; b.emit('physicsTick'); return { sent: true } },
    landing: async bot => { calls.push(`land${bot.username}`); return { reason: 'landed' } },
    respawn: async () => { calls.push('cleanupRespawn'); t.emit('respawn')
      b._client.emit('explosion', { center: { x: 0, y: 151.9, z: 0 }, playerKnockback: { x: .5, y: .1, z: 0 } }) }
  })
  assert.deepEqual(calls.slice(0, 3), ['toss', 'wait8', 'strike'])
  assert.equal(calls.filter(x => x === 'strike').length, 1); assert.equal(calls.filter(x => x === 'toss').length, 1)
  assert.ok(phase.endedAtMs - phase.deathAtMs >= 2000); assert.equal(phase.outcome.primedAtDeath, false)
  assert.ok(phase.endedAtMs - phase.cleanupRespawnAtMs >= 1000); assert.equal(phase.explosions.length, 2, 'cleanup-triggered effects remain inside capture')
  assert.equal(phase.outcome.blastObserved, true); assert.equal(phase.outcome.receiverMotionObserved, true)
  assert.equal(phase.respawnRequests[0].blocked, true); assert.equal(t._client.write, original)
  assert.equal(a._client.listenerCount('explosion'), 0); assert.equal(t.listenerCount('death'), 0)
  assert.ok(calls.includes('landA') && calls.includes('landB'))
})

test('STOP and action errors cannot leave a target respawn filter or start a strike after cancellation', async () => {
  for (const fail of [false, true]) {
    const a = actor('A', 1), t = actor('T', 2), b = actor('B', 3), original = t._client.write
    let strikes = 0
    const phase = await windChargedPhase({ attacker: a, target: t, receiver: b }, 'held', () => !fail, {
      target: () => ({ id: 2, position: t.entity.position, isValid: true }), visible: () => true,
      throwPotion: async () => { throw Error('fixture toss failure') }, strike: async () => { strikes++; return { sent: true } }
    })
    assert.equal(strikes, 0); assert.equal(t._client.write, original)
    assert.equal(phase.why, fail ? 'action_error' : 'cancelled')
    assert.equal(t.listenerCount('death'), 0); assert.equal(b._client.listenerCount('explosion'), 0)
  }
})

test('real WindCharged registry id35 observes an effect receipt before death without changing the action sequence', async () => {
  const a = actor('A', 1), t = actor('T', 2), b = actor('B', 3), calls: string[] = []
  Object.defineProperty(t, 'health', { get() { throw Error('target HP cannot control actions') } })
  const phase = await windChargedPhase({ attacker: a, target: t, receiver: b }, 'auto', () => false, {
    target: () => ({ id: 2, position: t.entity.position, isValid: true }), visible: () => true,
    throwPotion: async () => { calls.push('toss'); t._client.emit('entity_effect', { entityId: 2, effectId: 35, amplifier: 0, duration: 3600 }); return { thrown: true, ticks: 4.2 } },
    waitTicks: async (_bot, n) => { calls.push(`wait${n}`) },
    strike: async () => { calls.push('strike'); t.emit('death'); return { sent: true } },
    landing: async () => ({ reason: 'landed' })
  })
  assert.deepEqual(calls, ['toss', 'wait8', 'strike'])
  assert.equal(phase.primedAtDeath, true); assert.equal(phase.outcome.primedAtDeath, true)
  assert.equal(phase.effects.length, 1); assert.equal(phase.effects[0].data.effectId, 35)
  assert.equal(t._client.listenerCount('entity_effect'), 0)
})

test('classification keeps priming, actual death and a later blast separate from a mere strike attempt', () => {
  const noDeath = classifyDeathBoost({ deathAtMs: null, primedAtDeath: true, explosions: [{ ms: 30, actor: 'B', impulse: { x: 1, y: 1, z: 0 } }], receiver: 'B' })
  assert.equal(noDeath.deathObserved, false); assert.equal(noDeath.blastObserved, false)
  const before = classifyDeathBoost({ deathAtMs: 20, primedAtDeath: true, explosions: [{ ms: 10, actor: 'B', impulse: { x: 1, y: 1, z: 0 } }], receiver: 'B' })
  assert.equal(before.deathObserved, true); assert.equal(before.blastObserved, false)
  const hit = classifyDeathBoost({ deathAtMs: 20, primedAtDeath: true, explosions: [{ ms: 30, actor: 'B', impulse: { x: 1, y: 1, z: 0 } }], receiver: 'B',
    frames: [{ ms: 31, actor: 'B', velocity: { x: 1, y: 1, z: 0 } }] })
  assert.equal(hit.blastObserved, true); assert.equal(hit.receiverMotionObserved, true); assert.equal(hit.primedAtDeath, true)
})
