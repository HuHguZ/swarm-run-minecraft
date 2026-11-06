// Облёт на элитрах вокруг подброшенного врага (пользователь 25.10: «хочу, чтобы в полёте кидали… научи кружить»): взлёт,
// на арене — дуга со стороны центра к будущей высоте глаз для бокового сброса; вне арены — прежний круг.
// Заряды бросает wind-out на сближении. В Колизее сопровождаем цель и на внутренних площадках.
import * as gameClock from '../game-clock'
import { windCount, windReady } from '../mace/hands'
import { createLastSeen } from '../pvp/last-seen'
import { observedVelocity, hasObservedVelocity } from '../bow/track'
import { observedCollision } from '../pvp/search'
import edges = require('../edges')
import pick = require('../pick')
import { bodyClear, supportAt } from '../navigation/geometry'
import { WIND, windLaunch, windMovement, windOutside, windOutward, worldTick } from './team-wind'
import { windOrder } from './wind-coordination'
import { owner as reflexOwner } from '../reflex-lock'

const peaks = new WeakMap<object, { values: WeakMap<object, any>; read: any; world: any; entity: any }>()
function wingCache(bot, target, allowGlider = false) {
  const [previous, current] = target?._ndPositionReceipts || []
  const relative = r => r?.kind === 'rel_entity_move' || r?.kind === 'entity_move_look'
  if (target?._ndVisible !== true || target.onGround || !previous || !current ||
    !(relative(previous) || previous.kind === 'reacquired') || !relative(current) || previous.grounded || current.grounded ||
    !(current.t > previous.t) || current.t - previous.t > 10 * 50 ||
    (target._ndObservationNow?.() ?? gameClock.observationNow()) - current.t > 10 * 50 || !hasObservedVelocity(target)) return null
  const gliding = require('../elytra').gliding(target)
  if (!bot.physics || gliding && (!allowGlider || previous.flying !== true || current.flying !== true)) return null
  let cache = peaks.get(bot)
  if (!cache) {
    cache = { values: new WeakMap(), read: bot.blockAt, world: bot.world, entity: bot.entity }; peaks.set(bot, cache)
    const invalidate = () => { cache.values = new WeakMap() }
    bot.on('blockUpdate', invalidate)
    bot.once('end', () => { bot.removeListener('blockUpdate', invalidate); peaks.delete(bot) })
  }
  if (cache.read !== bot.blockAt || cache.world !== bot.world || cache.entity !== bot.entity) {
    cache.values = new WeakMap(); Object.assign(cache, { read: bot.blockAt, world: bot.world, entity: bot.entity })
  }
  const old = cache.values.get(target)
  if (old?.previous === previous && old.current === current && old.gliding === gliding) return old
  const result: any = { previous, current, gliding }; cache.values.set(target, result)
  return result
}
/** Native rising height from two fair receipts: full apex, or the certified lower bound before unknown cells. */
export function wingPeak(bot, target): number | null {
  const result = wingCache(bot, target)
  if (!result) return null
  const velocity = observedVelocity(target)
  if (!(velocity?.y > 0)) return null
  if (result.peak !== undefined) return result.peak
  result.peak = null
  const { Vec3 } = require('vec3'), known = edges.worldOf(observedCollision(bot)), simulate = edges.simOf(bot)
  let unknown = false
  const world = { getBlock(p) { const b = known.getBlock(p); if (!b) unknown = true; return b } }
  const entity = { position: target.position.clone(), velocity: new Vec3(velocity.x, velocity.y, velocity.z),
    onGround: false, elytraFlying: false, yaw: target.yaw || 0, pitch: 0, effects: {}, attributes: {}, _ndPoseHeight: target.height || 1.8 }
  const state = edges.stateOf({ ...bot, entity, inventory: { slots: [], items: () => [] }, food: 20,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 }, edges.IDLE)
  let peak = state.pos.y
  for (let tick = 0; tick < 40 && state.vel.y > 0; tick++) {
    simulate(state, world)
    if (state.onGround || state.isInWater || state.isInLava) return null
    if (unknown) return result.peak = peak > target.position.y ? peak : null
    if (state.isCollidedHorizontally || state.isCollidedVertically) return null
    peak = Math.max(peak, state.pos.y)
  }
  return result.peak = state.vel.y > 0 ? null : peak
}

