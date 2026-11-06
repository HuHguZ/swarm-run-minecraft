'use strict'
// Прыжок на заряде ветра в точку (13.10, арена: «запрыгивать зарядами ветра на нужный блок, паркурить — я так с яруса
// Колизея на ярус снаружи над обрывом запрыгнул»). Механика 1.21.11 (mace.ts, PVP-RESEARCH б.8): заряд летит 1.5 б/т
// без гравитации, о блок — всплеск в точке удара + 0.25 по нормали; толчок (1 − |ноги − центр|/2.4)·1.22 по направлению
// «центр → глаза»; mineflayer прибавляет его к скорости (physics playerKnockback). План — перебор: разбег (с места,
// прыжок, спринт-прыжок 2–4 тика), тик броска, куда в пол (под ноги или за спину на 0.4–1.2), и честная физика тела
// (edges: simulatePlayer по миру бота) с рулём в воздухе к цели — до посадки. Годен вариант, где тело садится на
// выбранную опору с полной свободной рамкой и шестью тиками остановки. Исполнение — те же клавиши по тикам.
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import './game-clock'
import * as gameClock from './game-clock'
import edges = require('./edges')
import * as wind from './combat/team-wind'
import * as hands from './mace/hands'
import * as reflex from './reflex-lock'
import * as geometry from './navigation/geometry'
import { landingDamage } from './navigation/landing'
import { observedCollision } from './pvp/search'
import { windReleaseSafe } from './combat/wind-safety'
import { eyeOf } from './pick'

const EYE = 1.62
const LIFT = wind.WIND.surfaceOffset

const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z))

// Точка удара заряда о пол (верх твёрдого блока под (x,z) не ниже feetY − 3): центр всплеска чуть над гранью.
function floorBurst (bot, x, z, feetY) {
  for (let y = Math.floor(feetY); y >= Math.floor(feetY) - 3; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)), false)
    if (b && b.boundingBox === 'block') return new Vec3(x, y + 1 + LIFT, z)
  }
  return null
}

// Один вариант: разбег run (тиков спринта), jump, бросок на тике tThrow в пол за спиной на back бл.
function* simulation (bot, to, v) {
  const sim = edges.simOf(bot)
  const world = edges.worldOf(bot)
  const yaw = yawTo(bot.entity.position, to)
  const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
  const st = edges.cloneState(edges.stateOf(bot, edges.IDLE), edges.IDLE)
  st.yaw = yaw
  let burst = null; let boom = -1; let path = []; let lastMove = wind.windMovement(bot); let peak = st.pos.y; let settled = 0; let shot = null
  let handoffReady = !v.handoffAt
  for (let t = 0; t < 90; t++) {
    const ctrl: any = { ...edges.IDLE }
    if (t < v.run) { ctrl.forward = true; ctrl.sprint = true }
    if (v.jump && t === v.run) ctrl.jump = true
    if (t > v.run && boom < 0) { ctrl.forward = v.run > 0; ctrl.sprint = v.run > 0 }
    if (t === v.tThrow) {
      const B = floorBurst(bot, st.pos.x - dir.x * v.back, st.pos.z - dir.z * v.back, st.pos.y)
      if (!B) return null
      const eye = st.pos.offset(0, EYE, 0)
      const moved = new Vec3(lastMove.x, st.onGround ? 0 : lastMove.y, lastMove.z)
      shot = wind.windShot(bot, eye, B.offset(0, -LIFT, 0), moved)
      if (!shot || !wind.windInside(shot.impact, v.arena, 0)) return null
      burst = shot.burst; boom = t + shot.ticks
    }
    if (t === boom) {
      const impulse = wind.windImpulse(bot, st.pos, burst)
      if (impulse.norm() < .05) return null
      st.vel = st.vel.plus(impulse)
    }
    // После толчка — руль к цели: вперёд, пока не над ней.
    if (boom >= 0 && t > boom) {
      if (!handoffReady && !st.onGround && st.vel.y < 0) handoffReady = v.handoffAt(st.pos)
      const steering = wind.windSteer(bot, st, to, v.arena)
      st.yaw = steering.yaw; Object.assign(ctrl, steering.control)
    }
    st.control = ctrl
    const before = st.pos.clone(); sim(st, world); lastMove = st.pos.minus(before)
    peak = Math.max(peak, st.pos.y)
    if (t % 2 === 0) path.push({ x: +st.pos.x.toFixed(2), y: +st.pos.y.toFixed(2), z: +st.pos.z.toFixed(2) })
    if (st.isInLava || st.isInWater || !geometry.bodyClear(bot, st.pos) || !wind.windInside(st.pos, v.arena)) return null
    if (boom >= 0 && t > boom + 1 && st.onGround) {
      const off = Math.hypot(st.pos.x - to.x, st.pos.z - to.z)
      if (Math.abs(st.pos.y - to.y) > .03) return null
      const support = geometry.supportAt(bot, st.pos, .04)
      const fall = t - boom <= wind.WIND.forgivenessTicks ? Math.min(peak - st.pos.y, burst.y - st.pos.y) : peak - st.pos.y
      if (!support || landingDamage(support.block, fall, bot.entity.attributes) > 0) return null
      if (wind.windLanding(bot, st, to)) settled++; else settled = 0
      if (settled >= 6) return !handoffReady ? null : { ...v, land: st.pos.clone(), off, dy: st.pos.y - to.y, ticks: t, burst, boomTick: boom, yaw, path, shot, settled: true }
      if (t > boom + 8 && off > .8) return null
    }
    yield
  }
  return null
}
function simulate (bot, to, v) {
  const search = simulation(bot, to, v)
  for (;;) { const frame = search.next(); if (frame.done) return frame.value }
}

