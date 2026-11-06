'use strict'
// Элитры (elytra.ts): полёт — ракета на тик, лететь, взлёт, посадка, нагрудник назад.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { AsyncResource }: typeof import('node:async_hooks') = require('node:async_hooks')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { TICK_MS, HALF, ROCKET_MAX_TICKS, RESCUE_ROCKETS, KEYS, DEBUG, sleep, wrap, r2, nextTick }: typeof import('./consts') = require('./consts')
const { worldOf, rollout, headroom }: typeof import('./physics') = require('./physics')
const { offName, chestName, rocketCount, plainRocket, wearingElytra, toHotbar, swapChest }: typeof import('./kit') = require('./kit')
const { choose, returnInside }: typeof import('./control') = require('./control')
const { flightControl, install, steer, startGlide, fireRocket }: typeof import('./install') = require('./install')
import { rocketForecast } from './rocket-forecast'
import { ceilingExit } from './ceiling-exit'

// ---------------------------------------------------------------- полёт

// Ракета на этот тик: want — rocketIf (true «надо», false «нет», иначе — по выгоде). С ракетой — взгляд, посчитанный
// С ракетой, и только если лучший такой полёт не кончается стеной с уроном ≥ 1 (s7c3: 3 удара «таран: разбег» под
// ракетой, −9…−12: «надо» шла со взглядом, посчитанным без ракеты). { fire, yaw, pitch, c, veto }.
// S7d: без запрета — сравнение цен. «Надо» (низко/медленно) — ракета, если лучший полёт с ней не дороже лучшего без
// неё больше чем на 40 (удар о стену в цене полёта стоит 400 + 40·урон, так что ракета в стену проигрывает сама);
// необязательная — только если с ней заметно дешевле.
function rocketChoice (W, st, g, pl, want): any {
  if (want === false) return { fire: false }
  const withR = choose(W, st, g, { rocketNow: true })
  if (!withR) return { fire: false }
  const crash = withR.r.kind === 'wall' && withR.r.dmg >= 1
  const fire = { fire: true, ...withR }
  if (want === true) return withR.c <= pl.c + 40 ? fire : { fire: false, veto: crash }
  return withR.c < pl.c - 4 ? fire : { fire: false }
}

