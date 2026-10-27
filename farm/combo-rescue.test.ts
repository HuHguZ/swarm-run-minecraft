import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { startWaterRescue } from './swarm/swarm-driver/combo-rescue'

const { Vec3 } = require('../daemon/node_modules/vec3')
const hands = require('../daemon/src/swarm/combos/landing-rescue')
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
function fixture() {
  const actor = (username: string, id: number, z: number, y = 151) => {
    const bot: any = new EventEmitter()
    bot.username = username; bot.health = 20; bot._client = new EventEmitter()
    bot.entity = { id, position: new Vec3(600.5, y, z), velocity: new Vec3(0, 0, 0),
      onGround: y === 151, eyeHeight: 1.62, yaw: 0, pitch: 0 }
    bot.controls = {}; bot.setControlState = (key, value) => { bot.controls[key] = value }
    bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
    return bot
  }
  const a = actor('support', 2, 606.5), b = actor('mace', 1, 597.5, 163), t = actor('target', 3, 600.5)
  let wall = false
  const remote = (bot: any) => ({ id: bot.entity.id, username: bot.username, name: 'player', type: 'player', isValid: true,
    position: bot.entity.position.clone(), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, metadata: [] })
  a.entities = { 1: remote(b), 3: remote(t) }; a.players = { mace: { entity: a.entities[1] }, target: { entity: a.entities[3] } }
  a.registry = { entitiesByName: { player: { metadataKeys: [] } } }; a.world = { raycast: () => null }
  a.blockAt = p => ({ name: wall ? 'stone' : 'air', position: p, boundingBox: wall ? 'block' : 'empty', shapes: wall ? [[0, 0, 0, 1, 1, 1]] : [] })
  b.registry = a.registry; b.world = a.world; b.blockAt = a.blockAt; b.entities = { 3: remote(t) }
  b.heldItem = { name: 'mace' }; b.attacks = 0
  b.attack = function (enemy: any) { assert.equal(this, b); b.attacks++; b.lastAttack = enemy; return 'attack-return' }
  Object.defineProperty(t, 'health', { get() { throw Error('enemy HP must not decide rescue') } })
  Object.defineProperty(a.entities[3], 'health', { get() { throw Error('enemy HP must not decide rescue') } })
  Object.defineProperty(b.entities[3], 'health', { get() { throw Error('enemy HP must not decide rescue') } })
  const packet = { entityId: 3, sourceTypeId: 26, sourceCauseId: 2, sourceDirectId: 2 }
  return { a, b, t, packet, wall: (value: boolean) => { wall = value }, arrive: () => {
    a.entity.position.set(601.5, 151, 601); a.emit('physicsTick')
  } }
}

test('only a visible attributed mace smash cues rescue; target death does not cancel the live allies', async () => {
  const f = fixture(), original = hands.waterCatch
  hands.waterCatch = async (_a, _b, _cell, ctl, enabled) => ({ sent: enabled && !ctl.aborted,
    waterObserved: enabled && !ctl.aborted, why: enabled ? 'water_observed' : 'sham' })
  const rescue = startWaterRescue(f.a, f.b, f.t, true, () => false)
  try {
    rescue.afterWind({ fired: true })
    for (const change of [{ sourceTypeId: 34 }, { sourceCauseId: 9 }, { sourceDirectId: 9 }, { entityId: 9 }])
      f.a._client.emit('damage_event', { ...f.packet, ...change })
    f.wall(true); f.a._client.emit('damage_event', f.packet); f.wall(false)
    assert.equal(rescue.trace.firstSmash, null)
    f.a._client.emit('damage_event', f.packet); f.t.emit('death')
    f.arrive(); await rescue.settle()
    assert.equal(rescue.trace.firstSmash.packet.sourceTypeId, 26)
    assert.equal(rescue.trace.secondPlace.sent, true)
    assert.equal(rescue.trace.walk.arrived, true)
    assert.deepEqual(rescue.trace.walk.actualEnd, { x: 601.5, y: 151, z: 601 })
  } finally { await rescue.close(); hands.waterCatch = original }
  assert.equal(f.a._client.listenerCount('damage_event'), 0)
  assert.equal(f.a.controls.forward, false)
})

