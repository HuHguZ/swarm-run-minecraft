'use strict'
const gameClock = require('./game-clock')
const afterMovePacket = require('./edges').afterPacket
const { AsyncResource } = require('node:async_hooks')
// Лук. Один модуль и для боя (pvp.js), и для тира (try-bow.js), чтобы то,
// что проверено в тире, и было тем, что стреляет в бою.
//
// Физика стрелы — как в AbstractArrow.tick (Java 1.21): стрела появляется на
// высоте глаз − 0.1, скорость = направление × 3 × сила (сила 1 при полном
// натяжении, 20 тиков); каждый тик позиция += скорость, потом скорость ×= 0.99,
// потом y −= 0.05. Разброс лука ~1° (inaccuracy 1.0) — его не убрать, но всё
// остальное должно быть точным. Прошлый прицел перебирал угол шагом 1° (на 30
// блоках это полблока), упреждал по «дистанция / 3» и держал тетиву ровно 1.05 с —
// на лаге стрела уходила недотянутой и падала короче.

const Vec3 = require('vec3')
const { sleep } = require('./movement')
const pick = require('./pick')

const SPEED = 3.0
const GRAVITY = 0.05
const DRAG = Math.fround(.99) // AbstractArrow.tick's 0.99f, promoted to double.
const DRAW_MS = 1150