// Лететь, пока until() не скажет «хватит» (или сели, кончился полёт, время).
// goal() — цель этого тика; ракета — когда с ней прогноз заметно лучше или
// скорость/высота ниже нужной (rocketIf). Всё — на тике физики: взгляд этого
// тика двигает тело на следующем.
function fly (bot, ctl, { goal, until = null, maxMs = 15000, rocketIf = null, onTick = null, stats = null, noRocket = null, phase = null, arena = null, useReserve = false }: any = {}) {
  const W = worldOf(bot, { observed: !!arena })
  const S = install(bot)
  ctl = flightControl(bot, ctl)
  S.arenaBounds = arena
  return new Promise<any>(resolve => {
    const t0 = gameClock.now()
    let done = false
    let ticks = 0
    let planMs = 0
    const evasion = { lance: null }
    S.driving = (S.driving || 0) + 1
    const finish = (why) => {
      if (done) return
      done = true
      S.driving = Math.max(0, (S.driving || 1) - 1)
      bot.removeListener('physicsTick', onT)
      // Latch the actual contact: onGround may clear on the next zero-Y move.
      const ground = why === 'сел' && bot.entity?.onGround ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null
      resolve({ why, ground, ms: gameClock.now() - t0, ticks, planMs: ticks ? r2(planMs / ticks) : 0 })
    }
    // EventEmitter does not retain the launching tactical/skill hand lease.
    const onT = AsyncResource.bind(() => {
      const session = bot._ndReflexSession
      const hands: typeof import('../reflex-lock') = require('../reflex-lock')
      // An independent landing may outlive its launching intent, but never borrow another active lease.
      return session && !hands.owner(session) ? hands.run(session, ctl, step) : step()
    })
    const step = () => {
      if (done) return
      try {
        const b = bot.entity
        if (ctl.aborted || !b || (bot.health ?? 0) <= 0) return finish('прервали')
        const inside = !arena || (require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(b.position, arena, HALF)
        if (b.onGround) return finish('сел')
        if (b.isInWater) return finish('в воде')
        if (!b.elytraFlying && gameClock.now() - S.startedAt > 400) return finish('полёт кончился')
        if (gameClock.now() - t0 > maxMs) return finish('долго')
        if (until && inside) { const u = until(); if (u) return finish(u) }
        ticks++
        let g = typeof goal === 'function' ? goal() : goal
        if (!g) return finish('цели нет')
        if (arena) g = { ...g, arena }
        // Лук натянут на меня или стрела на подлёте — рывок вбок с ракетой: прямой полёт — лёгкая мишень (пользователь 25.10:
        // «на элитрах не уворачиваются от стрел, должны летать активнее и быстро»). Сторона меняется каждые 0.6 с — «змейка».
        const landing = g.kind === 'land'
        const jink = (g.kind === 'point' || landing) && dodgeSide(bot, b, !landing, evasion)
        if (jink) {
          const at0 = g.at, shift = q => new Vec3(q.x + jink.x * 5, q.y, q.z + jink.z * 5)
          g = { ...g, ...(g.kind === 'land' ? { kind: 'point', gap: 3 } : {}), at: jink.at || (typeof at0 === 'function' ? t => shift(at0(t)) : shift(at0)) }
        }
        S.phase = phase || g.kind
        const st = { p: b.position, v: b.velocity, ...rocketForecast(bot), fd: landing ? Math.max(S.fd, S.moveFd || 0) : S.fd }
        const tp = gameClock.wall.now()
        let pl = inside ? choose(W, st, g) : null
        const returning = !pl && !!arena
        if (returning) { pl = returnInside(W, st, arena); if (pl) g = pl.goal; S.phase = 'возврат в арену' }
        if (!pl) return finish('no_safe_arena_trajectory')
        let fire = false
        if (!(noRocket && noRocket()) && !(bot.fireworkRocketDuration > 0) && rocketCount(bot) > (useReserve ? 0 : RESCUE_ROCKETS)) {
          const want = jink ? true : rocketIf ? rocketIf(st, pl, g) : false
          const rc = rocketChoice(W, st, g, pl, want)
          if (rc.fire) { fire = true; pl = { ...pl, ...rc } } else if (rc.veto && stats) stats.rocketVeto = (stats.rocketVeto || 0) + 1
        }
        planMs += gameClock.wall.now() - tp
        S.lastPlan = { c: r2(pl.c), k: pl.r.kind, t: pl.r.t, fd: r2(pl.r.fd), vyHit: pl.r.vyHit == null ? null : r2(pl.r.vyHit), gx: r2(typeof g.at === 'function' ? g.at(0).x : g.at.x), gz: r2(typeof g.at === 'function' ? g.at(0).z : g.at.z) }
        // Диагностика S7d: план без события, а стена по ходу в ≤ 4 бл. — входы плана целиком в лог (повтор офлайн).
        if (!pl.r.kind && (S.planMiss || 0) < 6) {
          const hs = Math.hypot(b.velocity.x, b.velocity.z)
          if (hs > 0.8) {
            const ux = b.velocity.x / hs; const uz = b.velocity.z / hs
            let wd = null
            for (let d = 1; d <= 4 && wd == null; d++) if (W.at(Math.floor(b.position.x + ux * d), Math.floor(b.position.y + 0.3), Math.floor(b.position.z + uz * d)) === 1) wd = d
            if (wd != null) {
              S.planMiss = (S.planMiss || 0) + 1
              const rr = rollout(W, st.p, st.v, pl.yaw, pl.pitch, st.boost, 18, { fd: st.fd, keepPath: true })
              console.log('[elytra-plan-miss]', JSON.stringify({ wd, p: [st.p.x, st.p.y, st.p.z], v: [st.v.x, st.v.y, st.v.z], yaw: pl.yaw, pitch: pl.pitch, boost: st.boost, fd: st.fd, c: pl.c, kind: pl.r.kind, again: rr.kind, againT: rr.t, path: (rr.path || []).slice(0, 6).map(q => [r2(q.x), r2(q.y), r2(q.z)]), g: { kind: g.kind, at: typeof g.at === 'function' ? g.at(0) : g.at, minY: g.minY, maxY: g.maxY } }))
            }
          }
        }
        steer(bot, pl.yaw, pl.pitch)
        if (fire && (useReserve || rocketCount(bot) > RESCUE_ROCKETS)) {
          const fr = fireRocket(bot)
          if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1
        }
        if (onTick && !returning) onTick(pl, st)
        if (DEBUG && ticks % 5 === 0) console.log('[elytra]', JSON.stringify({ t: ticks, kind: g.kind, p: [r2(b.position.x), r2(b.position.y), r2(b.position.z)], v: [r2(b.velocity.x), r2(b.velocity.y), r2(b.velocity.z)], yaw: r2(pl.yaw), pitch: r2(pl.pitch), c: r2(pl.c), ev: pl.r.kind, fw: bot.fireworkRocketDuration, fd: r2(S.fd) }))
      } catch (e) { finish('ошибка: ' + e.message) }
    }
    bot.on('physicsTick', onT)
  })
}

// От тарана/булавы в ближайшие 12 тиков, иначе — линии стрелы или натянутого лука.
function dodgeSide (bot, b, arrows, memory) {
  let d
  try {
    const threats: typeof import('../threats') = require('../threats'), scope = { foes: bot._ndFoes ?? null }
    const glider = threats.incomingGliders(bot, scope).find(p => p.kind === 'lance' && p.ticks <= 12 && p.side)
    // Сдвиг далёкой цели едва меняет курс; от копья сначала уходим в ближнюю боковую точку.
    if (glider) {
      const raw = bot.entities?.[glider.id], previous = memory.lance, side = { ...glider.side }
      if (previous?.raw === raw && previous.side.x * side.x + previous.side.z * side.z < 0) { side.x *= -1; side.z *= -1 }
      const relative = { x: glider.vel.x - b.velocity.x, y: glider.vel.y - b.velocity.y, z: glider.vel.z - b.velocity.z }
      memory.lance = { raw, from: { ...glider.from }, vel: { ...glider.vel }, relative, side, at: gameClock.now() }
      return { ...side, at: b.position.offset(side.x * 5, 0, side.z * 5) }
    }
    const episode = memory.lance
    if (episode) {
      const raw = episode.raw, age = (gameClock.now() - episode.at) / TICK_MS
      const valid = raw && bot.entities?.[raw.id] === raw && raw.isValid !== false &&
        (scope.foes === null || scope.foes.includes(raw.username)) &&
        !(require('../combat/ally-safety') as typeof import('../combat/ally-safety')).isAlly(bot, raw)
      const landed = valid && (require('../pvp/last-seen') as typeof import('../pvp/last-seen')).seesPlayer(bot, raw) &&
        !(require('./track') as typeof import('./track')).gliding(raw)
      // shortcut: coast the last visible velocity for the existing 24-tick horizon; use a fresh path if traces show turns during gaps.
      const ahead = (b.position.x - episode.from.x - episode.vel.x * age) * episode.relative.x +
        (b.position.y - episode.from.y - episode.vel.y * age) * episode.relative.y +
        (b.position.z - episode.from.z - episode.vel.z * age) * episode.relative.z
      if (valid && !landed && age >= 0 && age <= 24 && ahead > 0) {
        const side = episode.side
        if (process.env.ND_GLIDER_TRACE === '1' && !episode.logged) {
          episode.logged = true
          console.log('[glider-trace]', JSON.stringify({ event: 'flight_hold', id: raw.id, ageTicks: age, ahead: r2(ahead), side }))
        }
        return { ...side, at: b.position.offset(side.x * 5, 0, side.z * 5) }
      }
      memory.lance = null
    }
    // The ground shield reflex cannot turn an owned glider. Keep its pilot and
    // safe trajectory selection, but leave a visible descending strike point.
    const smash = threats.smashes(bot, scope.foes ?? []).find(p => p.ticks <= 12)
    if (smash) {
      const dx = b.position.x - smash.at.x, dz = b.position.z - smash.at.z, n = Math.hypot(dx, dz)
      const side = n ? { x: dx / n, z: dz / n } : { x: -Math.sin(b.yaw), z: -Math.cos(b.yaw) }
      return { ...side, at: b.position.offset(side.x * 5, 0, side.z * 5) }
    }
    if (!arrows) return null
    d = threats.projectileDangers(bot, scope)
  } catch { memory.lance = null; return null }
  const shot = (d.arrows || []).filter(p => p.ticks <= 12 && p.from).sort((x, y) => x.ticks - y.ticks)[0]
  const src = shot?.from || (d.aims || []).find(a => a.at && b.position.distanceTo(a.at) <= 40)?.at
  if (!src) return null
  const dx = b.position.x - src.x, dz = b.position.z - src.z, n = Math.hypot(dx, dz) || 1
  const flip = Math.floor(gameClock.now() / 600) % 2 ? 1 : -1
  return { x: -dz / n * flip, z: dx / n * flip, at: null }
}

// Взгляд взлёта (S7d, колизей с рельефом s7d-n-30: 5 ударов о стену на взлёте, −0.6…−6.8): от «раскрыть» до
// первого руля fly — до 12 тиков под ракетой без руля, а взлёт шёл по заказанному взгляду (бой — 0.45 рад., к нему)
// прямо в уступ в 2 бл. Прогон 14 тиков с ракетой по кандидатам: заказанный, круче, в сторону — первый чистый по цене
// отклонения; чистого нет — тот, где удар позже.
function launchLook (W, p, yaw0, pitch0, v = null, arena = null) {
  // С земли — прыжок (раскрыть на подъёме, ~0.3 выше, v.y 0.3); в воздухе — как есть (ревью Codex).
  const p1 = v ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y + 0.3, z: p.z }
  const v1 = v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0.3, z: 0 }
  let best = null
  for (const dp of [0, 0.35, 0.6, 0.85]) {
    const pitch = Math.min(1.45, pitch0 + dp)
    for (const o of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.35, -1.35, 2, -2, Math.PI]) {
      const yaw = wrap(yaw0 + o)
      const r = rollout(W, p1, v1, yaw, pitch, ROCKET_MAX_TICKS, 14, { arena })
      if (r.kind === 'outside') continue
      const bad = (r.kind === 'wall' && r.dmg >= 0.5) || r.kind === 'floor' || (r.kind === 'ceil' && r.t < 8)
      const c = (bad ? 1000 - r.t * 20 : 0) + Math.abs(o) * 2 + dp * 3
      if (!best || c < best.c) best = { c, yaw, pitch, bad, kind: r.kind, t: r.t }
    }
  }
  return best
}

