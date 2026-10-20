'use strict'
// Бой с драконом (dragon/pillar-run.ts): бегун по столбу — pillarRun, оркестр прогона. Состояние прогона — объект rs
// (runner-state.ts); оборот цикла — шаги по порядку (runner-steps, runner-pass, runner-click): шаг возвращает 'next'
// (следующий оборот), 'stop' (конец цикла) или ничего (дальше по шагам). Упреждение клика (clickLead) — runner-click.ts.
import { gameClock } from '../dig-down-to'
import { type RunState, type RunTick, type Turn, runOpen, runEnter, runArm } from './runner-state'
import { runPhase, runBeds, runVitals, runForecast, runLevels } from './runner-steps'
import { runPass, runAnchor, runPlace } from './runner-pass'
import { clickLead, runAim, runClick } from './runner-click'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const RUN_STEPS: ((rs: RunState, tk: RunTick) => Promise<Turn>)[] = [
  runPhase, runBeds, runVitals, runForecast, runLevels, runPass, runAnchor, runPlace, runAim, runClick
]

async function pillarRun (session, ctl, stats, track, feed) {
  const rs = runOpen(session, ctl, stats, track, feed)
  try {
    const early = await runEnter(rs)
    if (early) return early
    runArm(rs)
    turn: while (!ctl.aborted && gameClock.now() < rs.tEnd) {
      const tk: RunTick = {}
      for (const step of RUN_STEPS) {
        const r = await step(rs, tk)
        if (r === 'stop') break turn
        if (r === 'next') continue turn
      }
    }
    return rs.out
  } finally {
    rs.out.ms = gameClock.now() - rs.t0
    rs.ev('pillarRun', rs.out)
  }
}

export {
  clickLead, pillarRun
}