// Self USING_ITEM metadata acknowledges the requested hand's native use. A time packet
// preceding that receipt cannot date its start: the first subsequent native
// age is a conservative start bound, with no client prediction credit.
function observeCharge (bot, { item = 'bow', hand = 'hand' }: { item?: string; hand?: 'hand' | 'off-hand' } = {}) {
  const client = bot._client; const clock = bot.ndClock
  const off = hand === 'off-hand'
  const key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  let failure = !client?.on || key < 0 || typeof clock?.age !== 'bigint' || !Number.isSafeInteger(clock?.serverTicks)
    ? item + '_native_authority_unavailable' : null
  let armed = false; let using = false; let acknowledged = false; let closed = false
  let slot = bot.quickBarSlot; let start = null; let previousAge = null; let previousTicks = null
  let stopped
  const cancelled = new Promise(resolve => { stopped = resolve })
  const fail = why => { if (!failure) { failure = why; stopped(why) } }
  const check = () => {
    if (armed && (off ? bot.inventory?.slots?.[45]?.name !== item : bot.quickBarSlot !== slot || bot.heldItem?.name !== item)) fail(item + '_slot_changed')
    return failure
  }
  const metadata = packet => {
    if (!armed || packet?.entityId !== bot.entity?.id || check()) return
    for (const entry of packet.metadata ?? []) if (entry.key === key && typeof entry.value === 'number') {
      using = (entry.value & 3) === (off ? 3 : 1)
      if (using) acknowledged = true
      else if (acknowledged) fail(item + '_native_use_ended')
    }
  }
  const age = () => {
    if (!armed || !acknowledged || !using || check()) return
    const ticks = clock.serverTicks; const actualAge = clock.age
    if (typeof actualAge !== 'bigint' || !Number.isSafeInteger(ticks)) { fail(item + '_native_authority_unavailable'); return }
    if (previousAge !== null && (actualAge < previousAge || ticks < previousTicks || actualAge - previousAge !== BigInt(ticks - previousTicks))) { fail(item + '_world_changed'); return }
    if (start === null) start = ticks
    previousAge = actualAge; previousTicks = ticks
  }
  const ended = () => fail(item + '_disconnected')
  const died = () => fail(item + '_died')
  const respawned = () => fail(item + '_world_changed')
  const changed = () => { check() }
  const cooldown = packet => { if (off && String(packet?.cooldownGroup || '').split(':').pop() === item && packet.cooldownTicks > 0) fail(item + '_cooldown') }
  client?.on?.('entity_metadata', metadata); client?.on?.('update_time', age)
  client?.on?.('set_cooldown', cooldown)
  bot.on('end', ended); bot.on('death', died); bot.on('respawn', respawned); bot.on('heldItemChanged', changed)
  if (off) bot.inventory?.on?.('updateSlot', changed)
  const close = () => {
    closed = true; armed = false
    client?.removeListener?.('entity_metadata', metadata); client?.removeListener?.('update_time', age)
    client?.removeListener?.('set_cooldown', cooldown)
    bot.removeListener('end', ended); bot.removeListener('death', died); bot.removeListener('respawn', respawned); bot.removeListener('heldItemChanged', changed)
    if (off) bot.inventory?.removeListener?.('updateSlot', changed)
    stopped(null)
  }
  const ticks = () => start === null || previousTicks === null ? null : previousTicks - start
  return {
    start () { if (closed || check()) return false; armed = true; slot = bot.quickBarSlot; if (check()) return false; bot.activateItem(off); return true },
    why: check, cancelled,
    ready (required = 20) { return !closed && !check() && acknowledged && using && (required === 0 || (ticks() !== null && ticks() >= required)) },
    snapshot () { return { useConfirmed: acknowledged, confirmedTicks: ticks() } },
    close,
    cancel () { const started = armed; close(); if (started) { try { if (off) bot.deactivateItem(); else bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch {} } }
  }
}

// Летит стрела под углом pitch (вверх +). Возвращает высоту (относительно
// точки вылета) на горизонтальном расстоянии dx и число тиков, или null.
function flight (pitch, dx, speed = SPEED, g = GRAVITY, drag = DRAG) {
  let x = 0; let y = 0
  let vx = Math.cos(pitch) * speed
  let vy = Math.sin(pitch) * speed
  for (let t = 1; t <= 200; t++) {
    const nx = x + vx
    const ny = y + vy
    if (nx >= dx) {
      // Точка на отрезке тика, где пересекли dx.
      const f = (dx - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vx *= drag
    vy = vy * drag - g
    if (vx < 1e-3) return null
  }
  return null
}

// Угол, при котором стрела на дистанции dx окажется на высоте dy. Низкая
// траектория: между -45° и углом максимальной дальности высота на dx растёт
// монотонно, так что деление пополам сходится.
// Низ — до −80°: со столба (pvp perch) цель бывает круто под ногами, а при
// −45° решатель молча возвращал сам край и стрела уходила поверх головы.
const LOW = -80 * Math.PI / 180
// Крутой выстрел (steep): цель высоко над головой и близко — кристалл на
// обелиске в сорок блоков высотой с двадцати блоков по земле. Потолок 43°
// такой выстрел отвергал как «не долетит», хотя стрела долетает: высота на
// дистанции dx растёт с углом до своего пика и потом падает, так что верхняя
// граница поиска — это угол пика для этой dx, а не угол максимальной дальности.
// По умолчанию выключено: у всех прежних вызовов поведение прежнее.
const TOP = 1.45
function peakPitch (dx, speed = SPEED, g = GRAVITY) {
  let lo = Math.PI / 4.2
  let hi = TOP
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  for (let i = 0; i < 50; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (at(m1) < at(m2)) lo = m1
    else hi = m2
  }
  return (lo + hi) / 2
}
// steep = 'lob' — навесом: ветка за пиком, где высота на dx с углом падает.
// Стрела приходит сверху — так бьют кристалл на высоком обелиске, чей край
// закрывает его от пологой стрелы с земли.
function solvePitch (dx, dy, speed = SPEED, g = GRAVITY, steep: any = false) {
  if (steep === 'lob') {
    const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
    let lo = peakPitch(dx, speed, g)
    let hi = TOP
    if (at(lo) < dy || at(hi) > dy) return null
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) > dy) lo = mid
      else hi = mid
    }
    const pitch = (lo + hi) / 2
    const f = flight(pitch, dx, speed, g)
    return f ? { pitch, ticks: f.ticks } : null
  }
  let lo = LOW
  let hi = steep ? peakPitch(dx, speed, g) : Math.PI / 4.2
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  if (at(hi) < dy) return null // не долетает
  if (at(lo) > dy) return null // круче, чем можно наклонить голову
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) < dy) lo = mid
    else hi = mid
  }
  const pitch = (lo + hi) / 2
  const f = flight(pitch, dx, speed, g)
  return f ? { pitch, ticks: f.ticks } : null
}

