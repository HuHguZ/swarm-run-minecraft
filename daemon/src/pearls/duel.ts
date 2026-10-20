'use strict'
// Дуэль — huntDuel: оркестр охоты. Состояние охоты — duel/state.ts (объект dh), оборот цикла — шаги по порядку
// (duel/steps.ts): шаг возвращает 'next' (следующий оборот), 'stop' (конец цикла) или ничего (дальше по шагам).
import { type DuelHunt, openDuel, closeDuel, duelReport } from './duel/state'
import { type Turn, type DuelTick, duelLimits, duelRest, duelSurvey, duelPoke, duelScout, duelChoose, duelFight, duelAfter } from './duel/steps'

// Порядок шагов оборота — порядок прежнего тела while: первая сработавшая ветка решает оборот.
const DUEL_STEPS: ((dh: DuelHunt, tk: DuelTick) => Turn | Promise<Turn | void>)[] = [
  duelLimits, duelRest, duelSurvey, duelPoke, duelScout, duelChoose, duelFight, duelAfter
]

// ------------------------------------------------------------ hunt: дуэль
// Честный бой один на один (style: 'duel'): эндермен, у которого в 16 блоках
// нет другого, взгляд в глаза с 6..20 блоков, потом combat.fight со щитом
// 'always' (его удар в поднятый щит гасится целиком и отбрасывает его). Между
// боями — еда. Меряем убийства в час и хп за убийство.
async function huntDuel (session, ctl, p: any = {}) {
  const dh = openDuel(session, ctl, p)
  turn: while (!ctl.aborted) {
    const tk: DuelTick = {}
    for (const step of DUEL_STEPS) {
      const r = await step(dh, tk)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
  closeDuel(dh)
  return duelReport(dh)
}

export { huntDuel }
