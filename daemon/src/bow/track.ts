'use strict'
// Лук (bow.ts): цель — упреждение, наблюдаемая скорость по нативным пакетам позиции (падение, планирование), трасса прицела.
import * as gameClock from '../game-clock'
import * as pick from '../pick'

// Цель с упреждением: скорость по двум последним позициям. Высота точки —
// середина туловища (0.55 роста): туда стрела ложится при любой ошибке по
// высоте в пределах полблока.
function leadTarget (entity, velFn, bot = null, frac = .55) {
  const sky: typeof import('../elytra') = require('../elytra')
  return (ticks) => {
    const v = velFn ? velFn() : observedVelocity(entity)
    ticks += v.ageTicks || 0
    const flying = sky.gliding(entity)
    const p = flying ? sky.predictGlider(entity, v, ticks) : entity.position.offset(v.x * ticks, 0, v.z * ticks)
    if (!flying && entity.onGround === false) {
      // travelInAir: move, then (v.y - gravity) * .98f. Horizontal input
      // is unknown: ponytail: keep observed strafe, re-aim every server tick.
      const slowFall = bot?.registry?.effectsByName?.slow_falling?.id
      const gravity = slowFall !== undefined && entity.effects?.[slowFall] && v.y <= 0 ? .01 : .08
      const drag = Math.fround(.98)
      const n = Math.floor(ticks)
      const sum = (1 - drag ** n) / (1 - drag)
      p.y += v.y * sum - gravity * drag * (n - sum) / (1 - drag)
      p.y += (ticks - n) * (v.y * drag ** n - gravity * drag * (1 - drag ** n) / (1 - drag))
      if (bot) {
        const floor = sky.worldOf(bot).floorBelow(p.x, entity.position.y, p.z, Math.ceil(entity.position.y - p.y) + 2)
        if (floor && !floor.lava && !floor.water) p.y = Math.max(p.y, floor.top)
      }
    }
    const height = bot ? pick.hitboxOf(bot, entity).h : flying ? .6 : (entity.height || 1.8)
    return p.offset(0, height * frac, 0)
  }
}

// Use the last actual entity movement update: a 12-tick average kept aiming
// along the old strafe after a turn. Convert falling displacement to the next
// native velocity, because the measured displacement precedes gravity/drag.
function traceTarget (target, observation) {
  observation.calls = 0; observation.targetMs = 0
  return ticks => {
    const start = gameClock.wall.monotonic()
    const result = target(ticks)
    observation.targetMs += gameClock.wall.monotonic() - start
    observation.calls++
    return result
  }
}

