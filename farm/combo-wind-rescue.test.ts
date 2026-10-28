import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { startWindRescue, projectFall } from './swarm/swarm-driver/combo-wind-rescue'
import { anvilArm } from './swarm/swarm-driver/combo-anvil'

const { Vec3 } = require('../daemon/node_modules/vec3')
const pick = require('../daemon/src/pick'), track = require('../daemon/src/bow/track')
const air = require('../daemon/src/swarm/combos/air-ideas'), ballistics = require('../daemon/src/combat/team-wind')
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
function fixture() {
  const actor = (username, id, y, z) => {
    const bot: any = new EventEmitter()
    bot.username = username; bot.health = 100; bot._client = new EventEmitter()
    bot.entity = { id, position: new Vec3(600.5, y, z), velocity: new Vec3(0, 0, 0), onGround: y === 151 }
    bot.activations = 0; bot._ndWindCd = 123
    bot.activateItem = function (...args) { assert.equal(this, bot); bot.activations++; return args[0] }
    bot.quit = () => bot.emit('end')
    return bot
  }
  const a = actor('A', 1, 151, 606.5), b = actor('B', 2, 163, 597.5), t = actor('T', 3, 160, 600.5)
  const remote = bot => ({ ...bot.entity, position: bot.entity.position.clone(), username: bot.username,
    type: 'player', name: 'player', isValid: true })
  a.entities = { 2: remote(b), 3: remote(t) }
  a.entities[2].position.y = 158.5; a.entities[2].onGround = false
  a.entities[2]._ndPositionReceipts = [null, { t: 1, kind: 'rel_entity_move', x: 600.5, y: 158.5, z: 597.5 }]
  a.blockAt = p => ({ position: p.clone(), name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
  Object.defineProperty(t, 'health', { get() { throw Error('enemy HP must not decide') } })
  Object.defineProperty(a.entities[3], 'health', { get() { throw Error('enemy HP must not decide') } })
  const packet = { entityId: 3, sourceTypeId: 26, sourceCauseId: 3, sourceDirectId: 3 }
  let visible = true, floor = true, stopped = false
  const originals = { canHit: pick.canHit, faceAim: pick.faceAim, eyeOf: pick.eyeOf,
    observedVelocity: track.observedVelocity, hasObservedVelocity: track.hasObservedVelocity,
    windAt: air.windAt, windLaunch: ballistics.windLaunch }
  pick.canHit = () => visible
  pick.faceAim = (_a, pos) => floor ? pos.offset(.5, 1, .5) : null
  pick.eyeOf = bot => bot.entity.position.offset(0, 1.62, 0)
  track.observedVelocity = () => ({ x: 0, y: -.3, z: 0, ageTicks: .2 })
  track.hasObservedVelocity = () => true
  ballistics.windLaunch = () => ({ time: 6 })
  const stages: string[] = []
  air.windAt = async (bot, target, p) => {
    assert.equal(target, a.entities[2]); stages.push('equip', 'wait2'); await pause()
    stages.push('look', 'wait1'); await pause()
    if (p.ctl.aborted || !p.allySafe()) return { fired: false, why: 'cancelled' }
    assert.equal(p.allowAlly, true); assert.equal(p.allyHealth(), 100)
    bot.activateItem('return-value'); bot._ndWindCd = 999
    return { fired: true, ticks: 6, trace: { aim: { target: target.position.clone() } } }
  }
  const receipt = (y, x = 600.5) => {
    const target = a.entities[2]; target.position.y = y; target.position.x = x
    const old = target._ndPositionReceipts[1]
    target._ndPositionReceipts = [old, { ...old, t: old.t + 1, x, y }]
  }
  return { a, b, t, packet, receipt, stages, stop: () => stopped, setStop: () => { stopped = true },
    visible: value => { visible = value }, floor: value => { floor = value },
    restore() { Object.assign(pick, { canHit: originals.canHit, faceAim: originals.faceAim, eyeOf: originals.eyeOf })
      Object.assign(track, { observedVelocity: originals.observedVelocity, hasObservedVelocity: originals.hasObservedVelocity })
      air.windAt = originals.windAt; ballistics.windLaunch = originals.windLaunch }
  }
}

test('air recurrence uses move then native float drag, and wind arm keeps first wind and six-metre support in both arms', () => {
  const p = projectFall({ x: 0, y: 160.89044745, z: 0 }, { x: 0, y: .01, z: 0 }, 17)
  assert.ok(Math.abs(p.y - 151.368719) < .001)
  for (const enabled of [false, true]) {
    const arm = anvilArm(enabled, 'wind')
    assert.equal(arm.firstWind, true); assert.equal(arm.supportZ, 606.5)
  }
})

test('attributed26 needs two distinct fresh vertical observations; target death after acceptance does not cancel rescue', async () => {
  const f = fixture(), rescue = startWindRescue(f.a, f.b, f.t, true, f.stop)
  try {
    rescue.afterWind({ fired: true })
    for (const change of [{ entityId: 99 }, { sourceTypeId: 34 }, { sourceCauseId: 99 }, { sourceDirectId: 99 }])
      f.a._client.emit('damage_event', { ...f.packet, ...change })
    assert.equal(rescue.trace.firstSmash, null)
    f.visible(false); f.a._client.emit('damage_event', f.packet); f.visible(true)
    assert.equal(rescue.trace.firstSmash, null)
    f.a._client.emit('damage_event', f.packet); f.t.emit('death')
    f.receipt(158.4); await pause()
    assert.equal(f.a.activations, 0, 'a confident mixed pre/post-smash interval cannot release')
    f.receipt(158.3); await rescue.settle()
    assert.equal(rescue.trace.secondWind.fired, true)
    assert.equal(rescue.trace.gate.newReceiptCount, 2)
    assert.equal(rescue.trace.gate.horizonTicks, 9)
    assert.equal(f.a.activations, 1)
  } finally { await rescue.close(); f.restore() }
})

test('sham keeps preparation and restores exact activation/cooldown; STOP or ally death joins before close', async () => {
  for (const enabled of [false, true]) for (const cancel of [null, 'stop', 'death']) {
    const f = fixture(), original = f.a.activateItem, rescue = startWindRescue(f.a, f.b, f.t, enabled, f.stop)
    try {
      assert.equal(f.a.activateItem('first'), 'first', 'first wind is outside the second-shot wrapper')
      rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
      f.receipt(158.4); await pause(); f.receipt(158.3)
      const deadline = Date.now() + 1000
      while (!f.stages.length && Date.now() < deadline) await pause()
      assert.ok(f.stages.length, 'the second-shot preparation began')
      if (cancel === 'stop') f.setStop()
      if (cancel === 'death') { f.b.emit('death'); f.b.entity = { ...f.b.entity }; f.b.health = 100 }
      if (cancel) await rescue.close(); else await rescue.settle()
      assert.deepEqual(f.stages, ['equip', 'wait2', 'look', 'wait1'])
      assert.equal(f.a.activations, 1 + Number(enabled && !cancel))
      assert.equal(f.a.activateItem, original)
      assert.equal(f.a._ndWindCd, enabled && !cancel ? 999 : 123)
      assert.equal(rescue.trace.secondWind.fired, enabled && !cancel)
      await rescue.close()
      assert.equal(f.a._client.listenerCount('damage_event'), 0)
      for (const actor of [f.a, f.b]) for (const event of ['death', 'respawn', 'end']) assert.equal(actor.listenerCount(event), 0)
    } finally { await rescue.close(); f.restore() }
  }
})

test('post-smash observer changes only the timing estimate and cannot expire on an unmeasured old velocity', async () => {
  const f = fixture(), originalWind = air.windAt
  let factories = 0, helperVelocity: number | null = null
  track.observedVelocity = () => ({ x: 0, y: -10, z: 0, ageTicks: .2 })
  air.windAt = async (...args) => { helperVelocity = track.observedVelocity(args[1]).y; return originalWind(...args) }
  const observer = baseline => {
    factories++; assert.equal(baseline.y, 158.5)
    const seen = new Set<number>()
    return (receipt, velocity) => {
      if (receipt.t !== baseline.t) seen.add(receipt.t)
      return { velocity: { ...velocity, y: -.3 }, confidence: seen.size >= 3, fit: { points: seen.size } }
    }
  }
  const rescue = (startWindRescue as any)(f.a, f.b, f.t, true, f.stop, Date.now(), observer)
  try {
    rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet); f.t.emit('death')
    f.receipt(158.4); await pause(); f.receipt(158.3); await pause()
    assert.equal(f.a.activations, 0)
    f.receipt(158.2); await rescue.settle()
    assert.equal(factories, 1)
    assert.equal(f.a.activations, 1)
    assert.equal(rescue.trace.gate.velocity.y, -.3)
    assert.equal(helperVelocity, -10, 'the unchanged wind helper still reads the existing tracker')
  } finally { await rescue.close(); f.restore() }
})

test('two fresh XZ-only receipts cannot spend a charge using a previously confident vertical estimate', async () => {
  const f = fixture(), rescue = startWindRescue(f.a, f.b, f.t, true, f.stop)
  try {
    rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
    f.receipt(158.5, 600.6); await pause(); f.receipt(158.5, 600.7); await pause(); await pause()
    assert.equal(f.stages.length, 0, 'XZ-only observations cannot start second-shot preparation')
    assert.equal(f.a.activations, 0, 'changed XZ does not supply two post-hit vertical displacements')
    f.receipt(158.4); await pause(); f.receipt(158.3); await rescue.settle()
    assert.equal(rescue.trace.secondWind.fired, true)
  } finally { await rescue.close(); f.restore() }
})

test('an injected second launcher keeps the attributed cue, sham activation and exact restoration', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), original = f.a.activateItem
    let calls = 0
    const launch = async (...args) => { calls++; return air.windAt(...args) }
    const rescue = startWindRescue(f.a, f.b, f.t, enabled, f.stop, Date.now(), undefined, launch)
    try {
      rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
      f.receipt(158.4); await pause(); f.receipt(158.3); await rescue.settle()
      assert.equal(calls, 1); assert.equal(f.a.activations, enabled ? 1 : 0)
      assert.equal(rescue.trace.secondWind.sham, !enabled); assert.equal(f.a.activateItem, original)
      assert.equal(f.a._ndWindCd, enabled ? 999 : 123)
    } finally { await rescue.close(); f.restore() }
    assert.equal(f.a._client.listenerCount('damage_event'), 0)
  }
})

test('settle bounds a silent helper tick wait before the engine can enter close/reset', async () => {
  const f = fixture(), original = f.a.activateItem
  air.windAt = async bot => { f.stages.push('waiting'); await new Promise(resolve => bot.once('end', resolve)); return { fired: false, why: 'ended' } }
  const rescue = startWindRescue(f.a, f.b, f.t, true, f.stop)
  try {
    rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
    f.receipt(158.4); await pause(); f.receipt(158.3)
    let settled = false
    const joined = rescue.settle().then(() => { settled = true })
    const deadline = Date.now() + 2600
    while (!settled && Date.now() < deadline) await pause()
    assert.equal(settled, true, 'settle must not wait forever for close to supply cancellation')
    await joined
    assert.equal(rescue.trace.error, 'second_wind_wall_cap')
    assert.equal(f.a.activateItem, original)
  } finally { await rescue.close(); f.restore() }
})
