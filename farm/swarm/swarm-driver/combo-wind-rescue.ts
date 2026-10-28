import * as pick from '../../../daemon/src/pick'

const point = (p: any) => ({ x: p.x, y: p.y, z: p.z })
const pause = () => new Promise(resolve => setTimeout(resolve, 10))

/** Native air order: move, then gravity and float32 drag. Horizontal input is unknown. */
export function projectFall(position: any, velocity: any, ticks: number) {
  const p = point(position); let vy = velocity.y
  for (let tick = 0; tick < ticks; tick++) {
    p.x += velocity.x; p.y += vy; p.z += velocity.z
    vy = (vy - .08) * Math.fround(.98)
  }
  return p
}

/** C1 defaults keep ordinary linear windAt; laboratory candidates may inject only the second launcher. */
export function startWindRescue(a: any, b: any, t: any, enabled: boolean, stop: () => boolean, t0 = Date.now(),
  postSmash?: (baseline: any) => (receipt: any, trackedVelocity: any) => any,
  secondLauncher?: (bot: any, target: any, options: any) => Promise<any>) {
  const air: typeof import('../../../daemon/src/swarm/combos/air-ideas') = require('../../../daemon/src/swarm/combos/air-ideas')
  const track: typeof import('../../../daemon/src/bow/track') = require('../../../daemon/src/bow/track')
  const { windLaunch }: typeof import('../../../daemon/src/combat/team-wind') = require('../../../daemon/src/combat/team-wind')
  const ownA = a.entity, ownB = b.entity, targetId = t.entity.id
  const remote = actor => a.players?.[actor.username]?.entity ?? a.entities?.[actor.entity?.id]
  const bodyLife = remote(b), targetLife = remote(t)
  let closed = false, dead = false, armed = false, ticks = 0, sending = false
  let job: Promise<void> = Promise.resolve()
  const trace: any = { enabled, t0, policy: postSmash ? 'C2a_strict_postcue_arc_linear_wind' : 'C1_distinctY56_stationary_linear_wind_after_attributed26',
    firstWind: null, firstSmash: null, secondWind: null, gate: null, samples: [], cueRejects: [], landing: null }
  const ctl = { get aborted() { return closed || dead || stop() || a.entity !== ownA || b.entity !== ownB || !(a.health > 0) || !(b.health > 0) } }
  const visibleBody = () => {
    const body = remote(b)
    return body === bodyLife && body?.isValid !== false && pick.canHit(a, body, { range: 32 }) ? body : null
  }
  const count = () => { ticks++ }
  const died = () => { dead = true }
  const landed = () => {
    if (trace.firstSmash && !trace.landing && (b.entity.onGround || b.entity.isInWater))
      trace.landing = { ms: Date.now(), position: point(b.entity.position), ownHp: b.health }
  }
  const knownFloor = (p: any) => {
    // Look only for the exposed surface at our known ground level, not a downward hidden-block scan.
    const cell = a.entity.position.clone(); cell.set(Math.floor(p.x), Math.floor(a.entity.position.y) - 1, Math.floor(p.z))
    const block = a.blockAt(cell, false)
    if (!block || block.boundingBox !== 'block' || !block.shapes?.length) return null
    const avoid = Object.values<any>(a.entities ?? {}).filter(entity => entity !== a.entity && entity.position &&
      (entity.username || entity.type === 'player' || entity.type === 'mob') && pick.canHit(a, entity, { range: 32 }))
    const face = pick.faceAim(a, cell, { x: 0, y: 1, z: 0 }, { range: 32, avoid })
    return face ? { cell: point(cell), name: block.name, top: face.y, exposedTop: point(face) } : null
  }
  const sample = (observe?: (receipt: any, trackedVelocity: any) => any) => {
    const body = visibleBody()
    if (!body) return { ms: Date.now(), why: 'body_unseen' }
    const receipt = body._ndPositionReceipts?.[1], trackedVelocity = track.observedVelocity(body)
    const observation = observe?.(receipt, trackedVelocity), velocity = observe ? observation?.velocity : trackedVelocity
    const confidence = observe ? observation?.confidence === true : track.hasObservedVelocity(body)
    const extra = observe ? { observation, trackerVelocity: { ...trackedVelocity } } : {}
    if (!receipt || !velocity || !confidence || ![velocity.x, velocity.y, velocity.z, velocity.ageTicks].every(Number.isFinite) ||
      velocity.ageTicks < 0 || velocity.ageTicks > 1.5 || body.onGround !== false || velocity.y >= 0)
      return { ms: Date.now(), why: 'body_motion_unknown', receipt: receipt ? { ...receipt } : null, ...extra }
    const from = pick.eyeOf(a), moved = a.entity.velocity.clone(); if (a.entity.onGround) moved.y = 0
    const shot = windLaunch(from, body.position.offset(0, .3, 0), moved)
    if (!shot) return { ms: Date.now(), why: 'no_flight_estimate' }
    const horizonTicks = 3 + Math.ceil(shot.time), projected = projectFall(body.position, velocity, horizonTicks), floor = knownFloor(projected)
    const height = floor ? projected.y - floor.top : null
    return { ms: Date.now(), why: !floor ? 'unknown_floor' : height! < .5 ? 'too_late' : height! > 2.5 ? 'too_early' : 'ready',
      receipt: { t: receipt.t, kind: receipt.kind, x: receipt.x, y: receipt.y, z: receipt.z },
      position: point(body.position), velocity: { ...velocity }, confidence, flightTicks: shot.time, horizonTicks, projected, floor, height, ...extra }
  }
  const second = async () => {
    const original = a.activateItem, hadCd = Object.hasOwn(a, '_ndWindCd'), priorCd = a._ndWindCd
    let attempts = 0
    const activate = function (this: any, ...args: any[]) { attempts++; if (enabled) return Reflect.apply(original, this, args) }
    a.activateItem = activate; sending = true
    const wallTimer = setTimeout(() => {
      if (sending) { trace.error = 'second_wind_wall_cap'; closed = true; a.quit('wind rescue stalled tick wait') }
    }, 2000)
    try {
      const value = await (secondLauncher ?? air.windAt)(a, visibleBody(), { ctl, allowAlly: true, allyHealth: () => b.health,
        // The narrow timing window is a one-time launch decision; it naturally changes during preparation.
        allySafe: () => !ctl.aborted && b.health > 1 && !!visibleBody() && bodyLife.onGround === false && !!knownFloor(bodyLife.position) })
      trace.secondWind = { ...value, fired: enabled && attempts > 0 && value.fired, attempted: value.fired,
        sham: !enabled, ...(value.fired && !enabled ? { why: 'sham_no_second_use' } : {}), activationAttempts: attempts }
    } finally {
      clearTimeout(wallTimer)
      sending = false
      if (a.activateItem === activate) a.activateItem = original
      if (!enabled) { if (hadCd) a._ndWindCd = priorCd; else delete a._ndWindCd }
      trace.wrapperRestored = a.activateItem === original
    }
  }
  const cue = packet => {
    const enemy = remote(t)
    const why = !armed ? 'not_armed' : ctl.aborted ? 'cancelled' : trace.firstSmash ? 'already_cued' :
      packet.entityId !== targetId ? 'wrong_target' : packet.sourceTypeId !== 26 ? 'wrong_type' :
      packet.sourceCauseId !== ownB.id + 1 || packet.sourceDirectId !== ownB.id + 1 ? 'wrong_cause' :
      enemy !== targetLife || enemy?.isValid === false || !pick.canHit(a, enemy, { range: 32 }) ? 'target_unseen_or_new_life' : null
    if (why) { if (trace.cueRejects.length < 32) trace.cueRejects.push({ ms: Date.now(), why, packet: { ...packet } }); return }
    const body = visibleBody(), baseline = body?._ndPositionReceipts?.[1]
    trace.firstSmash = { ms: Date.now(), packet: { ...packet }, visibleTarget: point(enemy.position),
      baseline: baseline ? { ...baseline } : null }
    job = (async () => {
      if (!body || !baseline) { trace.secondWind = { fired: false, why: 'body_baseline_unknown' }; return }
      const observe = postSmash?.(baseline)
      const started = Date.now(), firstTick = ticks, seen = new Set<string>(), positions = new Set<string>()
      const baselineKey = JSON.stringify([baseline.t, baseline.kind, baseline.x, baseline.y, baseline.z])
      while (!ctl.aborted && Date.now() - started < 2000 && ticks - firstTick < 40) {
        const current: any = sample(observe), receipt = current.receipt
        if (receipt) {
          const key = JSON.stringify([receipt.t, receipt.kind, receipt.x, receipt.y, receipt.z])
          if (key !== baselineKey) {
            seen.add(key)
            if (Number.isFinite(receipt.y) && receipt.y !== baseline.y) positions.add(receipt.y)
          }
        }
        current.newReceiptCount = seen.size
        current.distinctPostCueY = positions.size
        if (trace.samples.length < 64) trace.samples.push(current)
        if (positions.size >= 2 && current.why === 'ready') { trace.gate = current; await second(); return }
        if (current.why === 'too_late' && positions.size >= 2) { trace.secondWind = { fired: false, why: 'timing_window_passed' }; return }
        await pause()
      }
      trace.secondWind = { fired: false, why: ctl.aborted ? 'cancelled' : 'body_observation_timeout' }
    })().catch(error => { trace.error = String(error); trace.secondWind = { fired: false, why: 'action_error', error: String(error) } })
  }
  a._client.on('damage_event', cue); a.on('physicsTick', count); b.on('physicsTick', landed)
  for (const actor of [a, b]) for (const event of ['death', 'end', 'respawn']) actor.on(event, died)
  const settle = async () => { await job }
  return { trace, afterWind(wind: any) {
    if (trace.firstWind || closed) return
    trace.firstWind = { ms: Date.now(), fired: wind.fired === true }; armed = wind.fired === true && !ctl.aborted
  }, settle, async close() {
    closed = true
    a._client.removeListener('damage_event', cue); a.removeListener('physicsTick', count); b.removeListener('physicsTick', landed)
    for (const actor of [a, b]) for (const event of ['death', 'end', 'respawn']) actor.removeListener(event, died)
    // End only this owned client if an existing tick wait cannot join after cancellation.
    const timer = setTimeout(() => { if (sending) { trace.error = 'second_wind_join_stalled'; a.quit('wind rescue stalled tick wait') } }, 500)
    try { await settle() } finally { clearTimeout(timer); trace.closedAt = Date.now() }
  } }
}

if (require.main === module) {
  const [pairs = '3', hp = '100', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20 || !['20', '100'].includes(hp)) throw new Error('combo-wind-rescue [pairs=3:1..20] [hp=100:20|100]')
  require('./combo-anvil').apexTrials(false, +pairs, +hp, 'wind').then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
