const { gameClock, Vec3, overlap, playerBox, inflate, Movements, goals, findItem, FILLER_RE, voidBelow, cloudZones, inZone, nearPortal, runnerBowl, cloudsOf, DEBUG, dbg, stepIntoZone, SAFE_FROM_CRYSTAL, bow, starer, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, digDownTo, items, build, EYE, SITTING, partsOf, supportCell, clearControls, box, RUN_SEEN, PHASE_RU, hpOf, RUN_ARROW, envNum, RUN_KEEPCOB, isAirish, RUN_BOX, RUN_HIGH, envv, FIRST_MAX, RUN_TICKSEEN, PLACE_LEAD, RUN_FACING, RUN_GAPARROW, RUN_LATEHEAD, runnerOn, fbAlarm, placeItemAt, pick, TOWER_FAR, fireballsOf, BUILD_MAX_MS, RUN_TOWER1, pvp, makeTrack, pillarTriesMax, PILLAR_BAD, KEEP_ON, KEEP_N, RUN_MELEE, BEDS_KIT, dragonWaitBand, dragonWaitStop, holdingOdds, BREATH_R, sitFix, boxDist, PART, cloudHits, fillerItem, HEAD_AHEAD, BREATH_AHEAD, zonesOf, runwayAhead } = require('./dig-down-to')
const { inCharge, hunters, doing, surfaceY, inClouds, pickSpot, nearPillar, fastTower, r1, podiumTop, HOLE_TOP, duckPlan, duck, overCloud, crystalsOf, breathOf, nearEdge, standY, hasEffect, sight, takeoffBoxes, STAY_R, awayFromHead, hitBy, straightWalkable, usePotion, cloudAgeMs, healRaw, dragonVel, wingBoxes, embeddedNow, unembed } = require('./fall-guard')
const { dangerAt, countOf, evade, noteNear, sneakPlace, lookAtSafe, DRAD, virtualBot, exposure, landingForecast, landingHits, bedDamage, SNEAK_EYE, hurtNear, bedCellFree, BED_TOP, fillPlaceable, simClone, simHead, simNeck, predParts, tsClickPoint, segPoint2, dragonSeen, DIRS4, blastReaches, anClickPoint, SCAN_RANGE, bedPlan, takeoffSidestep } = require('./evade-raw')
const { makeRubberband, crystalShotSpot, pointBlank, chargeOf, takeoffSoon, unstick } = require('./crystal-shot-spot')
const { towerUnsafe, waterToHotbar, dropOff, onSpike, getDown, onOwnPillar, tidy, dynamicPlace, stationPlan, bedHere, stationPlaceBed, stationBlow, pillarHere, smCompile, smDragonSeen, SM_EMPTY, runnerArrow, runnerSupport, bodyBlocksBed, runnerGapArrow, standFor, pillarPlanAutoAsync, rangedShot, crysAlive, CRYS_BAND, chooseStation } = require('./station-plan')
const { headPoint, pillarCells, faceClick, BED_GAP_MS, faceClickFacing, approachFar, SWORD_V2, SWORD_PED, swordPick, runnerAim, crysState, crysTargets, crystalTimingAllowed, crystalShotFrom, crystalSpot, crysOn, portalBlocks, noteTakeoff, RUN_SWORD, stationBedPlaced, runnerPlan, pillarPlan, pillarKey, OC_ON, takeoffSeen, exposedNow, doubleHit, doubleBuild, shieldFor, cardOf, cellsOnSeg, bedPointFrom, lowRowsOpen, bedsBuild, bedClickPoint, BEDS_TAKEOFF, seeCalibrate, BEDS_DOUBLE, meleeSpot, clickBedAt } = require('./pillar-plan')
const { anchorCharges, FACE_IDX, chargeAnchor, pushedForecast, placeNoBed, placeBedAt, turnSafe, yRotOf, blastPush, dragonNodes, takeoffNode, takeoffForecast, tsPlan, TURN_SAFE_R, clearOfDragon, DAMAGE_TYPES, readVarIntAt, lpVec3At, r3, placeAnchorAt, AXES, tsSecond, tsOwnPlan, stationWorld, tsOwnStation } = require('./ts-plan')
async function refillBucket (session, ctl, stats) {
  const bot = session.bot
  if (findItem(bot, /^water_bucket$/)) return true
  const empty = findItem(bot, /^bucket$/)
  if (!empty) return false
  const me = bot.entity.position
  const srcs = bot.findBlocks({ matching: b => !!b && b.name === 'water' && b.metadata === 0, maxDistance: 24, count: 12 })
    .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  const clouds = cloudsOf(bot)
  for (const w of srcs.slice(0, 4)) {
    if (ctl.aborted) break
    doing(ctl, 'refill')
    // Встать рядом с водой (не в ней): клетка в 1–3 блоках, на земле, не в облаке.
    let spot = null
    for (let r = 1; r <= 3 && !spot; r++) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
        const y = standY(bot, w.x + dx + 0.5, w.z + dz + 0.5, w.y, 2, 3)
        if (y == null) continue
        const feet = new Vec3(w.x + dx + 0.5, y, w.z + dz + 0.5)
        if (inClouds(clouds, feet, 1) || nearEdge(bot, feet, 2)) continue
        spot = feet; break
      }
    }
    if (!spot) continue
    if (spot.distanceTo(bot.entity.position) > 1.2) {
      const wk = await walkTo(session, ctl, spot, { range: 1, timeoutMs: 12000 })
      if (!wk.ok) continue
    }
    const b = findItem(bot, /^bucket$/)
    if (!b) break
    try {
      await bot.equip(b, 'hand')
      await bot.lookAt(w.offset(0.5, 0.5, 0.5), true)
      bot.activateItem()
    } catch (e) { dbg('refill', e.message) }
    const t0 = gameClock.now()
    while (!findItem(bot, /^water_bucket$/) && gameClock.now() - t0 < 800) await sleep(50)
    const ok = !!findItem(bot, /^water_bucket$/)
    stats.refill = (stats.refill || 0) + (ok ? 1 : 0)
    if (ctl.trace) ctl.trace.ev('refill', { at: [w.x, w.y, w.z], ok })
    if (ok) { await waterToHotbar(bot); const wpn = items.bestWeapon(bot); if (wpn) await bot.equip(wpn, 'hand').catch(() => {}); return true }
  }
  return false
}

function endMovements (bot, clouds = null, { maxDrop = 3, portal = false, noDig = false, sprint = false, digCost = 1 }: any = {}) {
  const m = new Movements(bot)
  m.canDig = !noDig && !!findItem(bot, /_pickaxe$/)
  m.allowParkour = false
  m.allowSprinting = !!sprint && (bot.food ?? 20) > 6
  m.digCost = digCost
  // Прыжок вниз pathfinder планирует только на твёрдое (в пустоту не
  // прыгнет), так что глубина — это только цена в хп падения.
  m.maxDropDown = maxDrop
  m.infiniteLiquidDropdownDistance = false
  // Не копать и не ходить к низу острова: fin3-11 — платформа в толще острова (y 49), путь к
  // центру прокопом ушёл вниз до y 36, к нижнему краю, и следующий прокоп открыл пустоту.
  m.exclusionAreasBreak.push(b => (b && b.position && b.position.y < 44 ? Infinity : 0))
  m.exclusionAreasStep.push(b => (b && b.position && b.position.y < 43 ? Infinity : 0))
  // Столб 1×1 у pathfinder'а медленный и срывается (прыжок и установка не в
  // такт): 5 с на блок против 0.6 с на прокоп ступеньки в эндерняке алмазной киркой.
  m.allow1by1towers = false
  const reg = bot.registry
  m.scafoldingBlocks = bot.inventory.items().filter(i => FILLER_RE.test(i.name)).map(i => i.type)
  for (const n of ['obsidian', 'bedrock', 'iron_bars', 'end_portal_frame', 'crying_obsidian']) {
    if (reg.blocksByName[n]) m.blocksCantBreak.add(reg.blocksByName[n].id)
  }
  // Выходной портал и шлюз — не пол: шаг в них уносит из Энда.
  for (const n of ['end_portal', 'end_gateway']) {
    if (reg.blocksByName[n]) m.blocksToAvoid.add(reg.blocksByName[n].id)
  }
  // Мостить над пустотой pathfinder'у не даём: это делает свой мост, осторожно.
  m.exclusionAreasPlace.push(b => (b && b.position && voidBelow(bot, b.position.x, b.position.y + 1, b.position.z, 40)) ? 1000 : 0)
  // Облака растут (фаербол: 3 → 7 за 30 с) — путь сквозь них не прокладывать вовсе.
  if (clouds) {
    m.exclusionAreasStep.push(b => {
      if (!(b && b.position)) return 0
      const feet = new Vec3(b.position.x + 0.5, b.position.y, b.position.z + 0.5)
      const zs = cloudZones(bot)
      if (zs.some(z => inZone(z, feet))) return 20000
      return zs.some(z => inZone(z, feet, 1.2)) ? 500 : 0
    })
  }
  m.exclusionAreasStep.push(b => (b && b.position) ? dragonStepCost(bot, b.position) : 0)
  if (!portal) m.exclusionAreasStep.push(b => (b && b.position && nearPortal(new Vec3(b.position.x + 0.5, b.position.y, b.position.z + 0.5))) ? 1000 : 0)
  return m
}

async function walkTo (session, ctl, target, opts: any = {}) {
  let last = null
  for (let attempt = 0; attempt < 4 && !ctl.aborted; attempt++) {
    if (embeddedNow(session.bot)) await unembed(session.bot, ctl)
    await guard(session, ctl)
    // Уже в облаке — сперва выйти: noPath отвечает мгновенно, и без этого
    // тело так и стоит в нём, пока вызывающий перебирает цели.
    if (opts.hazards !== false) {
      const bad = hazardNow(session.bot)
      if (bad && !(opts.hazards === 'noclouds' && /облако/.test(bad.kind))) await evade(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }, bad)
    }
    if (opts.stopIf) { const w = opts.stopIf(); if (w) return { ok: false, why: w, stopped: true } }
    last = await walkOnce(session, ctl, target, opts)
    if (last.stopped) return last
    if (last.embedded) { await unembed(session.bot, ctl); continue }
    if (last.stalled) { await unstick(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }); continue }
    if (last.enderman) { attempt--; continue }
    // Облако на пути — рассчитать заново (облака уже в цене шага); цель сама в
    // облаке — вернуть вызывающему.
    if (last.blocked) { if (cloudZones(session.bot).some(z => inZone(z, target))) return { ok: false, why: 'цель в облаке', cloud: true }; await sleep(150); continue }
    // Застрял наверху (мосток над порталом, свой столб): вниз разрешить
    // спрыгнуть глубже — до 8 блоков, это до ~5 хп, а не пустота.
    if (!last.ok && !last.hazard && !last.cloud && !opts.maxDrop && session.bot.entity.position.y - target.y > 3 && session.bot.health > 12) {
      last = await walkOnce(session, ctl, target, { ...opts, maxDrop: 8 })
      if (last.ok) return last
    }
    if (last.ok || !last.hazard) return last
    await evade(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }, last.hazard)
    // Цель сама в облаке — возвращаться туда значит снова стоять в нём: пусть
    // вызывающий выберет другое место.
    if (inClouds(cloudsOf(session.bot), target, 2.5)) return { ok: false, why: 'цель в облаке', cloud: true }
  }
  return last || { ok: false, why: 'прервано' }
}

let guarding = false

async function guard (session, ctl) {
  if (guarding) return
  guarding = true
  try {
    const bot = session.bot
    const stats = ctl.stats || { dodges: {}, ate: [], hid: [] }
    const d = dragonOf(bot)
    const ph = d ? phaseOf(bot, d) : null
    const landing = SITTING.has(ph) || ph === PHASE.LANDING || ph === PHASE.APPROACH
    // Дракон садится — окно дороже эндермена: драться, только если тот уже бьёт.
    const e = hunters(bot, landing ? 2.5 : 3.5).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (e) {
      await fightEnderman(session, ctl, stats, e, () => {
        const p2 = phaseOf(bot, dragonOf(bot))
        return !landing && (SITTING.has(p2) || p2 === PHASE.LANDING)
      })
    }
    // Окно посадки (сидит/садится) дороже еды: уход от облака «с запасом 4» и яблоко на 13 хп
    const win = SITTING.has(ph) || ph === PHASE.LANDING
    if (bot.health <= 14) await clearOfClouds(session, ctl, stats, win ? 1 : 4)
    if (bot.health <= 7) await hideAndHeal(session, ctl, null, stats, { until: 16 })
    else if (win ? bot.health <= 10 : (bot.health <= 14 || bot.food < 14)) await heal(session, ctl, null, stats, { hard: bot.health <= 14 })
  } finally { guarding = false }
}

async function walkOnce (session, ctl, target, { range = 1, timeoutMs = 30000, xz = false, hazards = true, maxDrop = 3, portal = false, stopIf = null, noDig = false, sprint = false, digCost = 1 }: any = {}) {
  const bot = session.bot
  // Уже прервано — не начинать: stop() в onAbort после abort не позовут, и
  if (ctl.aborted) return { ok: false, why: 'прервано' }
  if (ctl.deadline) timeoutMs = Math.max(1000, Math.min(timeoutMs, ctl.deadline - gameClock.now()))
  if (runnerBowl(bot, ctl)) portal = true
  bot.pathfinder.setMovements(endMovements(bot, hazards === 'noclouds' ? null : () => cloudsOf(bot), { maxDrop, portal, noDig, sprint, digCost }))
  const goal = xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)
  const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  ctl.onAbort.push(stop)
  let timer = null
  let hazard = null
  // Путь впереди (массив pathfinder'а, он сдвигает его сам по мере хода) — для
  // проверки облаков на пути: облако, упавшее после расчёта, — путь заново.
  let curPath = null
  let blocked = null
  const onPath = r => {
    if (r && r.path) curPath = r.path
    if (!DEBUG || !r || !r.path) return
    dbg('path', r.status, r.path.slice(0, 6).map(n => `${n.x},${n.y},${n.z}${n.toBreak && n.toBreak.length ? ' dig' + n.toBreak.length : ''}${n.toPlace && n.toPlace.length ? ' place' + n.toPlace.length : ''}`).join(' → '))
  }
  bot.on('path_update', onPath)
  // Пока идём — следить за фаерболами и облаками: путь рвётся, тело уходит.
  const band = makeRubberband(bot)
  let embedded = false
  let pest = null
  // Встал: жмёт «вперёд» в стену и не двигается (прогон 2026-09-25: 20 с в
  let stalled = false
  let moved = { p: bot.entity.position.clone(), t: gameClock.now() }
  let stopped = null
  const poll = gameClock.setInterval(() => {
    if (hazard || embedded || pest || stalled || blocked || stopped) return
    if (stopIf) { const w = stopIf(); if (w) { stopped = w; stop(); return } }
    if (band.count() >= 4) { embedded = true; stop(); return }
    const here = bot.entity.position
    if (here.distanceTo(moved.p) > 0.25 || bot.targetDigBlock || !bot.getControlState('forward')) moved = { p: here.clone(), t: gameClock.now() }
    else if (gameClock.now() - moved.t > 2500) { stalled = true; stop(); return }
    // Злой эндермен вплотную: остановиться и отбиться, а не идти с ним на спине.
    const e = hunters(bot, 3)[0]
    if (e) { pest = e; stop(); return }
    if (!hazards) return
    const bad = hazardNow(bot)
    // noclouds — сквозь облако идём сознательно (к подставке у головы), но
    // от фаербола и головы уходим.
    if (bad && !(hazards === 'noclouds' && /облако/.test(bad.kind))) { hazard = bad; stop(); return }
    if (hazards !== 'noclouds' && curPath && curPath.length) {
      const zs = cloudZones(bot)
      let prev = here
      for (const n of curPath.slice(0, 8)) {
        const f = new Vec3(n.x + 0.5, n.y, n.z + 0.5)
        const z = stepIntoZone(zs, prev, f)
        if (z) { blocked = z; stop(); return }
        prev = f
      }
    }
  }, 150)
  const sampler = DEBUG
    ? gameClock.setInterval(() => {
      const e = bot.entity
      const c = ['forward', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)).join('+')
      const blk = bot.blockAt(e.position)
      dbg('walk', e.position.toString(), 'v', e.velocity.toString(), 'ground', e.onGround, 'keys', c || '-', 'blk', blk ? blk.name : 'NULL', 'veh', bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : '-')
    }, 1000)
    : null
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error(`не дошёл за ${Math.round(timeoutMs / 1000)}с`)), timeoutMs) })
    ])
    // «Дошёл» от pathfinder'а — не свидетель: goal_reached от прошлой цели
    const p = bot.entity.position
    const left = xz ? Math.hypot(p.x - target.x, p.z - target.z) : p.distanceTo(target)
    if (left > range + 1) return { ok: false, why: `pathfinder сказал «дошёл», а до цели ${left.toFixed(1)}` }
    return { ok: true }
  } catch (e) {
    stop()
    if (stopped) return { ok: false, why: stopped, stopped: true }
    return { ok: false, why: embedded ? 'замурован: сервер отбивает шаги' : pest ? 'напал эндермен' : hazard ? `опасность: ${hazard.kind}` : blocked ? `на пути ${blocked.kind}` : stalled ? 'встал: упёрся и не двигается' : String((e && e.message) || e), hazard, embedded, stalled, enderman: !!pest, blocked }
  } finally {
    gameClock.clearTimeout(timer)
    band.close()
    gameClock.clearInterval(poll)
    if (sampler) gameClock.clearInterval(sampler)
    bot.removeListener('path_update', onPath)
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) { try { bot.setControlState(k, false) } catch {} }
  }
}

async function shootCrystal (session, ctl, cr, rep, stats) {
  const bot = session.bot
  const spot = crystalShotSpot(bot, cr)
  if (!spot) return { ok: false, why: 'нет места, откуда стрела долетит мимо блоков' }
  dbg('crystal', cr.id, 'spot', spot.feet.toString(), 'pitch', (spot.sol.pitch * 57.3).toFixed(0), spot.mode === 'lob' ? 'навесом' : '', 'ticks', spot.sol.ticks)
  doing(ctl, 'crystal:walk')
  if (spot.feet.distanceTo(bot.entity.position) > 1.5) {
    const w = await walkTo(session, ctl, spot.feet, { range: 0.8, timeoutMs: 45000 })
    if (!w.ok && spot.feet.distanceTo(bot.entity.position) > 3) return { ok: false, why: `не дошёл до точки выстрела: ${w.why}` }
  }
  const alive = () => !!bot.entities[cr.id] && bot.entities[cr.id].isValid !== false
  let stopWhy = null
  for (let shot = 0; shot < 6 && alive() && !ctl.aborted; shot++) {
    doing(ctl, 'crystal:shoot')
    stopWhy = null
    if (countOf(bot, /arrow$/) < 1) return { ok: false, why: 'стрелы кончились' }
    if (bot.entity.position.distanceTo(cr.pos) < SAFE_FROM_CRYSTAL) return { ok: false, why: 'слишком близко к кристаллу — взрыв' }
    // Заход с фаерболом сам по себе не повод бросать лук: фаербол виден с
    const bad0 = hazardNow(bot)
    if (bad0) { await evade(bot, ctl, stats, bad0); return { ok: false, why: `опасность: ${bad0.kind}`, moved: true } }
    const r = await bow.shoot(bot, cr.e, {
      point: () => cr.aim,
      steep: spot.mode,
      follow: false,
      mode: 'settle',
      shouldStop: () => {
        const why = ctl.aborted ? 'прервано' : !alive() ? 'кристалла нет' : starer(bot, bot.entity.yaw, bot.entity.pitch) ? 'взгляд в глаза эндермену' : hunters(bot, 4).length ? 'эндермен бьёт' : (hazardNow(bot) || {}).kind || null
        if (why) stopWhy = why
        return !!why
      }
    })
    if (hunters(bot, 4).length) await guard(session, ctl)
    if (!r.shot) {
      dbg('crystal shot refused', r.why, stopWhy)
      if (ctl.trace) ctl.trace.ev('shotRefused', { id: cr.id, why: r.why, stop: stopWhy })
      if (r.blocked) return { ok: false, why: r.why, blocked: true }
      continue
    }
    stats.arrows++
    // Стрела в полёте (навесом — до четырёх секунд): стоять можно, пока тихо.
    const wait = gameClock.now() + Math.min(6000, (r.flightTicks || 20) * 50 + 700)
    while (gameClock.now() < wait && alive() && !ctl.aborted) {
      const bad = hazardNow(bot)
      if (bad) { await evade(bot, ctl, stats, bad); break }
      await sleep(50)
    }
  }
  if (!alive()) { stats.crystals++; return { ok: true } }
  return { ok: false, why: 'шесть стрел — кристалл цел' }
}

async function earlyCrystalStep (session, ctl, stats, d, ph) {
  const bot = session.bot
  if (envv('ND_CRYS_EARLY') !== '1' || !crysOn() || !ctl.pillarMode || (ctl.pillar && ctl.pillar.built) ||
      ph !== PHASE.STRAFE || !d || bot.health < 12 || countOf(bot, /_bed$/) < 1 ||
      Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) >= 30) return false
  return crystalWait(session, ctl, stats, d, ph)
}

async function crystalWait (session, ctl, stats, d, ph) {
  const bot = session.bot
  const C = crysState(bot, ctl)
  const keep = envNum('ND_CRYS_KEEP', 6)
  if (!findItem(bot, /^bow$/) || countOf(bot, /arrow$/) <= keep) { C.active = false; return false }
  const targets = crysTargets(bot, ctl)
  if (!targets.length) { C.active = false; return false }
  C.active = true
  const now = gameClock.now()
  // свои стрелы в полёте — ждать (промах — после полёта + 0.6 с: кристалл цел)
  const free = targets.filter(t => !((C.pending.get(t.id) || 0) > now))
  // почему не стреляем (трасса, не чаще раза в 3 с на причину)
  const idle = (why, o: any = {}) => { C.idleT = C.idleT || {}; if (ctl.trace && now - (C.idleT[why] || 0) > 3000) { C.idleT[why] = now; ctl.trace.ev('crysIdle', { why, left: targets.length, free: free.length, ph, ...o }) } return false }
  if (!free.length) return idle('стрелы в полёте')
  if (bot.health < 10) return idle('мало хп')
  if (hunters(bot, 6).length) return idle('эндермен')
  { const hz = hazardNow(bot); if (hz) return idle('опасность', { kind: hz.kind }) }
  // Заход с фаерболом (STRAFE): сбитый сейчас кристалл нового захода не вызывает — стрелять, пока дракон не ближе
  // ND_CRYS_STRAFE_D (24); фаербол в полёте — hazardNow выше и shouldStop при натяжении.
  const dD = d.position.distanceTo(bot.entity.position)
  if (!crystalTimingAllowed(ph, dD)) return idle('фаза', { dD: r1(dD) })
  const me = bot.entity.position
  const feet = new Vec3(me.x, me.y, me.z)
  let best = null
  let stareSkip = 0
  for (const t of free) {
    const live = bot.entities[t.id]
    if (!live || live.isValid === false) continue
    const ban = C.ban.get(t.id)
    if (ban && ban.distanceTo(feet) < 1.5) continue
    const s = crystalShotFrom(bot, t, feet)
    // прицел на этот кристалл смотрит эндермену в глаза — не начинать натяжение (ca2-s17: 122 отмены «взгляд в глаза» за 16 с)
    if (s && starer(bot, s.sol.yaw, s.sol.pitch)) { stareSkip = (stareSkip || 0) + 1; continue }
    if (s && (!best || s.cost < best.s.cost)) best = { t, s, e: live }
  }
  if (!best && stareSkip) return idle('эндермен на линии')
  if (best) {
    doing(ctl, 'crystal:wait-shot')
    const { t, s, e } = best
    const alive = () => !!bot.entities[t.id] && bot.entities[t.id].isValid !== false
    let stopWhy = null
    let releasePh = null; let releaseAt = null
    const hp0 = d ? hpOf(bot, d) : null
    const r = await bow.shoot(bot, e, {
      point: () => t.aim,
      steep: s.mode,
      follow: false,
      mode: 'settle',
      onRelease: () => { const dd = dragonOf(bot); releasePh = dd ? phaseOf(bot, dd) : null; releaseAt = gameClock.now() },
      shouldStop: () => {
        const dd = dragonOf(bot); const p2 = dd ? phaseOf(bot, dd) : null
        const why = ctl.aborted ? 'прервано' : !alive() ? 'кристалла нет'
          : (envv('ND_CRYS_STRAFE_ONLY') === '1' ? !dd || !crystalTimingAllowed(p2, dd.position.distanceTo(bot.entity.position)) : p2 !== PHASE.HOLDING && p2 !== PHASE.STRAFE) ? 'фаза/дистанция ' + (PHASE_RU[p2] ?? p2)
            : starer(bot, bot.entity.yaw, bot.entity.pitch) ? 'взгляд в глаза эндермену' : hunters(bot, 4).length ? 'эндермен бьёт' : (hazardNow(bot) || {}).kind || null
        if (why) stopWhy = why
        return !!why
      }
    })
    if (!r.shot) {
      if (r.blocked) C.ban.set(t.id, feet.clone())
      if (ctl.trace) ctl.trace.ev('crysRefused', { id: t.id, why: r.why, stop: stopWhy })
      return !!stopWhy
    }
    C.shots++
    stats.arrows++
    stats.crysArrows = (stats.crysArrows || 0) + 1
    C.tries.set(t.id, (C.tries.get(t.id) || 0) + 1)
    C.pending.set(t.id, gameClock.now() + (r.flightTicks || s.ticks || 20) * 50 + 600)
    if (C.firstShot == null) C.firstShot = gameClock.now()
    if (ctl.trace) ctl.trace.ev('crysShot', { id: t.id, y: r1(t.pos.y), mode: s.mode === 'lob' ? 'lob' : 'steep', ticks: r1(s.ticks), dist: r1(feet.distanceTo(t.pos)), pitch: r.pitchDeg, ph, releasePh, releaseAt, dHp: hp0 != null ? r1(hp0) : null, at: [r1(feet.x), r1(feet.y), r1(feet.z)], n: C.tries.get(t.id), arrows: countOf(bot, /arrow$/) })
    return true
  }
  if (now < C.noSpotUntil) return idle('нет точки (пауза)')
  // пришли к точке выстрела, а выстрела с места нет — точку в «плохие»
  C.bad = C.bad || []
  if (C.lastMove && C.lastMove.distanceTo(me) < 1.2) { C.bad.push(C.lastMove); C.lastMove = null }
  const spot = await crystalSpot(bot, free, me, C.bad)
  if (!spot) { C.noSpotUntil = now + 10000; if (ctl.trace) ctl.trace.ev('crysNoSpot', { left: free.length }); return false }
  doing(ctl, 'crystal:wait-move')
  C.moves++
  C.lastMove = spot.feet
  if (ctl.trace) ctl.trace.ev('crysMove', { to: [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)], d: r1(spot.feet.distanceTo(me)), id: spot.id, mode: spot.mode === 'lob' ? 'lob' : 'steep' })
  if (spot.feet.distanceTo(me) > 6) await walkTo(session, ctl, spot.feet, { range: 0.8, timeoutMs: 12000, sprint: true, digCost: 4 })
  else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.4 })
  clearControls(bot)
  // не дошли (облако, путь) — к этой точке 10 с не возвращаться
  if (bot.entity.position.distanceTo(spot.feet) > 2) C.noSpotUntil = gameClock.now() + 10000
  return true
}