// Прицел по движущейся цели на точный дробный тик перехвата.
// targetAt(ticks) -> Vec3 точки, куда целимся.
function aim (from, targetAt, speed = SPEED, g = GRAVITY, steep = false) {
  return aimMoving(from, targetAt, { x: 0, y: 0, z: 0 }, false, speed, g, steep)
}

// Projectile.shootFromRotation adds known movement; vertical only airborne.
function aimMoving (from, targetAt, u, airborne = false, speed = SPEED, g = GRAVITY, steep: any = false) {
  // AbstractArrow: p += v; v *= .99; v.y -= .05. Sum whole ticks and
  // the final segment, then solve |launch - inherited movement| = speed.
  // This also handles steep falling shots; an uncompensated fallback misses.
  const uy = airborne ? u.y : 0
  const at = (ticks) => {
    const n = Math.floor(ticks)
    const dragN = DRAG ** n
    const sum = (1 - dragN) / (1 - DRAG) + (ticks - n) * dragN
    const P = targetAt(ticks)
    const v = { x: (P.x - from.x) / sum - u.x,
      y: (P.y - from.y + g * (ticks - sum) / (1 - DRAG)) / sum - uy,
      z: (P.z - from.z) / sum - u.z }
    return { P, v, error: Math.hypot(v.x, v.y, v.z) - speed }
  }
  let lo = .001
  let previous = at(lo).error
  for (let hi = 1; hi <= 200; hi++) {
    const current = at(hi).error
    const crossing = steep === 'lob' ? previous < 0 && current >= 0 : previous > 0 && current <= 0
    if (crossing) {
      let end = hi
      for (let i = 0; i < 35; i++) {
        const mid = (lo + end) / 2
        if ((at(mid).error > 0) === (steep !== 'lob')) lo = mid
        else end = mid
      }
      const ticks = (lo + end) / 2
      const { P, v } = at(ticks)
      const pitch = Math.atan2(v.y, Math.hypot(v.x, v.z))
      return { yaw: Math.atan2(-v.x, -v.z), pitch, ticks, at: P, comp: true }
    }
    lo = hi
    previous = current
  }
  return null
}

// Свободна ли траектория: стрела по тикам (та же физика), каждый отрезок —
// лучом по блокам. Живой прогон: бот вышел из арены через пробитую дыру и
// стрелял в стеклянную стену, потому что целился только по цели, не по пути.
// Возвращает null — путь чист, или точку, где стрела упрётся.
function blockedAt (bot, from, sol, u = { x: 0, y: 0, z: 0 }, speed = SPEED) {
  const dir = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch), y: Math.sin(sol.pitch), z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) }
  let p = from.clone()
  let v = { x: dir.x * speed + u.x, y: dir.y * speed + (bot.entity?.onGround ? 0 : u.y), z: dir.z * speed + u.z }
  const ticks = Math.ceil(sol.ticks || 20)
  for (let t = 0; t < ticks; t++) {
    const step = new Vec3(v.x, v.y, v.z)
    const len = step.norm()
    if (len < 1e-3) break
    // Последний отрезок — до самой цели, не дальше: цель стоит в своём блоке.
    // Цель на дробном тике (ticks 3.4) — от последнего шага нужна только доля
    // (0.4): полный шаг минус 0.8 пролетал цель и упирался в стену за ней
    // (лаборатория 2026-09-27: блейз у стены — «на линии стрельбы блок» 40 раз).
    const fraction = Math.min(1, (sol.ticks || ticks) - t)
    const reach = t === ticks - 1 ? Math.max(0, len * fraction - 0.8) : len
    try {
      // Направление — копией: Vec3.normalize() меняет сам вектор (vec3), и
      // раньше step после проверки становился единичным — стрела в симуляции
      // шла блок за тик вместо трёх, и проверялась лишь первая треть пути.
      const hit = bot.world.raycast(p, step.scaled(1 / len), reach, b => b && b.boundingBox === 'block')
      if (hit) return hit.position
    } catch { return null }
    p = p.plus(step)
    v = { x: v.x * DRAG, y: v.y * DRAG - GRAVITY, z: v.z * DRAG }
  }
  return null
}