// Взлёт: элитры на теле, прыжок, в воздухе — «раскрыть», взгляд вверх и
// фейерверк. Отказ — с причиной (потолок, воды, нет ракет).
async function takeoff (bot, ctl, { pitch = 1.0, yaw = null, stats = null, liquidStart = false, arena = null, useReserve = false }: any = {}) {
  ctl = flightControl(bot, ctl)
  if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
  const W = worldOf(bot, { observed: !!arena })
  install(bot).arenaBounds = arena
  const b = bot.entity
  if (!b) return { ok: false, why: 'нет тела' }
  if (arena && !(require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(b.position, arena, HALF)) return { ok: false, why: 'outside_arena' }
  if (b.isInWater) return { ok: false, why: 'в воде' }
  const fromLava = liquidStart && !!b.isInLava
  if (!fromLava && b.onGround && headroom(W, b.position, 6) < 4) {
    // Под крышей (галереи Колизея, стенд ветра 25.10: «над головой блок» раз за разом) — шаг к ближайшему открытому небу, оттуда взлёт.
    const sky = skyCell(W, b.position, arena)
    if (!sky || !bot.pathfinder) return { ok: false, why: 'над головой блок, неба в 10 бл. нет' }
    const walked = await walkToCell(bot, ctl, sky, 1500 + 600 * sky.distanceTo(b.position))
    if (!walked || ctl.aborted) return { ok: false, why: 'над головой блок, до неба не дошёл' }
    if (!bot.entity.onGround || headroom(W, bot.entity.position, 6) < 4) return { ok: false, why: `над головой блок и у неба (${sky.x},${sky.y},${sky.z})` }
  }
  if (fromLava && !lavaLaunchClear(bot)) return { ok: false, why: 'над головой блок' }
  if (!rocketCount(bot)) return { ok: false, why: 'фейерверков нет' }
  if (!useReserve && rocketCount(bot) <= RESCUE_ROCKETS) return { ok: false, why: `ракет ${rocketCount(bot)} — запас на спасение` }
  if (!wearingElytra(bot)) {
    const s = await swapChest(bot, 'elytra', { hand: offName(bot) === 'elytra' ? 'off' : 'main', ctl })
    if (!s.ok) return { ok: false, why: 'элитры не надел: ' + s.why }
  }
  // Взгляд взлёта — по прогону (launchLook): заказанный, если он чист.
  let lYaw = wrap(yaw ?? b.yaw)
  let lPitch = pitch
  if (!fromLava) {
    const ll = launchLook(W, b.position, lYaw, pitch, b.onGround ? null : b.velocity, arena)
    if (arena && !ll) return { ok: false, why: 'no_safe_arena_launch' }
    if (ll && (Math.abs(ll.yaw - lYaw) > 1e-6 || ll.pitch !== pitch)) { lYaw = ll.yaw; lPitch = ll.pitch; if (stats) stats.launchTurns = (stats.launchTurns || 0) + 1 }
  }
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  const y0 = b.position.y
  if (b.onGround) {
    await nextTick(bot)
    try { bot.setControlState('jump', true) } catch {}
    await nextTick(bot)
    try { bot.setControlState('jump', false) } catch {}
  }
  // В воздухе: подъём прыжка ещё идёт — «раскрыть» сейчас.
  for (let i = 0; i < 4 && bot.entity.onGround; i++) await nextTick(bot)
  if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
  if (bot.entity.onGround) return { ok: false, why: 'не оторвался от земли' }
  if (!startGlide(bot)) return { ok: false, why: 'не раскрыл элитры' }
  install(bot).phase = 'взлёт'
  await steer(bot, lYaw, lPitch)
  if (!plainRocket(bot.inventory.slots[45])) await toHotbar(bot, plainRocket)
  await nextTick(bot)
  if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
  let launch = rollout(W, bot.entity.position, bot.entity.velocity, lYaw, lPitch, ROCKET_MAX_TICKS, 14, { arena })
  // Jump, knockback or fresh geometry may invalidate the course chosen before the awaited body tick.
  if (!fromLava && launch.kind) {
    const ll = launchLook(W, bot.entity.position, lYaw, lPitch, bot.entity.velocity, arena)
    if (ll) {
      lYaw = ll.yaw; lPitch = ll.pitch
      await steer(bot, lYaw, lPitch)
      launch = rollout(W, bot.entity.position, bot.entity.velocity, lYaw, lPitch, ROCKET_MAX_TICKS, 14, { arena })
    }
  }
  if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
  if (launch.kind === 'outside') return { ok: false, why: 'no_safe_arena_launch' }
  const fr = fireRocket(bot)
  if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1
  // Сервер подтвердил полёт (метаданные) и ракету (сущность прицепилась).
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 600 && !ctl.aborted && !(bot.fireworkRocketDuration > 0)) await nextTick(bot)
  if (fromLava) {
    try {
      bot.setControlState('jump', true)
      const liftAt = gameClock.now()
      while (!ctl.aborted && bot.health > 0 && bot.entity.isInLava && gameClock.now() - liftAt < 1500) {
        if (!lavaLaunchClear(bot)) return { ok: false, why: 'проход из лавы перекрыт' }
        if (!bot.entity.elytraFlying) startGlide(bot)
        await bot.look(yaw ?? bot.entity.yaw, 1.2, true).catch(() => {})
        await nextTick(bot)
      }
      if (ctl.aborted || bot.entity.isInLava) return { ok: false, why: 'не вышел из лавы под тягой ракеты' }
    } finally { bot.setControlState('jump', false) }
  }
  if (stats) stats.takeoffs = (stats.takeoffs || 0) + 1
  return { ok: !!bot.entity.elytraFlying, rocket: bot.fireworkRocketDuration > 0, dy: r2(bot.entity.position.y - y0), why: bot.entity.elytraFlying ? null : 'сервер не дал лететь' }
}

