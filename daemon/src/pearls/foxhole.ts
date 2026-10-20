'use strict'
// Окоп (style: 'foxhole') — huntFoxhole: оркестр охоты. Место, постройка, вход и выход окопа — foxhole/site.ts,
// состояние охоты — foxhole/state.ts (объект fh), оборот цикла — шаги по порядку (foxhole/steps.ts): шаг возвращает
// 'next' (следующий оборот), 'stop' (конец цикла) или ничего (дальше по шагам).
import * as gameClock from '../game-clock'
import { xyz } from '../movement'
import { countOf } from '../items'
import { log } from './common'
import { endermanReach } from './shelter'
import { foxHere, foxExit } from './foxhole/site'
import { type FoxHunt, openFoxHunt, closeFoxHunt, foxNewSite } from './foxhole/state'
import {
  type Turn, type FoxTick, stepLimits, stepReturn, stepTend, stepStrike, stepPending, stepStareHere, stepPoke, stepHot,
  stepPeek, stepLying, stepStalk, stepIdle
} from './foxhole/steps'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const FOX_STEPS: ((fh: FoxHunt, tick: FoxTick) => Turn | Promise<Turn | void>)[] = [
  stepLimits, stepReturn, stepTend, stepStrike, stepPending, stepStareHere, stepPoke, stepHot, stepPeek, stepLying,
  stepStalk, stepIdle
]

async function huntFoxhole (session, ctl, p: any = {}) {
  const fh = openFoxHunt(session, ctl, p)
  const { bot, mcData } = fh
  try {
    fh.fox = foxHere(bot, mcData)
    if (fh.fox) { try { fh.reach = endermanReach(bot, fh.fox.out, { radius: 28 }) } catch {} ; log('окоп: уже в нём', { at: xyz(fh.fox.P) }) }
    else {
      const s = await foxNewSite(fh)
      log('окоп', s.ok ? { at: xyz(s.fox.P), placed: s.placed } : s)
      if (!s.ok) fh.stopped = s.why
      else fh.fox = s.fox
    }
    turn: while (fh.fox && !ctl.aborted) {
      const tick: FoxTick = {}
      for (const step of FOX_STEPS) {
        const r = await step(fh, tick)
        if (r === 'stop') break turn
        if (r === 'next') continue turn
      }
    }
  } finally {
    closeFoxHunt(fh)
  }
  // Жемчуга хватает — наружу (дальше идти ногами); нет — сидеть в окопе до следующего вызова.
  if (fh.fox && countOf(bot, 'ender_pearl') >= fh.want) await foxExit(bot, ctl, mcData, fh.fox).catch(() => false)
  return foxReport(fh)
}

// Итог охоты (прежний хвост huntFoxhole).
function foxReport (fh: FoxHunt) {
  const { bot } = fh
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - fh.t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'окоп',
    ...((process.env.ND_NE_RECOVER === '1' || process.env.ND_EM_PRICE_RECEIPTS === '1') ? { prepared: !!fh.fox } : {}),
    pearls: { before: fh.pearls0, now: pearls, gained: pearls - fh.pearls0, want: fh.want },
    kills: fh.kills,
    aggros: fh.aggros,
    stares: fh.stares,
    peeks: fh.peeks,
    pokes: fh.pokes,
    stalks: fh.stalks,
    openFights: fh.openFights,
    moves: fh.moves,
    hits: fh.hits,
    hitsOnMe: fh.hitsOnMe,
    killsPerHour: secs ? Math.round(fh.kills * 3600 / secs) : 0,
    rounds: fh.rounds.slice(-10),
    hpLost: Math.max(0, fh.hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < fh.want) {
    detail.need = { what: 'ender_pearl', count: fh.want - pearls, have: pearls }
    detail.stopped = `${fh.stopped || 'встал'} — жемчуга ${pearls} из ${fh.want} (убил ${fh.kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${fh.kills} (разозлил ${fh.aggros} из ${fh.stares} взглядов, выглядывал ${fh.peeks}) за ${secs} с (окоп под крышей).`
  return detail
}

export { huntFoxhole }