function wingForecast(bot, target, arena, lead: number, allowGlider = false) {
  if (!arena || !Number.isFinite(arena.r)) return null
  const cache = wingCache(bot, target, allowGlider)
  if (!cache) return null
  const kernel: typeof import('./enemy-wind') = require('./enemy-wind')
  if (cache.arena !== arena || cache.forecast === undefined) {
    cache.arena = arena; cache.forecast = null
    const frames = kernel.enemyWindFrames(bot, target, arena, [], 0, true)
    const landed = frames.findIndex((f, k) => k > 0 && f.onGround), path = landed < 0 ? frames : frames.slice(0, landed + 1)
    const known = observedCollision(bot)
    const unknown = path.findIndex(f => !bodyClear(known, f.pos)), visible = unknown < 0 ? path : path.slice(0, unknown)
    if (visible.length > 1) cache.forecast = {
      frames: visible, at: target._ndObservationNow?.() ?? gameClock.observationNow()
    }
  }
  const baseline = cache.forecast
  if (!baseline || !arena.ellipse || cache.gliding || !bot._ndThrown?.size) return baseline
  const at = target._ndObservationNow?.() ?? gameClock.observationNow()
  const age = Math.floor(Math.max(0, at - baseline.at) / 50)
  const deadline = gameClock.wall.monotonic() + 250 / (bot.ndClock?.observationRate?.() || 20)
  const frames = kernel.enemyWindLiftFrames(bot, target, arena, baseline.frames.slice(age), lead, deadline)
  return frames ? { ...baseline, lift: { frames, at } } : baseline
}

function windFinishTerrain(bot, freshWorld: () => ReturnType<typeof observedCollision>) {
  const world = bot.world
  if (typeof world?.on !== 'function' || typeof world?.removeListener !== 'function') return
  const cellKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const columnKey = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
  type Footprint = { cells: Map<string, any>; columns: Set<string> }
  // The initial inside forecast and the latest retained cells have independent footprints.
  let accepted: Footprint | undefined, remembered: Footprint | undefined, reading: Footprint | undefined, revision = 0
  const forget = () => { revision++; accepted = remembered = undefined }
  const affected = (part: keyof Footprint, key: string) =>
    accepted?.[part].has(key) || remembered?.[part].has(key) || reading?.[part].has(key)
  const blockChange = (old, next) => {
    const p = next?.position ?? old?.position
    if (![p?.x, p?.y, p?.z].every(Number.isFinite) || affected('cells', cellKey(p))) forget()
  }
  const columnChange = p => {
    if (![p?.x, p?.z].every(Number.isFinite) || affected('columns', columnKey(p))) forget()
  }
  const listeners = { blockUpdate: blockChange, chunkColumnLoad: columnChange, chunkColumnUnload: columnChange }
  for (const [event, listener] of Object.entries(listeners)) world.on(event, listener)
  return {
    sample() {
      if (bot.world !== world) { forget(); return }
      const seen: Footprint = { cells: new Map(), columns: new Set() }, epoch = revision
      reading = seen
      const fresh = freshWorld()
      const collision = { ...fresh, blockAt(p) {
        const key = cellKey(p)
        if (!seen.cells.has(key)) {
          // An unreadable cell is still relevant to invalidation, but supplies no block.
          seen.cells.set(key, undefined)
          seen.columns.add(columnKey(p))
        }
        const block = fresh.blockAt(p) ?? remembered?.cells.get(key)
        seen.cells.set(key, block)
        return block
      } }
      const current = () => revision === epoch && bot.world === world
      return { collision, current, keep() {
        if (reading === seen) reading = undefined
        if (current()) { accepted ??= seen; remembered = seen }
      } }
    },
    close() {
      for (const [event, listener] of Object.entries(listeners)) world.removeListener(event, listener)
      reading = undefined
      forget()
    }
  }
}

