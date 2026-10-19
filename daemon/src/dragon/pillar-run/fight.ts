'use strict'
// Бой с драконом (dragon/pillar-run.ts): станция и бой с драконом целиком.
const { gameClock, Vec3, findItem, FILLER_RE, cloudsOf, dbg, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, digDownTo, items, build, SITTING, partsOf, PHASE_RU, hpOf, envNum, isAirish, envv, runnerOn, fireballsOf, makeTrack, pillarTriesMax, PILLAR_BAD, KEEP_ON, KEEP_N, RUN_MELEE, BEDS_KIT, dragonWaitBand, dragonWaitStop, holdingOdds }: typeof import('../dig-down-to') = require('../dig-down-to')
const { hunters, doing, pickSpot, nearPillar, r1, podiumTop, overCloud, crystalsOf, breathOf, nearEdge }: typeof import('../fall-guard') = require('../fall-guard')
const { dangerAt, countOf, evade, sneakPlace, lookAtSafe }: typeof import('../evade-raw') = require('../evade-raw')
const { waterToHotbar, onSpike, getDown, onOwnPillar, tidy, dynamicPlace, stationPlan, bedHere, stationPlaceBed, stationBlow, pillarHere, pillarPlanAutoAsync, rangedShot, crysAlive, CRYS_BAND, chooseStation }: typeof import('../station-plan') = require('../station-plan')
const { headPoint, approachFar, crysOn, portalBlocks, noteTakeoff, RUN_SWORD, stationBedPlaced, runnerPlan, pillarPlan, pillarKey, OC_ON, takeoffSeen }: typeof import('../pillar-plan') = require('../pillar-plan')
import { sitRec, blindKnown, hazardNow, dragonZones } from './sight-zones'
import { refillBucket, walkTo, heal, clearOfClouds, hideAndHeal, fightEnderman } from './walk'
import { makeDragonFeed } from './feed'
import { perchAttack } from './perch'
import { earlyCrystalStep, crystalWait, destroyCrystals, mineEndStone } from './crystals'
import { meleeFinish, runnerSword } from './sword'
import { ocLanding } from './oc'
import { bedsPerch } from './beds-perch'
import { pillarBuild, pillarEnter } from './pillar-build'
import { pillarRun } from './runner'

async function stationBuild (session, ctl, st, stats) {
  const bot = session.bot
  let placed = 0; let failed = 0
  // Блоков нет — сразу сказать: без этого круг боя крутил станцию вхолостую
  if (countOf(bot, FILLER_RE) <= 4) return { placed, failed, noBlocks: true }
  for (const p of st.place) {
    if (ctl.aborted) break
    const b = bot.blockAt(p)
    if (b && isSolid(b)) continue
    const r = await sneakPlace(bot, p, { timeoutMs: 1500 })
    if (r.ok) placed++
    else { failed++; dbg('station place', p.toString(), r.reason); if (/нечем строить/.test(r.reason || '')) return { placed, failed, noBlocks: true } }
    if (hazardNow(bot)) break
  }
  stats.stationBlocks = (stats.stationBlocks || 0) + placed
  return { placed, failed }
}

