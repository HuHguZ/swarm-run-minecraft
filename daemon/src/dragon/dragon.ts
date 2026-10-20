'use strict'
// Бой с драконом — вход RPC (dragon) и оркестр вызова (dragonFight). Состояние вызова — объект df (dragon/state.ts:
// отчёт, осмотр, прогрузка Края, снаряжение, сторожа), путь к центру и бой — стадии dragon/route.ts.
import { gameClock } from './dig-down-to'
import { type DragonFight, dfOpen, dfLook, dfArrive, dfKit, dfArm, dfError, dfClose } from './dragon/state'
import { dfGear, dfModes, dfIsland, dfCenter, dfFight } from './dragon/route'
// 750 TPS (s5, 06.10): A* pathfinder'а считает бюджет в РЕАЛЬНЫХ мс — 40 мс на срез (tickTimeout) и до 5 с на путь
// (thinkTimeout). На 750 тиках/с срез — 30 игровых тиков без физики, путь — до 190 игровых с (s5-b2-s2: 78 расчётов
// «partial», 6.9 с реального времени у моста; s5-b2-s4: до центра не дошёл за 600 с). Бюджет боя — в игровом времени.
function scalePathBudget (bot, rate = gameClock.snapshot()?.tickRate ?? 20) {
  const pf = bot.pathfinder
  if (!pf || !(rate > 20)) return () => {}
  const tick0 = pf.tickTimeout; const think0 = pf.thinkTimeout
  pf.tickTimeout = Math.max(1, tick0 * 20 / rate)
  pf.thinkTimeout = Math.max(500, think0 * 20 / rate)
  return () => { pf.tickTimeout = tick0; pf.thinkTimeout = think0 }
}

async function dragon (session, ctl, p: any = {}) {
  const bot = session.bot
  const undo = scalePathBudget(bot)
  // Выходной портал встаёт под станцией у столба (окоп в его кольце): после убийства тело падает в портал — титры.
  // Ответ perform_respawn теперь у всего демона (credits.ts, s5c 06.10), не только на время навыка (s5-e23-s7).
  ;(require('../credits') as typeof import('../credits')).install(bot)
  // окно точности на ферме (dragon/precision.ts, ND_PRECISION_TPS): посадка при готовой станции и опасность рядом
  const prec: typeof import('./precision') = require('./precision')
  const pwTimer = prec.precisionRate() ? gameClock.setInterval(() => { try { prec.precisionTick(bot, ctl) } catch {} }, 100) : null
  try { return await dragonFight(session, ctl, p) } finally { if (pwTimer) gameClock.clearInterval(pwTimer); undo(); prec.precisionOff(bot, ctl) }
}

// Стадии внутри try по порядку прежнего тела: стадия возвращает отчёт (конец вызова) или ничего (дальше).
const DF_STAGES: ((df: DragonFight) => Promise<any>)[] = [dfGear, dfModes, dfIsland, dfCenter, dfFight]

async function dragonFight (session, ctl, p: any = {}) {
  const df = dfOpen(session, ctl, p)
  const { bot } = df
  if (!/end/.test(bot.game.dimension)) throw new Error(`я не в Энде (${bot.game.dimension}): бой с драконом — в Энде, сначала портал`)

  if (df.mode === 'look') return dfLook(df)

  const arrived = await dfArrive(df)
  if (arrived !== undefined) return arrived
  const short = dfKit(df)
  if (short !== undefined) return short

  dfArm(df)
  try {
    for (const stage of DF_STAGES) {
      const r = await stage(df)
      if (r !== undefined) return r
    }
  } catch (e) {
    return dfError(df, e)
  } finally {
    dfClose(df)
  }
}

export { dragon, scalePathBudget }
