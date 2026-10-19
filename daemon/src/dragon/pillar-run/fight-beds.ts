'use strict'
// Бой с драконом (fightDragon) — шаги оборота про кровати: бюджет кроватей и цикл одной посадки (ocLanding), посадка
// у построенного столба (окоп, меч R), цепочка кроватей сидящему (bedsPerch), добивание и ожидание у станции после кроватей.
import {
  gameClock, Vec3, findItem, sleep, CENTER, stepTo, dragonOf, phaseOf, PHASE, items, SITTING, envNum, envv, runnerOn,
  pillarTriesMax, KEEP_ON, KEEP_N, RUN_MELEE, BEDS_KIT, dragonWaitBand, dragonWaitStop, holdingOdds
} from '../dig-down-to'
import { doing, pickSpot, nearPillar, r1, podiumTop, nearEdge } from '../fall-guard'
import { dangerAt, countOf, evade, lookAtSafe } from '../evade-raw'
import { tidy, pillarHere, rangedShot, crysAlive, CRYS_BAND } from '../station-plan'
import { crysOn, stationBedPlaced, OC_ON } from '../pillar-plan'
import { hazardNow } from './sight-zones'
import { walkTo } from './walk'
import { perchAttack } from './perch'
import { crystalWait } from './crystals'
import { meleeFinish } from './sword'
import { ocLanding } from './oc'
import { bedsPerch } from './beds-perch'
import { type Fight, type FightTick, type Turn } from './fight-state'

// Бюджет кроватей спидраннера и окоп столба на этот оборот; снижение у столба — один цикл посадки (ocLanding).
export async function fightBedsPlan (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot, track, feed, d } = fx
  const { ph, hp } = t
  // Бюджет кроватей спидраннера (≤ 8, 01.10): все — в цепочку станции у столба на одном снижении. Сидящему (взлёт после
  const bedsN = t.bedsN = countOf(bot, /_bed$/) + (stationBedPlaced(bot, ctl) ? 1 : 0)
  const finish = t.finish = hp != null && hp <= 45 * Math.min(bedsN, 2) + 5
  const stationLater = !!ctl.pillarMode && (ctl.pillarTries || 0) < pillarTriesMax() && ((ctl.pillar && ctl.pillar.built) || runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1)
  const keepBeds = t.keepBeds = KEEP_ON && ctl.bedsOnly && stationLater && bedsN <= KEEP_N && !finish
  // st1-s23: «держаться в окопе» при сидящем копало окоп заново у его головы — смерть; не в окопе — тоже наружу
  const builtPl = t.builtPl = ctl.pillar && ctl.pillar.built ? ctl.pillar.plan : null
  const holdPh = t.holdPh = ph === PHASE.LANDING || ph === PHASE.TAKEOFF || SITTING.has(ph)
  const inTrench = t.inTrench = keepBeds && holdPh && !!builtPl && (() => { const q = bot.entity.position; return (Math.floor(q.x) === builtPl.B.x && Math.floor(q.z) === builtPl.B.z && Math.abs(q.y - builtPl.feet.y) < 0.3) || !!pillarHere(bot, builtPl) })()
  const holdOut = t.holdOut = keepBeds && holdPh && !inTrench
  if (ctl.bedsOnly && OC_ON && !keepBeds && ph === PHASE.LANDING && feed.fc && feed.fc.id === d.id) {
    const key = d.id + ':' + fx.ocLandStart
    if (key !== fx.ocLandKey && feed.fc.n >= 40 && feed.fc.n <= 190) {
      fx.ocLandKey = key
      await ocLanding(session, ctl, rep, stats, track, feed)
      return 'next'
    }
  }
}