async function stationStep (session, ctl, rep, stats, track, st, d, ph) {
  const bot = session.bot
  const me = bot.entity.position
  // Облако фаербола на станции (растёт 3 → 7 за 30 с) — не ходить туда, пока
  const lidded = c => c.pos.y >= st.B.y + 1.8
  if (cloudsOf(bot).some(c => !lidded(c) && Math.hypot(st.B.x - c.pos.x, st.B.z - c.pos.z) < c.r + 1.2 && Math.abs(c.pos.y - st.B.y) < 2)) return 'облако'
  const atB = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 0.6 && Math.abs(me.y - st.B.y) < 0.6
  if (!atB) {
    doing(ctl, 'station:walk')
    const near = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 4 && Math.abs(me.y - st.B.y) < 1.2
    const r = near ? await stepTo(bot, ctl, st.B, { ms: 2000, sprint: false, stopAt: 0.2 }) : await walkTo(session, ctl, st.B, { range: 0.4, timeoutMs: 20000 })
    // Не дошёл — помеха (фаербол, облако, эндермен, путь); станция негодна,
    if (!r.ok && Math.hypot(bot.entity.position.x - st.B.x, bot.entity.position.z - st.B.z) > 0.8) {
      st.walkFails = r.hazard || r.enderman ? (st.walkFails || 0) : (st.walkFails || 0) + 1
      return st.walkFails >= 3 ? 'fail' : 'помеха'
    }
    st.walkFails = 0
    await stepTo(bot, ctl, st.B, { ms: 700, sprint: false, stopAt: 0.12 })
    return 'дошёл'
  }
  // Блоки станции — взрыв кровати выбивает опору и верх стенок.
  const fresh = st.dynamic ? { ok: true, place: dynamicPlace(bot, st) } : stationPlan(bot, st.a)
  if (!fresh.ok) return 'fail'
  Object.assign(st, { place: fresh.place })
  const perch = ph === PHASE.LANDING || SITTING.has(ph) || ph === PHASE.TAKEOFF
  const hasBed = bedHere(bot, st)
  // Порядок: опора изножья (без неё кровать не положить) → кровать → стенки
  const buildList = async (list, what) => {
    doing(ctl, `station:${what}`)
    st.place = [...list].sort((p, q) => p.y - q.y || p.distanceTo(st.B) - q.distanceTo(st.B))
    const b = await stationBuild(session, ctl, st, stats)
    if (b.noBlocks) { stats.stationNoBlocks = true; return 'fail' }
    if (!b.placed && b.failed) st.buildFails = (st.buildFails || 0) + 1
    else if (b.placed) st.buildFails = 0
    return (st.buildFails || 0) >= 3 ? 'fail' : 'строю'
  }
  const support = fresh.place.filter(p => p.x === st.F.x && p.z === st.F.z)
  // Кривая кровать (изголовьем не туда, или половина) в клетках станции —
  // убрать: на её место новую не поставить, а щёлкать её — взрыв у самих нас.
  if (!hasBed) {
    for (const p of [st.F, st.H]) {
      const b = bot.blockAt(p)
      if (b && /_bed$/.test(b.name)) {
        doing(ctl, 'station:clear')
        try { await build.withTimeout(bot.dig(b, true), 2000) } catch (e) { dbg('station clear', e.message) }
        st.cleared = (st.cleared || 0) + 1
        return 'убрал кровать'
      }
    }
  }
  if (!hasBed && support.length) return buildList(support, 'support')
  if (!hasBed) {
    if (!findItem(bot, /_bed$/)) return 'кроватей нет'
    doing(ctl, 'station:bed')
    const r = await stationPlaceBed(bot, st)
    if (!r.ok) { st.bedFails = (st.bedFails || 0) + 1; dbg('station', r.why); if (st.bedFails >= 4) return 'fail' } else st.bedFails = 0
    return 'кровать'
  }
  // Стенки — пока летает; сидя — только высматривая (до огня ≥ 3 с), и только
  if (fresh.place.length) return buildList(fresh.place, 'build')
  if (perch) {
    const head = headPoint(bot, d, track, 2)
    const dist = head.distanceTo(st.blast)
    const was = st.lastDist
    st.lastDist = dist
    if (ctl.trace && (!st.headLog || gameClock.now() - st.headLog > 250)) {
      st.headLog = gameClock.now()
      ctl.trace.ev('head', { ph, dist: r1(dist), head: [r1(head.x), r1(head.y), r1(head.z)], d: [r1(d.position.x), r1(d.position.y), r1(d.position.z)], yaw: +d.yaw.toFixed(2) })
    }
    let go = null
    if (ph === PHASE.LANDING) {
      if (dist <= 2.0 || (was != null && dist > was && was <= 3.2)) go = 'садится'
    } else if (SITTING.has(ph)) {
      if (!st.sitSince) st.sitSince = gameClock.now()
      if (dist <= 3.2) go = 'сидит'
      else if (gameClock.now() - st.sitSince > 2500 && dist <= 4.5) go = 'сидит'
      // Готовая станция: ждать на месте — высматривая, дракон сам повернёт
      else if (st.dynamic && gameClock.now() - st.sitSince > 700 && dist > 4.5) { st.lastDist = null; st.sitSince = null; return 'далеко' }
      // не чистится — EnderDragon.aiStep не зовёт serverAiStep, и первое «не
      else if (gameClock.now() - st.sitSince > 1500) { st.lastDist = null; return 'далеко' }
    } else if (ph === PHASE.TAKEOFF) {
      if (dist <= 3.6) go = 'взлетает'
    }
    if (!SITTING.has(ph)) st.sitSince = null
    // Мало хп — не жать: за стенками взрыв снимает 0–0.4 (замер), но стенка
    // могла треснуть от прошлого взрыва так, что план этого не видит.
    if (go && bot.health >= 8) {
      await stationBlow(session, ctl, st, stats, d, track, go)
      st.lastDist = null
      return 'взрыв'
    }
    doing(ctl, 'station:wait')
    await lookAtSafe(bot, head)
    return 'жду голову'
  }
  st.lastDist = null
  return 'готово'
}

