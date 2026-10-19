'use strict'
// Бой с драконом (dragon/pillar-run.ts): кристаллы: выстрел, ранний шаг, ожидание, клетки, обход башен, копка эндерняка.
const { gameClock, Vec3, findItem, FILLER_RE, voidBelow, cloudZones, cloudsOf, dbg, SAFE_FROM_CRYSTAL, bow, starer, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, digDownTo, items, build, EYE, SITTING, supportCell, clearControls, PHASE_RU, hpOf, envNum, envv, pick }: typeof import('../dig-down-to') = require('../dig-down-to')
const { hunters, doing, surfaceY, inClouds, pickSpot, nearPillar, fastTower, r1, overCloud, crystalsOf }: typeof import('../fall-guard') = require('../fall-guard')
const { countOf, evade }: typeof import('../evade-raw') = require('../evade-raw')
const { crystalShotSpot, pointBlank }: typeof import('../crystal-shot-spot') = require('../crystal-shot-spot')
const { towerUnsafe, waterToHotbar, dropOff, onSpike, getDown, onOwnPillar, tidy }: typeof import('../station-plan') = require('../station-plan')
const { crysState, crysTargets, crystalTimingAllowed, crystalShotFrom, crystalSpot, crysOn }: typeof import('../pillar-plan') = require('../pillar-plan')
import { hazardNow } from './sight-zones'
import { refillBucket, walkTo, guard, heal, clearOfClouds, fightEnderman } from './walk'
import { perchFar, perchApproach } from './perch'

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

export {
  shootCrystal, earlyCrystalStep, crystalWait, openCage, destroyCrystals, mineEndStone
}
