'use strict'
// Бой с драконом (dragon/pillar-run.ts): fightDragon — оркестр боя. Состояние боя — объект fx (fight-state.ts); оборот
// цикла — шаги по порядку (fight-state, fight-pillar, fight-beds, fight-steps): шаг возвращает 'next' (следующий оборот),
// 'stop' (конец цикла) или ничего (дальше по шагам этого оборота). Станция кроватей — station.ts.
import { gameClock, yieldTick, hpOf } from '../dig-down-to'
import { doing } from '../fall-guard'
import { portalBlocks } from '../pillar-plan'
import {
  type Fight, type FightTick, type Turn, openFight, armFight, fightActive, fightLookFor, fightTrack, fightReport
} from './fight-state'
import { fightPillar } from './fight-pillar'
import { fightBedsPlan, fightKeepBeds, fightBedsPerch, fightBedsOnly } from './fight-beds'
import { fightSurvive, fightSupplies, fightStation, fightFlying } from './fight-steps'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const FIGHT_STEPS: ((fx: Fight, t: FightTick) => Promise<Turn>)[] = [
  fightTrack, fightPillar, fightBedsPlan, fightKeepBeds, fightBedsPerch, fightSurvive, fightSupplies, fightBedsOnly,
  fightStation, fightFlying
]

async function fightDragon (session, ctl, rep, stats, { deadline, perches = 0 }: any) {
  const fx = openFight(session, ctl, rep, stats, deadline, perches)
  const { bot, track } = fx
  fx.d = track.tick() || await fightLookFor(fx, 60000)
  if (!fightActive(fx)) { rep.dragon.lost = 'бой прерван: тело сменилось, погибло или вышло из Края'; return }
  if (!fx.d) {
    rep.dragon.seen = false
    if (portalBlocks(bot).length) { rep.dragon.won = true; rep.dragon.lost = 'дракона нет, выходной портал горит — убит' } else rep.dragon.lost = 'дракона не видно минуту, выходной портал не горит — жив, но не найден'
    return
  }
  rep.dragon.seen = true
  rep.dragon.hpStart = Math.round(hpOf(bot, fx.d) ?? 0)
  armFight(fx)
  turn: while (fightActive(fx) && gameClock.now() < deadline) {
    await yieldTick()
    if (!fightActive(fx) || gameClock.now() >= deadline) break
    doing(ctl, 'fight')
    const t: FightTick = {}
    for (const step of FIGHT_STEPS) {
      const r = await step(fx, t)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
  fightReport(fx)
}

export { fightDragon }
