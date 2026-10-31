'use strict'
// Лук (bow.ts): выстрел shoot — подготовка (лук, стрелы, сила, первая проверка пути), натяжение с ведением прицела,
// спуск и слежение за стрелой. Синхронные части — в shot-aim (часы и решатель), shot-release (слушатели, спуск,
// финальный прицел), shot-result (итог и разбор); общее состояние фаз — ShotState (shot-state). Ожидания (await)
// остались здесь, в прежних местах: лишний await между фазами сдвинул бы постановку слушателей на микрозадачу.
import * as gameClock from '../game-clock'
import * as pick from '../pick'
import { sleep } from '../movement'
import { DRAW_MS, SPEED, GRAVITY, aim, aimMoving, blockedAt } from './ballistics'
import { observeCharge } from './charge'
import { leadTarget, traceTarget, observedVelocity } from './track'
import type { ShotState } from './shot-state'
import { trackShot } from './shot-aim'
import { armRelease, lateRelease } from './shot-release'
import { shotOutcome, arrowDiag } from './shot-result'

// Выстрел. Натягивает DRAW_MS, всё это время ведя прицел; перед спуском —
// последний пересчёт. onDraw(tick) — чем занять ноги (стрейф). Возвращает
// прицел и, если follow, — чем кончилась стрела (hit / промах в блоках).
// Сервер 1.21 прибавляет к стреле скорость стрелка (shootFromRotation:
// getKnownMovement — то, что клиент сообщил о своём движении). Стрейф во время
// натяжения уводил стрелу вбок: в бою по зомби бот мазал через раз, хотя в
// тире стоя попадал всегда. Поэтому последние SETTLE_MS перед спуском тело
// стоит (onSettle), и скорость успевает погаснуть: трение на земле ×0.546 за тик.
const SETTLE_MS = 250