// Цель с упреждением: скорость по двум последним позициям. Высота точки —
// середина туловища (0.55 роста): туда стрела ложится при любой ошибке по
// высоте в пределах полблока.
function leadTarget (entity, velFn, bot = null, frac = .55) {
  const sky = require('./elytra')
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
  if (!(previous < 0 && current < 0)) return null
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
  const sky = require('./elytra')
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
  let flying = require('./elytra').gliding(entity)
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
    const nextFlying = require('./elytra').gliding(entity)
    if (receipts && receipt?.kind && (nextFlying !== flying || (nextFlying &&
      (entity.yaw !== yaw || entity.pitch !== pitch || !!entity._ndGlideBoosted !== boosted || (entity._ndGlideRevision || 0) !== revision)))) {
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
        if (entity.onGround === false && !require('./elytra').gliding(entity)) {
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

// Выстрел. Натягивает DRAW_MS, всё это время ведя прицел; перед спуском —
// последний пересчёт. onDraw(tick) — чем занять ноги (стрейф). Возвращает
// прицел и, если follow, — чем кончилась стрела (hit / промах в блоках).
// Сервер 1.21 прибавляет к стреле скорость стрелка (shootFromRotation:
// getKnownMovement — то, что клиент сообщил о своём движении). Стрейф во время
// натяжения уводил стрелу вбок: в бою по зомби бот мазал через раз, хотя в
// тире стоя попадал всегда. Поэтому последние SETTLE_MS перед спуском тело
// стоит (onSettle), и скорость успевает погаснуть: трение на земле ×0.546 за тик.
const SETTLE_MS = 250

// mode: 'compensate' (по умолчанию) — не останавливаться, а учесть свою
// скорость в прицеле (aimMoving): стрейф идёт до самого спуска, и попасть в
// такого стрелка труднее; 'settle' — замереть перед спуском; 'raw' — ни то ни
// другое (для сравнения в тире).
// point(ticks) -> Vec3 — своя точка прицела вместо середины туловища (у
// дракона бьётся не сущность, а её части: голова, тело, крылья — dragon.js);
// steep — разрешить крутой выстрел вверх (см. peakPitch).
async function shoot (bot, entity, { velFn = null, onDraw = null, onSettle = null, onRelease = null, onHit = null, shouldStop = null, follow = true, mode = 'compensate', point = null, steep = false, drawMs = DRAW_MS, holdWhile = null, holdMaxMs = 2500, traceAim = false }: any = {}) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  const arrows = bot.inventory.items().find(i => /arrow$/.test(i.name))
  if (!bow || !arrows) return { shot: false, why: !bow ? 'лука нет' : 'стрел нет' }
  // Отменить натяжение без выстрела (ревью Codex 2026-09-30): deactivateItem —
  // это «отпустить кнопку», сервер на нём и стреляет (BowItem.releaseUsing) —
  // «отменил натяжение» выпускал стрелу. Смена слота снимает использование
  // предмета без releaseUsing (как при закрытом пути ниже).
  const cancelDraw = () => charge.cancel() // not deactivateItem: that releases an arrow

  // Короткое натяжение (стрела вреда, ranged.harmDrawMs, 2026-09-26): сила лука
  // (f² + 2f)/3 при f = тики/20 (BowItem.getPowerForTime), скорость стрелы 3 × сила.
  // Short-shot speed is an estimate, not a measured native charge duration.
  const short = drawMs < DRAW_MS
  const drawTicks = Math.max(2, Math.round(drawMs / 50) - 1)
  const speed = short ? SPEED * Math.min(1, ((drawTicks / 20) ** 2 + 2 * drawTicks / 20) / 3) : SPEED
  // One observed velocity per solve: reading a clock-backed tracker inside
  // every bisection step makes targetAt(t) change during the same calculation.
  const targetNow = () => {
    const v = velFn ? velFn() : observedVelocity(entity)
    let target = point || leadTarget(entity, () => v, bot)
    if (traceAim) {
      const observation = { at: gameClock.serverNow(), position: { ...entity.position }, velocity: { ...v }, grounded: entity.onGround }
      target = traceTarget(target, observation); target.observation = observation
    }
    return target
  }
  const eye = () => pick.eyeOf(bot).offset(0, -.1, 0)
  // Путь закрыт ещё до натяжения — не тратить секунду: вызывающий должен
  // сменить позицию (или идти в ближний бой).
  const pre = aim(eye(), targetNow(), speed, GRAVITY, steep)
  if (!pre) return { shot: false, why: 'не долетит' }
  const wall = blockedAt(bot, eye(), pre, undefined, speed)
  if (wall) return { shot: false, blocked: true, why: `на линии стрельбы блок ${wall.x},${wall.y},${wall.z}` }
  if (!bot.heldItem || bot.heldItem.name !== 'bow') await bot.equip(bow, 'hand')
  const charge = observeCharge(bot)
  let stopTick = () => {}; let sent = false
  try {
  if (!charge.start()) return { shot: false, why: charge.why(), fullChargeConfirmed: false }
  let sol = null
  const t0 = gameClock.now()
  const holdDeadline = t0 + drawMs + holdMaxMs
  // Что сервер прибавит к стреле — это смещение стрелка за последний тик
  // (замер /data get entity Motion: лишняя скорость стрелы ≈ 2 × velocity
  // mineflayer). velocity в mineflayer — уже после трения за тик (×0.546 на
  // земле), а смещение — до него. Поэтому меряем само смещение.
  let lastPos = bot.entity.position.clone()
  let moved = { x: 0, y: 0, z: 0 }
  const onTick = () => {
    const p = bot.entity.position
    moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }
    lastPos = p.clone()
  }
  bot.on('physicsTick', onTick)
  stopTick = () => { bot.removeListener('physicsTick', onTick) }
  const myVel = () => moved
  const solve = () => {
    const from = eye()
    const target = targetNow()
    const s = mode === 'compensate'
      ? aimMoving(from, target, myVel(), !bot.entity.onGround, speed, GRAVITY, steep)
      : aim(from, target, speed, GRAVITY, steep)
    return s ? { ...s, from, ...(traceAim ? { observation: target.observation, solvedAt: gameClock.serverNow() } : {}) } : null
  }
  let settled = false
  while (gameClock.now() - t0 < drawMs) {
    if (charge.why()) { stopTick(); cancelDraw(); return { shot: false, why: charge.why(), fullChargeConfirmed: false } }
    if (shouldStop && shouldStop()) { stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
    sol = solve()
    if (sol) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})
    if (mode !== 'settle' || gameClock.now() - t0 < drawMs - SETTLE_MS) {
      if (onDraw) onDraw(gameClock.now() - t0)
    } else if (!settled) {
      settled = true
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
      if (onSettle) onSettle()
    }
    await Promise.race([sleep(50), charge.cancelled])
  }
  while (!short && !charge.ready(20) && gameClock.now() < holdDeadline && !charge.why()) {
    if (shouldStop?.()) { stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение', fullChargeConfirmed: false } }
    sol = solve()
    if (sol) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})
    if (onDraw && mode !== 'settle') onDraw(gameClock.now() - t0)
    await Promise.race([sleep(50), charge.cancelled])
  }
  if (!charge.ready(short ? 0 : 20)) { stopTick(); cancelDraw(); return { shot: false, why: charge.why() || 'bow_charge_not_confirmed', fullChargeConfirmed: false } }
  // Держать натянутым, пока holdWhile() — его щит поднят к нам, и стрела в щит
  // пропала бы (LivingEntity.applyItemBlocking). Сила уже полная и не растёт
  // (BowItem.getPowerForTime ≤ 1): выстрел в тот тик, когда он опустит щит —
  // а щит он опустит, чтобы ударить. Короткое натяжение (вред) не держим: сила
  // выросла бы. Не дольше holdMaxMs (2026-09-26).
  if (holdWhile && !short) {
    const until = holdDeadline
    while (gameClock.now() < until && holdWhile()) {
      if (charge.why()) { stopTick(); cancelDraw(); return { shot: false, why: charge.why(), fullChargeConfirmed: false } }
      if (shouldStop && shouldStop()) { stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
      sol = solve()
      if (sol) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      if (onDraw) onDraw(gameClock.now() - t0)
      await Promise.race([sleep(50), charge.cancelled])
    }
  }
  if (mode === 'settle') {
    // Ещё скользим — дождаться, пока гаснет, но не дольше 150 мс.
    const still = gameClock.now() + 150
    while (!charge.why() && gameClock.now() < still && bot.entity.velocity && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.02) await Promise.race([sleep(25), charge.cancelled])
  }
  if (mode === 'snap' || mode === 'snap2') {
    // Эксперимент: клавиши отпустить в момент спуска (snap) или за тик (snap2).
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
    if (mode === 'snap2') await Promise.race([sleep(60), charge.cancelled])
  }
  // Финальный прицел — на позднем physicTick после planning, перед updatePosition.
  // Сервер берёт взгляд и known movement из пакета движения (1.21.11).
  // Тетива отпускается на ndMovementSent, после movement/tick_end этого кадра.
  // Ловим свою стрелу: появится у глаз в ближайшие тики.
  let arrow = null
  let me = bot.entity.position.clone()
  const onSpawn = (e) => {
    if (!arrow && e && /arrow$/.test(e.name) && e.position && e.position.distanceTo(me) < 3) arrow = e
  }
  // Настоящая начальная скорость стрелы — из пакета появления: позиции летящей
  // стрелы mineflayer почти не обновляет, по ним ничего не измерить.
  // Только для разбора (follow): в бою без него каждый выстрел оставлял
  // слушателя висеть — MaxListenersExceededWarning после десятка стрел.
  let spawnPkt = null
  const onRaw = (pkt, meta, bytes) => {
    if (spawnPkt || !pkt || meta?.name !== 'spawn_entity' || pkt.type !== bot.registry?.entitiesByName?.arrow?.id) return
    const px = pkt.x; const pz = pkt.z
    if (typeof px !== 'number' || Math.hypot(px - me.x, pz - me.z) > 3) return
    spawnPkt = { ...pkt, velocity: require('./drops').velocityFromRaw(bytes, 'spawn') }
  }
  let hit = false
  // Урон цели в ближайшие ~2 с после спуска — наша стрела (ближний бой в это
  // время не идёт: стреляем с дистанции).
  const onHurt = (victim) => {
    if (victim !== entity || hit) return
    hit = true
    if (onHit) { try { onHit() } catch {} }
  }
  let releasedAt = null
  const release = (s, shut, checkedAt, position) => {
    // Send inside the packet-boundary callback. Awaiting its Promise first
    // lets a synchronous catch-up burst change the server's last movement.
    if (!s || shut) { stopTick(); cancelDraw(); return { s, shut, checkedAt } }
    if (shouldStop?.()) { stopTick(); cancelDraw(); return { s, stopped: true } }
    if (!charge.ready(short ? 0 : 20)) { stopTick(); cancelDraw(); return { s, chargeError: charge.why() || 'bow_charge_not_confirmed' } }
    if (!point && !hasObservedVelocity(entity)) { stopTick(); cancelDraw(); return { s, unobserved: true } }
    // release_use_item поворота не несёт: стрела летит по последнему отправленному look, а он — из тела. Голова не там,
    // где решение (сторож взгляда эндермена опустил её, поворот под замком не успел) — не стрелять мимо (s5c 06.10).
    if (bot.entity && (Math.abs(bot.entity.pitch - s.pitch) > 0.05 || Math.abs(Math.atan2(Math.sin(bot.entity.yaw - s.yaw), Math.cos(bot.entity.yaw - s.yaw))) > 0.05)) {
      stopTick(); cancelDraw(); return { s, stopped: true }
    }
    sol = s; me = position
    bot.on('entitySpawn', onSpawn); bot.on('entityHurt', onHurt)
    if (follow) { try { bot._client.on('packet', onRaw) } catch {} }
    releasedAt = traceAim ? gameClock.serverNow() : null
    if (onRelease) { try { onRelease(moved) } catch {} }
    stopTick()
    bot.deactivateItem()
    sent = true
    charge.close()
    return { s, checkedAt, released: true }
  }
  let fin: any = await new Promise<any>(resolve => {
    let done = false
    charge.cancelled.then(why => {
      if (!why || done) return
      done = true; bot.removeListener('physicTick', onT); gameClock.clearTimeout(timer)
      stopTick(); cancelDraw(); resolve({ chargeError: why })
    })
    const onT = AsyncResource.bind(() => {
      if (done) return
      if (shouldStop?.()) {
        done = true; bot.removeListener('physicTick', onT); gameClock.clearTimeout(timer)
        stopTick(); cancelDraw(); resolve({ stopped: true }); return
      }
      if (!point && !hasObservedVelocity(entity)) {
        if (onDraw) onDraw(gameClock.now() - t0)
        return
      }
      done = true
      bot.removeListener('physicTick', onT)
      gameClock.clearTimeout(timer)
      const position = bot.entity.position.clone()
      let s = solve()
      let shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
      // Refresh once after solve/LOS work, then verify the new path too.
      if (s && !shut) {
        s = solve()
        shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
      }
      if (s && !shut) bot.look(s.yaw, s.pitch, true).catch(() => {})
      const checkedAt = traceAim ? gameClock.serverNow() : null
      afterMovePacket(bot, () => resolve(release(s, shut, checkedAt, position)))
    })
    // Installed physics emits this existing late boundary after all planning
    // callbacks, immediately before updatePosition. Keep the movement observer
    // on physicsTick; release still follows the actual movement/tick_end packet.
    Object.defineProperty(onT, '_ndLatePacketAim', { value: true })
    bot.on('physicTick', onT)
    const timer = gameClock.setTimeout(() => {
      if (done) return
      done = true; bot.removeListener('physicTick', onT)
      if (!point && !hasObservedVelocity(entity)) {
        stopTick(); cancelDraw(); resolve({ unobserved: true })
      } else resolve(null)
    }, 300)
  })
  if (!fin) {
    const s = solve()
    const shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
    if (s && !shut) await bot.look(s.yaw, s.pitch, true).catch(() => {})
    fin = release(s, shut, traceAim ? gameClock.serverNow() : null, bot.entity.position.clone())
  }
  if (!fin.released) {
    const shut = fin.shut
    return { shot: false, blocked: !!shut, fullChargeConfirmed: false, why: fin.chargeError || (fin.stopped ? 'отменил натяжение' : fin.unobserved ? 'скорость цели ещё не наблюдалась' : shut ? `на линии стрельбы блок ${shut.x},${shut.y},${shut.z}` : 'не долетит') }
  }

  const out: any = {
    shot: true,
    dist: Math.round(me.distanceTo(entity.position) * 10) / 10,
    pitchDeg: Math.round(sol.pitch * 1800 / Math.PI) / 10,
    flightTicks: sol.ticks,
    aimAt: sol.at,
    from: sol.from,
    fullChargeConfirmed: !short,
    nativeCharge: charge.snapshot(),
    ...(traceAim ? { aimObservation: { ...sol.observation, solvedAt: sol.solvedAt, checkedAt: fin?.checkedAt, releasedAt } } : {}),
    speed: short ? Math.round(speed * 100) / 100 : undefined,
    speedEstimated: short || undefined
  }
  if (!follow) {
    // Стрела на 40 блоков летит ~20 тиков: 2.5 с хватает.
    gameClock.setTimeout(() => { bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityHurt', onHurt) }, Math.min(3000, sol.ticks * 50 + 1000))
    return out
  }
  // Диагностика: куда реально полетела стрела в первые тики против того, куда
  // целились. Отличает «прицел неверный» от «сервер добавил чужую скорость».
  const firstPos = []
  // Следим за стрелой: попала, или где ближе всего прошла мимо цели.
  let closest = Infinity
  const deadline = gameClock.now() + Math.max(1500, sol.ticks * 50 + 1200)
  while (gameClock.now() < deadline && !hit) {
    if (arrow && arrow.position && entity.position) {
      if (firstPos.length < 3) firstPos.push({ p: arrow.position.clone(), t: gameClock.now() })
      const c = point ? point(0) : entity.position.offset(0, (entity.height || 1.8) / 2, 0)
      const dd = arrow.position.distanceTo(c)
      if (dd < closest) closest = dd
      if (arrow.isValid === false) break
    }
    await sleep(50)
  }
  try { bot._client.removeListener('packet', onRaw) } catch {}
  if (spawnPkt) {
    // Скорость в пакете: старые версии — velocityX/Y/Z в 1/8000 блока за тик,
    // 1.21.9+ — вектор velocity. Берём, что есть.
    let v = null
    const pv = spawnPkt.velocity
    if (pv && typeof pv.x === 'number') v = { x: pv.x, y: pv.y, z: pv.z }
    else if (typeof spawnPkt.velocityX === 'number') v = { x: spawnPkt.velocityX / 8000, y: spawnPkt.velocityY / 8000, z: spawnPkt.velocityZ / 8000 }
    out.diag = {
      wantYaw: Math.round(sol.yaw * 180 / Math.PI),
      wantPitch: Math.round(sol.pitch * 180 / Math.PI),
      flewYaw: v ? Math.round(Math.atan2(-v.x, -v.z) * 180 / Math.PI) : null,
      flewPitch: v ? Math.round(Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI) : null,
      speed: v ? Math.round(Math.hypot(v.x, v.y, v.z) * 100) / 100 : null,
      mySpeed: bot.entity.velocity ? Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 100) / 100 : null,
      raw: v ? undefined : Object.keys(spawnPkt).join(',')
    }
  } else if (follow) {
    out.diag = { note: 'пакета появления стрелы не поймал' }
  }
  bot.removeListener('entitySpawn', onSpawn)
  bot.removeListener('entityHurt', onHurt)
  out.hit = hit
  if (!hit && closest < Infinity) out.missBy = Math.round(closest * 10) / 10
  if (!arrow) out.note = 'свою стрелу не увидел'
  return out
  } finally { stopTick(); if (sent) charge.close(); else charge.cancel() }
}

module.exports = { shoot, observeCharge, aim, aimMoving, solvePitch, peakPitch, flight, leadTarget, trackTarget, observedVelocity, hasObservedVelocity, traceTarget, blockedAt, DRAW_MS, SPEED, GRAVITY }