async function planAsync (bot, to, { arena = undefined, maxTries = Infinity }: any = {}) {
  if (!geometry.bodyClear(bot, to) || !geometry.supportAt(bot, to, .03) || !wind.windInside(to, arena)) return { best: null, tried: 0, near: null }
  const cache = edges.worldOf(bot)
  const observed = { ...bot, entity: { ...bot.entity, position: bot.entity.position.clone(), velocity: bot.entity.velocity.clone() }, blockAt: p => cache.getBlock(p) }
  let tried = 0, slice = performance.now() + 4
  for (const run of [0, 2, 3, 4]) for (const jump of [false, true]) {
    if (run > 0 && !jump) continue
    for (const dt of jump ? [1, 2, 3, 4, 5, 6] : [0]) for (const back of [0, .4, .8, 1.2]) {
      if (tried >= maxTries) return { best: null, tried, near: null }
      tried++
      const search = simulation(observed, to, { run, jump, tThrow: run + dt, back, arena })
      for (;;) {
        const frame = search.next()
        if (frame.done) { if (frame.value) return { best: frame.value, tried, near: null }; break }
        if (performance.now() >= slice) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now() + 4 }
      }
    }
  }
  return { best: null, tried, near: null }
}

// План: лучший вариант, садящийся на клетку цели (to — ноги на цели: центр клетки, y верха опоры).
function plan (bot, to, { arena = undefined, maxTries = Infinity, handoffAt = null }: any = {}) {
  if (!geometry.bodyClear(bot, to) || !geometry.supportAt(bot, to, .03) || !wind.windInside(to, arena)) return { best: null, tried: 0, near: null }
  const cache = edges.worldOf(bot)
  const observed = { ...bot, blockAt: p => cache.getBlock(p) }
  let tried = 0
  for (const run of [0, 2, 3, 4]) for (const jump of [false, true]) {
    if (run > 0 && !jump) continue
    for (const dt of jump ? [1, 2, 3, 4, 5, 6] : [0]) for (const back of [0, 0.4, 0.8, 1.2]) {
      const v = { run, jump, tThrow: run + dt, back, arena }
      if (tried >= maxTries) return { best: null, tried, near: null }
      tried++
      const r = simulate(observed, to, handoffAt ? { ...v, handoffAt } : v)
      if (r) return { best: r, tried, near: null }
    }
  }
  return { best: null, tried, near: null }
}

