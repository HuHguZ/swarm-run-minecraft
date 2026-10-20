'use strict'
// Сторож блочного клатча — прогноз тика (context: посадка, вода, исключения для decide) и спасение в воду/на мягкий пол
// рядом (waterStep: план parkour, шаги по тикам).
import { IDLE, copyState } from './blocks'
import { type ClutchGuard, available, controls, climbing, emit, releaseSteering } from './guard-state'

function intentional (g: ClutchGuard, s) {
  const { opts, session, bot, st } = g
  if (!opts.mlgDrop || !opts.mlgDrop(session).ok || !bot.pathfinder?.isMoving?.()) return false
  return st.path.some((p, i) => {
    const q = st.path[i + 1]
    return q && p.y - q.y >= 6 && s.pos.y <= p.y + 1.3 && s.pos.y >= q.y &&
      Math.hypot(s.pos.x - (p.x + 0.5), s.pos.z - (p.z + 0.5)) <= 1.7 &&
      Math.hypot(s.pos.x - (q.x + 0.5), s.pos.z - (q.z + 0.5)) <= 1.7
  })
}
function context (g: ClutchGuard, s) {
  const { bot, st, opts, session, api, world, simulate, now } = g
  const marker = bot._ndParkourForecast
  // Physics listeners can run before or after the movement controller has
  // advanced its marker to the next native tick. Both observed endpoints
  // belong to that one verified transition; drift and damage still revoke it.
  const guardAllow = now() < (bot._ndClutchAllowUntil || 0) || !!(marker && marker.until > now() && bot.health >= marker.hp &&
    Math.min(s.pos.distanceTo(marker.from), marker.next ? s.pos.distanceTo(marker.next) : Infinity) <= .1)
  // Supported movement needs no airborne rescue. A verified native skill
  // already owns its trajectory; reforecasting it at750TPS starves the clock.
  // An active water rescue still needs actual fluid/landing observations.
  const predict = !!st.waterPlan || !s.onGround && !guardAllow
  const forecast = copyState(s, s.control)
  let ticksToWater = Infinity; let settled = false
  for (let t = 0; predict && t < 24; t++) {
    simulate(forecast, world)
    if (forecast.isInWater || forecast.isInLava) { settled = true; break }
    if (forecast.onGround) {
      // A brief edge contact still carries horizontal momentum. Forecast the
      // neutral braking after contact before calling this a safe landing;
      // otherwise the guard omits its own necessary second support block.
      forecast.control = { ...IDLE }
      if (forecast.vel.x === 0 && forecast.vel.z === 0) { settled = true; break }
    }
  }
  const l: any = predict ? api.landing(forecast, world) : { top: s.onGround ? s.pos.y : -Infinity, unknown: !s.onGround, water: !!s.isInWater, lava: !!s.isInLava }
  // column's depth limit is relative to this tick's feet, not the forecast
  // after it has already reached a distant water surface.
  if (l.water) l.deep = Math.floor(s.pos.y) - Math.floor(l.top - 1) > 12
  if (opts.mlgLandingBad && l.cell && !l.lava) l.bad = !!opts.mlgLandingBad(bot, l.cell.x, l.cell.y, l.cell.z)
  if (predict && Number.isFinite(l.top)) {
    const probe = copyState(s, s.control)
    for (let t = 0; t < 24; t++) {
      if (probe.pos.y > l.top && probe.pos.y + 1.62 <= l.top + 4.5) { ticksToWater = t; break }
      simulate(probe, world)
      if (probe.onGround) break
    }
  }
  const ready = bot.inventory.slots.slice(36, 45).some(i => i?.name === 'water_bucket') && (!bot._ndFallGuard?.barAt || now() - bot._ndFallGuard.barAt >= 300)
  const next = copyState(s); if (predict) simulate(next, world)
  return { landing: l, peak: st.peak, feet: s.pos.y, blocks: available(g) ? 1 : 0, hp: bot.health, minFall: opts.waterMinFall ?? 6, waterEligible: !!bot._ndFallGuard,
    ground: !!s.onGround, elytra: !!(s.elytraFlying || bot.entity?.elytraFlying), riding: !!bot.vehicle,
    slowFalling: (s.slowFalling || 0) > 0, levitation: (s.levitation || 0) > 0, climbing: climbing(g, s.pos) || !!s.isInWeb,
    mode: bot.game?.gameMode, dimension: bot.game?.dimension, dead: bot.health <= 0,
    dragon: session.current?.name === 'dragon', swimming: s.isInWater, lava: s.isInLava, mace: !!(bot._ndDescend || bot._ndSmashNow),
    wind: !!bot._ndWindFall?.(l.top), waterPlaced: !!bot._ndFallGuard?.placed,
    intentional: intentional(g, s), guardAllow,
    hasBucketBar: ready, ticksToWater, waterTooLate: settled && next.onGround && s.pos.y + 1.62 > l.top + 4.5,
    ...(opts.context ? opts.context({ state: s, landing: l, peak: st.peak, guard: st }) : {}) }
}
function waterStep (g: ClutchGuard, s, ctx, decision) {
  const { bot, st, stats, opts } = g
  const parkour = () => require('../navigation/parkour') as typeof import('../navigation/parkour')
  let own = st.waterPlan
  if (!own && !st.waterAttempted && opts.existingWater !== false && decision.why !== 'excluded' && decision.why !== 'unknown_world' && !ctx.ground && s.vel.y < -.08 &&
      (ctx.landing.deep || ctx.landing.lava || !Number.isFinite(ctx.landing.top) || ctx.peak - ctx.landing.top > 3)) {
    st.waterAttempted = true
    const began = performance.now(); const plan = parkour().planNearbyWaterEntry(bot, ctx.landing.waterCell)
    if (plan) {
      own = st.waterPlan = { plan, index: 0, hp: bot.health }
      stats.water_plans++; emit(g, 'water_plan', { target: plan.target, ticks: plan.ticks, planningMs: performance.now() - began })
    } else if (process.env.ND_SOFT_LANDING === '1') {
      // No water: steer onto a nearby floor that hurts less (hay/honey/slime), when
      // it beats the floor straight below. Off by default until a native series.
      const soft = parkour().planNearbySoftLanding(bot, ctx.peak)
      if (soft) {
        own = st.waterPlan = { plan: soft, index: 0, hp: bot.health, soft: soft.damage }
        stats.soft_plans++; emit(g, 'soft_plan', { target: soft.target, ticks: soft.ticks, damage: soft.damage, planningMs: performance.now() - began })
      }
    }
  }
  if (!own) return null
  const excluded = ctx.dead || ctx.lava || ctx.elytra || ctx.riding || ctx.mace || ctx.wind || ctx.dragon || ctx.guardAllow || ctx.mode === 'creative' || ctx.mode === 'spectator'
  const expected = own.index ? own.plan.states[own.index - 1] : null
  const allowed = own.soft ?? 0
  if (excluded || bot.health < own.hp - allowed || expected && s.pos.distanceTo(expected.pos) > .65) {
    stats[own.soft !== undefined ? 'soft_failed' : 'water_failed']++; emit(g, own.soft !== undefined ? 'soft_failed' : 'water_failed', { target: own.plan.target, at: s.pos, ticks: own.index, why: excluded ? 'owner_changed' : bot.health < own.hp - allowed ? 'hurt' : 'physics_diverged' })
    st.waterPlan = null; releaseSteering(g); return null
  }
  if (own.index >= own.plan.steps.length) {
    const soft = own.soft !== undefined
    const ok = soft ? s.onGround && Math.hypot(s.pos.x - own.plan.target.x, s.pos.z - own.plan.target.z) < .35 && Math.abs(s.pos.y - own.plan.target.y) < .03 && bot.health >= own.hp - allowed
      : parkour().inWaterCell(bot, s, own.plan.target) && bot.health >= own.hp && Math.hypot(s.vel.x, s.vel.z) < .04
    const kind = soft ? 'soft' : 'water'
    stats[`${kind}_${ok ? 'saved' : 'failed'}`]++; emit(g, `${kind}_${ok ? 'saved' : 'failed'}`, { target: own.plan.target, at: s.pos, hp: bot.health, ticks: own.index })
    st.waterPlan = null; releaseSteering(g)
    return ok ? { action: 'none', why: soft ? 'soft_floor_landed' : 'existing_water_landed' } : null
  }
  const step = own.plan.steps[own.index++]
  const previous = st.steering?.previous || controls(g)
  bot.look(step.yaw, 0, true)?.catch?.(() => {})
  for (const [k, v] of Object.entries(step.control)) bot.setControlState?.(k, v)
  st.steering = { yaw: step.yaw, control: step.control, previous }
  return { action: 'clutch', why: own.soft !== undefined ? 'soft_floor' : 'existing_water' }
}

export { intentional, context, waterStep }
