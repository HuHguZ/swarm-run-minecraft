'use strict'
// Бой с драконом (dragon/pillar-run.ts): двойной подрыв и кровати на насесте.
const { gameClock, Vec3, playerBox, FILLER_RE, nearPortal, cloudsOf, sleep, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, EYE, SITTING, partsOf, PHASE_RU, hpOf, fireballsOf, sitFix }: typeof import('../dig-down-to') = require('../dig-down-to')
const { doing, r1, podiumTop, standY, hasEffect }: typeof import('../fall-guard') = require('../fall-guard')
const { dangerAt, countOf, evade, noteNear, lookAtSafe, hurtNear, tsClickPoint }: typeof import('../evade-raw') = require('../evade-raw')
const { headPoint, BED_GAP_MS, OC_ON, exposedNow, doubleHit, doubleBuild, shieldFor, bedsBuild, bedClickPoint, BEDS_TAKEOFF, seeCalibrate, BEDS_DOUBLE }: typeof import('../pillar-plan') = require('../pillar-plan')
const { placeNoBed, placeBedAt, turnSafe, tsPlan, TURN_SAFE_R, clearOfDragon }: typeof import('../ts-plan') = require('../ts-plan')
import { sitRec, sitState, blindKnown, sitAcc, dragonZones } from './sight-zones'
import { heal } from './walk'
import { bedsLayout, bedsDouble } from './beds-plan'
import { bedsGo, bedsBoom } from './beds-act'
import { meleeFinish } from './sword'
import { tsBuild } from './ts-build'
import { ocTakeoffRun, ocT1, seeStation } from './oc'

async function doubleRun (session, ctl, rep, stats, track, P, plan0) {
  const bot = session.bot
  let plan = plan0
  const onSpot = () => { const p = bot.entity.position; return Math.hypot(p.x - plan0.feet.x, p.z - plan0.feet.z) < 0.55 && Math.abs(p.y - plan0.y) < 0.3 }
  const g = await bedsGo(session, ctl, { feet: plan.feet, B: plan.S, y: plan.y }, bot.health >= 16, partsOf(bot, dragonOf(bot), track))
  if (!g.ok) return { ok: false, why: g.why }
  ctl.holdStation = true
  try { return await doubleRunAt(session, ctl, rep, stats, track, P, plan, onSpot) } finally { ctl.holdStation = false }
}

async function doubleRunAt (session, ctl, rep, stats, track, P, plan, onSpot) {
  const bot = session.bot
  const b = await doubleBuild(session, ctl, stats, plan)
  if (!b.ok) return b
  if (ctl.trace) ctl.trace.ev('double', { S: [plan.S.x, plan.y, plan.S.z], X: [plan.X.H.x, plan.X.H.z, plan.X.expect], C: [plan.C.H.x, plan.C.H.z, plan.C.expect], n: plan.nPlace })
  // C лежит — её можно взорвать на взлёте и после кровати из запасного плана.
  stats.pendingC = { C: plan.C, y: plan.y, plan }
  let booms = 0
  for (let k = 0; k < 3 && !ctl.aborted; k++) {
    while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
    const d = dragonOf(bot)
    if (!d) break
    const ph = phaseOf(bot, d)
    if (!SITTING.has(ph)) break
    // Новый круг «высматривает» у видящего: голова доворачивает к нам (мы вне её
    // круга) — ждать рёва и проверить, что голова всё ещё над X.
    if (ph === PHASE.SCANNING && !blindKnown(sitRec)) {
      const tw = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw < 2000) {
        dragonZones(bot)
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.SCANNING || blindKnown(sitRec)) break
        doing(ctl, 'beds:wait-scan')
        await sleep(50)
      }
      k--
      const dd = dragonOf(bot)
      if (!dd || !SITTING.has(phaseOf(bot, dd))) break
      const hd = headPoint(bot, dd, track, 0)
      if (hd.distanceTo(plan.X.centre) > 3.2) return { ok: false, why: 'голова ушла от X', booms }
      continue
    }
    if (bot.health < 8) return { ok: false, why: 'мало хп перед щелчком', booms }
    if (!onSpot()) return { ok: false, why: 'сдвинуло с места', booms }
    if (!(await shieldFor(session, ctl, stats, plan, plan.X))) return { ok: false, why: 'взрыв X видит нас — стенку не поправить', booms }
    const hit = doubleHit(bot, plan, plan.X)
    if (!hit) return { ok: false, why: 'X не видно', booms }
    const boom = await bedsBoom(session, ctl, stats, { H: plan.X.H, y: plan.y, dist: plan.X.dist, expect: plan.X.expect, D: plan.X.f }, hit, 'сидит')
    if (!boom.ok) return { ok: false, why: boom.why, booms }
    booms++
    P.beds.push(boom.dmg)
    const d2 = dragonOf(bot)
    if (!d2 || !SITTING.has(phaseOf(bot, d2))) break
    // Сидит (сидячий счёт ≤ 50): ещё X с того же места — заново план с этой клеткой.
    if (countOf(bot, /_bed$/) < 2) break
    const again = bedsDouble(bot, d2, partsOf(bot, d2, track), { brave: true, fixS: plan.S })
    if (!again) {
      // Нового места под головой нет — та же кровать X, если пол под изножьем цел.
      if (ctl.trace) ctl.trace.ev('bedFail', { why: 'повтор X: плана нет', no: bedsDouble.why })
      const r0 = await placeBedAt(bot, plan.X.F, plan.X.H, plan.y)
      if (!r0.ok) { P.lastWhy = `повтор X: ${r0.why}`; break }
      for (const w of plan.walls) if (!isSolid(bot.blockAt(new Vec3(w.x, plan.y, w.z)))) { const rw = await placeNoBed(bot, new Vec3(w.x, plan.y, w.z), { timeoutMs: 1200 }); if (!rw.ok) { P.lastWhy = 'повтор X: стенка'; break } }
      continue
    }
    plan = again
    stats.pendingC = { C: plan.C, y: plan.y, plan }
    const r = await doubleBuild(session, ctl, stats, plan)
    if (!r.ok) { if (ctl.trace) ctl.trace.ev('bedFail', { why: `повтор X: ${r.why}` }); break }
  }
  if (await tryC(session, ctl, stats, track, P)) booms++
  return { ok: true, booms }
}

