'use strict'
// Элитры (elytra.ts): пике с булавой — бонус высоты, план, само пике, хп моба, удар после пакета.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const pick: typeof import('../pick') = require('../pick')
const maceLift: typeof import('../mace/hands') = require('../mace/hands')
const { TICK_MS, EYE, BODY_H, REACH, KEYS, DEBUG, ON, sleep, nextTick, yawTo, wrap, r2 }: typeof import('./consts') = require('./consts')
const { lookVec, fallStep, worldOf, headroom, reachFromBox }: typeof import('./physics') = require('./physics')
const { findItem, offName, chestName, plainRocket, bestChest, kit, swapChest }: typeof import('./kit') = require('./kit')
const { choose }: typeof import('./control') = require('./control')
const { install, steer, startGlide, fireRocket, arenaAround }: typeof import('./install') = require('./install')
const { fly, takeoff, land, chestDown }: typeof import('./flight') = require('./flight')
import { rocketForecast } from './rocket-forecast'

// Пике с булавой. Булава в правой заранее (33 тика заряда: к удару — крит),
// фейерверки в левой; набор высоты над ним со сдвигом, перед пике в левую —
// нагрудник; пике почти отвесно (щит держит по горизонтали — сверху почти
// ноль), за 2–3 тика до руки — нагрудник на тело («использовать» левой):
// полёт кончился, высота падения из пике осталась (MaceItem.canSmashAttack);
// удар в первый тик, когда он в руке и под прицелом. Мимо и высоко —
// элитры обратно и в полёт.
function smashBonus (h) {
  if (!(h > 1.5)) return 0
  if (h <= 3) return 4 * h
  if (h <= 8) return 12 + 2 * (h - 3)
  return 22 + (h - 8)
}

// Оценка пике с булавой (гибкость вместо жёстких ворот, AGENTS.md 06.10): физические условия (элитры, булава, нагрудник,
// тяга, небо) обязательны; щит соперника, хп, дистанция и высота — цена и риск (с топором slamHit выбивает щит в том же тике).
function divePlan (bot, e, { d, dy, hp, foeGrounded = true, hisShield = false, arena = null, W = worldOf(bot, { observed: !!arena }) }: any = {}) {
  if (!ON) return null
  const k = kit(bot)
  if (!k.elytra || !k.mace || (k.rockets < 2 && !maceLift.windReady(bot)) || !k.chest) return null
  if (!bot.entity || !bot.entity.onGround || bot.entity.isInWater || !e?.position) return null
  if (e.elytraFlying) return null
  const hasAxe = !!findItem(bot, i => /_axe$/.test(i.name))
  const hasTotem = offName(bot) === 'totem_of_undying' || !!findItem(bot, 'totem_of_undying')
  // Без топора пике в поднятый щит, смотрящий на нас, приносит 0 урона при риске падения; с топором slamHit пробивает щит.
  if (hisShield && !hasAxe && maceLift.shieldAtUs(bot, e)) return null
  if (!(d >= 2 && d <= 30) || Math.abs(dy) > 5) return null
  if (hp < (hasTotem ? 5 : 7)) return null
  const me = bot.entity.position
  if (headroom(W, me, 12) < 10) return null
  if (headroom(W, e.position, 12) < 9) return null
  // EV score: ожидаемый урон булавы с 8–10 бл. (~20+) против риска промаха / потери хп.
  const risk = (hp < 9 ? (9 - hp) * 1.5 : 0) + (!foeGrounded ? 3 : 0) + (hisShield ? 2 : 0) + (d > 22 ? (d - 22) * 0.4 : 0)
  if (risk > 10 && !hasTotem) return null
  return { kind: 'dive' }
}

