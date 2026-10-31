'use strict'
// Элитры (elytra.ts): установка на бота (руль, чёрный ящик), руль, раскрыть элитры, фейерверк, стены вокруг.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { AsyncLocalStorage }: typeof import('node:async_hooks') = require('node:async_hooks')
const steering = new AsyncLocalStorage<object>()
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { BODY_H, ROCKET_MAX_TICKS, GUARD, r2 }: typeof import('./consts') = require('./consts')
const { lookVec, worldOf, rollout, headroom }: typeof import('./physics') = require('./physics')
import { rocketForecast } from './rocket-forecast'
const { plainRocket, wearingElytra }: typeof import('./kit') = require('./kit')
const { choose, returnInside }: typeof import('./control') = require('./control')

// Установка на бота (раз): фейерверк тянет, пока его сущность жива (как у
// клиента игры), высота падения по правилам сервера (для прогноза посадки),
// сторож ведра не льёт воду в полёте.
function install (bot) {
  if (bot._ndElytra) return bot._ndElytra
  const S: any = { rocketIds: new Set(), fd: 0, moveFd: 0, lastY: null, startedAt: 0, flightStart: 0, lastRocketAt: 0, phase: null, box: [], crashes: [], groundT: 0 }
  bot._ndElytra = S
  rocketForecast(bot)
  // Кто повернул взгляд в полёте (S7d: в чёрном ящике s7c5 скорость под ракетой разворачивалась на 180° за тик —
  // похоже на двух рулевых): в полёте каждый bot.look/lookAt помечается первым кадром стека вне mineflayer/elytra.
  // В запись тика — фактический взгляд и метка последнего рулевого. ND_ELYTRA_WHO=0 — выкл.
  if (process.env.ND_ELYTRA_WHO !== '0') {
    const tag = () => {
      const fr = String(new Error().stack || '').split('\n').slice(2)
      for (const f of fr) {
        if (/node_modules[\\/]mineflayer|elytra(?:[\\/][\w.-]+)?\.js|tick-plugins|game-clock|new Promise|<anonymous>/.test(f)) continue
        const m = /([\w.-]+\.js):(\d+)/.exec(f)
        const fn = /at (?:async )?([\w.$<>]+) /.exec(f)
        return (fn ? fn[1] + '@' : '') + (m ? m[1] + ':' + m[2] : '?')
      }
      return 'elytra'
    }
    // Руль один (S7d): пока полёт ведёт fly/таран (S.driving), чужой поворот взгляда (прицел боя, рефлексы) не
    // проходит — в s7d-base 36 ударов о стену за 9 раундов, все — под ракетой прямо в стену с ровной скоростью, а
    // офлайн тот же choose() из этих состояний разворачивается (elysim.js). ND_ELYTRA_LOCK=0 — только метка.
    const LOCK = process.env.ND_ELYTRA_LOCK !== '0'
    S.blockedBy = {}
    for (const k of ['look', 'lookAt']) {
      const orig = bot[k]
      if (typeof orig !== 'function') continue
      bot[k] = function (...a) {
        try {
          if (bot.entity && bot.entity.elytraFlying) {
            const who = tag()
            if ((S.driving > 0 || S.boundaryReturn || S.collisionAvoidance) && !S.steering && steering.getStore() !== bot) {
              S.blockedLooks = (S.blockedLooks || 0) + 1
              S.blockedBy[who] = (S.blockedBy[who] || 0) + 1
              if (LOCK) return Promise.resolve()
            }
            S.lookBy = who
          }
        } catch {}
        return orig.apply(this, a)
      }
    }
  }
  // Чёрный ящик полёта (S7c, замечание проверки S7b а: 18 из 49 раундов «элитры и копьё» — разбился сам):
  // последние 30 тиков в воздухе; удар о стену (fly_into_wall) или пол (fall) себе в полёте/сразу после — запись
  // { kind, phase, dmg, hp, ticks[] } в S.crashes и строка [elytra-crash] в лог демона.
  bot.on('physicsTick', () => {
    try {
      const b = bot.entity
      if (!b) return
      S.collisionAvoidance = false
      // Земля: ящик чистится не сразу — урон падения (damage_event) приходит от сервера после касания, а без ящика
      // смерть «fell from a high place» не попадала в crashes (s7d-n-30: 2 такие смерти без записи).
      if (b.onGround && !b.elytraFlying) { S.wasFlying = false; if (++S.groundT > 10 && !S.boxHold) { S.box.length = 0; S.phase = null } return }
      S.groundT = 0
      // Полёт кончился в воздухе (S7d, s7d-n-30: обе смерти «fell from a high place» — после такого обрыва): кто и
      // при чём — в лог, раз в 2 с.
      if (S.wasFlying && !b.elytraFlying && !b.isInWater && gameClock.now() - (S.dropLogAt || 0) > 2000) {
        S.dropLogAt = gameClock.now()
        S.drops = (S.drops || 0) + 1
        let gap = null
        try { const f = worldOf(bot).floorBelow(b.position.x, b.position.y, b.position.z, 40); gap = f ? r2(b.position.y - f.top) : null } catch {}
        console.log('[elytra-drop]', JSON.stringify({ at: gameClock.wall.now(), chest: bot.inventory.slots[6]?.name || null, held: bot.heldItem?.name || null, off: bot.inventory.slots[45]?.name || null, gap, vy: r2(b.velocity.y), fd: r2(S.fd), ph: S.phase, dr: S.driving || 0, last: S.box.slice(-3) }))
      }
      S.wasFlying = !!b.elytraFlying
      // Рефлекс «снова раскрыть» (S7d: s7d-f-27p — 2 из 10 смертей «fell from a high place»: полёт кончился на
      // высоте 22, таран после третьего захода ждал земли): элитры на теле, не летим, падаем (v.y < −0.5), до пола
      // > 4 бл. — раскрыть снова (пике с булавой меняет элитры на нагрудник заранее — его это не трогает).
      if (GUARD && !b.elytraFlying && !b.isInWater && b.velocity.y < -0.5 && wearingElytra(bot) && bot.heldItem?.name !== 'mace' && gameClock.now() - (S.reglideAt || 0) > 500) {
        const f = worldOf(bot).floorBelow(b.position.x, b.position.y, b.position.z, 40)
        if (!f || b.position.y - f.top > 4) { S.reglideAt = gameClock.now(); if (startGlide(bot)) S.reglideReflex = (S.reglideReflex || 0) + 1 }
      }
      // Рефлекс столкновения (S7c, а): летит, а рулит никто (между вызовами fly — удар копьём в воздухе, выстрел,
      // жемчуг, решение боя) — нынешний взгляд за 8 тиков ведёт в стену с уроном или в пол с высотой падения > 3:
      // этот тик — безопасный взгляд (choose: прямо по ходу на 12 бл., выше пола на 3).
      S.boundaryReturn = false
      if (b.elytraFlying && !S.driving && GUARD) {
        const W = worldOf(bot, { observed: !!S.arenaBounds })
        const st = { p: b.position, v: b.velocity, ...rocketForecast(bot), fd: S.fd }
        const r = rollout(W, b.position, b.velocity, b.yaw, b.pitch, st.boost, 8, { fd: S.fd, arena: S.arenaBounds })
        S.boundaryReturn = r.kind === 'outside'
        if (S.boundaryReturn || (r.kind === 'wall' && r.dmg >= 1) || (r.kind === 'floor' && r.fd > 3)) {
          const h = Math.hypot(b.velocity.x, b.velocity.z) > 0.2 ? Math.atan2(-b.velocity.x, -b.velocity.z) : b.yaw
          const L = lookVec(h, 0)
          const pl = choose(W, st, { kind: 'point', at: new Vec3(b.position.x + L.x * 12, b.position.y + 2, b.position.z + L.z * 12), gap: 3, speedMin: 0.3, arena: S.arenaBounds }) || (S.arenaBounds ? returnInside(W, st, S.arenaBounds) : null)
          if (pl) {
            // A resumed ground action must not undo this tick's safe flight look.
            S.collisionAvoidance = true
            steer(bot, pl.yaw, pl.pitch); S.guardSaves = (S.guardSaves || 0) + 1; S.phase = S.phase || 'рефлекс'
          }
        }
      }
      // Диагностика S7d: план рулевого этого тика (цена, событие прогона, тик события) и стена по ходу — по кэшу
      // мира полёта (W) и по свежему blockAt: расходятся — кэш врёт.
      let wallW = null; let wallF = null
      try {
        const hs = Math.hypot(b.velocity.x, b.velocity.z)
        if (b.elytraFlying && hs > 0.5) {
          const W = worldOf(bot)
          const ux = b.velocity.x / hs; const uz = b.velocity.z / hs
          for (let d = 1; d <= 12 && (wallW == null || wallF == null); d++) {
            const x = Math.floor(b.position.x + ux * d); const y = Math.floor(b.position.y + 0.3); const z = Math.floor(b.position.z + uz * d)
            if (wallW == null && W.at(x, y, z) === 1) wallW = d
            let fb = null
            try { fb = bot.blockAt(new Vec3(x, y, z), false) } catch {}
            if (wallF == null && (!fb || fb.boundingBox === 'block')) wallF = d
          }
        }
      } catch {}
      const pl = S.lastPlan && S.lastPlan.tick === S.box.length ? S.lastPlan : S.lastPlan
      S.box.push({ x: r2(b.position.x), y: r2(b.position.y), z: r2(b.position.z), vx: r2(b.velocity.x), vy: r2(b.velocity.y), vz: r2(b.velocity.z), ef: b.elytraFlying ? 1 : 0, fd: r2(S.fd), fdMove: r2(S.moveFd), ph: S.phase, fw: bot.fireworkRocketDuration > 0 ? 1 : 0, bst: bot.fireworkRocketDuration || 0, forecast: rocketForecast(bot), yaw: r2(b.yaw), pitch: r2(b.pitch), by: S.lookBy || null, dr: S.driving || 0, pc: pl ? pl.c : null, pk: pl ? pl.k : null, pt: pl ? pl.t : null, pfd: pl ? pl.fd : null, pvyHit: pl ? pl.vyHit : null, wallW, wallF })
      S.lastPlan = null
      S.lookBy = null
      if (S.box.length > 30) S.box.shift()
    } catch {}
  })
  try {
    bot._client.on('damage_event', (pk) => {
      try {
        if (!bot.entity || pk.entityId !== bot.entity.id) return
        const type = (require('../gamedata') as typeof import('../gamedata')).damageTypeName(pk.sourceTypeId)
        if (type !== 'fly_into_wall' && type !== 'fall') return
        if (!S.box.length) return
        const hp0 = bot.health ?? 20
        const rec: any = { kind: type === 'fly_into_wall' ? 'стена' : 'пол', phase: S.phase || S.box[S.box.length - 1].ph || null, at: gameClock.now(), wallAt: gameClock.wall.now(), ticks: S.box.slice(type === 'fall' ? -30 : -12) }
        S.boxHold = true
        // В список — сразу (отчёт погибшего собирается раньше 100 мс), урон и смерть — когда придёт хп.
        rec.dmg = null
        S.crashes.push(rec)
        if (S.crashes.length > 20) S.crashes.shift()
        gameClock.setTimeout(() => {
          S.boxHold = false
          rec.dmg = r2(Math.max(0, hp0 - (bot.health ?? 0)))
          rec.died = (bot.health ?? 0) <= 0
          console.log('[elytra-crash]', JSON.stringify(rec))
        }, 100)
      } catch {}
    })
  } catch {}
  bot.on('usedFirework', (id) => {
    S.rocketIds.add(id)
    // Тянет до entityGone: сервер убирает ракету на исходе её жизни.
    bot.fireworkRocketDuration = Math.max(bot.fireworkRocketDuration || 0, ROCKET_MAX_TICKS)
  })
  bot.on('entityGone', (e) => {
    if (!e || !S.rocketIds.has(e.id)) return
    S.rocketIds.delete(e.id)
    if (!S.rocketIds.size) bot.fireworkRocketDuration = 0
  })
  bot.on('physicsTick', () => {
    try {
      const b = bot.entity
      if (!b) return
      const y = b.position.y
      // ServerPlayer accepts position packets; its deltaMovement is not the client's simulated velocity.
      // A positive accepted Y delta resets fallDistance in handleMovePlayer. Ignore unobserved slow-fall resets.
      if (b.onGround || b.isInWater || (S.lastY != null && y > S.lastY)) S.moveFd = 0
      else if (S.lastY != null) S.moveFd += Math.max(0, S.lastY - y)
      if (b.onGround || b.isInWater) S.fd = 0
      else {
        if (b.elytraFlying && b.velocity.y > -0.5 && S.fd > 1) S.fd = 1
        if (S.lastY != null && y < S.lastY) S.fd += S.lastY - y
      }
      S.lastY = y
      if (b.elytraFlying && !S.flightStart) S.flightStart = gameClock.now()
      if (!b.elytraFlying) S.flightStart = 0
    } catch {}
  })
  // Сторож ведра (edges.installFallGuard) спрашивает bot._ndWindFall(top): «падение
  // прикрыто — вода не нужна». В полёте на элитрах — прикрыто всегда: посадку
  // ведёт полёт (высота падения ≤ 1, пока v.y > −0.5), а вода под ноги в
  // последний тик — это взгляд вниз, то есть пике в землю. Свойство, а не
  // функция поверх: булава (mace.install) ставит свою позже — оборачиваем и её.
  let inner = bot._ndWindFall
  try {
    Object.defineProperty(bot, '_ndWindFall', {
      configurable: true,
      get: () => (top) => {
        if (bot.entity && bot.entity.elytraFlying) return true
        return typeof inner === 'function' ? inner(top) : false
      },
      set: (f) => { inner = f }
    })
  } catch {}
  return S
}