// Исполнение плана тик в тик. Итог: { ok, plan, land, off }.
// handoff() — на спуске отдать полёт вызывающему (засада жемчуга: булавой на точку появления), не доводя посадку.
async function leap (session, ctl, to, { dryRun = false, arena = undefined, handoff = null, handoffAt = null, canLaunch = null, observedStationary = false }: any = {}) {
  const bot = session.bot, body = bot.entity, owner = session.current
  const owns = () => session.bot === bot && bot.entity === body && session.current === owner && reflex.allowed(session)
  const canUse = () => owns() && !ctl.aborted && bot.health > 0 && !bot.usingHeldItem && (!canLaunch || canLaunch())
  const observed = () => ({ ...bot, blockAt: observedCollision(bot).blockAt })
  const stationary = () => {
    const moved = bot._ndLaunchMovement?.()
    return moved && Math.hypot(moved.x, moved.y, moved.z) < 1e-6 && bot.entity.onGround
  }
  const T = new Vec3(to.x, to.y, to.z)
  const offhand = hands.offWind(bot), wc0 = offhand ? null : hands.findItem(bot, 'wind_charge')
  if (!offhand && !wc0) return { ok: false, why: 'нет зарядов ветра' }
  if (!canUse()) return { ok: false, why: 'hands_busy' }
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  if (observedStationary && !stationary()) return { ok: false, why: 'moving_route_launch' }
  const p = observedStationary ? plan(observed(), T, { arena, maxTries: 4 }) : plan(bot, T, { arena, handoffAt })
  if (!p.best || dryRun) return { ok: !!p.best, why: p.best ? 'план' : 'не допрыгнуть', tried: p.tried, near: p.near, plan: p.best && { run: p.best.run, jump: p.best.jump, tThrow: p.best.tThrow, back: p.best.back, ticks: p.best.ticks, off: +p.best.off.toFixed(2) } }
  const v = p.best
  bot.pathfinder?.setGoal(null)
  if (!offhand) await bot.equip(wc0, 'hand')
  if (!canUse()) return { ok: false, why: 'hands_busy' }
  const dir = { x: -Math.sin(v.yaw), z: -Math.cos(v.yaw) }
  await bot.look(v.yaw, 0, true)
  let boom = -1; let settled = 0; let lastPos = bot.entity.position.clone(); let moved = wind.windMovement(bot)
  try {
    for (let t = 0; t < 95 && !ctl.aborted; t++) {
      if (observedStationary && !owns()) return { ok: false, why: 'route_owner_changed' }
      if (!wind.windInside(bot.entity.position, arena) || bot.health <= 0) return { ok: false, why: 'unsafe_actual_flight' }
      bot.clearControlStates()
      if (t < v.run) { bot.setControlState('forward', true); bot.setControlState('sprint', true) }
      if (v.jump && t === v.run) bot.setControlState('jump', true)
      if (t > v.run && boom < 0 && v.run > 0) { bot.setControlState('forward', true); bot.setControlState('sprint', true) }
      if (t === v.tThrow) {
        if (!canUse()) return { ok: false, why: 'hands_busy' }
        const pos = bot.entity.position
        const world = observedStationary ? observed() : bot
        const B = floorBurst(world, pos.x - dir.x * v.back, pos.z - dir.z * v.back, pos.y)
        if (!B) return { ok: false, why: 'некуда бросить' }
        const launchMovement = bot._ndLaunchMovement ? wind.windMovement(bot) : new Vec3(moved.x, bot.entity.onGround ? 0 : moved.y, moved.z)
        let actual = wind.windShot(world, eyeOf(bot), B.offset(0, -LIFT, 0), launchMovement)
        if (!actual) return { ok: false, why: 'actual_charge_ray_changed' }
        await bot.look(actual.yaw, actual.pitch, true)
        const fired = await new Promise<boolean>(resolve => edges.afterPacket(bot, () => {
          try {
            if (!canUse() || hands.windCooling(bot) || (offhand ? !hands.offWind(bot) : bot.heldItem?.name !== 'wind_charge')) return resolve(false)
            if (observedStationary) {
              if (!stationary()) return resolve(false)
              const fresh = simulate(observed(), T, v)
              if (!fresh?.shot || !windReleaseSafe(bot, fresh.shot, wind.windMovement(bot))) return resolve(false)
              actual = fresh.shot
            }
            wind.useWindAtAngle(bot, offhand, actual); bot.usingHeldItem = false; resolve(true)
          }
          catch { resolve(false) }
        }))
        if (!fired) return { ok: false, why: 'wind_release_interrupted' }
        boom = t + actual.ticks
        await bot.look(v.yaw, 0, true)
      }
      if (boom >= 0 && t > boom && handoff && bot.entity.velocity.y < 0 && handoff()) return { ok: true, handedOff: true }
      if (boom >= 0 && t > boom) {
        const pos = bot.entity.position
        const steering = wind.windSteer(bot, edges.stateOf(bot, edges.IDLE), T, arena)
        void bot.look(steering.yaw, 0, true).catch(() => {})
        for (const [key, value] of Object.entries(steering.control)) bot.setControlState(key, value)
        if (wind.windLanding(bot, { pos, vel: bot.entity.velocity, onGround: bot.entity.onGround }, T)) settled++; else settled = 0
        if (settled >= 6) break
      }
      await bot.waitForTicks(1)
      moved = bot.entity.position.minus(lastPos); lastPos = bot.entity.position.clone()
    }
  } finally { if (owns() && !bot.usingHeldItem) bot.clearControlStates() }
  const at = bot.entity.position
  const off = Math.hypot(at.x - T.x, at.z - T.z)
  return { ok: !ctl.aborted && settled >= 6 && wind.windLanding(bot, { pos: at, vel: bot.entity.velocity, onGround: bot.entity.onGround }, T), off: +off.toFixed(2), dy: +(at.y - T.y).toFixed(2), plan: { run: v.run, jump: v.jump, tThrow: v.tThrow, back: v.back, ticks: v.ticks, simOff: +v.off.toFixed(2) }, at: { x: +at.x.toFixed(2), y: +at.y.toFixed(2), z: +at.z.toFixed(2) } }
}