async function diveSmash (bot, ctl, e, { vel = () => ({ x: 0, y: 0, z: 0 }), stats = {}, used = () => {}, allow = null, maxMs = 12000, telemetryHp = e => healthOf(bot, e), arena = null, chain = null }: any = {}) {
  const W = worldOf(bot, { observed: !!arena })
  const S = install(bot)
  const out: any = { ok: false, hit: false, note: '' }
  const t0 = gameClock.now()
  const foe = () => e.position
  const hp0 = bot.health ?? 20
  const hisHp0 = telemetryHp(e)
  // Подготовка на земле: элитры на тело (правой), булава — в правую (заряд
  // пошёл), фейерверки — в левую.
  const sw = await swapChest(bot, 'elytra', { hand: 'main', ctl })
  if (!sw.ok) { out.note = 'пике: элитры не надел — ' + sw.why; return out }
  const mace = findItem(bot, 'mace')
  try { if (mace && (!bot.heldItem || bot.heldItem.name !== 'mace')) await bot.equip(mace, 'hand') } catch {}
  const maceAt = gameClock.now()
  const windTakeoff = kit(bot).rockets < 2 && maceLift.windReady(bot)
  const liftItem = it => windTakeoff ? it?.name === 'wind_charge' : plainRocket(it)
  try { const rk = bot.inventory.items().find(liftItem); if (rk && !liftItem(bot.inventory.slots[45])) await bot.equip(rk, 'off-hand') } catch {}
  if (!bot.heldItem || bot.heldItem.name !== 'mace' || !liftItem(bot.inventory.slots[45])) {
    await swapChest(bot, 'chest', { ctl })
    out.note = 'пике: булава или фейерверк не в руках'
    return out
  }
  const hands = () => `слот ${bot.quickBarSlot}, в руке ${bot.heldItem ? bot.heldItem.name : '-'}, левая ${offName(bot) || '-'}, грудь ${chestName(bot) || '-'}, хотбар ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (bot.inventory.slots[36 + i] || {}).name || '-').join(',')}`
  if (DEBUG) console.log('[dive] руки перед взлётом:', hands())
  if (allow) allow()
  const toward = yawTo(bot.entity.position, foe())
  let to
  if (windTakeoff) {
    // Тот же нативный бросок под ноги, что у windSmash: заряд с земли, затем прыжок.
    const y0 = bot.entity.position.y
    for (const key of KEYS) bot.setControlState(key, false)
    await nextTick(bot)
    const charges = maceLift.windCount(bot)
    let useSeen = false, impulseSeen = false
    const onUse = p => { if (/wind_charge/.test(String(p?.cooldownGroup || '')) && p.cooldownTicks > 0) useSeen = true }
    const onImpulse = p => { if (p?.playerKnockback?.y > 0) impulseSeen = true }
    bot._client.on('set_cooldown', onUse); bot._client.on('explosion', onImpulse)
    try {
      const fired = await maceLift.fireWind(bot, moved => !ctl.aborted && maceLift.selfWindAim(bot, { moved }), {
        swap: false, hand: 'off', before: () => bot.setControlState('jump', !ctl.aborted && bot.entity.onGround)
      })
      if (fired.fired) await nextTick(bot)
      bot.setControlState('jump', false)
      let lifted = false
      for (let tick = 0; fired.fired && !ctl.aborted && (bot.health ?? 0) > 0 && tick < 10; tick++) {
        // Jump Boost тоже даёт vy > .55: нужен расход/серверная перезарядка и пакет толчка, не одна скорость.
        if ((useSeen || maceLift.windCount(bot) < charges) && impulseSeen && !bot.entity.onGround && bot.entity.velocity.y > 0) { lifted = true; break }
        if (!await nextTick(bot)) break
      }
      if (lifted) {
        bot._ndWind = { impactY: y0, until: gameClock.now() + 2000 }
        startGlide(bot)
        await nextTick(bot)
      }
      to = { ok: lifted && !ctl.aborted && !!bot.entity.elytraFlying, why: fired.fired ? 'всплеск не открыл полёт' : fired.why }
    } finally {
      bot.setControlState('jump', false)
      bot._client.removeListener('set_cooldown', onUse); bot._client.removeListener('explosion', onImpulse)
    }
  } else to = await takeoff(bot, ctl, { pitch: 1.1, yaw: wrap(toward + Math.PI), stats, arena })
  if (!to.ok) { await chestDown(bot, ctl, { stats, arena }); out.note = 'пике: не взлетел — ' + to.why; return out }
  stats.dives = (stats.dives || 0) + 1
  // Набор высоты: точка над ним со сдвигом 6 бл. в нашу сторону, на высоте
  // его ног + 10 (под потолком — ниже).
  const topY = () => {
    const ar = arenaAround(bot, W, bot.entity.position)
    return Math.min(ar.ceilY - BODY_H - 1.4, foe().y + 11)
  }
  let phase = 'climb'
  let chestReady = false
  // Сторона захода — та, где мы были на взлёте; пока булава заряжается, держим отступ 7 бл. (вне радиуса разворота,
  // чтобы не крутиться на месте), а к готовности сводим в 2.5 бл. с упреждением по скорости цели.
  const side = yawTo(foe(), bot.entity.position)
  const r: any = await fly(bot, ctl, { arena,
    maxMs: 6500, phase: 'пике: заход',
    stats,
    goal: () => {
      const f = foe()
      const tv = vel() || { x: 0, y: 0, z: 0 }
      const lead = new Vec3(f.x + (Number.isFinite(tv.x) ? tv.x * 6 : 0), f.y, f.z + (Number.isFinite(tv.z) ? tv.z * 6 : 0))
      const L = lookVec(side, 0)
      const offset = gameClock.now() - maceAt >= 26 * TICK_MS ? 2.5 : 7.0
      const P = new Vec3(lead.x + L.x * offset, topY(), lead.z + L.z * offset)
      return { kind: 'point', at: P, reach: true, minY: f.y + 3, maxY: topY() + 1, gap: 2.5, speedMin: 0.35 }
    },
    rocketIf: (st) => st.p.y < topY() - 3 ? true : null,
    onTick: () => { if (allow) allow() },
    // Пике — с заряженной булавой (33 тика); расширенное окно (dy > 5.5, dh < 9.5) даёт быстрый заход без лишних кругов.
    until: () => {
      if (e.isValid === false || !e.position) return 'цель пропала'
      const me = bot.entity.position; const f = foe()
      const dh = Math.hypot(me.x - f.x, me.z - f.z)
      return (me.y > f.y + 5.5 && dh < 9.5 && gameClock.now() - maceAt >= 33 * TICK_MS + 50) ? 'над ним' : null
    }
  })
  if (r.why !== 'над ним') {
    const l: any = bot.entity.elytraFlying ? await land(bot, ctl, { away: null, stats, arena }) : { ok: true }
    await chestDown(bot, ctl, { stats, arena })
    out.note = `пике: не зашёл сверху (${r.why})${l.ok ? '' : ', посадка: ' + l.why}`
    return out
  }
  // Нагрудник — в левую на втором тике пике: на первом — фейерверк из левой
  // (пике на ракете — вниз ~1.5 б/т, высота падения копится сразу; без ракеты
  // медленный спуск держит v.y > −0.5, и высота падения залипает на 1 —
  // замер elytra-probe3: 3 из 6 заходов без ракеты вышли из пике без удара).
  // Ракета — отдельная сущность: уход стопки из руки её не гасит.
  let chestAsked = false
  const askChest = () => {
    if (chestAsked) return
    chestAsked = true
    const cp = bestChest(bot)
    if (cp) bot.equip(cp, 'off-hand').then(() => { chestReady = /_chestplate$/.test(offName(bot) || '') }).catch(() => {})
  }
  let diveRocket = !(bot.fireworkRocketDuration > 3) && plainRocket(bot.inventory.slots[45]) ? 'нужна' : 'нет'
  phase = 'dive'
  // Пике: цель — его голова с упреждением; свап, когда до руки 2–3 тика.
  let swapped: any = false
  let hit = null
  let deployBack = false
  // Сторож ведра (edges.installFallGuard): после свапа мы падаем, и он взвёл
  // бы воду в последний тик — сменой слота на ведро под самым ударом (замер
  // 2026-09-26: удар ушёл «ведром» — 0.04 хп вместо 18). Как у спуска булавы
  // (mace.descend): метка спуска — вода только в последний тик, и наш удар
  // этого тика (bot._ndSmashNow) сторож делает первым.
  const mark = { at: gameClock.now() }
  let confirmed = false
  const onDamage = pk => { if (hit && (require('../combat/aerial-lance') as typeof import('../combat/aerial-lance')).ownHit(pk, bot.entity.id, e.id)) confirmed = true }
  bot._client.on('damage_event', onDamage)
  let reglideTimer: any = null
  const clearReglide = () => { if (reglideTimer != null) { gameClock.clearTimeout(reglideTimer); reglideTimer = null } }
  try {
  const res = await new Promise<any>(resolve => {
    let done = false
    S.driving = (S.driving || 0) + 1
    const fin = (why) => { if (done) return; done = true; S.driving = Math.max(0, (S.driving || 1) - 1); bot.removeListener('physicsTick', onT); if (bot._ndDescend === mark) bot._ndDescend = null; resolve(why) }
    const tD = gameClock.now()
    const W2 = W
    const footAt = (t) => { const f = foe(); const tv = vel() || { x: 0, y: 0, z: 0 }; return new Vec3(f.x + tv.x * t, f.y, f.z + tv.z * t) }
    const strikeAt = (t) => footAt(t).offset(0, 2.4, 0)
    const DIVE_PITCHES = [-1.52, -1.4, -1.25, -1.1, -0.95, -0.8, -0.65, -0.5, -0.35, -0.2]
    const onT = () => {
      if (done) return
      try {
        if (ctl.aborted || (bot.health ?? 0) <= 0 || e.isValid === false || !e.position) return fin(e.isValid === false ? 'цель пропала' : 'прервали')
        if (confirmed && chain && (require('../read') as typeof import('../read')).enchLevel(bot, mace, 'wind_burst') > 0) return fin('Wind Burst')
        const b = bot.entity
        if (b.onGround) return fin(hit ? 'сел после удара' : 'сел')
        if (gameClock.now() - tD > 3500) return fin('долго')
        if (allow) allow()
        const f = foe()
        const tv = vel() || { x: 0, y: 0, z: 0 }
        const p = b.position; const v = b.velocity
        if (!swapped) {
          // Пике: взгляд, который за 18 тиков проводит нас ближе всего к точке
          // над его головой (2.4 — чтобы свап успел до его рамки), только круто
          // вниз: скорость вниз копит высоту падения (> −0.5), горизонталь для
          // его щита — почти ноль.
          const pl = choose(W2, { p, v, yaw: b.yaw, pitch: b.pitch, ...rocketForecast(bot), fd: S.fd }, { kind: 'strike', at: strikeAt, foot: footAt, pitches: DIVE_PITCHES, arena }, { rocketNow: diveRocket === 'нужна' })
          // Дуга за границей арены не выбирается (Codex 15.10) — нет дуги внутри: выход.
          if (!pl) return fin('no_safe_arena_trajectory')
          steer(bot, pl.yaw, pl.pitch)
          if (diveRocket === 'нужна') {
            // Взгляд этого тика уйдёт пакетом с ним же — ракета после пакета.
            afterPacket(bot, () => { const fr = fireRocket(bot); if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1 })
            diveRocket = 'была'
            return
          }
          askChest()
          // Свап: прогноз свободного падения с этого тика — войдём ли в его руку
          // (глаза 1.62 после свапа) за ≤ 4 тика и выше его головы.
          const q = { x: p.x, y: p.y, z: p.z }; const w = { x: v.x, y: v.y, z: v.z }
          let enter = -1
          for (let t = 1; t <= 6; t++) {
            fallStep(q, w)
            const ep = new Vec3(f.x + tv.x * t, f.y, f.z + tv.z * t)
            const rr = reachFromBox(new Vec3(q.x, q.y + EYE, q.z), ep, 0.6, 1.8)
            if (rr <= REACH - 0.25 && q.y > ep.y + 0.6) { enter = t; break }
          }
          const charged = gameClock.now() - maceAt >= 33 * TICK_MS + 60
          if (DEBUG) console.log('[dive]', JSON.stringify({ t: gameClock.now() - tD, p: [r2(p.x - f.x), r2(p.y - f.y), r2(p.z - f.z)], v: [r2(v.x), r2(v.y), r2(v.z)], enter, charged, chestReady, fd: r2(S.fd), fly: b.elytraFlying }))
          if (enter >= 1 && enter <= 3 && charged && chestReady && S.fd > 1.8 && v.y < -0.45) {
            bot.activateItem(true)
            bot.usingHeldItem = false
            swapped = gameClock.now()
            bot._ndDescend = mark
            if (stats) stats.swaps = (stats.swaps || 0) + 1
          } else if (gameClock.now() - tD > 2500 || (p.y < f.y + 2 && Math.hypot(f.x - p.x, f.z - p.z) > 3)) {
            return fin('промахнулся на подлёте')
          } else {
            // Свапа не будет, а пол близко и высота падения уже набрана —
            // выйти из пике (взгляд вверх: v.y > −0.5 — и высота падения снова
            // ≤ 1), иначе удар о пол.
            const fl0 = W2.floorBelow(p.x, p.y, p.z, 20)
            const hh = fl0 ? p.y - fl0.top : 20
            if (S.fd > 2.5 && hh < 3 + Math.max(0, -v.y) * 3 && enter < 0) return fin('вышел из пике — удара не будет')
          }
          return
        }
        bot._ndDescend = mark
        // После свапа: смотреть на него и бить в первый тик, когда достаём.
        const eye = pick.eyeOf(bot)
        const targetBox = pick.hitboxOf(bot, e)
        const target = new Vec3(f.x, f.y + targetBox.h / 2, f.z)
        steer(bot, yawTo(p, target), Math.atan2(target.y - eye.y, Math.max(0.2, Math.hypot(target.x - p.x, target.z - p.z))))
        // Клавиши — к нему (0.02 б/т² в воздухе), без спринта (крит).
        const yawNow = bot.entity.yaw
        const ex = f.x - p.x; const ez = f.z - p.z
        const fwd = ex * -Math.sin(yawNow) + ez * -Math.cos(yawNow)
        const right = ex * Math.cos(yawNow) + ez * -Math.sin(yawNow)
        try { bot.setControlState('forward', fwd > 0.3); bot.setControlState('back', fwd < -0.3); bot.setControlState('right', right > 0.3); bot.setControlState('left', right < -0.3); bot.setControlState('sprint', false) } catch {}
        if (DEBUG) console.log('[dive] после свапа', JSON.stringify({ t: gameClock.now() - swapped, p: [r2(p.x - f.x), r2(p.y - f.y), r2(p.z - f.z)], v: [r2(v.x), r2(v.y), r2(v.z)], r: r2(reachFromBox(eye, f, 0.6, 1.8)), fly: b.elytraFlying, chest: chestName(bot), fd: r2(S.fd) }))
        // Удар — не раньше, чем сервер снял полёт (флаг у нас — по его метаданным
        // или по слоту груди): в одном тике со свапом сервер ещё считает полёт,
        // и удара с падения нет (замер: 2.6 хп вместо 20).
        if (!hit && !b.elytraFlying && gameClock.now() - swapped >= 45 && v.y < 0 && reachFromBox(eye, f, 0.6, 1.8) <= REACH - 0.05) {
          // Булава — в правой (сторож ведра мог сменить слот): слот булавы и
          // удар одним куском; сторож в том же тике зовёт нас первым.
          const doHit = () => {
            try {
              if (ctl.aborted || e.isValid === false || bot.entity.elytraFlying || !(S.fd > 1.5) || bot.entity.velocity.y >= 0 || !pick.canHit(bot, e, { range: REACH })) { hit = null; return }
              // Его щит поднят — «оглушающий»: топор и булава в одном тике (mace.slamHit).
              const strike = (require('../mace') as typeof import('../mace')).slamHit(bot, e, stats)
              if (strike?.blocked) hit = null
            } catch {}
          }
          hit = { at: gameClock.now(), fd: r2(S.fd), sinceSwap: gameClock.now() - swapped, fly: !!b.elytraFlying }
          if (DEBUG) console.log('[dive] удар, руки:', hands())
          bot._ndSmashNow = doHit
          afterPacket(bot, () => { if (bot._ndSmashNow === doHit) { bot._ndSmashNow = null; doHit() } })
          return
        }
        // Проскочили мимо и ещё высоко — элитры обратно (левой) и в полёт.
        const f0 = W.floorBelow(p.x, p.y, p.z, 30)
        const h = f0 ? p.y - f0.top : 30
        const away = reachFromBox(eye, f, 0.6, 1.8)
        if (!hit && !deployBack && gameClock.now() - swapped > 150 && away > REACH + 0.5 && h > 3.5 && v.y < -0.3) {
          deployBack = true
          ;(require('../combat/aerial-recovery') as typeof import('../combat/aerial-recovery')).beginAerialRecovery(bot, ctl)
          bot.activateItem(true)
          bot.usingHeldItem = false
          reglideTimer = gameClock.setTimeout(() => {
            reglideTimer = null
            if (ctl.aborted || !bot.entity || bot.entity.onGround || bot.entity.elytraFlying || (bot.health ?? 0) <= 0) return
            try { startGlide(bot); bot.look(bot.entity.yaw, 0.5, true).catch(() => {}) } catch {}
          }, 60)
          return fin('мимо — элитры обратно')
        }
      } catch (err) { fin('ошибка: ' + err.message) }
    }
    bot.on('physicsTick', onT)
  })
  if (res === 'Wind Burst') {
    // Удар подтверждён сервером; продолжение ждёт реальную скорость отскока и заново оценивает цель.
    out.chain = await (require('../mace') as typeof import('../mace')).descend(bot, ctl, e, {
      vel, swap: false, stats, telemetryHp, chain: { ...chain, deadline: Math.min(chain.deadline ?? Infinity, t0 + maxMs) }, maxMs: Math.max(0, maxMs - (gameClock.now() - t0)),
      initialHit: { at: hit.at, fall: hit.fd, target: e.username || e.name, hp0: hisHp0, charged: true, selfHp: bot.health }
    })
  }
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  // Мимо на подлёте (не свапнули) — сесть; свапнули и вернули элитры — сесть.
  if (bot.entity.elytraFlying) await land(bot, ctl, { away: null, stats, arena })
  await sleep(250)
  clearReglide()
  await chestDown(bot, ctl, { stats, arena })
  out.hit = confirmed
  out.ok = true
  const hisHp1 = telemetryHp(e)
  out.dealt = hit && hisHp0 != null && hisHp1 != null ? r2(Math.max(0, hisHp0 - hisHp1)) : null
  out.self = r2(Math.max(0, hp0 - (bot.health ?? 20)))
  out.fd = hit ? hit.fd : r2(S.fd)
  out.ms = gameClock.now() - t0
  if (confirmed) { stats.diveHits = (stats.diveHits || 0) + 1; if (out.dealt != null) (stats.diveDealt = stats.diveDealt || []).push(out.dealt) }
  stats.diveSelf = r2((stats.diveSelf || 0) + out.self)
  out.note = `элитры: пике с булавой — ${confirmed ? `удар с падения ${hit.fd} бл.${out.dealt != null ? `, снял ${out.dealt}` : ''}` : hit ? 'взмах без подтверждения попадания' : res}${out.self ? `, себе −${out.self}` : ''}`
  void phase
  return out
  } finally { clearReglide(); bot._client.removeListener('damage_event', onDamage) }
}

function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h : null
  } catch { return null }
}

// После пакета позиции этого тика (как mace.afterPacket): удар уходит с
// позицией, в которой мы его посчитали.
function afterPacket (bot, fn) {
  let done = false
  const run = () => { if (done) return; done = true; bot.removeListener?.('physicsTick', run); try { fn() } catch {} }
  if (typeof bot.prependListener === 'function') bot.prependListener('physicsTick', run)
  else if (typeof bot.on === 'function') bot.on('physicsTick', run)
  setImmediate(run)
}

export {
  smashBonus, divePlan, diveSmash, healthOf, afterPacket
}
