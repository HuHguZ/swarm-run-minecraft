'use strict'
// Бой с драконом (dragon/pillar-run.ts): насест: кровать в голову, уход спереди, подход к насесту, удар по голове.
// perchAttack — оркестр насеста: состояние — объект pa (PerchAttack), фазы до удара и шаги цикла удара — ниже.
import { gameClock, Vec3, overlap, playerBox, inflate, findItem, FILLER_RE, cloudsOf, DEBUG, dbg, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, partsOf, clearControls, PHASE_RU, hpOf, fireballsOf, pvp, BREATH_R, boxDist, PART, cloudHits, HEAD_AHEAD, BREATH_AHEAD, zonesOf } from '../dig-down-to'
import { hunters, doing, inClouds, pickSpot, nearPillar, r1, podiumTop, HOLE_TOP, duckPlan, duck, breathOf, standY, hasEffect, sight, takeoffBoxes, STAY_R, awayFromHead, hitBy, straightWalkable, usePotion } from '../fall-guard'
import { dangerAt, countOf, evade, noteNear, sneakPlace, lookAtSafe, segPoint2, SCAN_RANGE, bedPlan, takeoffSidestep } from '../evade-raw'
import { meleeSpot } from '../pillar-plan'
import { sitRec, sightKey, sitState, blindKnown, takeoffOnHit, hazardNow } from './sight-zones'
import { walkTo, heal } from './walk'