async function openCage (session, ctl, cr, rep, stats) {
  const bot = session.bot
  const t0 = gameClock.now()
  const toC = { x: CENTER.x - cr.pos.x, z: CENTER.z - cr.pos.z }
  // Сторона — к центру острова (там земля и туда же прыгать вниз), потом
  const main = Math.abs(toC.x) >= Math.abs(toC.z) ? { x: Math.sign(toC.x), z: 0 } : { x: 0, z: Math.sign(toC.z) }
  // Место столба — стена клетки, по три клетки вдоль каждой стороны (сдвиг
  const faces = [main, { x: -main.z, z: main.x }, { x: main.z, z: -main.x }, { x: -main.x, z: -main.z }]
  const sides = []
  for (const off of [0, 1, -1]) for (const f of faces) sides.push({ ...f, off })
  let s = null; let tx = 0; let tz = 0; let sf = null; let off = 0
  const skipped = []
  for (const cand of sides) {
    const x = cr.cx + 3 * cand.x - cand.z * cand.off; const z = cr.cz + 3 * cand.z + cand.x * cand.off
    const top = surfaceY(bot, x + 0.5, z + 0.5, cr.top + 3)
    if (!top) { skipped.push(`${x},${z}: пусто`); continue }
    let ground = top
    // Наш блок — наполнитель, но не эндерняк (эндерняк — сама земля острова).
    const ours = n => FILLER_RE.test(n) && n !== 'end_stone'
    if (ours(top.name)) {
      // Столб из наших блоков: спуститься по нему до естественной земли.
      let y = top.y - 1
      while (y > 0 && bot.blockAt(new Vec3(x, y, z)) && ours(bot.blockAt(new Vec3(x, y, z)).name)) y--
      if (top.y - (y + 1) >= 4) { skipped.push(`${x},${z}: наш столб`); continue }
      const nat = bot.blockAt(new Vec3(x, y, z))
      ground = nat && isSolid(nat) ? { y: top.y, name: nat.name } : null
    }
    if (!ground || !/^(end_stone|cobblestone|cobbled_deepslate|dirt|stone|netherrack)$/.test(ground.name)) { skipped.push(`${x},${z}: ${ground ? ground.name : 'пусто'}`); continue }
    if (voidBelow(bot, x + 0.5, ground.y, z + 0.5, 6)) { skipped.push(`${x},${z}: пустота`); continue }
    // Облако у основания столба: и столб растёт из него, и спрыгнуть придётся в
    // него (d3-22, 30.09: столб в облаке фаербола, спуск в него же — смерть).
    if (inClouds(cloudsOf(bot), new Vec3(x + 0.5, ground.y, z + 0.5), 2)) { skipped.push(`${x},${z}: облако`); continue }
    s = { x: cand.x, z: cand.z }; tx = x; tz = z; sf = ground; off = cand.off
    break
  }
  if (!s) return { ok: false, why: `под столб нет места: ${skipped.join('; ')}` }
  const gy = sf.y
  const topY = cr.top + 2
  const need = topY - gy
  if (countOf(bot, FILLER_RE) < need + 6) await mineEndStone(session, ctl, need + 12, stats)
  if (countOf(bot, FILLER_RE) < need + 6) return { ok: false, why: `на столб нужно ${need + 6} блоков, есть ${countOf(bot, FILLER_RE)}` }
  const base = new Vec3(tx + 0.5, gy, tz + 0.5)
  doing(ctl, 'cage:walk')
  const w = await walkTo(session, ctl, base, { range: 0.5, timeoutMs: 45000 })
  if (!w.ok && Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 1.2) return { ok: false, why: `не дошёл до столба: ${w.why}` }
  const cage: any = { at: { x: cr.cx, y: cr.top, z: cr.cz }, tower: need }
  rep.cages = rep.cages || []
  rep.cages.push(cage)
  // Окно: на столбе от тарана и фаербола не уйти — только вниз.
  doing(ctl, 'cage:wait')
  const tw = gameClock.now()
  let stage = null
  while (!ctl.aborted && towerUnsafe(bot) && gameClock.now() - tw < 60000) {
    await yieldTick()
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    const pest = hunters(bot, 4)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); continue }
    if (!stage) {
      const zs = cloudZones(bot)
      const toCx = CENTER.x - base.x; const toCz = CENTER.z - base.z; const L = Math.hypot(toCx, toCz) || 1
      const want = new Vec3(base.x + toCx / L * 9, base.y, base.z + toCz / L * 9)
      const sp = pickSpot(bot, base, { rMin: 7, rMax: 12, step: 1, edge: 4, prefer: want, avoid: f => nearPillar(bot, f, 3) || zs.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + 3 && Math.abs(f.y - z.y) < 4) })
      stage = sp ? sp.feet : base
    }
    if (Math.hypot(bot.entity.position.x - stage.x, bot.entity.position.z - stage.z) > 1.5) await walkTo(session, ctl, stage, { range: 1, timeoutMs: 8000 })
    else await sleep(250)
  }
  cage.waited = Math.round((gameClock.now() - tw) / 1000)
  if (towerUnsafe(bot)) return { ok: false, why: `ждал окна минуту: ${towerUnsafe(bot)}`, moved: true }
  // Пока ждали, могли уйти от облака далеко: столб строится только у клетки
  if (Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 1.2) {
    await walkTo(session, ctl, base, { range: 0.5, timeoutMs: 15000 })
  }
  await stepTo(bot, ctl, base, { ms: 1500, sprint: false, stopAt: 0.15 })
  if (Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 0.8 || Math.abs(bot.entity.position.y - gy) > 0.6) {
    return { ok: false, why: 'не встал на место столба', moved: true }
  }
  // На столбе бросать всё — только когда уже летит: фаербол упадёт рядом,
  const threat = () => {
    const bad = hazardNow(bot)
    if (bad) return bad.kind
    const d = dragonOf(bot)
    return d && phaseOf(bot, d) === PHASE.CHARGING ? 'таран' : null
  }
  // Ведро — в хотбар перед столбом (его выталкивает из хотбара любой equip из
  await waterToHotbar(bot)
  if (!bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды — на столб не лезу' }
  doing(ctl, 'cage:tower')
  {
    const pest = hunters(bot, 5)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); return { ok: false, why: 'эндермен у клетки', moved: true } }
  }
  const up = await fastTower(bot, ctl, topY, { abortIf: () => threat() || (hunters(bot, 4).length ? 'эндермен бьёт' : null) || (perchFar(bot) && phaseOf(bot, dragonOf(bot)) === PHASE.SCANNING ? 'сел — будет таран' : null) })
  cage.towerMs = up.ms
  const bailOut = async (why) => {
    cage.bailed = why
    const d = await dropOff(bot, ctl, stats, s, why)
    if (!d.ok) { const dn = await digDownTo(bot, ctl, gy, need + 6); cage.down = dn }
    else cage.drop = d
  }
  if (!up.ok) {
    if (Math.floor(bot.entity.position.y + 0.01) - gy >= 3) await bailOut(up.why || 'столб не дорос')
    return { ok: false, why: `столб не дорос: ${up.why}`, moved: true }
  }
  // копка впятеро медленнее (Player.getDestroySpeed: не на земле ÷5), а
  const tl = gameClock.now()
  while (!bot.entity.onGround && gameClock.now() - tl < 800) await sleep(50)
  doing(ctl, 'cage:bar')
  const barPos = new Vec3(cr.cx + 2 * s.x - s.z * off, cr.top + 3, cr.cz + 2 * s.z + s.x * off)
  const bar = bot.blockAt(barPos)
  if (bar && bar.name === 'iron_bars') {
    try {
      await items.equipBestTool(bot, bar)
      await build.withTimeout(bot.dig(bar, true), 6000)
    } catch (e) { dbg('bar', e.message) }
  }
  cage.hole = !bot.blockAt(barPos) || bot.blockAt(barPos).name !== 'iron_bars'
  const alive = () => !!bot.entities[cr.id] && bot.entities[cr.id].isValid !== false
  if (cage.hole && alive()) {
    doing(ctl, 'cage:shoot')
    // Путь стрелы (u — расстояние от центра кристалла к нам по оси s, у нас
    const lat = off ? { x: s.z * off, z: -s.x * off } : { x: -s.z, z: s.x }
    const uB = (bot.entity.position.x - (cr.cx + 0.5)) * s.x + (bot.entity.position.z - (cr.cz + 0.5)) * s.z
    const d1 = uB - 2.0625; const d2 = uB - 1.0625
    const h = bot.entity.position.y + EYE - 0.1 - (cr.top + 3)
    const slope = d1 > 0.3 && d2 > d1 && h > 0.2 ? (h / d1 + h / d2) / 2 : 0.41
    const eyeNow = () => bot.entity.position.offset(0, EYE, 0)
    const aimAt = () => eyeNow().offset(-s.x * 2 + lat.x * 0.26, -slope * 2, -s.z * 2 + lat.z * 0.26)
    cage.slope = r1(slope)
    for (let k = 0; k < 3 && alive() && !ctl.aborted; k++) {
      const why = threat()
      if (why) break
      const r = await pointBlank(bot, ctl, aimAt, () => !alive() || !!threat())
      if (!r.shot) { cage.refused = r.why; continue }
      stats.arrows++
      const tw2 = gameClock.now()
      while (alive() && gameClock.now() - tw2 < 1500) await sleep(50)
    }
  }
  const destroyed = !alive()
  if (destroyed) stats.crystals++
  cage.destroyed = destroyed
  // Вниз: шагом в сторону острова (ведро), без ведра — копать.
  doing(ctl, 'cage:down')
  if (Math.floor(bot.entity.position.y + 0.01) - gy >= 3) await bailOut(destroyed ? 'сбит' : (threat() || 'не сбит'))
  cage.secs = Math.round((gameClock.now() - t0) / 1000)
  if (ctl.trace) ctl.trace.ev('cage', cage)
  return destroyed ? { ok: true, destroyed: true } : { ok: false, why: cage.bailed && cage.bailed !== 'не сбит' ? `слез со столба: ${cage.bailed}` : (cage.refused || 'кристалл цел'), moved: !!cage.bailed }
}

async function destroyCrystals (session, ctl, rep, stats, { deadline = Infinity }: any = {}) {
  const bot = session.bot
  const tried = new Map()
  // Живой кристалл лечит дракона на 2 хп/с — бой без его сбития не выиграть
  // (d5-17, d5-22: 9 из 10, дракон 200 через 8 минут боя). Кругов — три.
  let reprieve = 3
  const note = t => { if (!rep.crystals.notes.includes(t)) rep.crystals.notes.push(t) }
  for (let round = 0; round < 60 && !ctl.aborted && gameClock.now() < deadline; round++) {
    await yieldTick()
    doing(ctl, 'crystals')
    // Сначала — не стоять в облаке. Прогон 2026-09-25: pathfinder дважды ответил
    for (let k = 0; k < 4 && !ctl.aborted; k++) {
      const bad = hazardNow(bot)
      if (!bad) break
      await evade(bot, ctl, stats, bad)
    }
    await waterToHotbar(bot)
    if (!overCloud(bot) && onSpike(bot)) { await getDown(session, ctl, stats); continue }
    if (bot.health < 14 && !overCloud(bot)) {
      await clearOfClouds(session, ctl, stats)
      const ate = await heal(session, ctl, rep, stats, { hard: true })
      if (!ate) await sleep(400)
      if (bot.health < 12) continue
    }
    {
      const pil = onOwnPillar(bot)
      if (pil) { doing(ctl, 'pillar:down'); if (ctl.trace) ctl.trace.ev('pillarDown', { n: pil.n, gy: pil.gy }); await digDownTo(bot, ctl, pil.gy, pil.n + 2); continue }
    }
    // Садится или сел и высматривает, а мы дальше STAY_R от фонтана — ближе, иначе
    if (await perchApproach(session, ctl, stats)) continue
    let list = crystalsOf(bot).filter(c => c.pillar)
    // Кристаллы видно только с 64 блоков: пока все обелиски не ближе, подойти
    // к центру, чтобы видеть все.
    const me = bot.entity.position
    const fromCenter = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
    if (!list.length) {
      if (fromCenter > 20) {
        const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 18 })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 40000 })
        list = crystalsOf(bot).filter(c => c.pillar)
      }
      if (!list.length) break
    }
    rep.crystals.seen = Math.max(rep.crystals.seen, list.length + stats.crystals)
    // Открытые — первыми (ближний), клетки — потом.
    list.sort((a, b) => (((a.bars > 0) as any) - ((b.bars > 0) as any)) || (a.pos.distanceTo(me) - b.pos.distanceTo(me)))
    let cr = list.find(c => (tried.get(c.id) || 0) < 4)
    // (EnderDragon.checkCrystals: +1 хп раз в 10 тиков) — прогоны repro2: 9 из 10,
    if (!cr && reprieve-- > 0) { tried.clear(); cr = list[0] }
    if (!cr) { rep.crystals.stuck = list.map(c => ({ x: c.cx, y: c.top + 1, z: c.cz, caged: c.bars > 0 })); break }
    tried.set(cr.id, (tried.get(cr.id) || 0) + 1)
    await guard(session, ctl)
    await tidy(session, ctl, rep, stats)
    if (cr.bars > 0) {
      // Столб у клетки — только с ведром: пустое — сперва набрать.
      if (!findItem(bot, /^water_bucket$/) && findItem(bot, /^bucket$/)) await refillBucket(session, ctl, stats)
      const o = await openCage(session, ctl, cr, rep, stats)
      if (!o.ok && o.moved) tried.set(cr.id, (tried.get(cr.id) || 1) - 0.5)
      if (!o.ok) note(`клетка ${cr.cx},${cr.top + 1},${cr.cz}: ${o.why}`)
      continue
    }
    const r = await shootCrystal(session, ctl, crystalsOf(bot).find(c => c.id === cr.id) || cr, rep, stats)
    // Ушёл от фаербола — это не попытка, а помеха: попытку не списывать.
    if (!r.ok && r.moved) tried.set(cr.id, (tried.get(cr.id) || 1) - 1)
    else if (!r.ok) note(`${cr.cx},${cr.top + 1},${cr.cz}: ${r.why}`)
  }
  rep.crystals.destroyed = stats.crystals
  rep.crystals.left = crystalsOf(bot).filter(c => c.pillar).length
}

async function heal (session, ctl, rep, stats, { hard = false }: any = {}) {
  const bot = session.bot
  // В облаке не есть — сперва выйти (oc5-20, 00:10: облако фаербола на месте, «лечение»
  // четыре раза подряд в нём, 19 → 0 хп): прочь от центра облака клавишами.
  const inC = inClouds(cloudsOf(bot), bot.entity.position, 1.0)
  if (inC) {
    const me = bot.entity.position
    const dx = me.x - inC.pos.x; const dz = me.z - inC.pos.z; const h = Math.hypot(dx, dz) || 1
    const tx = inC.pos.x + dx / h * (inC.r + 2.5); const tz = inC.pos.z + dz / h * (inC.r + 2.5)
    const ty = standY(bot, tx, tz, me.y, 2, 4)
    doing(ctl, 'heal:out-of-cloud')
    if (ty != null && !nearEdge(bot, new Vec3(tx, ty, tz), 2)) await stepTo(bot, ctl, new Vec3(tx, ty, tz), { ms: 1500, stopAt: 0.5, clouds: false })
    else await clearOfClouds(session, ctl, stats, 2)
    if (inClouds(cloudsOf(bot), bot.entity.position, 0.3)) return false
  }
  if (fbAlarm(bot)) return false
  const was = ctl.doing
  doing(ctl, 'heal')
  const iv = gameClock.setInterval(() => {
    const c = inClouds(cloudsOf(bot), bot.entity.position, 0.2)
    if (c && cloudAgeMs(c) > 300) { try { bot.deactivateItem() } catch {} }
  }, 100)
  try { return await healRaw(session, ctl, rep, stats, { hard }) } finally { gameClock.clearInterval(iv); doing(ctl, was) }
}

async function clearOfClouds (session, ctl, stats, margin = 4) {
  const bot = session.bot
  // Не в падении: уход клавишами в воздухе уносил тело от своей воды (v13-26, 30.09,
  // 439 с: ведро поставлено, «прочь от облаков» сдвинуло на 5 блоков — падение 17, смерть).
  if (!bot.entity.onGround || bot.entity.isInWater) return false
  const me = bot.entity.position
  const zs = cloudZones(bot)
  const near = zs.some(z => Math.hypot(me.x - z.x, me.z - z.z) < z.r + margin && Math.abs(me.y - z.y) < 4)
  if (!near) return false
  const far = f => zs.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + margin + 1 && Math.abs(f.y - z.y) < 4)
  const spot = pickSpot(bot, me, { rMin: 5, rMax: 17, step: 2, edge: 3, avoid: f => far(f) || nearPillar(bot, f, 2) })
  if (!spot) return false
  const was = ctl.doing
  doing(ctl, 'retreat')
  if (ctl.trace) ctl.trace.ev('retreat', { to: [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)], hp: r1(bot.health) })
  try { await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 8000 }) } finally { doing(ctl, was) }
  return true
}

async function hideAndHeal (session, ctl, rep, stats, { until = 16, maxMs = 60000 }: any = {}) {
  const bot = session.bot
  // Сперва приземлиться (ведро в падении делает своё): путь в воздухе уносит от воды.
  { const tg = gameClock.now(); while (!ctl.aborted && !bot.entity.onGround && !bot.entity.isInWater && gameClock.now() - tg < 3000) await sleep(50) }
  // Бьёт эндермен — в яму от него не уйти (он лезет следом и бьёт в яме:
  // d4-4, 30.09, 203–206 с — три удара в яме, смерть). Сперва отбиться.
  const pest = hunters(bot, 5).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (pest) await fightEnderman(session, ctl, stats, pest, null)
  // 02.10 (rs16-s10, смерть): 6.7 хп, еды 17 (регенерации нет), бот 8 с шёл/копал яму и не ел — второй фаербол в яму, два удара
  // облака. Сперва поесть (золотое яблоко при ≤ 10), если опасности нет прямо сейчас.
  if (bot.health <= 10 && !hazardNow(bot)) await heal(session, ctl, rep, stats, { hard: true }).catch(() => {})
  doing(ctl, 'hide')
  // Сидит — место отдыха не в коридоре взлёта (c2-27, 30.09, 425–437 с: «прятался»
  // в 13.7 блока прямо перед мордой, после четвёртого огня взлёт — три удара).
  const dS = dragonOf(bot)
  const boxesS = dS && SITTING.has(phaseOf(bot, dS)) ? takeoffBoxes(dS.position, dS.yaw) : null
  // И не дальше STAY_R от сидящего видящего (или пока не ясно): иначе таран.
  const nearS = !!boxesS && !blindKnown(sitRec)
  const zsH = cloudZones(bot)
  const spot = pickSpot(bot, CENTER, { rMin: nearS ? 10 : 16, rMax: nearS ? 15 : 30, edge: nearS ? 3 : 5, avoid: f => nearPillar(bot, f) || (!!boxesS && boxesS.some(b => overlap(playerBox(f), inflate(b, 1.5)))) || (nearS && f.distanceTo(dS.position) > STAY_R) || zsH.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + 4 && Math.abs(f.y - z.y) < 4) })
  if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 20000 })
  const pick = findItem(bot, /_pickaxe$/)
  const hole: any = { dug: 0 }
  if (pick) {
    for (let i = 0; i < 4 && !ctl.aborted; i++) {
      // фаербол летит сюда / облако рядом — яму бросить, уйти (ниже цикл отдыха уводит от опасности)
      if (hazardNow(bot) || fbAlarm(bot)) { hole.abort = 'опасность'; break }
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !isSolid(under) || /bedrock|obsidian/.test(under.name)) break
      const lower = new Vec3(bot.entity.position.x, Math.floor(bot.entity.position.y + 0.01) - 1, bot.entity.position.z)
      if (cloudsOf(bot).some(c => cloudHits(c, lower, 0.6) || cloudHits(c, lower.offset(0, -1, 0), 0.6))) break
      if (voidBelow(bot, bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z, 6)) break
      try {
        await items.equipBestTool(bot, under)
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        await build.withTimeout(bot.dig(under, true), 6000)
        hole.dug++
        const t0 = gameClock.now()
        while (!bot.entity.onGround && gameClock.now() - t0 < 1500) await sleep(50)
      } catch { break }
    }
    const lid = bot.entity.position.floored().offset(0, 2, 0)
    const l = await build.placeBlockAt(bot, lid, { timeoutMs: 3000 })
    hole.lid = !!l.ok
  }
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && bot.health < until) {
    // Отдых — не глухой: облако, фаербол, коридор взлёта сидящего — уйти.
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    // Злой эндермен вернулся (отбились не до конца, телепортировался и снова бьёт)
    const pest = hunters(bot, 4)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); continue }
    await heal(session, ctl, rep, stats, { hard: bot.health < 8 })
    await sleep(300)
  }
  // Наверх: убрать крышку, столбом до поверхности.
  if (hole.dug) {
    const lid = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))
    if (lid && isSolid(lid)) { try { await items.equipBestTool(bot, lid); await build.withTimeout(bot.dig(lid, true), 5000) } catch {} }
    await build.towerUp(bot, ctl, hole.dug)
  }
  hole.hp = Math.round(bot.health)
  hole.seconds = Math.round((gameClock.now() - t0) / 1000)
  stats.hid.push(hole)
}

let sitRec = null

let sightMe = null

function sightKey (dId) { return dId + ':' + sightMe }

function sitState (d, ph, now) {
  if (d && SITTING.has(ph)) {
    if (!sitRec || sitRec.id !== d.id || sitRec.ended) {
      const known = sight.get(sightKey(d.id))
      sitRec = { id: d.id, t0: now, roared: known === 'seeing', blind: known === 'blind', flames: 0, lastPh: null }
    }
    if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { sitRec.roared = true; sitRec.blind = false; sight.set(sightKey(d.id), 'seeing') }
    if (ph === PHASE.FLAMING && sitRec.lastPh !== PHASE.FLAMING) { sitRec.flames++; sitRec.flameAt = now }
    sitRec.lastPh = ph
    sitRec.pos = d.position.clone(); sitRec.yaw = d.yaw
    return sitRec
  }
  if (sitRec && !sitRec.ended) sitRec.ended = now
  return null
}

function blindKnown (rec, now = gameClock.now()) {
  if (!rec || rec.roared) return false
  if (rec.blind) return true
  const b = !!rec.nearAt && now - rec.nearAt > 450
  if (b && rec.id != null) { rec.blind = true; sight.set(sightKey(rec.id), 'blind') }
  return b
}

let sitAcc = { id: null, dmg: 0, hp: null, sitting: false }

function noteSitDamage (bot, d, ph) {
  const hp = hpOf(bot, d)
  if (sitAcc.id !== d.id) sitAcc = { id: d.id, dmg: 0, hp, sitting: SITTING.has(ph) }
  if (hp != null && sitAcc.hp != null && hp < sitAcc.hp - 0.01 && (sitAcc.sitting || SITTING.has(ph))) {
    sitAcc.dmg += sitAcc.hp - hp
    if (sitAcc.dmg > 50) sitAcc.dmg = 0
  }
  if (hp != null) sitAcc.hp = hp
  sitAcc.sitting = SITTING.has(ph)
}

function takeoffOnHit () { return sitAcc.dmg + 9.5 > 50 }

function hazardNow (bot, extra: any = {}) {
  const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 60), parts: extra.parts || null, breath: extra.breath || null }
  Object.assign(ctx, dragonZones(bot))
  const bad = dangerAt(bot, bot.entity.position, ctx)
  return bad ? { ...bad, ctx } : null
}