// Native LpVec3.write: rounded 15-bit components, low two bytes then big-endian int.
// Deliberately do not use minecraft-protocol's legacy/misordered LP reader or writer.
function velocityWire(id: number, y = Math.fround(.01), x = 0, scale = Math.ceil(Math.max(Math.abs(y), Math.abs(x)))) {
  const vint = (n: number) => { const out: number[] = []; do { const v = n % 128; n = Math.floor(n / 128); out.push(v | (n ? 128 : 0)) } while (n); return out }
  const pack = (v: number) => Math.round((v / scale * .5 + .5) * 32766)
  const bits = (scale & 3) + (scale > 3 ? 4 : 0) + pack(x) * 8 + pack(y) * 2 ** 18 + pack(0) * 2 ** 33
  const lp = Buffer.alloc(6); lp[0] = bits % 256; lp[1] = Math.floor(bits / 256) % 256
  lp.writeUInt32BE(Math.floor(bits / 65536), 2)
  return Buffer.concat([Buffer.from([0x63, ...vint(id)]), lp, Buffer.from(scale > 3 ? vint(Math.floor(scale / 4)) : [])])
}
function motion(f: ReturnType<typeof fixture>, bytes = velocityWire(f.b.entity.id), id = f.b.entity.id) {
  // Parsed velocity is intentionally wrong: only this same packet's native bytes are evidence.
  f.b._client.emit('packet', { entityId: id, velocity: { x: 9, y: -8, z: 7 } }, { name: 'entity_velocity' }, bytes)
}
function attempt(f: ReturnType<typeof fixture>, vy = -1) {
  f.b.entity.position.set(600.5, 160, 600.5); f.b.entity.velocity.y = vy; f.b.entity.onGround = false
  f.b.entities[3].position.set(600.5, 158, 600.5); f.a.entities[3].position.set(600.5, 158, 600.5)
  return f.b.attack(f.b.entities[3])
}

test('motion-only fixture control preserves raw26 delivery while standard primary26 wins and control waits for self-motion', async () => {
  const original = hands.waterCatch
  hands.waterCatch = async () => ({ sent: true, waterObserved: true })
  try {
    for (const damageCue of [false, true]) {
      const f = fixture(), named: any[] = [], raw: any[] = [], bytes = Buffer.from([1, 2, 3])
      const onNamed = packet => named.push(packet), onRaw = (packet, meta, wire) => raw.push({ packet, meta, wire })
      f.a._client.on('damage_event', onNamed); f.a._client.on('packet', onRaw)
      const rescue = Reflect.apply(startWaterRescue, undefined, [f.a, f.b, f.t, true, () => false, Date.now(), damageCue])
      try {
        rescue.afterWind({ fired: true }); attempt(f)
        f.a._client.emit('packet', f.packet, { name: 'damage_event' }, bytes)
        f.a._client.emit('damage_event', f.packet)
        assert.equal(named[0], f.packet); assert.equal(raw[0].packet, f.packet); assert.equal(raw[0].wire, bytes)
        assert.deepEqual(rescue.trace.rawDamage26[0].packet, f.packet)
        assert.equal(!!rescue.trace.firstSmash, damageCue)
        motion(f); f.arrive(); await rescue.settle()
        assert.equal(rescue.trace.cuePolicy, damageCue ? 'standard' : 'motion_only_control')
        assert.equal(rescue.trace.firstSmash.cueKind, damageCue ? 'attributed_damage26' : 'motion_post_mace_attempt')
        if (!damageCue) assert.equal(rescue.trace.cueRejects[0].why, 'primary_disabled_control')
        assert.equal(rescue.trace.secondPlace.sent, true)
      } finally { await rescue.close() }
      assert.equal(f.a._client.listenerCount('damage_event'), 1)
      assert.equal(f.a._client.listenerCount('packet'), 1)
      f.a._client.removeListener('damage_event', onNamed); f.a._client.removeListener('packet', onRaw)
    }
  } finally { hands.waterCatch = original }
})

test('missing target damage_event can cue once from a new native self-motion after a legal descending mace attempt, in both arms', async () => {
  const original = hands.waterCatch
  let calls = 0
  hands.waterCatch = async (_a, _b, _cell, _ctl, enabled) => { calls++; return { sent: enabled, waterObserved: enabled, why: enabled ? 'water_observed' : 'sham' } }
  try {
    for (const enabled of [false, true]) {
      const f = fixture(), attack = f.b.attack, rescue = startWaterRescue(f.a, f.b, f.t, enabled, () => false)
      try {
        rescue.afterWind({ fired: true }); assert.equal(attempt(f), 'attack-return')
        motion(f); motion(f); f.arrive(); await rescue.settle()
        assert.equal(rescue.trace.firstSmash.cueKind, 'motion_post_mace_attempt')
        assert.equal(rescue.trace.firstSmash.targetAttribution, 'unknown_motion_has_no_target')
        assert.equal(rescue.trace.secondPlace.sent, enabled)
        assert.equal(f.b.attacks, 1)
        assert.ok(rescue.trace.rawVelocity[0].bytesHex)
        assert.notEqual(rescue.trace.rawVelocity[0].velocity.y, -8)
      } finally { await rescue.close() }
      assert.equal(f.b.attack, attack); assert.equal(f.b._client.listenerCount('packet'), 0)
    }
    assert.equal(calls, 2)
  } finally { hands.waterCatch = original }
})