async function bedBlast (session, ctl, rep, stats, track) {
  const bot = session.bot
  const d0 = dragonOf(bot)
  if (!d0) return null
  const sitting = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  const blast: any = { at: Math.round(hpOf(bot, d0) ?? 0), beds: 0, dmg: 0, dist: [] }
  // Дракон ударил, пока шли к месту кровати (голова довернулась) — бросить:
  // d8-22 (30.09, 269–270 с) — два удара по 6 на пути к кровати, смерть позже.
  const tBed = gameClock.now()
  const struck = () => (hitBy.get(d0.id) || 0) > tBed
  // Взрыв кровати поджигает (fire = true): огнестойкость, если есть.
  if (bot.entity.position.distanceTo(d0.position) > HEAD_AHEAD + 4) await usePotion(bot, stats, 'fire_resistance')
  // Каждая кровать — по новому плану: взрыв выбивает пол под изножьем и
  // заслон (прогон: вторая кровать на старое место — «ответа от сервера нет»).
  for (let n = 0; n < 4 && !ctl.aborted && sitting() && countOf(bot, /_bed$/) > 0; n++) {
    await yieldTick()
    const d = dragonOf(bot)
    const parts = partsOf(bot, d, track)
    // Смелый (идёт к месту кровати сквозь облако огня, 3 за удар) — только с
    // запасом: жать кровать можно с 16 хп и выше (см. ниже).
    const brave = bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 14)
    const plan = bedPlan(bot, d, parts, { brave })
    if (!plan) { if (!n) stats.bedNoSpot = (stats.bedNoSpot || 0) + 1; blast.why = blast.why || 'нет места под кровать'; break }
    if (!n) stats.beds.push(blast)
    blast.dist.push(+plan.dist.toFixed(1))
    doing(ctl, 'bed:walk')
    if (Math.hypot(bot.entity.position.x - plan.feet.x, bot.entity.position.z - plan.feet.z) > 0.5) {
      // Рядом и на одной высоте — клавишами (pathfinder с ценой облаков и зон
      // головы на 7 с не успевал: «не дошёл за 7с» три посадки подряд).
      const near = bot.entity.position.distanceTo(plan.feet) < 7 && Math.abs(bot.entity.position.y - plan.feet.y) < 1.2
      const s1 = near ? await stepTo(bot, ctl, plan.feet, { ms: 3000, sprint: false, stopAt: 0.3, stop: struck }) : { ok: false }
      if (struck()) { blast.why = 'ударил дракон'; const rs = sitRec && !sitRec.ended ? sitRec : null; if (rs) rs.hitBack = gameClock.now(); break }
      const w = s1.ok ? s1 : await walkTo(session, ctl, plan.feet, { range: 0, timeoutMs: 12000, hazards: brave ? 'noclouds' : true })
      if (struck()) { blast.why = 'ударил дракон'; const rs = sitRec && !sitRec.ended ? sitRec : null; if (rs) rs.hitBack = gameClock.now(); break }
      if (!w.ok && Math.hypot(bot.entity.position.x - plan.feet.x, bot.entity.position.z - plan.feet.z) > 0.9) { blast.why = `не дошёл до места: ${w.why}`; break }
      await stepTo(bot, ctl, plan.feet, { ms: 800, sprint: false, stopAt: 0.15 })
    }
    clearControls(bot)
    if (!sitting()) break
    const hz = hazardNow(bot, { parts: partsOf(bot, dragonOf(bot), track) })
    if (hz && !(brave && /облако/.test(hz.kind))) { blast.left = `опасность: ${hz.kind}`; break }
    const hAt = new Vec3(plan.H.x, plan.g, plan.H.z)
    const wAt = new Vec3(plan.W.x, plan.g, plan.W.z)
    // Кровать: изножье на F, изголовье — туда, куда смотрим (D).
    doing(ctl, 'bed:place')
    try {
      await bot.equip(findItem(bot, /_bed$/), 'hand')
      await build.withTimeout(bot.placeBlock(bot.blockAt(new Vec3(plan.F.x, plan.g - 1, plan.F.z)), new Vec3(0, 1, 0)), 2500)
    } catch (e) { dbg('bed place', e.message) }
    await sleep(100)
    const hb = bot.blockAt(hAt)
    if (!hb || !/_bed$/.test(hb.name)) { blast.why = `кровать не встала (${hb ? hb.name : '?'})`; break }
    // Заслон после кровати: с ним клик по полу под F уже не виден. Два блока
    for (const w of [wAt, wAt.offset(0, 1, 0)]) {
      if (isSolid(bot.blockAt(w))) continue
      const r = await sneakPlace(bot, w, { timeoutMs: 2500 })
      if (!r.ok) { blast.why = `заслон не встал: ${r.reason || r.why}`; break }
    }
    if (blast.why) break
    // Хп — с запасом на неудачный взрыв (~16 в открытую с трёх блоков).
    if (bot.health < 16 && !hasEffect(bot, 'absorption')) { blast.why = `мало хп (${Math.round(bot.health)}) для кровати`; break }
    // Щёлкать — только стоя на своём месте за заслоном: рефлекс «на блок» (облако
    {
      const pp = bot.entity.position
      if (Math.hypot(pp.x - plan.feet.x, pp.z - plan.feet.z) > 0.6 || Math.abs(pp.y - plan.feet.y) > 0.3) { blast.why = 'не за заслоном — не щёлкаю'; break }
    }
    // Щёлкнуть изголовье поверх заслона: в руке — не кровать (иначе клик
    // может уйти в установку второй), не крадучись.
    const w = items.bestWeapon(bot)
    if (w) await bot.equip(w, 'hand').catch(() => {})
    bot.setControlState('sneak', false)
    const before = hpOf(bot, dragonOf(bot))
    const myHp = bot.health
    doing(ctl, 'bed:click')
    if (ctl.trace) ctl.trace.ev('bed', { dragonHp: before, me: myHp, dist: +plan.dist.toFixed(1) })
    try { await bot.activateBlock(hb, new Vec3(0, 1, 0), new Vec3(0.5, 0.56, 0.5)) } catch (e) { dbg('bed use', e.message) }
    await sleep(300)
    const gone = !bot.blockAt(hAt) || !/_bed$/.test(bot.blockAt(hAt).name)
    if (!gone) { blast.why = 'щёлкнул — не взорвалась'; break }
    blast.beds++
    stats.bedsUsed = (stats.bedsUsed || 0) + 1
    const dd = dragonOf(bot)
    const after = dd ? hpOf(bot, dd) : 0
    if (before != null && after != null && after < before) { blast.dmg += before - after; stats.dmg += before - after; if (sitRec && !sitRec.ended) sitRec.dmg = (sitRec.dmg || 0) + before - after }
    blast.selfDmg = Math.round(((blast.selfDmg || 0) + Math.max(0, myHp - bot.health)) * 10) / 10
    dbg('bed', 'dragon', before, '->', after, 'me', myHp, '->', bot.health)
    // Взрыв перевалил сидячий урон за 50 — взлёт, а мы у головы: сразу вбок от оси.
    if (dd && phaseOf(bot, dd) === PHASE.TAKEOFF) { await takeoffSidestep(bot, ctl, dd, 'взлёт от кровати'); break }
    // Огонь под ногами — шаг назад, прочь от заслона.
    const fire = bot.blockAt(bot.entity.position.floored())
    if (fire && /fire/.test(fire.name)) await stepTo(bot, ctl, bot.entity.position.offset(-plan.D.x * 2, 0, -plan.D.z * 2), { ms: 900, stopAt: 0.4 })
    if (bot.health < 16) break
  }
  blast.dmg = Math.round(blast.dmg)
  return blast.beds || blast.why ? blast : null
}