function dragonZones (bot, now = gameClock.now()) {
  if (bot.entity) sightMe = bot.entity.id
  const d = dragonOf(bot)
  if (!d) { sitState(null, null, now); return {} }
  const ph = phaseOf(bot, d)
  const v = dragonVel(d, now)
  const rec = sitState(d, ph, now)
  if (rec) noteNear(rec, d, bot, now)
  noteSitDamage(bot, d, ph)
  const ch = chargeOf(bot, d, ph)
  if (ch) return { charge: ch }
  const out: any = {}
  const me = bot.entity.position
  const near = Math.hypot(d.position.x - me.x, d.position.z - me.z) < 40
  // Крылья на посадке, взлёте и в низком полёте: коробки сейчас и через 3, 6,
  // 9 тиков по скорости (на взлёте — до блока за тик).
  if (near && !SITTING.has(ph) && (ph === PHASE.LANDING || ph === PHASE.TAKEOFF || d.position.y - me.y < 10)) {
    out.wings = []
    for (const k of [0, 3, 6, 9]) out.wings.push(...wingBoxes(new Vec3(d.position.x + v.x * k, d.position.y + v.y * k, d.position.z + v.z * k), d.yaw, 0.6))
    out.wingKind = ph === PHASE.TAKEOFF ? 'взлёт' : 'крыло'
    out.wingAway = d.position.clone()
    if (ph === PHASE.TAKEOFF) {
      const n = Math.hypot(v.x, v.z)
      out.wingAxis = { p: d.position.clone(), dir: n > 0.05 ? { x: v.x / n, z: v.z / n } : { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
      // Начало взлёта (скорость ещё мала): коробки по скорости стоят на месте, и
      if (n < 0.5) out.wings.push(...takeoffBoxes(d.position, n > 0.05 ? Math.atan2(v.x, v.z) : d.yaw, 16))
    }
  }
  // Сидит, а взлёт скоро (слепой — 100 тиков): коридор взлёта вперёд по взгляду.
  if (rec && near && takeoffSoon(rec, now)) {
    out.wings = takeoffBoxes(d.position, d.yaw)
    out.wingKind = 'взлёт скоро'
    out.wingAxis = { p: d.position.clone(), dir: { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
  }
  if (ph === PHASE.LANDING) {
    const P = podiumTop(bot)
    if (P != null && d.position.y < P + 12) out.landing = { c: new Vec3(CENTER.x, P, CENTER.z), r: 14.5, yMin: P - 2.2 }
  }
  if (!SITTING.has(ph) && ph !== PHASE.LANDING) return out
  const parts = partsOf(bot, d, null)
  out.parts = parts
  // Дуга головы — пока видящий доворачивает к нам (высматривая, первые 25
  // тиков); слепой (высматривает дольше 1.6 с без рёва) не поворачивается.
  if (ph === PHASE.SCANNING && !blindKnown(rec, now)) out.sweep = { pos: d.position, dir: parts.dir }
  return out
}

let zonesCache = { t: 0, z: {} }

// Тиков после прохода головы по прогнозу до щелчка: +1 на 20 тиках (an-pilltiming, 81 из 90), 0 на ускоренных (s5 06.10).
function clickLead (rate = gameClock.snapshot()?.tickRate ?? 20) { return envNum('ND_CLICK_LEAD', rate > 100 ? 0 : 1) }

function dragonStepCost (bot, pos) {
  if (gameClock.now() - zonesCache.t > 250) zonesCache = { t: gameClock.now(), z: dragonZones(bot) }
  const z: any = zonesCache.z
  if (z.charge) return inCharge(z.charge, new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)) ? 200 : 0
  if (!z.parts && !z.wings && !z.landing) return 0
  const feet = new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)
  if (dangerAt(bot, feet, { clouds: [], fireballs: [], parts: z.parts, sweep: z.sweep, wings: z.wings, landing: z.landing })) return 200
  if (z.parts && overlap(playerBox(feet), inflate(z.parts.body, 1))) return 200
  return 0
}

async function fightEnderman (session, ctl, stats, e, stop) {
  const bot = session.bot
  doing(ctl, 'enderman')
  stats.endermen++
  const id = e.id
  const t0 = gameClock.now()
  let ready = gameClock.now() + 100
  let swings = 0
  let killed = false
  if (ctl.trace) ctl.trace.ev('endermanFight', { id, dist: +e.position.distanceTo(bot.entity.position).toFixed(1), hp: bot.health })
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 15000) {
      await yieldTick()
      if (stop && stop()) break
      const en = bot.entities[id]
      if (!en || en.isValid === false || !en.position) { killed = true; break }
      const me = bot.entity.position
      if (en.position.distanceTo(me) > 10) break
      // Облако и фаербол — прежде эндермена: 6 магией раз в секунду хуже его 3.8.
      const bad = hazardNow(bot)
      if (bad) { clearControls(bot); await evade(bot, ctl, stats, bad); continue }
      // Мало хп — яблоко (1.6 с под ударами, но поглощение 4 и регенерация II).
      if (bot.health <= 9 && !hasEffect(bot, 'absorption') && findItem(bot, /golden_apple$/)) {
        clearControls(bot)
        await heal(session, ctl, null, stats, { hard: true })
        ready = gameClock.now() + 100
        continue
      }
      const w = items.bestWeapon(bot)
      if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) {
        await bot.equip(w, 'hand').catch(() => {})
        ready = gameClock.now() + pvp.cooldownMs(w)
        continue
      }
      const box = { min: en.position.offset(-0.3, 0, -0.3), max: en.position.offset(0.3, 2.9, 0.3) }
      const reach = boxDist(me.offset(0, EYE, 0), box)
      // Смотреть в туловище, не в глаза: он и так зол, а сторож взгляда
      // опускает голову от любых глаз эндермена в конусе.
      await bot.lookAt(en.position.offset(0, 1.3, 0), true).catch(() => {})
      // Обрыв впереди — как у stepTo: шаг и прыжок за крит несут тело на 1–2 блока.
      const cliff = runwayAhead(bot, me, -Math.sin(bot.entity.yaw), -Math.cos(bot.entity.yaw), 2.4)
      // И не в облако за эндерменом (общая проверка пути).
      const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
      const intoCloud = !!stepIntoZone(cloudZones(bot), me, new Vec3(me.x + fx, me.y, me.z + fz))
      const safeStep = (cliff == null || cliff > 1.2) && !intoCloud
      bot.setControlState('forward', reach > 2.6 && safeStep)
      const now = gameClock.now()
      bot.setControlState('jump', now >= ready - 300 && bot.entity.onGround && reach < 3.8 && cliff == null)
      const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.04
      if (now >= ready && reach <= 2.95 && (falling || now >= ready + 450)) {
        bot.attack(en)
        swings++
        ready = now + pvp.cooldownMs(bot.heldItem)
      }
      await sleep(50)
    }
  } finally {
    clearControls(bot)
    if (killed) stats.endermenKilled = (stats.endermenKilled || 0) + 1
    if (ctl.trace) ctl.trace.ev('endermanDone', { id, killed, swings, secs: Math.round((gameClock.now() - t0) / 100) / 10, hp: bot.health })
    dbg('enderman', JSON.stringify({ killed, swings }))
  }
}

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

let lastDragonHit = 0

// Серверные тики пакетов дракона (750 TPS, s5 06.10). Отметка t — игровые мс клиента в миг разбора: на 750 тиках/с пакеты
// приходят пачками (половина промежутков 0, остальные 50…1000 при настоящих 150), и прогноз снижения брал число тиков
// между пакетами и миг прохода головы из этих отметок — щелчок кровати −4…+2 тика (DragonLab, s5-c1). Тиков между
// пакетами — по пути (смещение / скорость за тик), миг — по пакету, разобранному без задержки (меньшее t − tick·50
// за последние 15 пакетов, ~45 тиков: ошибка числа тиков не копится): tt — отметка без задержки разбора.
function feedTicks (list, r) {
  const prev = list[list.length - 1]
  // фактический темп сервера (s5-c3: по заказанным 750 при настоящих ~700 якорь за 45 тиков уезжал на 4–6 тиков раньше)
  const sn = gameClock.snapshot()
  const tickMs = 1000 / (sn?.effectiveRate || sn?.tickRate || 20)
  if (!prev || prev.id !== r.id || prev.tick == null) { r.tick = 0; r.n = null; r.tt = r.t; r.ttMono = r.mono; return }
  const byStamp = Math.max(1, Math.round((r.t - prev.t) / 50))
  const vs = [prev, r].filter(q => q.vx != null).map(q => Math.hypot(q.vx, q.vy, q.vz))
  const sp = vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : 0
  const d = Math.hypot(r.x - prev.x, r.y - prev.y, r.z - prev.z)
  r.n = sp > 0.2 && d > 0.05 ? Math.max(1, Math.min(6, Math.round(d / sp))) : byStamp
  r.tick = prev.tick + r.n
  let off = r.t - r.tick * 50
  let offMono = r.mono != null ? r.mono - r.tick * tickMs : null
  for (let i = list.length - 1, k = 0; i >= 0 && k < 15 && list[i].id === r.id && list[i].tick != null; i--, k++) {
    off = Math.min(off, list[i].t - list[i].tick * 50)
    if (offMono != null && list[i].mono != null && k < 5) offMono = Math.min(offMono, list[i].mono - list[i].tick * tickMs)
  }
  // на 20 тиках отметки разбора точны (50 мс на тик), и +1 тик clickLead выверен по ним (an-pilltiming); якорь — только
  // на ускоренных (s5-e22: якорь на 20 сдвигал щелчок на 1–2 тика раньше, урон p50 45 вместо 52)
  r.tt = (sn?.effectiveRate || sn?.tickRate || 20) > 100 ? r.tick * 50 + off : r.t
  // то же в монотонных мс реального времени: часы клиента на 750 скачут (догоняют сервер рывком, стоят впереди него),
  // щелчок по ним уходит раньше/позже на тики — миг щелчка считать по ровным часам (clickBedAt untilMono)
  r.ttMono = offMono != null ? r.tick * tickMs + offMono : null
}

function makeDragonFeed (bot) {
  const onHit = pk => {
    if (!pk || !bot.entity || pk.entityId !== bot.entity.id) return
    const src = bot.entities[pk.sourceCauseId - 1]
    if (DAMAGE_TYPES[pk.sourceTypeId] === 'mob_attack' && src && src.name === 'ender_dragon') lastDragonHit = gameClock.now()
  }
  bot._client.on('damage_event', onHit)
  const list = []
  let vel = null
  // Снижение — прогноз посадки (по двум последним пакетам со скоростью).
  const refresh = id => {
    const r = list[list.length - 1]
    if (!r || r.id !== id || r.ph !== PHASE.LANDING || r.vx == null) return
    try { const f = landingForecast(feed, podiumTop(bot)); if (f) feed.fc = { ...f, id } } catch (err) { dbg('forecast', err.message) }
  }
  const onVel = buf => {
    try {
      let off = 0; let id
      ;[, off] = readVarIntAt(buf, off)
      ;[id, off] = readVarIntAt(buf, off)
      const e = bot.entities[id]
      if (!e || e.name !== 'ender_dragon') return
      vel = { t: gameClock.now(), id, ...lpVec3At(buf, off) }
      const last = list[list.length - 1]
      if (last && last.id === id && vel.t - last.t < 25 && last.vx == null) { last.vx = vel.x; last.vy = vel.y; last.vz = vel.z; refresh(id) }
    } catch {}
  }
  const onMoved = e => {
    if (!e || e.name !== 'ender_dragon') return
    const t = gameClock.now()
    const last = list[list.length - 1]
    const p = e.position
    if (last && last.id === e.id && t - last.t < 25 && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.z - p.z) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) { last.yRot = yRotOf(e.yaw); return }
    const r: any = { t, wallMs: gameClock.wall.now(), mono: gameClock.wall.monotonic(), id: e.id, x: p.x, y: p.y, z: p.z, yRot: yRotOf(e.yaw), ph: phaseOf(bot, e), vx: null, vy: null, vz: null }
    if (vel && vel.id === e.id && t - vel.t < 25) { r.vx = vel.x; r.vy = vel.y; r.vz = vel.z }
    feedTicks(list, r)
    list.push(r)
    if (list.length > 40) list.shift()
    refresh(e.id)
  }
  // Сел (метаданные фазы; сидящий не двигается — пакетов движения нет): угол головы
  // по последнему прогнозу — yRotA заморожен.
  const onUpd = e => {
    if (!e || e.name !== 'ender_dragon') return
    const ph = phaseOf(bot, e)
    const last = list[list.length - 1]
    if (last && last.id === e.id && gameClock.now() - last.t < 25) last.ph = ph
    const f = feed.fc
    if (!SITTING.has(ph) || !f || f.id !== e.id || gameClock.now() - f.t > 700 || feed.fixed === f.t) return
    feed.fixed = f.t
    sitFix.set(e.id, { yRotA: f.yRotA, yaw: e.yaw, t: gameClock.now(), head: f.head, sit: simClone(f.sit), pos: e.position.clone(), pushes: [], me: bot.entity && bot.entity.position.clone() })
    if (feed.onSit) feed.onSit({ pred: [r3(f.sit.x), r3(f.sit.y), r3(f.sit.z), r1(f.sit.yRot)], act: [r3(e.position.x), r3(e.position.y), r3(e.position.z), r1(yRotOf(e.yaw))], yRotA: r1(f.yRotA), n: f.n, late: gameClock.now() - f.t, head: [r1(f.head.x), r1(f.head.y), r1(f.head.z)] })
  }
  const feed = { list, fc: null, fixed: null, onSit: null, close () { bot._client.removeListener('raw.entity_velocity', onVel); bot.removeListener('entityMoved', onMoved); bot.removeListener('entityUpdate', onUpd); bot._client.removeListener('damage_event', onHit) } }
  bot._client.on('raw.entity_velocity', onVel)
  bot.on('entityMoved', onMoved)
  bot.on('entityUpdate', onUpd)
  return feed
}