// Ближайшая клетка в 10 бл. (по высоте ±2): пол под ногами, тело свободно, над головой 4+ бл. воздуха, внутри арены.
function skyCell(W, p, arena) {
  const tw: typeof import('../combat/team-wind') = require('../combat/team-wind')
  const x0 = Math.floor(p.x), y0 = p.y, z0 = Math.floor(p.z)
  let best = null, bd = Infinity
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    if (Math.hypot(dx, dz) >= bd || Math.hypot(dx, dz) > 10) continue
    const f = W.floorBelow(x0 + dx + .5, y0 + 2, z0 + dz + .5, 4)
    if (!f || f.lava || f.top < y0 - 2) continue
    const c = new Vec3(x0 + dx + .5, f.top, z0 + dz + .5), d = Math.hypot(dx, dz) + Math.abs(f.top - y0)
    // Небо и над соседями: дошедший стоит не точно в центре, рамка 0.6 у края крыши задевает навес (стенд 25.10: «у неба» — снова блок).
    if (d >= bd || W.boxHit(c.x, c.y + .01, c.z) || [[0, 0], [.7, 0], [-.7, 0], [0, .7], [0, -.7]].some(([ox, oz]) => headroom(W, c.offset(ox, 0, oz), 6) < 4)) continue
    if (arena && !tw.windInside(c, arena, HALF)) continue
    best = c; bd = d
  }
  return best
}