// «Раскрыть» элитры: пакет START_FALL_FLYING и, как клиент игры
// (LocalPlayer.aiStep → tryToStartFallFlying), флаг у себя сразу — без
// ожидания метаданных сервера (тик). Сервер откажет — пришлёт флаг назад.
// Поворот взгляда рулевым полёта (fly, таран, пике, рефлекс): мимо замка «руль один» в install.
function steer (bot, yaw, pitch) {
  const S = bot._ndElytra
  if (S) S.steering = true
  // Hand guards may defer the actual look beyond this synchronous steering flag.
  try { return steering.run(bot, () => bot.look(yaw, pitch, true).catch(() => {})) } finally { if (S) S.steering = false }
}

function startGlide (bot) {
  const b = bot.entity
  if (!b || b.onGround || b.isInWater || !wearingElytra(bot)) return false
  if (b.elytraFlying) return true // A repeated START_FALL_FLYING makes the server stop an active glide.
  try {
    bot._client.write('entity_action', { entityId: b.id, actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8, jumpBoost: 0 })
  } catch { return false }
  b.elytraFlying = true
  install(bot).startedAt = gameClock.now()
  return true
}

// Фейерверк: из левой руки (правая с оружием не трогается), иначе из хотбара —
// слот, «использовать», слот назад в том же тике.
function fireRocket (bot) {
  const S = install(bot)
  if (!bot.entity || !bot.entity.elytraFlying) return { ok: false, why: 'не лечу' }
  if (gameClock.now() - S.lastRocketAt < 250) return { ok: false, why: 'только что' }
  if (plainRocket(bot.inventory.slots[45])) {
    const usingHeldItem = bot.usingHeldItem
    bot.activateItem(true)
    bot.usingHeldItem = usingHeldItem // server mainhand use от offhand ракеты не прекращается
    S.lastRocketAt = gameClock.now()
    return { ok: true, hand: 'off' }
  }
  let idx = -1
  for (let i = 0; i < 9; i++) if (plainRocket(bot.inventory.slots[36 + i])) { idx = i; break }
  if (idx < 0) return { ok: false, why: 'фейерверка нет в хотбаре' }
  const back = bot.quickBarSlot
  try {
    if (back !== idx) bot.setQuickBarSlot(idx)
    bot.activateItem()
    bot.usingHeldItem = false
    if (back !== idx) bot.setQuickBarSlot(back)
  } catch (e) { return { ok: false, why: e.message } }
  S.lastRocketAt = gameClock.now()
  return { ok: true, hand: 'main' }
}

