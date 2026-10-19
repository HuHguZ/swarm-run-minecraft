'use strict'
// Бой у спавнера — holdSpawner: оркестр захода. Состояние захода — объект hs (blaze/hold/state.ts), начало —
// hold/start.ts, отдых — hold/rest.ts, оборот цикла — шаги по порядку (hold/survive, fight, gather, position, chores):
// шаг возвращает 'next' (следующий оборот), 'stop' (конец цикла) или ничего (дальше по шагам).
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { shieldWear, arrowsHave } from './targets'
import { type HoldState, type Tick, type Turn, openHold, closeHold, equipSword } from './hold/state'
import { startHold } from './hold/start'
import { stepEnough, stepLowWindow, stepFireResistance, stepGuard, stepSafety, stepOutOfFire } from './hold/survive'
import { stepSurvey, stepOtherFoes, stepDangers, stepBoxRetry, stepMelee, stepBow } from './hold/fight'
import { stepSortie, stepClear, stepIdle, collectBeforeLeave } from './hold/gather'
import { stepAcquire, stepFarBlaze, stepRepost, stepReturn } from './hold/position'
import { stepChores, stepArrows, stepWait } from './hold/chores'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const HOLD_STEPS: ((hs: HoldState, t: Tick) => Turn | Promise<Turn | void>)[] = [
  stepEnough, stepLowWindow, stepFireResistance, stepGuard, stepSafety, stepOutOfFire,
  stepSurvey, stepOtherFoes, stepDangers, stepBoxRetry, stepMelee, stepBow,
  stepSortie, stepClear, stepIdle,
  stepAcquire, stepFarBlaze, stepRepost, stepReturn,
  stepChores, stepArrows, stepWait
]

async function holdSpawner (session, ctl, ctx) {
  const hs = openHold(session, ctl, ctx)
  const { bot, out, guard, radar } = hs
  try {
    const early = await startHold(hs)
    if (early) return early
    await equipSword(hs)
    bot.on('blockUpdate', hs.onClearBlock)
    turn: while (!ctl.aborted && !hs.bail) {
      // Каждый оборот — через таймер: ветка без sleep (вылазка, которой нечего
      // собрать) иначе держит цикл событий, и пакеты мира не читаются.
      await sleep(20)
      const t: Tick = { now: gameClock.now() }
      for (const step of HOLD_STEPS) {
        const r = await step(hs, t)
        if (r === 'stop') break turn
        if (r === 'next') continue turn
      }
    }
    await collectBeforeLeave(hs)
  } finally {
    await closeHold(hs)
  }
  out.shield = guard.report()
  out.shieldWear = shieldWear(bot)
  out.radar = radar.stats
  out.arrowsLeft = arrowsHave(bot)
  return { ...out, stopped: hs.stopped, bail: hs.bail }
}

export { holdSpawner }
