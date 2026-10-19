'use strict'
// Человек в бою (showman.ts): после убийства — присесть над ним, взмах, оглядеться (рефлекс под замком управления).
import * as gameClock from '../game-clock'
import { evaluateSocial } from '../social-graph'
import * as controlLock from '../reflex-lock'
import { between } from './consts'
import { tally, tgt } from './body'
import { say, airSwing } from './posture'
import type { Showman } from './state'

// --------------------------------------------------------------- победа
function victory (H: Showman) {
  const { bot, session, human } = H
  if (H.victoryDone) return
  H.victoryDone = true
  const spot = H.deathSpot || (tgt(H) && tgt(H).position && tgt(H).position.clone())
  if (!spot || !bot.entity) return
  const expression = evaluateSocial({ signal: 'victory', mood: session?.mood?.state?.mood ?? 50,
    affinity: 50, health: bot.health ?? 20, threatLevel: session?.tactics?.snapshot()?.threatLevel ?? 0,
    bodyBusy: !!session?.reflex, airborne: !!bot.entity.elytraFlying || !!bot._ndDescend,
    interrupted: false, distance: bot.entity.position.distanceTo(spot) })
  if (!expression.gesture || !session) return
  session.socialDecision = expression
  if (Math.random() > (human ? 0.95 : 0.6)) return
  const taps = human ? 3 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2)
  tally(H, `победа: присел над ним ×${taps}, взмах, огляделся`)
  say(H, 'kill')
  // Не на поводке боя: арена после смерти второго сразу шлёт stop, и жест
  // внутри боя обрывался. Рефлекс сам кончается за ~3 с и бросает всё, если
  // по нам попали или мозг дал новое дело.
  const cur0 = session && session.current
  const hp0 = bot.health ?? 20
  const tv0 = gameClock.now()
  let ctl: any = null
  const off = () => ctl?.aborted || (session.tactics?.snapshot()?.threatLevel ?? 0) > 0 || !bot.entity || (bot.health ?? 0) < hp0 - 0.5 || (session && session.current && session.current !== cur0) || gameClock.now() - tv0 > 3500
  const wait = (ms) => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))
  controlLock.start(session, async control => {
    ctl = control
    await wait(between(250, 450))
    if (off()) return
    await bot.lookAt(spot.offset(0, 0.3, 0), true).catch(() => {})
    for (let i = 0; i < taps && !off(); i++) {
      bot.setControlState('sneak', true)
      await wait(between(150, 220))
      if (off()) return
      bot.setControlState('sneak', false)
      await wait(between(120, 190))
    }
    if (off()) return
    airSwing(H, 99)
    await wait(between(200, 320))
    const y0 = bot.entity.yaw
    for (const dy of [0.9, -0.9]) {
      if (off()) return
      await bot.look(y0 + dy + between(-0.2, 0.2), between(0.05, 0.25), true).catch(() => {})
      await wait(between(260, 380))
    }
  }, { owner: 'Skill', priority: 1, source: 'social-victory' }).catch(() => {})
}

export { victory }
