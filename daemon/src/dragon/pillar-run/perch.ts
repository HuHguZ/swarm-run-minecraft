'use strict'
// Бой с драконом (dragon/pillar-run.ts): насест: кровать в голову, уход спереди, подход к насесту, удар по голове.
const { gameClock, Vec3, overlap, playerBox, inflate, findItem, FILLER_RE, cloudsOf, DEBUG, dbg, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, partsOf, clearControls, PHASE_RU, hpOf, fireballsOf, pvp, BREATH_R, boxDist, PART, cloudHits, HEAD_AHEAD, BREATH_AHEAD, zonesOf }: typeof import('../dig-down-to') = require('../dig-down-to')
const { hunters, doing, inClouds, pickSpot, nearPillar, r1, podiumTop, HOLE_TOP, duckPlan, duck, breathOf, standY, hasEffect, sight, takeoffBoxes, STAY_R, awayFromHead, hitBy, straightWalkable, usePotion }: typeof import('../fall-guard') = require('../fall-guard')
const { dangerAt, countOf, evade, noteNear, sneakPlace, lookAtSafe, segPoint2, SCAN_RANGE, bedPlan, takeoffSidestep }: typeof import('../evade-raw') = require('../evade-raw')
const { meleeSpot }: typeof import('../pillar-plan') = require('../pillar-plan')
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