// Где стены, пол и потолок вокруг (для круга под потолком и уходов): лучи на
// 8 сторон на высоте y, вверх — потолок. Кэш на 1 с.
function arenaAround (bot, W, at, { reach = 48 }: any = {}) {
  const S = install(bot)
  const k = `${Math.floor(at.x / 4)},${Math.floor(at.y / 2)},${Math.floor(at.z / 4)}`
  if (S.arena && S.arena.k === k && gameClock.now() - S.arena.at < 1000) return S.arena.v
  const dirs = []
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2
    const dx = -Math.sin(a); const dz = -Math.cos(a)
    let d = 0
    for (; d < reach; d += 0.5) if (W.boxHit(at.x + dx * d, at.y, at.z + dz * d)) break
    dirs.push({ yaw: a, d })
  }
  const ceil = headroom(W, at, 40)
  const v = { dirs, ceilY: at.y + 0.2 + ceil + BODY_H }
  S.arena = { k, at: gameClock.now(), v }
  return v
}

// Фоновая посадка наследует владельца исходного действия.
function flightControl (bot, ctl, emergency = false) {
  const S = install(bot)
  if (!ctl._ndFlightOwner) {
    if (S.flightOwner) S.flightOwner.active = false
    S.flightOwner = ctl._ndFlightOwner = { active: true }
  }
  const owner = ctl._ndFlightOwner
  return { ...ctl, _ndFlightOwner: owner,
    get aborted () { return !owner.active || (!emergency && ctl.aborted) || (bot.health ?? 0) <= 0 } }
}

export {
  flightControl, install, steer, startGlide, fireRocket, arenaAround
}