test('wind, ordinary, upward, wrong-entity and stale pre-attempt motion never fabricate a smash cue', async () => {
  for (const kind of ['wind', 'ordinary', 'upward', 'wrong_entity', 'pre_attempt', 'blocked_pick', 'blocked_attack']) {
    const f = fixture()
    if (kind === 'blocked_attack') f.b.attack = () => { f.b.attacks++; f.b._ndBlockedHits = (f.b._ndBlockedHits || 0) + 1 }
    const rescue = startWaterRescue(f.a, f.b, f.t, true, () => false)
    try {
      rescue.afterWind({ fired: true })
      if (kind === 'pre_attempt') motion(f)
      if (kind === 'ordinary') f.b.heldItem.name = 'iron_sword'
      if (kind === 'blocked_pick') f.wall(true)
      attempt(f, kind === 'upward' ? .1 : -1)
      if (kind !== 'pre_attempt') motion(f, velocityWire(kind === 'wrong_entity' ? 99 : 1, kind === 'wind' ? .42 : Math.fround(.01)), kind === 'wrong_entity' ? 99 : 1)
      f.arrive(); await rescue.settle()
      assert.equal(rescue.trace.firstSmash, null, kind)
      assert.equal(rescue.trace.secondPlace, null, kind)
      assert.equal(f.b.attacks, 1, 'the observer must not suppress or duplicate the original attack')
    } finally { await rescue.close() }
  }
})

test('a pending motion cue expires and cannot cross STOP, landing, weapon swap or a replaced target life', async () => {
  for (const kind of ['timeout', 'stop', 'landing', 'swap', 'old_life', 'ally_death']) {
    const f = fixture(); let stopped = false
    const rescue = startWaterRescue(f.a, f.b, f.t, true, () => stopped), now = Date.now
    try {
      rescue.afterWind({ fired: true }); attempt(f)
      if (kind === 'timeout') { const later = now() + 1001; Date.now = () => later }
      if (kind === 'stop') stopped = true
      if (kind === 'landing') { f.b.entity.onGround = true; f.b.emit('physicsTick') }
      if (kind === 'swap') f.b.heldItem.name = 'iron_sword'
      if (kind === 'old_life') { f.a.entities[3] = { ...f.a.entities[3] }; f.a.players.target.entity = f.a.entities[3] }
      if (kind === 'ally_death') { f.b.emit('death'); f.b.health = 20 }
      motion(f); f.arrive(); await rescue.settle()
      assert.equal(rescue.trace.firstSmash, null, kind)
      assert.equal(rescue.trace.secondPlace, null, kind)
    } finally { Date.now = now; await rescue.close() }
  }
})

test('LP scale comes from the same bounded native packet, including extended scale; malformed bytes are not a receipt', async () => {
  const original = hands.waterCatch
  hands.waterCatch = async () => ({ sent: true, waterObserved: true })
  try {
    for (const kind of ['extended', 'truncated', 'raw_entity_mismatch', 'zero_bin']) {
      const f = fixture(), rescue = startWaterRescue(f.a, f.b, f.t, true, () => false)
      try {
        rescue.afterWind({ fired: true }); attempt(f)
        const bytes = kind === 'truncated' ? Buffer.from([0x63, 1, 4, 0, 0]) :
          kind === 'raw_entity_mismatch' ? velocityWire(99) : kind === 'zero_bin' ? velocityWire(1, Math.fround(.01), 513, 514) :
          velocityWire(1, Math.fround(.01), 4.1, 5)
        motion(f, bytes)
        f.arrive(); await rescue.settle()
        assert.equal(!!rescue.trace.firstSmash, kind === 'extended', kind)
        if (kind === 'extended') assert.equal(rescue.trace.rawVelocity[0].scale, 5)
      } finally { await rescue.close() }
    }
  } finally { hands.waterCatch = original }
})

test('raw target26 and cue rejection receipts are bounded and do not replace cause attribution with death status', async () => {
  const f = fixture(), rescue = startWaterRescue(f.a, f.b, f.t, true, () => false)
  try {
    rescue.afterWind({ fired: true }); attempt(f)
    for (let i = 0; i < 100; i++) {
      const pk = { ...f.packet, entityId: 99 }
      f.a._client.emit('packet', pk, { name: 'damage_event' }, Buffer.from([1, 2, 3]))
      f.a._client.emit('damage_event', pk)
    }
    f.a._client.emit('entity_status', { entityId: 3, entityStatus: 3 })
    f.arrive(); await rescue.settle()
    assert.equal(rescue.trace.firstSmash, null)
    assert.ok(rescue.trace.rawDamage26.length > 0 && rescue.trace.rawDamage26.length <= 32)
    assert.ok(rescue.trace.cueRejects.length > 0 && rescue.trace.cueRejects.length <= 32)
    assert.equal(rescue.trace.cueRejects[0].why, 'wrong_target')
  } finally { await rescue.close() }
})