async function walkToCell(bot, ctl, at, ms) {
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  let timer: unknown = null
  try {
    // Pathfinder represents standing on a partial block by the grid cell above it.
    await Promise.race([bot.pathfinder.goto(new goals.GoalNear(Math.floor(at.x), Math.ceil(at.y), Math.floor(at.z), .5)),
      new Promise((_, reject) => { timer = gameClock.setTimeout(() => reject(new Error('timeout')), ms) })])
    return !ctl.aborted
  } catch { try { bot.pathfinder.setGoal(null) } catch {} ; return false } finally { if (timer) gameClock.clearTimeout(timer) }
}

function lavaLaunchClear(bot) {
  const p = bot.entity.position
  let air = 0
  for (let dy = 0; dy < 8; dy++) {
    for (const [dx, dz] of [[-.3, -.3], [-.3, .3], [.3, -.3], [.3, .3]]) {
      const block = bot.blockAt(new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz)))
      if (!block || block.boundingBox === 'block' || /water|bubble_column/.test(block.name)) return false
      if (block.name !== 'lava' && block.boundingBox !== 'empty') return false
    }
    if (bot.blockAt(p.offset(0, dy, 0).floored())?.name !== 'lava') air++
  }
  return air >= 4
}

// Точка посадки: твёрдый пол 5×5 без пустоты рядом, как можно ближе к near и
// дальше от away. Перебор по кольцам вокруг near.
function landingSpot (bot, W, { near, away = null, floorY = null, radius = 20, minFromAway = 0, inside = null, depth = 14, minFloorY = -Infinity }: any = {}) {
  let best = null
  const y0 = floorY != null ? floorY : near.y
  for (let r = 0; r <= radius; r += 2) {
    const n = Math.max(1, Math.round(r * 1.5))
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2
      const x = Math.floor(near.x + Math.sin(a) * r) + 0.5
      const z = Math.floor(near.z + Math.cos(a) * r) + 0.5
      if (inside && !inside(x, z)) continue
      const f = W.floorBelow(x, y0 + 6, z, depth)
      if (!f || f.lava || f.water || f.top < minFloorY) continue
      let ok = true
      for (let dx = -2; dx <= 2 && ok; dx++) {
        for (let dz = -2; dz <= 2 && ok; dz++) {
          const g = W.floorBelow(x + dx, f.top + 0.5, z + dz, 4)
          if (!g || g.lava || g.water || g.top < minFloorY || Math.abs(g.top - f.top) > 1) ok = false
        }
      }
      if (!ok || W.boxHit(x, f.top, z) || headroom(W, new Vec3(x, f.top, z), 4) < 3) continue
      const da = away ? Math.hypot(x - away.x, z - away.z) : 0
      if (away && da < minFromAway) continue
      const sc = r - (away ? Math.min(30, da) * 0.6 : 0)
      if (!best || sc < best.sc) best = { sc, at: new Vec3(x, f.top, z) }
    }
    if (best && r >= 6) break
  }
  return best ? best.at : null
}