async function fightDragon (session, ctl, rep, stats, { deadline, perches = 0 }: any) {
  const bot = session.bot
  const active = () => !ctl.aborted && session.bot === bot && bot.isAlive !== false && bot.health > 0 && /end/.test(bot.game.dimension)
  const pause = ms => new Promise<void>(resolve => {
    let timer; let poll
    const done = () => { gameClock.clearTimeout(timer); gameClock.wall.clearInterval(poll); resolve() }
    timer = gameClock.setTimeout(done, ms)
    // Game time can stop after disconnect; lifecycle cancellation must still finish.
    poll = gameClock.wall.setInterval(() => { if (!active() || gameClock.now() >= deadline) done() }, 50)
  })
  const track = makeTrack(bot)
  const feed = ctl.feed || (ctl.feed = makeDragonFeed(bot))
  feed.onSit = o => { if (ctl.trace) ctl.trace.ev('ocSit', o) }
  let ocLandKey = null
  let ocLandStart = 0
  let ocPrevPh = null
  // «Не видно» — ещё не «убит»: убит, только если выходной портал горит. Иначе
  const lookFor = async (ms) => {
    const t0 = gameClock.now()
    let dd = track.tick()
    while (!dd && active() && gameClock.now() - t0 < ms && gameClock.now() < deadline) {
      // A missing island must still let disconnect, death and clock packets run.
      await yieldTick()
      if (!active() || gameClock.now() >= deadline || gameClock.now() - t0 >= ms) break
      if (portalBlocks(bot).length) return null
      doing(ctl, 'fight:search')
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 18) {
        const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 16 })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 20000 })
        else await pause(500)
      } else await pause(500)
      if (!active()) return null
      dd = track.tick()
    }
    return dd
  }
  let d = track.tick() || await lookFor(60000)
  if (!active()) { rep.dragon.lost = 'бой прерван: тело сменилось, погибло или вышло из Края'; return }
  if (!d) {
    rep.dragon.seen = false
    if (portalBlocks(bot).length) { rep.dragon.won = true; rep.dragon.lost = 'дракона нет, выходной портал горит — убит' } else rep.dragon.lost = 'дракона не видно минуту, выходной портал не горит — жив, но не найден'
    return
  }
  rep.dragon.seen = true
  rep.dragon.hpStart = Math.round(hpOf(bot, d) ?? 0)
  const hpLog = []
  let lastPhase = null
  let lastShot = 0
  let won = false
  // Станция кроватей: ось, число неудач по осям, когда пробовать снова.
  let st = null
  let dyn = null
  const stFails = new Map()
  let stationRetry = 0
  // Когда дракон последний раз поворачивался (голова «встала» — можно
  // собирать станцию под ней).
  let yawWas = null
  let yawSince = gameClock.now()
  let sitStart = 0
  let mineRetry = 0
  let refillAt = 0
  let crystalRetry = gameClock.now() + 20000
  stats.perchCount = stats.perchCount || 0
  while (active() && gameClock.now() < deadline) {
    await yieldTick()
    if (!active() || gameClock.now() >= deadline) break
    doing(ctl, 'fight')
    d = track.tick()
    if (!d) {
      // Исчез после «умирает» — победа. Иначе улетел из прорисовки.
      if (lastPhase === PHASE.DYING) { won = true; break }
      await pause(250)
      if (!active()) break
      if (!dragonOf(bot) && lastPhase === PHASE.DYING) { won = true; break }
      if (!dragonOf(bot) && !(await lookFor(30000))) {
        if (!active()) break
        if (portalBlocks(bot).length) { won = true; break }
        rep.dragon.lost = 'дракона не видно 30 с, выходной портал не горит'
        break
      }
      continue
    }
    const ph = phaseOf(bot, d)
    const hp = hpOf(bot, d)
    if (yawWas == null || Math.abs(d.yaw - yawWas) > 0.01) { yawWas = d.yaw; yawSince = gameClock.now() }
    if (SITTING.has(ph) && !sitStart) sitStart = gameClock.now()
    if (!SITTING.has(ph)) sitStart = 0
    noteTakeoff(d, ph, gameClock.now())
    if (ph !== lastPhase) {
      stats.phases.push(`${PHASE_RU[ph] ?? ph}${hp != null ? ` (${Math.round(hp)})` : ''}`)
      dbg('phase', PHASE_RU[ph], 'hp', hp)
      if (ph === PHASE.SCANNING && lastPhase === PHASE.LANDING) stats.perchCount++
      lastPhase = ph
    }
    if (hp != null && (!hpLog.length || hpLog[hpLog.length - 1] !== Math.round(hp))) hpLog.push(Math.round(hp))
    // в той фазе, где сидел (EnderDragon.hurt: DYING только если !isSitting),
    if (hp != null && hp <= 0) { won = true; break }
    if (ph === PHASE.DYING) { lastPhase = PHASE.DYING; await sleep(200); continue }
    // Проверка приёма (сцена): столько посадок — и хватит (когда посадка кончилась).
    if (perches && stats.perchCount >= perches && !SITTING.has(ph) && ph !== PHASE.LANDING && ph !== PHASE.TAKEOFF) { rep.dragon.stoppedAfterPerches = perches; break }

    const parts = partsOf(bot, d, track)
    const z: any = dragonZones(bot)
    const ctx: any = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot), parts: z.parts ? parts : null, breath: null, prefer: null, sweep: z.sweep, wings: z.wings, wingKind: z.wingKind, wingAway: z.wingAway, wingAxis: z.wingAxis, landing: z.landing }
    // Облако огня предсказывать только на рёве: высматривая, дракон ещё
    if (ph === PHASE.ROARING) ctx.breath = breathOf(bot, d, parts)
    if (z.charge) ctx.charge = z.charge
    // Один цикл: снижается — кровать у места головы сидящего, щелчок в тик до посадки.
    if (ph === PHASE.LANDING && ocPrevPh !== PHASE.LANDING) ocLandStart = gameClock.now()
    ocPrevPh = ph
    // Станция у столба (ctl.pillarMode): строится, пока дракон далеко; на каждом снижении — цепочка кроватей.
    if (ctl.bedsOnly && ctl.pillarMode) {
      // 02.10 (rs6-s3, смерть): эндермен бил 10 раз за 9 с, пока бот снова и снова входил в чашу (pillar:enter): вход
      // отказывал «эндермен бьёт», а ветка станции стоит раньше отбоя (п. 2 ниже) — до него цикл не доходил. Сперва отбиться.
      const pest: any = hunters(bot, 4).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (pest && ph !== PHASE.LANDING) {
        if (ctl.trace) ctl.trace.ev('pestFirst', { ph, hp: r1(bot.health), at: [r1(pest.position.x), r1(pest.position.y), r1(pest.position.z)] })
        await fightEnderman(session, ctl, stats, pest, () => { const p2 = phaseOf(bot, dragonOf(bot)); return p2 === PHASE.LANDING })
        await sleep(50)
        continue
      }
      if (await earlyCrystalStep(session, ctl, stats, d, ph)) continue
      // R: кровати кончились, дракон снижается или сидит — меч из чаши (runnerSword, ND_RUN_SWORD=1), раз на посадку
      if (RUN_SWORD() && ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) &&
          (ph === PHASE.LANDING || SITTING.has(ph)) && hp != null && hp > 0 && bot.health >= 10) {
        const key = d.id + ':' + ocLandStart
        if (ctl.swordKey !== key) { ctl.swordKey = key; ctl.swordN = 0 }
        // выход по опасности прогноза («R: голова/шея/крыло») — снова, когда пройдёт (до 6 входов на посадку)
        if (ctl.swordN < 6 && ctl.swordDone !== key) {
          ctl.swordN++
          doing(ctl, 'pillar:sword')
          const f = await runnerSword(session, ctl, stats, track, feed, ctl.pillar.plan)
          if (ctl.trace) ctl.trace.ev('runnerSword', f)
          ;(rep.dragon.sword || (rep.dragon.sword = [])).push({ hits: f.hits, by: f.by, hp0: f.hp0, hpMin: f.hpMin, why: f.why })
          if (!/^R: /.test(f.why || '')) ctl.swordDone = key
          else await sleep(150)
          continue
        }
      }
      const far = ph === PHASE.HOLDING || ph === PHASE.STRAFE || ph === PHASE.CHARGING || (ph === PHASE.APPROACH && approachFar(d))
      const nearC = Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5) < 30
      // не чаще раза в 2.5 с (pil5-28: 6 попыток за 3 с у облака — и больше ни одной за бой)
      if ((!ctl.pillar || !ctl.pillar.built) && far && nearC && (ctl.pillarTries || 0) < pillarTriesMax() && gameClock.now() >= (ctl.pillarNext || 0) && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1) && !hunters(bot, 6).length && bot.health >= 12) {
        ctl.pillarTries = (ctl.pillarTries || 0) + 1
        ctl.pillarNext = gameClock.now() + 2500
        const P0 = podiumTop(bot)
        const tP = gameClock.now()
        // план — заново на каждую попытку (hb6: план «на весь бой» устаревал после частичной стройки и окопа —
        let pp = null; let rNo = null
        // 03.10 (rs18-s8, ca1-s8: «мало обсидиана» до конца боя): план R недостроен (часть обсидиана уже стоит) — продолжать его же:
        // новый расчёт с этими блоками в мире выбирал другой план (seen 0.84 → 0.76), а на его клетки обсидиана в рюкзаке не хватало.
        const partial = ctl.partialPlan
        if (partial && P0 === partial.P0 && runnerOn()) {
          const okObs = (partial.pp.cells || []).filter(c => /obsidian/.test(c[3])).every(c => { const b = bot.blockAt(new Vec3(c[0], c[1], c[2])); return b && (/obsidian/.test(b.name) || isAirish(b)) })
          if (okObs) pp = partial.pp; else ctl.partialPlan = null
        }
        if (!pp && P0 != null && runnerOn() && (ctl.runnerNull || 0) < 2) { pp = runnerPlan(bot, P0); if (!pp) { ctl.runnerNull = (ctl.runnerNull || 0) + 1; rNo = runnerPlan.why } }
        if (P0 != null && !pp && (envv('ND_RUNNER') !== '1' || (ctl.runnerNull || 0) >= 2)) pp = await pillarPlanAutoAsync(bot, P0, PILLAR_BAD ? (ctl.pillarBad || (ctl.pillarBad = new Map())) : null)
        if (ctl.trace) ctl.trace.ev('pillarPlan', pp ? { ms: gameClock.now() - tP, R: !!pp.runner, try: ctl.pillarTries, H: [pp.H.x, pp.yb, pp.H.z], F: [pp.F.x, pp.F.z], B: [pp.B.x, pp.feet.y, pp.B.z], dig: pp.dig, nObs: pp.nObs, seen: pp.seen, n: (pillarPlan.all || []).length, ...(rNo ? { rNo } : {}) } : { ms: gameClock.now() - tP, no: rNo || pillarPlan.why, P: P0 })
        if (pp) {
          doing(ctl, 'pillar:build')
          const rb = await pillarBuild(session, ctl, stats, pp)
          if (pp.runner && rb && !rb.ok) {
            const placedObs = (pp.cells || []).filter(c => /obsidian/.test(c[3]) && /obsidian/.test((bot.blockAt(new Vec3(c[0], c[1], c[2])) || {}).name || '')).length
            if (placedObs > 0) ctl.partialPlan = { pp, P0 }
          } else if (rb && rb.ok) ctl.partialPlan = null
          // ждали дракона (садится / не кружит) — не попытка: столбик для опоры над столбом ставится только пока кружит
          if (rb && !rb.ok && /дракон|опасно/.test(rb.why || '')) ctl.pillarTries--
          else if (PILLAR_BAD && rb && !rb.ok && !/эндермен|мало хп/.test(rb.why || '')) ctl.pillarBad.set(pillarKey(pp), (ctl.pillarBad.get(pillarKey(pp)) || 0) + 1)
        }
        continue
      }
      if (ctl.pillar && ctl.pillar.built && ph === PHASE.APPROACH) {
        doing(ctl, 'pillar:enter')
        await pillarEnter(session, ctl, ctl.pillar.plan)
        await sleep(50)
        continue
      }
      if (ctl.pillar && ctl.pillar.built && ph === PHASE.LANDING) {
        const key = d.id + ':' + ocLandStart
        if (key !== ctl.pillarKey) {
          ctl.pillarKey = key
          await pillarRun(session, ctl, stats, track, feed)
          continue
        }
      }
    }
    // Бюджет кроватей спидраннера (≤ 8, 01.10): все — в цепочку станции у столба на одном снижении. Сидящему (взлёт после
    const bedsN = countOf(bot, /_bed$/) + (stationBedPlaced(bot, ctl) ? 1 : 0)
    const finish = hp != null && hp <= 45 * Math.min(bedsN, 2) + 5
    const stationLater = !!ctl.pillarMode && (ctl.pillarTries || 0) < pillarTriesMax() && ((ctl.pillar && ctl.pillar.built) || runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1)
    const keepBeds = KEEP_ON && ctl.bedsOnly && stationLater && bedsN <= KEEP_N && !finish
    // st1-s23: «держаться в окопе» при сидящем копало окоп заново у его головы — смерть; не в окопе — тоже наружу
    const builtPl = ctl.pillar && ctl.pillar.built ? ctl.pillar.plan : null
    const holdPh = ph === PHASE.LANDING || ph === PHASE.TAKEOFF || SITTING.has(ph)
    const inTrench = keepBeds && holdPh && !!builtPl && (() => { const q = bot.entity.position; return (Math.floor(q.x) === builtPl.B.x && Math.floor(q.z) === builtPl.B.z && Math.abs(q.y - builtPl.feet.y) < 0.3) || !!pillarHere(bot, builtPl) })()
    const holdOut = keepBeds && holdPh && !inTrench
    if (ctl.bedsOnly && OC_ON && !keepBeds && ph === PHASE.LANDING && feed.fc && feed.fc.id === d.id) {
      const key = d.id + ':' + ocLandStart
      if (key !== ocLandKey && feed.fc.n >= 40 && feed.fc.n <= 190) {
        ocLandKey = key
        await ocLanding(session, ctl, rep, stats, track, feed)
        continue
      }
    }
    // Только кровати: сел — посадка целиком в bedsPerch (свои проверки облаков,
    // фаерболов и коробок дракона — по высоте точные: земля у фонтана под ними).
    if (keepBeds && SITTING.has(ph) && ctl.pillar && ctl.pillar.built) {
      const bad0 = dangerAt(bot, bot.entity.position, ctx)
      if (bad0) { await evade(bot, ctl, stats, { ...bad0, ctx }); continue }
      // R (02.10, rs3: после 4 кроватей дракону оставалось 1–24 хп в 7 из 11 проигрышей): кроватей нет, дракон сел — мечом
      // в голову, один заход на посадку (сидячий счёт до 50 удары не поднимают). ND_RUN_MELEE=1 — вкл., пока не замерено.
      const sitKey = d.id + ':' + ocLandStart
      if (RUN_MELEE() && builtPl && builtPl.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && hp != null && hp <= envNum('ND_RUN_MELEE_HP', 35) && bot.health >= 12 && ctl.meleeKey !== sitKey) {
        ctl.meleeKey = sitKey
        doing(ctl, 'pillar:melee')
        const f = await meleeFinish(session, ctl, stats, track, { blind: false })
        if (ctl.trace) ctl.trace.ev('runnerMelee', { ok: f.ok, why: f.why || null, hits: f.hits || 0, hp0: r1(hp) })
        continue
      }
      if (inTrench) {
        doing(ctl, 'pillar:hold')
        await lookAtSafe(bot, parts.bodyC)
        await sleep(150)
        continue
      }
    }
    if (ctl.bedsOnly && bedsN > 0 && SITTING.has(ph) && !keepBeds) {
      await bedsPerch(session, ctl, rep, stats, track)
      await sleep(60)
      continue
    }
    const me = bot.entity.position
    // 1. Опасность под ногами — отойти.
    const bad = dangerAt(bot, me, ctx)
    if (bad) { await evade(bot, ctl, stats, { ...bad, ctx }); continue }
    // 2. Злой эндермен (бил нас) — отбиться; посадку не бросать ради него,
    // если кровать у головы уже ждёт.
    const angry = hunters(bot, 3.5).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    const window = SITTING.has(ph) || ph === PHASE.LANDING || ph === PHASE.TAKEOFF
    if (angry && !(window && st && bedHere(bot, st))) {
      await fightEnderman(session, ctl, stats, angry, () => {
        const p2 = phaseOf(bot, dragonOf(bot))
        return !!st && (p2 === PHASE.LANDING || SITTING.has(p2)) && bedHere(bot, st)
      })
      await sleep(50)
      continue
    }
    // 3. Здоровье. Есть — 1.6 с: в окне посадки у готовой кровати не есть,
    // если хп терпит (станция держит облако огня выше нас).
    const busy = window && st && bedHere(bot, st)
    // Стоим на блоке над облаком (рефлекс или «на блок» подняли) — не сходить
    const perched = overCloud(bot)
    if (perched) stats.overCloud = (stats.overCloud || 0) + 1
    if (!perched && !window && onSpike(bot)) { await getDown(session, ctl, stats); continue }
    {
      const pil = onOwnPillar(bot)
      if (pil) {
        doing(ctl, 'pillar:down')
        if (ctl.trace) ctl.trace.ev('pillarDown', { n: pil.n, gy: pil.gy })
        await digDownTo(bot, ctl, pil.gy, pil.n + 2)
        continue
      }
    }
    if (bot.health <= 7 && !window && !perched) { await hideAndHeal(session, ctl, rep, stats, { until: 16 }); continue }
    if (bot.health <= 14 && !window && !perched) await clearOfClouds(session, ctl, stats)
    if ((bot.health <= 14 || bot.food < 16) && !(busy && bot.health > 8)) await heal(session, ctl, rep, stats, { hard: bot.health <= 14 })
    // 4. Кровати. Пока летает — заранее построенная станция у фонтана (не
    if (!window) dyn = null
    // Блоков на станцию (10) и заслоны нет — наломать эндерняка, пока летает.
    const lowBlocks = countOf(bot, FILLER_RE) < (ctl.beds && countOf(bot, /_bed$/) > 0 ? 14 : 6)
    if (!bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket') && findItem(bot, /^water_bucket$/)) await waterToHotbar(bot)
    if (!window && !perched && gameClock.now() >= refillAt && !findItem(bot, /^water_bucket$/) && findItem(bot, /^bucket$/)) {
      refillAt = gameClock.now() + 20000
      await refillBucket(session, ctl, stats)
      continue
    }
    if (lowBlocks && !window && !perched && gameClock.now() >= mineRetry && findItem(bot, /_pickaxe$/)) {
      const got = await mineEndStone(session, ctl, 20, stats)
      if (got < 4) mineRetry = gameClock.now() + 30000
      continue
    }
    const bedsSpent = countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl)
    const finishBow = !!findItem(bot, /^bow$/) && countOf(bot, /arrow$/) > 0
    // После кроватей использовать оставшиеся стрелы, даже если кристалл уже успел вылечить дракона.
    if (ctl.bedsOnly && finishBow && (bedsSpent || (hp != null && hp <= 20)) && !SITTING.has(ph) && ph !== PHASE.LANDING && !perched && gameClock.now() - lastShot > 900) {
      lastShot = gameClock.now()
      // (02.10 вечер, rs12-s8/s15/s18: сюда передавали false — bow.shoot звал hazardSoon() и вызов «сорвался» при драконе 0.2–12 хп
      // сразу после взлёта с меча; добивания из лука в полёте не было ни разу)
      if (await rangedShot(session, ctl, stats, track, d, () => !!hazardNow(bot))) { stats.finishArrows = (stats.finishArrows || 0) + 1; continue }
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
        break
      }
      if (swordMore && SITTING.has(ph) && !(ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner)) {
        await perchAttack(session, ctl, rep, stats, track); await sleep(50); continue
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
        if (await crystalWait(session, ctl, stats, d, ph)) continue
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
        continue
      }
      if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
      doing(ctl, window ? 'beds:landing' : 'beds:wait')
      await lookAtSafe(bot, parts.bodyC)
      await sleep(100)
      continue
    }
    if (ctl.beds && countOf(bot, /_bed$/) > 0 && countOf(bot, FILLER_RE) > 0) {
      if (!st && !window && gameClock.now() >= stationRetry) {
        st = chooseStation(bot, stFails)
        if (!st) {
          stats.stationNone = chooseStation.why
          stationRetry = gameClock.now() + 5000
        } else {
          stats.stations = (stats.stations || 0) + 1
          if (ctl.trace) ctl.trace.ev('station', { key: st.key, B: [st.B.x, st.B.y, st.B.z], yb: st.yb, g: st.g, place: st.place.length })
        }
      }
      // 25 тиков без рёва (Sensing у дракона не очищается — EnderDragon.aiStep
      const blind = ph === PHASE.SCANNING && blindKnown(sitRec)
      let use = window ? dyn : st
      // Поправка по замеру (e2e10, 2026-09-26): к игроку на B (11 блоков от
      const settled = ph === PHASE.ROARING || ph === PHASE.FLAMING || blind
      if (window && !use && st) {
        const near = headPoint(bot, d, track, 0).distanceTo(st.blast) <= 4.5
        if (near || ph === PHASE.LANDING || ph === PHASE.TAKEOFF || (SITTING.has(ph) && !settled)) use = st
      }
      // Без станции у головы — perchAttack (видящему — кровать или меч; слепому —
      if (window && !use && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); continue }
      if (use) {
        const r = await stationStep(session, ctl, rep, stats, track, use, d, ph)
        if (r === 'далеко') {
          // Голова ушла от станции (довернулся) — собрать заново под ней.
          stats.stationFar = (stats.stationFar || 0) + 1
          if (use === dyn) dyn = null
          else if (SITTING.has(ph)) dyn = null
          continue
        }
        if (r === 'fail') {
          if (use === st) {
            stFails.set(st.key, (stFails.get(st.key) || 0) + 1)
            if (ctl.trace) ctl.trace.ev('stationFail', { key: st.key })
            st = null
          } else dyn = null
          continue
        }
        // Станция под облаком — обычный бой (лук, уход от угроз) поодаль.
        if (r !== 'готово' && r !== 'облако') continue
      }
    }
    const stationed = !!st && ctl.beds && countOf(bot, /_bed$/) > 0
    // 5. Без станции: сидит — к голове с мечом (только видящий, см. perchAttack).
    if (!stationed && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); continue }
    // Кристалл на обелиске ещё жив (не сбили в начале) — снова за ним, пока
    // дракон летает: иначе он лечит дракона на 2 хп/с (d5-17, d5-22).
    if (!window && !perched && gameClock.now() >= crystalRetry && crystalsOf(bot).some(c => c.pillar)) {
      crystalRetry = gameClock.now() + 60000
      stats.crystalRetry = (stats.crystalRetry || 0) + 1
      if (ctl.trace) ctl.trace.ev('crystalRetry', { left: crystalsOf(bot).filter(c => c.pillar).length })
      await destroyCrystals(session, ctl, rep, stats, { deadline: Math.min(deadline, gameClock.now() + 150000) })
      continue
    }
    // 6. Летает: без станции — держаться у портала в 10–16 блоках.
    const fromC = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
    // Садится, сидит, взлетает — не возвращаться к фонтану (там его крылья и
    // коридор взлёта): отошли от них — там и стоять до конца посадки.
    if (!stationed && !window && !perched && (fromC > 18 || fromC < 7 || nearEdge(bot, me, 2))) {
      const spot = pickSpot(bot, CENTER, { rMin: 9, rMax: 14, avoid: f => nearPillar(bot, f, 2) })
      doing(ctl, 'fight:reposition')
      if (spot) {
        if (spot.feet.distanceTo(me) > 8) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000 })
        else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.5 })
      } else await sleep(200)
      continue
    }
    const hazardSoon = () => !!hazardNow(bot)
    // 7. Стрелы по летящему (сидящему — без толку: onHurt → 0).
    if (!window && gameClock.now() - lastShot > 300 && countOf(bot, /arrow$/) > 0) {
      const dist = d.position.distanceTo(me)
      const good = dist < 44 && (ph === PHASE.STRAFE || ph === PHASE.CHARGING || ph === PHASE.APPROACH || dist < 30)
      if (good && !hazardSoon()) {
        doing(ctl, 'fight:shoot')
        await rangedShot(session, ctl, stats, track, d, hazardSoon)
        lastShot = gameClock.now()
        continue
      }
    }
    // Пока ждём — смотреть на дракона (но не в глаза эндерменам) и есть.
    if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
    await lookAtSafe(bot, parts.bodyC)
    await sleep(100)
  }
  rep.dragon.hpLog = hpLog.slice(-40)
  rep.dragon.won = won
  if (!won && !active() && !rep.dragon.lost) rep.dragon.lost = 'бой прерван: тело сменилось, погибло или вышло из Края'
  if (won && ctl.started) rep.timing.killed = Math.round((gameClock.now() - ctl.started) / 1000)
  if (stats.perchCount) rep.dragon.perchCount = stats.perchCount
  if (stats.bedPerches && stats.bedPerches.length) rep.dragon.bedPerches = stats.bedPerches.slice(-12).map(({ key, ...p }: any) => p)
  {
    const dd0 = dragonOf(bot)
    const tr = dd0 && takeoffSeen.get(dd0.id)
    if (tr && tr.az.length) rep.dragon.takeoffAz = tr.az.map(a => Math.round(a * 180 / Math.PI))
  }
  if (stats.stations) rep.dragon.station = { built: stats.stations, blocks: stats.stationBlocks || 0, none: stats.stationNone }
  const dd = dragonOf(bot)
  rep.dragon.hpNow = won ? 0 : (dd ? Math.round(hpOf(bot, dd) ?? 0) : null)
}

export {
  stationBuild, stationStep, fightDragon
}
