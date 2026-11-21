import * as gameClock from '../game-clock'
import { makeTracker } from './body'
import { profileOf } from './rules'
import { type DuelCtx } from './turn'
import { isAlly } from '../combat/ally-safety'
import { playerCues } from '../swarm-senses'
import { seesPlayer } from './last-seen'

// Смена цели: сброс памяти по прежней цели.
export function installTarget (ctx: DuelCtx) {
  const { blockedShotTargets, bot, co, guard, opts, pathTo, pickWeaponFor, st, vision } = ctx
  ctx.retarget = (e) => {
    if (!e || e === bot.entity || (bot.entity && e.id === bot.entity.id)) return
    const observed = vision.observe(e)
    if (!observed) return
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    ctx.entity = observed
    ctx.rushActive = false
    delete blockedShotTargets.bow; delete blockedShotTargets.xbow
    ctx.reposition = null; ctx.failedReposition = null; ctx.losGoal = null
    ctx.flankRoute = null; ctx.failedFlank = null; ctx.counterRoute = null; ctx.failedCounter = null
    ctx.failedClimb = null; ctx.failedHop = null; ctx.failedStandoff = null; ctx.failedUnblock = null
    ctx.failedBow = null; ctx.failedXbow = null; ctx.failedAirBow = null; ctx.failedAirXbow = null
    ctx.siegeRoute = null; ctx.siegeGoal = null
    ctx.dodgeLine = null; ctx.dodgeKey = null; ctx.creeperBack = null
    ctx.foeSeenPos = null
    st.bowProg = []
    ctx.exchangeStart = { swings: st.swings, landed: st.landed }
    ctx.foeHp = null
    ctx.calc.stop(); ctx.calc = co.trackFoe(bot, ctx.entity, { honest: true, visible: vision.visible, roundScope: opts.roundScope })
    ctx.label = ctx.entity.username || ctx.entity.name
    ctx.track = makeTracker(ctx.entity)
    ctx.seenAt = gameClock.now()
    ctx.prof = profileOf(ctx.entity)
    ctx.killed = false
    ctx.targetHurtAt = 0
    ctx.lastHurtByTarget = gameClock.now()
    if (guard) guard.watch(ctx.entity, 3.2)
    pickWeaponFor(ctx.entity)
  }
}

// Цепочка булавы: выбор следующей цели в прыжке.
export function installMaceChain (ctx: DuelCtx) {
  const { arena, attackers, bot, dead, deadline, foeEst, kills, opts, retarget, used, vision } = ctx
  const roster = new Set<string>(opts.maceOpponents || [])
  ctx.maceChain = {
    deadline, arena, home: opts.relocateTo, visible: vision.visible,
    choose: (peak, launch = false) => {
      const allowed = new Set([ctx.entity.username, ...(opts.targets || []), ...[...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e.username)])
      const candidates = (Object.values(bot.entities) as any[]).filter(e => {
        const known = allowed.has(e.username)
        if (dead.has(e.id) || !known && !roster.has(e.username)) return false
        const mode = bot.players?.[e.username]?.gamemode
        if (roster.size && (mode === 1 || mode === 3 || isAlly(bot, e))) return false
        if (known) return true
        if (!e.position || e.isValid === false) return false
        // A new name must be readable on this body. No gear tracking for distant names or nameplates behind walls.
        const cues = playerCues(bot, e)
        return (cues.nametag || cues.crouchName) && seesPlayer(bot, e)
      }).map(vision.observe).filter((e: any) => e && (e._ndVisible ?? vision.visible(e)))
      const choice = require('../combat/mace-chain').chainChoice(bot, candidates, { peak, arena, launch,
        hp: e => e.id === ctx.entity.id ? foeEst() : opts.roundScope && ctx.co.readFoeEstimate(bot, { roundScope: opts.roundScope, entity: e }),
        velocity: e => (e.id === ctx.entity.id ? ctx.track.vel() : e.velocity) || { x: 0, y: 0, z: 0 } })
      // Preserve the native-backed observation; a scoring snapshot must not replace its packet source.
      return choice && { ...choice, entity: candidates.find((e: any) => e.id === choice.entity.id), vel: () => ctx.track.vel() }
    },
    onTarget: choice => {
      if (choice.entity.id === ctx.entity.id) return
      if (ctx.killed && !ctx.prof.player && !kills.includes(ctx.label)) kills.push(ctx.label)
      used(`булава: ${Math.round(choice.fall)} бл., урон ${Math.round(choice.damage.min)}–${Math.round(choice.damage.max)} → ${choice.entity.username}`)
      retarget(choice.entity)
    }
  }
}
