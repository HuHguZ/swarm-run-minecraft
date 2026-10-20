'use strict'
// Штрек к золоту бастиона (sealedGold, bastion/sealed-gold.ts) — состояние захода. Прежние let замыкания sealedGold —
// поля объекта sg (SealedRun), значения одного оборота цикла — tk (SealTick). Шаги цикла — sealed-gold/steps.ts,
// route.ts, gold.ts: шаг возвращает 'next' (прежний continue), 'stop' (прежний break) или ничего (дальше по шагам).
import { gameClock } from '../take-gold-block'
import { answerAttack } from '../defense'

export type Turn = 'next' | 'stop' | undefined

export interface SealedRun {
  session: any
  ctl: any
  st: any
  until: number
  bot: any
  dimension: any
  SL: typeof import('../../sealed')
  S: any
  noPlan: number
}

// Значения одного оборота (прежние const тела while, нужные нескольким шагам).
export interface SealTick {
  tg?: any[]
  minRank?: number
  feet?: () => any
  tgGoals?: any[]
  hit?: any
  t?: any
  opens?: boolean
}

// An unchanged physical failure stays closed for this RPC; the campaign reopens it after new evidence or an approach.
function routeRetryAt (ms) { return process.env.ND_NE_RECOVER === '1' ? Infinity : gameClock.now() + ms }

// Сундуки, известные заходу и ещё не взятые/не отложенные, — цели штрека (прежнее выражение chestsT в цикле sealedGold).
function chestTargets (st) { return st.lootChests ? [...st.chestSeen.entries()].filter(([k]) => !st.looted.has(k) && (st.skip.get(k) || 0) < gameClock.now()).map(([k, v]) => ({ k, pos: v.pos, chest: true })) : [] }

// Начало захода (прежнее начало sealedGold до цикла).
export function sgOpen (session, ctl, st, until): SealedRun {
  const bot = session.bot
  const dimension = bot.game?.dimension
  const SL: typeof import('../../sealed') = require('../../sealed')
  const S = st.sealedState || (st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 })
  const sg = { session, ctl, st, until, bot, dimension, SL, S } as SealedRun
  S.deadline = until
  // Вслепую — план по шаблону узнанного бастиона (template-view), сверка исполнителя — только с видимым (S.honest); попутная
  // руда (bonusGold) судит по скрытым соседям — выкл.
  if ((require('../../nether-cover') as typeof import('../../nether-cover')).blind()) { S.honest = true; S.noBonus = true }
  S.onThreat = async () => { try { await answerAttack(session, ctl, st) } catch {} }
  // BonusGold обходит проверку цели; в этом эксперименте охраняемое копаем только здесь.
  if (st.fastSafe) S.noBonus = true
  sg.noPlan = 0
  return sg
}

export { routeRetryAt, chestTargets }
