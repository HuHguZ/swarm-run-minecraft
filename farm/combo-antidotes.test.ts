import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rawAntidoteSession, antidoteCalibrationPhase, CALIBRATION_POSES, FAR_SHARE_POSES } from './swarm/swarm-driver/combo-antidotes'

function actors() {
  const bots = ['patient', 'donor', 'cover', 'enemy'].map((username, index) => {
    const bot: any = new EventEmitter()
    Object.assign(bot, { username, health: 20, entity: { id: index + 1, position: { x: index, y: 151, z: 600.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
      registry: {}, clearControlStates() {}, deactivateItem() {}, quit() { bot.emit('end') }, waitForTicks: async () => {} })
    return bot
  })
  return { patient: bots[0], donor: bots[1], cover: bots[2], enemy: bots[3], bots }
}

test('fixture numeric coordinates are explicit block centers, so integer command centering cannot move the expected body', () => {
  for (const poses of Object.values(CALIBRATION_POSES)) for (const [x, z] of poses) {
    assert.equal(x - Math.floor(x), .5); assert.equal(z - Math.floor(z), .5)
  }
})

test('minimal raw session propagates abort and restores current intent/listeners after a real worker finishes', async () => {
  const { patient } = actors(), session = rawAntidoteSession(patient, () => false)
  let released = 0, captured: any
  const value = await session.runIntent('antidote', async ctl => {
    captured = ctl; ctl.onAbort.push(() => { released++ }); patient.emit('death')
    assert.equal(ctl.aborted, true); return 'finished'
  }, { timeoutMs: 1000 })
  assert.equal(value, 'finished'); assert.equal(released, 1); assert.equal(session.current, null)
  assert.equal(patient.listenerCount('death'), 0); assert.equal(captured.aborted, true)
})

test('delivery calibration awaits actual toss and pickup inventory receipt before consuming, with shield cover closed after landing', async () => {
  const f = actors(), order: string[] = []
  let have = 0
  const result = await antidoteCalibrationPhase(f, 'share', () => false, {
    count: () => have,
    toss: async () => { order.push('toss'); return { ok: true } },
    pickup: async () => { order.push('pickup'); have++; return { ok: true } },
    shield: async () => ({ confirmed: true, close: () => { order.push('shield_close') }, report: () => ({ blocked: 1 }) }),
    attackCover: async () => { order.push('enemy_strike'); return { sent: true } },
    consume: async () => { assert.equal(have, 1); order.push('consume'); return { consumed: true, item: 'honey_bottle' } },
    landing: async () => { order.push('land'); return { reason: 'landed' } },
    drain: async () => { order.push('drain') },
  })
  assert.equal(result.consumed, true); assert.equal(result.joined, true)
  assert.ok(order.indexOf('toss') < order.indexOf('pickup') && order.indexOf('pickup') < order.indexOf('consume'))
  assert.ok(order.indexOf('consume') < order.indexOf('land')); assert.ok(order.indexOf('land') < order.indexOf('shield_close'))
  assert.equal(result.transfer.received, 1); assert.equal(result.cover.blocked, 1)
})

test('a nominal pickup without inventory gain cannot be credited as a delivery or trigger drinking', async () => {
  const f = actors(); let consumed = 0
  const result = await antidoteCalibrationPhase(f, 'share', () => false, {
    count: () => 0, toss: async () => ({ ok: true }), pickup: async () => ({ ok: true }),
    shield: async () => ({ confirmed: false, close() {}, report: () => ({}) }), attackCover: async () => ({}),
    consume: async () => { consumed++; return { consumed: true } }, landing: async () => ({ reason: 'landed' }), drain: async () => {},
  })
  assert.equal(consumed, 0); assert.equal(result.consumed, false); assert.equal(result.transfer.received, 0); assert.equal(result.joined, true)
})

test('STOP or own first-life death prevents later consume and releases a pending cover scope', async () => {
  for (const death of [false, true]) {
    const f = actors(); let stopped = false, consumed = 0, closed = 0
    const result = await antidoteCalibrationPhase(f, 'share', () => stopped, {
      count: () => 0,
      toss: async () => { if (death) f.patient.emit('death'); else stopped = true; return { ok: true } },
      pickup: async () => { throw Error('pickup after cancellation') },
      shield: async () => ({ confirmed: true, close() { closed++ }, report: () => ({}) }), attackCover: async () => ({}),
      consume: async () => { consumed++; return {} }, landing: async () => ({ reason: 'landed' }), drain: async () => {},
    })
    assert.equal(consumed, 0); assert.equal(result.consumed, false); assert.equal(closed, 1); assert.equal(result.joined, true)
    assert.equal(f.patient.listenerCount('death'), 0)
  }
})

test('far share prices a real 4.29 meter approach, tosses only in range, and counts an early actual pickup before consuming', async () => {
  assert.ok(Math.abs(Math.hypot(FAR_SHARE_POSES[1][0] - FAR_SHARE_POSES[0][0], FAR_SHARE_POSES[1][1] - FAR_SHARE_POSES[0][1]) - 4.29) < 1e-10)
  for (const role of [0, 2, 3]) assert.deepEqual(FAR_SHARE_POSES[role], CALIBRATION_POSES.share[role])
  const f = actors(), order: string[] = []; let have = 0
  f.donor.entity.position.x = 4.29
  const result = await antidoteCalibrationPhase(f, 'share-far', () => false, {
    count: () => have, target: (_bot, name) => f.bots.find(bot => bot.username === name)?.entity, visible: () => true,
    state: bot => ({ health: 20, alive: true, inventory: { honey_bottle: bot === f.donor ? 2 : 0, milk_bucket: 0 },
      effects: bot === f.patient ? [{ name: 'poison', amplifier: 1, remainingTicks: 600 }] : [] }),
    approach: async (bot, ctl, spot) => { order.push('approach'); assert.equal(ctl.aborted, false); bot.entity.position.x = spot.x; bot.entity.position.z = spot.z; return { ok: true } },
    toss: async () => { order.push('toss'); assert.ok(Math.hypot(f.donor.entity.position.x - f.patient.entity.position.x, f.donor.entity.position.z - f.patient.entity.position.z) <= 3); have++; return { ok: true } },
    pickup: async () => { throw Error('already received; no second pickup needed') },
    shield: async () => ({ confirmed: true, close() {}, report: () => ({}) }), attackCover: async () => ({}),
    consume: async () => { order.push('consume'); assert.equal(have, 1); return { consumed: true } }, landing: async () => ({}), drain: async () => {},
  })
  assert.equal(result.error, null); assert.deepEqual(order, ['approach', 'toss', 'consume']); assert.equal(result.transfer.received, 1)
  assert.ok(result.delivery.initialQuote > 0 && result.delivery.releaseQuote > 0); assert.equal(result.consumed, true); assert.equal(result.joined, true)
})

test('far share stops after an interrupted approach without tossing or consuming and closes the shield scope', async () => {
  for (const death of [false, true]) {
    const f = actors(); let stopped = false, tossed = 0, consumed = 0, closed = 0
    f.donor.entity.position.x = 4.29
    const result = await antidoteCalibrationPhase(f, 'share-far', () => stopped, {
      count: () => 0, target: (_bot, name) => f.bots.find(bot => bot.username === name)?.entity, visible: () => true,
      state: bot => ({ health: 20, alive: true, inventory: { honey_bottle: bot === f.donor ? 2 : 0, milk_bucket: 0 },
        effects: bot === f.patient ? [{ name: 'poison', amplifier: 1, remainingTicks: 600 }] : [] }),
      approach: async () => { if (death) f.donor.emit('death'); else stopped = true; return { ok: true } },
      toss: async () => { tossed++; return { ok: true } }, consume: async () => { consumed++; return { consumed: true } },
      shield: async () => ({ confirmed: true, close() { closed++ }, report: () => ({}) }), landing: async () => ({}), drain: async () => {},
    })
    assert.equal(tossed, 0); assert.equal(consumed, 0); assert.equal(closed, 1); assert.equal(result.joined, true)
  }
})