export async function fightKeepBeds (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, stats, bot, track, d } = fx
  const { ph, hp, ctx, parts, keepBeds, builtPl, inTrench } = t
  // Только кровати: сел — посадка целиком в bedsPerch (свои проверки облаков,
  // фаерболов и коробок дракона — по высоте точные: земля у фонтана под ними).
  if (keepBeds && SITTING.has(ph) && ctl.pillar && ctl.pillar.built) {
    const bad0 = dangerAt(bot, bot.entity.position, ctx)
    if (bad0) { await evade(bot, ctl, stats, { ...bad0, ctx }); return 'next' }
    // R (02.10, rs3: после 4 кроватей дракону оставалось 1–24 хп в 7 из 11 проигрышей): кроватей нет, дракон сел — мечом
    // в голову, один заход на посадку (сидячий счёт до 50 удары не поднимают). ND_RUN_MELEE=1 — вкл., пока не замерено.
    const sitKey = d.id + ':' + fx.ocLandStart
    if (RUN_MELEE() && builtPl && builtPl.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && hp != null && hp <= envNum('ND_RUN_MELEE_HP', 35) && bot.health >= 12 && ctl.meleeKey !== sitKey) {
      ctl.meleeKey = sitKey
      doing(ctl, 'pillar:melee')
      const f = await meleeFinish(session, ctl, stats, track, { blind: false })
      if (ctl.trace) ctl.trace.ev('runnerMelee', { ok: f.ok, why: f.why || null, hits: f.hits || 0, hp0: r1(hp) })
      return 'next'
    }
    if (inTrench) {
      doing(ctl, 'pillar:hold')
      await lookAtSafe(bot, parts.bodyC)
      await sleep(150)
      return 'next'
    }
  }
}

export async function fightBedsPerch (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, track } = fx
  const { ph, bedsN, keepBeds } = t
  if (ctl.bedsOnly && bedsN > 0 && SITTING.has(ph) && !keepBeds) {
    await bedsPerch(session, ctl, rep, stats, track)
    await sleep(60)
    return 'next'
  }
}

