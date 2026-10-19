'use strict'
// Человек в бою (showman.ts): отчёт слоя за бой (нрав, фазы, доля шоу и тактики, финты) и закрытие: снять слушателей.
import * as gameClock from '../game-clock'
import { release } from './body'
import type { Showman } from './state'

// ---------------------------------------------------------------- отчёт
function report (H: Showman) {
  const { human, persona, t0, stats } = H
  const total = gameClock.now() - t0
  const ph = {}
  for (const [k, v] of ((Object.entries(stats.phaseMs) as [string, any][]) as any)) ph[k] = Math.round(v / 100) / 10
  return {
    on: true,
    нрав: persona.name,
    противник: human ? 'человек' : 'бот',
    фазы: ph,
    showMs: Math.round(stats.showMs),
    tacticMs: Math.round(stats.tacticMs),
    fightMs: total,
    showPct: total ? Math.round(stats.showMs / total * 1000) / 10 : 0,
    tacticPct: total ? Math.round(stats.tacticMs / total * 1000) / 10 : 0,
    baits: H.baits,
    bites: H.bites,
    acts: stats.acts
  }
}
function close (H: Showman) {
  const { bot, used } = H
  if (H.closed) return
  H.closed = true
  release(H)
  bot.removeListener('entityCrouch', H.onCrouch)
  bot.removeListener('entitySwingArm', H.onSwing)
  bot.removeListener('entityHurt', H.onHurt)
  bot.removeListener('entityDead', H.onDead)
  bot.removeListener('physicsTick', H.onTick)
  const r = report(H)
  if (r.fightMs > 1500) used(`человек: шоу ${r.showPct}%, финты и засады ${r.tacticPct}% времени боя`)
  try { console.log('[human]', JSON.stringify({ at: new Date().toTimeString().slice(0, 8), bot: bot.username, ...r })) } catch {}
}

export { report, close }
