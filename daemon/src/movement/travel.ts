'use strict'
// Ходьба: отрезок по XZ (travelXZ) — из воды, с ожиданием пути и встряской.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, stuckGuard, unstick } from './basics'
import { inWater } from './water'
import { escapeWater } from './escape-water'
import { gotoPath } from './goto'
import { surfaceDropGuard } from '../session/surface-walk'

// Walk toward a column, guarded. Used by exploration, where a failed leg just
// means "try another direction" rather than "the intent failed".
export async function travelXZ (bot, ctl, x, z, { range = 4, retries = 2, deadline = null, y = null }: any = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (ctl.aborted) return { ok: false, error: 'прервано' }
    if (deadline && gameClock.now() >= deadline) return { ok: false, error: 'время вышло', outOfTime: true }

    // Never start a walk from inside a river — pathfinder will just thrash.
    if (inWater(bot)) {
      const esc = await escapeWater(bot, ctl, { timeoutMs: deadline ? Math.max(1, deadline - gameClock.now()) : 25000 })
      // Отказ без единого таймера (нет пути из воды) — тик игрового времени, иначе цикл вызывающего крутится микрозадачами
      // и вешает демон (s5c-f4-4 06.10: explore, 100 % CPU, часы стоят).
      if (!esc.ok) { await sleep(50); return { ok: false, error: esc.error, surfaceDrop: esc.surfaceDrop } }
    }

    const dropGuard = surfaceDropGuard(bot)
    const guard = stuckGuard(bot, ctl)
    const goal = Number.isFinite(y)
      ? new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range)
      : new goals.GoalNearXZ(Math.floor(x), Math.floor(z), range)
    const path = gotoPath(bot, goal)
    const activeOther = () => {
      const active = bot._ndReflexSession?._reflexState?.active
      return active && active.ctl !== ctl && (active.owner === 'Tactical' || active.owner === 'Emergency')
    }
    const canSwim = () => !ctl.aborted && !activeOther() && !bot._ndParkourForecast && bot.pathfinder.goal === goal &&
      inWater(bot) && !goal.isEnd(bot.entity.position.floored()) && !bot.pathfinder.isMoving?.() &&
      !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.() && !bot.targetDigBlock && !bot.usingHeldItem && !bot.currentWindow
    const water = {}, onWet = () => { if (canSwim()) handoff(water) }
    let handoff
    const wet = new Promise(resolve => { handoff = resolve })
    bot.on('physicsTick', onWet)
    const racers = [
      path,
      guard.promise,
      wet,
      dropGuard.promise
    ]
    // A single leg must not outlive the caller's budget: the guard only fires
    // when the bot stops moving, and a bot walking the wrong way forever is
    // still "moving".
    let timer = null
    if (deadline) {
      const left = Math.max(1, deadline - gameClock.now())
      racers.push(new Promise<any>((_resolve, reject) => {
        timer = gameClock.setTimeout(() => reject(Object.assign(new Error('время вышло'), { outOfTime: true })), left)
      }))
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      const cancelled = path.cancel?.(); cancelled?.catch?.(() => {})
      dropGuard.stop(); guard.stop(); bot.removeListener('physicsTick', onWet)
      if (timer) gameClock.clearTimeout(timer)
    }

    try {
      const outcome = await Promise.race(racers)
      if (outcome === water) {
        // A synchronous goal/lease change may arrive after detection but before
        // this continuation. Release only our waiters and leave the new owner alone.
        if (!canSwim()) return { ok: false, error: 'путь передан другому действию или прерван' }
        release()
        bot.pathfinder.setGoal(null)
        if (ctl.aborted || activeOther()) return { ok: false, error: 'прервано' }
        const esc = await escapeWater(bot, ctl, { timeoutMs: deadline ? Math.max(1, deadline - gameClock.now()) : 25000 })
        if (!esc.ok) return { ok: false, error: esc.error, surfaceDrop: esc.surfaceDrop }
        if (ctl.aborted || activeOther() || bot.pathfinder.goal !== null) return { ok: false, error: 'путь передан другому действию или прерван' }
        if (goal.isEnd(bot.entity.position.floored())) return { ok: true }
        // A successful change of transport resumes this same leg, even when
        // retries=0. A physical swim refusal is returned above without an unstuck jump.
        attempt--; continue
      }
      // mineflayer-pathfinder 2.4.5 lib/goto.js: путь длиной 0 («partial», ни
      // одного шага) goto считает ДОСТИГНУТОЙ целью и резолвит без ошибки.
      // В Аду (искажённый лес, обрывы) это «ok» у тела, не сдвинувшегося ни на
      // блок: разведка крепости насчитала 208 пройденных блоков при 47
      // настоящих (try-nether-trip, 2026-09-25). Свидетель — где тело.
      const at = bot.entity.position
      if (Math.hypot(at.x - (Math.floor(x) + 0.5), Number.isFinite(y) ? at.y - Math.floor(y) : 0, at.z - (Math.floor(z) + 0.5)) > range + 1.5) {
        throw Object.assign(new Error('pathfinder не нашёл к цели ни шага (путь длиной 0) — не дошёл'), { noStep: true })
      }
      return { ok: true }
    } catch (err) {
      lastError = err
      release()
      if (err.outOfTime) {
        if (bot.pathfinder.goal === goal && !activeOther()) { try { bot.pathfinder.setGoal(null) } catch {} }
        return { ok: false, error: 'время вышло', outOfTime: true }
      }
      if (bot.pathfinder.goal !== goal || activeOther()) return { ok: false, error: err.message }
      try { bot.pathfinder.setGoal(null) } catch {}
      if (ctl.aborted) return { ok: false, error: err.message }
      if (err.surfaceDrop) { bot.clearControlStates(); return { ok: false, error: err.message, surfaceDrop: true } }
      // Пути нет вовсе — тело и не застревало: рывок назад тут не лечит, а у
      // обрыва в Аду убивает (падение насмерть, try-nether-trip 2026-09-25).
      if (err.noStep) {
        if (!Number.isFinite(y) && bot.physics && bot.entity.onGround && Math.hypot(bot.entity.position.x - (Math.floor(x) + .5), bot.entity.position.z - (Math.floor(z) + .5)) <= 6) {
          const jump = await (require('../navigation/parkour') as typeof import('../navigation/parkour')).tryLocal(bot, ctl, { x, z })
          if (jump.ok) return { ok: true, parkour: jump }
        }
        return { ok: false, error: err.message, noStep: true }
      }
      await unstick(bot)
    } finally {
      release()
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'не дошёл' }
}
