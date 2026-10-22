// Тактика: TacticalSystem — арбитр действий, эпизод, исполнение, отпуск тела.
import { TacticalArbiter } from '../arbiter'
import { S4D, piglinNiche, threatLevel, hasObservedTarget, canRepelLavaAttacker, meleeReachable, type TacticalState, type Candidate, type ThreatLevel, type ControlOwner, type ActionId } from '../state'
import { EscapeProgress, type EscapeObservation } from '../escape-progress'
import { drinkFireResistance, climbFromLava } from '../lava-escape'
import { createEmergencyEscape } from '../../combat/emergency-escape'
import { webBoatEscape } from '../web-boat'
import { runBoatHop } from '../../combat/boat-hop'
import { blastNear, dodgeBlast, shieldBlast, shieldableBlast } from '../blast'
import * as clock from '../../game-clock'
import * as locks from '../../reflex-lock'
import * as survival from '../../survival'
import * as flee from '../../flee'
import * as guard from '../../ne-guard'
import * as movement from '../../movement'
import * as pick from '../../pick'
import { Vec3 } from 'vec3'
import * as lavaNav from '../../lava-nav'
import * as polarBear from '../../polar-bear'
import { minecraftPorts, EXHAUSTION_HOLD_MS, FIGHT_RECOVERY_HP, stateSnapshot, commandedEscape, shieldCanContinue, IDLE_COOLED, rememberUnreachable, dropBehind, FLEE_SAFE_DISTANCE, foodActions, observeTactics } from './observe'
import type { TacticalPorts, MinecraftEntity, Episode, Controller, MinecraftSession, TacticalSnapshot } from './observe'

export class TacticalSystem {
  private readonly ports: TacticalPorts
  private readonly arbiter = new TacticalArbiter()
  private readonly escapes = new EscapeProgress()
  // An action that fails at once (its precondition was a wrong observation) sits out 2 s instead of being re-selected on
  // every 150 ms sample (stress stand, real observation: Heal on a "cover" it could not confirm, x13 in 2 s).
  private readonly failedAt = new Map<ActionId, number>()
  private exhaustion: { value: boolean; since: number | null } = { value: false, since: null }
  private unfitLow: number | null = null
  private state: TacticalState | null = null
  private bot: MinecraftEntity | null = null
  private episode: Episode | null = null
  private generation = 0
  private lastSample = -Infinity
  private substantive = false
  private needsObservation = false
  private level: ThreatLevel = 0
  private observationError: string | undefined
  private pending: Promise<unknown> | null = null
  private incident: { at: number; hp: number; threat: ThreatLevel; actions: Set<string>; chain: string[]; state: Record<string, unknown>; intent?: Controller } | null = null
  private readonly onTick = () => { lavaNav.sample(this.session); this.update() }
  private readonly onDamage = (packet?: MinecraftEntity) => {
    lavaNav.hit(this.session, packet)
    if (packet?.entityId === this.bot?.entity?.id && packet?.sourceTypeId === 22) {
      this.session._tacticalInWallAt = clock.now()
      this.session._tacticalInWallDimension = String(this.bot?.game?.dimension || '')
    }
    this.update(true)
  }
  private readonly onForcedMove = () => { lavaNav.reset(this.session); this.session._tacticalTeleportAt = clock.now(); this.update(true) }
  private readonly onEnd = () => this.detach()

  constructor(private readonly session: MinecraftSession, ports: Partial<TacticalPorts> = {}) { this.ports = { ...minecraftPorts, ...ports } }

  attach(bot: MinecraftEntity): void {
    if (this.bot === bot) return
    this.detach()
    this.bot = bot
    locks.install(this.session)
    guard.attach(this.session)
    bot.on('physicsTick', this.onTick)
    bot.on('health', this.onDamage)
    bot.on('forcedMove', this.onForcedMove)
    bot._client?.on('damage_event', this.onDamage)
    bot.once('end', this.onEnd)
  }

  enabled(): boolean { return process.env.ND_TACTICS !== '0' && !!this.bot }

  snapshot(): TacticalSnapshot {
    const owner: ControlOwner = locks.owner(this.session)?.owner || 'Skill'
    return { threatLevel: this.level, action: this.episode?.action.id || null, owner,
      replanRevision: this.session.replanRevision || 0, requireObservation: this.needsObservation, state: this.state,
      ...(this.observationError ? { error: this.observationError } : {}) }
  }

  async waitForRelease(): Promise<void> {
    while (this.pending || this.session.reflex) {
      await (this.pending || this.session.reflex)
    }
  }

  observed(): void { if (!this.pending && !this.session.reflex) this.needsObservation = false }

  requestGuard(): Promise<unknown> {
    this.update(true)
    return this.pending || Promise.resolve({ acted: false })
  }

