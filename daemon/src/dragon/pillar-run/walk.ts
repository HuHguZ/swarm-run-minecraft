'use strict'
// Бой с драконом (dragon/pillar-run.ts): ходьба в Крае: ведро, движения, путь со сторожем, лечение, уход из облаков, эндермены.
const { gameClock, Vec3, overlap, playerBox, inflate, Movements, goals, findItem, FILLER_RE, voidBelow, cloudZones, inZone, nearPortal, runnerBowl, cloudsOf, DEBUG, dbg, stepIntoZone, sleep, CENTER, isSolid, yieldTick, stepTo, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, clearControls, box, fbAlarm, pick, pvp, boxDist, cloudHits, runwayAhead }: typeof import('../dig-down-to') = require('../dig-down-to')
const { inCharge, hunters, doing, inClouds, pickSpot, nearPillar, r1, nearEdge, standY, hasEffect, takeoffBoxes, STAY_R, cloudAgeMs, healRaw, embeddedNow, unembed }: typeof import('../fall-guard') = require('../fall-guard')
const { dangerAt, evade }: typeof import('../evade-raw') = require('../evade-raw')
const { makeRubberband, unstick }: typeof import('../crystal-shot-spot') = require('../crystal-shot-spot')
const { waterToHotbar }: typeof import('../station-plan') = require('../station-plan')
import { sitRec, blindKnown, hazardNow, dragonZones } from './sight-zones'

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

let zonesCache = { t: 0, z: {} }

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

export {
  refillBucket, endMovements, walkTo, guarding, guard, walkOnce, heal, clearOfClouds, hideAndHeal, zonesCache, dragonStepCost, fightEnderman
}