async function leaveFront (session, ctl, stats, d, rec) {
  const bot = session.bot
  doing(ctl, 'perch:leave')
  const boxes = takeoffBoxes(d.position, d.yaw)
  const me0 = bot.entity.position
  const farOk = blindKnown(rec) || me0.distanceTo(d.position) <= STAY_R + 0.5
  if (!boxes.some(b => overlap(playerBox(me0), b)) && farOk) { doing(ctl, 'perch:away'); await lookAtSafe(bot, d.position.offset(0, 2, 0)); await sleep(150); return true }
  // Сперва — вбок от головы и шеи (awayFromHead), потом место на СВОЕЙ стороне
  const parts = partsOf(bot, d, null)
  if (Math.hypot(me0.x - parts.headC.x, me0.z - parts.headC.z) < 6.5) await stepTo(bot, ctl, awayFromHead(d, parts, me0, 3.5), { ms: 1100, stopAt: 0.4 })
  const dir = parts.dir
  const sideOf = f => Math.sign((f.x - d.position.x) * dir.z - (f.z - d.position.z) * dir.x) || 1
  const me = bot.entity.position
  const mySide = sideOf(me)
  const far = f => !blindKnown(rec) && f.distanceTo(d.position) > STAY_R
  // Путь к месту — не мимо головы: c2-4 (30.09, 227–231 с) — от морды к месту
  const hd0 = Math.hypot(me.x - parts.headC.x, me.z - parts.headC.z)
  const byHead = f => segPoint2(me, f, parts.headC) < Math.min(5.5, hd0 - 0.3)
  const spot = pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: blindKnown(rec) ? 20 : 15, prefer: me, avoid: f => sideOf(f) !== mySide || boxes.some(b => overlap(playerBox(f), inflate(b, 1))) || nearPillar(bot, f, 2) || far(f) || byHead(f) }) ||
    pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: blindKnown(rec) ? 20 : 15, prefer: me, avoid: f => boxes.some(b => overlap(playerBox(f), inflate(b, 1))) || nearPillar(bot, f, 2) || far(f) || byHead(f) })
  stats.leftFront = (stats.leftFront || 0) + 1
  if (ctl.trace) ctl.trace.ev('leaveFront', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, flames: rec.flames, dmg: Math.round(rec.dmg || 0) })
  if (!spot) { await sleep(150); return false }
  const w = await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 8000 })
  return w.ok
}

function perchFar (bot) {
  const dd = dragonOf(bot)
  if (!dd) return null
  const ph = phaseOf(bot, dd)
  if (!(SITTING.has(ph) || ph === PHASE.LANDING)) return null
  if (sight.get(sightKey(dd.id)) === 'blind' || (SITTING.has(ph) && blindKnown(sitRec))) return null
  return Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > STAY_R + 0.5 ? 'садится/сел — дальше круга, будет таран' : null
}

async function perchApproach (session, ctl, stats) {
  const bot = session.bot
  const dd = dragonOf(bot)
  if (!dd) return false
  const ph = phaseOf(bot, dd)
  if (ph !== PHASE.SCANNING) return false
  { const rc = sitState(dd, ph, gameClock.now()); if (rc) noteNear(rc, dd, bot, gameClock.now()) }
  if (!perchFar(bot)) return false
  {
    const P = podiumTop(bot)
    const Y = ph === PHASE.SCANNING || SITTING.has(ph) ? dd.position.y : (P != null ? P + 0.5 : dd.position.y)
    const F = Math.floor(Y - 0.6 - HOLE_TOP - 0.15)
    const plan = duckPlan(bot, F)
    if (plan) {
      doing(ctl, 'perch:duck')
      if (plan.dig === 0) { await sleep(250); return true }
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: 'посадка у клеток', F, dig: plan.dig })
      await duck(bot, ctl, F)
      return true
    }
  }
  if (ph === PHASE.SCANNING) { await keepInScan(session, ctl, stats, dd, partsOf(bot, dd, null)); return true }
  if (ph !== PHASE.LANDING) return false
  doing(ctl, 'perch:close')
  const spot = pickSpot(bot, CENTER, { rMin: 15, rMax: 16.5, prefer: bot.entity.position, avoid: f => nearPillar(bot, f, 2) })
  if (ctl.trace) ctl.trace.ev('keepInScan', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, landing: true })
  if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 8000 })
  else await sleep(200)
  return true
}

async function keepInScan (session, ctl, stats, d, parts) {
  const bot = session.bot
  doing(ctl, 'perch:close')
  // Дальше ~27 — за 100 тиков в круг 20 не успеть (v1, 30.09: «ближе» с 36–40
  if (bot.entity.position.distanceTo(d.position) > 27) {
    const F = Math.floor(d.position.y - 0.6 - HOLE_TOP - 0.15)
    const plan = duckPlan(bot, F)
    if (plan) {
      if (plan.dig === 0) { await sleep(200); return true }
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: 'далеко от сидящего', F, dig: plan.dig })
      return await duck(bot, ctl, F)
    }
  }
  const boxes = takeoffBoxes(d.position, d.yaw)
  const me = bot.entity.position
  const dir = parts.dir
  const sideOf = f => Math.sign((f.x - d.position.x) * dir.z - (f.z - d.position.z) * dir.x) || 1
  const mySide = sideOf(me)
  const hd0 = Math.hypot(me.x - parts.headC.x, me.z - parts.headC.z)
  const ok = f => !boxes.some(b => overlap(playerBox(f), inflate(b, 1))) && !nearPillar(bot, f, 2) && f.distanceTo(d.position) <= STAY_R && Math.abs(f.y - d.position.y) <= 8 && segPoint2(me, f, parts.headC) >= Math.min(5.5, hd0 - 0.3)
  const spot = pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: 15, prefer: me, avoid: f => !ok(f) || sideOf(f) !== mySide }) ||
    pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: 15, prefer: me, avoid: f => !ok(f) })
  stats.keptInScan = (stats.keptInScan || 0) + 1
  if (ctl.trace) ctl.trace.ev('keepInScan', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, dist: r1(me.distanceTo(d.position)) })
  if (!spot) {
    // Места нет, а мы и так в круге (с запасом) — стоять; нет — к центру фонтана
    // обычным путём (дальше 20 — таран).
    if (me.distanceTo(d.position) <= SCAN_RANGE - 2) { await sleep(250); return true }
    await sleep(150)
    return false
  }
  const w = await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 6000 })
  return w.ok
}

