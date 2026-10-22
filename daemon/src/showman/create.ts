'use strict'
// Человек в бою (showman.ts): create — слой на один бой. Собирает состояние H (опции pvp.js, нрав, счёт и переменные
// жестов, фазы, стойки, засады, финтов, победы — в прежнем порядке), ставит слушателей его жестов и отдаёт крючки.
import * as gameClock from '../game-clock'
import { ON, CHAT, pick } from './consts'
import { personaOf, isBotName } from './persona'
import { watchHim } from './watch'
import { pre } from './pre'
import { steer } from './steer'
import { victory } from './victory'
import { report, close } from './report'
import type { Showman } from './state'

function create (opts) {
  if (!ON) return null
  const { bot, session, target, observe = e => e, style = {}, used = () => {}, set, aimTo, stopPath, tt, stepOk, cover, fillerCount, styleOut, weaponMs, onAirSwing, nearDrop = null } = opts
  const me0 = target()
  const human = !isBotName(me0 && me0.username)
  const persona = personaOf(bot.username)
  if (styleOut) { styleOut.нрав = persona.name; styleOut.противник = human ? 'человек' : 'бот' }
  const t0 = gameClock.now()
  const stats = { showMs: 0, tacticMs: 0, acts: {}, phaseMs: {} }
  const cds: any = {}
  const H = { bot, session, target, observe, style, used, set, aimTo, stopPath, tt, stepOk, cover, fillerCount, weaponMs, onAirSwing, nearDrop,
    human, persona, t0, stats, cds } as Showman

  // ------------------------------------------------------------ его жесты
  H.seen = { crouches: [], swings: [], pitch: [], yaw: [], jumps: [], myY: [], ground: null, peak: null, lastY: null }
  H.hits = { took: [], gave: [] }
  H.lastExchange = 0
  H.deathSpot = null
  H.whiff = null
  watchHim(H)
  H.mirrored = {}
  H.mirror = null

  // ---------------------------------------------------------------- фазы
  H.phase = null
  H.phaseAt = gameClock.now()

  // --------------------------------------------------------------- стойка
  H.driving = false
  H.lease = 0
  H.posture = null // { budgetUntil, act }
  // Стойка перед боем — раз на встречу, а не на каждый вызов боя: рой зовёт бой заново каждые 3–12 с и после каждого уворота,
  // и бот снова по 3 с красовался в 5 бл. от человека — стоял под его мечом (стенд бота-противника 22.10: стойка 3000 мс из
  // 9050 мс боя). Встреча — тот же противник в последние 30 игровых с (pre продлевает её, пока бой идёт).
  H.foeKey = me0 ? String(me0.username || me0.id) : null
  const met = bot._ndShowMet || (bot._ndShowMet = new Map())
  H.engaged = !!H.foeKey && gameClock.now() - (met.get(H.foeKey) ?? -Infinity) < 30000
  if (H.foeKey) met.set(H.foeKey, gameClock.now())
  H.lullRolled = false
  H.lastTick = gameClock.now()
  H.rushSwings = 0
  H.honorRush = null
  H.circleKey = Math.random() < 0.5 ? 'left' : 'right'
  H.circleFlipAt = 0
  H.chatSlot = null
  const chatP = (human ? 0.5 : 0.12) * (0.5 + persona.chat)
  if (CHAT && Math.random() < chatP) H.chatSlot = pick(['kill', 'kill', 'posture', 'mirror'])

  // ---------------------------------------------------------------- засада
  H.hide = null

  // ---------------------------------------------------------------- steer
  H.bait = null
  H.baits = 0
  H.bites = 0
  H.baitOff = false
  H.baitRolled = false
  H.retreat = null
  H.pauseUntil = 0
  H.pauseRolledAt = 0
  H.lastSteer = gameClock.now()

  // --------------------------------------------------------------- победа
  H.victoryDone = false

  // ---------------------------------------------------------------- отчёт
  H.closed = false

  return { pre: c => pre(H, c), steer: (k, c) => steer(H, k, c), victory: () => victory(H), report: () => report(H), close: () => close(H), hiding: () => !!H.hide, persona, human }
}

export { create }