async function tryC (session, ctl, stats, track, P) {
  const bot = session.bot
  const pc = stats.pendingC
  const d3 = dragonOf(bot)
  if (!pc || !d3 || phaseOf(bot, d3) !== PHASE.TAKEOFF || gameClock.now() - (stats.lastBoom || 0) > 900) return false
  const hb = bot.blockAt(new Vec3(pc.C.H.x, pc.y, pc.C.H.z))
  if (!hb || !/_bed$/.test(hb.name)) { stats.pendingC = null; return false }
  if (exposedNow(bot, pc.y, pc.C)) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C: взрыв видит нас' }); return false }
  while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(15)
  const hit = doubleHit(bot, { y: pc.y }, pc.C)
  if (!hit) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C не видно' }); return false }
  const hd = headPoint(bot, d3, track, 0)
  // Голова уже далеко — взрыв впустую (0 урона), а кровать — последняя из запаса.
  if (hd.distanceTo(pc.C.centre) > 7.5) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C: голова далеко', dist: r1(hd.distanceTo(pc.C.centre)) }); return false }
  const boom = await bedsBoom(session, ctl, stats, { H: pc.C.H, y: pc.y, dist: r1(hd.distanceTo(pc.C.centre)), expect: pc.C.expect, D: pc.C.f }, hit, 'взлёт')
  stats.pendingC = null
  if (boom.ok) { P.beds.push(boom.dmg); return true }
  return false
}