test('sham takes the same diagonal walk and placement stage but passes disabled water activation', async () => {
  const original = hands.waterCatch
  hands.waterCatch = async (_a, _b, _cell, _ctl, enabled) => ({ sent: enabled, waterObserved: enabled, why: enabled ? 'water_observed' : 'sham' })
  try {
    for (const enabled of [false, true]) {
      const f = fixture(), rescue = startWaterRescue(f.a, f.b, f.t, enabled, () => false)
      try {
        rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
        f.arrive(); await rescue.settle()
        assert.equal(rescue.trace.walk.arrived, true)
        assert.equal(rescue.trace.secondPlace.sent, enabled)
        assert.equal(rescue.trace.secondPlace.why, enabled ? 'water_observed' : 'sham')
      } finally { await rescue.close() }
    }
  } finally { hands.waterCatch = original }
})

test('STOP joins pending placement and leaves no movement or listeners for the next fixture', async () => {
  const f = fixture(), original = hands.waterCatch
  let stopped = false, finished = false
  hands.waterCatch = async (_a, _b, _cell, ctl) => {
    await pause(); finished = true
    return { sent: false, waterObserved: false, why: ctl.aborted ? 'cancelled' : 'wrongly_live' }
  }
  const rescue = startWaterRescue(f.a, f.b, f.t, true, () => stopped)
  try {
    rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet); f.arrive()
    await pause(); stopped = true; await rescue.close()
    assert.equal(finished, true); assert.equal(rescue.trace.secondPlace.why, 'cancelled')
    assert.equal(f.a.controls.forward, false)
    assert.equal(f.a._client.listenerCount('damage_event'), 0)
    assert.equal(f.b.listenerCount('physicsTick'), 0)
    f.a.emit('physicsTick'); assert.equal(f.a.controls.forward, false)
  } finally { await rescue.close(); hands.waterCatch = original }
})

test('walking stops before placement and waits for native horizontal velocity to settle to zero in both arms', async () => {
  const original = hands.waterCatch
  let placements = 0
  hands.waterCatch = async (a, _b, _cell, _ctl, enabled) => {
    assert.equal(a.controls.forward, false)
    assert.equal(a.entity.velocity.x, 0); assert.equal(a.entity.velocity.z, 0)
    placements++
    return { sent: enabled, waterObserved: enabled, why: enabled ? 'water_observed' : 'sham' }
  }
  try {
    for (const enabled of [false, true]) {
      const f = fixture(), before = placements, rescue = startWaterRescue(f.a, f.b, f.t, enabled, () => false)
      try {
        rescue.afterWind({ fired: true }); f.a._client.emit('damage_event', f.packet)
        f.a.entity.velocity.x = .01; f.arrive(); await pause()
        assert.equal(placements, before); assert.equal(f.a.controls.forward, false)
        f.a.entity.velocity.x = 0; f.a.emit('physicsTick'); await rescue.settle()
        assert.equal(placements, before + 1); assert.equal(rescue.trace.walk.settled, true)
        assert.ok(rescue.trace.walk.settleTicks > 0)
      } finally { await rescue.close() }
    }
  } finally { hands.waterCatch = original }
})

test('both rescue arms sprint along the same route and release sprint before settling', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), rescue = startWaterRescue(f.a, f.b, f.t, enabled, () => false)
    try {
      rescue.afterWind({ fired: true }); await Promise.resolve()
      assert.equal(f.a.controls.forward, true); assert.equal(f.a.controls.sprint, true)
      assert.equal(rescue.trace.walk.locomotion, 'sprint')
      f.arrive(); await rescue.settle()
      assert.equal(f.a.controls.forward, false); assert.equal(f.a.controls.sprint, false)
      assert.equal(rescue.trace.walk.settled, true)
    } finally { await rescue.close() }
    assert.equal(f.a.controls.sprint, false)
  }
})

test('a first-life ally death remains cancelled after respawn and a refused first wind never starts walking', async () => {
  const f = fixture(), rescue = startWaterRescue(f.a, f.b, f.t, true, () => false)
  rescue.afterWind({ fired: false }); await rescue.settle()
  assert.equal(rescue.trace.walk, null)
  await rescue.close()
  const next = startWaterRescue(f.a, f.b, f.t, true, () => false)
  next.afterWind({ fired: true }); f.b.emit('death'); f.b.health = 20
  f.a._client.emit('damage_event', f.packet); await next.close()
  assert.equal(next.trace.firstSmash, null); assert.equal(f.a.controls.forward, false)
})