type Turn = 'next' | 'stop' | undefined

// Насест — состояние захода (прежние let и стрелки замыкания perchAttack).
interface PerchAttack {
  session: any
  ctl: any
  rep: any
  stats: any
  track: any
  bot: any
  d: any
  parts: any
  rec: any
  spot: any
  through: boolean
  perch: any
  hz: any
  me: any
  standing: () => boolean
  nearHead: () => boolean
  blindNow: () => boolean
  weapon: any
  nextReady: number
  lastSwing: number
  lastHp: number
  t0: number
}

// Значения одного оборота цикла удара (прежние const тела while, нужные нескольким шагам).
interface PerchTick {
  ph?: any
  rc?: any
  feet?: any
  reach?: number
}

// Насест (perchAttack): фазы до удара — что делает сидящий, хп и кровати, место у головы, подход, подставка.
// Фаза возвращает 'stop' (прежний return из perchAttack) или ничего (дальше по фазам).
async function perchSeen (pa: PerchAttack): Promise<Turn> {
  const { bot, ctl, session, stats, track } = pa
  doing(ctl, 'perch')
  pa.d = dragonOf(bot)
  if (!pa.d) return 'stop'
  pa.parts = partsOf(bot, pa.d, track)
  // Посадка (2026-09-30). Видящий (ревёт на 25-м тике) сидит до четырёх огней
  pa.rec = sitState(pa.d, phaseOf(bot, pa.d), gameClock.now())
  // Дракон бил нас в эту посадку (где угодно: у кровати, на подходе) — к голове
  // больше не лезть.
  const hitAt0 = hitBy.get(pa.d.id)
  if (pa.rec && hitAt0 && hitAt0 > pa.rec.t0 && !pa.rec.hitBack) pa.rec.hitBack = hitAt0
  // Подставки не было, а видящий ревёт или дышит — к голове не идти до «высматривает».
  if (pa.rec && pa.rec.noPedestal && pa.rec.roared && (phaseOf(bot, pa.d) === PHASE.ROARING || phaseOf(bot, pa.d) === PHASE.FLAMING) && countOf(bot, FILLER_RE) < 1) {
    doing(ctl, 'perch:wait-flame')
    const bad = hazardNow(bot)
    if (bad) await evade(bot, ctl, stats, bad)
    else { await lookAtSafe(bot, pa.parts.headC); await sleep(150) }
    return 'stop'
  }
  // Видящий высматривает (25 тиков каждого круга) — голова поворачивается к нам
  if (pa.rec) noteNear(pa.rec, pa.d, bot, gameClock.now())
  // Видящий (или пока не ясно) высматривает, а мы дальше STAY_R — ближе, в
  // сторону от морды: иначе через 100 тиков таран (см. SCAN_RANGE).
  if (pa.rec && phaseOf(bot, pa.d) === PHASE.SCANNING && !blindKnown(pa.rec) && bot.entity.position.distanceTo(pa.d.position) > STAY_R + 0.5) {
    await keepInScan(session, ctl, stats, pa.d, pa.parts)
    return 'stop'
  }
  {
    const phNow = phaseOf(bot, pa.d)
    if (pa.rec && phNow === PHASE.SCANNING && (pa.rec.roared || !blindKnown(pa.rec))) {
      doing(ctl, 'perch:scan')
      const bad = hazardNow(bot, { parts: pa.parts })
      if (bad) await evade(bot, ctl, stats, bad)
      else {
        const rx = bot.entity.position.x - pa.d.position.x; const rz = bot.entity.position.z - pa.d.position.z
        const inPit = bot.entity.position.y <= pa.d.position.y - HOLE_TOP + 0.05
        if (Math.hypot(rx, rz) < HEAD_AHEAD + 3.5 && !inPit) await stepTo(bot, ctl, awayFromHead(pa.d, pa.parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 })
        else { await lookAtSafe(bot, pa.parts.headC); await sleep(100) }
      }
      return 'stop'
    }
  }
  // Нырнули до взлёта слепого — сидеть в яме до конца посадки.
  if (pa.rec && pa.rec.ducked) { doing(ctl, 'perch:ducked'); await lookAtSafe(bot, pa.parts.headC); await sleep(150); return 'stop' }
  if (pa.rec && (pa.rec.flames >= 4 || (pa.rec.dmg || 0) >= 44 || pa.rec.hitBack)) {
    await leaveFront(session, ctl, stats, pa.d, pa.rec)
    return 'stop'
  }
}