export async function fightBedsOnly (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot, track, d } = fx
  const { ph, hp, parts, holdOut, me, window, perched } = t
  const bedsSpent = t.bedsSpent = countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl)
  const finishBow = t.finishBow = !!findItem(bot, /^bow$/) && countOf(bot, /arrow$/) > 0
  // После кроватей использовать оставшиеся стрелы, даже если кристалл уже успел вылечить дракона.
  if (ctl.bedsOnly && finishBow && (bedsSpent || (hp != null && hp <= 20)) && !SITTING.has(ph) && ph !== PHASE.LANDING && !perched && gameClock.now() - fx.lastShot > 900) {
    fx.lastShot = gameClock.now()
    // (02.10 вечер, rs12-s8/s15/s18: сюда передавали false — bow.shoot звал hazardSoon() и вызов «сорвался» при драконе 0.2–12 хп
    // сразу после взлёта с меча; добивания из лука в полёте не было ни разу)
    if (await rangedShot(session, ctl, stats, track, d, () => !!hazardNow(bot))) { stats.finishArrows = (stats.finishArrows || 0) + 1; return 'next' }
  }
  if (ctl.bedsOnly) {
    // Кровати — основной урон; их расход не обрывает бой, пока есть меч или стрелы.
    const swordMore = bedsSpent && !!items.bestWeapon(bot)
    if (swordMore && !ctl.swordMoreT) { ctl.swordMoreT = gameClock.now(); if (ctl.trace) ctl.trace.ev('swordMore', { hp: r1(hp), alive: crysAlive(ctl) }) }
    if (bedsSpent && !swordMore && !finishBow) {
      rep.dragon.lost = 'кровати и стрелы кончились, оружия нет'; rep.need = { what: 'red_bed', count: BEDS_KIT, have: 0 }
      // 02.10 (rs2-s9): кровати кончились в окопе/чаше у фонтана — бот стоял под сидящим драконом после конца вызова и
      // погиб (11 хп после своих взрывов, удар дракона). Уйти на кольцо 23–27 (вне обзора сидящего), потом вернуть управление.
      if (dragonOf(bot) && Math.hypot(me.x - CENTER.x, me.z - CENTER.z) < 21 && !ctl.bedsOut) {
        ctl.bedsOut = true
        doing(ctl, 'beds:out')
        const P1 = podiumTop(bot)
        const spot = pickSpot(bot, CENTER, { rMin: 23, rMax: 27, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P1 != null && f.y > P1 - 2.5) })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 15000 }).catch(() => {})
        if (ctl.trace) ctl.trace.ev('bedsOut', { to: spot ? [r1(spot.feet.x), r1(spot.feet.y), r1(spot.feet.z)] : null, at: [r1(bot.entity.position.x), r1(bot.entity.position.y), r1(bot.entity.position.z)], hp: r1(bot.health) })
      }
      return 'stop'
    }
    if (swordMore && SITTING.has(ph) && !(ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner)) {
      await perchAttack(session, ctl, rep, stats, track); await sleep(50); return 'next'
    }
    // Ждать следующую посадку у станции, попутно сбивая доступные кристаллы.
    const fromC0 = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
    const P0 = podiumTop(bot)
    const high = P0 != null && me.y > P0 - 2.5
    // Кольцо 27–31 на время облёта (заходов с фаерболом по формуле меньше:
    const far = false
    // Заходит на посадку (фаза 2 — до снижения ещё 5–15 с, фаерболов нет): ближе к
    const stationR = !!(ctl.pillar && ctl.pillar.built)
    if (crysOn() && stationR && !window && !perched && !holdOut) {
      if (await crystalWait(session, ctl, stats, d, ph)) return 'next'
    }
    const crysBand = crysOn() && stationR && !!ctl.crys && ctl.crys.active && !window && !holdOut && ph !== PHASE.APPROACH
    // Дальнее ожидание (ND_WAIT_FAR=1, выкл.): заходов с фаерболом меньше — nextInt(⌊d²/512⌋+2): r 15 → 1/2, r 30–33 → 1/3–1/4;
    const waitFar = stationR && envv('ND_WAIT_FAR') === '1' && !holdOut && ph !== PHASE.APPROACH
    const bucketBand = dragonWaitBand({ station: stationR, crystalActive: crysBand, holdOut, ph })
    const [r0, r1b] = bucketBand || (holdOut ? [23, 27] : OC_ON && ph === PHASE.APPROACH ? [9.5, 11.5] : crysBand ? CRYS_BAND : waitFar ? [27, 33] : [15, 16.5])
    if ((!window || holdOut) && !perched && (fromC0 > r1b + 1 || fromC0 < r0 - 0.7 || (high && !crysBand) || nearEdge(bot, me, 2))) {
      let spot = pickSpot(bot, CENTER, { rMin: r0, rMax: r1b, step: crysBand ? 1.5 : 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (!far && !crysBand && P0 != null && f.y > P0 - 2.5) })
      if (!spot && (crysBand || waitFar || bucketBand)) spot = pickSpot(bot, CENTER, { rMin: 15, rMax: 16.5, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
      doing(ctl, 'beds:reposition')
      if (spot) {
        // Начался APPROACH — сразу вернуть управление pillarEnter, не заканчивать отход на кольцо.
        const stopWait = bucketBand ? () => dragonWaitStop(phaseOf(bot, dragonOf(bot))) : null
        if (bucketBand && ctl.trace && P0 != null) ctl.trace.ev('waitBucket', { ...holdingOdds(crysAlive(ctl) ?? 10, spot.feet, new Vec3(CENTER.x, P0 + 0.5, CENTER.z)), to: [spot.feet.x, spot.feet.y, spot.feet.z], knownAlive: crysAlive(ctl) })
        if (spot.feet.distanceTo(me) > 8) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000, sprint: crysBand || waitFar || !!bucketBand, stopIf: stopWait })
        else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.5, stop: stopWait })
      } else await sleep(200)
      return 'next'
    }
    if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
    doing(ctl, window ? 'beds:landing' : 'beds:wait')
    await lookAtSafe(bot, parts.bodyC)
    await sleep(100)
    return 'next'
  }
}
