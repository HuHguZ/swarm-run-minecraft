'use strict'
// Бой с драконом (dragon/pillar-run.ts): добивание мечом и меч бегуна.
const { gameClock, playerBox, sleep, stepTo, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, partsOf, clearControls, PHASE_RU, hpOf, envNum, pvp, boxDist, PART }: typeof import('../dig-down-to') = require('../dig-down-to')
const { doing, r1 }: typeof import('../fall-guard') = require('../fall-guard')
const { noteNear, lookAtSafe, landingForecast, landingHits, hurtNear }: typeof import('../evade-raw') = require('../evade-raw')
const { SWORD_V2, SWORD_PED, swordPick, runnerAim, meleeSpot }: typeof import('../pillar-plan') = require('../pillar-plan')
import { sitState, sitAcc, noteSitDamage } from './sight-zones'
import { bedsGo } from './beds-act'

async function meleeFinish (session, ctl, stats, track, { blind = true }: any = {}) {
  const bot = session.bot
  const w = items.bestWeapon(bot)
  if (!w) return { ok: false, why: 'нет меча' }
  let d = track.tick()
  if (!d || !SITTING.has(phaseOf(bot, d))) return { ok: false, why: 'не сидит' }
  let parts = partsOf(bot, d, track)
  // видящему — только почти на оси морды (голова поворачивается к нам); нет такого места — как слепому
  const spot = meleeSpot(bot, d, parts, { blind }) || (blind ? null : meleeSpot(bot, d, parts, { blind: true }))
  if (!spot) return { ok: false, why: 'нет места у головы' }
  doing(ctl, 'finish:go')
  if (ctl.trace) ctl.trace.ev('finish', { hp: r1(hpOf(bot, d)), acc: r1(sitAcc.dmg), at: [r1(spot.ground.x), spot.ground.y, r1(spot.ground.z)] })
  const g = await bedsGo(session, ctl, { feet: spot.ground, B: { x: Math.floor(spot.ground.x), z: Math.floor(spot.ground.z) }, y: spot.ground.y }, true, parts)
  if (!g.ok) return { ok: false, why: g.why }
  await bot.equip(w, 'hand').catch(() => {})
  let next = gameClock.now() + 100; let hits = 0
  stats.melee = stats.melee || 0
  while (!ctl.aborted) {
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    const hp = hpOf(bot, d)
    if (!SITTING.has(ph) || (hp != null && hp <= 0) || bot.health < 8) break
    parts = partsOf(bot, d, track)
    const eye = bot.entity.position.offset(0, EYE, 0)
    const reach = boxDist(eye, parts.head)
    if (reach > 3.0 || hurtNear(playerBox(bot.entity.position), parts)) break
    await lookAtSafe(bot, parts.headC)
    if (gameClock.now() >= next) {
      bot.attack({ id: d.id + PART.head })
      hits++; stats.melee++
      next = gameClock.now() + pvp.cooldownMs(bot.heldItem)
      gameClock.setTimeout(() => { const dd = dragonOf(bot); if (dd) noteSitDamage(bot, dd, phaseOf(bot, dd)) }, 150)
    }
    await sleep(50)
  }
  if (ctl.trace) ctl.trace.ev('finishDone', { hits, hp: d ? r1(hpOf(bot, d)) : 0 })
  return { ok: true, hits }
}

