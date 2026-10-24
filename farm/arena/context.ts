'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Общее для частей арены (запуск — farm/arena/ffa.ts, части боя — farm/arena/*): корень, сон, журнал, ручки окружения и
// контекст боя. Контекст создаёт run() и отдаёт каждой части: изменяемое между частями читается и пишется только полем
// ctx (ctx.between, ctx.round…), не копией; функции частей зовутся через ctx — часть может встать позже той, что её зовёт.
import 'path'
import path = require('path')
export const ROOT = REPO_ROOT
export const sleep = ms => new Promise<any>(r => setTimeout(r, ms))
export const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)
export const SEG_S = Number(process.env.FFA_SEG_S || 30)
// Один против всех (12.10: «всех ботов синими против меня, я один красный — жёсткое месиво»): боты — одна синяя команда,
// человек — красный, усиленный набор; рой оценивает преимущество и расходится за лутом, когда бой невыгоден.
export const SOLO = process.env.ARMS_SOLO === '1'
// Чемпион (пользователь 21.10: «1 красного сильного бота, жёсткого как человек, которому ты вещи выдаёшь, остальных — за
// синих»): первый бот — красный, набор и баффы человека соло, бой — дуэльным движком демона; 29 синих — рой как есть.
export const CHAMP = process.env.ARMS_CHAMP === '1'

type Fn = (...a: any[]) => any
export interface ArenaContext {
  // запуск: слот, набор, режим; карта гонки (модуль раскладки и сама раскладка) и центр поля
  i: number; kit: string; teams: boolean; arms: boolean
  COLOS_MAP: boolean; AL: any; L: any
  X: number; Y: number; Z: number; R: number
  // бойцы
  bots: any[]; N: number; names: string[]; teamOf: Fn
  // ввод-вывод: в бою — настоящие, в тестах — подмена
  rcon: (i: number, cmd: string, timeoutMs?: number) => Promise<any>
  log: Fn
  sleep: (ms: number) => Promise<any>
  // журнал сервера, стоп-файл, габарит уборки, команда человека
  LOGF: string; STOPF: string; BOX: string; HUMAN_TEAM: string | null
  // общее состояние боя (сами объекты не заменяются — только их содержимое)
  pos: Record<string, any>; deaths: Record<string, number>; kills: Record<string, number>
  deadNow: Set<string>; out: Set<string>; deathAt: Record<string, any>
  opened: Set<string>; refills: Map<string, number>; chestBy: Map<string, string>; chestFail: Map<string, number>
  roundWins: Record<string, number>; killGaps: number[]
  busy: Set<string>; labNeed: Record<string, string[]>; brewed: Record<string, boolean>; alchemist: Record<string, string>
  radio: Record<string, any>; humans: Record<string, any>; rel: Record<string, Record<string, number>>
  perches: any[]
  // изменяемое между частями — только через ctx.<поле>
  between: boolean; round: number; stop: boolean; roundT0: number; lastKillAt: number; logAt: number; logBorn?: number
  // выбывшие до конца раунда люди (соло: раунд синих, когда выбыли все)
  humanNames: string[]; humanOut: Set<string>; spawnAt: any
  // сброс ветром: кто и когда бросил в цель (watch), сколько сбросов кончилось смертью (rounds)
  windOutAt?: Record<string, { by: string; at: number; kind: string }>; windKills?: number
  stockChests: (round: number, only?: any[] | null) => Promise<void>
  restoreArena: () => Promise<void>
  // ставят части: map — home, place, armsHome; rounds — readDeaths … endRound; humans — kitHuman … hostile;
  // supply — kitHas … labTask; radio — tell … callout; dangers — dodgeAway; watch — swarmDriver, enemiesOf
  home: Fn; place: Fn; armsHome: Fn
  readDeaths: Fn; board: Fn; reset: Fn; roundKit: Fn; giveBlue: Fn; spreadBots: Fn; endRound: Fn
  kitHuman: Fn; kitStrong: Fn; humanStart: Fn; humanHome: Fn; humanOutWatch: Fn; emote: Fn; eyeOf: Fn; relSay: Fn; hostile: Fn
  kitHas: Fn; needOf: Fn; spare: Fn; armsPrep: Fn; brewTask: Fn; labTask: Fn
  tell: Fn; short: Fn; alive: Fn; radioSay: Fn; callout: Fn
  dodgeAway: Fn
  swarmDriver: any; enemiesOf: Fn
}