async function perchHealBeds (pa: PerchAttack): Promise<Turn> {
  const { bot, ctl, session, rep, stats, track } = pa
  // С малым хп к голове не идти: сидячий огонь — 3 магией в секунду сквозь
  if (bot.health < 16 && findItem(bot, /golden_apple$/) && !hasEffect(bot, 'absorption') &&
      bot.entity.position.distanceTo(pa.d.position) > HEAD_AHEAD + 3) {
    await heal(session, ctl, rep, stats, { hard: true })
  }
  if (bot.health < 12) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 10) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return 'stop' }
  }
  // Удар может поднять его на взлёт (накопленный сидячий урон у 50), а у головы
  // мы в коридоре взлёта: голова и крылья — до 11 хп. Только с запасом хп.
  if (takeoffOnHit() && bot.health < 16) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 16) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return 'stop' }
  }
  // Кровати с собой — сперва они (урон сразу, у головы не стоять). Не вышло
  // трижды подряд без единого взрыва — дальше только меч.
  const ph0 = phaseOf(bot, pa.d)
  // Слепому (посадка 5 с) — не кровать: поставить её, заслон и щёлкнуть к взлёту не
  // успеть, а стоим с ней по оси морды — в коридоре взлёта. Меч быстрее.
  if (ctl.beds && !blindKnown(pa.rec) && countOf(bot, /_bed$/) > 0 && bot.health >= 12 && !((stats.bedTried || 0) >= 3 && !stats.bedsUsed)) {
    const soonFlame = ph0 === PHASE.ROARING ? breathOf(bot, pa.d, pa.parts) : null
    const plan = bedPlan(bot, pa.d, pa.parts, { brave: bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 14) })
    if (!plan) { stats.bedNoPlan = stats.bedNoPlan || {}; for (const [k, v] of (Object.entries(bedPlan.why || {}) as [string, any][])) stats.bedNoPlan[k] = (stats.bedNoPlan[k] || 0) + v; if (DEBUG && gameClock.now() - (stats.bedPlanLog || 0) > 2000) { stats.bedPlanLog = gameClock.now(); dbg('bed plan', PHASE_RU[ph0], JSON.stringify(bedPlan.why)) } }
    if (plan && !(soonFlame && cloudHits(soonFlame, plan.feet, 0.8))) {
      stats.bedTried = (stats.bedTried || 0) + 1
      const b = await bedBlast(session, ctl, rep, stats, track)
      if (b && b.beds) return 'stop'
    }
  }
}

async function perchSpot (pa: PerchAttack): Promise<Turn> {
  const { bot, ctl, stats } = pa
  pa.spot = meleeSpot(bot, pa.d, pa.parts, { blind: blindKnown(pa.rec) })
  if (!pa.spot) { stats.noSpot++; return 'stop' }
  // Облака фаерболов у фонтана (живут 30 с, растут до 7) — к голове сквозь
  {
    const fb = cloudsOf(bot).filter(c => c.r < BREATH_R - 0.3 || c.pos.distanceTo(pa.parts.headC) > BREATH_AHEAD + 3)
    const me1 = bot.entity.position
    if (inClouds(fb, pa.spot.ground, 1) || !straightWalkable(bot, me1, pa.spot.ground, zonesOf(fb))) {
      stats.perchCloudy = (stats.perchCloudy || 0) + 1
      doing(ctl, 'perch:cloudy')
      const bad = hazardNow(bot)
      if (bad) await evade(bot, ctl, stats, bad)
      else await sleep(200)
      return 'stop'
    }
  }
  // Огонь уже лежит — к голове идти сквозь него (подставка ставится на месте,
  const onSpot = Math.hypot(bot.entity.position.x - pa.spot.ground.x, bot.entity.position.z - pa.spot.ground.z) < 0.8 && bot.entity.position.y >= pa.spot.feet.y - 0.01
  const flame = cloudsOf(bot).find(c => c.pos.distanceTo(pa.parts.headC) < BREATH_AHEAD + 3 && c.r >= BREATH_R - 0.5)
  pa.through = false
  if (flame && !onSpot && Math.hypot(pa.spot.ground.x - flame.pos.x, pa.spot.ground.z - flame.pos.z) < flame.r + 1) {
    // Облако огня живёт 10 с, а огонь повторяется каждые ~13 с: ждать его
    const brave = (bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 16)) && !(ctl.beds && countOf(bot, /_bed$/) > 0) &&
      bot.entity.position.distanceTo(pa.spot.ground) < 9 && countOf(bot, FILLER_RE) >= pa.spot.lift
    if (!brave) {
      stats.waitedFlame = (stats.waitedFlame || 0) + 1
      await sleep(300)
      return 'stop'
    }
    pa.through = true
  }
  pa.perch = { at: Math.round(hpOf(bot, pa.d)), hits: 0, dmg: 0, head: 0, body: 0 }
  doing(ctl, 'perch:approach')
  if (pa.through) pa.perch.throughFlame = true
  stats.perches.push(pa.perch)
  pa.hz = pa.through ? 'noclouds' : true
}

