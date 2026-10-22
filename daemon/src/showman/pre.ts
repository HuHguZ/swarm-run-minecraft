'use strict'
// Человек в бою (showman.ts): pre — до сшибки и в затишье: стойка, ответ на его жест, засада; рывок начала и нажим
// pvp.js отдают тело бою в тот же тик.
import * as gameClock from '../game-clock'
import { FIXP, THEIR_REACH, between } from './consts'
import { tally, release, drive } from './body'
import { readGestures } from './watch'
import { tickPhase } from './phase'
import { say, airSwing, closingOf, unsafeWhy, nextAct, actTick } from './posture'
import { hideStart, hideTick } from './hide'
import type { Showman } from './state'

// ------------------------------------------------------------------ pre
async function pre (H: Showman, c) {
  const { bot, human, persona, stats, cds, stopPath } = H
  if (bot.entity?.elytraFlying || bot._ndDescend) { release(H); return false }
  const now = gameClock.now()
  const dt = Math.min(100, now - H.lastTick)
  if (H.foeKey) bot._ndShowMet?.set(H.foeKey, now)
  tickPhase(H, c)
  readGestures(H, c)
  const closing = closingOf(H, c)
  c.closingNow = closing
  // Его руку мы уже видели вблизи — бой начался; затишье — разошлись.
  if (c.theirR < THEIR_REACH + 0.2) { H.lastExchange = now; H.engaged = true }
  if (now - H.lastExchange < 2000) H.lullRolled = false
  try {
    // Нажим (pvp.js): долго без размена — никакой стойки и засады, в бой.
    if (FIXP && c.press) {
      if (H.hide) { H.hide = null; tally(H, 'засада: нажим — выхожу') }
      if (H.posture) { H.posture = null; H.engaged = true }
      release(H)
      return false
    }
    if (H.hide) return hideTick(H, c)
    // Засада — до стойки: от лучника и от бегущего на нас.
    if (!c.perch && !c.fort && !c.meInWeb && !c.others && (await hideStart(H, c))) return true
    // Рывок начала (tempo.pickOpening): в напоре — бежать, как решил темп;
    // иначе чаще сперва покружить (жалоба: «просто бегут и бьют вслепую»).
    // Наказание занятого (punRush) — всегда рывок: окно короткое.
    if (c.openRush && H.honorRush === null) H.honorRush = (H.phase && H.phase.name === 'напор') || Math.random() < 0.25
    const rushing = c.punRush || (c.openRush && H.honorRush)
    // На рывке стойки нет, а мечом на бегу помахать можно — если заряд
    // успеет вернуться до его руки (airSwing: на Paper взмах его сбрасывает).
    if (rushing) {
      release(H)
      if (c.d > 3.8 && c.d < 13 && H.rushSwings < 3 && now >= (cds.rushSwing || 0) && Math.random() < persona.show * 0.5 && airSwing(H, c.theirR, true)) {
        H.rushSwings++
        cds.rushSwing = now + between(300, 500)
        if (H.rushSwings === 1) tally(H, 'жест: машет мечом на бегу')
      }
      return false
    }
    const why = c.d > 13 ? 'далеко' : unsafeWhy(H, c, closing)
    if (why) {
      if (H.posture) { if (why !== 'далеко' && why !== 'не вижу') H.engaged = true; H.posture = null }
      release(H)
      return false
    }
    if (!H.posture) {
      let budget = 0
      const ph = H.phase ? H.phase.name : 'шоу'
      if (!H.engaged) {
        // Начало: до сшибки покружить, по нраву и фазе.
        budget = ph === 'шоу' ? between(2500, 5000) : ph === 'хитрость' ? between(1500, 3000) : ph === 'оборона' ? between(1200, 2800) : (Math.random() < 0.4 ? 0 : between(500, 1500))
      } else if (now - H.lastExchange > 2000 && !H.lullRolled) {
        // Затишье (разошлись после размена) — иногда подразнить.
        H.lullRolled = true
        const p = (0.15 + persona.show * 0.4) * (ph === 'шоу' ? 1.8 : ph === 'напор' ? 0.4 : 1) * (human ? 1 : 0.6)
        if (Math.random() < p) budget = between(600, 1800)
      }
      if (H.mirror && !budget) budget = 1200 // на жест ответить всегда
      budget *= (0.7 + persona.patience * 0.6) * (human ? 1.2 : 0.85)
      // Стойка — короткое окно (FIX): до сшибки ≤ 3 с, в затишье ≤ 1.5 с, за бой
      // всего ≤ 8 с — дальше только бой.
      if (FIXP) budget = stats.showMs > 8000 ? 0 : Math.min(budget, H.engaged ? 1500 : 3000)
      if (budget < 250) { if (!H.engaged) H.engaged = true; return false }
      H.posture = { budgetUntil: now + budget, act: null }
      if (!H.engaged) tally(H, `стойка перед боем (${ph})`)
    }
    if (now >= H.posture.budgetUntil && !(H.mirror && now >= H.mirror.after)) {
      H.posture = null
      H.engaged = true
      release(H)
      return false
    }
    let act = H.posture.act
    if (!act || now >= act.until) act = nextAct(H, c)
    if (act.kind === 'подзыв' && act.n === 0) { act.n = 1; say(H, 'posture') }
    const k = actTick(H, act, c)
    // Погоня pathfinder'ом перебивает клавиши каждый тик — снять её.
    if (!H.driving) stopPath()
    drive(H, k)
    stats.showMs += dt
    return true
  } finally {
    H.lastTick = now
  }
}

export { pre }