const targetTrackers = new WeakMap()
// Native relative coordinates are quantized to 1/4096. Fit two displacements
// without assuming a launch height, start velocity, or fall phase. Use a count
// only when every compatible interval pair agrees on the final interval.
const fallIntervals = Array.from({ length: 10 }, (_, i) => {
  const ticks = i + 1; const d = Math.fround(.98); const drag = d ** ticks
  const sum = (1 - drag) / (1 - d)
  return { ticks, drag, sum, loss: .08 * d * (ticks - sum) / (1 - d) }
})
function observedFallTicks(previous, current) {
  // The same native gravity/drag inverse applies while rising and across the apex.
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null
  let count = null
  for (const first of fallIntervals) {
    const end = (previous + first.loss) / first.sum * first.drag - .08 * Math.fround(.98) * first.sum
    for (const last of fallIntervals) {
      const tolerance = (1 + first.drag * last.sum / first.sum) / 4096
      if (Math.abs(end * last.sum - last.loss - current) > tolerance) continue
      if (count !== null && count !== last.ticks) return null
      count = last.ticks
    }
  }
  return count
}
let levelGlideIntervals
function observedGlideVelocity(previous, current, yaw, pitch) {
  // At zero pitch vertical motion is a monotone piecewise affine map, independent
  // of horizontal speed. Other pitches are not promoted by this bounded inverse.
  if (pitch !== 0 || !Number.isFinite(yaw) || !['x', 'y', 'z'].every(a => Number.isFinite(previous[a]) && Number.isFinite(current[a]))) return null
  const sky: typeof import('../elytra') = require('../elytra')
  if (!levelGlideIntervals) {
    const nextY = y => { const p = { x: 0, y: 0, z: 0 }; const v = { x: 0, y, z: 0 }; sky.glideStep(p, v, 0, 0, false); return v.y }
    const down = nextY(-1) - nextY(-2); const downLoss = nextY(-1) + down
    const up = nextY(2) - nextY(1); const upLoss = nextY(1) - up
    const boundary = n => -upLoss * (1 - up ** n) / (1 - up) / up ** n
    levelGlideIntervals = fallIntervals.map(({ ticks }) => {
      const parts = []
      for (let positive = 0; positive <= ticks; positive++) {
        let a = 1; let b = 0; let sum = 0; let loss = 0
        for (let i = 0; i < ticks; i++) {
          const drag = i < positive ? up : down
          a *= drag; b = b * drag + (i < positive ? upLoss : downLoss)
          sum += a; loss += b
        }
        parts.push({ lo: positive ? boundary(positive) : -Infinity, hi: positive < ticks ? boundary(positive + 1) : Infinity, a, b, sum, loss })
      }
      const p = { x: 0, y: 0, z: 0 }; const v = { x: 1, y: 0, z: 0 }
      for (let i = 0; i < ticks; i++) sky.glideStep(p, v, 0, 0, false)
      return { ticks, parts, perpendicular: p.x }
    })
  }
  const inverseY = (interval, displacement) => {
    for (const part of interval.parts) {
      const start = (displacement - part.loss) / part.sum
      if (start >= part.lo && start <= part.hi) return { start, end: start * part.a + part.b }
    }
    return null
  }
  const displacementY = (interval, start) => {
    const part = interval.parts.find(p => start >= p.lo && start <= p.hi)
    return start * part.sum + part.loss
  }
  const q = 1 / 4096
  let interval = null
  for (const first of levelGlideIntervals) {
    const lo = inverseY(first, previous.y - q); const hi = inverseY(first, previous.y + q)
    for (const last of levelGlideIntervals) {
      if (current.y + q < displacementY(last, lo.end) || current.y - q > displacementY(last, hi.end)) continue
      if (interval && interval !== last) return null
      interval = last
    }
  }
  if (!interval) return null
  const vertical = inverseY(interval, current.y)
  const look = sky.lookVec(yaw, 0); const sideways = { x: -look.z, z: look.x }
  const perpendicular = (current.x * sideways.x + current.z * sideways.z) / interval.perpendicular
  const wanted = current.x * look.x + current.z * look.z
  const run = forward => {
    const p = { x: 0, y: 0, z: 0 }
    const v = { x: look.x * forward + sideways.x * perpendicular, y: vertical.start, z: look.z * forward + sideways.z * perpendicular }
    for (let i = 0; i < interval.ticks; i++) sky.glideStep(p, v, yaw, 0, false)
    return { p, v, forward: p.x * look.x + p.z * look.z }
  }
  // The parallel map is strictly increasing: its derivative is drag*(.9+.1*v/|v|).
  // Perpendicular motion is linear and already inverted above, so one bracketed
  // root is the unique velocity for this count, including crosswise movement.
  let span = Math.abs(wanted) + Math.abs(current.y) + Math.abs(perpendicular) + 1
  for (let i = 0; i < 16 && (run(-span).forward > wanted || run(span).forward < wanted); i++) span *= 2
  if (run(-span).forward > wanted || run(span).forward < wanted) return null
  let lo = -span; let hi = span
  for (let i = 0; i < 35; i++) { const mid = (lo + hi) / 2; if (run(mid).forward < wanted) lo = mid; else hi = mid }
  const result = run((lo + hi) / 2)
  return ['x', 'y', 'z'].every(a => Math.abs(result.p[a] - current[a]) <= q) ? result.v : null
}
function observedVelocity (entity) {
  return entity._ndPositionReceipts ? trackTarget(entity).vel() : entity.velocity || { x: 0, y: 0, z: 0 }
}
function hasObservedVelocity (entity) {
  return entity.onGround !== false || !entity._ndPositionReceipts?.[1]?.kind || trackTarget(entity).hasVelocity()
}
function trackTarget (entity, nowOf = null) {
  const receipts = nowOf === null
  if (receipts && targetTrackers.has(entity)) return targetTrackers.get(entity)
  nowOf ||= () => entity._ndObservationNow?.() ?? gameClock.observationNow()
  let last = null
  let velocity = { x: 0, y: 0, z: 0 }
  let velocityMeasured = false
  let lastReceipt = null
  let groundPath = 0
  let groundSamples = []
  let airSamples = []
  let fallDelta = null
  let glideDelta = null
  let flying = (require('../elytra') as typeof import('../elytra')).gliding(entity)
  let yaw = entity.yaw; let pitch = entity.pitch; let boosted = !!entity._ndGlideBoosted
  let revision = entity._ndGlideRevision || 0
  let phasePending = false
  const update = () => {
    const p = entity.position
    const receipt = receipts ? entity._ndPositionReceipts?.[1] : null
    const now = receipt?.t ?? nowOf()
    const freshReceipt = receipt && receipt !== lastReceipt
    if (freshReceipt) lastReceipt = receipt
    const relative = receipt?.kind === 'rel_entity_move' || receipt?.kind === 'entity_move_look'
    const nextFlying = (require('../elytra') as typeof import('../elytra')).gliding(entity)
    // A steering glider changes look every receipt: that cancels the physical endpoint fit and its confidence, but
    // the positional estimate stays (try-lance 23.10: a full rebaseline kept a steering glider's velocity at 0 —
    // the lance aimed at where it was, 0.02 hits per pass on a turning target).
    const steered = receipts && receipt?.kind && nextFlying === flying && nextFlying &&
      (entity.yaw !== yaw || entity.pitch !== pitch || !!entity._ndGlideBoosted !== boosted || (entity._ndGlideRevision || 0) !== revision)
    if (steered && process.env.ND_GLIDE_KEEP !== '0') {
      yaw = entity.yaw; pitch = entity.pitch; boosted = !!entity._ndGlideBoosted; revision = entity._ndGlideRevision || 0
      velocityMeasured = false; glideDelta = null
    } else if (receipts && receipt?.kind && (nextFlying !== flying || steered)) {
      // A motion change can straddle the last old-phase step (Air35).
      // Rebaseline it; a fresh zero displacement remains a measured stop.
      flying = nextFlying; yaw = entity.yaw; pitch = entity.pitch; boosted = !!entity._ndGlideBoosted; revision = entity._ndGlideRevision || 0; phasePending = true
      velocity = { x: 0, y: 0, z: 0 }; velocityMeasured = false; groundPath = 0; groundSamples = []; airSamples = []; fallDelta = null; glideDelta = null
    }
    if (phasePending && relative && freshReceipt) {
      phasePending = false
      if (!last || p.x !== last.x || p.y !== last.y || p.z !== last.z) {
        last = { x: p.x, y: p.y, z: p.z, t: now, grounded: entity.onGround === true }
        return
      }
    }
    // Absolute synchronization can be a teleport outside the entity tracker
    // cadence. Its fresh position starts a new baseline, rather than a speed.
    if (last && freshReceipt && receipt?.kind && !relative) {
      last = null; velocity = { x: 0, y: 0, z: 0 }; velocityMeasured = false; groundPath = 0; groundSamples = []; airSamples = []; fallDelta = null; glideDelta = null
    }
    // A native age packet can correct extrapolated observation time backward.
    // Start from its fresh position instead of ignoring moves until catch-up.
    if (last && now < last.t) {
      last = null; velocity = { x: 0, y: 0, z: 0 }; velocityMeasured = false; groundPath = 0; groundSamples = []; airSamples = []; fallDelta = null; glideDelta = null
    }
    if (last && p.x === last.x && p.y === last.y && p.z === last.z) {
      if ((relative && freshReceipt) || (receipts && entity._ndPositionReceipts && now > last.t)) {
        velocity = { x: 0, y: 0, z: 0 }; last.t = now
        velocityMeasured = !!(relative && freshReceipt)
        groundPath = 0; groundSamples = entity.onGround === true ? [{ t: now, path: 0 }] : []
        airSamples = []; fallDelta = null; glideDelta = null
      }
      else if (nowOf() - last.t > 1000) velocity = { x: 0, y: 0, z: 0 }
      return
    }
    if (last && now === last.t && !relative) return
    if (last) {
      let base = last
      const airborne = entity.onGround === false
      let physicalTicks = null
      let firstFallDisplacement = false
      if (receipts && relative && freshReceipt && airborne && !nextFlying &&
        (entity.type === 'player' || entity.type === 'mob') && now - last.t <= 10 * 50) {
        const dy = p.y - last.y
        firstFallDisplacement = dy < 0 && fallDelta === null
        if (fallDelta !== null) physicalTicks = observedFallTicks(fallDelta, dy)
        fallDelta = dy
      } else fallDelta = null
      if (airborne) {
        // Native physics advances whole ticks, while adjacent movement packets
        // can arrive in one sub-tick burst. Retain just enough actual positions
        // to measure at least one tick; the latest position still owns aim age.
        if (physicalTicks !== null) airSamples = [last]
        else airSamples.push(last)
        while (airSamples.length > 1 && airSamples[1].t <= now - 50) airSamples.shift()
        base = airSamples[0]
      } else airSamples = []
      // ChunkMap ticks ServerEntity once per native world tick. Each relative
      // position packet therefore represents at least one tick, even when
      // dirty metadata bypasses PLAYER's usual two-tick send interval.
      const dt = physicalTicks ?? Math.max((now - base.t) / 50, airborne && relative ? airSamples.length : 0)
      if (dt > 0 && dt <= 10 && (!airborne || dt >= 1)) {
        velocity = { x: (p.x - base.x) / dt, y: (p.y - base.y) / dt, z: (p.z - base.z) / dt }
        // The first falling displacement has no observed physical interval.
        // Retain its estimate, but release only after another real receipt;
        // an ambiguous pair still uses the existing observation fallback.
        velocityMeasured = !firstFallDisplacement
        if (entity.onGround === true) {
          if (!last.grounded) { groundPath = 0; groundSamples = [{ t: last.t, path: 0 }] }
          const dx = p.x - last.x; const dz = p.z - last.z; const distance = Math.hypot(dx, dz)
          groundPath += distance
          groundSamples.push({ t: now, path: groundPath })
          // Time packets span 20 native ticks. Packet arrival can batch adjacent
          // moves into microseconds; average only speed over that interval, and
          // keep the LAST direction so a reversal never follows the old strafe.
          while (groundSamples.length > 2 && groundSamples[1].t <= now - 1000) groundSamples.shift()
          const first = groundSamples[0]
          const speed = (groundPath - first.path) / ((now - first.t) / 50)
          velocity.x = distance ? dx / distance * speed : 0
          velocity.z = distance ? dz / distance * speed : 0
          velocity.y = 0
        } else {
          groundPath = 0; groundSamples = []
          if (airborne) {
            const dx = p.x - last.x; const dz = p.z - last.z; const distance = Math.hypot(dx, dz)
            let path = 0
            for (let i = 0; i < airSamples.length; i++) {
              const next = airSamples[i + 1] || p; const at = airSamples[i]
              path += Math.hypot(next.x - at.x, next.z - at.z)
            }
            const speed = path / dt
            velocity.x = distance ? dx / distance * speed : 0
            velocity.z = distance ? dz / distance * speed : 0
          }
        }
        if (entity.onGround === false && !(require('../elytra') as typeof import('../elytra')).gliding(entity)) {
          const d = Math.fround(.98); const sum = (1 - d ** dt) / (1 - d)
          const start = (p.y - base.y + .08 * d * (dt - sum) / (1 - d)) / sum
          velocity.y = start * d ** dt - .08 * d * sum
        }
      } else if (dt <= 0 || dt > 10) {
        velocity = { x: 0, y: 0, z: 0 }
        velocityMeasured = false
        // The first move after a long idle gap starts a new speed baseline.
        // Including frozen readiness/standing time understated a new runner's
        // speed until another full time-packet interval had elapsed.
        groundPath = 0
        groundSamples = entity.onGround === true ? [{ t: now, path: 0 }] : []
        airSamples = []; fallDelta = null
      } else if (airborne) {
        // A compressed turn changes direction immediately, using only a speed
        // already measured over a native interval until a new interval exists.
        const dx = p.x - last.x; const dz = p.z - last.z; const distance = Math.hypot(dx, dz)
        const speed = Math.hypot(velocity.x, velocity.z)
        velocity.x = distance ? dx / distance * speed : 0
        velocity.z = distance ? dz / distance * speed : 0
      }
      if (receipts && airborne && nextFlying && relative && freshReceipt) {
        const delta = { x: p.x - last.x, y: p.y - last.y, z: p.z - last.z }
        const eligible = receipt.flying === true && receipt.yaw === entity.yaw && receipt.pitch === entity.pitch &&
          !receipt.boosted && !boosted && now - last.t <= 500 && now >= last.t
        const endpoint = eligible && glideDelta ? observedGlideVelocity(glideDelta, delta, entity.yaw, entity.pitch) : null
        velocityMeasured = !!endpoint
        if (endpoint) velocity = endpoint
        glideDelta = eligible ? delta : null
      } else if (!nextFlying) glideDelta = null
    }
    if (!last && entity.onGround === true) groundSamples = [{ t: now, path: 0 }]
    last = { x: p.x, y: p.y, z: p.z, t: now, grounded: entity.onGround === true }
  }
  const age = () => last ? Math.min(20, Math.max(0, (nowOf() - last.t) / 50)) : 0
  const tracker = { update, hasVelocity: () => { update(); return velocityMeasured }, vel: () => { update(); return { ...velocity, ageTicks: age() } }, at: ticks => { update(); ticks += age(); return entity.position.offset(velocity.x * ticks, velocity.y * ticks, velocity.z * ticks) } }
  if (receipts) {
    const previous = entity._ndPositionReceipts?.[0]
    if (previous) {
      last = { x: previous.x, y: previous.y, z: previous.z, t: previous.t, grounded: previous.grounded }
      if (typeof previous.flying === 'boolean') { flying = previous.flying; yaw = previous.yaw; pitch = previous.pitch; boosted = !!previous.boosted }
      revision = previous.revision || 0
    }
    entity.on?.('ndPositionObserved', update)
    targetTrackers.set(entity, tracker)
    if (entity._ndPositionReceipts) update()
  }
  return tracker
}

export { leadTarget, traceTarget, trackTarget, observedVelocity, hasObservedVelocity }