async function perchWalk (pa: PerchAttack): Promise<Turn> {
  const { bot, ctl, session, track } = pa
  // Подойти к клетке у головы: по прямой, если близко и путь ровный, иначе
  // pathfinder (между ботом и головой часто чаша портала и столб).
  pa.me = bot.entity.position
  pa.standing = () => SITTING.has(phaseOf(bot, dragonOf(bot))) || phaseOf(bot, dragonOf(bot)) === PHASE.LANDING
  // Шаг к подставке — не в голову и не в шею: пока идём, дракон доворачивает
  pa.nearHead = () => {
    const dd = dragonOf(bot)
    if (!dd) return false
    const pp = partsOf(bot, dd, track)
    const pb = playerBox(bot.entity.position)
    return overlap(pb, inflate(pp.head, 1.4)) || overlap(pb, inflate(pp.neck, 1.4))
  }
  // Сбоку к голове не подходить — её дуга (см. dangerAt, sweep): сначала выйти
  // на ось морды подальше, потом шагнуть к ней спереди.
  {
    const rx = pa.me.x - pa.d.position.x; const rz = pa.me.z - pa.d.position.z
    const h = Math.hypot(rx, rz)
    const ang = h > 0.1 ? Math.acos(Math.max(-1, Math.min(1, (rx * pa.parts.dir.x + rz * pa.parts.dir.z) / h))) : Math.PI
    // Слепому голову не поворачивать — к месту сбоку напрямую.
    if (!blindKnown(pa.rec) && (ang > 0.45 || h < HEAD_AHEAD)) {
      const front = pa.d.position.offset(pa.parts.dir.x * (HEAD_AHEAD + 5), 0, pa.parts.dir.z * (HEAD_AHEAD + 5))
      const fy = standY(bot, front.x, front.z, pa.spot.ground.y, 4, 6)
      if (fy != null) {
        pa.perch.viaFront = true
        await walkTo(session, ctl, new Vec3(front.x, fy, front.z), { range: 1.5, timeoutMs: 8000, hazards: pa.hz })
        pa.me = bot.entity.position
      }
    }
  }
  if (Math.hypot(pa.me.x - pa.spot.ground.x, pa.me.z - pa.spot.ground.z) > 0.6) {
    let r: any = pa.me.distanceTo(pa.spot.ground) < 5 ? await stepTo(bot, ctl, pa.spot.ground, { ms: 2000, stopAt: 0.25, sprint: false, clouds: !pa.through, stop: () => !pa.standing() || pa.nearHead() || (!pa.through && !!inClouds(cloudsOf(bot), bot.entity.position, 0.3)) }) : { ok: false }
    if (pa.nearHead()) { pa.perch.why = 'шея довернулась к нам'; await stepTo(bot, ctl, awayFromHead(pa.d, pa.parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); return 'stop' }
    if (!r.ok && pa.standing()) r = await walkTo(session, ctl, pa.spot.ground, { range: 0, timeoutMs: 9000, hazards: pa.hz })
    if (!r.ok && Math.hypot(bot.entity.position.x - pa.spot.ground.x, bot.entity.position.z - pa.spot.ground.z) > 0.8) { pa.perch.why = r.why; return 'stop' }
    await stepTo(bot, ctl, pa.spot.ground, { ms: 800, sprint: false, stopAt: 0.12, stop: pa.nearHead, clouds: !pa.through })
  }
}

async function perchMount (pa: PerchAttack): Promise<void> {
  const { bot, ctl } = pa
  pa.perch.reached = true
  doing(ctl, 'perch:melee')
  // Блок (или два) под себя — стоять над облаком огня.
  pa.blindNow = () => blindKnown(pa.rec)
  for (let tries = 0; tries < 2 && !pa.blindNow() && countOf(bot, FILLER_RE) >= pa.spot.lift && Math.floor(bot.entity.position.y + 0.01) < pa.spot.feet.y; tries++) {
    const t = await build.towerUp(bot, ctl, Math.max(1, pa.spot.feet.y - Math.floor(bot.entity.position.y + 0.01)))
    pa.perch.pedestal = (pa.perch.pedestal || 0) + t.placed
  }
  // Подставка не встала: пока дракон дышит, облако ляжет прямо под ноги — стоять
  // рядом с головой можно только до огня.
  pa.perch.low = Math.floor(bot.entity.position.y + 0.01) < pa.spot.feet.y
  pa.weapon = items.bestWeapon(bot)
  if (pa.weapon) await bot.equip(pa.weapon, 'hand').catch(() => {})
  pa.nextReady = gameClock.now() + 100
  pa.lastSwing = 0
  pa.lastHp = hpOf(bot, pa.d)
  pa.t0 = gameClock.now()
}

// Насест: шаги оборота цикла удара по голове (прежнее тело while): 'next' — прежний continue, 'stop' — break.
async function perchHitTrack (pa: PerchAttack, tk: PerchTick): Promise<Turn> {
  const { bot, ctl, track } = pa
  await yieldTick()
  pa.d = track.tick()
  if (!pa.d) return 'stop'
  tk.ph = phaseOf(bot, pa.d)
  if (!SITTING.has(tk.ph)) {
    // Взлёт от нашего удара (сидячий урон перевалил за 50 — он копится на все
    if (tk.ph === PHASE.TAKEOFF) { pa.perch.left = 'взлёт — вбок'; await takeoffSidestep(bot, ctl, pa.d, 'взлёт от удара') }
    return 'stop'
  }
  tk.rc = sitState(pa.d, tk.ph, gameClock.now())
  // Подставки нет (кончились блоки), а видящий ревёт или дышит — облако огня
  if (pa.perch.low && !pa.blindNow() && (tk.ph === PHASE.ROARING || tk.ph === PHASE.FLAMING)) { pa.perch.left = 'огонь, подставки нет'; if (tk.rc) tk.rc.noPedestal = gameClock.now(); return 'stop' }
  // Видящий снова высматривает — голова пойдёт по дуге: отойти до рёва.
  if (tk.ph === PHASE.SCANNING && tk.rc && tk.rc.roared) { pa.perch.left = 'высматривает — отойти'; await stepTo(bot, ctl, awayFromHead(pa.d, pa.parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); return 'stop' }
  // Четвёртый огонь или ≥ 44 за посадку — уходить от морды до взлёта.
  if (tk.rc && (tk.rc.flames >= 4 || (tk.rc.dmg || 0) >= 44)) { pa.perch.left = tk.rc.flames >= 4 ? 'четвёртый огонь' : 'снято 44'; return 'stop' }
  // Слепой взлетит на ~4.6 с — к 3.4 с нырнуть (или уйти, если не копается).
  if (tk.rc && !tk.rc.roared && gameClock.now() - tk.rc.t0 > 3400) {
    clearControls(bot)
    const F = Math.floor(pa.d.position.y - HOLE_TOP - 0.15)
    pa.perch.ducked = duckPlan(bot, F) ? await duck(bot, ctl, F) : false
    if (pa.perch.ducked) tk.rc.ducked = true
    else tk.rc.hitBack = gameClock.now()
    pa.perch.left = pa.perch.ducked ? 'нырнул до взлёта' : 'взлёт скоро, нырнуть нельзя'
    return 'stop'
  }
}

async function perchHitGuard (pa: PerchAttack, tk: PerchTick): Promise<Turn> {
  const { bot, ctl, track } = pa
  pa.parts = partsOf(bot, pa.d, track)
  tk.feet = bot.entity.position
  const eye = tk.feet.offset(0, EYE, 0)
  // Облако уже под ногами или голова наехала — сойти.
  const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 30), parts: pa.parts, breath: null }
  const bad = dangerAt(bot, tk.feet, ctx)
  if (bad) { pa.perch.left = bad.kind; return 'stop' }
  // Ударил сам дракон (голова, шея — наша оценка их коробок разошлась с
  const hitAt = hitBy.get(pa.d.id)
  if (hitAt && hitAt > pa.t0) {
    pa.perch.left = 'ударил дракон'
    if (tk.rc) tk.rc.hitBack = gameClock.now()
    clearControls(bot)
    await stepTo(bot, ctl, awayFromHead(pa.d, pa.parts, tk.feet, 4), { ms: 1200, stopAt: 0.4 })
    return 'stop'
  }
  tk.reach = boxDist(eye, pa.parts.head)
  // Дракон довернул голову — раздутые голова и шея уже рядом: отступить
  // сразу, по оси морды назад, и выбрать место заново.
  const pbNow = playerBox(tk.feet)
  if (overlap(pbNow, inflate(pa.parts.head, 1.2)) || overlap(pbNow, inflate(pa.parts.neck, 1.2))) {
    pa.perch.backed = (pa.perch.backed || 0) + 1
    clearControls(bot)
    const back = awayFromHead(pa.d, pa.parts, tk.feet, 3)
    await stepTo(bot, ctl, back, { ms: 900, stopAt: 0.4 })
    if (pa.perch.backed > 3) return 'stop'
    return 'next'
  }
}