// К цели вверх уступами (арена: «с яруса Колизея на ярус запрыгнул»): клетки, где можно встать (пол, 3 воздуха над
// ним — дуга не в потолок), в 7 бл. по горизонтали и на 2–7 выше меня, ближе к цели хотя бы на 2 бл.; лучшие по
// близости к цели — по очереди план (до 10), первый годный — прыжок.
async function leapToward (session, ctl, goal, { dryRun = false, arena = undefined }: any = {}) {
  const bot = session.bot
  const G = new Vec3(goal.x, goal.y, goal.z)
  const me = bot.entity.position; const f = me.floored()
  const open = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'empty' && !/^(water|lava)$/.test(b.name) }
  const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'block' }
  const d0 = me.distanceTo(G)
  const cands = []
  for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
    if (dx * dx + dz * dz > 49 || (dx === 0 && dz === 0)) continue
    for (let dy = 2; dy <= 7; dy++) {
      const x = f.x + dx; const y = f.y + dy; const z = f.z + dz
      if (!solid(x, y - 1, z) || !open(x, y, z) || !open(x, y + 1, z) || !open(x, y + 2, z)) continue
      const c = new Vec3(x + 0.5, y, z + 0.5)
      const d = c.distanceTo(G)
      if (d < d0 - 2) cands.push({ c, d })
    }
  }
  cands.sort((a, b) => a.d - b.d)
  for (const k of cands.slice(0, 10)) {
    if (ctl.aborted) break
    const p = plan(bot, k.c, { arena })
    if (!p.best) continue
    if (dryRun) return { ok: true, why: 'план', to: k.c, closer: +(d0 - k.d).toFixed(1) }
    const r = await leap(session, ctl, k.c, { arena })
    return { ...r, to: { x: k.c.x, y: k.c.y, z: k.c.z }, closer: +(d0 - bot.entity.position.distanceTo(G)).toFixed(1) }
  }
  return { ok: false, why: cands.length ? 'ни на один уступ не допрыгнуть' : 'уступов ближе к цели нет', cands: cands.length }
}

export { plan, planAsync, leap, simulate, leapToward }