export async function wingOrbit (session, ctl, p: any = {}) {
  const bot = session.require()
  const sky = require('../elytra')
  const { Vec3 }: typeof import('vec3') = require('vec3')
  const vision = createLastSeen(bot)
  let finishTerrain: ReturnType<typeof windFinishTerrain>
  type FinishWindow = NonNullable<ReturnType<typeof import('./enemy-wind').windFinishOpportunity>>
  let finishPreflight: { window: FinishWindow; current: () => boolean } | undefined
  const c = p.arena && Number.isFinite(p.arena.x) ? p.arena : null
  const ellipse = c?.ellipse
  const pursueGround = Number.isFinite(c?.z) && Number.isFinite(ellipse?.a) && ellipse.a > 0 && Number.isFinite(ellipse?.b) && ellipse.b > 0
  const canCoast = () => {
    if (!pursueGround || !sky.gliding(bot.entity) || sky.kit(bot).rockets > 0) return false
    const items = bot.inventory.items()
    const { isSpear }: typeof import('../spear') = require('../spear')
    const { crossbows }: typeof import('../ranged') = require('../ranged')
    return !items.some(i => isSpear(i.name) || i.name === 'ender_pearl') &&
      !(items.some(i => i.name === 'bow') && items.some(i => /arrow$/.test(i.name))) &&
      !crossbows(bot).some(entry => entry.info.loaded)
  }
  try {
    const foe = () => {
      const player = bot.players?.[p.target]
      if (pursueGround && (player?.gamemode === 1 || player?.gamemode === 3)) return null
      const e = vision.observe(player?.entity)
      return e?._ndVisible ? e : null
    }
    const glidingFoe = () => sky.gliding(foe())
    const target = foe()
    if (!target) return { ok: false, why: 'цели не видно' }
    const known = observedCollision(bot)
    const supported = e => e.onGround === true || !!supportAt(known, e.position, 0)
    // Высокое пересечение края обратимо. Окончание — посадка снаружи или уход ниже линии падения.
    const exited = e => pursueGround && windOutside(c, e.position, pick.hitboxOf(bot, e).w) &&
      (Number.isFinite(c.killY) && e.position.y < c.killY || (e.onGround ?? supported(e)))
    if (exited(target)) return { ok: false, why: 'цель за ареной' }
    const k = sky.kit(bot)
    const needsTakeoff = bot.entity.onGround || !sky.gliding(bot.entity)
    if (!k.elytra || needsTakeoff && k.rockets < 1) return { ok: false, why: 'нет элитр или ракет' }
    const fired = session._windOut?.fired
    const R = p.radius ?? 8, floorY = Number.isFinite(p.floorY) ? p.floorY : (p.arena?.y ?? -64)
    const perched = p.ledge || target.onGround === true, perchY = target.position.y
    let leftPerch = !perched
    if (needsTakeoff) {
      if (!windCount(bot)) return { ok: false, why: 'нет зарядов ветра' }
      const t = await sky.takeoff(bot, ctl, { pitch: 1.2, arena: p.arena, useReserve: true })
      if (!t.ok) return { ok: false, why: 'взлёт: ' + t.why }
    }
    const t0 = gameClock.now(), deadline = t0 + (p.seconds ?? 12) * 1000
    const body = bot.entity, nativeClock = bot.ndClock, owner = session.current
    const current = () => !ctl.aborted && bot.health > 0 && bot.entity === body && bot.ndClock === nativeClock &&
      !nativeClock?.frozen && !nativeClock?.disposed && session.current === owner
    const finishFoe = (visible?: any) => {
      const tick = worldTick(bot)
      if (!current() || tick === null || !sky.gliding(body) || reflexOwner(session) || windOrder(session, tick)) return null
      const e = visible ?? foe()
      return e?.id === target.id && !sky.gliding(e) && !supported(e) ? e : null
    }
    const readFinish = (e: any, budget: number, collision?: ReturnType<typeof observedCollision>, spear?: 'preflight' | FinishWindow) => {
      if (!e) return null
      const kernel: typeof import('./enemy-wind') = require('./enemy-wind')
      const opportunity = kernel.windFinishOpportunity(bot, e, c, collision, budget, spear)
      return opportunity?.gameTick === worldTick(bot) ? opportunity : null
    }
    const windFirst = (budget: number) => {
      if (gameClock.wall.monotonic() > budget) return true
      if (!windReady(bot)) return false
      const { enemyWindReport }: typeof import('./enemy-wind-execute') = require('./enemy-wind-execute')
      const { windOutDecide }: typeof import('./wind-out') = require('./wind-out')
      const report = enemyWindReport(session, { flying: true })
      if (!report.ready || !report.report) return true
      const remaining = budget - gameClock.wall.monotonic()
      if (remaining <= 0) return true
      // Leave time in this tick for the already feasible spear course and its first active recheck.
      const plan = windOutDecide(bot, report.report, c, 0, budget - remaining / 2)?.plan
      return gameClock.wall.monotonic() > budget || !!(plan?.nominal.out || plan?.worst.out || plan?.fallThreat)
    }
    let finishItem: any = null, finishTried = false
    let near = 0, closest = Infinity
    // Стоит на гребне (пользователь 25.10: «с центра колизея тоже скидывать, элитровые в помощь») — не круг, а дуга ±0.8 рад.
    // со стороны центра арены: снаружи заряд толкнул бы его внутрь, а с центра — наружу, через край; сбили — тот же заход
    // добивает падающего. Сторона дуги меняется, когда бот дошёл до её конца.
    let sweep = 1
    const laneAngle = pursueGround && (p.lane === -1 || p.lane === 0 || p.lane === 1) ? Math.atan2(3 * p.lane, R) : null
    const centreSideAngle = (ai, me, f, d) => {
      if (laneAngle !== null) return ai + laneAngle
      const rel = Math.atan2(Math.sin(Math.atan2(me.z - f.z, me.x - f.x) - ai), Math.cos(Math.atan2(me.z - f.z, me.x - f.x) - ai))
      if (d < R * 1.6 && rel * sweep > .6) sweep = -sweep
      return ai + (d < R * 1.6 ? .8 * sweep : 0)
    }
    const escort = () => sky.fly(bot, ctl, {
      arena: p.arena, useReserve: true, maxMs: Math.max(0, deadline - gameClock.now()), phase: 'облёт',
      goal: () => {
        const e = foe(); if (!e || exited(e)) return null
        const me = bot.entity.position, f = e.position, ground = supported(e)
        const d = Math.hypot(me.x - f.x, me.z - f.z); closest = Math.min(closest, me.distanceTo(f)); if (me.distanceTo(f) < 16) near++
        // Точка круга на 0.7 рад. впереди по ходу: бот всё время догоняет её и обходит его кругом.
        const ledge = c && ground && (pursueGround || Math.hypot(f.x - c.x, f.z - c.z) > R)
        if (ledge) {
          const outward = pursueGround ? windOutward(c, f, pick.hitboxOf(bot, e).w) : null
          const ai = outward ? Math.atan2(-outward.z, -outward.x) : Math.atan2(c.z - f.z, c.x - f.x)
          const a = centreSideAngle(ai, me, f, d)
          return { kind: 'point', at: new Vec3(f.x + Math.cos(a) * R, f.y + 2, f.z + Math.sin(a) * R), minY: f.y - 1, maxY: f.y + 10, gap: 3, speedMin: .4 }
        }
        const arenaAir = c && !ground, height = pick.hitboxOf(bot, bot.entity).h, eye = pick.eyeHeight(bot)
        const targetEye = arenaAir ? pick.eyeHeight(bot, e) : 0
        let a = Math.atan2(me.z - f.z, me.x - f.x) + (d < R * 1.6 ? .7 : 0)
        if (arenaAir) {
          const outward = windOutward(c, f, pick.hitboxOf(bot, e).w), ai = Math.atan2(-outward.z, -outward.x)
          a = centreSideAngle(ai, me, f, d)
        }
        const forecast = wingForecast(bot, e, p.arena, Math.ceil(R / WIND.speed), sky.gliding(e) && canCoast())
        if (forecast) {
          const gap = 3
          // A future arena escort follows the target at radius R. The cast solver uses inherited movement at release.
          const launch = arenaAir ? null : windLaunch(new Vec3(Math.cos(a) * R, eye - height, Math.sin(a) * R), new Vec3(0, 0, 0), windMovement(bot))
          const lead = Math.ceil(launch?.time ?? R / WIND.speed)
          const at = e._ndObservationNow?.() ?? gameClock.observationNow()
          const elapsed = Math.max(0, (at - forecast.at) / 50), vertical = forecast.lift || forecast
          const verticalAge = Math.max(0, (at - vertical.at) / 50)
          const frames = vertical.frames, last = frames.length - 1, current = Math.min(last, Math.ceil(verticalAge))
          let crest = last
          // Пока цель поднимается, готовим высоту для следующего броска, даже если конец прогона уже видит посадку.
          if (forecast.lift) {
            crest = current
            for (let tick = current + 1; tick <= last; tick++) if (frames[tick].pos.y > frames[crest].pos.y) crest = tick
          } else if (pursueGround && arenaAir && current < last && frames[current + 1].pos.y > frames[current].pos.y) {
            crest = current + 1
            while (crest < last && frames[crest + 1].pos.y >= frames[crest].pos.y) crest++
          }
          return { kind: 'point', at: t => {
            // Armor can reduce a real gust. Keep the known horizontal lane while preparing for the lift.
            const future = forecast.frames[Math.min(forecast.frames.length - 1, Math.ceil(elapsed + t + lead))].pos
            const tick = Math.min(last, Math.ceil(verticalAge + t + lead))
            const y = frames[t > 0 ? Math.min(tick, crest) : tick].pos.y
            return new Vec3(future.x + Math.cos(a) * R, Math.max(floorY + gap, y + (arenaAir ? targetEye - eye : -height)), future.z + Math.sin(a) * R)
          }, minY: floorY + gap, maxY: arenaAir ? undefined : f.y + 12, gap, speedMin: .4 }
        }
        if (arenaAir) return { kind: 'point', at: new Vec3(f.x + Math.cos(a) * R,
          Math.max(floorY + 3, f.y + targetEye - eye), f.z + Math.sin(a) * R), minY: floorY + 3, gap: 3, speedMin: .4 }
        return { kind: 'point', at: new Vec3(f.x + Math.cos(a) * R, f.y + (sky.gliding(e) ? 0 : 3), f.z + Math.sin(a) * R), minY: f.y - 2, maxY: f.y + 12, gap: 3, speedMin: .4 }
      },
      rocketIf: (s, _plan, goal) => {
        const e = foe()
        if (!e) return false
        const moving = typeof goal?.at === 'function', at = moving ? goal.at(0) : c ? goal?.at : null
        if (s.p.y < (at?.y ?? e.position.y + 1) || Math.hypot(s.v.x, s.v.z) < .6) return true
        if (!pursueGround || !moving) return false
        const next = goal.at(1), dx = at.x - s.p.x, dz = at.z - s.p.z
        const toward = dx * s.v.x + dz * s.v.z
        const retreat = dx * (next.x - at.x) + dz * (next.z - at.z)
        // Undefined lets the existing pilot price the boost against coasting.
        return toward > 0 && retreat > toward ? undefined : false
      },
      until: () => {
        const e = foe()
        if (!e) return 'цели не видно'
        if (exited(e)) return 'цель за ареной'
        let followForSpear = false
        if (pursueGround && !finishTried && current() && !bot.usingHeldItem && bot.health >= 6 && sky.gliding(body) &&
            bot.inventory.items().some(i => (require('../spear') as typeof import('../spear')).isSpear(i.name))) {
          const budget = gameClock.wall.monotonic() + 1000 / (nativeClock?.observationRate?.() || 20)
          const candidate = finishFoe(e)
          const kernel: typeof import('./enemy-wind') = require('./enemy-wind')
          const affected = !!candidate && kernel.recentlyWindAffected(bot, candidate)
          const terrain = affected ? windFinishTerrain(bot, () => kernel.windCollisionWorld(bot)) : undefined
          try {
            const sample = terrain?.sample(), window = readFinish(candidate, budget, sample?.collision, sample ? 'preflight' : undefined)
            // A fresh gust can have an occluded landing for one view. Keep steering
            // and wait for the full forecast before admitting the spear pass.
            followForSpear = !!window || affected
            if (window) {
              const lance: typeof import('./aerial-lance') = require('./aerial-lance')
              const item = lance.windLancePlan(bot, e, window, c, budget)
              if (item && !windFirst(budget)) {
                sample?.keep()
                finishTerrain = terrain
                finishPreflight = sample && { window, current: sample.current }
                finishItem = item
                return 'таран после ветра'
              }
            }
          } finally {
            if (terrain !== finishTerrain) terrain?.close()
          }
        }
        if (!windCount(bot) && !followForSpear) return 'заряды закончились'
        if (sky.gliding(e) && !canCoast()) return 'цель на элитрах'
        if (pursueGround) return null
        const ground = supported(e)
        if (!ground && (e.onGround === false || e.position.y !== perchY)) leftPerch = true
        if (ground && (leftPerch || e.position.y < perchY)) return 'он внизу'
        return null
      }
    })
    let flight = await escort()
    let landed: any = { ok: !!bot.entity.onGround }
    let combat: any = null
    try {
      if (flight.why === 'таран после ветра' && finishItem && current()) {
        finishTried = true
        const e = foe(), lance: typeof import('./aerial-lance') = require('./aerial-lance')
        let first = true
        try {
          if (e?.id === target.id) {
            combat = await lance.finishWindLance(bot, ctl, e, finishItem, budget => {
              // Reforecast the visible body each tick. The preceding accepted
              // forecast can supply previously seen cells now behind cover.
              const candidate = finishFoe(), sample = candidate && finishTerrain?.sample()
              const preflight = finishPreflight?.current() ? finishPreflight.window : undefined
              const window = readFinish(candidate, budget, sample?.collision, preflight)
              if (!window || first && windFirst(budget)) return null
              sample?.keep()
              first = false
              return window
            }, c, deadline)
          }
        } finally {
          finishTerrain?.close()
          finishTerrain = undefined
          finishPreflight = undefined
        }
        if (!combat?.hit && current() && sky.gliding(bot.entity) && gameClock.now() < deadline) flight = await escort()
      }
      const left = deadline - gameClock.now()
      // Keep the same owner until combat finishes; returning airborne lets unmanaged rescue steal the approach.
      if (flight.why === 'цель на элитрах' && !ctl.aborted && sky.gliding(bot.entity) && glidingFoe() && left > 0) {
        session.updateMovements()
        combat = await require('../combat').fight(session, ctl, { target: p.target, allowPlayer: true, allowRanged: true,
          timeoutSeconds: left / 1000, retreatAtHealth: 3, arena: p.arena })
      }
    } finally {
      const e = foe()
      if (sky.gliding(bot.entity)) landed = await sky.land(bot, ctl, { away: e ? e.position : null, arena: p.arena })
      try { if (bot.entity.onGround && sky.wearingElytra(bot)) await sky.chestDown(bot, ctl, { arena: p.arena }) } catch {}
    }
    const windShots = Number.isFinite(fired) && Number.isFinite(session._windOut?.fired) ? Math.max(0, session._windOut.fired - fired) : null
    return { ok: true, why: flight.why, combat, ms: gameClock.now() - t0, windShots, nearTicks: near, closest: Number.isFinite(closest) ? Math.round(closest * 10) / 10 : null, landed: !!landed.ok, at: bot.entity.position.floored() }
  } finally { finishTerrain?.close(); vision.close() }
}