async function perchHitMove (pa: PerchAttack, tk: PerchTick): Promise<Turn> {
  const { bot, ctl } = pa
  if (DEBUG && (!pa.perch.dbgAt || gameClock.now() - pa.perch.dbgAt > 1000)) {
    pa.perch.dbgAt = gameClock.now()
    dbg('perch', 'phase', PHASE_RU[tk.ph], 'head', pa.parts.headC.toString(), 'me', tk.feet.toString(), 'reach', tk.reach.toFixed(2), 'hp', hpOf(bot, pa.d), 'yaw', pa.d.yaw.toFixed(2))
  }
  if (tk.reach > 3.4) {
    // Дракон повернулся: переставиться.
    pa.perch.moved = (pa.perch.moved || 0) + 1
    if (pa.perch.moved > 3) return 'stop'
    const again = meleeSpot(bot, pa.d, pa.parts)
    if (!again) return 'stop'
    // Голова ушла далеко (довернулся) — не бегать за ней вокруг дракона сквозь
    if (Math.hypot(again.ground.x - tk.feet.x, again.ground.z - tk.feet.z) > 3 || inClouds(cloudsOf(bot), again.ground, 1)) { pa.perch.left = 'голова ушла далеко'; return 'stop' }
    clearControls(bot)
    await stepTo(bot, ctl, again.ground, { ms: 2500, stopAt: 0.2, stop: () => (hitBy.get(pa.d.id) || 0) > pa.t0 })
    if (countOf(bot, FILLER_RE) > 0) await build.towerUp(bot, ctl, 1)
    return 'next'
  }
}