// Посадка: планирование к точке пола, касание с v.y > −0.5 (высота падения ≤ 1
// — без урона), не в пустоту и не у самого края. Без полного плана сравниваем и тягу.
async function land (bot, ctl, { at = null, away = null, maxMs = 12000, stats = null, arena = null, maxFallDamage = 0 }: any = {}) {
  ctl = flightControl(bot, ctl)
  if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
  const W = worldOf(bot, { observed: !!arena })
  const b = bot.entity
  const inside = () => !arena || (require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(bot.entity.position, arena, HALF)
  if (b && !inside()) {
    if (b.elytraFlying) await fly(bot, ctl, { arena, stats, maxMs, noRocket: () => true,
      goal: () => ({ kind: 'point', at: new Vec3(arena.x, bot.entity.position.y, arena.z), gap: 3 }),
      until: () => inside() ? 'вернулся' : null })
    if (!inside()) return { ok: false, why: 'outside_arena' }
  }
  if (!b || !b.elytraFlying) return { ok: !!(b && b.onGround), why: 'не лечу' }
  let spot = at || landingSpot(bot, W, { near: b.position, away, floorY: null, inside: arena ? (x, z) => Math.abs(x - arena.x) + HALF <= arena.r && Math.abs(z - arena.z) + HALF <= arena.r : null })
  if (!spot) {
    const f = W.floorBelow(b.position.x, b.position.y, b.position.z, 60)
    spot = f ? new Vec3(b.position.x, f.top, b.position.z) : null
  }
  if (!spot) return { ok: false, why: 'сесть некуда' }
  if (arena && !(require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(spot, arena, HALF)) return { ok: false, why: 'outside_arena' }
  const hp0 = bot.health ?? 20
  const edge = (p) => {
    for (const [dx, dz] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const f = W.floorBelow(p.x + dx, p.y + 0.5, p.z + dz, 4)
      if (!f || f.lava) return true
    }
    return false
  }
  let exit: ReturnType<typeof ceilingExit> = null
  const r: any = await fly(bot, ctl, {
    phase: 'посадка',
    goal: () => {
      const me = bot.entity.position
      if (me.y < spot.y && !exit) exit = ceilingExit(W, me, p => !arena || (require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(p, arena, HALF))
      const cruiseY = Math.max(me.y, spot.y) + 4
      const detour = exit?.(me, spot.y, cruiseY, Number.isFinite(arena?.killY) ? arena.killY + 1 : -Infinity)
      if (detour) return detour
      if (me.y < spot.y) return { kind: 'point', at: new Vec3(spot.x, cruiseY, spot.z), minY: spot.y }
      exit = null
      return { kind: 'land', at: spot, away, edge, maxFallDamage }
    },
    maxMs,
    rocketIf: (_st, _plan, goal) => goal.kind === 'point',
    useReserve: true,
    arena,
    stats
  })
  // Скольжение после касания (трение) — рефлекс края держит от ям.
  await sleep(150)
  const lost = Math.max(0, hp0 - (bot.health ?? 20))
  if (stats) { stats.landings = (stats.landings || 0) + 1; if (lost > 0.5) stats.landDmg = r2((stats.landDmg || 0) + lost) }
  return { ok: !!(bot.entity.onGround || r.ground) && inside() && !ctl.aborted && (bot.health ?? 0) > 0,
    why: r.why, ground: r.ground, lost: r2(lost), at: spot }
}

// Нагрудник назад — только внизу (S7c, а): свап в воздухе гасит полёт, и тело падает с высоты («fell from a
// high place»). Летит — посадка (до двух попыток); падает без полёта высоко над полом — снова раскрыть и сесть;
// на земле или в воде (или пол в 1.2 бл. и v.y > −0.5) — свап.
async function chestDown (bot, ctl, { stats = null, away = null, at = null, arena = null }: any = {}) {
  const W = worldOf(bot)
  const low = () => {
    const b = bot.entity
    if (!b) return true
    if (b.onGround || b.isInWater) return true
    const f = W.floorBelow(b.position.x, b.position.y, b.position.z, 6)
    return !!f && b.position.y - f.top < 1.2 && b.velocity.y > -0.5
  }
  const landCtl = flightControl(bot, ctl, true)
  for (let i = 0; i < 3 && !landCtl.aborted && !low(); i++) {
    if (bot.entity.elytraFlying) { await land(bot, landCtl, { at: i === 0 ? at : null, away, stats, arena }); continue }
    const f = W.floorBelow(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z, 40)
    if (f && bot.entity.position.y - f.top > 3.5 && wearingElytra(bot) && startGlide(bot)) { if (stats) stats.reglide = (stats.reglide || 0) + 1; continue }
    const t0 = gameClock.now()
    while (!low() && !landCtl.aborted && gameClock.now() - t0 < 3000) await sleep(TICK_MS)
  }
  if (landCtl.aborted) return { ok: false, why: 'flight_superseded' }
  if (/_chestplate$/.test(chestName(bot) || '')) return { ok: true, already: true }
  if (!low()) { if (stats) stats.chestAir = (stats.chestAir || 0) + 1; return { ok: false, why: 'не сел — нагрудник не меняю в воздухе' } }
  return swapChest(bot, 'chest', { hand: /_chestplate$/.test(offName(bot) || '') ? 'off' : 'main', ctl: landCtl })
}

export {
  rocketChoice, fly, launchLook, takeoff, lavaLaunchClear, landingSpot, land, chestDown, skyCell
}
