'use strict'
// Езда (ride.ts): RPC ride — режимы лошади и лодки.
import * as gameClock from '../game-clock'
import { withTimeout } from '../build'
import { goals } from 'mineflayer-pathfinder'
import { approach, dismount, mountOn, patchVehicle } from './mount'
import { DEBUG, HORSES, TICK, attrFix, flat, isBoatName, isTamedHorse, sendLook, sendVehicle, sleep, toMcYaw, xyz } from './base'
import { horseInfo, pickHorse, rideHorse, saddleUp, tameHorse, tie } from './horse'
import { boatItemIn, craftBoat, findBoat, launchBoat, pickUpBoat, rideBoat } from './boat'


// ------------------------------------------------------------------ вход

// Режимы. Лошадь (kind horse|donkey|mule): status — какая рядом; tame —
// приручить; saddle — приручить при нужде и осёдлать; mount — и сесть; go —
// и доехать до x,z (слезть, tie=true — привязать); tie — привязать ближнюю
// приручённую к забору; dismount. Лодка (kind boat): status; craft — лодку из
// досок; launch — спустить на воду; mount — сесть; go — доплыть до x,z,
// высадиться на берег, лодку разбить и подобрать (pickup=false — оставить);
// pickup — разбить и подобрать ближнюю пустую лодку; dismount.
export const HORSE_MODES = ['status', 'tame', 'saddle', 'mount', 'go', 'tie', 'dismount']
export const BOAT_MODES = ['status', 'craft', 'launch', 'mount', 'go', 'pickup', 'dismount']

export async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  patchVehicle(bot)
  attrFix(bot)
  // Транспорт, который далеко от тела или пропал, — призрак (пакет о высадке
  // пришёл до правки или сущность ушла без него): забыть.
  if (bot.vehicle && (!bot.entities[bot.vehicle.id] || bot.vehicle.position.distanceTo(bot.entity.position) > 4)) {
    bot.vehicle = null
    bot.entity.vehicle = null
  }
  const kind = String(p.kind || 'horse').toLowerCase()
  let mode = String(p.mode || 'go').toLowerCase()
  if (mode === 'ride' || mode === 'to' || mode === 'cross') mode = 'go'
  const report: any = { kind, mode }
  const t0 = gameClock.now()
  const deadline = t0 + Math.min(600, p.timeoutSeconds ?? 120) * 1000
  const target = (p.x !== undefined && p.z !== undefined) ? { x: Number(p.x) + 0.5, y: p.y !== undefined ? Number(p.y) : undefined, z: Number(p.z) + 0.5 } : null

  if (mode === 'dismount') {
    report.wasOn = bot.vehicle ? bot.vehicle.name : null
    report.dismounted = await dismount(bot)
    report.at = xyz(bot.entity.position)
    return report
  }

  if (kind === 'boat') {
    if (!BOAT_MODES.includes(mode)) throw new Error(`лодка: режим ${mode} не знаю — ${BOAT_MODES.join(' / ')}`)
    return runBoat(session, ctl, { ...p, mode }, report, target, deadline)
  }
  if (!HORSES[kind]) throw new Error(`не умею ездить на ${kind}: horse, donkey, mule или boat`)
  if (!HORSE_MODES.includes(mode)) throw new Error(`лошадь: режим ${mode} не знаю — ${HORSE_MODES.join(' / ')}`)

  // Лошадь: уже в седле — её, иначе ближайшая видимая. Привязать — только
  // приручённую: дикая с поводка не убежит, но и седла не примет.
  let e = bot.vehicle && HORSES[bot.vehicle.name] ? bot.vehicle : null
  if (!e) {
    const list = pickHorse(bot, p.radius ?? 24, p.id)
      .filter((x : any) => kind === 'horse' ? true : x.name === kind)
      .filter(x => mode !== 'tie' || isTamedHorse(x))
    if (!list.length) { report.stopped = `не вижу взрослой ${mode === 'tie' ? 'приручённой ' : ''}лошади (осла, мула) в ${p.radius ?? 24} блоках`; return report }
    e = list[0]
  }
  report.horse = horseInfo(e)
  if (mode === 'status') return report
  if (mode === 'tie') {
    if (bot.vehicle) await dismount(bot)
    await tie(session, ctl, e, report)
    if (!report.tied && !report.stopped) report.stopped = report.note || 'не привязал'
    return report
  }
  if (!isTamedHorse(e)) {
    if (p.tame === false) { report.stopped = 'лошадь дикая: mode=tame (или без tame=false)'; return report }
    const tamed = await tameHorse(session, ctl, e, report, { tries: p.tries ?? 20 })
    report.horse = horseInfo(e)
    if (!tamed) return report
    await sleep(800, ctl)
    if (bot.vehicle) await dismount(bot)
  }
  if (mode === 'tame') return report
  if (!(await saddleUp(session, ctl, e, report))) return report
  report.horse = horseInfo(e)
  if (mode === 'saddle') return report
  if (!bot.vehicle || bot.vehicle.id !== e.id) {
    if (!(await approach(bot, ctl, e, 1.8))) { report.stopped = 'не подошёл к лошади'; return report }
    if (!(await mountOn(bot, ctl, e))) { report.stopped = 'сесть не вышло (сервер не посадил)'; return report }
    report.mounted = true
    await sleep(300)
  }
  if (mode === 'mount') return report
  if (!target) { report.stopped = 'куда ехать? x и z'; return report }
  report.from = xyz(e.position)
  report.distance = Math.round(flat(e.position, target))
  const arrived = await rideHorse(session, ctl, e, target, report, { deadline, range: p.range ?? 1.5 })
  report.arrived = arrived
  if (!arrived && !report.stopped) report.stopped = ctl.aborted ? 'прервано' : `время вышло: осталось ${report.rode && report.rode.left} блоков — позови тот же вызов`
  if (report.rode && report.rode.seconds > 0) report.rode.avgSpeed = Math.round((report.distance - (report.rode.left || 0)) / report.rode.seconds * 10) / 10
  if (arrived && !p.stay) {
    report.dismounted = await dismount(bot)
    if (p.tie) await tie(session, ctl, e, report)
  }
  return report
}