async function bedsPerch (session, ctl, rep, stats, track) {
  const bot = session.bot
  let d = track.tick()
  if (!d) return
  const tIn = gameClock.now()
  const rec0 = sitState(d, phaseOf(bot, d), tIn)
  const key = rec0 ? rec0.t0 : tIn
  stats.bedPerches = stats.bedPerches || []
  let P = stats.bedPerches.find(p => p.key === key)
  if (!P) {
    P = { key, at: Math.round((key - (ctl.started || key)) / 1000), hp0: Math.round(hpOf(bot, d) ?? 0), beds: [], fails: 0 }
    stats.bedPerches.push(P)
    if (ctl.trace) ctl.trace.ev('bedsPerch', { hp: P.hp0, acc: Math.round(sitAcc.dmg) })
  }
  // План «взлёт» с этой посадки (ocLanding: L уже взорвана) — A, T1, T2 вместо A, B.
  if (ctl.ocTk && ctl.ocTk.dId === d.id && gameClock.now() - ctl.ocTk.t < 8000 && blindKnown(rec0) && !P.tk) {
    const tkP = ctl.ocTk; ctl.ocTk = null; P.tk = true
    const r = await ocTakeoffRun(session, ctl, rep, stats, track, P, tkP)
    const dd = dragonOf(bot)
    if (!dd || !SITTING.has(phaseOf(bot, dd))) return
    P.tkWhy = r.why
  }
  let tries = 0
  let stayAt = null
  // Планы, что сейчас не вышли (пол не встал, кровать не легла): ключ → до когда.
  const failed = new Map()
  const skipNow = () => { const s = new Set(); for (const [k, t] of failed) if (t > gameClock.now()) s.add(k); return s }
  while (!ctl.aborted && tries < 14) {
    await yieldTick()
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    const hpD = hpOf(bot, d)
    if (hpD != null && hpD <= 0) break
    const now = gameClock.now()
    const sitting = SITTING.has(ph)
    const takeoffWin = BEDS_TAKEOFF && ph === PHASE.TAKEOFF && now - (stats.lastBoom || 0) < 700
    if (!sitting && !takeoffWin) break
    if (countOf(bot, /_bed$/) < 1) { P.why = 'кровати кончились'; break }
    if (countOf(bot, FILLER_RE) < 1) { P.why = 'нет блоков на заслон'; break }
    const rec = sitState(d, ph, now)
    if (rec) noteNear(rec, d, bot, now)
    const parts = partsOf(bot, d, track)
    // Под ногами облако или летит фаербол — уйти и продолжить.
    const sweep = sitting && !blindKnown(rec, now) ? { pos: d.position, dir: parts.dir } : null
    const ctx0 = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 30), parts: null, breath: null, sweep }
    // Видящий высматривает — голова пойдёт к нам: из круга её поворота выйти.
    const seeingScan = sitting && ph === PHASE.SCANNING && !blindKnown(rec, now)
    if (seeingScan && !turnSafe(d, bot.entity.position)) {
      const me = bot.entity.position
      const rx = me.x - d.position.x; const rz = me.z - d.position.z; const rh = Math.hypot(rx, rz) || 1
      const tx = d.position.x + rx / rh * (TURN_SAFE_R + 1.2); const tz = d.position.z + rz / rh * (TURN_SAFE_R + 1.2)
      const ty = standY(bot, tx, tz, me.y, 2, 3)
      doing(ctl, 'beds:out-of-turn')
      if (ctl.trace) ctl.trace.ev('evade', { kind: 'круг поворота головы', to: [r1(tx), ty, r1(tz)] })
      if (ty != null) await stepTo(bot, ctl, new Vec3(tx, ty, tz), { ms: 1200, stopAt: 0.4 })
      else await sleep(100)
      tries++
      continue
    }
    const bad = dangerAt(bot, bot.entity.position, ctx0) || (hurtNear(playerBox(bot.entity.position), parts) ? { kind: 'голова дракона' } : null)
    if (bad && !(bot.health >= 16 && /облако/.test(bad.kind))) { await evade(bot, ctl, stats, { ...bad, ctx: { ...ctx0, parts } }); tries++; continue }
    if (bot.health < 9) {
      await heal(session, ctl, rep, stats, { hard: true })
      if (bot.health < 9) { P.why = `мало хп (${Math.round(bot.health)})`; break }
    }
    // Видящий первые 25 тиков доворачивает голову к нам — план до рёва только
    // чтобы подойти; кровать — когда голова встала (рёв/огонь) или слепой.
    const settled = !sitting || !rec || blindKnown(rec, now) || ph !== PHASE.SCANNING
    // Голова ещё поворачивается (видящий высматривает, первые 25 тиков): идти
    if (!settled) {
      const me = bot.entity.position
      const rx = me.x - d.position.x; const rz = me.z - d.position.z
      const rh = Math.hypot(rx, rz) || 1
      const P0 = podiumTop(bot)
      if (rh > 12.5) {
        const tx = d.position.x + rx / rh * 11; const tz = d.position.z + rz / rh * 11
        const ty = standY(bot, tx, tz, me.y, 2, 3)
        const t = ty != null ? new Vec3(Math.floor(tx) + 0.5, ty, Math.floor(tz) + 0.5) : null
        if (t && !nearPortal(t) && !(P0 != null && ty > P0 - 2.5) && clearOfDragon(bot, me, t, parts)) {
          doing(ctl, 'beds:approach')
          await stepTo(bot, ctl, t, { ms: 1200, sprint: true, stopAt: 0.6 })
          continue
        }
      }
      doing(ctl, 'beds:ready')
      await lookAtSafe(bot, parts.headC)
      await sleep(80)
      continue
    }
    let headAt = null
    if (takeoffWin) {
      // Взлёт: голова идёт вперёд по взгляду, к щелчку (конец неуязвимости) —
      // ~4.5 блока за 10 тиков от старта (трассы), чуть выше; щёлкаем с той же клетки.
      const lead = Math.max(2, (stats.lastBoom + BED_GAP_MS + 150 - now) / 50)
      const v = track.vel()
      const sp = Math.max(0.45, Math.hypot(v.x, v.z))
      headAt = new Vec3(parts.headC.x + parts.dir.x * sp * lead, parts.head.min.y + 0.8, parts.headC.z + parts.dir.z * sp * lead)
      const p = bot.entity.position
      stayAt = { x: Math.floor(p.x), z: Math.floor(p.z) }
    }
    // Видящий, голова встала (рёв/огонь): станции в окопе у неё — A (≤ 50 − счёт), потом B.
    if (OC_ON && process.env.ND_SEE_TS === '1' && sitting && !takeoffWin && rec && rec.roared && ph !== PHASE.SCANNING && countOf(bot, /_bed$/) >= 1 && (P.seeFails || 0) < 3) {
      seeCalibrate(bot, d)
      const capS = sitAcc.dmg < 25 ? 49 - sitAcc.dmg : null
      const r: any = await seeStation(session, ctl, stats, track, d, P, { cap: capS })
      if (r.dmg != null) { tries++; continue }
      P.seeFails = (P.seeFails || 0) + 1
    }
    // Слепой сидит, A уже была (счёт 20…50): вместо B (поднимет на взлёт с толчком) — T1 на
    if (OC_ON && process.env.ND_OC_T1 === '1' && sitting && !takeoffWin && blindKnown(rec, now) && sitAcc.dmg >= 20 && sitAcc.dmg <= 50 && !P.t1Tried && rec && now - rec.t0 < 2700 && countOf(bot, /_bed$/) >= 1) {
      P.t1Tried = true
      const r: any = await ocT1(session, ctl, stats, track, d, rec, P)
      if (r.dmg != null) break
    }
    const brave = bot.health >= 16 || (hasEffect(bot, 'absorption') && bot.health >= 12)
    // Первая кровать посадки — не больше 50 сидячего урона (иначе сразу взлёт и
    // второй сидя не будет). Настоящий урон — ожидаемый ± 3 (b1, 30.09).
    const cap = sitting && sitAcc.dmg < 30 ? 46 - sitAcc.dmg : null
    // Добить мечом: слепой сидит, хп ≤ остатка сидячего счёта (удары его не поднимут).
    if (sitting && blindKnown(rec, now) && hpD != null && hpD <= Math.max(7, 50 - sitAcc.dmg) && !P.finished) {
      P.finished = true
      const f = await meleeFinish(session, ctl, stats, track)
      if (f.ok) continue
    }
    // Сперва двойная станция (A/B под головой + C на взлёте); нет её — одна кровать.
    if (BEDS_DOUBLE && sitting && !takeoffWin && countOf(bot, /_bed$/) >= 2 && !(P.doubleFails >= 2)) {
      const dp = bedsDouble(bot, d, parts, { brave, cap, skip: skipNow() })
      if (dp) {
        const r: any = await doubleRun(session, ctl, rep, stats, track, P, dp)
        P.double = (P.double || 0) + 1
        if (r.ok) { if (!r.booms) tries++; continue }
        P.doubleFails = (P.doubleFails || 0) + 1
        P.lastWhy = r.why
        failed.set(dp.key, gameClock.now() + 5000)
        if (ctl.trace) ctl.trace.ev('bedFail', { why: `двойная: ${r.why}` })
        tries++
        continue
      }
      P.noDouble = bedsDouble.why
    }
    // Слепой сидит, первая кровать уже была (счёт ≥ 30): вторая — станцией в окопе под
    if (process.env.ND_OC_TSB === '1' && OC_ON && sitting && !takeoffWin && cap == null && blindKnown(rec, now) && !P.tsTried && rec && now - rec.t0 < 3300) {
      const fix = sitFix.get(d.id)
      if (fix && fix.head) {
        P.tsTried = true
        const tp = tsPlan(bot, fix.head, { lift: 1, dpos: d.position })
        if (ctl.trace) ctl.trace.ev('ocB', tp ? { H: [tp.H.x, tp.yb, tp.H.z], dist: tp.dist, expect: tp.expect } : { no: tsPlan.why })
        if (tp && tp.expect >= 52) {
          ctl.holdStation = true
          let tb
          try { tb = await tsBuild(session, ctl, stats, tp) } finally { ctl.holdStation = false }
          const dd = dragonOf(bot)
          if (tb.ok && dd && SITTING.has(phaseOf(bot, dd))) {
            const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tp)
            if (hit) {
              const boom = await bedsBoom(session, ctl, stats, tp, hit, 'сидит', { note: { oc: 'B' } })
              if (boom.ok) { P.beds.push(boom.dmg); continue }
            }
          }
          if (ctl.trace) ctl.trace.ev('bedFail', { why: `B в окопе: ${tb.ok ? 'щелчок' : tb.why}` })
        }
      }
    }
    const hurry = OC_ON && sitting && cap == null && blindKnown(rec, now) && !!rec && now - rec.t0 > 3000
    const plan = bedsLayout(bot, d, parts, { headAt, stayAt: takeoffWin ? stayAt : null, brave, cap, skip: skipNow(), liftMax: OC_ON && cap == null && blindKnown(rec, now) && !hurry ? 1 : 0, hurry })
    if (!plan) {
      P.noPlan = bedsLayout.why
      if (takeoffWin) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'взлёт: плана нет', no: bedsLayout.why }); break }
      tries++
      await lookAtSafe(bot, parts.headC)
      await sleep(120)
      continue
    }
    const g = await bedsGo(session, ctl, plan, brave, parts)
    if (!g.ok) { tries++; P.lastWhy = g.why; failed.set(plan.key, gameClock.now() + 1500); continue }
    ctl.holdStation = true
    let b
    try { b = await bedsBuild(session, ctl, stats, plan) } finally { ctl.holdStation = false }
    if (!b.ok) { tries++; P.fails++; P.lastWhy = b.why; failed.set(plan.key, gameClock.now() + 4000); if (ctl.trace) ctl.trace.ev('bedFail', { why: b.why, takeoff: takeoffWin || undefined }); continue }
    // Неуязвимость дракона после прошлого взрыва — 10 тиков.
    while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
    const d2 = dragonOf(bot)
    if (!d2) break
    const ph2 = phaseOf(bot, d2)
    if (!SITTING.has(ph2) && !(ph2 === PHASE.TAKEOFF && takeoffWin)) {
      // Взлетел, пока строили (его огни кончились) — кровать лежит: щёлкнуть, если голова ещё рядом.
      const hp2 = headPoint(bot, d2, track, 0)
      if (!(ph2 === PHASE.TAKEOFF && hp2.distanceTo(plan.centre) < 5)) break
    }
    if (bot.health < 8) { P.why = 'мало хп перед щелчком'; break }
    const pp = bot.entity.position
    if (Math.hypot(pp.x - plan.feet.x, pp.z - plan.feet.z) > 0.55 || Math.abs(pp.y - plan.y) > 0.3) { tries++; P.lastWhy = 'сдвинуло с места'; continue }
    const hit = bedClickPoint(bot, plan)
    if (!hit) { tries++; P.fails++; P.lastWhy = 'кровать не видно'; if (ctl.trace) ctl.trace.ev('bedFail', { why: 'не видно' }); continue }
    const why = takeoffWin || ph2 === PHASE.TAKEOFF ? 'взлёт' : SITTING.has(ph2) ? 'сидит' : PHASE_RU[ph2]
    const boom = await bedsBoom(session, ctl, stats, plan, hit, why)
    if (!boom.ok) { tries++; P.fails++; P.lastWhy = boom.why; continue }
    P.beds.push(boom.dmg)
    // Взлетел от неё, а C двойной станции лежит и видна — через 10 тиков в неё.
    if (boom.took) await tryC(session, ctl, stats, track, P)
    // Огонь под ногами после взрыва — шаг назад.
    const fire = bot.blockAt(bot.entity.position.floored())
    if (fire && /fire/.test(fire.name)) await stepTo(bot, ctl, bot.entity.position.offset(-plan.D.x * 1.2, 0, -plan.D.z * 1.2), { ms: 700, stopAt: 0.3 })
  }
  const dd = dragonOf(bot)
  P.hp1 = dd ? Math.round(hpOf(bot, dd) ?? 0) : 0
  P.secs = Math.round((gameClock.now() - key) / 100) / 10
}

export {
  doubleRun, doubleRunAt, tryC, bedsPerch
}