// mode: 'compensate' (по умолчанию) — не останавливаться, а учесть свою
// скорость в прицеле (aimMoving): стрейф идёт до самого спуска, и попасть в
// такого стрелка труднее; 'settle' — замереть перед спуском; 'raw' — ни то ни
// другое (для сравнения в тире).
// point(ticks) -> Vec3 — своя точка прицела вместо середины туловища (у
// дракона бьётся не сущность, а её части: голова, тело, крылья — dragon.js);
// steep — разрешить крутой выстрел вверх (см. peakPitch).
async function shoot (bot, entity, { velFn = null, onDraw = null, onSettle = null, onRelease = null, onHit = null, shouldStop = null, follow = true, mode = 'compensate', point = null, steep = false, drawMs = DRAW_MS, holdWhile = null, holdMaxMs = 2500, traceAim = false, peek = false }: any = {}) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  const ranged: typeof import('../ranged') = require('../ranged')
  const first = ranged.firstArrow(bot), player = !!entity?.username || entity?.type === 'player'
  const arrows = first && ranged.offensiveArrow(first, player) ? first : ranged.pickArrow(bot, { player })?.item
  if (!bow || !arrows) return { shot: false, why: !bow ? 'лука нет' : 'стрел нет' }
  if (first !== arrows && !(await ranged.readyArrow(bot, arrows))) return { shot: false, why: 'боевая стрела недоступна' }
  // Отменить натяжение без выстрела (ревью Codex 2026-09-30): deactivateItem —
  // это «отпустить кнопку», сервер на нём и стреляет (BowItem.releaseUsing) —
  // «отменил натяжение» выпускал стрелу. Смена слота снимает использование
  // предмета без releaseUsing (как при закрытом пути ниже).
  const cancelDraw = () => charge.cancel() // not deactivateItem: that releases an arrow

  // Короткое натяжение (стрела вреда, ranged.harmDrawMs, 2026-09-26): сила лука
  // (f² + 2f)/3 при f = тики/20 (BowItem.getPowerForTime), скорость стрелы 3 × сила.
  // Short-shot speed is an estimate, not a measured native charge duration.
  const short = drawMs < DRAW_MS
  const drawTicks = Math.max(2, Math.round(drawMs / 50) - 1)
  const speed = short ? SPEED * Math.min(1, ((drawTicks / 20) ** 2 + 2 * drawTicks / 20) / 3) : SPEED
  // One observed velocity per solve: reading a clock-backed tracker inside
  // every bisection step makes targetAt(t) change during the same calculation.
  const targetNow = () => {
    const v = velFn ? velFn() : observedVelocity(entity)
    let target = point || leadTarget(entity, () => v, bot)
    if (traceAim) {
      const observation = { at: gameClock.serverNow(), position: { ...entity.position }, velocity: { ...v }, grounded: entity.onGround }
      target = traceTarget(target, observation); target.observation = observation
    }
    return target
  }
  const eye = () => pick.eyeOf(bot).offset(0, -.1, 0)
  // Путь закрыт ещё до натяжения — не тратить секунду: вызывающий должен
  // сменить позицию (или идти в ближний бой).
  // До натяжения — текущая скорость; при спуске всё равно проверяется измеренное смещение.
  const motion = mode === 'compensate' && bot.entity.velocity || { x: 0, y: 0, z: 0 }
  const pre = mode === 'compensate'
    ? aimMoving(eye(), targetNow(), motion, !bot.entity.onGround, speed, GRAVITY, steep)
    : aim(eye(), targetNow(), speed, GRAVITY, steep)
  if (!pre) return { shot: false, why: 'не долетит' }
  // peek — выстрел из-за укрытия в прыжке (peek_shot): сейчас стенка закрывает, откроется на вершине прыжка; закрыто ли
  // в миг спуска — проверка при выстреле (release) та же.
  const wall = peek ? null : blockedAt(bot, eye(), pre, motion, speed)
  if (wall) return { shot: false, blocked: true, why: `на линии стрельбы блок ${wall.x},${wall.y},${wall.z}` }
  if (!bot.heldItem || bot.heldItem.name !== 'bow') await bot.equip(bow, 'hand')
  const charge = observeCharge(bot)
  const S: ShotState = { bot, entity, velFn, onDraw, onSettle, onRelease, onHit, shouldStop, follow, mode, point, steep, drawMs, holdWhile, holdMaxMs, traceAim,
    cancelDraw, short, speed, targetNow, eye, charge, stopTick: () => {}, sent: false }
  try {
  if (!charge.start()) return { shot: false, why: charge.why(), fullChargeConfirmed: false }
  trackShot(S)
  const { t0, holdDeadline, solve, myVel } = S
  let settled = false
  while (gameClock.now() - t0 < drawMs) {
    if (charge.why()) { S.stopTick(); cancelDraw(); return { shot: false, why: charge.why(), fullChargeConfirmed: false } }
    if (shouldStop && shouldStop()) { S.stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
    S.sol = solve()
    if (S.sol) await bot.look(S.sol.yaw, S.sol.pitch, true).catch(() => {})
    if (mode !== 'settle' || gameClock.now() - t0 < drawMs - SETTLE_MS) {
      if (onDraw) onDraw(gameClock.now() - t0)
    } else if (!settled) {
      settled = true
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
      if (onSettle) onSettle()
    }
    await Promise.race([sleep(50), charge.cancelled])
  }
  while (!short && !charge.ready(20) && gameClock.now() < holdDeadline && !charge.why()) {
    if (shouldStop?.()) { S.stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение', fullChargeConfirmed: false } }
    S.sol = solve()
    if (S.sol) await bot.look(S.sol.yaw, S.sol.pitch, true).catch(() => {})
    if (onDraw && mode !== 'settle') onDraw(gameClock.now() - t0)
    await Promise.race([sleep(50), charge.cancelled])
  }
  if (!charge.ready(short ? 0 : 20)) { S.stopTick(); cancelDraw(); return { shot: false, why: charge.why() || 'bow_charge_not_confirmed', fullChargeConfirmed: false } }
  // Держать натянутым, пока holdWhile() — его щит поднят к нам, и стрела в щит
  // пропала бы (LivingEntity.applyItemBlocking). Сила уже полная и не растёт
  // (BowItem.getPowerForTime ≤ 1): выстрел в тот тик, когда он опустит щит —
  // а щит он опустит, чтобы ударить. Короткое натяжение (вред) не держим: сила
  // выросла бы. Не дольше holdMaxMs (2026-09-26).
  if (holdWhile && !short) {
    const until = holdDeadline
    while (gameClock.now() < until && holdWhile()) {
      if (charge.why()) { S.stopTick(); cancelDraw(); return { shot: false, why: charge.why(), fullChargeConfirmed: false } }
      if (shouldStop && shouldStop()) { S.stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
      S.sol = solve()
      if (S.sol) await bot.look(S.sol.yaw, S.sol.pitch, true).catch(() => {})
      if (onDraw) onDraw(gameClock.now() - t0)
      await Promise.race([sleep(50), charge.cancelled])
    }
  }
  if (mode === 'settle') {
    // Ещё скользим — дождаться, пока гаснет, но не дольше 150 мс.
    const still = gameClock.now() + 150
    while (!charge.why() && gameClock.now() < still && bot.entity.velocity && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.02) await Promise.race([sleep(25), charge.cancelled])
  }
  if (mode === 'snap' || mode === 'snap2') {
    // Эксперимент: клавиши отпустить в момент спуска (snap) или за тик (snap2).
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
    if (mode === 'snap2') await Promise.race([sleep(60), charge.cancelled])
  }
  const { onSpawn, onRaw, onHurt, release } = armRelease(S)
  let fin: any = await lateRelease(S, release)
  if (!fin) {
    const s = solve()
    const shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
    if (s && !shut) await bot.look(s.yaw, s.pitch, true).catch(() => {})
    fin = release(s, shut, traceAim ? gameClock.serverNow() : null, bot.entity.position.clone())
  }
  if (!fin.released) {
    const shut = fin.shut
    return { shot: false, blocked: !!shut, fullChargeConfirmed: false, why: fin.chargeError || (fin.stopped ? 'отменил натяжение' : fin.unobserved ? 'скорость цели ещё не наблюдалась' : shut ? `на линии стрельбы блок ${shut.x},${shut.y},${shut.z}` : 'не долетит') }
  }

  const out: any = shotOutcome(S, fin)
  if (!follow) {
    // Стрела на 40 блоков летит ~20 тиков: 2.5 с хватает.
    gameClock.setTimeout(() => { bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityHurt', onHurt) }, Math.min(3000, S.sol.ticks * 50 + 1000))
    return out
  }
  // Диагностика: куда реально полетела стрела в первые тики против того, куда
  // целились. Отличает «прицел неверный» от «сервер добавил чужую скорость».
  const firstPos = []
  // Следим за стрелой: попала, или где ближе всего прошла мимо цели.
  let closest = Infinity
  const deadline = gameClock.now() + Math.max(1500, S.sol.ticks * 50 + 1200)
  while (gameClock.now() < deadline && !S.hit) {
    if (S.arrow && S.arrow.position && entity.position) {
      if (firstPos.length < 3) firstPos.push({ p: S.arrow.position.clone(), t: gameClock.now() })
      const c = point ? point(0) : entity.position.offset(0, (entity.height || 1.8) / 2, 0)
      const dd = S.arrow.position.distanceTo(c)
      if (dd < closest) closest = dd
      if (S.arrow.isValid === false) break
    }
    await sleep(50)
  }
  try { bot._client.removeListener('packet', onRaw) } catch {}
  arrowDiag(S, out)
  bot.removeListener('entitySpawn', onSpawn)
  bot.removeListener('entityHurt', onHurt)
  out.hit = S.hit
  if (!S.hit && closest < Infinity) out.missBy = Math.round(closest * 10) / 10
  if (!S.arrow) out.note = 'свою стрелу не увидел'
  return out
  } finally { S.stopTick(); if (S.sent) charge.close(); else charge.cancel() }
}

export { shoot }