async function runnerSword (session, ctl, stats, track, feed, plan) {
  const bot = session.bot
  const out: any = { hits: 0, by: {}, hp0: null, hpMin: null, phases: [], why: null, ms: 0, back: 0 }
  const w = items.bestWeapon(bot)
  if (!w) { out.why = 'нет меча'; return out }
  const t0 = gameClock.now()
  try { await bot.equip(w, 'hand') } catch (e) { out.why = 'меч: ' + e.message; return out }
  // смена предмета обнуляет силу удара (attackStrengthTicker): первый удар — через полную перезарядку
  let next = gameClock.now() + pvp.cooldownMs(bot.heldItem)
  let lastPh = null; let sitT = null
  const P = plan.P
  while (!ctl.aborted && gameClock.now() - t0 < envNum('ND_RUN_SWORD_MS', 45000)) {
    const d = track.tick()
    if (!d) { out.why = 'дракона нет'; break }
    const ph = phaseOf(bot, d); const hp = hpOf(bot, d)
    if (out.hp0 == null && hp != null) out.hp0 = r1(hp)
    if (hp != null) out.hpMin = out.hpMin == null ? r1(hp) : Math.min(out.hpMin, r1(hp))
    if (ph !== lastPh) { out.phases.push(PHASE_RU[ph] ?? ph); lastPh = ph }
    if (hp != null && hp <= 0) { out.why = 'убит'; break }
    if (ph === PHASE.DYING) { out.why = 'умирает'; break }
    // v2: на взлёте — пока есть кого бить (до 2.5 с без цели — конец)
    const takeoff = SWORD_V2() && ph === PHASE.TAKEOFF
    if (takeoff) { out.toT = out.toT || gameClock.now(); if (gameClock.now() - (out.lastTgt || out.toT) > 2500 || gameClock.now() - out.toT > 6000) { out.why = 'взлетел'; break } }
    if (ph !== PHASE.LANDING && !SITTING.has(ph) && !takeoff) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; break }
    if (bot.health < 8) { out.why = 'мало хп'; break }
    const now = gameClock.now()
    if (SITTING.has(ph)) { const rc = sitState(d, ph, now); if (rc) noteNear(rc, d, bot, now); noteSitDamage(bot, d, ph); if (!sitT) sitT = now } else sitT = null
    const q = bot.entity.position
    const home = out.ped ? plan.feet.offset(0, 1, 0) : plan.feet
    // сидит, а достать некого — встать на блок (ND_RUN_SWORD_PED)
    if (SWORD_PED() && !out.ped && !out.pedTried && sitT && now - Math.max(sitT, out.lastTgt || 0) > 1200 && bot.entity.onGround && q.distanceTo(plan.feet) < 0.4 && d.position.y >= P + 0.7 && bot.health >= 12) {
      const tw = await build.towerUp(bot, ctl, 1).catch(e => ({ placed: 0, reason: e.message }))
      clearControls(bot)
      out.ped = !!(tw && tw.placed); out.pedWhy = out.ped ? null : (tw && tw.reason) || 'не встал'
      if (!out.ped) out.pedTried = true
      try { await bot.equip(w, 'hand') } catch {}
      next = gameClock.now() + 600
      if (ctl.trace) ctl.trace.ev('swPed', { ok: out.ped, why: out.pedWhy || null, Y: r1(d.position.y - P) })
      continue
    }
    // толчок сдвинул из защищённой клетки — назад (в чаше шаг-другой)
    if (q.distanceTo(home) > 0.5 && !(out.ped && q.distanceTo(plan.feet) <= 0.5)) {
      if (++out.back > 12) { out.why = 'не вернулся в клетку'; break }
      await stepTo(bot, ctl, home, { ms: 900, sprint: false, stopAt: 0.15, clouds: false })
      clearControls(bot)
      continue
    }
    // на снижении прогноз пути задевает клетку — как в цепочке R, не стоять (решает основной цикл)
    if (ph === PHASE.LANDING && feed) {
      const fc = landingForecast(feed, P)
      if (fc) { const k = Math.max(0, Math.round((now - fc.t) / 50)); const hit = landingHits({ path: fc.path.slice(k, k + 4) }, q); if (hit) { out.why = 'R: ' + hit.what; break } }
    }
    // взлёт: голова/шея/тело рядом с нами (модель с запасом) — не стоять под ними, выход
    if (takeoff && hurtNear(playerBox(q), partsOf(bot, d, track))) { out.why = 'взлёт: части над нами'; break }
    if (now >= next) {
      const parts = partsOf(bot, d, track)
      const t = swordPick(bot, parts, q.offset(0, EYE, 0))
      if (t) {
        if (!bot.heldItem || bot.heldItem.name !== w.name) { try { await bot.equip(w, 'hand') } catch {} next = gameClock.now() + pvp.cooldownMs(bot.heldItem); continue }
        runnerAim(bot, t.point)
        bot.attack({ id: d.id + t.id })
        out.hits++; out.by[t.name] = (out.by[t.name] || 0) + 1
        stats.swordHits = (stats.swordHits || 0) + 1
        if (ctl.trace) ctl.trace.ev('sw', { part: t.name, dist: r1(t.dist * 100) / 100, hp: hp != null ? r1(hp) : null, ph })
        // v2: шаг 575 мс (~11.5 тика: свежий удар — ≥ 10 тиков, сила ≥ 0.92) вместо 675 (625 + тик запаса): по не-голове урон
        // dmg/4 + 1 — частые удары выгоднее (≈ 4.2/с против 3.7/с), меньше лечения до сидячего порога 50
        next = SWORD_V2() ? now + envNum('ND_RUN_SWORD_HIT_MS', 575) : now + pvp.cooldownMs(bot.heldItem)
        out.lastTgt = now
      }
    }
    await sleep(SWORD_V2() ? 8 : 25)
  }
  out.ms = gameClock.now() - t0
  return out
}

export {
  meleeFinish, runnerSword
}