async function perchHitPest (pa: PerchAttack): Promise<Turn> {
  const { bot } = pa
  // Злой эндермен вплотную посреди посадки: ударить его в перезарядку головы,
  // не сходя с места (его 7 урона за удар против окна посадки).
  const pest: any = hunters(bot, 3.2)[0]
  if (pest && gameClock.now() >= pa.nextReady) {
    await bot.lookAt(pest.position.offset(0, 1.5, 0), true).catch(() => {})
    bot.attack(pest)
    pa.perch.pests = (pa.perch.pests || 0) + 1
    pa.nextReady = gameClock.now() + pvp.cooldownMs(bot.heldItem)
    await sleep(50)
    return 'next'
  }
}

async function perchHitSwing (pa: PerchAttack, tk: PerchTick): Promise<Turn> {
  const { bot, stats } = pa
  await lookAtSafe(bot, pa.parts.headC)
  // Крита по дракону НЕТ: Player.canCriticalAttack требует, чтобы цель была
  // LivingEntity, а часть дракона — EnderDragonPart (сверено по байткоду;
  const now = gameClock.now()
  const hp = hpOf(bot, pa.d)
  if (hp != null && pa.lastHp != null && hp < pa.lastHp) {
    const lost = pa.lastHp - hp
    pa.perch.dmg += lost
    stats.dmg += lost
    if (sitRec && sitRec.id === pa.d.id && !sitRec.ended) sitRec.dmg = (sitRec.dmg || 0) + lost
    pa.lastHp = hp
  }
  if (now >= pa.nextReady - 350 && bot.entity.onGround) bot.setControlState('jump', true)
  else bot.setControlState('jump', false)
  const airborne = !bot.entity.onGround
  if (now >= pa.nextReady && (airborne || now >= pa.nextReady + 300)) {
    // Столб под ноги (переставились) берёт в руку булыжник — и удар
    const w = items.bestWeapon(bot)
    if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) {
      await bot.equip(w, 'hand').catch(() => {})
      pa.nextReady = gameClock.now() + pvp.cooldownMs(w)
      await sleep(50)
      return 'next'
    }
    if (tk.reach <= 3.0) {
      bot.attack({ id: pa.d.id + PART.head })
      pa.perch.hits++
      stats.melee++
      pa.nextReady = now + pvp.cooldownMs(bot.heldItem)
      // Урон головой или телом — по тому, на сколько упало здоровье.
      const before = hpOf(bot, pa.d)
      gameClock.setTimeout(() => {
        const dd = dragonOf(bot)
        const after = dd ? hpOf(bot, dd) : null
        if (before != null && after != null) {
          const lost = before - after
          if (lost >= 4) pa.perch.head++
          else if (lost > 0) pa.perch.body++
          if (DEBUG) dbg('hit', 'lost', lost.toFixed(2), 'air', airborne, 'reach', tk.reach.toFixed(2), 'held', bot.heldItem && bot.heldItem.name)
        }
      }, 250)
      pa.lastSwing = now
    }
  }
  await sleep(50)
}
// Порядок фаз до удара и шагов цикла удара — порядок прежнего тела perchAttack.
const PERCH_PHASES: ((pa: PerchAttack) => Promise<Turn | void>)[] = [perchSeen, perchHealBeds, perchSpot, perchWalk, perchMount]
const PERCH_STEPS: ((pa: PerchAttack, tk: PerchTick) => Promise<Turn>)[] = [perchHitTrack, perchHitGuard, perchHitMove, perchHitPest, perchHitSwing]

async function perchAttack (session, ctl, rep, stats, track) {
  const pa = { session, ctl, rep, stats, track, bot: session.bot } as PerchAttack
  const { bot } = pa
  for (const phase of PERCH_PHASES) if (await phase(pa) === 'stop') return
  turn: while (!ctl.aborted && gameClock.now() - pa.t0 < 30000) {
    const tk: PerchTick = {}
    for (const step of PERCH_STEPS) {
      const r = await step(pa, tk)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
  clearControls(bot)
  pa.perch.hpAfter = pa.d ? Math.round(hpOf(bot, pa.d) ?? 0) : 0
}

export {
  bedBlast, leaveFront, perchFar, perchApproach, keepInScan, perchAttack
}
