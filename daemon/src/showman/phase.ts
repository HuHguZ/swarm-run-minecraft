'use strict'
// Человек в бою (showman.ts): фаза боя (напор, оборона, хитрость, шоу) — выбор по нраву, настроению и размену хп,
// смена по своему ритму и учёт времени в фазах.
import * as gameClock from '../game-clock'
import { evaluateSocial } from '../social-graph'
import { FIXP, PHASES, between, weighted } from './consts'
import { tally, tgt } from './body'
import type { Showman } from './state'

// ---------------------------------------------------------------- фазы
function nextPhase (H: Showman, c) {
  const { bot, session, style, human, persona } = H
  const w: any = {}
  for (const p of PHASES) w[p] = persona.bias[p]
  const expression = evaluateSocial({ signal: 'wave', mood: session?.mood?.state?.mood ?? 50,
    affinity: session?.mood?.affinity(tgt(H)?.username) ?? 50, health: c.hp ?? 20,
    threatLevel: c.theirR < 4 ? 1 : 0, bodyBusy: false,
    airborne: !!bot.entity?.elytraFlying || !!bot._ndDescend, interrupted: false, distance: c.d ?? 3 })
  if (expression.node === 'Quiet') w.шоу *= 0.1
  if (expression.node === 'Cautious') { w.оборона *= 1.4; w.шоу *= 0.5 }
  w.напор *= 0.6 + (style.aggression ?? 0.6) // характер боя из pvp.js
  const diff = (c.hp ?? 20) - (c.theirHp ?? 20)
  if (diff <= -4) { w.оборона *= 1.8; w.хитрость *= 1.4; w.шоу *= 0.3; w.напор *= 0.7 }
  if (diff >= 4) { w.напор *= 1.5; w.шоу *= 1.4 }
  if ((c.hp ?? 20) < 9) w.шоу *= 0.15
  if (!human) w.шоу *= 0.6
  if (H.phase) w[H.phase.name] *= 0.45 // тянет сменить
  const name = weighted(w)
  const was = H.phase ? H.phase.name : null
  H.phase = { name, since: gameClock.now(), until: gameClock.now() + (FIXP ? between(6000, 14000) : between(10000, 30000)) * persona.rhythm }
  if (name !== was) tally(H, 'фаза: ' + name)
}
function tickPhase (H: Showman, c) {
  const { stats } = H
  const now = gameClock.now()
  if (H.phase) stats.phaseMs[H.phase.name] = (stats.phaseMs[H.phase.name] || 0) + Math.min(200, now - H.phaseAt)
  H.phaseAt = now
  if (!H.phase || now >= H.phase.until) nextPhase(H, c)
}

export { nextPhase, tickPhase }
