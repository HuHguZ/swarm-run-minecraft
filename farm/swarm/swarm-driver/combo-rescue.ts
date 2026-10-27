import * as pick from '../../../daemon/src/pick'

const point = (v: any) => ({ x: v.x, y: v.y, z: v.z })
const pause = () => new Promise(resolve => setTimeout(resolve, 10))

// Read only the LP scale/header. XYZ remains owned by the existing native decoder.
function motionHeader(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes)) return null
  let offset = 0
  const vint = () => {
    let value = 0
    for (let i = 0; i < 5 && offset < bytes.length; i++) {
      const byte = bytes[offset++]; value += (byte & 127) * 2 ** (i * 7)
      if (!(byte & 128)) return value <= 0x7fffffff ? value : null
    }
    return null
  }
  if (vint() === null) return null // packet ID
  const entityId = vint(), first = bytes[offset]
  if (entityId === null || !first || offset + 6 > bytes.length) return null
  let scale = first & 3
  if (first & 4) { offset += 6; const high = vint(); if (high === null) return null; scale += high * 4 }
  return Number.isSafeInteger(scale) && scale > 0 ? { entityId, scale } : null
}

/** Fixture controller only: the water helper owns item, ray and packet-time guards. */
export function startWaterRescue(a: any, b: any, t: any, enabled: boolean, stop: () => boolean, t0 = Date.now(), damageCue = true) {
  const { waterCatch }: typeof import('../../../daemon/src/swarm/combos/landing-rescue') = require('../../../daemon/src/swarm/combos/landing-rescue')
  const { velocityFromRaw }: typeof import('../../../daemon/src/drops') = require('../../../daemon/src/drops')
  const cell = { x: 600, y: 151, z: 597 }, destination = { x: 601.5, y: 151, z: 601 }
  const supportLife = a.entity, bodyLife = b.entity, targetId = t.entity?.id
  const remote = (actor: any) => a.players?.[actor.username]?.entity ?? a.entities?.[actor.entity?.id]
  const targetLife = remote(t), originalAttack = b.attack
  const body = () => b.entity ? ({ position: point(b.entity.position), velocity: point(b.entity.velocity),
    onGround: b.entity.onGround, inWater: !!b.entity.isInWater, ownHp: b.health }) : null
  const trace: any = { enabled, t0, cuePolicy: damageCue ? 'standard' : 'motion_only_control', cell, destination, prepare: { ms: Date.now(), support: point(a.entity.position), body: body() },
    firstWind: null, walk: null, firstSmash: null, secondPlace: null, landing: null, rayClearAtPacket: null,
    attackAttempts: [], rawVelocity: [], rawDamage26: [], cueRejects: [] }
  const bounded = (rows: any[], row: any) => { if (rows.length < 32) rows.push(row) }
  const bytesOf = (bytes: any) => Buffer.isBuffer(bytes) ? { bytesHex: bytes.subarray(0, 64).toString('hex'), byteLength: bytes.length } : { bytesHex: null, byteLength: null }
  let closed = false, dead = false, armed = false, ticks = 0, bodyTicks = 0, targetEpoch = 0, pending: any = null
  let walkJob = Promise.resolve(), catchJob = Promise.resolve()
  const ctl = { get aborted() { return closed || dead || stop() || a.entity !== supportLife || b.entity !== bodyLife || !(a.health > 0) || !(b.health > 0) } }
  const clear = () => { a.setControlState('forward', false); a.setControlState('sprint', false) }
  const died = () => { dead = true; pending = null; clear() }
  const count = () => { ticks++ }
  const landed = () => {
    bodyTicks++
    if (b.entity.onGround || b.entity.isInWater) pending = null
    if (trace.firstSmash && !trace.landing && (b.entity.onGround || b.entity.isInWater))
      trace.landing = { ms: Date.now(), ...body() }
  }
  const targetChanged = (entity: any) => { if (entity?.id === targetId) { targetEpoch++; pending = null } }
  const walk = async () => {
    const start = Date.now(), firstTick = ticks
    trace.walk = { locomotion: 'sprint', startedAt: start, arrived: false, settled: false, actualEnd: point(a.entity.position) }
    try {
      while (!ctl.aborted && Date.now() - start < 3000 && ticks - firstTick < 60) {
        const dx = destination.x - a.entity.position.x, dz = destination.z - a.entity.position.z
        if (Math.hypot(dx, dz) <= .15) { trace.walk.arrived = true; break }
        await a.look(Math.atan2(-dx, -dz), 0, true)
        if (ctl.aborted) break
        a.setControlState('sprint', true); a.setControlState('forward', true)
        await pause()
      }
      clear()
      const stoppedAt = Date.now(), stoppedTick = ticks
      trace.walk.stoppedAt = stoppedAt; trace.walk.velocityOnStop = point(a.entity.velocity)
      // Let unchanged native physics remove residual walking; never overwrite velocity/pose.
      while (!ctl.aborted && trace.walk.arrived && Date.now() - stoppedAt < 800 && ticks - stoppedTick < 12 &&
        (a.entity.velocity.x !== 0 || a.entity.velocity.z !== 0)) await pause()
      trace.walk.settled = !ctl.aborted && trace.walk.arrived && a.entity.velocity.x === 0 && a.entity.velocity.z === 0
      trace.walk.settleTicks = ticks - stoppedTick; trace.walk.velocityAfterSettle = point(a.entity.velocity)
      trace.walk.why = ctl.aborted ? 'cancelled' : !trace.walk.arrived ? 'walk_timeout' : !trace.walk.settled ? 'settle_timeout' : 'arrived'
    } finally { clear(); trace.walk.endedAt = Date.now(); trace.walk.actualEnd = point(a.entity.position) }
  }
  const accept = (receipt: any, enemy: any) => {
    pending = null
    trace.firstSmash = { ms: Date.now(), ...receipt, visibleTarget: point(enemy.position), body: body() }
    catchJob = (async () => {
      await walkJob
      if (ctl.aborted || !trace.walk?.settled) {
        trace.secondPlace = { sent: false, waterObserved: false, why: ctl.aborted ? 'cancelled' : trace.walk?.why ?? 'not_walking' }
        return
      }
      trace.placementFrom = point(pick.eyeOf(a))
      trace.secondPlace = await waterCatch(a, remote(b), cell, ctl, enabled)
      trace.rayClearAtPacket = trace.secondPlace.sent || trace.secondPlace.why === 'sham' ? true : null
    })().catch(error => { trace.error = String(error) })
  }
  const visibleTarget = () => {
    const enemy = remote(t)
    return enemy === targetLife && enemy?.isValid !== false && enemy?.position && pick.canHit(a, enemy, { range: 32 }) ? enemy : null
  }
  const cue = (packet: any) => {
    const why = !damageCue && packet.sourceTypeId === 26 ? 'primary_disabled_control' :
      !armed ? 'not_armed' : ctl.aborted ? 'cancelled' : trace.firstSmash ? 'already_cued' :
      packet.entityId !== targetId ? 'wrong_target' : packet.sourceTypeId !== 26 ? 'wrong_type' :
      packet.sourceCauseId !== bodyLife.id + 1 || packet.sourceDirectId !== bodyLife.id + 1 ? 'wrong_cause' :
      !visibleTarget() ? 'target_unseen_or_new_life' : null
    if (why) { bounded(trace.cueRejects, { ms: Date.now(), kind: 'damage_event', why, packet: { ...packet } }); return }
    accept({ cueKind: 'attributed_damage26', targetAttribution: 'damage_event_target_and_cause', packet: { ...packet } }, visibleTarget())
  }
  const rawDamage = (packet: any, meta: any, bytes: any) => {
    if (meta?.name === 'damage_event' && packet?.sourceTypeId === 26)
      bounded(trace.rawDamage26, { ms: Date.now(), packet: { ...packet }, ...bytesOf(bytes) })
  }
  const attack = function (this: any, ...args: any[]) {
    pending = null
    const enemy = args[0], ms = Date.now(), blocked = b._ndBlockedHits || 0
    let why = !armed ? 'not_armed' : ctl.aborted ? 'cancelled' : trace.firstSmash ? 'already_cued' :
      enemy?.id !== targetId ? 'wrong_target' : b.heldItem?.name !== 'mace' ? 'not_mace' :
      b.entity.onGround || b.entity.isInWater || !(b.entity.velocity.y < 0) ? 'not_descending' : null
    if (!why) { try { if (!pick.canHit(b, enemy)) why = 'pick_blocked' } catch { why = 'pick_unavailable' } }
    const before = body(), result = Reflect.apply(originalAttack, this, args)
    if ((b._ndBlockedHits || 0) !== blocked) why = 'attack_blocked'
    const observed = { ms, tick: bodyTicks, targetId: enemy?.id, held: b.heldItem?.name, before, why }
    bounded(trace.attackAttempts, observed)
    if (!why) pending = { ...observed, epoch: targetEpoch, enemy, record: observed }
    return result
  }
  const motion = (packet: any, meta: any, bytes: any) => {
    if (meta?.name !== 'entity_velocity') return
    const velocity = velocityFromRaw(bytes, 'velocity'), header = motionHeader(bytes)
    // MaceItem.hurtEnemy sets Y to float .01, then sends native LPVec3. LpVec3.pack
    // rounds ((component/scale*.5+.5)*32766); compare that exact bin, without a fitted epsilon.
    const expectedY = header ? (Math.min(Math.round((Math.fround(.01) / header.scale * .5 + .5) * 32766), 32766) * 2 / 32766 - 1) * header.scale : null
    const enemy = visibleTarget()
    // 500 ms / 10 body ticks is this prototype's attribution window, not a physical smash threshold.
    const why = packet?.entityId !== bodyLife.id ? 'wrong_entity' : !header || !velocity ? 'malformed_motion' :
      header.entityId !== packet.entityId ? 'raw_entity_mismatch' : !armed || !pending ? 'no_pending_attempt' :
      ctl.aborted ? 'cancelled' : trace.firstSmash ? 'already_cued' :
      Date.now() - pending.ms > 500 || bodyTicks - pending.tick > 10 ? 'attempt_expired' :
      pending.epoch !== targetEpoch || b.entities?.[targetId] !== pending.enemy || !enemy ? 'target_unseen_or_new_life' :
      b.heldItem?.name !== 'mace' ? 'not_mace' : b.entity.onGround || b.entity.isInWater ? 'already_landed' :
      !(expectedY > 0) || velocity.y !== expectedY ? 'not_smash_motion_bin' : null
    bounded(trace.rawVelocity, { ms: Date.now(), entityId: packet?.entityId, velocity, scale: header?.scale ?? null,
      expectedY, why, ...bytesOf(bytes) })
    if (why) return
    accept({ cueKind: 'motion_post_mace_attempt', targetAttribution: 'unknown_motion_has_no_target',
      motion: { velocity, scale: header.scale, expectedY }, attempt: pending.record }, enemy)
  }
  b.attack = attack
  a._client.on('damage_event', cue); a.on('physicsTick', count); b.on('physicsTick', landed)
  a._client.on('packet', rawDamage); b._client.on('packet', motion)
  a.on('entityGone', targetChanged); a.on('entitySpawn', targetChanged)
  for (const actor of [a, b]) { actor.on('death', died); actor.on('end', died); actor.on('respawn', died) }
  const settle = async () => { await walkJob; await catchJob }
  return { trace, afterWind(wind: any) {
    if (trace.firstWind !== null || closed) return
    trace.firstWind = { ms: Date.now(), fired: wind.fired === true }
    if (!wind.fired || ctl.aborted) return
    armed = true
    walkJob = walk().catch(error => { trace.error = String(error) })
  }, settle, async close() {
    closed = true; pending = null; clear()
    if (b.attack === attack) b.attack = originalAttack
    a._client.removeListener('damage_event', cue); a.removeListener('physicsTick', count); b.removeListener('physicsTick', landed)
    a._client.removeListener('packet', rawDamage); b._client.removeListener('packet', motion)
    a.removeListener('entityGone', targetChanged); a.removeListener('entitySpawn', targetChanged)
    for (const actor of [a, b]) { actor.removeListener('death', died); actor.removeListener('end', died); actor.removeListener('respawn', died) }
    await settle()
    trace.closedAt = Date.now(); trace.supportEnd = point(a.entity.position)
  } }
}
