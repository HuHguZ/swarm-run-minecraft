'use strict'
import * as gameClock from './game-clock'
// Все числа механики — Java 1.21 (minecraft.wiki, «Damage», «Attack cooldown»,

import { sleep } from './movement'
import * as totemMod from './totem'
import { canUseRanged } from './play-policy'
import { createLastSeen } from './pvp/last-seen'
import { TICK_MS } from './pvp/rules'
import { NEXT, type DuelCtx, type TurnFrame } from './pvp/turn'
import { initDuelState } from './pvp/duel-state'
import { installCore, installDamageLog, installTempo } from './pvp/duel-core'
import { installProbes, installTrace, installSight, installInputs } from './pvp/duel-probes'
import { installStrafe, installMelee, installShotGate } from './pvp/duel-melee'
import { installEvents, installFloorWatch, installFallAndAim } from './pvp/duel-events'
import { installServices } from './pvp/duel-services'
import { installSkillDelegates, installPerchDrop, installFortDelegates, installFort, installHazardSkills, installSkills, installLateSkills } from './pvp/duel-skills'
import { installReport } from './pvp/duel-report'
import { installTarget, installMaceChain } from './pvp/duel-target'
import { openDuel } from './pvp/duel-opening'
import { targetTurn, measureTurn, foeReadTurn, noteSightTurn, postureTurn } from './pvp/turn-target'
import { safetyTurn, blastRetreatTurn, lowHpTurn, perchTurn } from './pvp/turn-escape'
import { skySenseTurn, braceReleaseTurn, skyDefenseTurn, pearlResponseTurn, flightTurn, glideShotTurn } from './pvp/turn-air'
import { recoverTurn, dressTurn, rebuffTurn, offhandTurn, fortTurn, healTurn } from './pvp/turn-heal'
import { fightGraphTurn } from './pvp/turn-graph'
import { holdArenaTurn, arenaClimbTurn, climbToHimTurn, hiddenFoeTurn, breakUnderTurn, counterPillarTurn, standoffTurn, stuckTurn, hopTurn, repositionTurn } from './pvp/turn-reach'
import { mobDetourTurn, duoTurn, backAttackerTurn } from './pvp/turn-foes'
import { maceDefenseTurn, windPushTurn, smashSetupTurn, smashTurn } from './pvp/turn-mace'
import { boomDefenseTurn, crystalTurn, boomOffenseTurn } from './pvp/turn-blast'
import { arrowPickupTurn, crossbowTurn, bowTurn } from './pvp/turn-ranged'
import { terrainTurn, scoopTurn, webTurn, webObstacleTurn, fireTurn, pitTurn } from './pvp/turn-hazards'
import { incomingTurn, dodgeTurn, shieldsTurn } from './pvp/turn-projectiles'
import { punishTurn, potionFirstTurn, utilTurn, showmanTurn } from './pvp/turn-tempo'
import { flyerTurn, farApproachTurn, debuffTurn, spearTurn, lanceWebTurn } from './pvp/turn-approach'
import { meleeIntentTurn, creeperFleeTurn, steerTurn, edgeTurn, unblockTurn, exitTurn, hitKindTurn, floorEscapeTurn, controlsTurn, strikeTurn } from './pvp/turn-melee'

// Ход боя — ступени по порядку (pvp/turn.ts: протокол ответа ступени).
const TURN: Array<(ctx: DuelCtx, turn: TurnFrame) => any> = [
  targetTurn, measureTurn, safetyTurn, skySenseTurn, braceReleaseTurn, skyDefenseTurn, webTurn, blastRetreatTurn,
  pearlResponseTurn, flightTurn, recoverTurn, foeReadTurn, fightGraphTurn, noteSightTurn, postureTurn, holdArenaTurn,
  mobDetourTurn, arenaClimbTurn, maceDefenseTurn, boomDefenseTurn, crystalTurn, dressTurn, rebuffTurn, duoTurn,
  backAttackerTurn, arrowPickupTurn, terrainTurn, scoopTurn, webObstacleTurn, fireTurn, offhandTurn, fortTurn, healTurn,
  lowHpTurn, perchTurn, incomingTurn, dodgeTurn, pitTurn, lanceWebTurn, climbToHimTurn, punishTurn, windPushTurn, glideShotTurn,
  potionFirstTurn, boomOffenseTurn, crossbowTurn, bowTurn, utilTurn, showmanTurn, hiddenFoeTurn, breakUnderTurn,
  counterPillarTurn, standoffTurn, stuckTurn, hopTurn, repositionTurn, flyerTurn, shieldsTurn, farApproachTurn,
  smashSetupTurn, smashTurn, debuffTurn, spearTurn, meleeIntentTurn, creeperFleeTurn, steerTurn, edgeTurn,
  unblockTurn, exitTurn, hitKindTurn, floorEscapeTurn, controlsTurn, strikeTurn
]