  update(force = false): void {
    if (!this.enabled() || this.session.bot !== this.bot) return
    const now = clock.now()
    if (!force && now - this.lastSample < 150) return
    this.lastSample = now
    let state: TacticalState | null
    try { state = this.ports.observe(this.session); this.observationError = undefined }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.observationError) this.session.bus.emit('tactical_observation_failed', { error: message })
      this.observationError = message
      return
    }
    if (!state) { this.release('unavailable'); return }
    const escape = this.escapes.observe(this.escapeObservation(state))
    const now2 = clock.now()
    // A run that sat out for "escaping" nobody is still the swim out of lava or fire (escapeFire): the cooldown of the
    // no-op flight left the body in a pool with no action for 2 s (stand fuzz-1312: TNT, then lava, level 4 unhandled).
    const swim = state.lava || state.burning && !state.fireResistance && state.water
    const quick = [...this.failedAt].filter(([id, at]) => now2 - at < 2000 && !(swim && (id === 'Flee' || id === 'CreateDistance'))).map(([id]) => id)
    state.failedEscapes = quick.length ? [...new Set([...escape.failed, ...quick])] : escape.failed
    // A corner is a place, not a sample: inside an incident the flag turns only after the new value held EXHAUSTION_HOLD_MS.
    // It gates LastStand against Fight/Flee/refuge, and a flag that flickered with each cell walked (or jump) swapped them
    // on every 150 ms sample (farm 06.10: Fight<->LastStand 94, BlockOff<->LastStand 51 alternations within 2 s).
    // A rising threat takes the fact as it is: in lava without a dry run the swim to shore (exits now "open") waited out the
    // hold of the old dead end, 10 ticks without any action (stress stand fuzz-6159/9456: level4-unhandled, burned).
    const rising = threatLevel(state)
    if (this.level === 0 && !this.episode || rising === 4 || rising > this.level || escape.exhausted === this.exhaustion.value) this.exhaustion = { value: escape.exhausted, since: null }
    else if ((this.exhaustion.since ??= now2) <= now2 - EXHAUSTION_HOLD_MS) this.exhaustion = { value: escape.exhausted, since: null }
    state.escapeExhausted = this.exhaustion.value
    // A fight dropped as unsustainable comes back only after a real recovery, FIGHT_RECOVERY_HP over the low point: the
    // verdict crossed its threshold with each arrow and each regenerated point, and the body walked back to a skeleton it
    // had just fled (stress stand fuzz-274/513: Fight>CreateDistance>Fight in 1.6 s). A lava repel keeps its own verdict.
    if (this.level === 0 && !this.episode) this.unfitLow = null
    if (!(state.fireResistance && (state.lava || state.lavaEscapePending))) {
      if (!state.canFight && state.enemies.some(enemy => enemy.threatening)) this.unfitLow = Math.min(this.unfitLow ?? Infinity, state.health)
      else if (state.canFight && this.unfitLow !== null) {
        // One more exchange of margin: a single hit must not cross the threshold again (fuzz-513: skeleton 3.5 per arrow).
        const hit = Math.max(0, ...state.enemies.filter(enemy => enemy.threatening).map(enemy => enemy.hit ?? 0))
        // S4d: capped at full health - a fight dropped at 20 hp (hunger, not wounds: «сытость не позволяет лечиться») asked for
        // 24 and never came back in the incident (natives s4d-ab3: a wither skeleton run from ×13 at 20 hp, then death).
        const recovered = this.unfitLow + Math.max(FIGHT_RECOVERY_HP, 2 * hit)
        if (state.health < (S4D() ? Math.min(recovered, (this.bot?.maxHealth ?? 20) - 0.5) : recovered)) state.canFight = false
        else this.unfitLow = null
      }
    }
    this.state = state
    const decision = this.arbiter.decide(state)
    this.level = decision.level
    // An arena duel (pvp.duel with tempo, fight { arena }) is to the death by design: a retreat at level 3 only interrupted
    // the losing side's fight (S7 20:08, arms race). Lava, a fall, a blast, a wall or water stay with the tactics.
    const hazard = state.waterEmergency || state.lava || state.lavaAhead || state.dangerousFall || state.embedded || state.explosion || state.drowning || state.waterEscape
    const arena = state.protectedEncounter && !!this.session.current?.params?.arena && !hazard
    // The blaze skill under fire resistance keeps level 3 too (S1 21:01): at the spawner a crowd of 3+ blazes makes hp < 12
    // level 3, and the takeover (BlockOff/Flee off the platform) died in at least 35 of 66 such episodes in S1's farm
    // telemetry (06.10, slots 21/22/30); the skill holds the shield, eats and strikes on its own. Level 4 stays tactical.
    // Без огнестойкости — тоже (s1c 06.10, решение пользователя «FR — не допуск»): навык сам ведёт бой без неё (радар залпов, щит,
    // коробка с окном, отдых и возврат); перехват уровня 3 рвал его и кампания звала его снова — два хозяина одного боя.
    const blazeOwned = state.protectedEncounter && this.session.current?.name === 'blaze' && !hazard
    if (state.protectedEncounter && (decision.level < 3 && !state.waterEscape || arena || blazeOwned)) {
      // Защищённый навык (blaze/дракон/дуэль) забирает руки у начатого раньше эпизода уровня <3: иначе Fight тактики держал
      // аренду, lookAt навыка ждал её, а ифриты били в упор (s1-post05 06.10: blaze «меч» 0 взмахов, 30 урона, смерть).
      if (this.episode && (this.episode.level < 3 || arena || blazeOwned) && locks.owner(this.session)?.owner !== 'Emergency' &&
          locks.owner(this.session)?.ctl !== this.session._refugeBuild) locks.cancel(this.session)
      return
    }
    // Падение ведёт рефлекс (клатч/вода, clutch.ts); тактике в нём выбрать нечего (арбитр: dangerousFall не выбирает
    // действие). Обрыв навыка только снимал клавиши посреди перехода (s5c-f2-3 06.10: 49 эпизодов L4 «dangerousFall» без
    // действия за 8 игр. мин — goto к крепости рвался, стратегия ушла в паузу 5 мин; S6b 21:52 — то же у прыжка паркура).
    // Блок клатча ставится под арендой Emergency (reflex-lock fall-controller) — это тот же рефлекс падения (S6c 07.10: спуск
    // блоками вдоль стены, try-descent wall — goto «прервано» после каждого первого блока).
    const fallOnly = !decision.selected && (state.dangerousFall || state.emergencyController) && threatLevel({ ...state, dangerousFall: false, emergencyController: false }) < 3
    if (decision.level >= 2) {
      // Чистое падение под рефлексом не «существенно»: по его концу release() не рвёт навык (MLG pathfinder'а, спуск блоками:
      // goto «interrupted» сразу после посадки — s6c-desc-bucket2 4/4 в обоих плечах).
      if (!fallOnly) this.substantive = true
      this.incident ||= { at: state.at, hp: state.health, threat: decision.level, actions: new Set(), chain: [], state: stateSnapshot(state, this.session.bot), intent: this.session.current?.ctl }
      this.incident.threat = Math.max(this.incident.threat, decision.level) as ThreatLevel
    }
    if (decision.level === 0 && !this.episode && !this.pending && !this.session.reflex) { this.release('safe'); return }
    // Уворот/побег по приказу (арена 12.10: рывок от зелья и булавы, джук от лука, ветер, жемчуг, элитры, укрытие) — это уже
    // ответ на угрозу: щит/бой тактики рвали его («reflex: действие прервано», mace-5: булава сверху — угроза 3-го уровня,
    // и рывок обрывался щитом). Пока он идёт — тактика не вмешивается; аварии (падение, лава) — свой рефлекс Emergency.
    if (commandedEscape(this.session) && !state.waterEmergency) return
    if ((decision.level >= 3 || state.waterEscape) && !fallOnly) this.interruptSkill(decision.level)
    // A fireball disappears on impact, before its later hurt sample. The observed shooter remains: cancelling the
    // started guard here dropped offhand use before the native five-tick ACK (sr1011-b ghast scene). Keep its existing
    // bounded executor unless a more valuable defence or an emergency takes over; unseen shooters do not hold it.
    if (this.pending && this.episode?.action.id === 'Shield' && decision.level < 3 && shieldCanContinue(state) &&
        (!decision.selected || decision.selected.score <= this.episode.action.score)) {
      this.arbiter.hold(this.episode.action)
      return
    }
    // Losing contact while a wall is placed must not cancel bounded defence for Shield. A flight runs to its own safe
    // distance: released at the 16-block sight edge, a pursuer still inside its FOLLOW_RANGE walked back into contact.
    // A calm sample is not the server receipt of a pending bite or recovery.
    if (this.pending && (decision.level <= 1 && ['Fight', 'LastStand', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Heal', 'Eat'].includes(this.episode?.action.id || '') ||
      decision.level === 0 && ['FreeEmbedded', 'FlightEscape', 'PearlEscape', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop', 'Flee', 'CreateDistance'].includes(this.episode?.action.id || ''))) {
      if (this.episode) this.arbiter.hold(this.episode.action)
      return
    }
    if (decision.release) {
      if (locks.owner(this.session)?.source === 'lava-nav') return // a dry central cell is not the lava packet's all-clear
      if (this.episode && (decision.level === 0 || locks.owner(this.session)?.owner !== 'Emergency')) locks.cancel(this.session)
      if (decision.level === 0) this.release('safe')
      return
    }
    if (!decision.selected || !decision.change && this.episode) return
    if (decision.selected.id === 'Fight' && /^(fight|retaliate|defend)$/.test(this.session.current?.name || '') && decision.level < 3) return
    // The fight skill is already the favourable fight: a run the arbiter picked only because Fight sat out its re-entry
    // (dropped a moment ago) must not take the hands from it — native slot 1 14.10: a lone zombie, Fight 90 > Flee 65, the
    // fight RPC interrupted by Flee four rounds out of four, the zombie left alive to follow.
    const fightBest = decision.candidates.find(candidate => candidate.id === 'Fight')
    if (fightBest && fightBest.score >= decision.selected.score && /^(fight|retaliate|defend)$/.test(this.session.current?.name || '') && decision.level < 3) return
    const active = locks.owner(this.session)
    const repelDuringClimb = active?.source === 'ClimbOut' && decision.selected.id === 'Fight' && canRepelLavaAttacker(state)
    const fluidHandoff = active?.source === 'fall-controller' && state.lava
    if (active?.owner === 'Emergency' && !state.waterEmergency && decision.selected.id !== 'FreeEmbedded' && !repelDuringClimb && !fluidHandoff) return
    this.begin(decision.selected, decision.candidates, state, decision.level)
  }

  private interruptSkill(level: ThreatLevel): void {
    const current = this.session.current
    if (!current?.ctl || current.ctl.aborted || commandedEscape(this.session) && !this.state?.waterEmergency) return
    current.ctl.interruptedBy = { type: 'tactical', threatLevel: level, requireObservation: true }
    current.ctl.abort()
  }

  private begin(action: Candidate, candidates: Candidate[], state: TacticalState, level: ThreatLevel): void {
    const previous = this.episode
    if (previous) { this.finish(previous, 'preempted', { by: action.id }); locks.cancel(this.session) }
    const episode: Episode = { action, at: state.at, hp: state.health, level, candidates, token: ++this.generation, state: stateSnapshot(state, this.session.bot), intent: this.session.current?.ctl }
    this.episode = episode
    this.escapes.begin(action.id, this.escapeObservation(state))
    this.incident?.actions.add(action.id)
    this.incident?.chain.push(action.id)
    this.session.bus.emit('tactical_selected', { action: action.id, threatLevel: level, candidates, during: this.session.current?.name || null,
      ...(state.lavaAhead ? { lavaAhead: true, health: state.health, position: this.session.bot.entity.position.clone() } : {}) })
    let ending = 'completed'
    const pending: Promise<unknown> = locks.start(this.session, async (ctl: Controller) => {
      try {
        const result = await (this.ports.execute ? this.ports.execute(action, ctl, state) : this.execute(action, ctl, state))
        if (result && typeof result === 'object' && 'failed' in result && result.failed) {
          ending = 'failed'
          this.session.bus.emit('tactical_failed', { action: action.id, reason: 'reason' in result ? result.reason : 'action not confirmed', threatLevel: level })
        }
        return result
      }
      catch (error) {
        ending = ctl.aborted ? 'interrupted' : 'failed'
        const reason = error instanceof Error ? error.message : String(error)
        if (!ctl.aborted && action.id !== 'FreeEmbedded') this.session.bus.emit('tactical_failed', { action: action.id, reason, threatLevel: level })
        return { error: reason }
      }
      finally {
        if (ctl.aborted) ending = 'interrupted'
        if (this.episode === episode && level >= 2 && this.session.current?.ctl === episode.intent) this.interruptSkill(level)
      }
    }, { source: action.id, owner: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 'Emergency' : 'Tactical', priority: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 3 : 2, preempt: true })
    this.pending = pending
    void pending.then(result => {
      // A flight that reported safety ends the old hit's contact (else the 1.5 s hit memory restarts the same flight).
      if ((action.id === 'Flee' || action.id === 'CreateDistance') && result && typeof result === 'object' &&
          ((result as { mode?: string }).mode === 'оторвался' || (result as { safe?: boolean }).safe === true)) this.session._tacticalRetreatSafeAt = clock.now()
      // So does a kill: the dead attacker's hit kept "contact" for 1.5 s and started a flight from nobody (stress stand
      // fuzz-513: Fight killed the spider, CreateDistance with no enemy in sight, then a new skeleton read as a flap).
      if ((action.id === 'Fight' || action.id === 'LastStand') && result && typeof result === 'object' && (result as { killed?: boolean }).killed) {
        this.session._tacticalRetreatSafeAt = clock.now()
        if (S4D()) this.arbiter.forgive('Fight')
      }
      if (this.episode !== episode) return
      if (result && typeof result === 'object' && 'cancelled' in result && result.cancelled) ending = 'interrupted'
      const failed = ending === 'failed' || !!(result && typeof result === 'object' && 'unavailable' in result && result.unavailable)
      // A strike that ends in the tick it began did nothing (farm 06.10, slot 21: Fight vs a hovering blaze "out of melee",
      // 0 swings, 447 re-selections); it sits out like a failure.
      // So does a refuge run that ended at once (already healed, nothing to hide from): re-selected on each sample otherwise
      // (stress stand fuzz-730: Hide>Heal>Hide, each "healed" in a tick at level 2 with a skeleton at 10 blocks).
      // A run that "escaped" at once had nobody in reach to run from (a shot still flying from a shooter already past its
      // range): Flee and CreateDistance - one run under two names - sit out together (stand fuzz-68: CD>Flee>CD in 6 ticks).
      // So does one that "escaped" within a second while the incident goes on (burning at low health, a zombie past 17 blocks:
      // each run safe in 3 ticks, CD>Flee>CD - stand fuzz-5085).
      const run = action.id === 'Flee' || action.id === 'CreateDistance'
      const escaped = !!result && typeof result === 'object' && ((result as { mode?: string }).mode === 'оторвался' || (result as { safe?: boolean }).safe === true)
      const idle = (IDLE_COOLED.has(action.id) || run) && clock.now() - episode.at < 100 &&
        !(result && typeof result === 'object' && 'killed' in result && result.killed) || run && escaped && clock.now() - episode.at < 1000
      if ((failed || idle) && action.id !== 'FreeEmbedded' && clock.now() - episode.at < 1000) {
        for (const id of run && idle ? ['Flee', 'CreateDistance'] as const : [action.id]) this.failedAt.set(id, clock.now())
      }
      this.finish(episode, ending, result)
      this.episode = null
      this.arbiter.finished()
    }).finally(() => {
      if (this.pending === pending) this.pending = null
      if (!this.episode) {
        try { this.state = this.ports.observe(this.session) } catch {}
      }
      if (!this.episode && (!this.state || threatLevel(this.state) === 0)) this.release('safe')
    })
  }

  private async execute(action: Candidate, ctl: Controller, state: TacticalState): Promise<unknown> {
    const session = this.session
    const bot = session.bot
    // The strike goes to the nearest foe a sword reaches (the entity table order is arbitrary: a LastStand against a
    // circling phantom walked to a brute 13 blocks away that had not even engaged - stress stand).
    const enemy = state.enemies.filter(candidate => candidate.threatening)
      .sort((a, b) => Number(meleeReachable(b)) - Number(meleeReachable(a)) || a.distance - b.distance)
      .find(candidate => bot.entities[candidate.id]?.position &&
      bot.entities[candidate.id].isValid !== false && (candidate.unseen || pick.aim(bot, bot.entities[candidate.id], {
        range: state.polarBear?.id === candidate.id ? 32 : action.id === 'Shield' ? Math.max(16, candidate.distance + 1) : 16 })?.point))
    if ((action.id === 'Fight' || action.id === 'LastStand') && !enemy) {
      return { unavailable: true, reason: 'observed target disappeared or lost line of sight before act' }
    }
    switch (action.id) {
      case 'BoatLavaHop': {
        const result = await runBoatHop(session, ctl)
        if (!result.ok && !ctl.aborted) throw Object.assign(new Error(result.why || 'boat hop exit not confirmed'), { detail: result })
        return result
      }
      case 'WebBoatEscape': {
        const result = await webBoatEscape(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'web boat rescue not confirmed')
        return result
      }
      case 'FlightEscape': case 'PearlEscape': {
        const escape = createEmergencyEscape(bot, { away: () => enemy ? bot.entities[enemy.id]?.position : null })
        const result = await escape.run(ctl, action.id === 'FlightEscape' ? 'flight' : 'pearl')
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'emergency escape not confirmed')
        return result
      }
      case 'UseFireResistance': {
        const result = await drinkFireResistance(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'fire resistance not confirmed')
        return result
      }
      case 'ClimbOut': {
        const result = await climbFromLava(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'lava climb not confirmed')
        return result
      }
      case 'FreeEmbedded': {
        const result = await session.autopilot?.freeIfBuried(bot, { ctl, force: true })
        if (ctl.aborted) return { cancelled: true }
        if (result?.freed === false || session.autopilot?.buriedBy(bot)) {
          const reason = result?.reason || 'body remains embedded after visible escape dig'
          session.bus.emit('tactical_failed', { action: action.id, reason, threatLevel: 4 })
          throw Object.assign(new Error(reason), { code: 'STILL_EMBEDDED' })
        }
        return result ?? { freed: true, dug: 0 }
      }
      case 'LastStand': {
        const result = await (require('../../combat') as typeof import('../../combat')).fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined,
          allowPlayer: enemy?.player, timeoutSeconds: 15, lastStand: true, retreatAtHealth: 0, purpose: 'defense' })
        // A whole stand without a swing (a crossbow piglin across a gap): retry only after contact conditions change (c15-5-1 14.10: five
        // stands of 15 s at a shooter 5 blocks off, 9 -> 0 hp).
        if (enemy && !enemy.player && /nether/.test(String(bot.game?.dimension || '')) && result && typeof result === 'object' && !ctl.aborted &&
            !(result as { swings?: number }).swings && !((result as { kills?: unknown[] }).kills || []).length) rememberUnreachable(session, bot.entities[enemy.id])
        return result
      }
      case 'Fight': {
        if (state.polarBear?.action === 'Fight') return (require('../../combat') as typeof import('../../combat')).fight(session, ctl, {
          target: '#' + state.polarBear.id, purpose: 'defense', lastStand: true, shield: 'always', timeoutSeconds: 15 })
        const attacker = state.enemies.find(candidate => candidate.threatening && candidate.distance <= 3 &&
          bot.entities[candidate.id]?.isValid !== false && bot.entities[candidate.id]?.position &&
          pick.aim(bot, bot.entities[candidate.id], { range: 3.2 })?.point)
        if (attacker && canRepelLavaAttacker(state)) {
          return (require('../../combat') as typeof import('../../combat')).fight(session, ctl, { target: '#' + attacker.id, allowPlayer: attacker.player,
            timeoutSeconds: 4, purpose: 'defense', repelLava: true })
        }
        if (/nether/.test(String(bot.game?.dimension || '')) && enemy) {
          const entity = bot.entities[enemy.id]
          const result = await guard.react(session, ctl, { force: { e: entity, why: 'tactical fight' }, _owned: true, duelMs: 15000, sitMs: 8000 })
          // Not reached in the whole duel (across a gap, a crossbow out of a sword's reach): remember the failed contact -
          // c13-5-3 14.10: a piglin at 8 blocks behind a drop, Fight "out of reach" 179 times a minute, 90 minutes of the run gone.
          if (!ctl.aborted && result?.duel?.stopped === 'не достать' && !result.duel.swings) rememberUnreachable(session, entity)
          return result
        }
        return (require('../../combat') as typeof import('../../combat')).fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined, allowPlayer: enemy?.player, timeoutSeconds: 15, engaged: true })
      }
      case 'Dodge':
        // Primed TNT: run - out of its 8 blocks in a 2 s sprint of the 4 s fuse. The shield faces one source, and a TNT on the
        // other side killed the shielded bot (arena 16.10, user: «не щитом надо прикрываться, а убегать»). The shield only
        // when the run has nowhere to go.
        if (state.blast === 'tnt') {
          const ran = await dodgeBlast(session, ctl)
          return ran.cornered && state.shield && !ctl.aborted ? shieldBlast(session, ctl) : ran
        }
        // S4d: with a shield the blast is taken on it, facing the source (tactics/blast.ts shieldBlast) - unless a fall waits
        // behind the body: the explosion knockback still applies to a blocking player (ServerExplosion.hurtEntities pushes
        // every entity whose damage was not cancelled).
        if (S4D() && state.shield && state.blast !== 'falling_block') {
          const source = shieldableBlast(bot)
          if (source && !dropBehind(bot, source.entity.position)) return shieldBlast(session, ctl)
        }
        return state.blast ? dodgeBlast(session, ctl) : survival.dodgeCreeper(session, ctl, {})
      case 'Flee': case 'CreateDistance':
        // Lava: the swim out. Burning on dry ground: a water bucket puts it out (escapeFire pours it); without one a run does
        // not, and escapeFire's blind 1.2 s sprint-jump toward the nearest floor cell went over platform and bridge edges
        // (review g, S4c) - the run is smartFlee's from the shooters (edge guard, stepSafe, no fire cells).
        // No foe in sight while burning: smartFlee "escaped" nobody in a tick and the body stood in burning grass (s8-f3-15).
        if (state.hotFloor || state.lava || state.burning && !state.fireResistance && (state.water || !hasObservedTarget(state))) {
          const result = await (require('../../director') as typeof import('../../director')).escapeFire(session, ctl)
          return result.status === 'failed' ? { ...result, failed: true, reason: result.detail?.how || 'contact escape not confirmed' } : result
        }
        // Past the default FOLLOW_RANGE 16 (Mob.createMobAttributes): smartFlee's own 14 left the creeper/skeleton/spider
        // still targeting, so it walked back into contact and the same flight repeated (stress stand, charged-creeper).
        // smartFlee steers by mobs only: near a primed TNT the first leg is dodgeBlast (TNT and mobs), then the flight.
        if (blastNear(bot, 2)) await dodgeBlast(session, ctl)
        if (ctl.aborted) return { cancelled: true }
        // An attacking player is a pursuer too (smartFlee steers by mob doctrine; without him it "escaped" in a tick).
        return flee.smartFlee(session, ctl, { timeoutMs: 12000, reason: 'tactical', safeDist: state.polarBear ? polarBear.MECH.followMax + polarBear.MECH.reach : FLEE_SAFE_DISTANCE, chaseExit: true,
          foes: state.enemies.filter(foe => foe.player && foe.threatening).map(foe => foe.id) })
      case 'DigDown':
        if (state.enemies.some(foe => foe.threatening && foe.kind === 'enderman')) {
          const fortify: typeof import('../../fortify') = require('../../fortify')
          const valid = () => bot.entity.onGround && survival.holePlan(bot, session.mcData, fortify.feetCell(bot))
          if (!valid()) return { failed: true, reason: 'physical hole disappeared before descent' }
          await fortify.centerInCell(bot)
          if (ctl.aborted) return { cancelled: true }
          if (!valid()) return { failed: true, reason: 'physical hole changed while centering' }
          const previous = session._refugeBuild
          session._refugeBuild = ctl
          let entry: any
          try {
            entry = await (require('../../survival/enter-shelter') as typeof import('../../survival/enter-shelter')).enterShelter(session, ctl,
              { depth: 3, torch: false, box: false, maxSwings: 5, center: true })
          } finally { if (session._refugeBuild === ctl) session._refugeBuild = previous }
          if (ctl.aborted) return { cancelled: true, entry }
          if (!entry.sealed || !survival.refugeLook(session).pocket) return { failed: true, entry, reason: 'closed hole was not confirmed' }
          // The same recovery runs only after the existing pocket is real. Its generic outrun preface cannot help against
          // a teleporting pursuer and must not replace the selected descent before a single block is dug.
          const result = await survival.refuge(session, ctl, { minHp: 16, maxSeconds: 30, stayIn: true, why: 'tactical DigDown' })
          return result?.code && result.code !== 'OK' ? { ...result, entry, failed: true, reason: result.stopped || 'refuge was not confirmed' } : { ...result, entry }
        }
      case 'BlockOff': case 'PillarUp': case 'Hide': case 'Heal':
        {
          if (action.id === 'PillarUp' && state.polarBear) return polarBear.pillar(session, ctl, state.polarBear)
          // Nether walkers out of reach (netherHide): the guard's hole two down or its pillar, then strikes from it. The episode
          // holds its own flag while it digs, climbs and sits: airborne steps and the shrinking head room flipped the flag off
          // mid-climb, and CreateDistance took the hands 0.3 s in (try-lab-ne-piglin c3, brute: 7 of 8 died).
          if (action.id === 'PillarUp' && state.netherHide && /nether/.test(String(bot.game?.dimension || ''))) {
            const near = enemy && bot.entities[enemy.id] && !/^(blaze|ghast|magma_cube)$/.test(bot.entities[enemy.id].name || '') ? bot.entities[enemy.id]
              : (guard.meleeFoes(bot, 12) as MinecraftEntity[]).filter(entity => !/^(blaze|magma_cube)$/.test(entity.name || ''))[0]
            if (near) {
              session._ndHideCtl = ctl
              try { return await guard.react(session, ctl, { force: { e: near, why: 'tactical hide' }, _owned: true, hide: true, sitMs: 8000 }) }
              finally { if (session._ndHideCtl === ctl) session._ndHideCtl = null }
            }
          }
          const nightBlockOff = process.env.ND_OW_NIGHT_BLOCKOFF === '1'
          const paidRangedBox = state.owRangedApproachHp !== undefined && String(bot.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld'
          const committedBox = nightBlockOff || paidRangedBox
          // The selected shelter was already priced against flight; its executor must build before generic recovery.
          if (action.id === 'BlockOff' && (piglinNiche(state) || committedBox && /overworld/.test(String(bot.game?.dimension || ''))) &&
              (!committedBox || !survival.refugeLook(session).pocket)) {
            const site = survival.refugeLook(session)
            const how = piglinNiche(state) ? 'niche' : survival.chooseRefuge(site).how
            if (how !== 'box' && how !== 'niche') return { failed: true, reason: 'selected box geometry changed before construction' }
            const previous = session._refugeBuild
            session._refugeBuild = ctl
            let entry: any
            try {
              const hold: typeof import('../../survival/hold-out') = require('../../survival/hold-out')
              entry = await (how === 'niche' ? hold.takeNiche : hold.takeBox)(session, ctl, site, () => {})
            } finally { if (session._refugeBuild === ctl) session._refugeBuild = previous }
            if (ctl.aborted) return { cancelled: true, entry }
            if (!entry || committedBox && entry.intruder || !survival.refugeLook(session).pocket) return committedBox
              ? { failed: true, entry, reason: 'selected box was not sealed or is occupied' }
              : { failed: true, reason: 'piglin niche was not sealed or is occupied' }
          }
          const result = await survival.refuge(session, ctl, { minHp: 16, maxSeconds: 30, stayIn: action.id === 'BlockOff', why: 'tactical ' + action.id })
          return result?.code && result.code !== 'OK' ? { ...result, failed: true, reason: result.stopped || 'refuge was not confirmed' } : result
        }
      case 'Eat': {
        if (state.burning && !state.fireResistance) {
          const escape = await (require('../../director') as typeof import('../../director')).escapeFire(session, ctl)
          if (ctl.aborted) return { cancelled: true }
          if (escape.status !== 'done') return { failed: true, reason: 'fire contact remains before recovery bite', detail: escape.detail }
        }
        return foodActions.eat(session, ctl, {})
      }
      case 'Shield': {
        const combat: typeof import('../../combat') = require('../../combat')
        const shield = combat.makeShield(session, ctl, { shield: 'always' })
        let abort!: () => void
        const cancelled = new Promise<void>(resolve => { abort = resolve; if (ctl.aborted) resolve(); else ctl.onAbort.push(abort) })
        try {
          if (!await shield.wear()) throw new Error('shield unavailable')
          if (state.owGuard) await bot.lookAt(new Vec3(state.owGuard.point.x, state.owGuard.point.y, state.owGuard.point.z), true)
          else if (enemy && bot.entities[enemy.id]) await bot.lookAt(bot.entities[enemy.id].position.offset(0, 1.5, 0), true)
          if (ctl.aborted) return { cancelled: true }
          const deadline = clock.now() + combat.SHIELD_NATIVE_CONFIRM_MS
          await shield.raise(true)
          for (;;) {
            if (ctl.aborted) return { cancelled: true }
            const failure = shield.failure()
            if (failure) throw new Error(failure)
            const observed = observeTactics(session)
            const permissible = shieldCanContinue(observed)
            if (!permissible || clock.now() >= deadline && (observed?.owGuard === undefined || !shield.blocking())) {
              // The threat passing before the server confirmed the block is not a failed shield (farm telemetry 06.10:
              // 13 of 28 Shields "failed", several within 1-2 ticks of raising); only the confirmation deadline is.
              if (!shield.blocking() && permissible) throw new Error('shield blocking not confirmed')
              return { shielded: shield.blocking(), shield: shield.report() }
            }
            const facing = observed.enemies.filter(candidate => candidate.threatening).sort((a, b) => a.distance - b.distance)
              .find(candidate => bot.entities[candidate.id]?.position && bot.entities[candidate.id].isValid !== false &&
                pick.aim(bot, bot.entities[candidate.id], { range: Math.max(16, candidate.distance + 1) })?.point)
            if (observed.owGuard) {
              const p = observed.owGuard.point
              await bot.lookAt(new Vec3(p.x, p.y, p.z), true)
            } else if (facing) {
              const entity = bot.entities[facing.id]
              await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * .75, 0), true)
            }
            await Promise.race([movement.sleep(40), shield.cancelled, cancelled])
          }
        } finally {
          const i = ctl.onAbort.indexOf(abort)
          if (i >= 0) ctl.onAbort.splice(i, 1)
          shield.close()
        }
      }
      case 'UseWater': {
        const bucket = bot.inventory.items().find((item: MinecraftEntity) => item.name === 'water_bucket')
        if (!bucket || ctl.aborted) return { unavailable: true }
        await bot.equip(bucket, 'hand')
        if (ctl.aborted) return { cancelled: true }
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        const feet = bot.entity.position.floored()
        bot.activateItem()
        await movement.sleep(200)
        const extinguished = !!bot.entity.isInWater
        // Воду — назад в ведро, как бой (pvp fireTurn: потушился и зачерпнул): иначе к следующему поджогу ведро пустое
        // (стенд 21.10: меч чемпиона с Огненным аспектом поджигал синих раз за разом).
        if (extinguished && !ctl.aborted) await (require('../../obsidian') as typeof import('../../obsidian')).scoopWater(bot, feet).catch(() => false)
        return { extinguished }
      }
      case 'Surface': return movement.escapeWater(bot, ctl, { timeoutMs: 15000, visibleOnly: true })
      case 'EnterPortal': return (require('../../nether') as typeof import('../../nether')).enter(session, ctl, { scan: 4, timeoutSeconds: 20, noIgniter: true })
    }
  }

  private finish(episode: Episode, result: string, detail?: unknown): void {
    const hp = this.session.bot?.health ?? 0
    let state = this.state
    try { state = this.ports.observe(this.session) || state } catch {}
    if (state) this.escapes.finish(episode.action.id, this.escapeObservation(state), result, result === 'completed' && (detail as { chased?: boolean } | undefined)?.chased === true)
    this.session.bus.emit('tactical_finished', { action: episode.action.id, result: hp <= 0 ? 'died' : result, hpBefore: episode.hp, hp,
      gameMs: clock.now() - episode.at, detail })
    // TODO plan, step 1: outcome died / killed / escaped / alive, next to the technical result.
    const facts = (detail && typeof detail === 'object' ? detail : {}) as { killed?: boolean; mode?: string; safe?: boolean }
    const outcome = hp <= 0 ? 'died' : facts.killed ? 'killed' : facts.mode === 'оторвался' || facts.safe ? 'escaped' : 'alive'
    this.ports.record({ level: 'tactical', skill: episode.action.id, skillVersion: 1, threat: episode.level,
      candidates: episode.candidates, selected: episode.action.id, sec: (clock.now() - episode.at) / 1000,
      hp0: episode.hp, hp, result: hp <= 0 ? 'died' : result, outcome, alive: hp > 0, detail, state: episode.state, body: (require('../../gamedata') as typeof import('../../gamedata')).bodySnapshot(this.session.bot, hp <= 0) })
  }

  private escapeObservation(state: TacticalState): EscapeObservation {
    const position = this.session.bot?.entity?.position || { x: 0, y: 0, z: 0 }
    const actions: ActionId[] = []
    const add = (id: ActionId, enabled: boolean | undefined) => { if (enabled) actions.push(id) }
    const route = state.escapeRoute || state.lava && !state.fireResistance
    add('Flee', route); add('CreateDistance', route)
    add('FlightEscape', state.flightEscape); add('PearlEscape', state.pearlEscape); add('EnterPortal', state.portal)
    add('WebBoatEscape', state.webBoatEscape)
    add('BoatLavaHop', state.boatLavaHop)
    add('UseFireResistance', state.fireResistancePotion && !state.fireResistance); add('ClimbOut', state.lavaClimb && state.fireResistance)
    add('Hide', state.cover && !state.lava)
    if (state.shelter) add(state.shelter, (state.blocks > 0 || state.shelter === 'DigDown' || state.shelter === 'Hide') && !state.lava)
    return { at: state.at, position: { x: position.x, y: position.y, z: position.z },
      threatDistance: state.enemies.filter(enemy => enemy.threatening).reduce<number | null>((distance, enemy) => distance === null ? enemy.distance : Math.min(distance, enemy.distance), null),
      exits: this.session._tacticalExitGeometry || '',
      available: actions.length > 0, actions, swim: state.lava || state.burning && !state.fireResistance && state.water, armed: state.weapon }
  }

  private release(reason: string): void {
    if (reason === 'unavailable' || reason === 'disconnected') {
      locks.cancel(this.session)
      delete this.session._tacticalLavaClimbGoal
      this.state = null
      this.level = 0
      this.arbiter.finished()
    }
    if (this.episode) { this.finish(this.episode, reason); this.episode = null; this.arbiter.finished() }
    if (this.substantive) {
      // A worker accepted after waitForRelease belongs to the next plan.
      if (reason !== 'unavailable' && reason !== 'disconnected' && this.session.current?.ctl === this.incident?.intent) this.interruptSkill(this.level)
      this.substantive = false
      this.escapes.clear()
      this.needsObservation = true
      this.session.replanRevision = (this.session.replanRevision || 0) + 1
      if (this.incident) {
        const hp = this.session.bot?.health ?? 0
        this.ports.record({ level: 'tactical_episode', threat: this.incident.threat,
          actions: [...this.incident.actions], chain: this.incident.chain, state: this.incident.state, sec: (clock.now() - this.incident.at) / 1000,
          body: (require('../../gamedata') as typeof import('../../gamedata')).bodySnapshot(this.session.bot), hp0: this.incident.hp, hp, result: hp <= 0 ? 'died' : reason, replanRevision: this.session.replanRevision })
        this.incident = null
      }
      this.session.bus.emit('tactical_released', { reason, replanRevision: this.session.replanRevision, requireObservation: true })
    }
  }

  detach(): void {
    const bot = this.bot
    if (!bot) return
    locks.cancel(this.session)
    this.release('disconnected')
    lavaNav.reset(this.session)
    bot.removeListener('physicsTick', this.onTick)
    bot.removeListener('health', this.onDamage)
    bot.removeListener('forcedMove', this.onForcedMove)
    bot.removeListener('end', this.onEnd)
    bot._client?.removeListener('damage_event', this.onDamage)
    this.bot = null
    this.state = null
    this.level = 0
    this.observationError = undefined
    this.lastSample = -Infinity
    this.session._tacticalEmbedded = false
    this.escapes.clear()
  }
}