async function runBoat (session, ctl, p, report, target, deadline) {
  const bot = session.bot
  const have = () => { const it = boatItemIn(bot); return it ? it.name : null }
  if (mode(p) === 'craft') {
    if (have() && !p.force) { report.have = have(); report.note = `лодка уже в рюкзаке: ${have()} (force=true — ещё одну)`; return report }
    await craftBoat(session, ctl, report)
    report.have = have()
    return report
  }
  if (mode(p) === 'pickup') {
    const boat: any = findBoat(bot, p.radius ?? 8)
    if (!boat) { report.stopped = `пустой лодки в ${p.radius ?? 8} блоках не вижу`; return report }
    report.boat = { kind: boat.name, at: xyz(boat.position) }
    await pickUpBoat(session, ctl, boat, report)
    if (!report.pickedUp && !report.stopped) report.stopped = 'лодку не подобрал'
    return report
  }
  let boat = bot.vehicle && isBoatName(bot.vehicle.name) ? bot.vehicle : null
  if (!boat && mode(p) !== 'launch') boat = findBoat(bot, p.radius ?? 8)
  if (!boat) {
    if (mode(p) === 'status') { report.boat = null; report.have = have(); return report }
    boat = await launchBoat(session, ctl, report)
    if (!boat) return report
  }
  report.boat = { kind: boat.name, at: xyz(boat.position) }
  if (mode(p) === 'status' || mode(p) === 'launch') { report.have = have(); return report }
  if (!bot.vehicle || bot.vehicle.id !== boat.id) {
    if (!(await approach(bot, ctl, boat, 2))) { report.stopped = 'не подошёл к лодке'; return report }
    if (!(await mountOn(bot, ctl, boat))) { report.stopped = 'сесть в лодку не вышло'; return report }
    report.mounted = true
    await sleep(300)
  }
  if (mode(p) === 'mount') return report
  if (!target) { report.stopped = 'куда плыть? x и z'; return report }
  report.distance = Math.round(flat(boat.position, target))
  const arrived = await rideBoat(session, ctl, boat, target, report, { deadline, stay: !!p.stay })
  report.arrived = arrived
  if (!arrived && !report.stopped) report.stopped = ctl.aborted ? 'прервано' : 'время вышло — позови тот же вызов'
  if (arrived && !p.stay) {
    // Доплыть до водной клетки недостаточно: без сухого места shift оставит
    // тело в воде. Сохраняем управление лодкой для следующего отрезка.
    if (report.beached !== true) { report.arrived = false; report.stopped = 'сухая площадка высадки не подтверждена — остаюсь в лодке'; return report }
    // AbstractBoat.getDismountLocationForPassenger: место высадки — в 1.3 блока
    // ПО ВЗГЛЯДУ наездника (getCollisionHorizontalEscapeVector от его yRot), и
    // только если там не вода. Смотреть на берег, потом shift.
    const shore = report.landingTarget || target
    const face = toMcYaw(Math.atan2(-(shore.x - boat.position.x), -(shore.z - boat.position.z)))
    for (let i = 0; i < 3; i++) { sendLook(bot, face, 20); sendVehicle(bot, boat.position, face, false); await sleep(TICK) }
    if (report.beached === false) report.note = (report.note ? report.note + ' ' : '') + 'к берегу вплотную не подошёл — сервер мог высадить в воду'
    report.dismounted = await dismount(bot)
    await sleep(400)
    const ashore = bot.entity.position.clone()
    if (DEBUG) console.log(`[boat] dismount face ${face.toFixed(0)} boat ${boat.position} → body ${ashore}`)
    // Лодку с собой — если не сказано оставить.
    if (p.pickup !== false && report.dismounted) {
      await pickUpBoat(session, ctl, boat, report)
      if (DEBUG) console.log(`[boat] after pickup body ${bot.entity.position}`)
      // За дропом тело могло зайти в воду (предмет плавает у берега) —
      // вернуться туда, куда высадила лодка.
      if (!ctl.aborted && bot.entity.position.distanceTo(ashore) > 1.5) {
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ashore.x, ashore.y, ashore.z, 1)), 10000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      }
    }
    report.landed = xyz(bot.entity.position)
    report.onLand = flat(bot.entity.position, target)
    report.onLand = Math.round(report.onLand * 10) / 10
  }
  return report
}

const mode = p => String(p.mode || 'go').toLowerCase()