async function ocLanding (session, ctl, rep, stats, track, feed, { blindLid = false }: any = {}) {
  const bot = session.bot
  const P = podiumTop(bot)
  const fc = landingForecast(feed, P)
  if (!fc || fc.n < 40 || fc.n > 190) { if (ctl.trace) ctl.trace.ev('ocL', { why: fc ? `n ${fc.n}` : 'нет прогноза', blindLid: blindLid || undefined }); return false }
  // Режим «видящий» (ND_SEE=1): на первой посадке L нет — окоп спрятал бы нас от первого
  // «высматривает», и дракон остался бы слепым навсегда (Sensing не чистится).
  if (process.env.ND_SEE === '1' && !blindLid) {
    const dd0 = dragonOf(bot)
    if (dd0 && !sight.get(dd0.id + ':' + bot.entity.id)) { if (ctl.trace) ctl.trace.ev('ocL', { why: 'видящий: первая посадка без L', n: fc.n }); return false }
  }
  const anchorsOk = process.env.ND_OC_ANCHOR !== '0' && !blindLid && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  if ((countOf(bot, /_bed$/) < 2 && !anchorsOk) || countOf(bot, FILLER_RE) < 3) return false
  const d = dragonOf(bot)
  if (!d) return false
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  stats.oc = stats.oc || { tries: 0, built: 0, booms: 0, why: {} }
  const no = w => { stats.oc.why[w] = (stats.oc.why[w] || 0) + 1; ev('ocL', { why: w, n: fc.n }); return false }
  stats.oc.tries++
  const tPlan0 = gameClock.now()
  const tgt = (fc.path[fc.n - 3] || fc.path[fc.path.length - 1]).head
  let plan = null
  const whyAll = {}
  const cands = []
  // Кровать на блок или два выше земли (на два — центр взрыва у самой головы; кровать не
  // должна попасть в коробки головы/шеи на пути снижения — проверка в tsPlan: oc3-22).
  for (const lift of [2, 1]) {
    if (countOf(bot, /_bed$/) < 1) break
    const p2 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), lid: blindLid })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) whyAll[k] = (whyAll[k] || 0) + v
    cands.push(...(tsPlan.all || []))
    if (p2 && (!plan || p2.cost < plan.cost)) plan = p2
  }
  // Якорь возрождения (есть в рюкзаке): прямо на путь головы — взрыв ближе (до ~0.5 от низа головы).
  if (anchorsOk) {
    let pa = null
    for (const lift of [3, 2, 1]) {
      const p3 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), anchor: true })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) whyAll['я:' + k] = (whyAll['я:' + k] || 0) + v
      if (p3 && (!pa || p3.cost < pa.cost)) pa = p3
    }
    if (pa && (!plan || pa.expect > plan.expect + 3)) plan = pa
  }
  tsPlan.why = whyAll
  if (!plan) { ev('ocNoPlan', { no: tsPlan.why }); return no('нет станции у головы') }
  // Вторая кровать снижения (L0) с другой стороны того же окопа — за ≥ 10 тиков до L.
  let refHead = fc.head
  if (process.env.ND_OC_L0 === '1' && !blindLid && fc.n >= 60) {
    const dpos = new Vec3(fc.sit.x, fc.sit.y, fc.sit.z)
    const P = podiumTop(bot)
    const seenKeys = new Set()
    const top = cands.sort((p, q) => p.cost - q.cost).filter(c => { const k = `${c.B.x},${c.B.z}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true }).slice(0, 3)
    let bestPair = null; const why0 = {}
    const note = k => { why0[k] = (why0[k] || 0) + 1 }
    for (const c of top) {
      const sides = DIRS4.filter(d2 => !(d2.x === c.u.x && d2.z === c.u.z))
      const s2 = tsSecond(bot, c, fc, { dpos, sides })
      for (const [k, v] of (Object.entries(tsSecond.why || {}) as [string, any][])) why0[k] = (why0[k] || 0) + v
      if (!s2) continue
      const fc2 = pushedForecast(fc, s2.i0, s2.centre, s2.seen || 1, P)
      if (!fc2) { note('толчок: нет посадки'); continue }
      if ((fc2.n - 2) - (s2.i0 + 1) < 10) { note('толчок: L раньше 10 тиков'); continue }
      const tgt2 = (fc2.path[fc2.n - 3] || fc2.path[fc2.path.length - 1]).head
      const avoid = new Set([s2.F, s2.W, s2.V, s2.PS, s2.H].map(q => `${q.x},${q.z}`))
      const extra = new Map()
      for (const y of s2.sCells) extra.set(`${s2.F.x},${y},${s2.F.z}`, 'block')
      for (const y of s2.wCells) extra.set(`${s2.W.x},${y},${s2.W.z}`, 'block')
      let L2 = null
      for (const lift of [2, 1]) {
        const q = tsPlan(bot, tgt2, { lift, fc: fc2, dpos: new Vec3(fc2.sit.x, fc2.sit.y, fc2.sit.z), fixedB: c.B, avoid, extra })
        if (q && (!L2 || q.cost < L2.cost)) L2 = q
      }
      if (!L2) { note('L после толчка: нет станции у того же окопа'); continue }
      // L переживает взрыв L0; бок L0 виден из окопа в мире со станцией L2
      const exW = new Map(L2.world); exW.set(`${L2.F.x},${L2.yb},${L2.F.z}`, 'bed'); exW.set(`${L2.H.x},${L2.yb},${L2.H.z}`, 'bed')
      if (blastReaches(virtualBot(bot, exW), bot, s2.centre, [{ x: L2.F.x, y: L2.yb, z: L2.F.z }, { x: L2.H.x, y: L2.yb, z: L2.H.z }])) { note('L0 снесёт кровать L'); continue }
      const ex0 = new Map(exW); ex0.set(`${s2.F.x},${s2.yb},${s2.F.z}`, 'bed'); ex0.set(`${s2.H.x},${s2.yb},${s2.H.z}`, 'bed')
      if (!tsClickPoint(virtualBot(bot, ex0), L2.trench.offset(0, EYE, 0), s2)) { note('бок L0 закрыт станцией L'); continue }
      if (exposure(virtualBot(bot, L2.world), L2.trench, s2.centre) > 0.02) { note('взрыв L0 видит окоп'); continue }
      const sum = s2.expect + L2.expect
      if (!bestPair || sum > bestPair.sum) bestPair = { L2, s2, fc2, sum }
    }
    ev('ocPlan0', bestPair ? { i0: bestPair.s2.i0, n: fc.n, n2: bestPair.fc2.n, H0: [bestPair.s2.H.x, bestPair.s2.yb, bestPair.s2.H.z], L0: bestPair.s2.expect, H: [bestPair.L2.H.x, bestPair.L2.yb, bestPair.L2.H.z], L: bestPair.L2.expect, alone: plan.expect, push: [r1(bestPair.fc2.pushed.x * 100) / 100, r1(bestPair.fc2.pushed.y * 100) / 100, r1(bestPair.fc2.pushed.z * 100) / 100] } : { no: why0, tried: top.length })
    if (bestPair && bestPair.sum > plan.expect + 25) {
      plan = bestPair.L2; plan.second = bestPair.s2; plan.gapTicks = (bestPair.fc2.n - 2) - (bestPair.s2.i0 + 1); plan.nPlan = fc.n
      refHead = bestPair.fc2.head
    }
  }
  // Взлёт слепого (сам, на 99-м тике после посадки — без толчка B): голова первые ~15 тиков
  let tk = null
  if (process.env.ND_OC_TK === '1' && !blindLid && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    const why1 = {}
    const n1 = k => { why1[k] = (why1[k] || 0) + 1 }
    const fcL = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (!fcL) n1('посадка после L не считается')
    else if (hurtNear(playerBox(plan.ground), predParts(fcL)) || hurtNear(playerBox(new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)), predParts(fcL))) n1('станция L у шеи сидящего (T1 заново не поставить)')
    else {
      const A = bedsLayout(bot, d, predParts(fcL), { headAt: fcL.head, noTurn: true, brave: true, cap: 46 })
      const S = simClone(fcL.sit)
      if (A) { const pu = blastPush(S, A.centre, A.seen != null ? A.seen : 1); S.vx += pu.x; S.vy += pu.y; S.vz += pu.z }
      S.hist = new Array(12).fill(S.y)
      const nodes = dragonNodes(bot)
      const node = nodes && takeoffNode(nodes, S)
      if (!node) n1('узел взлёта не найден')
      else {
        const path = takeoffForecast(S, node, 30)
        const t1 = path[1]
        const t1exp = bedDamage(t1.head.distanceTo(plan.centre), plan.seen || 1)
        const sides = DIRS4.filter(q => !(q.x === plan.u.x && q.z === plan.u.z))
        const T2 = tsSecond(bot, plan, { n: 99, path }, { dpos: new Vec3(S.x, S.y, S.z), sides, imin: 11, imax: 18, primaryFirst: true })
        if (!T2) Object.assign(why1, tsSecond.why || {})
        else {
          // Клетки станции T2 (кровать, опора, заслон) не на пути снижения (checkWalls снесёт) и
          // переживут взрыв A (A — сидя, до T1/T2).
          const cells = [{ x: T2.F.x, y: T2.yb, z: T2.F.z }, { x: T2.H.x, y: T2.yb, z: T2.H.z }, ...T2.sCells.map(y => ({ x: T2.F.x, y, z: T2.F.z })), ...T2.wCells.map(y => ({ x: T2.W.x, y, z: T2.W.z }))]
          let onPath = false
          for (const st of fc.path) {
            const boxes = [inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.2), inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.2), inflate(box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3), 0.2)]
            if (cells.some(c => boxes.some(b => overlap(b, { min: new Vec3(c.x, c.y, c.z), max: new Vec3(c.x + 1, c.y + 1, c.z + 1) })))) { onPath = true; break }
          }
          const ex = new Map(plan.world)
          for (const y of T2.sCells) ex.set(`${T2.F.x},${y},${T2.F.z}`, 'block')
          for (const y of T2.wCells) ex.set(`${T2.W.x},${y},${T2.W.z}`, 'block')
          ex.set(`${T2.F.x},${T2.yb},${T2.F.z}`, 'bed'); ex.set(`${T2.H.x},${T2.yb},${T2.H.z}`, 'bed')
          if (onPath) n1('станция T2 на пути снижения')
          else if (A && blastReaches(virtualBot(bot, ex), bot, A.centre, cells)) n1('взрыв A заденет станцию T2')
          else tk = { A, T2, path, node, t1exp, sum: t1exp + T2.expect, S }
        }
      }
    }
    ev('ocTk', tk ? { node: [tk.node.x, tk.node.z], A: tk.A ? tk.A.expect : null, T1: tk.t1exp, T2: tk.T2.expect, i2: tk.T2.i0, H2: [tk.T2.H.x, tk.T2.yb, tk.T2.H.z] } : { no: why1 })
    if (tk && tk.sum < 70) tk = null
    if (tk) { plan.second = tk.T2 }
  }  // Кровать A заранее в СВОЁМ окопе у головы сидящего (слепой: голова сидящего не поворачивается):
  // после L — к окопу A, щелчок через ≥ 10 тиков после L, в сидячий счёт (≤ cap). Темп спидраннеров:
  let fcA = null
  let ownA = null
  let ownB = null
  if (process.env.ND_OC_A === '1' && !blindLid && !plan.second && fc.n >= 120 && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    fcA = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (fcA) {
      const acc = sitAcc.id === d.id ? sitAcc.dmg : 0
      const cap = acc < 25 ? 49 - acc : null
      const tA = gameClock.now()
      ownA = tsOwnPlan(bot, plan, fcA, { cap, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z) })
      ev('ocA', ownA ? { ms: gameClock.now() - tA, H: [ownA.H.x, ownA.yb, ownA.H.z], B: [ownA.B.x, ownA.G, ownA.B.z], depth: ownA.depth, expect: ownA.expect, dist: r1(ownA.centre.distanceTo(fcA.head)), seen: ownA.seen, cap, acc: r1(acc) } : { ms: gameClock.now() - tA, no: tsOwnPlan.why, cap, acc: r1(acc) })
      // B — тоже свой окоп у головы сидящего, без потолка (её взрыв поднимет на взлёт); цела после
      // взрывов L и A, её окоп не в их воронках.
      if (ownA && process.env.ND_OC_B !== '0') {
        const tB = gameClock.now()
        const world = stationWorld(ownA, stationWorld(plan, plan.world))
        ownB = tsOwnStation(bot, fcA.head, { fc: { ...fcA, n: fcA.n + 3 }, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z), world, priors: [plan, ownA], avoid: [plan, ownA], sitP: predParts(fcA) })
        if (ownB) ownB.role = 'B'
        ev('ocB', ownB ? { ms: gameClock.now() - tB, H: [ownB.H.x, ownB.yb, ownB.H.z], B: [ownB.B.x, ownB.G, ownB.B.z], depth: ownB.depth, expect: ownB.expect, dist: r1(ownB.centre.distanceTo(fcA.head)), seen: ownB.seen } : { ms: gameClock.now() - tB, no: tsOwnStation.why })
      }
    } else ev('ocA', { no: { 'посадка после L не считается': 1 } })
  }

  ev('ocPlan', { ms: gameClock.now() - tPlan0, anchor: plan.anchor || undefined, n: fc.n, head: [r1(tgt.x), r1(tgt.y), r1(tgt.z)], sitHead: [r1(fc.head.x), r1(fc.head.y), r1(fc.head.z)], yRotA: r1(fc.yRotA), H: [plan.H.x, plan.yb, plan.H.z], lift: plan.lift, depth: plan.depth, dist: plan.dist, seen: plan.seen, expect: plan.expect, u: [plan.u.x, plan.u.z], a: [plan.a.x, plan.a.z], no: whyAll })
  doing(ctl, 'oc:build')
  // Опасно стоять там, где мы сейчас: коробки снижающегося по свежему прогнозу на ~1.5 с вперёд.
  const danger = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph !== PHASE.LANDING) return `фаза ${PHASE_RU[ph] ?? ph}`
    const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc
    if (f.n - Math.round((gameClock.now() - f.t) / 50) < 8) return 'не успеть до посадки'
    const soon = { ...f, path: f.path.slice(0, 30) }
    const h = landingHits(soon, bot.entity.position, 0.5)
    return h ? `${h.what} через ${h.k} тиков` : null
  }
  ctl.holdStation = true
  let b
  const leftTicks = () => { const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc; return f.n - Math.round((gameClock.now() - f.t) / 50) }
  try {
    if (!ownA) b = await tsBuild(session, ctl, stats, plan, danger, leftTicks)
    else {
      b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { skipTrench: true })
      if (b.ok) {
        // A — пока до посадки ≥ 70 тиков; бросить, если меньше 45 (успеть в окоп L).
        if (leftTicks() >= 70) {
          const dangerA = () => (leftTicks() < 45 ? 'некогда (A)' : danger())
          const bA = await tsBuild(session, ctl, stats, ownA, dangerA, leftTicks, { skipTrench: true })
          if (!bA.ok) { ev('ocA', { fail: `стройка A: ${bA.why}` }); ownA = null; ownB = null }
          if (ownB && leftTicks() >= 70) {
            const bB = await tsBuild(session, ctl, stats, ownB, dangerA, leftTicks, { skipTrench: true })
            if (bB.ok) ownB.built = true
            else { ev('ocB', { fail: `стройка B: ${bB.why}` }); ownB = null }
          }
        } else { ev('ocA', { fail: 'некогда строить A' }); ownA = null; ownB = null }
        b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { onlyTrench: true })
      }
    }
  } finally { ctl.holdStation = false }
  if (!b.ok) return no(`стройка: ${b.why}`)
  stats.oc.built++
  // L0: щелчок за gapTicks тиков до L (прогноз — свежий).
  if (plan.second && plan.gapTicks >= 10) {
    const s2 = plan.second
    const hit0 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), s2)
    if (hit0) {
      await lookAtSafe(bot, hit0.point)
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      doing(ctl, 'oc:wait0')
      let t0c = 0; let last0 = fc; let okWait = true
      for (;;) {
        if (ctl.aborted) return false
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { okWait = false; break }
        const f2 = feed.fc && feed.fc.id === d.id ? feed.fc : null
        if (f2) last0 = f2
        // До L0 дракон летит по прогнозу без толчка: тик L0 — i0 + 1 от пакета плана, сдвиг —
        // по свежему прогнозу того же (ещё не толкнутого) полёта.
        t0c = plan.nPlan ? last0.t + 50 * (last0.n - plan.nPlan + s2.i0 + 1) - 30 : last0.t + 50 * (last0.n - 2) - 30 - 50 * plan.gapTicks
        if (t0c - gameClock.now() < 70) break
        await sleep(15)
      }
      if (okWait && t0c > gameClock.now() - 30) {
        const at0 = plan.nPlan ? last0.path[last0.n - plan.nPlan + s2.i0] : last0.path[last0.n - 3 - plan.gapTicks]
        const hd0 = at0 ? r1(at0.head.distanceTo(s2.centre)) : null
        const b0 = await bedsBoom(session, ctl, stats, { ...s2, reuse: true }, hit0, 'снижение', { aimed: true, until: t0c, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist: hd0, oc: 'L0' } })
        stats.oc.L0 = stats.oc.L0 || []
        stats.oc.L0.push({ ok: b0.ok, dmg: b0.dmg, headDist: hd0 })
      } else ev('ocL', { why: 'L0: не дождался' })
    } else ev('ocL', { why: 'L0: бок не видно' })
  }
  const hitPt = plan.anchor ? anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan) : tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
  if (!hitPt) return no(plan.anchor ? 'якорь из окопа не видно' : 'бок кровати из окопа не видно')
  await lookAtSafe(bot, hitPt.point)
  await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  // Ждать миг: прогноз по свежим пакетам; голова должна лечь у кровати.
  doing(ctl, 'oc:wait')
  let tClick = 0; let last = fc
  for (;;) {
    if (ctl.aborted) return false
    const dd = dragonOf(bot)
    if (!dd) return false
    const ph = phaseOf(bot, dd)
    if (ph !== PHASE.LANDING) return no(`фаза ${PHASE_RU[ph] ?? ph} до щелчка`)
    const f2 = landingForecast(feed, P)
    if (f2) last = f2
    const miss = last.head.distanceTo(refHead)
    if (miss > 1.2) return no(`прогноз ушёл на ${r1(miss)}`)
    if (landingHits(last, bot.entity.position, 0.2)) return no('коробки дракона на месте')
    // Щелчок, обработанный после тика g + n − 2 (за два тика до посадки): опоздание на тик
    // — ещё снижение; на тик раньше «в самый раз» — уже сидит (урон в сидячий счёт; oc2-26).
    tClick = last.t + 50 * (last.n - 2) - 55
    if (tClick - gameClock.now() < 70) break
    await sleep(15)
  }
  const at = last.path[last.n - 3] || last.path[last.path.length - 1]
  const cen = plan.centre
  const headDist = at ? r1(Math.hypot(at.head.x - cen.x, at.head.y - cen.y, at.head.z - cen.z)) : null
  // Первая посадка: сразу за L — крышка над головой к упору K (обработается через тик, до
  // тика посадки: первое «высматривает» спросит видимость — окоп закрыт, и дракон слепой навсегда).
  let lidSent = false
  const placeLid = async () => {
    const K = new Vec3(plan.K.x, plan.G, plan.K.z)
    const face = new Vec3(-plan.K.d.x, 0, -plan.K.d.z)
    const aim = pick.faceAim(bot, K, face, { avoid: [] })
    if (!aim) return
    await lookAtSafe(bot, aim)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const cur = aim.minus(K)
    bot._client.write('block_place', { location: K, direction: FACE_IDX(face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    lidSent = true
  }
  if (blindLid) {
    const f = fillerItem(bot)
    const it = f && bot.inventory.items().find(i => i.name === f)
    if (it) await bot.equip(it, 'hand').catch(() => {})
    await lookAtSafe(bot, hitPt.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  }
  const boom = await bedsBoom(session, ctl, stats, plan, hitPt, 'снижение', { aimed: true, until: tClick, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist, n: last.n, oc: 'L', lid: blindLid || undefined }, keepHand: blindLid, afterClick: blindLid ? placeLid : null })
  if (blindLid) {
    // Дождаться «высматривает» (запрос видимости — в тик посадки), потом вылезти.
    const lidPos = new Vec3(plan.B.x, plan.G, plan.B.z)
    const t0 = gameClock.now(); let sat = 0; let roared = false
    while (!ctl.aborted && gameClock.now() - t0 < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
      if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
      await sleep(20)
    }
    const lidUp = isSolid(bot.blockAt(lidPos))
    ev('blind:lid', { sent: lidSent, lid: lidUp, sat: !!sat, roared })
    if (sat && lidUp && !roared && dragonOf(bot)) sight.set(dragonOf(bot).id + ':' + bot.entity.id, 'blind')
    if (lidUp) { await items.equipBestTool(bot, bot.blockAt(lidPos)); await build.withTimeout(bot.dig(bot.blockAt(lidPos), true), 3000).catch(() => {}) }
  }
  if (!boom.ok) return no(`щелчок: ${boom.why}`)
  stats.oc.booms++
  stats.oc.L = stats.oc.L || []
  stats.oc.L.push({ dmg: boom.dmg, headDist, took: boom.ph })
  if (tk && plan.second) ctl.ocTk = { dId: d.id, t: gameClock.now(), plan: { ...plan, second: null }, T2: tk.T2, A: tk.A, path: tk.path, S: tk.S }
  // Видящий: «высматривает» 25 тиков поворачивает голову к нам — переждать в окопе (в окопе в 2
  {
    const dd = dragonOf(bot)
    if (dd && sight.get(dd.id + ':' + bot.entity.id) === 'seeing') {
      doing(ctl, 'oc:scanWait')
      const tw = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw < 3500) {
        const d2 = dragonOf(bot); const ph2 = d2 ? phaseOf(bot, d2) : null
        if (!d2 || ph2 === PHASE.ROARING || ph2 === PHASE.FLAMING) break
        if (!SITTING.has(ph2) && ph2 !== PHASE.LANDING) break
        await sleep(25)
      }
    }
  }
  // Из окопа — сразу на землю (блок под себя): выход шагами из ямы в блок шёл по 4 с
  // (oc7-15: «beds:walk» до самого взлёта — ни A, ни B).
  const q = bot.entity.position
  if (Math.floor(q.y + 0.01) < plan.G) { doing(ctl, 'oc:out'); await build.towerUp(bot, ctl, plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  if (ownA) {
    const rA = await ocOwnClick(session, ctl, stats, ownA, fcA, track, { tag: 'A' })
    // B: построена на снижении — дойти и щёлкнуть; нет — построить сейчас (слепой сидит 99 тиков).
    if (rA && ownB) await ocOwnClick(session, ctl, stats, ownB, fcA, track, { tag: 'B', build: !ownB.built })
  }
  return true
}

async function ocOwnClick (session, ctl, stats, st, fcA, track, { tag = 'A', build: doBuild = false }: any = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  let why = null
  let ok = false
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const d0 = dragonOf(bot)
    if (!d0) { why = 'нет дракона'; return false }
    if (doBuild) {
      if (!sittingNow()) { why = 'не сидит — строить некогда'; return false }
      if (!st.psSafe) { why = 'место ставки у шеи сидящего'; return false }
      ctl.holdStation = true
      let b
      try { b = await tsBuild(session, ctl, stats, st, () => (!sittingNow() ? 'взлетел' : null), null, { skipTrench: true, parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
      if (!b.ok) { why = `стройка: ${b.why}`; return false }
    }
    const bedOk = /_bed$/.test((bot.blockAt(new Vec3(st.H.x, st.yb, st.H.z)) || {}).name || '')
    if (!bedOk) { why = 'кровати нет (снесло?)'; return false }
    doing(ctl, `oc:to${tag}`)
    const feet = new Vec3(st.B.x + 0.5, st.G, st.B.z + 0.5)
    const g = await bedsGo(session, ctl, { feet, y: st.G, B: st.B, lift: 0 }, true, partsOf(bot, d0, track))
    if (!g.ok) { why = `не дошёл: ${g.why}`; return false }
    const tr = await tsTrench(bot, ctl, st, k => doing(ctl, `oc${tag}:` + k), session)
    if (!tr.ok) { why = `окоп: ${tr.why}`; return false }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), st)
    if (!hit) { why = 'бок не видно'; return false }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, `oc:wait${tag}`)
    const tw = gameClock.now()
    let sat = false
    while (!ctl.aborted && gameClock.now() - tw < 3000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (SITTING.has(ph)) { sat = true; break }
      if (ph !== PHASE.LANDING) break
      await sleep(10)
    }
    if (!sat) { why = 'не сидит'; return false }
    const hd = fcA ? r1(fcA.head.distanceTo(st.centre)) : null
    const r = await bedsBoom(session, ctl, stats, { ...st, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p), note: { oc: tag, headDist: hd, ms: gameClock.now() - t0, prebuilt: !doBuild } })
    stats.oc[tag] = stats.oc[tag] || []
    stats.oc[tag].push({ ok: r.ok, dmg: r.dmg, headDist: hd })
    if (!r.ok) { why = `щелчок: ${r.why}`; return false }
    ok = true
    return true
  } finally {
    ev('oc' + tag, { done: ok, why, ms: gameClock.now() - t0 })
    const q = bot.entity.position
    if (Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, `oc:out${tag}`); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function walkAround (session, ctl, target, { timeoutMs = 8000, stop = null }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const me = bot.entity.position
  const pts = []
  const segNear = (a, b) => segPoint2({ x: a.x, z: a.z }, { x: b.x, z: b.z }, CENTER)
  if (segNear(me, target) < 4.5) {
    const a0 = Math.atan2(me.z - CENTER.z, me.x - CENTER.x); const a1 = Math.atan2(target.z - CENTER.z, target.x - CENTER.x)
    const da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
    const n = Math.max(1, Math.ceil(Math.abs(da) / 0.6))
    for (let k = 1; k < n; k++) { const a = a0 + da * k / n; pts.push(new Vec3(CENTER.x + Math.cos(a) * 7.5, target.y, CENTER.z + Math.sin(a) * 7.5)) }
  }
  pts.push(target)
  for (let i = 0; i < pts.length; i++) {
    if (ctl.aborted || gameClock.now() - t0 > timeoutMs) break
    const p = pts[i]
    const last = i === pts.length - 1
    const y = standY(bot, p.x, p.z, bot.entity.position.y, 3, 4)
    const q = new Vec3(p.x, y != null ? y : p.y, p.z)
    if (stop && stop()) break
    const r = await stepTo(bot, ctl, q, { ms: 2500, sprint: true, stopAt: last ? 0.3 : 1.0, stop })
    if (stop && stop()) break
    if (!r.ok && Math.hypot(bot.entity.position.x - q.x, bot.entity.position.z - q.z) > (last ? 0.6 : 2)) {
      await walkTo(session, ctl, q, { range: last ? 0.35 : 1.5, timeoutMs: Math.max(1500, timeoutMs - (gameClock.now() - t0)), hazards: true, stopIf: stop ? () => (stop() ? 'опасно' : null) : undefined })
    }
  }
  clearControls(bot)
  const m = bot.entity.position
  return { ok: Math.hypot(m.x - target.x, m.z - target.z) <= 0.6, why: gameClock.now() - t0 > timeoutMs ? 'не успел' : null }
}

async function tsBuild (session, ctl, stats, plan, danger = null, left = null, { skipTrench = false, onlyTrench = false, parts = null }: any = {}) {
  const bot = session.bot
  const v = (c, y) => new Vec3(c.x, y, c.z)
  const t0 = gameClock.now()
  const lap: any = {}
  const mark = k => { lap[k] = gameClock.now() - t0; doing(ctl, 'ts:' + k) }
  const risky = () => { const w = (gameClock.now() - lastDragonHit < 1500 ? 'удар дракона' : null) || (danger && danger()); if (w) { lap.danger = w; return true } return false }
  const res = r => { if (ctl.trace) ctl.trace.ev('tsBuild', { ok: r.ok, why: r.why, lap, role: plan.role || undefined, part: skipTrench ? 'стройка' : onlyTrench ? 'окоп' : undefined }); return r }
  const trench = async () => { const r = await tsTrench(bot, ctl, plan, mark, session); Object.assign(lap, r.lap || {}); delete r.lap; return res(r) }
  if (onlyTrench) return trench()
  mark('walk')
  if (risky()) return res({ ok: false, why: 'дракон рядом' })
  const low = plan.psLift ? new Vec3(plan.ground.x, plan.gPS, plan.ground.z) : plan.ground
  // Дракон сидит (parts) — идти в обход его коробок (bedsGo), а не дугой у фонтана.
  const walkStop = () => {
    if (gameClock.now() - lastDragonHit < 1500) return true
    const dd = dragonOf(bot)
    if (dd && SITTING.has(phaseOf(bot, dd))) { const pp = partsOf(bot, dd, null); if (hurtNear(playerBox(bot.entity.position), pp)) return true }
    return !!(danger && danger())
  }
  const g = parts ? await bedsGo(session, ctl, { feet: low, y: low.y, B: { x: Math.floor(low.x), z: Math.floor(low.z) }, lift: 0 }, true, parts()) : await walkAround(session, ctl, low, { timeoutMs: 7000, stop: walkStop })
  if (!g.ok) return res({ ok: false, why: `не дошёл до места ставки: ${g.why || ''}` })
  clearControls(bot)
  // Ставить с середины клетки: план проверял грани из неё (касательные взгляды с края — «грань
  // не видно», fin1).
  for (let k = 0; k < 3 && Math.hypot(bot.entity.position.x - low.x, bot.entity.position.z - low.z) > 0.12; k++) { await stepTo(bot, ctl, low, { ms: 600, sprint: false, stopAt: 0.06 }); clearControls(bot) }
  // Ставить стоя на земле: fin2-28 — опора и заслон ставились в прыжке (y 61.4→62.2, g 0),
  // грани из воздуха «не видно».
  const settle = async () => { clearControls(bot); for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50) }
  await settle()
  if (plan.psLift) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    mark('stand')
    await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot)
    // Встал — значит стоит на своём блоке (на земле), а не в прыжке: fin2-28 — проверка прошла
    // в воздухе (y 64.2), блока не было, тело упало, и заслон «грань не видно».
    const onStand = () => bot.entity.onGround && Math.abs(bot.entity.position.y - plan.ground.y) <= 0.3 && isSolid(bot.blockAt(new Vec3(low.x, plan.gPS, low.z)))
    for (let k = 0; k < 2 && !onStand(); k++) {
      if (k) { await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot) }
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
      for (let j = 0; j < 15 && !bot.entity.onGround; j++) await sleep(50)
    }
    if (!onStand()) return res({ ok: false, why: 'на блок у места ставки не встал' })
  }
  mark('support')
  for (const y of plan.sCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r: any = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 })
    // Грань опоры видна с середины клетки ставки (так считал план) — встать точно и ещё раз.
    if (!r.ok) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.08 }); clearControls(bot); r = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 }) }
    if (!r.ok) return res({ ok: false, why: `опора: ${r.reason || r.why}` })
  }
  // заслон — отсюда, если видно; нет — с B
  mark('wall')
  let moved = false
  for (const y of plan.wCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r: any = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    // С места ставки не вышло — сперва встать точно туда (стоя), потом уже с B.
    if (!r.ok && !moved && !plan.psLift) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.06 }); await settle(); r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 }) }
    if (!r.ok && !moved) {
      moved = true
      await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.08 })
      await settle()
      r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    }
    if (!r.ok) { const q = bot.entity.position; lap.wallAt = [plan.W.x, y, plan.W.z]; lap.me = [r1(q.x), r1(q.y), r1(q.z)]; lap.ps = [plan.ground.x, plan.ground.y, plan.ground.z]; return res({ ok: false, why: `заслон: ${r.reason || r.why}` }) }
  }
  if (plan.K && !isSolid(bot.blockAt(v(plan.K, plan.G)))) {
    mark('anchor')
    let r: any = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 })
    if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 }); moved = true }
    if (!r.ok) return res({ ok: false, why: `упор крышки: ${r.reason || r.why}` })
  }
  if (moved) await stepTo(bot, ctl, plan.ground, { ms: 2000, stopAt: 0.2 })
  if (plan.anchor) {
    mark('anchor')
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    const r = await placeAnchorAt(bot, plan)
    if (!r.ok) return res({ ok: false, why: `якорь: ${r.why}` })
    mark('charge')
    const c = await chargeAnchor(bot, plan)
    if (!c.ok) return res({ ok: false, why: `заряд: ${c.why}` })
  } else {
  mark('bed')
  const bedAt = bot.blockAt(v(plan.F, plan.yb))
  if (!(bedAt && /_bed$/.test(bedAt.name))) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    const r = await placeBedAt(bot, plan.F, plan.H, plan.yb)
    if (!r.ok) return res(r)
  }
  const hb = bot.blockAt(v(plan.H, plan.yb))
  if (!hb || !/_bed$/.test(hb.name)) return res({ ok: false, why: 'изголовье не там (взгляд не вдоль a)' })
  }
  if (plan.second && (!left || left() >= 70)) {
    const s2 = plan.second
    mark('walk0')
    const g0 = risky() ? { ok: false } : await walkAround(session, ctl, s2.ground, { timeoutMs: 6000 })
    if (g0.ok) {
      mark('build0')
      let ok0 = true
      for (const y of s2.sCells) { if (risky()) { ok0 = false; break } const r = await placeNoBed(bot, v(s2.F, y), { timeoutMs: 1200 }); if (!r.ok) { ok0 = false; break } }
      for (const y of ok0 ? s2.wCells : []) {
        if (risky()) { ok0 = false; break }
        let r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 })
        if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 }); await stepTo(bot, ctl, s2.ground, { ms: 2000, stopAt: 0.2 }) }
        if (!r.ok) { ok0 = false; break }
      }
      if (ok0 && !risky()) { const r = await placeBedAt(bot, s2.F, s2.H, s2.yb); ok0 = r.ok } else ok0 = false
      const hb0 = bot.blockAt(v(s2.H, s2.yb))
      lap.second = ok0 && hb0 && /_bed$/.test(hb0.name) ? 'ok' : 'нет'
      if (lap.second !== 'ok') plan.second = null
    } else { lap.second = 'не дошёл'; plan.second = null }
  }
  else if (plan.second) { lap.second = 'некогда'; plan.second = null }
  if (skipTrench) { mark('done'); return res({ ok: true }) }
  return trench()
}

async function tsTrench (bot, ctl, plan, mark, session) {
  const lap: any = {}
  mark('trench')
  const runner0 = runnerOn() && plan.runner
  const bc = runner0 && plan.feet ? new Vec3(plan.feet.x, plan.G, plan.feet.z) : new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // portal: окоп станции у столба — в 3–5 от середины: шаг к середине клетки смотрит на 0.9 вперёд и
  // упирался в «чашу портала» (pil5-15: «не встал в середину клетки» ×5 за 1.5 с)
  const portal = !!plan.portal
  const runner = runnerOn() && plan.runner
  // depth 0: спуститься с обода P−3 в чашу P−4 маршрутом, а не копкой под собой.
  if (runner && plan.depth === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 8000, portal })
  // R: в клетке ног чаши — свой блок (рефлекс от облака/фаербола, rs8-s1), бот стоит на нём на ярус выше — снять под собой
  if (runner && plan.depth === 0) {
    for (let k = 0; k < 2; k++) {
      const q0 = bot.entity.position
      const under = bot.blockAt(new Vec3(Math.floor(q0.x), Math.floor(q0.y + 0.01) - 1, Math.floor(q0.z)))
      if (Math.floor(q0.y + 0.01) <= plan.G || Math.hypot(q0.x - bc.x, q0.z - bc.z) > 0.6 || !under || !FILLER_RE.test(under.name)) break
      lap.unfill = (lap.unfill || 0) + 1
      await digDownTo(bot, ctl, plan.G, 2, plan.abortIf || null).catch(() => {})
    }
  }
  await stepTo(bot, ctl, bc, { ms: 2000, stopAt: 0.15, portal })
  clearControls(bot)
  // R: ноги сдвинуты к краю клетки (x 0.2/0.8) — floor(x) на шаге за край врёт; годится ≤ 0.35 от точки ног (rs3: 37 «не встал над окопом»)
  const inCell = () => { const q = bot.entity.position; return runner0 && plan.feet ? Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.35 : Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.45 }
  for (let k = 0; k < 2 && !inCell(); k++) {
    if (k === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 4000, hazards: true, portal })
    await stepTo(bot, ctl, bc, { ms: 900, sprint: false, stopAt: 0.1, portal })
    clearControls(bot)
  }
  if (plan.abortIf && plan.abortIf()) return { ok: false, why: plan.abortIf(), lap }
  if (!inCell()) return { ok: false, why: 'не встал над окопом', lap }
  // Копать под собой — только стоя целиком над клеткой (коробка 0.6: смещение ≤ 0.18),
  const centred = () => { const q = bot.entity.position; return Math.max(Math.abs(q.x - bc.x), Math.abs(q.z - bc.z)) <= 0.18 }
  for (let k = 0; k < 4 && !centred(); k++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot); await sleep(60) }
  if (!centred()) return { ok: false, why: 'не встал в середину клетки окопа', lap }
  for (let k = 0; k < 2 && (!runner || plan.depth > 0) && Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth; k++) {
    const stopWhy = plan.abortIf && plan.abortIf()
    if (stopWhy) return { ok: false, why: stopWhy, lap }
    const down = await digDownTo(bot, ctl, plan.G - plan.depth, plan.depth, plan.abortIf || null)
    lap['dig' + k] = { dug: down.dug, why: down.why || null, y: r1(bot.entity.position.y), off: r1(Math.hypot(bot.entity.position.x - bc.x, bot.entity.position.z - bc.z) * 100) / 100 }
    if (Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth) { clearControls(bot); bot.setControlState('sneak', false); for (let j = 0; j < 3 && !centred(); j++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot) } }
  }
  // глубже, чем надо (провалился) — подняться на свой блок
  const under = plan.G - plan.depth - Math.floor(bot.entity.position.y + 0.01)
  if (!runner && under > 0 && under <= 2 && inCell()) { lap.up = under; await build.towerUp(bot, ctl, under).catch(() => {}); clearControls(bot) }
  // st2-s1: «не спустился» ×6 подряд за 1.5 с — тело ещё падало/подпрыгивало в яме (y 61.4 при цели 61): ждать земли
  for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50)
  lap.end = { y: r1(bot.entity.position.y), want: plan.G - plan.depth, ground: !!bot.entity.onGround }
  if (Math.floor(bot.entity.position.y + 0.01) !== plan.G - plan.depth) return { ok: false, why: 'окоп: не спустился', lap }
  mark('done')
  return { ok: true, lap }
}

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

function bedsLayout (bot, d, parts, { headAt = null, stayAt = null, brave = false, cap = null, skip = null, noTurn = false, liftMax = 0, hurry = false }: any = {}) {
  const me = bot.entity.position
  const hp = headAt || new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const blind = SITTING.has(ph) && blindKnown(sitRec)
  const breath = SITTING.has(ph) && !blind ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  let best = null
  const cands = []
  const nearY = Math.floor(hp.y) - 3
  for (const D of AXES) {
    // ±2 от головы: после первой кровати у головы воронка (эндерняк под изножьем
    // снесён, досыпку не видно) — вторая ложится на целый пол рядом.
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const H = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        const F = { x: H.x - D.x, z: H.z - D.z }
        const W = { x: H.x - 2 * D.x, z: H.z - 2 * D.z }
        const B = { x: H.x - 3 * D.x, z: H.z - 3 * D.z }
        if (stayAt && (B.x !== stayAt.x || B.z !== stayAt.z)) continue
        const key = `${H.x},${H.z},${D.x},${D.z}`
        if (skip && skip.has(key)) { no('не вышло только что'); continue }
        const y0 = standY(bot, B.x + 0.5, B.z + 0.5, nearY, 2, 3)
        if (y0 == null) { no('нет земли'); continue }
        // lift 1 — всё на блок выше: мы на своём блоке у B, кровать на опоре у F (центр
        // взрыва в 0.5 под головой сидящего вместо 1.5; сидячий крыльями не бьёт).
        for (const lift of (liftMax && SITTING.has(ph) ? [0, 1] : [0])) {
        const y = y0 + lift
        if (lift && !isAirish(at(B.x, y + 1, B.z))) { no('над своим блоком'); continue }
        if (/fire/.test((at(B.x, y, B.z) || {}).name || '')) { no('огонь на месте'); continue }
        // У задней кромки клетки — если за ней свободно (иначе по центру).
        const backFree = !isSolid(at(B.x - D.x, y, B.z - D.z)) && !isSolid(at(B.x - D.x, y + 1, B.z - D.z))
        const back = backFree ? 0.22 : 0
        const feet = new Vec3(B.x + 0.5 - D.x * back, y, B.z + 0.5 - D.z * back)
        if (nearPortal(feet)) { no('чаша портала'); continue }
        if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
        if (!blind && !noTurn && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
        // В облако не вставать и смелому: рефлекс «на блок» поднимает тело, щелчок
        if (inClouds(clouds, feet, 1.0)) { no('облако'); continue }
        const breathHit = !!breath && cloudHits(breath, feet, 0.6)
        // Огонь уже идёт — в его круг нельзя; ревёт (облако через ≤ 2.5 с) — можно,
        // если место в паре шагов: кровать успевает раньше облака.
        if (breathHit && ph === PHASE.FLAMING) { no('облако огня'); continue }
        if (breathHit && ph === PHASE.ROARING && Math.hypot(feet.x - me.x, feet.z - me.z) > 3) { no('облако огня скоро'); continue }
        // Клетки кровати, заслона и вида поверх него.
        const hB = at(H.x, y, H.z); const fB = at(F.x, y, F.z)
        const reuse = !!hB && !!fB && /_bed$/.test(hB.name) && /_bed$/.test(fB.name)
        if (!reuse && (!bedCellFree(hB) || !bedCellFree(fB))) { no('клетки кровати'); continue }
        const wB = at(W.x, y, W.z)
        const wallUp = solidOk(wB)
        if (!wallUp && !bedCellFree(wB)) { no('клетка заслона'); continue }
        if (wallUp && !reuse) { no('заслон уже стоит — пол под кроватью не видно'); continue }
        if (!isAirish(at(W.x, y + 1, W.z)) || !isAirish(at(F.x, y + 1, F.z))) { no('над заслоном блок'); continue }
        // Пол: под изножьем — твёрдый (или досыпать один), под заслоном — тоже.
        const fills = []
        for (const c of [W, F]) {
          const fl = at(c.x, y - 1, c.z)
          if (!fl) { fills.push(null); break }
          if (solidOk(fl)) continue
          if (!isAirish(fl) && !/fire/.test(fl.name)) { fills.push(null); break }
          // Досыпать есть к чему прислонить: снизу или сбоку твёрдое (или
          // досыпка перед ней).
          const prev = fills[fills.length - 1]
          const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(c.x + a, y - 1 + b, c.z + e)) || (prev && prev.x === c.x + a && prev.y === y - 1 + b && prev.z === c.z + e))
          if (!nb) { fills.push(null); break }
          fills.push(new Vec3(c.x, y - 1, c.z))
        }
        if (fills.includes(null)) { no('пол'); continue }
        // Каждую досыпку — на «мире как будет» (после предыдущих): вторая (под
        // изножьем) за первой часто не видна (b4/b5: «пол не встал» ×20).
        {
          const ex = new Map()
          let hidden = false
          for (const f of fills) {
            if (!fillPlaceable(ex.size ? virtualBot(bot, ex) : bot, f, feet.offset(0, SNEAK_EYE, 0))) { hidden = true; break }
            ex.set(`${f.x},${f.y},${f.z}`, 'block')
          }
          if (hidden) { no('досыпку не видно'); continue }
        }
        if (!lift && !solidOk(at(B.x, y - 1, B.z))) { no('пол под нами'); continue }
        // Кровать не в коробках дракона (checkWalls снёс бы её без взрыва).
        const bedBox = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
        if (overlap(bedBox, inflate(parts.head, 0.1)) || overlap(bedBox, inflate(parts.neck, 0.1)) || overlap(bedBox, inflate(parts.body, 0.1))) { no('в драконе'); continue }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > 5.5) { no('далеко от головы'); continue }
        const expect = bedDamage(dist)
        const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
        const over = cap != null && expect > cap ? (expect - cap) * 3 : 0
        const cost = -expect + over + walk * 1.2 + fills.length * 6 + (breathHit ? 6 : 0) + (back ? 0 : 3)
        cands.push({ key: key + (lift ? ':1' : ''), H, F, W, B, D, y, feet, centre, dist: r1(dist), expect, fills, reuse, wallUp, cost: lift ? cost - fills.length * 6 + 3 : cost, breathHit, walk, back, lift })
        }
      }
    }
  }
  // Видимость дракона из центра взрыва (свои блоки у кровати — заслон, досыпка, яма и
  cands.sort((p, q) => p.cost - q.cost)
  for (const c of cands.slice(0, 6)) {
    const ex = new Map([[`${c.W.x},${c.y},${c.W.z}`, 'block']])
    for (const f of c.fills) ex.set(`${f.x},${f.y},${f.z}`, 'block')
    const seen = dragonSeen(virtualBot(bot, ex), c.centre, parts.pos)
    c.seen = Math.round(seen * 100) / 100
    c.expect = bedDamage(c.centre.distanceTo(hp), seen)
    const over = cap != null && c.expect > cap ? (c.expect - cap) * 3 : 0
    // На своём блоке досыпка под заслон и изножье — часть раскладки (не штраф «воронки»).
    c.cost = -c.expect + over + c.walk * 1.2 + (c.lift ? 3 : c.fills.length * 6) + (c.breathHit ? 6 : 0) + (c.back ? 0 : 3)
    // Слепой вот-вот взлетит сам (на 99-м тике): любая кровать ближе — лишь бы сидячий
    // счёт перевалил 50 и обнулился (иначе он перейдёт на следующую посадку: oc7-12).
    if (hurry) c.cost = -c.expect * 0.3 + c.walk * 3 + c.fills.length * 6
    if (!best || c.cost < best.cost) best = c
  }
  bedsLayout.why = best ? null : why
  return best
}
declare namespace bedsLayout {
  let why: any
}

async function bedsGo (session, ctl, plan, brave, parts = null) {
  const bot = session.bot
  if (plan.lift) {
    // Свой блок у B: дойти до земли под ним и встать на блок (прыжок с блоком под себя).
    const low = { ...plan, lift: 0, feet: plan.feet.offset(0, -1, 0), y: plan.y - 1 }
    const me0 = bot.entity.position
    if (!(Math.hypot(me0.x - plan.feet.x, me0.z - plan.feet.z) < 0.5 && Math.abs(me0.y - plan.y) < 0.3)) {
      const g = await bedsGo(session, ctl, low, brave, parts)
      if (!g.ok) return g
      doing(ctl, 'beds:stand')
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
    }
    const p = bot.entity.position
    if (Math.abs(p.y - plan.y) > 0.3 || Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.6) return { ok: false, why: 'на свой блок не встал' }
    return { ok: true }
  }
  const me = bot.entity.position
  const off = Math.hypot(me.x - plan.feet.x, me.z - plan.feet.z)
  if (off < 0.2 && Math.abs(me.y - plan.feet.y) < 0.3) return { ok: true }
  doing(ctl, 'beds:walk')
  // Видящий начал новый круг «высматривает» — голова пойдёт к нам: остановиться
  // (b2-22, попытка 2, 100.8–101.3 с: шёл к месту — удар головой).
  const scanStop = () => { const dd = dragonOf(bot); return !!dd && phaseOf(bot, dd) === PHASE.SCANNING && !blindKnown(sitRec) && !turnSafe(dd, bot.entity.position) }
  const near = off < 8 && Math.abs(me.y - plan.feet.y) < 1.2 && clearOfDragon(bot, me, plan.feet, parts)
  let r: any = near ? await stepTo(bot, ctl, plan.feet, { ms: 3000, sprint: off > 3, stopAt: 0.15, clouds: true, stop: scanStop }) : { ok: false }
  if (scanStop()) return { ok: false, why: 'высматривает — голова пойдёт к нам' }
  if (!r.ok) {
    const g = new Vec3(plan.B.x + 0.5, plan.y, plan.B.z + 0.5)
    r = await walkTo(session, ctl, g, { range: 0.3, timeoutMs: 8000, hazards: true, stopIf: () => scanStop() ? 'высматривает — голова пойдёт к нам' : null })
    if (Math.hypot(bot.entity.position.x - g.x, bot.entity.position.z - g.z) > 0.7) return { ok: false, why: r.why || 'не дошёл' }
    await stepTo(bot, ctl, plan.feet, { ms: 900, sprint: false, stopAt: 0.12, clouds: false })
  }
  clearControls(bot)
  const p = bot.entity.position
  if (Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.5 || Math.abs(p.y - plan.y) > 0.3) {
    // Чуть не дошёл/проскочил — ещё шаг клавишами.
    await stepTo(bot, ctl, plan.feet, { ms: 700, sprint: false, stopAt: 0.12, clouds: false })
    clearControls(bot)
    const q = bot.entity.position
    if (Math.hypot(q.x - plan.feet.x, q.z - plan.feet.z) > 0.5 || Math.abs(q.y - plan.y) > 0.3) return { ok: false, why: 'не на месте' }
  }
  return { ok: true }
}

async function bedsBoom (session, ctl, stats, plan, hit, why, opts: any = {}) {
  const bot = session.bot
  const d = dragonOf(bot)
  const wpn = items.bestWeapon(bot)
  if (!opts.keepHand && wpn && (!bot.heldItem || /_bed$|glowstone|respawn_anchor/.test(bot.heldItem.name))) await bot.equip(wpn, 'hand').catch(() => {})
  if (opts.phCheck && d && !opts.phCheck(phaseOf(bot, d))) return { ok: false, why: 'фаза уже не та' }
  const ph = d ? phaseOf(bot, d) : null
  const before = d ? hpOf(bot, d) : null
  const me0 = bot.health
  let boomAt = 0
  const onDmg = pk => { if (d && pk && pk.entityId === d.id && DAMAGE_TYPES[pk.sourceTypeId] === 'bad_respawn_point' && !boomAt) boomAt = gameClock.now() }
  bot._client.on('damage_event', onDmg)
  // Свидетель клиента (02.10, rs1: 14 из 25 ставок+щелчков R без взрыва и без причины в трассе): что сервер прислал по клеткам
  // кровати (ставка встала? снесена?), взрыв, телепорт; рука, крадучись, тело дракона против клетки F (коробка 16×8 мешает ставке).
  const wit: any = { blk: [] }; const tw0 = gameClock.now()
  const watch = opts.prePlace || hit.runnerGuard ? new Set([`${plan.H.x},${plan.y},${plan.H.z}`, ...(opts.prePlace ? [`${opts.prePlace.pos.x + opts.prePlace.face.x},${plan.y},${opts.prePlace.pos.z + opts.prePlace.face.z}`] : [])]) : null
  const onBlk = (o, n) => { if (watch && n && watch.has(`${n.position.x},${n.position.y},${n.position.z}`) && wit.blk.length < 8) wit.blk.push([gameClock.now() - tw0, n.position.x, n.position.z, n.name]) }
  const onExp = pk => { if (!wit.exp) wit.exp = gameClock.now() - tw0 }
  const onTp = () => { wit.tp = (wit.tp || 0) + 1 }
  if (watch) { bot.on('blockUpdate', onBlk); bot._client.on('explosion', onExp); bot._client.on('position', onTp) }
  const unwatch = () => { if (watch) { bot.removeListener('blockUpdate', onBlk); bot._client.removeListener('explosion', onExp); bot._client.removeListener('position', onTp) } }
  if (watch) {
    const hi = bot.heldItem; const q0 = bot.entity.position
    wit.hand = hi ? `${hi.name}x${hi.count}` : null; wit.sneak = !!bot.getControlState('sneak'); wit.g = !!bot.entity.onGround
    wit.me = [r1(q0.x), r1(q0.y), r1(q0.z)]
    if (d) { wit.body = [r1(d.position.x), r1(d.position.y), r1(d.position.z)]; wit.inBox = Math.abs(d.position.x - 0.5) < 8.5 && Math.abs(d.position.z - 0.5) < 8.5 && d.position.y < plan.y + 0.5625 && d.position.y + 8 > plan.y }
  }
  doing(ctl, `beds:click:${why}`)
  if (ctl.trace) ctl.trace.ev('bed', { ph, why, dist: plan.dist, expect: plan.expect, dragonHp: before, me: me0, D: [plan.D.x, plan.D.z], y: plan.y, at: [plan.H.x, plan.y, plan.H.z], ...(opts.note || {}) })
  let tc = gameClock.now()
  let tcWall = gameClock.wall.now()
  const failW = (w) => { unwatch(); if (watch && ctl.trace) { const dc = dragonOf(bot); if (dc) wit.body2 = [r1(dc.position.x), r1(dc.position.y), r1(dc.position.z)]; ctl.trace.ev('bedFail', { why: w, ...wit, ...(opts.note || {}) }) } return { ok: false, why: w } }
  // Подтверждение щелчка сервером (750 TPS, s5 06.10): окно 700 игровых мс — 19 мс реального времени, damage_event и хп
  // приходили позже — взорванная кровать считалась «ставка не прошла», урон 0. Ждать ack своего номера (clickBedAt).
  let seqWant = null; let acked = false
  const onAck = pk => { if (seqWant != null && pk && pk.sequenceId >= seqWant) acked = true }
  bot._client.on('acknowledge_player_digging', onAck)
  try { const sent = await clickBedAt(bot, hit, { aimed: !!opts.aimed, until: opts.until || 0, untilMono: opts.untilMono ?? null, prePlace: opts.prePlace || null }); if (sent === false) { bot._client.removeListener('damage_event', onDmg); bot._client.removeListener('acknowledge_player_digging', onAck); return failW('R: поздняя проверка безопасности' + (hit.guardWhy ? ': ' + hit.guardWhy : '')) } if (typeof sent === 'number') seqWant = sent; tc = gameClock.now(); tcWall = gameClock.wall.now(); wit.sentMs = tc - tw0 } catch (e) { dbg('beds click', e.message) }
  // В тик щелчка (01.10): голова по клиенту — расстояние от центра взрыва (клетка подушки H) и фаза.
  let atClick = null
  try {
    const dc = dragonOf(bot)
    if (dc && plan.H) {
      const pc = partsOf(bot, dc, makeTrack(bot))
      const C = plan.centre || new Vec3(plan.H.x + 0.5, plan.y + 0.5, plan.H.z + 0.5)
      atClick = { headNow: r1(pc.headC.distanceTo(C)), phNow: PHASE_RU[phaseOf(bot, dc)] ?? phaseOf(bot, dc) }
    }
  } catch {}
  if (opts.afterClick) { try { await opts.afterClick() } catch (e) { dbg('afterClick', e.message) } }
  const w0 = gameClock.wall.monotonic()
  while (seqWant != null ? !acked && (gameClock.now() - tc < 700 || gameClock.wall.monotonic() - w0 < 1500) : !boomAt && gameClock.now() - tc < 700) await sleep(25)
  bot._client.removeListener('damage_event', onDmg)
  bot._client.removeListener('acknowledge_player_digging', onAck)
  wit.acked = acked
  if (!acked) await sleep(120)
  const nameAt = (bot.blockAt(new Vec3(plan.H.x, plan.y, plan.H.z)) || {}).name || ''
  const gone = plan.anchor ? nameAt !== 'respawn_anchor' : !/_bed$/.test(nameAt)
  if (!gone && !boomAt) return failW('щёлкнул — не взорвалась')
  // ставка+взрыв в одном тике (ND_PLACE_CLICK): кровать не встала — урона нет и кровать в рюкзаке, это не трата (fs1: 6
  // «нулевых» bedDone, B/s16 и s28 насчитали 7 кроватей при 6 взрывах)
  if (opts.prePlace && !boomAt) return failW('ставка не прошла')
  unwatch()
  stats.lastBoom = boomAt || tc
  const dd = dragonOf(bot)
  const after = dd ? hpOf(bot, dd) : 0
  const dmg = before != null && after != null ? Math.max(0, before - after) : null
  // Толчок сидящему (скорость заморожена и копит толчки — взлёт с ними): для прогноза взлёта (T1).
  if (dd && SITTING.has(phaseOf(bot, dd)) && plan.centre) { const fx = sitFix.get(dd.id); if (fx && fx.pushes) fx.pushes.push({ centre: plan.centre.clone(), seen: plan.seen != null ? plan.seen : 1 }) }
  // Снижение (L): урон не в сидячий счёт — только запомнить хп.
  if (dd && opts.uncounted) { const h = hpOf(bot, dd); if (h != null) sitAcc.hp = h; sitAcc.sitting = false } else if (dd) noteSitDamage(bot, dd, phaseOf(bot, dd))
  stats.bedsUsed = (stats.bedsUsed || 0) + 1
  if (dmg) stats.dmg += dmg
  const rec = { ph: PHASE_RU[ph] ?? ph, why, dist: plan.dist, expect: plan.expect, dmg: dmg != null ? r1(dmg) : null, self: r1(Math.max(0, me0 - bot.health)), took: dd ? phaseOf(bot, dd) === PHASE.TAKEOFF : false, lagMs: boomAt ? boomAt - tc : null, sent: tc, sentWall: tcWall, tickRate: gameClock.snapshot()?.tickRate ?? 20, ...(opts.note || {}), ...(atClick || {}) }
  console.log(`[bed] ${why}: фаза ${rec.ph}${atClick ? '/' + atClick.phNow : ''}, голова ${atClick ? atClick.headNow : '?'} бл. (прогноз ${plan.dist}), урон ${rec.dmg} (ждали ${plan.expect}), нам ${rec.self}`)
  stats.beds.push(rec)
  if (ctl.trace) ctl.trace.ev('bedDone', rec)
  dbg('beds boom', JSON.stringify(rec))
  return { ok: true, ...rec }
}

function bedsDouble (bot, d, parts, { brave = false, skip = null, fixS = null, cap = null }: any = {}) {
  const me = bot.entity.position
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  const hp0 = new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  // Взлёт (трассы, 1300 взлётов, an-takeoffdir.js): первые 0.5 с тело почти на
  const hpC = new Vec3(hp0.x, hp0.y + 0.4, hp0.z)
  const mid = { x: (hp0.x + hpC.x) / 2, z: (hp0.z + hpC.z) / 2 }
  const nearY = Math.floor(hp0.y) - 3
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const breath = SITTING.has(ph) && !blindKnown(sitRec) ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const bodyBoxes = [inflate(parts.head, 0.1), inflate(parts.neck, 0.1), inflate(parts.body, 0.1)]
  // Кровать на (foot, head) уровня y: клетки свободны, пол под изножьем есть или
  // досыпается, не в коробках дракона.
  const bedCells = (F, H, y) => {
    const fb = at(F.x, y, F.z); const hb = at(H.x, y, H.z)
    // Своя кровать уже лежит так, как надо (изголовье в H) — взять её.
    if (fb && hb && /_bed$/.test(fb.name) && /_bed$/.test(hb.name)) {
      let part = null
      try { part = hb.getProperties ? hb.getProperties().part : null } catch {}
      return part === 'head' || part == null ? { fill: null, reuse: true } : null
    }
    if (!bedCellFree(fb) || !bedCellFree(hb)) return null
    const bb = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
    if (bodyBoxes.some(b => overlap(bb, b))) return null
    const fl = at(F.x, y - 1, F.z)
    if (!fl) return null
    if (solidOk(fl)) return { fill: null }
    if (!isAirish(fl) && !/fire/.test(fl.name)) return null
    const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(F.x + a, y - 1 + b, F.z + e)))
    return nb ? { fill: new Vec3(F.x, y - 1, F.z) } : null
  }
  // Лучшие варианты кровати у точки hp (голова) для места с глазами eye.
  const bedOpts = (hp, feet, y, lim) => {
    const out = []
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const F = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        // Изголовье ляжет по взгляду от нас на пол под изножьем (BedBlock.getStateForPlacement).
        const f = cardOf(F.x + 0.5 - feet.x, F.z + 0.5 - feet.z)
        const H = { x: F.x + f.x, z: F.z + f.z }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > lim) continue
        if (Math.max(Math.abs(F.x - Math.floor(feet.x)), Math.abs(F.z - Math.floor(feet.z))) < 2) continue
        const c = bedCells(F, H, y)
        if (!c) continue
        if (c.fill && !fillPlaceable(bot, c.fill, feet.offset(0, SNEAK_EYE, 0))) continue
        out.push({ F, H, f, centre, dist: r1(dist), expect: bedDamage(dist), fill: c.fill, reuse: !!c.reuse })
      }
    }
    return out.sort((a, b) => b.expect - a.expect)
  }
  let best = null
  for (let ox = -6; ox <= 6; ox++) {
    for (let oz = -6; oz <= 6; oz++) {
      const S = { x: Math.floor(mid.x) + ox, z: Math.floor(mid.z) + oz }
      if (fixS && (S.x !== fixS.x || S.z !== fixS.z)) continue
      const rS = Math.hypot(S.x + 0.5 - mid.x, S.z + 0.5 - mid.z)
      if (!fixS && (rS < 2.5 || rS > 5.2)) continue
      const y = standY(bot, S.x + 0.5, S.z + 0.5, nearY, 2, 3)
      if (y == null) { no('нет земли'); continue }
      if (/fire/.test((at(S.x, y, S.z) || {}).name || '')) { no('огонь'); continue }
      if (!solidOk(at(S.x, y - 1, S.z))) { no('пол под нами'); continue }
      // Задняя кромка — прочь от середины между кроватями.
      const ux = (S.x + 0.5 - mid.x) / (rS || 1); const uz = (S.z + 0.5 - mid.z) / (rS || 1)
      const bx = Math.round(ux); const bz = Math.round(uz)
      const backFree = !isSolid(at(S.x + bx, y, S.z + bz)) && !isSolid(at(S.x + bx, y + 1, S.z + bz))
      const feet = new Vec3(S.x + 0.5 + (backFree ? ux * 0.2 : 0), y, S.z + 0.5 + (backFree ? uz * 0.2 : 0))
      if (nearPortal(feet)) { no('чаша портала'); continue }
      if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
      if (!(SITTING.has(ph) && blindKnown(sitRec)) && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
      if (!brave && inClouds(clouds, feet, 1.0)) { no('облако'); continue }
      const eye = feet.offset(0, EYE, 0)
      // Первая кровать посадки — не выше cap (сидячий счёт > 50 — сразу взлёт).
      const xs = bedOpts(hp0, feet, y, 3.6).sort((a, b) => (b.expect - (cap != null && b.expect > cap ? (b.expect - cap) * 3 : 0)) - (a.expect - (cap != null && a.expect > cap ? (a.expect - cap) * 3 : 0))).slice(0, 4)
      const csAll = bedOpts(hpC, feet, y, 4.2)
      if (!xs.length) { no('нет места под головой'); continue }
      if (!csAll.length) { no('нет места для C'); continue }
      const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
      for (const X of xs) {
        // C — не ближе двух клеток к X (между ними щит).
        const cs = csAll.filter(C => ![C.F, C.H].some(a => [X.F, X.H].some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))).slice(0, 4)
        for (const C of cs) {
          if (skip && skip.has(`${X.H.x},${X.H.z}|${C.H.x},${C.H.z}`)) continue
          const xc = [X.F, X.H]; const cc = [C.F, C.H]
          if (xc.some(a => cc.some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))) { no('кровати тесно'); continue }
          const key = c => `${c.x},${c.z}`
          const taken = new Set([...xc, ...cc, S].map(key))
          // Стенка — клетки у нашей (8 соседей), через которые идут отрезки к кроватям.
          const walls = new Map()
          for (const t of [...xc, ...cc]) {
            for (const w of cellsOnSeg({ x: feet.x, z: feet.z }, { x: t.x + 0.5, z: t.z + 0.5 })) {
              if (Math.max(Math.abs(w.x - S.x), Math.abs(w.z - S.z)) === 1 && !taken.has(key(w))) walls.set(key(w), w)
            }
          }
          // Щит между X и C — клетки на отрезках от центра X к клеткам C.
          const shield = new Map()
          for (const t of cc) for (const w of cellsOnSeg({ x: X.H.x + 0.5, z: X.H.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          for (const t of cc) for (const w of cellsOnSeg({ x: X.F.x + 0.5, z: X.F.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          if (!shield.size) { no('щиту нет места'); continue }
          // Крышка облака огня: мы в круге облака — его колонка в два блока (облако
          // ляжет на её верх, выше нас).
          let lid = null
          if (breath && Math.hypot(feet.x - breath.pos.x, feet.z - breath.pos.z) < BREATH_R + 1) {
            const bc = breath.column
            if (taken.has(key(bc)) || walls.has(key(bc))) { no('крышка на клетке станции'); continue }
            const gy = standY(bot, bc.x + 0.5, bc.z + 0.5, y, 2, 3)
            if (gy == null) { no('крышка: нет земли'); continue }
            const h = Math.max(2, Math.ceil(y + 1.85 - gy))
            lid = { x: bc.x, z: bc.z, y: gy, h }
          }
          // Что поставить: всё должно встать в воздух (или уже стоять).
          const place = []
          let bad = false
          const want = (x, yy, z) => { const b = at(x, yy, z); if (!b) { bad = true; return } if (solidOk(b)) return; if (!bedCellFree(b)) { bad = true; return } place.push(new Vec3(x, yy, z)) }
          for (const w of walls.values()) want(w.x, y, w.z)
          for (const w of shield.values()) want(w.x, y, w.z)
          if (lid) for (let k = 0; k < lid.h; k++) want(lid.x, lid.y + k, lid.z)
          if (bad) { no('клетка стенки/щита занята'); continue }
          for (const w of walls.values()) if (!isAirish(at(w.x, y + 1, w.z))) bad = true
          if (bad) { no('над стенкой блок'); continue }
          // Каждый блок ставится честно: грань опоры видно из глаз и до неё ≤ 4.5
          const placeSet = new Set(place.map(p => `${p.x},${p.y},${p.z}`))
          const lidSet = new Set(lid ? Array.from({ length: lid.h }, (_, k) => `${lid.x},${lid.y + k},${lid.z}`) : [])
          const seye = feet.offset(0, SNEAK_EYE, 0)
          if (place.some(p => lidSet.has(`${p.x},${p.y},${p.z}`) && !placeSet.has(`${p.x},${p.y - 1},${p.z}`) && !fillPlaceable(bot, p, seye))) { no('до крышки не дотянуться'); continue }
          // Виртуальный мир: стенка, щит, крышка, кровати.
          const extra = new Map()
          const put = (x, yy, z, v) => extra.set(`${x},${yy},${z}`, v)
          // Кровати ставятся после крышки и досыпки, до щита и стенки: пол под
          // изножьями должен быть виден и с крышкой (b3-25: «C: пол под изножьем не видно»).
          if (lid) for (let k = 0; k < lid.h; k++) put(lid.x, lid.y + k, lid.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          {
            const vb0 = virtualBot(bot, extra)
            const up = new Vec3(0, 1, 0)
            if (!C.reuse && !pick.faceAim(vb0, new Vec3(C.F.x, y - 1, C.F.z), up, { eye, avoid: [] })) { no('пол под C не видно'); continue }
            for (const c of cc) put(c.x, y, c.z, 'bed')
            if (!X.reuse && !pick.faceAim(virtualBot(bot, extra), new Vec3(X.F.x, y - 1, X.F.z), up, { eye, avoid: [] })) { no('пол под X не видно'); continue }
            // Щит и стенка — после кроватей: грань опоры каждого видна и ≤ 4.5
            // (b3: «щит не встал — не к чему прислонить», щит за кроватью).
            for (const c of xc) put(c.x, y, c.z, 'bed')
            const vb1 = virtualBot(bot, extra)
            const later = place.filter(p => !lidSet.has(`${p.x},${p.y},${p.z}`)).sort((a, b) => (walls.has(`${a.x},${a.z}`) ? 1 : 0) - (walls.has(`${b.x},${b.z}`) ? 1 : 0))
            let unreach = false
            for (const p of later) {
              if (!fillPlaceable(vb1, p, feet.offset(0, SNEAK_EYE, 0))) { unreach = true; break }
              put(p.x, p.y, p.z, 'block')
            }
            if (unreach) { no('до щита/стенки не дотянуться'); continue }
          }
          for (const p of place) put(p.x, p.y, p.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          for (const c of xc) put(c.x, y, c.z, 'bed')
          for (const c of cc) put(c.x, y, c.z, 'bed')
          const vb = virtualBot(bot, extra)
          const far = (T) => cardOf(T.H.x + 0.5 - feet.x, T.H.z + 0.5 - feet.z)
          if (!bedPointFrom(vb, eye, [X.H, X.F], y, far(X))) { no('X не видно'); continue }
          // X взорвалась: её клетки — воздух.
          for (const c of xc) put(c.x, y, c.z, 'air')
          if (!bedPointFrom(vb, eye, [C.H, C.F], y, far(C))) { no('C не видно'); continue }
          if (lowRowsOpen(vb, feet, X.centre) > 0) { no('взрыв X видит нас'); continue }
          // C цела после X: все лучи от центра X к кровати C упираются в блоки.
          let cOpen = false
          for (const c of cc) for (const hy of [0.12, 0.45]) {
            const q = new Vec3(c.x + 0.5, y + hy, c.z + 0.5)
            const dv = q.minus(X.centre); const len = dv.norm()
            const hit = pick.blockOnRay(vb, X.centre, dv.scaled(1 / len), len - 0.05)
            if (!hit || /_bed$/.test(hit.block.name)) cOpen = true
          }
          if (cOpen) { no('щит не закрывает C'); continue }
          for (const c of cc) put(c.x, y, c.z, 'air')
          if (lowRowsOpen(vb, feet, C.centre) > 0) { no('взрыв C видит нас'); continue }
          const nPlace = place.length + (X.fill ? 1 : 0) + (C.fill ? 1 : 0)
          const xOver = cap != null && X.expect > cap ? (X.expect - cap) * 3 : 0
          const cost = -(X.expect + C.expect) + xOver + nPlace * 0.7 + walk * 1.2
          if (!best || cost < best.cost) {
            best = { S, y, feet, X, C, walls: [...walls.values()], shield: [...shield.values()], lid, place, nPlace, walk: r1(walk), cost, key: `${X.H.x},${X.H.z}|${C.H.x},${C.H.z}` }
          }
        }
      }
    }
  }
  bedsDouble.why = best ? null : why
  return best
}
declare namespace bedsDouble {
  let why: any
}

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

async function ocTakeoffRun (session, ctl, rep, stats, track, P, tkP) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const rec = sitRec
  const t0 = rec && !rec.ended ? rec.t0 : gameClock.now()
  const el = () => gameClock.now() - t0
  const sitting = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  const out = { A: null, T1: null, T2: null, why: null }
  try {
    // A
    if (tkP.A && el() < 2200 && sitting()) {
      const A = tkP.A
      const g = await bedsGo(session, ctl, A, true, partsOf(bot, dragonOf(bot), track))
      if (g.ok) {
        ctl.holdStation = true
        let b
        try { b = await bedsBuild(session, ctl, stats, A) } finally { ctl.holdStation = false }
        while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
        const hit = b.ok && sitting() ? bedClickPoint(bot, A) : null
        if (hit) { const bo = await bedsBoom(session, ctl, stats, A, hit, 'сидит', { note: { oc: 'A' } }); if (bo.ok) { out.A = bo.dmg; P.beds.push(bo.dmg) } }
      }
    }
    if (!sitting()) { out.why = 'взлетел до T1'; return out }
    // T1: станция L заново (опора/заслон, если снесло, кровать), в окоп
    const danger = () => (!sitting() ? 'взлетел' : el() > 4500 ? 'не успеть до взлёта' : null)
    ctl.holdStation = true
    let tb
    try { tb = await tsBuild(session, ctl, stats, tkP.plan, danger, null) } finally { ctl.holdStation = false }
    if (!tb.ok) { out.why = `T1: ${tb.why}`; return out }
    const hit1 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.plan)
    const hit2p = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2)
    if (!hit1) { out.why = 'T1 не видно'; return out }
    await lookAtSafe(bot, hit1.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'tk:wait')
    // сам-взлёт: фаза TAKEOFF
    const tw = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tw < 6000) {
      const dd = dragonOf(bot)
      if (!dd) break
      const ph = phaseOf(bot, dd)
      if (ph === PHASE.TAKEOFF) break
      if (!SITTING.has(ph)) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; return out }
      await sleep(5)
    }
    const tT1 = gameClock.now()
    const d1 = dragonOf(bot)
    if (!d1 || phaseOf(bot, d1) !== PHASE.TAKEOFF) { out.why = 'взлёта не дождался'; return out }
    const b1 = await bedsBoom(session, ctl, stats, tkP.plan, hit1, 'взлёт', { aimed: true, uncounted: true, note: { oc: 'T1', headDist: r1(tkP.path[1].head.distanceTo(tkP.plan.centre)) } })
    if (b1.ok) { out.T1 = b1.dmg; P.beds.push(b1.dmg) }
    // T2
    const hit2 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2) || hit2p
    if (!hit2) { out.why = 'T2 не видно'; return out }
    await lookAtSafe(bot, hit2.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const tT2 = tT1 + 50 * (tkP.T2.i0 - 1) - 30
    const b2 = await bedsBoom(session, ctl, stats, { ...tkP.T2, reuse: true }, hit2, 'взлёт', { aimed: true, until: Math.max(tT2, (stats.lastBoom || 0) + BED_GAP_MS), uncounted: true, note: { oc: 'T2', headDist: r1(tkP.path[tkP.T2.i0].head.distanceTo(tkP.T2.centre)) } })
    if (b2.ok) { out.T2 = b2.dmg; P.beds.push(b2.dmg) }
    return out
  } finally {
    ev('ocTkRun', out)
    // из окопа
    const q = bot.entity.position
    if (tkP.plan && Math.floor(q.y + 0.01) < tkP.plan.G && Math.floor(q.x) === tkP.plan.B.x && Math.floor(q.z) === tkP.plan.B.z) { await build.towerUp(bot, ctl, tkP.plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function ocT1 (session, ctl, stats, track, d, rec, P) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out: any = { why: null }
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const fx = sitFix.get(d.id)
    if (!fx || !fx.sit) { out.why = 'нет сидячего состояния'; return out }
    const S = simClone(fx.sit)
    S.x = d.position.x; S.y = d.position.y; S.z = d.position.z; S.yRot = yRotOf(d.yaw)
    for (const pu of fx.pushes || []) { const q = blastPush(S, pu.centre, pu.seen); S.vx += q.x; S.vy += q.y; S.vz += q.z }
    S.hist = new Array(12).fill(S.y); S.inWall = false
    const nodes = dragonNodes(bot)
    const node = nodes && takeoffNode(nodes, S)
    if (!node) { out.why = 'узел взлёта не найден'; return out }
    const path = takeoffForecast(S, node, 4)
    const target = path[0].head
    const sitHead = simHead(S, true); const sitNeck = simNeck(S, true)
    const fcT = { n: 3, path: [{ k: 0, head: path[0].head, neck: path[0].neck, pos: path[0].pos, yRot: path[0].yRot }], sit: S, head: sitHead, neck: sitNeck }
    const sitP = predParts(fcT)
    const left = () => rec.t0 + 4950 - gameClock.now()
    if (left() < 2300) { out.why = `некогда (${left()} мс)`; return out }
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      const all = []
      tsPlan(bot, target, { lift, fc: fcT, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
      all.push(...(tsPlan.all || []))
      for (const c of all.sort((a, b) => a.cost - b.cost)) {
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { why['в сидячих коробках'] = (why['в сидячих коробках'] || 0) + 1; continue }
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5))) { why['место ставки у шеи'] = (why['место ставки у шеи'] || 0) + 1; continue }
        if (!plan || c.cost < plan.cost) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, node: [node.x, node.z] } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, () => (!sittingNow() ? 'взлетел' : null), null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'oc:waitT1')
    const tw = gameClock.now()
    let took = false
    while (!ctl.aborted && gameClock.now() - tw < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.TAKEOFF) { took = true; break }
      if (!SITTING.has(ph)) break
      await sleep(3)
    }
    out.wait = gameClock.now() - tw
    if (!took) { out.why = 'взлёта не дождался'; return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'взлёт', { aimed: true, uncounted: true, phCheck: p => p === PHASE.TAKEOFF, note: { oc: 'T1', headDist: plan.dist } })
    out.dmg = r.ok ? r.dmg : null
    if (r.ok) P.beds.push(r.dmg); else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('ocT1', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'oc:outT1'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function seeStation (session, ctl, stats, track, d, P, { cap = null }: any = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out: any = { cap }
  try {
    const fx = sitFix.get(d.id)
    const S = { x: d.position.x, y: d.position.y, z: d.position.z, yRot: yRotOf(d.yaw), yRotA: fx ? fx.yRotA : 0, vx: 0, vy: 0, vz: 0, hist: new Array(12).fill(d.position.y) }
    const head = simHead(S, true); const neck = simNeck(S, true)
    const fcS = { n: 0, path: [], sit: S, head, neck }
    const sitP = predParts(fcS)
    const ux = head.x - S.x; const uz = head.z - S.z; const ul = Math.hypot(ux, uz) || 1
    const cloud = { x: head.x + ux / ul * 2.5, z: head.z + uz / ul * 2.5 }
    const inCloud = p => Math.hypot(p.x - cloud.x, p.z - cloud.z) < 5.6
    const Ptop = podiumTop(bot)
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      tsPlan(bot, head, { lift, fc: fcS, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
      for (const c of (tsPlan.all || []).sort((a, b) => b.expect - a.expect)) {
        const no = k => { why[k] = (why[k] || 0) + 1 }
        if (c.psLift) { no('свой блок'); continue }
        if (Ptop != null && c.yb > Ptop - 1) { no('выше P − 1'); continue }
        if (cap != null && c.expect > cap) { no('больше потолка'); continue }
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('в сидячих коробках'); continue }
        const bG = new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5)
        // с запасом: тело прыгает (+1.25) и стоит на своём блоке; голова/шея бьют 10 (fin5-19: смерть у шеи)
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(bG)) { no('у головы/шеи'); continue }
        if (inCloud(c.ground) || inCloud(bG)) { no('в облаке'); continue }
        if (!plan || c.expect - c.cost * 0.05 > plan.expect - plan.cost * 0.05) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, depth: plan.depth } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    const sittingSettled = () => { const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null; return !dd ? 'нет дракона' : !SITTING.has(ph) ? 'взлетел' : ph === PHASE.SCANNING ? 'высматривает' : null }
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, sittingSettled, null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    if (sittingSettled()) { out.why = sittingSettled(); return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p) && p !== PHASE.SCANNING, note: { oc: cap != null ? 'SA' : 'SB', headDist: plan.dist } })
    if (r.ok) { out.dmg = r.dmg; P.beds.push(r.dmg) } else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('seeStation', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'see:out'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function standAt (session, ctl, feet) {
  const bot = session.bot
  standAt.why = null; standAt.step = null
  for (let k = 0; k < 3 && bot.entity.position.distanceTo(feet) > 0.6; k++) {
    if (fbAlarm(bot)) { standAt.why = 'фаербол'; return false }
    // чаша фонтана — портал (пока дракон жив, неактивен): шагать в неё можно (portal: true)
    // |Δy| > 0.6 — маршрут и к близкой цели на другом ярусе (Codex fr1-fix: 83 «к столбику не дошёл»); не проверено боями — только при ND_RUNNER=1
    if (bot.entity.position.distanceTo(feet) > 3 || (runnerOn() && Math.abs(bot.entity.position.y - feet.y) > 0.6)) await walkTo(session, ctl, feet, { range: 0.4, timeoutMs: 9000, portal: true }).catch(() => {})
    const st1 = await stepTo(bot, ctl, feet, { ms: 1500, sprint: false, stopAt: 0.12, portal: true })
    if (st1 && st1.why) standAt.step = st1.why
    clearControls(bot)
  }
  for (let k = 0; k < 3 && !fbAlarm(bot) && Math.hypot(bot.entity.position.x - feet.x, bot.entity.position.z - feet.z) > 0.15; k++) { const st2 = await stepTo(bot, ctl, feet, { ms: 600, sprint: false, stopAt: 0.06, portal: true }); if (st2 && st2.why) standAt.step = st2.why; clearControls(bot) }
  for (let j = 0; j < 12 && !bot.entity.onGround; j++) await sleep(50)
  const q = bot.entity.position
  // в своей клетке на нужном ярусе и на земле — годится (столбик/ставка от середины клетки не зависят)
  if (bot.entity.onGround && Math.floor(q.x) === Math.floor(feet.x) && Math.floor(q.z) === Math.floor(feet.z) && Math.abs(q.y - feet.y) < 0.5) return true
  if (q.distanceTo(feet) <= 0.8) return true
  standAt.why = `стою ${r1(q.x)},${r1(q.y)},${r1(q.z)} — цель ${r1(feet.x)},${r1(feet.y)},${r1(feet.z)}${bot.entity.onGround ? '' : ', в воздухе'}${standAt.step ? ` (шаг: ${standAt.step})` : ''}`
  return false
}
declare namespace standAt {
  let why: any
  let step: any
}

async function placeFrom (session, ctl, cell, world, itemRe) {
  const bot = session.bot
  standFor(bot, cell, world)
  const list = (standFor.all || []).slice(0, 4)
  if (!list.length) return { ok: false, reason: 'негде встать' }
  let last = null
  for (const st of list) {
    if (!(await standAt(session, ctl, st.feet))) { last = 'не дошёл'; continue }
    const r = itemRe ? await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe) : await placeNoBed(bot, new Vec3(cell.x, cell.y, cell.z), { timeoutMs: 1500 })
    if (r.ok) return { ok: true }
    last = r.reason
  }
  return { ok: false, reason: last }
}

async function placeHigh (session, ctl, cell, world, itemRe, plan, lap, extra: any = []) {
  const bot = session.bot
  const solidW = (x, y, z) => world.get(`${x},${y},${z}`) === 'block' || isSolid(bot.blockAt(new Vec3(x, y, z)))
  const y1 = cell.y - 1
  const up = extra.length
  const forbid = new Set([`${plan.H.x},${plan.yb},${plan.H.z}`, `${plan.F.x},${plan.yb},${plan.F.z}`])
  // столбик не на окопе бота (и не рядом с ним по оси взгляда — заслоны/окоп)
  if (plan.B) for (let y = y1 - 6; y <= y1 + 2; y++) forbid.add(`${plan.B.x},${y},${plan.B.z}`)
  // 1) опора под клеткой: путь по ярусу y1 от твёрдого (BFS ≤ 4 шагов, r ≤ 3.5)
  const chainHigh = []
  if (!solidW(cell.x, y1, cell.z)) {
    const start = `${cell.x},${cell.z}`
    const prev = new Map([[start, null]])
    let q = [start]; let found = null
    for (let d = 0; d < 4 && q.length && !found; d++) {
      const nq = []
      for (const k of q) {
        const [x, z] = k.split(',').map(Number)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx; const nz = z + dz; const nk = `${nx},${nz}`
          if (prev.has(nk) || Math.hypot(nx + 0.5, nz + 0.5) > 4) continue
          prev.set(nk, k)
          if (solidW(nx, y1, nz)) { found = nk; break }
          if (!isAirish(bot.blockAt(new Vec3(nx, y1, nz)))) continue
          nq.push(nk)
        }
        if (found) break
      }
      q = nq
    }
    if (!found) return { ok: false, reason: 'опору под клеткой не к чему прислонить' }
    // клетки пути от соседа найденного твёрдого до клетки под целью
    for (let k = prev.get(found); k; k = prev.get(k)) chainHigh.push(k)
  }
  const Ptop = plan.P ?? plan.yb + 1
  // ярус ниже верха столба — с земли к боковым граням; выше — со столбика (снизу не дотянуться)
  if (y1 < Ptop) {
    for (const k of chainHigh.splice(0)) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const r = await placeFrom(session, ctl, { x, y: y1, z }, world, FILLER_RE)
      if (!r.ok) return { ok: false, reason: `опора ${x},${y1},${z}: ${r.reason}` }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
  }
  for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); for (let y = y1; y <= y1 + 2; y++) forbid.add(`${x},${y},${z}`) }
  // 2) столбик рядом: ноги на y1, верх опоры виден
  let tower = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const tx = cell.x + dx; const tz = cell.z + dz
    if (tx === 0 && tz === 0) continue
    let bad = false
    for (let y = y1; y <= y1 + 2 + up; y++) if (forbid.has(`${tx},${y},${tz}`) || world.get(`${tx},${y},${tz}`) === 'block') bad = true
    if (bad) continue
    const s = surfaceY(virtualBot(bot, world), tx + 0.5, tz + 0.5, y1)
    if (!s || s.y > y1 || s.y < y1 - 5) continue
    let clear = true
    for (let y = s.y; y <= y1 + 2 + up; y++) { const b = bot.blockAt(new Vec3(tx, y, tz)); if (b && isSolid(b) && world.get(`${tx},${y},${tz}`) !== 'air') { clear = false; break } }
    if (!clear) continue
    const wT = new Map(world)
    for (let y = s.y; y < y1 + up; y++) wT.set(`${tx},${y},${tz}`, 'block')
    for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); wT.set(`${x},${y1},${z}`, 'block') }
    const eye = new Vec3(tx + 0.5, y1 + up + SNEAK_EYE, tz + 0.5)
    if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, y1, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) continue
    // клетки сверху — каждая к верхней грани предыдущей, с того же места
    let upOk = true
    for (let i = 0; i < up && upOk; i++) { wT.set(`${cell.x},${cell.y + i},${cell.z}`, 'block'); if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, cell.y + i, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) upOk = false }
    if (!upOk) continue
    tower = { x: tx, z: tz, ground: s.y }
    break
  }
  if (!tower) return { ok: false, reason: 'некуда поставить столбик' }
  // наверху голова открыта. Раньше — только пока дракон кружит (HOLDING); у фонтана он то и дело заходит с фаерболом
  const calm = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : PHASE.HOLDING
    if (ph === PHASE.HOLDING) return !fbAlarm(bot) && !hazardNow(bot)
    if (!TOWER_FAR || !dd || (ph !== PHASE.STRAFE && ph !== PHASE.APPROACH)) return false
    const me = bot.entity.position
    if (Math.hypot(dd.position.x - me.x, dd.position.z - me.z) < TOWER_FAR) return false
    return !fireballsOf(bot).length && !hazardNow(bot)
  }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  doing(ctl, 'pillar:tower')
  lap.towerAt = [tower.x, tower.ground, tower.z, up]
  if (!(await standAt(session, ctl, new Vec3(tower.x + 0.5, tower.ground, tower.z + 0.5)))) { lap.towerMiss = standAt.why; return { ok: false, reason: 'к столбику не дошёл' } }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  const abortIf = () => hunters(bot, 5).length ? 'эндермен бьёт' : bot.health < 10 ? 'мало хп' : !calm() ? 'дракон не кружит' : null
  const t = await fastTower(bot, ctl, y1 + up, { maxMs: 12000, abortIf })
  lap.tower = { ok: t.ok, placed: t.placed, why: t.why || null }
  let r: any = { ok: false, reason: `столбик: ${t.why}` }
  if (Math.floor(bot.entity.position.y + 0.01) >= y1 + up) {
    r = { ok: true }
    for (const k of chainHigh) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const rc = await placeItemAt(bot, new Vec3(x, y1, z), FILLER_RE)
      if (!rc.ok) { r = { ok: false, reason: `опора ${x},${y1},${z} со столбика: ${rc.reason}` }; break }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
    if (r.ok) r = await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe)
    for (const e of extra) {
      if (!r.ok) break
      world.set(`${cell.x},${cell.y},${cell.z}`, 'block')
      r = await placeItemAt(bot, new Vec3(e.x, e.y, e.z), e.filler ? FILLER_RE : itemRe)
      if (r.ok) { world.set(`${e.x},${e.y},${e.z}`, 'block'); lap.placed.push([e.x, e.y, e.z]); e.done = true } else r = { ...r, reason: `над ней ${e.x},${e.y},${e.z}: ${r.reason}` }
    }
  }
  // вниз — всегда (раньше тот же abortIf с «не кружит» оставлял бота на столбике под фаерболом)
  await digDownTo(bot, ctl, tower.ground, 8, () => hunters(bot, 5).length ? 'эндермен бьёт' : null).catch(() => {})
  return r
}

async function runnerClean (session, ctl, plan) {
  const bot = session.bot
  const P = plan.P, s = plan.F.z, G = plan.G
  const cells = []
  for (let y = P - 2; y >= G; y--) cells.push(new Vec3(0, y, s))
  for (let y = G + 1; y >= G; y--) cells.push(new Vec3(0, y, 2 * s))
  const filled = () => cells.filter(c => { const b = bot.blockAt(c); return b && FILLER_RE.test(b.name) })
  let n = 0
  for (let k = 0; k < 8 && filled().length; k++) {
    const q = bot.entity.position
    const under = new Vec3(Math.floor(q.x), Math.floor(q.y + 0.01) - 1, Math.floor(q.z))
    const top = filled().sort((a, b) => b.y - a.y)[0]
    if (filled().some(c => c.equals(under))) { await digDownTo(bot, ctl, under.y, 1, () => hunters(bot, 5).length ? 'эндермен' : null).catch(() => {}); n++; continue }
    const b = bot.blockAt(top)
    const eye = q.offset(0, EYE, 0)
    if (eye.distanceTo(top.offset(0.5, 0.5, 0.5)) > 4.3) { await walkTo(session, ctl, new Vec3(top.x + 0.5, G, top.z + 0.5), { range: 2.5, timeoutMs: 6000, portal: true }).catch(() => {}); continue }
    try { const tool = findItem(bot, /_pickaxe$/); if (tool) await bot.equip(tool, 'hand'); await build.withTimeout(bot.dig(b, true, 'raycast'), 3000); n++ } catch (e) { bot.stopDigging(); break }
  }
  return { cleared: n, left: filled().length }
}

async function pillarBuild (session, ctl, stats, plan) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const lap: any = { placed: [], scaffold: 0 }
  const res = r => { ev('pillarBuild', { ok: r.ok, why: r.why || null, ms: gameClock.now() - t0, ...lap }); return r }
  const OBS_RE = /^(obsidian|crying_obsidian)$/
  const runner = runnerOn() && plan.runner
  const cells = runner ? plan.cells.filter(c => OBS_RE.test(c[3])).map(c => ({ x: c[0], y: c[1], z: c[2] })) : []
  for (const c of plan.supCob || []) cells.push({ x: c[0], y: c[1], z: c[2], filler: true })
  for (const c of plan.sup || []) cells.push({ x: c[0], y: c[1], z: c[2] })
  if (plan.place.obsidian) cells.push({ x: plan.place.K.x, y: plan.place.K.y, z: plan.place.K.z })
  for (const o of plan.obs) cells.push({ x: o[0], y: o[1], z: o[2] })
  if (countOf(bot, OBS_RE) < cells.filter(c => !c.filler && !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')).length) return res({ ok: false, why: 'мало обсидиана' })
  const world = new Map()
  // Частичная/готовая R: не ставить уже имеющиеся обсидианы, даже при пустом рюкзаке.
  const left = cells.filter(c => {
    if (!runner || !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')) return true
    world.set(`${c.x},${c.y},${c.z}`, 'block'); return false
  })
  // Бьёт эндермен или мало хп — бросить стройку, пусть бой отобьётся/поест (pil6-20: смерть в окопе — эндермен
  const abortIf = () => { if (hunters(bot, 5).length) return 'эндермен бьёт'; if (bot.health < 10) return 'мало хп'; const hz = hazardNow(bot); return hz ? `опасно: ${hz.kind || 'угроза'}` : null }
  for (let guard = 0; left.length && guard < 20; guard++) {
    // st2-s5: одна стройка шла 74.6 с (до 4 мест ставки × 3 маршрута по 9 с) — дольше BUILD_MAX — бросить, план заново
    if (BUILD_MAX_MS && gameClock.now() - t0 > BUILD_MAX_MS) return res({ ok: false, why: 'стройка долго' })
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if ((ph === PHASE.APPROACH && !approachFar(dd)) || ph === PHASE.LANDING || SITTING.has(ph)) return res({ ok: false, why: 'дракон садится — потом' })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    // клетка, которую можно поставить сейчас (есть сосед с видимой гранью откуда-то)
    let pick0 = null
    // клетка на высоте верха столба и выше (подушка над столбом) — со столбика, не «лесом»
    const Ptop = plan.P ?? plan.yb + 1
    for (const c of left) { if (c.y >= Ptop) continue; const st = standFor(bot, c, world); if (st) { pick0 = { c, st }; break } }
    const hi = !pick0 && left.find(c => c.y >= Ptop)
    if (hi) {
      // R: клетки над hi (K на P + 1) — с того же столбика
      const extra = []
      if (runner && RUN_TOWER1()) for (let y = hi.y + 1; ; y++) { const e = left.find(c => c.x === hi.x && c.z === hi.z && c.y === y); if (!e) break; extra.push(e) }
      const r = await placeHigh(session, ctl, hi, world, hi.filler ? FILLER_RE : OBS_RE, plan, lap, extra)
      for (const e of extra) if (e.done) left.splice(left.indexOf(e), 1)
      if (!r.ok) return res({ ok: false, why: `высоко ${hi.x},${hi.y},${hi.z}: ${r.reason}` })
      world.set(`${hi.x},${hi.y},${hi.z}`, 'block'); lap.placed.push([hi.x, hi.y, hi.z])
      left.splice(left.indexOf(hi), 1)
      continue
    }
    if (!pick0) {
      // лес: под первой клеткой — столбик булыжника от твёрдого снизу
      const c = left[0]
      let y = c.y - 1
      while (y > c.y - 6 && !isSolid(bot.blockAt(new Vec3(c.x, y, c.z)))) y--
      if (y <= c.y - 6) return res({ ok: false, why: `клетке ${c.x},${c.y},${c.z} не к чему прислониться` })
      const sc = { x: c.x, y: y + 1, z: c.z }
      const r = await placeFrom(session, ctl, sc, world, null)
      if (!r.ok) return res({ ok: false, why: `лес: ${r.reason}` })
      world.set(`${sc.x},${sc.y},${sc.z}`, 'block'); lap.scaffold++
      continue
    }
    const { c } = pick0
    const r = await placeFrom(session, ctl, c, world, c.filler ? FILLER_RE : OBS_RE)
    if (!r.ok) { lap.faceFail = (lap.faceFail || 0) + 1; if (lap.faceFail > 2) return res({ ok: false, why: `обсидиан ${c.x},${c.y},${c.z}: ${r.reason}` }); continue }
    world.set(`${c.x},${c.y},${c.z}`, 'block'); lap.placed.push([c.x, c.y, c.z])
    left.splice(left.indexOf(c), 1)
  }
  if (left.length) return res({ ok: false, why: 'не всё поставлено' })
  if (runner) {
    const cl0 = await runnerClean(session, ctl, plan)
    if (cl0.cleared || cl0.left) lap.clean = cl0
    if (cl0.left) return res({ ok: false, why: `R: в чаше свои блоки (${cl0.left})` })
  }
  if (runner) for (const c of plan.cells.filter(c => c[3] === 'air')) {
    const pos = new Vec3(c[0], c[1], c[2]), b = bot.blockAt(pos)
    if (b && /^(air|cave_air|void_air)$/.test(b.name)) continue
    // свой блок (рефлекс от облака кладёт булыжник под ноги — rs8-s1: бот стоял в клетке факела на своём блоке) — снять, как факел
    if (!b || !(/^(torch|wall_torch)$/.test(b.name) || FILLER_RE.test(b.name))) return res({ ok: false, why: `R: клетка факела занята (${b && b.name})` })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    if (!(await standAt(session, ctl, plan.feet))) { lap.torchMiss = standAt.why; return res({ ok: false, why: 'R: к факелу не дошёл' }) }
    if (bot.entity.position.offset(0, EYE, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) return res({ ok: false, why: 'R: факел далеко' })
    try {
      const tool = findItem(bot, /_pickaxe$/)
      if (tool) await bot.equip(tool, 'hand'); else await bot.unequip('hand')
      // mineflayer digging.js: raycast выбирает реально видимую грань, torch hardness=0; свой булыжник — киркой (~0.5 с)
      await build.withTimeout(bot.dig(b, true, 'raycast'), FILLER_RE.test(b.name) ? 3000 : 1500)
    } catch (e) { bot.stopDigging(); return res({ ok: false, why: 'R: факел: ' + e.message }) }
    if (!/^(air|cave_air|void_air)$/.test((bot.blockAt(pos) || {}).name || '')) return res({ ok: false, why: 'R: факел остался' })
    lap.torch = [c[0], c[1], c[2]]
  }
  // Окоп A / готовая чаша R (depth 0).
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner, abortIf, feet: plan.feet }, k => doing(ctl, 'pillar:' + k), session)
  if (!tr.ok) lap.trench = { why: tr.why, ...(tr.lap || {}) }
  if (!tr.ok && /эндермен|мало хп|опасно/.test(tr.why || '')) return res({ ok: false, why: tr.why })
  if (!tr.ok) {
    // окоп не той глубины / не по центру — но с этого места станция годится? (pil5: «не спустился» ×9)
    const here = pillarHere(bot, plan)
    if (!here) return res({ ok: false, why: `окоп: ${tr.why}` })
    lap.here = { y: here.feet.y, expo: r1(here.expo * 100) / 100 }
    plan.feet = here.feet; plan.dig = Math.max(0, plan.G - here.feet.y); plan.G = here.feet.y + plan.dig
  }
  ctl.pillar = { plan, built: true, t: gameClock.now(), booms: 0 }
  return res({ ok: true })
}

async function pillarEnter (session, ctl, plan) {
  const bot = session.bot
  // R: рефлекс мог сложить свои блоки в чаше после постройки станции — снять до входа
  if (runnerOn() && plan.runner && !hunters(bot, 5).length) { const cl = await runnerClean(session, ctl, plan); if (cl.cleared && ctl.trace) ctl.trace.ev('runnerClean', cl) }
  const q = bot.entity.position
  const inB = Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.abs(q.y - plan.feet.y) < 0.3
  if (inB) return true
  if (pillarHere(bot, plan)) return true
  if (hunters(bot, 5).length) return false
  const bc = new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // 03.10: от точки выстрела по кристаллам (до 30 от центра) — бегом и с запасом по времени (ND_ENTER_RUN=0 — шагом, 8 с)
  const farB = Math.hypot(q.x - bc.x, q.z - bc.z)
  const runE = envv('ND_ENTER_RUN') !== '0' && farB > 8
  await walkTo(session, ctl, bc, { range: 0.5, timeoutMs: runE ? Math.min(16000, 6000 + farB * 300) : 8000, portal: true, sprint: runE })
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner: runnerOn() && plan.runner, feet: plan.feet, abortIf: () => hunters(bot, 5).length ? 'эндермен бьёт' : null }, k => doing(ctl, 'pillar:' + k), session)
  return tr.ok || !!pillarHere(bot, plan)
}

async function pillarRun (session, ctl, stats, track, feed) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const st = ctl.pillar
  let plan = st.plan
  const runnerLevels = plan.runnerLevels
  const P = podiumTop(bot)
  const out: any = { booms: [], why: null }
  const t0 = gameClock.now()
  let H = plan.H; let F = plan.F; let yb = plan.yb
  const bedHere = () => /_bed$/.test((bot.blockAt(new Vec3(H.x, yb, H.z)) || {}).name || '') && /_bed$/.test((bot.blockAt(new Vec3(F.x, yb, F.z)) || {}).name || '')
  const bedCells = [{ x: F.x, y: yb, z: F.z }, { x: H.x, y: yb, z: H.z }]
  // Якорь возрождения (если есть якоря и светокамень): взрыв той же силы, дракон его не ломает (dragon_immune) —
  const Apos = new Vec3(F.x, yb, F.z)
  const Acentre = new Vec3(F.x + 0.5, yb + 0.5, F.z + 0.5)
  const anMode = process.env.ND_PILLAR_ANCHOR || 'last'
  const anchorAt = () => anchorCharges(bot, Apos)
  const torchSetP = new Set(pillarCells(plan.P ?? yb + 1).torches.map(t => `${t.x},${t.y},${t.z}`))
  const torchHitP = (eye, d, len) => { if (runnerLevels) return false; for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (torchSetP.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  const anClick = (vb) => { const eye = bot.entity.position.offset(0, EYE, 0); for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { const c = faceClick(vb, eye, Apos, new Vec3(f[0], f[1], f[2]), { reach: 4.3, avoidTorch: torchHitP }); if (c) return { point: c.point, face: new Vec3(f[0], f[1], f[2]) } } return null }
  // F ближе к окопу, чем H, и закрыт хуже (pil7-22: 1–1.5 хп нам за якорь против 0.3 за кровать) — при хп < 12 только кровати
  const recenter = async () => {
    out.recenter = (out.recenter || 0) + 1
    if (out.recenter > (runnerLevels ? 12 : 3)) return false
    const q = bot.entity.position
    await stepTo(bot, ctl, runnerLevels ? new Vec3(plan.feet.x, q.y, plan.feet.z) : new Vec3(plan.B.x + 0.5, q.y, plan.B.z + 0.5), { ms: 700, sprint: false, stopAt: 0.06, portal: true })
    clearControls(bot)
    // взрыв мог выбить эндерняк у окопа (якорь в F ближе к нам) — тогда окоп заново (глубже — подняться)
    if (!pillarHere(bot, plan)) await pillarEnter(session, ctl, plan)
    return true
  }
  const anchorOk = () => !runnerLevels && anMode !== '0' && !st.noAnchor && bot.health >= 12 && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  // Поставленная, но не взорванная кровать — тоже заряд (01.10: последняя из 7 ставилась и бросалась — «кровати кончились»
  // при 0 в рюкзаке, хотя кровать стояла у столба: 6 взрывов из 7 в 41 из 58 вызовов).
  const noBoom = () => countOf(bot, /_bed$/) < 1 && !bedHere() && !anchorOk() && anchorAt() < 1
  const cellHit = (st2) => {
    // клетки кровати в коробках головы/шеи/тела (checkWalls — по клеткам)
    const M = 0.1
    const hb = box(st2.head.x, st2.head.y - M, st2.head.z, 0.5, 1 + M); const nb = box(st2.neck.x, st2.neck.y - M, st2.neck.z, 1.5, 3 + M)
    const by = box(st2.pos.x + Math.sin(st2.yRot * DRAD) * 0.5, st2.pos.y - M, st2.pos.z - Math.cos(st2.yRot * DRAD) * 0.5, 2.5, 3 + M)
    const cellsOf = b => ({ x0: Math.floor(b.min.x), x1: Math.floor(b.max.x - 1e-7), y0: Math.floor(b.min.y), y1: Math.floor(b.max.y - 1e-7), z0: Math.floor(b.min.z), z1: Math.floor(b.max.z - 1e-7) })
    return [hb, nb, by].some(b => { const c = cellsOf(b); return bedCells.some(q => q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1 && q.z >= c.z0 && q.z <= c.z1) })
  }
  try {
    if (noBoom()) { out.why = 'кровати кончились'; return out }
    doing(ctl, 'pillar:enter')
    if (!(await pillarEnter(session, ctl, plan))) { out.why = 'в окоп не встал'; return out }
    // якорь в H с этого места щёлкается? (иначе — только кровати)
    if (anchorOk() && anchorAt() < 0 && !anClick(virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'block']])))) { st.noAnchor = true; out.anchor = 'не видно' }
    // открытость окопа взрыву в F: > 0.3 — якоря не ставить (урон нам ~2+ за взрыв)
    if (anchorOk() && !st.anExpo) { st.anExpo = exposure(bot, bot.entity.position, Acentre); out.anExpo = r1(st.anExpo * 100) / 100; if (st.anExpo > 0.3) { st.noAnchor = true; out.anchor = 'окоп открыт взрыву в F' } }
    let lastBoom = stats.lastBoom || 0
    let gapKey = null
    let keepKey = null
    const supBan = new Map()
    // снимок мира у станции R для seen (без клеток кровати и опоры под F — их форма зависит от яруса), один на цепочку
    let smSnap = null; const smCache = new Map()
    if (runnerLevels && RUN_SEEN()) {
      const t0s = gameClock.now()
      try { smSnap = smCompile(bot, [-16, P - 6, -16, 16, P + 16, 16], (x, y, z) => x === 0 && (z === 0 || z === F.z) && y >= P && y <= P + 1) } catch (e) { smSnap = null }
      out.smMs = gameClock.now() - t0s; out.smN = smSnap ? smSnap.colliders.length : null
    }
    // прогноз seen родителя и высоты тела над ярусом в тик щелчка — в событие bed (сверка с сервером, DragonLab)
    let fcNow = null
    const seenNote = (k) => {
      try {
        const st0 = fcNow && fcNow.path[k]
        if (!st0) return {}
        const o: any = { bodyDy: r1(st0.pos.y - yb) }
        if (smSnap) { const sp = smDragonSeen(smSnap, new Vec3(0.5, yb + 0.5, 0.5), st0.pos, yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY); if (sp != null) o.seenP = Math.round(sp * 1000) / 1000 }
        return o
      } catch (e) { return {} }
    }
    let pushed = null
    let placedSince = bedHere()
    // Поставленная кровать без прохода (садится/сел) — взорвать сейчас, а не отдать коробкам дракона (st1: «садится без
    const salvage = async (tag) => {
      if (!bedHere() || gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) return false
      const eye = bot.entity.position.offset(0, EYE, 0)
      let hitCell = new Vec3(plan.click.cell.x, yb, plan.click.cell.z)
      let hit = faceClick(bot, eye, hitCell, new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // плановая грань не видна (толчок сдвинул в окопе) — любая видимая грань кровати
      for (const cell of [F, H]) for (const fc of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { if (!hit) { const c3 = new Vec3(cell.x, yb, cell.z); hit = faceClick(bot, eye, c3, new Vec3(fc[0], fc[1], fc[2])); if (hit) hitCell = c3 } }
      if (!hit) { out.salvageFail = (out.salvageFail || 0) + 1; return false }
      await lookAtSafe(bot, hit.point)
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      const r = await bedsBoom(session, ctl, stats, { ...plan, dist: null, expect: null, D: plan.a, y: yb, reuse: true }, { point: hit.point, block: bot.blockAt(hitCell) }, 'снижение', { aimed: true, until: gameClock.now(), uncounted: true, phCheck: p => p === PHASE.LANDING || SITTING.has(p), note: { oc: 'P', salvage: tag } })
      out.booms.push(r.ok ? r.dmg : null)
      out.salvage = (out.salvage || 0) + 1
      if (r.ok) { lastBoom = stats.lastBoom || gameClock.now(); st.booms++; placedSince = false; pushed = null }
      return r.ok
    }
    const tEnd = gameClock.now() + 60000
    while (!ctl.aborted && gameClock.now() < tEnd) {
      const dd = dragonOf(bot)
      if (!dd) { out.why = 'дракона нет'; break }
      const ph = phaseOf(bot, dd)
      if (ph !== PHASE.LANDING) {
        out.why = `фаза ${PHASE_RU[ph] ?? ph}`
        if (!runnerLevels && SITTING.has(ph) && process.env.ND_SALVAGE !== '0') await salvage('сел')
        break
      }
      if (noBoom()) {
        // R: кровати кончились, а дракон ещё снижается и хп мало — стрела в проход головы (ND_RUN_ARROW=0 — выкл.)
        const hpNow = hpOf(bot, dd)
        if (runnerLevels && RUN_ARROW() && hpNow != null && hpNow <= envNum('ND_RUN_ARROW_HP', 30) && (out.arrows || 0) < 3) {
          out.arrows = (out.arrows || 0) + 1
          doing(ctl, 'pillar:arrow')
          const a: any = await runnerArrow(session, ctl, feed, P, lastBoom)
          ;(out.arrowLog || (out.arrowLog = [])).push(a.shot ? { ...a.shot, hpAfter: a.hpAfter } : a.why)
          continue
        }
        out.why = 'кровати кончились'; break
      }
      if ((hpOf(bot, dd) ?? 1) <= 0) break
      if (bot.health < 10 && hunters(bot, 5).length) { out.why = 'эндермен бьёт'; break }
      const hereAn = anchorAt()
      const useAn = hereAn >= 0 || (!bedHere() && anchorOk() && (anMode === 'first' || countOf(bot, /_bed$/) < 1))
      if (hereAn === 0 && countOf(bot, /^glowstone$/) < 1) { out.why = 'якорь без заряда'; break }
      // прогноз: свежий по пакетам, а сразу после взрыва — с толчком
      let fc = landingForecast(feed, P)
      if (pushed && (!fc || fc.t < pushed.after)) fc = pushed.fc
      if (!fc) { await sleep(20); continue }
      fcNow = fc
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      const minTick = Math.max(nowTick + 3, Math.ceil((lastBoom + BED_GAP_MS + 60 - fc.t) / 50))
      if (runnerLevels) {
        const q = bot.entity.position
        // толчок своего взрыва сдвигает в чаше (labR: 27 из 30 цепочек обрывались после первого взрыва) — вернуться в клетку
        if (bot.health < 10) { out.why = 'R: мало хп'; break }
        // без проверки exposure: первый взрыв сносит факелы столба, клиентский exposure считал их заслоном и рвал цепочку
        // (labR2: 16 из 17), а урон боту в чаше по серверу 0.3 за снижение
        if (!bot.entity.onGround || q.distanceTo(plan.feet) > 0.25) { if (await recenter()) continue; out.why = 'R: потеря защищённой позиции'; break }
        const danger = landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 4) }, q)
        if (danger) { out.why = 'R: ' + danger.what; break }
        // Опора под F для P + 1 — сразу после взрыва, если её снесло (labS1: P + 1 выбран лишь в 43 % взрывов — к проходу булыжник
        if (RUN_KEEPCOB() && keepKey !== lastBoom && !bedHere() && runnerLevels.some(p => p.yb > P) && gameClock.now() - (lastBoom || 0) > 120 && !supBan.has('keep')) {
          keepKey = lastBoom
          const sb = bot.blockAt(new Vec3(0, P, F.z))
          if (isAirish(sb) && !landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 8) }, q)) {
            const ok = await runnerSupport(bot, { ...plan, P }, 1)
            out.keepCob = (out.keepCob || 0) + 1
            if (!ok) { supBan.set('keep', true); (out.supWhy || (out.supWhy = [])).push('держать: ' + runnerSupport.why) }
            continue
          }
        }
        if (!bedHere()) {
          const rej = {}
          const choices = runnerLevels.map(p => {
            let i = -1, dist = Infinity
            for (let k = minTick; k < fc.path.length - 1; k++) {
              const d = fc.path[k].head.distanceTo(p.centre)
              if (d > fc.path[k - 1].head.distanceTo(p.centre) || d > fc.path[k + 1].head.distanceTo(p.centre)) continue
              if (d < dist) { i = k; dist = d }
            }
            // коробка родителя закроет F в тик прохода — ближайший ранний тик, где не закрывает (тело выше), с его расстоянием
            if (RUN_BOX() && i >= 0 && bodyBlocksBed(fc.path[i].pos, p.F, p.yb)) {
              let c = i
              while (c > minTick && bodyBlocksBed(fc.path[c].pos, p.F, p.yb)) c--
              if (bodyBlocksBed(fc.path[c].pos, p.F, p.yb) || fc.path[c].head.distanceTo(p.centre) > 4.6) { i = -1; rej[p.yb - P] = 'коробка' } else { i = c; dist = fc.path[c].head.distanceTo(p.centre) }
            } else if (i < 0) rej[p.yb - P] = 'нет прохода'
            let score = null
            if (RUN_SEEN() && i >= 0 && smSnap) {
              const extra = p.yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              const key = `${p.yb}|${r1(fc.path[i].pos.x)}|${r1(fc.path[i].pos.y)}|${r1(fc.path[i].pos.z)}`
              let seen = smCache.get(key)
              if (seen === undefined) { seen = smDragonSeen(smSnap, p.centre, fc.path[i].pos, extra); smCache.set(key, seen) }
              score = seen == null ? null : bedDamage(dist, seen)
            }
            return { p, i, dist, score }
          }).filter(c => {
            if (c.i < 0) return false
            const b = bot.blockAt(new Vec3(0, P, F.z))
            const ready = c.p.yb > P ? (b || {}).name === 'cobblestone' : isAirish(b)
            // ярус, опору которого только что не удалось подготовить, — не раньше, чем через 2.5 с (rs3-s2: цепочка рвалась)
            if (!ready && supBan.has(c.p.yb) && gameClock.now() < supBan.get(c.p.yb)) { rej[c.p.yb - P] = 'бан'; return false }
            if (!ready && c.i - nowTick < 20) { rej[c.p.yb - P] = `не готов (${c.i - nowTick} т.)`; return false }
            return true
          }).sort((a, b) => (a.score != null && b.score != null ? b.score - a.score : 0) || (RUN_HIGH() ? b.p.yb - a.p.yb : 0) || a.dist - b.dist)
          const best = choices[0]
          if (!best) { await sleep(30); continue }
          if (best) {
            const support = bot.blockAt(new Vec3(0, P, F.z)), dy = best.p.yb - P
            const ready = dy ? (support || {}).name === 'cobblestone' : isAirish(support)
            if (!ready) {
              // Окно подготовки — не менее 20 тиков, без коробок на всём этом интервале.
              if (best.i - nowTick < 20 || landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 20) }, q)) { await sleep(30); continue }
              // 02.10 (rs3-s2: «R: опора не подтверждена» рвал цепочку после 2 взрывов, и второй заход — сразу): не рвать — на 2.5 с
              // этот ярус не брать, взять готовый (на P опоре быть воздухом — после взрыва булыжник обычно снесён)
              if (!await runnerSupport(bot, plan, dy)) { out.supFail = (out.supFail || 0) + 1; (out.supWhy || (out.supWhy = [])).push(runnerSupport.why); supBan.set(best.p.yb, gameClock.now() + 2500); if (out.supFail > 6) { out.why = 'R: опора не подтверждена'; break } continue }
              continue // после await только свежий landingForecast/pushedForecast
            }
            plan = { ...best.p, runnerLevels }; st.plan = plan
            H = plan.H; F = plan.F; yb = plan.yb
            bedCells.splice(0, bedCells.length, F, H)
            const heightRec = { y: yb, headY: r1(fc.path[best.i].head.y * 10) / 10, pass: best.i, dist: r1(best.dist * 10) / 10, alt: choices.length > 1 ? r1(choices[1].dist * 10) / 10 : null, ...(Object.keys(rej).length ? { rej } : {}) }
            // запись — только когда выбор сменился (rs1: 149 одинаковых событий на цепочку)
            const rhKey = `${heightRec.y}|${heightRec.pass}`
            if (rhKey !== out.rhKey) { out.rhKey = rhKey; (out.runnerHeights || (out.runnerHeights = [])).push(heightRec); ev('runnerHeight', heightRec) }
          }
        }
      }
      // ближайший проход головы у подушки (локальный минимум ≤ 3.2), кровать не задета до него
      const ctr = useAn ? Acentre : plan.centre
      // Проход и свободное окно кровати — вместе (Codex dragon-series, 01.10: проход брался до проверки окна — первый
      const started = out.booms.some(b => typeof b === 'number')
      const mins = []
      for (let i = Math.max(1, minTick - 1); i < fc.path.length - 1; i++) {
        const a = fc.path[i - 1]; const b = fc.path[i]; const c = fc.path[i + 1]
        const d = b.head.distanceTo(ctr)
        if (i < minTick || d > a.head.distanceTo(ctr) || d > c.head.distanceTo(ctr)) continue
        if (d <= 6.5) mins.push({ i, d })
      }
      // Тик взрыва и когда ставить. Коробки дракона (голова/шея/тело) «съедают» кровать на клетках F/H (checkWalls): взрыв —
      const free = k => { const s2 = fc.path[k]; return !s2 || !cellHit(s2) }
      const placedNow = bedHere()
      // ND_PLACE_CLICK: 2 (по умолчанию с 02.10) — кровать ставится и взрывается двумя пакетами в тик прохода, коробки не
      const pcMode = envv('ND_PLACE_CLICK') ?? '2'
      const placeClick = !useAn && (pcMode === '1' || pcMode === '2') && !placedNow
      const placeClick2 = placeClick && pcMode === '2'
      const firstMax = envNum('ND_FIRST_MAX', FIRST_MAX)
      const lim = started ? 6.5 : firstMax
      // ND_EAT_MARGIN=0 — кровать нужна целой только до тика взрыва c (щелчок обработан между тиками c и c + 1),
      // без запаса на поздний щелчок (лаборатория 02.10: щелчок −25 мс от конца окна — в середине тика)
      const eatMargin = envNum('ND_EAT_MARGIN', 1)
      // ND_MIN_BLAST_HP — не щёлкать в тик c, где прогнозный урон головы (bedDamage, видимость ND_MIN_BLAST_SEEN, 1 —
      // по замеру лаборатории seen p50 0.99) ниже порога: ранний «безопасный» тик слабее самого прохода (Codex dragon-blast, 02.10). 0 — выкл.
      const minBlastHp = Math.max(0, envNum('ND_MIN_BLAST_HP', 0)); const minBlastSeen = envNum('ND_MIN_BLAST_SEEN', 1)
      const windowFor = m => {
        if (useAn) return { clickI: m.i, safeFrom: nowTick }
        // ND_PLACE_CLICK=1: кровать ставится и взрывается двумя пакетами в одном окне тика — коробки дракона её не застают;
        // нужна только свободная клетка в тик взрыва c (сервер не ставит блок в коробку сущности)
        if (placeClick) {
          for (let c = m.i; c >= nowTick + 1; c--) {
            // ND_PLACE_CLICK=2 — и без проверки коробок: части дракона стройке не мешают (Entity.blocksBuilding у EnderDragonPart
            // нет; lab5: 14 неудачных ставок из 499), а checkWalls кровать, поставленную и взорванную между тиками, не застаёт
            if (placeClick2 ? false : !free(c)) continue
            // R: низ коробки родителя 16×8×16 (LivingEntity.blocksBuilding) ниже верха кровати в F — ставка не пройдёт (rs3/rs4:
            // 10 из 10 «ставка не прошла» — тело в 0.1–1.5 над ярусом кровати и снижается); раньше — тело выше
            if (RUN_BOX() && runnerLevels && bodyBlocksBed(fc.path[c].pos, F, yb)) continue
            const cd = fc.path[c].head.distanceTo(ctr)
            if (cd > lim) return null
            if (minBlastHp > 0 && bedDamage(cd, minBlastSeen) < minBlastHp) return null
            // R + seen: среди этого тика и до 3 более ранних (тело выше — seen больше) — наибольший прогнозный урон
            if (runnerLevels && RUN_SEEN() && smSnap && RUN_TICKSEEN()) {
              const extra = yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              let best = null
              for (let c2 = c; c2 >= Math.max(nowTick + 1, c - 3, minTick); c2--) {
                if (RUN_BOX() && bodyBlocksBed(fc.path[c2].pos, F, yb)) continue
                const d2 = fc.path[c2].head.distanceTo(ctr)
                if (d2 > lim) break
                const sn = smDragonSeen(smSnap, ctr, fc.path[c2].pos, extra)
                const sc = bedDamage(d2, sn == null ? 0.95 : sn)
                if (!best || sc > best.sc + 0.5) best = { c: c2, sc }
              }
              if (best) return { clickI: best.c, safeFrom: best.c }
            }
            return { clickI: c, safeFrom: c }
          }
          return null
        }
        for (let c = m.i; c >= nowTick + 1; c--) {
          if (!free(c) || (eatMargin && !free(c + 1))) continue
          let w0 = c
          while (w0 - 1 >= nowTick && free(w0 - 1)) w0--
          if (placedNow ? w0 > nowTick : c - w0 < 3) continue
          const clickDist = fc.path[c].head.distanceTo(ctr)
          if (clickDist > lim) return null
          if (minBlastHp > 0 && bedDamage(clickDist, minBlastSeen) < minBlastHp) return null
          return { clickI: c, safeFrom: w0 }
        }
        return null
      }
      // Ярусы прохода: ND_PASS_T1 (3.2), ND_PASS_T2 (4.6), ND_PASS_END=0 — без дальнего прохода у конца захода
      const passT1 = envNum('ND_PASS_T1', 3.2); const passT2 = envNum('ND_PASS_T2', 4.6); const passEnd = envNum('ND_PASS_END', 1)
      const tiers = [m => m.d <= passT1, m => m.d <= (started ? passT2 : Math.min(passT2, firstMax)), m => passEnd && started && fc.n - nowTick < 40]
      let pass = null; let win = null
      for (const okT of tiers) {
        for (const m of mins) { if (!okT(m)) continue; const w = windowFor(m); if (w) { pass = m; win = w; break } }
        if (pass) break
      }
      if (!pass) {
        // сядет без прохода — дальше сидячие кровати. Не раньше, чем за 6 тиков: после толчков прогноз конца
        if (fc.n - nowTick < 6) {
          if (!runnerLevels && !useAn && process.env.ND_SALVAGE !== '0' && await salvage('садится')) continue
          out.why = 'садится без прохода'; break
        }
        await sleep(40); continue
      }
      if (useAn && hereAn < 1) {
        // якорь: поставить и зарядить сейчас (дракон его не сносит), не раньше 120 мс после взрыва
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:anchor')
        if (hereAn < 0) {
          // как кровать: к той же грани опоры K, прицел — по видимой точке (без факелов на луче)
          const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
          const fcl = K && faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { avoidTorch: torchHitP })
          const it = findItem(bot, /^respawn_anchor$/)
          if (fcl && it) {
            await bot.equip(it, 'hand').catch(() => {})
            bot.setControlState('sneak', false)
            await bot.lookAt(fcl.point, true)
            await new Promise<any>(resolve => bot.once('physicsTick', resolve))
            const cur = fcl.point.minus(K.position)
            bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
            bot.swingArm()
            const tw = gameClock.now()
            while (gameClock.now() - tw < 400 && anchorAt() < 0) await sleep(20)
          }
          if (!fcl && await recenter()) continue
          if (anchorAt() < 0) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 2) { st.noAnchor = true; out.anchor = fcl ? 'не встаёт' : 'опору не видно' } continue }
        }
        const c = await chargeAnchor(bot, { H: { x: F.x, z: F.z }, yb }, 1, () => { const h = anClick(bot); return h && { ...h, block: bot.blockAt(Apos) } })
        if (!c.ok) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 3) { out.why = `якорь: ${c.why}`; break } continue }
        continue
      }
      const clickI = win.clickI; const safeFrom = win.safeFrom
      // Ставить не в начале свободного окна, а за PLACE_LEAD тиков до щелчка (st4: кровати, поставленные заранее, съедали
      // коробки дракона или они оставались у столба при «садится без прохода» — s13 −2, s14 −2 из 6). ND_PLACE_LEAD=0 — как было.
      const placeLead = envNum('ND_PLACE_LEAD', PLACE_LEAD)
      const tPlace = fc.t + 50 * (placeLead > 0 ? Math.max(safeFrom, clickI - placeLead) : safeFrom)
      // Поставленная кровать пропала до щелчка (коробки дракона, checkWalls) — потеря из бюджета (01.10: с 7
      // кроватями бой кончался на 6 взрывах в 41 из 58 вызовов — одна уходила молча, без события).
      if (!useAn && placedSince && !bedHere()) {
        placedSince = false
        out.lost = (out.lost || 0) + 1
        ev('bedLost', { ph: PHASE_RU[ph] ?? ph, tick: nowTick, n: fc.n })
        console.log(`[bed] пропала до щелчка (съели коробки дракона?), тик ${nowTick} из ${fc.n}`)
      }
      if (!useAn && !bedHere() && !placeClick) {
        if (tPlace - gameClock.now() > 120) { await sleep(Math.min(200, tPlace - gameClock.now() - 100)); continue }
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:bed')
        const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fcl = K && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face))
        if (!fcl) {
          if (await recenter()) continue
          // станция с этого места не работает (мир не как в плане: леса, выбитый эндерняк) — перепланировать,
          // пока дракон далеко (pil8-15: «грань опоры не видно» при боте точно в окопе)
          const e = bot.entity.position.offset(0, EYE, 0)
          out.dbg = { eye: [r1(e.x), r1(e.y), r1(e.z)], K: [plan.place.K.x, plan.place.K.y, plan.place.K.z], Kname: (K || {}).name, here: !!pillarHere(bot, plan) }
          st.built = false
          out.why = 'грань опоры не видно'; break
        }
        const bedItem = findItem(bot, /_bed$/)
        await bot.equip(bedItem, 'hand').catch(() => {})
        bot.setControlState('sneak', false)
        await bot.lookAt(fcl.point, true)
        await new Promise<any>(resolve => bot.once('physicsTick', resolve))
        // сырой пакет: грань и точка — те, что видны (placeBlock сам смотрит в середину грани)
        const cur = fcl.point.minus(K.position)
        bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
        bot.swingArm()
        const tw = gameClock.now()
        while (gameClock.now() - tw < 400 && !bedHere()) await sleep(20)
        if (!bedHere()) { out.bedFail = (out.bedFail || 0) + 1; if (out.bedFail > 3) { out.why = 'кровать не встаёт'; break } continue }
        placedSince = true
      }
      // щелчок в тик прохода
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      const vBed = placeClick ? virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']])) : bot
      const hit = useAn ? anClick(bot) : faceClick(vBed, eyeNow, new Vec3(plan.click.cell.x, yb, plan.click.cell.z), new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // ставка в тот же миг: грань опоры K (взгляд — на неё: по горизонтали взгляда сервер кладёт изголовье)
      let pre = null
      if (placeClick && hit) {
        const Kb = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fk = Kb && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, eyeNow, Kb.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, eyeNow, Kb.position, plan.place.face))
        if (!fk) { if (await recenter()) continue; st.built = false; out.why = 'грань опоры не видно'; break }
        pre = { pos: Kb.position, face: plan.place.face, point: fk.point }
      }
      if (!hit) { if (await recenter()) continue; if (!useAn) st.built = false; out.why = useAn ? 'якорь не видно' : 'кровать не видно'; break }
      // +1 тик против L: по записи сервера (an-pilltiming.js, 90 взрывов pil2) лучший тик — на 1 позже в 81 из 90
      // 750 TPS (s5, 06.10, свидетель DragonLab, 16 взрывов): тот же +1 тик опаздывал — лучший тик раньше на 1 (медиана; −2…+1):
      // доставка и разбор пакетов — доли мс, но это 1–2 тика. На ускоренных тиках — без +1 (ND_CLICK_LEAD).
      const tClick = fc.t + 50 * (clickI + clickLead()) + envNum('ND_CLICK_OFS', -25)
      // тот же миг по ровным часам на ускоренных тиках (ND_CLICK_MONO=0 — по игровым, как раньше)
      const snNow = gameClock.snapshot(); const rateNow = snNow?.effectiveRate || snNow?.tickRate || 20
      const tClickMono = rateNow > 100 && fc.monoT != null && envv('ND_CLICK_MONO') !== '0' ? fc.monoT + (clickI + clickLead() + envNum('ND_CLICK_OFS', -25) / 50) * 1000 / rateNow : null
      const dClick = clickI === pass.i ? pass.d : fc.path[clickI].head.distanceTo(ctr)
      // щёлкать — по свежему прогнозу, когда до прохода ≤ 8 тиков (на 30 тиков вперёд прогноз спирали
      // ошибается на 2–3 блока: pil1-8 — ждали 41, вышло 15)
      const aimAt = pre ? pre.point : hit.point
      // R: стрела в промежутке, пока до щелчка ≥ 1.5 с (ND_RUN_GAPARROW=1); одна попытка на промежуток
      if (runnerLevels && RUN_GAPARROW() && tClick - gameClock.now() > 1500 && gapKey !== lastBoom && bot.health >= 10 && countOf(bot, /arrow$/) > 0) {
        gapKey = lastBoom
        const ga: any = await runnerGapArrow(session, ctl, feed, P, { minHit: (lastBoom || 0) + 560, maxHit: tClick - 560, deadline: tClick - 330 })
        ;(out.gapLog || (out.gapLog = [])).push(ga.shot ? { ...ga.shot, hpAfter: ga.hpAfter } : ga.why)
        continue
      }
      if (tClick - gameClock.now() > 260) { await lookAtSafe(bot, aimAt); await sleep(30); continue }
      await lookAtSafe(bot, aimAt)
      if (pre) { const bi = findItem(bot, /_bed$/); if (!bi) { out.why = 'кровати кончились'; break } if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) await bot.equip(bi, 'hand').catch(() => {}) }
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      const r = await bedsBoom(session, ctl, stats, { ...plan, ...(useAn ? { H: { x: F.x, z: F.z }, centre: Acentre } : {}), anchor: useAn, dist: r1(dClick), expect: bedDamage(dClick, plan.seen || 1), D: plan.a, y: yb, reuse: true }, { point: hit.point, face: runnerLevels ? plan.click.face : null, runnerGuard: runnerLevels ? () => {
        const q = bot.entity.position, f = landingForecast(feed, P) || fc
        const k = Math.max(0, Math.round((gameClock.now() - f.t) / 50))
        const dd = dragonOf(bot)
        // причина отказа — строкой (в трассу bedFail), годится — true
        if (ctl.aborted) return 'прервано'
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) return 'фаза'
        if (k >= f.path.length) return 'прогноз кончился'
        if (!bot.entity.onGround) return 'не на земле'
        if (q.distanceTo(plan.feet) > 0.15) return `сдвинут ${r1(q.distanceTo(plan.feet) * 10) / 10}`
        if (bot.health < 10) return 'мало хп'
        // свежий прогноз в миг щелчка: голова в тик взрыва далеко (rs6-s1: прогноз 1.3, по серверу 11.1 — урон 0.3) — кровать не тратить;
        // порог с запасом (rs7-s18: вето при 3.3 на раннем тике — цепочка оборвалась, дракон сел)
        { const kc = Math.round((tClick + 25 - f.t) / 50); const st2 = f.path[Math.min(f.path.length - 1, Math.max(0, kc))]; const hd = st2 ? st2.head.distanceTo(ctr) : null; if (RUN_LATEHEAD() && hd != null && hd > Math.max(6.5, dClick + 3)) return `голова ${r1(hd)}` }
        if (landingHits({ path: f.path.slice(k, k + 3) }, q)) return 'коробки дракона'
        const v = virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']]))
        const eye = q.offset(0, EYE, 0)
        if (!faceClick(v, eye, new Vec3(F.x, yb, F.z), plan.click.face)) return 'бок кровати не виден'
        if (!(RUN_FACING() ? faceClickFacing(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face, { x: H.x - F.x, z: H.z - F.z }, { minCos: 0.75 }) : faceClick(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face))) return 'грань K не видна'
        return true
      } : null, block: useAn ? bot.blockAt(Apos) : bot.blockAt(new Vec3(plan.click.cell.x, yb, plan.click.cell.z)) }, 'снижение', { aimed: true, until: Math.max(tClick, (stats.lastBoom || 0) + BED_GAP_MS), untilMono: tClickMono, uncounted: true, ...(pre ? { keepHand: true, prePlace: pre } : {}), phCheck: p => p === PHASE.LANDING, note: { ...(pre ? { pc: 1 } : {}), ...(runnerLevels ? { runnerY: yb, ...seenNote(clickI) } : {}), oc: useAn ? 'PA' : 'P', pass: clickI, headDist: r1(dClick), fcT: fc.t, fcWall: fc.wallMs, tClick, mono: tClickMono != null, ...(clickI !== pass.i ? { early: pass.i - clickI } : {}) } })
      // кровать пропала без удара по дракону и без урона нам — её снесли коробки дракона (checkWalls), взрыва
      // не было: толчка нет, прогноз — свежий (pil6-15, pil6-21: «съеденная» кровать на последнем заходе)
      const eaten = r.ok && !useAn && r.lagMs == null && !r.dmg && !r.self
      if (r.ok) placedSince = false
      out.booms.push(r.ok ? (eaten ? 'съели' : r.dmg) : null)
      if (!r.ok) (out.fails || (out.fails = [])).push(r.why)
      if (eaten) { out.eaten = (out.eaten || 0) + 1; pushed = null; continue }
      if (r.ok) {
        lastBoom = stats.lastBoom || gameClock.now()
        st.booms++
        const pf = pushedForecast(fc, clickI, ctr, plan.seen || 1, P)
        pushed = pf ? { fc: { ...pf, t: fc.t }, after: gameClock.now() + 150 } : null
      } else if (!useAn && !bedHere()) { /* снесло — следующая */ }
    }
    return out
  } finally {
    out.ms = gameClock.now() - t0
    ev('pillarRun', out)
  }
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

async function mineEndStone (session, ctl, want, stats) {
  const bot = session.bot
  const pick = findItem(bot, /_pickaxe$/)
  if (!pick) return 0
  const t0 = gameClock.now()
  const have0 = countOf(bot, FILLER_RE)
  const was = ctl.doing
  doing(ctl, 'mine-endstone')
  // Сел или садится — бросить: высматривая, он через 100 тиков таранит того, кто
  // дальше 20 блоков (c2-4, 30.09, 63.8–70.2 с: копал в 27 блоках, таран, два удара).
  const perched = () => { const dd = dragonOf(bot); if (!dd) return false; const p = phaseOf(bot, dd); return SITTING.has(p) || p === PHASE.LANDING }
  // Только с земли острова: на обелиске (обсидиан) кольцо пусто, а «новое место в
  {
    const sup = supportCell(bot)
    const ub = sup && bot.blockAt(sup)
    if (!ub || ub.name !== 'end_stone') { doing(ctl, was); if (ctl.trace) ctl.trace.ev('mined', { got: 0, secs: 0, have: countOf(bot, FILLER_RE), why: ub ? ub.name : 'нет опоры' }); return 0 }
  }
  try {
    for (let round = 0; round < 8 && !ctl.aborted && !perched() && countOf(bot, FILLER_RE) < want && gameClock.now() - t0 < 60000; round++) {
      const me = bot.entity.position
      const fy = Math.floor(me.y + 0.01) - 1
      const ring = []
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = new Vec3(Math.floor(me.x) + dx, fy, Math.floor(me.z) + dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'end_stone') continue
        if (Math.hypot(p.x + 0.5 - CENTER.x, p.z + 0.5 - CENTER.z) < 6) continue
        if (voidBelow(bot, p.x + 0.5, fy, p.z + 0.5, 4)) continue
        ring.push(b)
      }
      for (const b of ring) {
        if (ctl.aborted || countOf(bot, FILLER_RE) >= want || perched()) break
        const bad = hazardNow(bot)
        if (bad) { await evade(bot, ctl, stats, bad); break }
        // Бьёт эндермен — отбиться, а не копать дальше (d5-26, 30.09, 227–233 с:
        // семь ударов эндермена за 6 с, пока тело ломало эндерняк, смерть).
        const pest = hunters(bot, 4)[0]
        if (pest) { await fightEnderman(session, ctl, stats, pest, null); break }
        try {
          await bot.equip(pick, 'hand')
          await build.withTimeout(bot.dig(b, true), 3000)
        } catch (e) { dbg('mine', e.message) }
      }
      await sleep(700)
      if (countOf(bot, FILLER_RE) >= want) break
      // Дальше — на новое место в 3–4 блоках, на ровную землю.
      const spot = pickSpot(bot, bot.entity.position, { rMin: 3, rMax: 5, step: 1, edge: 3, avoid: f => nearPillar(bot, f, 2) || Math.hypot(f.x - CENTER.x, f.z - CENTER.z) < 7 })
      if (!spot) break
      await walkTo(session, ctl, spot.feet, { range: 0.6, timeoutMs: 8000 })
    }
  } finally { doing(ctl, was) }
  const got = countOf(bot, FILLER_RE) - have0
  stats.mined = (stats.mined || 0) + Math.max(0, got)
  if (ctl.trace) ctl.trace.ev('mined', { got, secs: Math.round((gameClock.now() - t0) / 1000), have: countOf(bot, FILLER_RE) })
  return got
}

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
    while (!dd && !ctl.aborted && gameClock.now() - t0 < ms && gameClock.now() < deadline) {
      if (portalBlocks(bot).length) return null
      doing(ctl, 'fight:search')
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 18) {
        const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 16 })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 20000 })
      } else await sleep(500)
      dd = track.tick()
    }
    return dd
  }
  let d = track.tick() || await lookFor(60000)
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
  while (!ctl.aborted && gameClock.now() < deadline) {
    await yieldTick()
    doing(ctl, 'fight')
    d = track.tick()
    if (!d) {
      // Исчез после «умирает» — победа. Иначе улетел из прорисовки.
      if (lastPhase === PHASE.DYING) { won = true; break }
      await sleep(250)
      if (!dragonOf(bot) && lastPhase === PHASE.DYING) { won = true; break }
      if (!dragonOf(bot) && !(await lookFor(30000))) {
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
    if (ctl.bedsOnly && SITTING.has(ph) && !keepBeds) {
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
    // Добить из лука в полёте: после посадки у дракона ≤ 20 хп (лечится 2 хп/с — только сейчас).
    if (ctl.bedsOnly && hp != null && hp <= 20 && !SITTING.has(ph) && ph !== PHASE.LANDING && !perched && gameClock.now() - lastShot > 900) {
      lastShot = gameClock.now()
      // (02.10 вечер, rs12-s8/s15/s18: сюда передавали false — bow.shoot звал hazardSoon() и вызов «сорвался» при драконе 0.2–12 хп
      // сразу после взлёта с меча; добивания из лука в полёте не было ни разу)
      if (await rangedShot(session, ctl, stats, track, d, () => !!hazardNow(bot))) { stats.finishArrows = (stats.finishArrows || 0) + 1; continue }
    }
    if (ctl.bedsOnly) {
      // Кровати кончились — бой «только кроватями» нечем продолжать: вернуть
      const swordMore = countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && crysOn() && envv('ND_SWORD_MORE') !== '0' && RUN_SWORD() &&
        !!(ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner) && !!items.bestWeapon(bot) && crysAlive(ctl) != null && crysAlive(ctl) <= 3 &&
        hp != null && hp <= envNum('ND_SWORD_MORE_HP', 80) && bot.health >= 12 && deadline - gameClock.now() > 45000
      if (swordMore && !ctl.swordMoreT) { ctl.swordMoreT = gameClock.now(); if (ctl.trace) ctl.trace.ev('swordMore', { hp: r1(hp), alive: crysAlive(ctl) }) }
      if (countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && !swordMore) {
        rep.dragon.lost = 'кровати кончились — бой только кроватями нечем продолжать'; rep.need = { what: 'red_bed', count: BEDS_KIT, have: 0 }
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
      // Только кровати: ни станции, ни кристаллов, ни стрел. Ждать посадку на
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

module.exports = { clickLead, feedTicks, refillBucket, endMovements, walkTo, guarding, guard, walkOnce, shootCrystal, earlyCrystalStep, crystalWait, openCage, destroyCrystals, heal, clearOfClouds, hideAndHeal, sitRec, sightMe, sightKey, sitState, blindKnown, sitAcc, noteSitDamage, takeoffOnHit, hazardNow, dragonZones, zonesCache, dragonStepCost, fightEnderman, bedBlast, leaveFront, perchFar, perchApproach, keepInScan, perchAttack, lastDragonHit, makeDragonFeed, ocLanding, ocOwnClick, walkAround, tsBuild, tsTrench, meleeFinish, runnerSword, bedsLayout, bedsGo, bedsBoom, bedsDouble, doubleRun, doubleRunAt, tryC, ocTakeoffRun, ocT1, seeStation, standAt, placeFrom, placeHigh, runnerClean, pillarBuild, pillarEnter, pillarRun, bedsPerch, mineEndStone, stationBuild, stationStep, fightDragon }