async function perchAttack (session, ctl, rep, stats, track) {
  const bot = session.bot
  doing(ctl, 'perch')
  let d = dragonOf(bot)
  if (!d) return
  let parts = partsOf(bot, d, track)
  // Посадка (2026-09-30). Видящий (ревёт на 25-м тике) сидит до четырёх огней
  const rec = sitState(d, phaseOf(bot, d), gameClock.now())
  // Дракон бил нас в эту посадку (где угодно: у кровати, на подходе) — к голове
  // больше не лезть.
  const hitAt0 = hitBy.get(d.id)
  if (rec && hitAt0 && hitAt0 > rec.t0 && !rec.hitBack) rec.hitBack = hitAt0
  // Подставки не было, а видящий ревёт или дышит — к голове не идти до «высматривает».
  if (rec && rec.noPedestal && rec.roared && (phaseOf(bot, d) === PHASE.ROARING || phaseOf(bot, d) === PHASE.FLAMING) && countOf(bot, FILLER_RE) < 1) {
    doing(ctl, 'perch:wait-flame')
    const bad = hazardNow(bot)
    if (bad) await evade(bot, ctl, stats, bad)
    else { await lookAtSafe(bot, parts.headC); await sleep(150) }
    return
  }
  // Видящий высматривает (25 тиков каждого круга) — голова поворачивается к нам
  if (rec) noteNear(rec, d, bot, gameClock.now())
  // Видящий (или пока не ясно) высматривает, а мы дальше STAY_R — ближе, в
  // сторону от морды: иначе через 100 тиков таран (см. SCAN_RANGE).
  if (rec && phaseOf(bot, d) === PHASE.SCANNING && !blindKnown(rec) && bot.entity.position.distanceTo(d.position) > STAY_R + 0.5) {
    await keepInScan(session, ctl, stats, d, parts)
    return
  }
  {
    const phNow = phaseOf(bot, d)
    if (rec && phNow === PHASE.SCANNING && (rec.roared || !blindKnown(rec))) {
      doing(ctl, 'perch:scan')
      const bad = hazardNow(bot, { parts })
      if (bad) await evade(bot, ctl, stats, bad)
      else {
        const rx = bot.entity.position.x - d.position.x; const rz = bot.entity.position.z - d.position.z
        const inPit = bot.entity.position.y <= d.position.y - HOLE_TOP + 0.05
        if (Math.hypot(rx, rz) < HEAD_AHEAD + 3.5 && !inPit) await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 })
        else { await lookAtSafe(bot, parts.headC); await sleep(100) }
      }
      return
    }
  }
  // Нырнули до взлёта слепого — сидеть в яме до конца посадки.
  if (rec && rec.ducked) { doing(ctl, 'perch:ducked'); await lookAtSafe(bot, parts.headC); await sleep(150); return }
  if (rec && (rec.flames >= 4 || (rec.dmg || 0) >= 44 || rec.hitBack)) {
    await leaveFront(session, ctl, stats, d, rec)
    return
  }
  // С малым хп к голове не идти: сидячий огонь — 3 магией в секунду сквозь
  if (bot.health < 16 && findItem(bot, /golden_apple$/) && !hasEffect(bot, 'absorption') &&
      bot.entity.position.distanceTo(d.position) > HEAD_AHEAD + 3) {
    await heal(session, ctl, rep, stats, { hard: true })
  }
  if (bot.health < 12) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 10) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return }
  }
  // Удар может поднять его на взлёт (накопленный сидячий урон у 50), а у головы
  // мы в коридоре взлёта: голова и крылья — до 11 хп. Только с запасом хп.
  if (takeoffOnHit() && bot.health < 16) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 16) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return }
  }
  // Кровати с собой — сперва они (урон сразу, у головы не стоять). Не вышло
  // трижды подряд без единого взрыва — дальше только меч.
  const ph0 = phaseOf(bot, d)
  // Слепому (посадка 5 с) — не кровать: поставить её, заслон и щёлкнуть к взлёту не
  // успеть, а стоим с ней по оси морды — в коридоре взлёта. Меч быстрее.
  if (ctl.beds && !blindKnown(rec) && countOf(bot, /_bed$/) > 0 && bot.health >= 12 && !((stats.bedTried || 0) >= 3 && !stats.bedsUsed)) {
    const soonFlame = ph0 === PHASE.ROARING ? breathOf(bot, d, parts) : null
    const plan = bedPlan(bot, d, parts, { brave: bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 14) })
    if (!plan) { stats.bedNoPlan = stats.bedNoPlan || {}; for (const [k, v] of (Object.entries(bedPlan.why || {}) as [string, any][])) stats.bedNoPlan[k] = (stats.bedNoPlan[k] || 0) + v; if (DEBUG && gameClock.now() - (stats.bedPlanLog || 0) > 2000) { stats.bedPlanLog = gameClock.now(); dbg('bed plan', PHASE_RU[ph0], JSON.stringify(bedPlan.why)) } }
    if (plan && !(soonFlame && cloudHits(soonFlame, plan.feet, 0.8))) {
      stats.bedTried = (stats.bedTried || 0) + 1
      const b = await bedBlast(session, ctl, rep, stats, track)
      if (b && b.beds) return
    }
  }
  const spot = meleeSpot(bot, d, parts, { blind: blindKnown(rec) })
  if (!spot) { stats.noSpot++; return }
  // Облака фаерболов у фонтана (живут 30 с, растут до 7) — к голове сквозь
  {
    const fb = cloudsOf(bot).filter(c => c.r < BREATH_R - 0.3 || c.pos.distanceTo(parts.headC) > BREATH_AHEAD + 3)
    const me1 = bot.entity.position
    if (inClouds(fb, spot.ground, 1) || !straightWalkable(bot, me1, spot.ground, zonesOf(fb))) {
      stats.perchCloudy = (stats.perchCloudy || 0) + 1
      doing(ctl, 'perch:cloudy')
      const bad = hazardNow(bot)
      if (bad) await evade(bot, ctl, stats, bad)
      else await sleep(200)
      return
    }
  }
  // Огонь уже лежит — к голове идти сквозь него (подставка ставится на месте,
  const onSpot = Math.hypot(bot.entity.position.x - spot.ground.x, bot.entity.position.z - spot.ground.z) < 0.8 && bot.entity.position.y >= spot.feet.y - 0.01
  const flame = cloudsOf(bot).find(c => c.pos.distanceTo(parts.headC) < BREATH_AHEAD + 3 && c.r >= BREATH_R - 0.5)
  let through = false
  if (flame && !onSpot && Math.hypot(spot.ground.x - flame.pos.x, spot.ground.z - flame.pos.z) < flame.r + 1) {
    // Облако огня живёт 10 с, а огонь повторяется каждые ~13 с: ждать его
    const brave = (bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 16)) && !(ctl.beds && countOf(bot, /_bed$/) > 0) &&
      bot.entity.position.distanceTo(spot.ground) < 9 && countOf(bot, FILLER_RE) >= spot.lift
    if (!brave) {
      stats.waitedFlame = (stats.waitedFlame || 0) + 1
      await sleep(300)
      return
    }
    through = true
  }
  const perch: any = { at: Math.round(hpOf(bot, d)), hits: 0, dmg: 0, head: 0, body: 0 }
  doing(ctl, 'perch:approach')
  if (through) perch.throughFlame = true
  stats.perches.push(perch)
  const hz = through ? 'noclouds' : true
  // Подойти к клетке у головы: по прямой, если близко и путь ровный, иначе
  // pathfinder (между ботом и головой часто чаша портала и столб).
  let me = bot.entity.position
  const standing = () => SITTING.has(phaseOf(bot, dragonOf(bot))) || phaseOf(bot, dragonOf(bot)) === PHASE.LANDING
  // Шаг к подставке — не в голову и не в шею: пока идём, дракон доворачивает
  const nearHead = () => {
    const dd = dragonOf(bot)
    if (!dd) return false
    const pp = partsOf(bot, dd, track)
    const pb = playerBox(bot.entity.position)
    return overlap(pb, inflate(pp.head, 1.4)) || overlap(pb, inflate(pp.neck, 1.4))
  }
  // Сбоку к голове не подходить — её дуга (см. dangerAt, sweep): сначала выйти
  // на ось морды подальше, потом шагнуть к ней спереди.
  {
    const rx = me.x - d.position.x; const rz = me.z - d.position.z
    const h = Math.hypot(rx, rz)
    const ang = h > 0.1 ? Math.acos(Math.max(-1, Math.min(1, (rx * parts.dir.x + rz * parts.dir.z) / h))) : Math.PI
    // Слепому голову не поворачивать — к месту сбоку напрямую.
    if (!blindKnown(rec) && (ang > 0.45 || h < HEAD_AHEAD)) {
      const front = d.position.offset(parts.dir.x * (HEAD_AHEAD + 5), 0, parts.dir.z * (HEAD_AHEAD + 5))
      const fy = standY(bot, front.x, front.z, spot.ground.y, 4, 6)
      if (fy != null) {
        perch.viaFront = true
        await walkTo(session, ctl, new Vec3(front.x, fy, front.z), { range: 1.5, timeoutMs: 8000, hazards: hz })
        me = bot.entity.position
      }
    }
  }
  if (Math.hypot(me.x - spot.ground.x, me.z - spot.ground.z) > 0.6) {
    let r: any = me.distanceTo(spot.ground) < 5 ? await stepTo(bot, ctl, spot.ground, { ms: 2000, stopAt: 0.25, sprint: false, clouds: !through, stop: () => !standing() || nearHead() || (!through && !!inClouds(cloudsOf(bot), bot.entity.position, 0.3)) }) : { ok: false }
    if (nearHead()) { perch.why = 'шея довернулась к нам'; await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); return }
    if (!r.ok && standing()) r = await walkTo(session, ctl, spot.ground, { range: 0, timeoutMs: 9000, hazards: hz })
    if (!r.ok && Math.hypot(bot.entity.position.x - spot.ground.x, bot.entity.position.z - spot.ground.z) > 0.8) { perch.why = r.why; return }
    await stepTo(bot, ctl, spot.ground, { ms: 800, sprint: false, stopAt: 0.12, stop: nearHead, clouds: !through })
  }
  perch.reached = true
  doing(ctl, 'perch:melee')
  // Блок (или два) под себя — стоять над облаком огня.
  const blindNow = () => blindKnown(rec)
  for (let tries = 0; tries < 2 && !blindNow() && countOf(bot, FILLER_RE) >= spot.lift && Math.floor(bot.entity.position.y + 0.01) < spot.feet.y; tries++) {
    const t = await build.towerUp(bot, ctl, Math.max(1, spot.feet.y - Math.floor(bot.entity.position.y + 0.01)))
    perch.pedestal = (perch.pedestal || 0) + t.placed
  }
  // Подставка не встала: пока дракон дышит, облако ляжет прямо под ноги — стоять
  // рядом с головой можно только до огня.
  perch.low = Math.floor(bot.entity.position.y + 0.01) < spot.feet.y
  const weapon = items.bestWeapon(bot)
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  let nextReady = gameClock.now() + 100
  let lastSwing = 0
  let lastHp = hpOf(bot, d)
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 30000) {
    await yieldTick()
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    if (!SITTING.has(ph)) {
      // Взлёт от нашего удара (сидячий урон перевалил за 50 — он копится на все
      if (ph === PHASE.TAKEOFF) { perch.left = 'взлёт — вбок'; await takeoffSidestep(bot, ctl, d, 'взлёт от удара') }
      break
    }
    const rc = sitState(d, ph, gameClock.now())
    // Подставки нет (кончились блоки), а видящий ревёт или дышит — облако огня
    if (perch.low && !blindNow() && (ph === PHASE.ROARING || ph === PHASE.FLAMING)) { perch.left = 'огонь, подставки нет'; if (rc) rc.noPedestal = gameClock.now(); break }
    // Видящий снова высматривает — голова пойдёт по дуге: отойти до рёва.
    if (ph === PHASE.SCANNING && rc && rc.roared) { perch.left = 'высматривает — отойти'; await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); break }
    // Четвёртый огонь или ≥ 44 за посадку — уходить от морды до взлёта.
    if (rc && (rc.flames >= 4 || (rc.dmg || 0) >= 44)) { perch.left = rc.flames >= 4 ? 'четвёртый огонь' : 'снято 44'; break }
    // Слепой взлетит на ~4.6 с — к 3.4 с нырнуть (или уйти, если не копается).
    if (rc && !rc.roared && gameClock.now() - rc.t0 > 3400) {
      clearControls(bot)
      const F = Math.floor(d.position.y - HOLE_TOP - 0.15)
      perch.ducked = duckPlan(bot, F) ? await duck(bot, ctl, F) : false
      if (perch.ducked) rc.ducked = true
      else rc.hitBack = gameClock.now()
      perch.left = perch.ducked ? 'нырнул до взлёта' : 'взлёт скоро, нырнуть нельзя'
      break
    }
    parts = partsOf(bot, d, track)
    const feet = bot.entity.position
    const eye = feet.offset(0, EYE, 0)
    // Облако уже под ногами или голова наехала — сойти.
    const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 30), parts, breath: null }
    const bad = dangerAt(bot, feet, ctx)
    if (bad) { perch.left = bad.kind; break }
    // Ударил сам дракон (голова, шея — наша оценка их коробок разошлась с
    const hitAt = hitBy.get(d.id)
    if (hitAt && hitAt > t0) {
      perch.left = 'ударил дракон'
      if (rc) rc.hitBack = gameClock.now()
      clearControls(bot)
      await stepTo(bot, ctl, awayFromHead(d, parts, feet, 4), { ms: 1200, stopAt: 0.4 })
      break
    }
    const reach = boxDist(eye, parts.head)
    // Дракон довернул голову — раздутые голова и шея уже рядом: отступить
    // сразу, по оси морды назад, и выбрать место заново.
    const pbNow = playerBox(feet)
    if (overlap(pbNow, inflate(parts.head, 1.2)) || overlap(pbNow, inflate(parts.neck, 1.2))) {
      perch.backed = (perch.backed || 0) + 1
      clearControls(bot)
      const back = awayFromHead(d, parts, feet, 3)
      await stepTo(bot, ctl, back, { ms: 900, stopAt: 0.4 })
      if (perch.backed > 3) break
      continue
    }
    if (DEBUG && (!perch.dbgAt || gameClock.now() - perch.dbgAt > 1000)) {
      perch.dbgAt = gameClock.now()
      dbg('perch', 'phase', PHASE_RU[ph], 'head', parts.headC.toString(), 'me', feet.toString(), 'reach', reach.toFixed(2), 'hp', hpOf(bot, d), 'yaw', d.yaw.toFixed(2))
    }
    if (reach > 3.4) {
      // Дракон повернулся: переставиться.
      perch.moved = (perch.moved || 0) + 1
      if (perch.moved > 3) break
      const again = meleeSpot(bot, d, parts)
      if (!again) break
      // Голова ушла далеко (довернулся) — не бегать за ней вокруг дракона сквозь
      if (Math.hypot(again.ground.x - feet.x, again.ground.z - feet.z) > 3 || inClouds(cloudsOf(bot), again.ground, 1)) { perch.left = 'голова ушла далеко'; break }
      clearControls(bot)
      await stepTo(bot, ctl, again.ground, { ms: 2500, stopAt: 0.2, stop: () => (hitBy.get(d.id) || 0) > t0 })
      if (countOf(bot, FILLER_RE) > 0) await build.towerUp(bot, ctl, 1)
      continue
    }
    // Злой эндермен вплотную посреди посадки: ударить его в перезарядку головы,
    // не сходя с места (его 7 урона за удар против окна посадки).
    const pest: any = hunters(bot, 3.2)[0]
    if (pest && gameClock.now() >= nextReady) {
      await bot.lookAt(pest.position.offset(0, 1.5, 0), true).catch(() => {})
      bot.attack(pest)
      perch.pests = (perch.pests || 0) + 1
      nextReady = gameClock.now() + pvp.cooldownMs(bot.heldItem)
      await sleep(50)
      continue
    }
    await lookAtSafe(bot, parts.headC)
    // Крита по дракону НЕТ: Player.canCriticalAttack требует, чтобы цель была
    // LivingEntity, а часть дракона — EnderDragonPart (сверено по байткоду;
    const now = gameClock.now()
    const hp = hpOf(bot, d)
    if (hp != null && lastHp != null && hp < lastHp) {
      const lost = lastHp - hp
      perch.dmg += lost
      stats.dmg += lost
      if (sitRec && sitRec.id === d.id && !sitRec.ended) sitRec.dmg = (sitRec.dmg || 0) + lost
      lastHp = hp
    }
    if (now >= nextReady - 350 && bot.entity.onGround) bot.setControlState('jump', true)
    else bot.setControlState('jump', false)
    const airborne = !bot.entity.onGround
    if (now >= nextReady && (airborne || now >= nextReady + 300)) {
      // Столб под ноги (переставились) берёт в руку булыжник — и удар
      const w = items.bestWeapon(bot)
      if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) {
        await bot.equip(w, 'hand').catch(() => {})
        nextReady = gameClock.now() + pvp.cooldownMs(w)
        await sleep(50)
        continue
      }
      if (reach <= 3.0) {
        bot.attack({ id: d.id + PART.head })
        perch.hits++
        stats.melee++
        nextReady = now + pvp.cooldownMs(bot.heldItem)
        // Урон головой или телом — по тому, на сколько упало здоровье.
        const before = hpOf(bot, d)
        gameClock.setTimeout(() => {
          const dd = dragonOf(bot)
          const after = dd ? hpOf(bot, dd) : null
          if (before != null && after != null) {
            const lost = before - after
            if (lost >= 4) perch.head++
            else if (lost > 0) perch.body++
            if (DEBUG) dbg('hit', 'lost', lost.toFixed(2), 'air', airborne, 'reach', reach.toFixed(2), 'held', bot.heldItem && bot.heldItem.name)
          }
        }, 250)
        lastSwing = now
      }
    }
    await sleep(50)
  }
  clearControls(bot)
  perch.hpAfter = d ? Math.round(hpOf(bot, d) ?? 0) : 0
}

export {
  bedBlast, leaveFront, perchFar, perchApproach, keepInScan, perchAttack
}