// Кадр хода раз в 500 мс (ND_TRACE_PVP): чья ступень закончила ход и замеры — разбор «машет мимо», «стоит у ямы».
function traceFrame (ctx: DuelCtx, turn: TurnFrame, by: string) {
  const now = gameClock.now()
  if (now - (ctx.frameAt || 0) < 500) return
  ctx.frameAt = now
  const f = (n: any) => typeof n === 'number' ? n.toFixed(1) : '-'
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint'].filter(c => ctx.bot.getControlState(c)).join('+') || '—'
  ctx.trace(`кадр ${by}: r=${f(turn.r)} d=${f(turn.d)} dy=${f(turn.dy)} прицел=${turn.inSight ? 1 : 0} вижу=${turn.seesBody ? 1 : 0} скрыт=${turn.hidden ? 1 : 0} рука=${ctx.bot.heldItem?.name || '-'} клавиши=${keys} путь=${ctx.pathing ? 1 : 0} мимо=${ctx.bot._ndBlockedHits || 0}`)
}

async function duel (session, ctl, entity, opts: any = {}) {
  const maceIntent = session.current
  const safety = opts.guard?.safety || require('./combat-safety').watch(session.bot)
  const vision = createLastSeen(session.bot)
  const totem0 = totemMod.snapshot(session.bot)
  try { return await duelBody(session, ctl, entity, { ...opts, safety, vision, totem0, maceIntent }) } finally {
    if (session.bot?._ndMaceDefense?.ctl === ctl) delete session.bot._ndMaceDefense
    vision.close()
    if (!opts.guard?.safety) safety.close()
  }
}

async function duelBody (session, ctl, entity, opts: any = {}) {
  // Контекст боя (pvp/turn.ts): параметры, состояние и службы; части ставят его по порядку.
  const ctx = { session, ctl, entity, opts, sleep } as DuelCtx
  ctx.rangedAllowed = () => canUseRanged(session, ctx.entity, opts)
  const bot = ctx.bot = session.bot
  const vision = ctx.vision = opts.vision
  const deadline = ctx.deadline = gameClock.now() + Math.min(300, opts.timeoutSeconds ?? 60) * 1000
  const acquired = ctx.acquired = await require('./pvp/search').acquireTarget(bot, ctl, vision, ctx.entity, { deadline, arena: opts.arena })
  if (!acquired.entity) return { lost: `${ctx.entity.username || ctx.entity.name} не найден`, search: acquired.search, totem: totemMod.delta(opts.totem0, totemMod.snapshot(bot)) }
  ctx.entity = acquired.entity
  ctx.strategicTargetId = ctx.entity.id
  ctl.onAbort.push(() => vision.close())
  initDuelState(ctx)
  installCore(ctx)
  installProbes(ctx)
  installTrace(ctx)
  installSight(ctx)
  installDamageLog(ctx)
  installTempo(ctx)
  installStrafe(ctx)
  installMelee(ctx)
  installShotGate(ctx)
  installEvents(ctx)
  installFloorWatch(ctx)
  installFallAndAim(ctx)
  installServices(ctx)
  installSkillDelegates(ctx)
  installPerchDrop(ctx)
  installFortDelegates(ctx)
  installFort(ctx)
  installInputs(ctx)
  installHazardSkills(ctx)
  installReport(ctx)
  installTarget(ctx)
  installMaceChain(ctx)
  installSkills(ctx)
  await openDuel(ctx)
  installLateSkills(ctx)

  let loopYielded = true
  let loopSpins = 0
  const markLoopYield = () => { loopYielded = true }
  while (!ctl.aborted) {
    ctx.miningProgress()
    if (loopYielded) loopSpins = 0
    else if (++loopSpins >= 50) { loopSpins = 0; await new Promise<any>(resolve => setImmediate(resolve)) }
    loopYielded = false
    setImmediate(markLoopYield)
    const turn = {} as TurnFrame
    let out
    let by = 'конец'
    for (const stage of TURN) {
      out = stage(ctx, turn)
      if (out && typeof out.then === 'function') out = await out
      if (out) { by = stage.name; break }
    }
    if (ctx.TRACE) traceFrame(ctx, turn, by)
    if (out === NEXT) continue
    if (out) return out.end
    await sleep(TICK_MS)
  }
  return ctx.finish({ aborted: true })
}

export { duel }
export { keyDir } from './moves'
export { cooldownMs, FOES, profileOf } from './pvp/rules'
export { potionOf, potionRole } from './pvp/potions'
export { reachFrom, stepSafe } from './pvp/body'
