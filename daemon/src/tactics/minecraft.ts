import { TacticalArbiter } from './arbiter'
import { threatLevel, canRepelLavaAttacker, type TacticalState, type TacticalEnemy, type Candidate, type ThreatLevel, type ControlOwner, type ActionId } from './state'
import { EscapeProgress, type EscapeObservation } from './escape-progress'
import { lavaCapabilities, inLava, drinkFireResistance, climbFromLava } from './lava-escape'
import { createEmergencyEscape, lavaFallFloor } from '../combat/emergency-escape'
import { webBoatPlan, webBoatEscape } from './web-boat'
import { boatHopAvailable, runBoatHop } from '../combat/boat-hop'
import { mountedBoatDry } from '../combat/boat-placement'

// Mineflayer plugins extend the bot/session at runtime; this is the protocol boundary.
type MinecraftSession = Record<string, any>
type MinecraftEntity = Record<string, any>
interface Controller { aborted: boolean; onAbort: Array<() => void>; abort(): void }
interface Episode { action: Candidate; at: number; hp: number; level: ThreatLevel; candidates: Candidate[]; token: number }

const clock = require('../game-clock')
const locks = require('../reflex-lock')
const survival = require('../survival')
const safety = require('../combat-safety')
const flee = require('../flee')
const guard = require('../ne-guard')
const movement = require('../movement')
const pick = require('../pick')
let autopilot: any, threats: any, itemTools: any, pack: any
const foodActions: {
  bestFood(bot: MinecraftEntity, data: MinecraftEntity): MinecraftEntity | null
  eat(session: MinecraftSession, ctl: Controller, options: Record<string, unknown>): Promise<unknown>
} = require('../actions')

function exitsNear(bot: MinecraftEntity): { route: boolean; signature: string } {
  const feet = bot.entity.position.floored()
  const facts: string[] = []
  let route = false
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    let open = true
    for (let distance = 1; distance <= 3; distance++) {
      const point = feet.offset(dx * distance, 0, dz * distance)
      const blocks = [-1, 0, 1].map(dy => bot.blockAt(point.offset(0, dy, 0)))
      facts.push(blocks.map(block => block?.name ?? 'unknown').join('/'))
      open &&= blocks[0]?.boundingBox === 'block' && blocks.slice(1).every(block => block?.boundingBox === 'empty' && !/lava|fire/.test(block.name))
    }
    route ||= open
  }
  return { route, signature: facts.join('|') }
}

export interface TacticalSnapshot {
  threatLevel: ThreatLevel
  action: string | null
  owner: ControlOwner
  replanRevision: number
  requireObservation: boolean
  state: TacticalState | null
  error?: string
}

export function observeTactics(session: MinecraftSession): TacticalState | null {
  const bot = session.bot
  if (!bot?.entity) return null
  session.autopilot?.syncDamageContext?.(bot)
  const preparation = /^(creative|spectator)$/.test(bot.game?.gameMode || '')
  const dimension = String(bot.game?.dimension || '')
  if (preparation || session._tacticalInWallDimension !== undefined && session._tacticalInWallDimension !== dimension) {
    session._tacticalInWallAt = -Infinity; session._tacticalEmbedded = false
  }
  if ((bot.health ?? 0) <= 0 || preparation) return null
  const at: number = clock.now()
  const items: MinecraftEntity[] = bot.inventory.items()
  const targetName = session.current?.target || session.current?.params?.target
  const target = targetName ? (Object.values(bot.entities || {}) as MinecraftEntity[]).find(entity =>
    entity && (entity.username === targetName || entity.name === targetName || '#' + entity.id === targetName)) : null
  const inspected = safety.inspect(bot, { target })
  const hot = guard.hot(bot)
  const seen = new Set<number>()
  const enemies: TacticalEnemy[] = []
  for (const threat of [...(inspected.threats || []), ...(hot ? [{ id: hot.e.id, distance: hot.e.position.distanceTo(bot.entity.position) }] : [])]) {
    const entity: MinecraftEntity | undefined = bot.entities[threat.id]
    if (!entity?.position || entity.isValid === false || seen.has(entity.id) || !pick.aim(bot, entity, { range: 16 })?.point) continue
    seen.add(entity.id)
    enemies.push({ id: entity.id, kind: entity.name || entity.username, distance: threat.distance,
      player: !!entity.username, threatening: true })
  }
  // Nearby players are observable facts; they become threats only after an attack or an explicit fight.
  for (const entity of Object.values(bot.entities || {}) as MinecraftEntity[]) {
    if (!entity?.username || entity === bot.entity || seen.has(entity.id) || !entity.position) continue
    const distance = entity.position.distanceTo(bot.entity.position)
    if (distance <= 16) enemies.push({ id: entity.id, kind: entity.username, distance, player: true, threatening: false })
  }
  const dryMountedBoat = mountedBoatDry(bot)
  const lava = !dryMountedBoat && inLava(bot)
  const lavaEscapePending = !!(session._tacticalLavaClimbGoal && !session._tacticalLavaClimbGoal.failed && at < session._tacticalLavaClimbGoal.deadline)
  let refuge: MinecraftEntity | null = null
  // Geometry is cached by TacticalSystem; avoid this scan when there is no incident to solve.
  if (!lava && !lavaEscapePending && enemies.some(enemy => enemy.threatening) && (bot.health < 16 || inspected.action !== 'fight')) {
    try { refuge = survival.refugeLook(session, { radius: 16 }) } catch {}
  }
  let fireResistance = false
  const resistance = bot.registry?.effectsByName?.fire_resistance || bot.registry?.effectsByName?.FireResistance
  if (resistance) fireResistance = !!bot.entity.effects?.[resistance.id]
  const burning = !!(bot.entity.metadata?.[0] & 1)
  const creeper = process.env.ND_CREEPER_DODGE === '0' ? null : (autopilot ??= require('../autopilot')).creeperNeed(bot)
  const incident = session.autopilot?.lastHurt
  const recentHit = incident && (incident.dimension === undefined || incident.dimension === dimension) && at - incident.at < 1500 && incident.byMob
  const current = session.current?.name || ''
  const hostile = enemies.filter(enemy => enemy.threatening)
  const contact = !!hot || !!recentHit || hostile.some(enemy => enemy.distance <= 4.5 || (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance)
  const fall = !dryMountedBoat && (bot._ndClutch?.lastDecision?.action === 'clutch' || bot._ndClutch?.lastDecision?.action === 'water' || !!bot._ndFallGuard?.placed)
  const control = locks.owner(session)
  const emergencyController = !!(control?.owner === 'Emergency' && control.source === 'fall-controller' && !bot.entity.onGround && !dryMountedBoat)
  const lavaAhead = !dryMountedBoat && !fall && !emergencyController && lavaFallFloor(bot) !== null
  const aerialCombat = !!(bot._ndDescend || bot._ndSmashNow || bot.entity.elytraFlying || bot._ndAerialRecovering?.())
  const boatEncounter = bot._ndEndermanBoatEncounter
  let protectedBoat = false
  if (current === 'pearls' && boatEncounter && boatEncounter.expiresAt >= at &&
      bot.entities[boatEncounter.boatId] && hostile.every(enemy => enemy.id === boatEncounter.targetId)) {
    try { protectedBoat = boatEncounter.safe() === true } catch {}
  }
  let embedded = false
  try {
    const buried = !!session.autopilot?.buriedBy(bot)
    const confirmed = at - (session._tacticalInWallAt ?? -Infinity) < 2000 || at - (session._tacticalTeleportAt ?? -Infinity) < 1500
    // Teleport/damage proves the cause; geometry ends the incident, including slow server-confirmed digs.
    embedded = buried && (session._tacticalEmbedded === true || confirmed)
    session._tacticalEmbedded = embedded
  } catch {}
  const portalId = bot.registry?.blocksByName?.nether_portal?.id
  let portal = false
  if (portalId !== undefined && !fall && bot.health >= 10 && bot.health < 12) {
    try { portal = !!bot.findBlock({ matching: portalId, maxDistance: 4 }) } catch {}
  }
  let incomingProjectiles = 0
  try { incomingProjectiles = (threats ??= require('../threats')).incoming(bot).filter((projectile: MinecraftEntity) => projectile.ticks <= 10).length } catch {}
  const choice = refuge ? survival.chooseRefuge(refuge) : null
  const shelter = choice?.how === 'box' || choice?.how === 'niche' ? 'BlockOff' : choice?.how === 'pillar' ? 'PillarUp' : choice?.how === 'hole' ? 'DigDown' : choice?.how === 'pocket' ? 'Hide' : null
  const ground = exitsNear(bot)
  const rescue = lava || lavaEscapePending || burning && !fireResistance ? lavaCapabilities(session) : { potion: false, climb: false, exit: '' }
  const air = lava || lavaAhead ? createEmergencyEscape(bot, { away: () => bot.entities[hostile[0]?.id]?.position }).snapshot() : { flightReady: false, pearlReady: false, landing: null }
  const webBoat = lava && !!webBoatPlan(session)
  const boatLavaHop = lava && boatHopAvailable(bot)
  const weapon = items.some(item => /_(sword|axe)$|^trident$|^mace$|_spear$/.test(item.name) && (itemTools ??= require('../items')).usesLeft(item) >= 4)
  const repel = fireResistance && (lava || lavaEscapePending) && weapon && hostile.some(enemy =>
    enemy.distance <= 3 && !!pick.aim(bot, bot.entities[enemy.id], { range: 3.2 })?.point)
  session._tacticalExitGeometry = ground.signature + '|' + rescue.exit + '|' + [portal, rescue.potion, rescue.climb, air.flightReady, air.pearlReady, webBoat, boatLavaHop].join(',')
  return { at, health: bot.health ?? 20, food: bot.food ?? 20, armor: inspected.ourArmor || 0,
    weapon, shield: bot.inventory.slots[45]?.name === 'shield' && clock.now() >= (bot._ndShieldDisabledUntil || 0),
    enemies, incomingProjectiles, burning, lava, lavaAhead, fireResistance,
    explosion: !!(creeper && (creeper.swelling || creeper.d <= 3.3)), dangerousFall: !!fall, emergencyController,
    inWater: !!bot.entity.isInWater, cover: !!refuge?.pocket, portal, escapeRoute: !fall && ground.route,
    blocks: refuge?.blocks ?? (pack ??= require('../pack')).buildCount(bot, /nether/.test(dimension) ? 'the_nether' : 'overworld'),
    water: !/nether/.test(dimension) && items.some(item => item.name === 'water_bucket'),
    edible: !!foodActions.bestFood(bot, session.mcData ?? bot.registry), canFight: hostile.length > 0 && (inspected.action === 'fight' || repel), contact,
    shelter, protectedEncounter: current === 'dragon' || protectedBoat || aerialCombat && /^(fight|retaliate|defend)$/.test(current), embedded, airborne: !bot.entity.onGround && !dryMountedBoat,
    aerialCombat,
    flightEscape: air.flightReady, pearlEscape: air.pearlReady, fireResistancePotion: rescue.potion, lavaClimb: rescue.climb, lavaEscapePending, webBoatEscape: webBoat, boatLavaHop }
}

export class TacticalSystem {
  private readonly arbiter = new TacticalArbiter()
  private readonly escapes = new EscapeProgress()
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
  private incident: { at: number; hp: number; threat: ThreatLevel; actions: Set<string> } | null = null
  private readonly onTick = () => this.update()
  private readonly onDamage = (packet?: MinecraftEntity) => {
    if (packet?.entityId === this.bot?.entity?.id && packet?.sourceTypeId === 22) {
      this.session._tacticalInWallAt = clock.now()
      this.session._tacticalInWallDimension = String(this.bot?.game?.dimension || '')
    }
    this.update(true)
  }
  private readonly onForcedMove = () => { this.session._tacticalTeleportAt = clock.now(); this.update(true) }
  private readonly onEnd = () => this.detach()

  constructor(private readonly session: MinecraftSession) {}

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
    try { state = observeTactics(this.session); this.observationError = undefined }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.observationError) this.session.bus.emit('tactical_observation_failed', { error: message })
      this.observationError = message
      return
    }
    if (!state) { this.release('unavailable'); return }
    const escape = this.escapes.observe(this.escapeObservation(state))
    state.failedEscapes = escape.failed
    state.escapeExhausted = escape.exhausted
    this.state = state
    const decision = this.arbiter.decide(state)
    this.level = decision.level
    if (state.protectedEncounter && decision.level < 3) return
    if (decision.level >= 2) {
      this.substantive = true
      this.incident ||= { at: state.at, hp: state.health, threat: decision.level, actions: new Set() }
      this.incident.threat = Math.max(this.incident.threat, decision.level) as ThreatLevel
    }
    if (decision.level === 0 && !this.episode && !this.pending && !this.session.reflex) { this.release('safe'); return }
    if (decision.level >= 3) this.interruptSkill(decision.level)
    // Losing contact while a wall is placed must not cancel bounded defence for Shield.
    if (this.pending && (decision.level <= 1 && ['Fight', 'LastStand', 'BlockOff', 'PillarUp', 'DigDown', 'Hide'].includes(this.episode?.action.id || '') ||
      decision.level === 0 && ['FreeEmbedded', 'FlightEscape', 'PearlEscape', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop'].includes(this.episode?.action.id || ''))) return
    if (decision.release) {
      if (this.episode && (decision.level === 0 || locks.owner(this.session)?.owner !== 'Emergency')) locks.cancel(this.session)
      if (decision.level === 0) this.release('safe')
      return
    }
    if (!decision.selected || !decision.change && this.episode) return
    if (decision.selected.id === 'Fight' && /^(fight|retaliate|defend)$/.test(this.session.current?.name || '') && decision.level < 3) return
    const active = locks.owner(this.session)
    const repelDuringClimb = active?.source === 'ClimbOut' && decision.selected.id === 'Fight' && canRepelLavaAttacker(state)
    if (active?.owner === 'Emergency' && decision.selected.id !== 'FreeEmbedded' && !repelDuringClimb) return
    this.begin(decision.selected, decision.candidates, state, decision.level)
  }

  private interruptSkill(level: ThreatLevel): void {
    const current = this.session.current
    if (!current?.ctl || current.ctl.aborted) return
    current.ctl.interruptedBy = { type: 'tactical', threatLevel: level, requireObservation: true }
    current.ctl.abort()
  }

  private begin(action: Candidate, candidates: Candidate[], state: TacticalState, level: ThreatLevel): void {
    const previous = this.episode
    if (previous) { this.finish(previous, 'preempted'); locks.cancel(this.session) }
    const episode: Episode = { action, at: state.at, hp: state.health, level, candidates, token: ++this.generation }
    this.episode = episode
    this.escapes.begin(action.id, this.escapeObservation(state))
    this.incident?.actions.add(action.id)
    this.session.bus.emit('tactical_selected', { action: action.id, threatLevel: level, candidates, during: this.session.current?.name || null,
      ...(state.lavaAhead ? { lavaAhead: true, health: state.health, position: this.session.bot.entity.position.clone() } : {}) })
    let ending = 'completed'
    const pending: Promise<unknown> = locks.start(this.session, async (ctl: Controller) => {
      try {
        const result = await this.execute(action, ctl, state)
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
        if (this.episode === episode && level >= 2) this.interruptSkill(level)
      }
    }, { source: action.id, owner: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 'Emergency' : 'Tactical', priority: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 3 : 2, preempt: true })
    this.pending = pending
    void pending.then(result => {
      if (this.episode !== episode) return
      if (result && typeof result === 'object' && 'cancelled' in result && result.cancelled) ending = 'interrupted'
      this.finish(episode, ending, result)
      this.episode = null
      this.arbiter.finished()
    }).finally(() => {
      if (this.pending === pending) this.pending = null
      if (!this.episode) {
        try { this.state = observeTactics(this.session) } catch {}
      }
      if (!this.episode && (!this.state || threatLevel(this.state) === 0)) this.release('safe')
    })
  }

  private async execute(action: Candidate, ctl: Controller, state: TacticalState): Promise<unknown> {
    const session = this.session
    const bot = session.bot
    const enemy = state.enemies.find(candidate => candidate.threatening && bot.entities[candidate.id]?.position &&
      bot.entities[candidate.id].isValid !== false && pick.aim(bot, bot.entities[candidate.id], { range: 16 })?.point)
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
      case 'LastStand': return require('../combat').fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined,
        allowPlayer: enemy?.player, timeoutSeconds: 15, lastStand: true, retreatAtHealth: 0, purpose: 'defense' })
      case 'Fight': {
        const attacker = state.enemies.find(candidate => candidate.threatening && candidate.distance <= 3 &&
          bot.entities[candidate.id]?.isValid !== false && bot.entities[candidate.id]?.position &&
          pick.aim(bot, bot.entities[candidate.id], { range: 3.2 })?.point)
        if (attacker && canRepelLavaAttacker(state)) {
          return require('../combat').fight(session, ctl, { target: '#' + attacker.id, allowPlayer: attacker.player,
            timeoutSeconds: 4, purpose: 'defense', repelLava: true })
        }
        if (/nether/.test(String(bot.game?.dimension || '')) && enemy) {
          const entity = bot.entities[enemy.id]
          return guard.react(session, ctl, { force: { e: entity, why: 'tactical fight' }, _owned: true, duelMs: 15000, sitMs: 8000 })
        }
        return require('../combat').fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined, allowPlayer: enemy?.player, timeoutSeconds: 15 })
      }
      case 'Dodge': return survival.dodgeCreeper(session, ctl, {})
      case 'Flee': case 'CreateDistance':
        if (state.lava || state.burning && !state.fireResistance) {
          return require('../director').Director.prototype.escapeFire.call({ session }, ctl)
        }
        return flee.smartFlee(session, ctl, { timeoutMs: 12000, reason: 'tactical' })
      case 'BlockOff': case 'PillarUp': case 'DigDown': case 'Hide': case 'Heal':
        if (/nether/.test(String(bot.game?.dimension || '')) && enemy && action.id !== 'Heal') {
          const entity = bot.entities[enemy.id]
          const result = await guard.react(session, ctl, { force: { e: entity, why: 'tactical refuge' }, _owned: true, sitMs: 8000 })
          return action.id === 'BlockOff' && result?.box?.ok === false && !result.killed
            ? { ...result, failed: true, reason: 'refuge was not confirmed' } : result
        }
        return survival.refuge(session, ctl, { minHp: 16, maxSeconds: 30, why: 'tactical ' + action.id })
      case 'Eat': return foodActions.eat(session, ctl, {})
      case 'Shield': {
        const combat = require('../combat')
        const shield = combat.makeShield(session, ctl, { shield: 'always' })
        let abort!: () => void
        const cancelled = new Promise<void>(resolve => { abort = resolve; if (ctl.aborted) resolve(); else ctl.onAbort.push(abort) })
        try {
          if (!await shield.wear()) throw new Error('shield unavailable')
          if (enemy && bot.entities[enemy.id]) await bot.lookAt(bot.entities[enemy.id].position.offset(0, 1.5, 0), true)
          if (ctl.aborted) return { cancelled: true }
          const deadline = clock.now() + combat.SHIELD_NATIVE_CONFIRM_MS
          await shield.raise(true)
          for (;;) {
            if (ctl.aborted) return { cancelled: true }
            const failure = shield.failure()
            if (failure) throw new Error(failure)
            const observed = observeTactics(session)
            const permissible = observed?.shield && !observed.dangerousFall && !observed.airborne &&
              (threatLevel(observed) === 1 || observed.incomingProjectiles > 0)
            if (!permissible || clock.now() >= deadline) {
              if (!shield.blocking()) throw new Error('shield blocking not confirmed')
              return { shielded: true, shield: shield.report() }
            }
            const facing = observed.enemies.filter(candidate => candidate.threatening).sort((a, b) => a.distance - b.distance)
              .map(candidate => bot.entities[candidate.id]).find(entity => entity?.position && entity.isValid !== false && pick.aim(bot, entity, { range: 16 })?.point)
            if (facing) await bot.lookAt(facing.position.offset(0, (facing.height || 1.8) * .75, 0), true)
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
        bot.activateItem()
        await movement.sleep(200)
        return { extinguished: !!bot.entity.isInWater }
      }
      case 'EnterPortal': return require('../nether').enter(session, ctl, { scan: 4, timeoutSeconds: 20, noIgniter: true })
    }
  }

  private finish(episode: Episode, result: string, detail?: unknown): void {
    const hp = this.session.bot?.health ?? 0
    let state = this.state
    try { state = observeTactics(this.session) || state } catch {}
    if (state) this.escapes.finish(episode.action.id, this.escapeObservation(state), result)
    this.session.bus.emit('tactical_finished', { action: episode.action.id, result: hp <= 0 ? 'died' : result, hpBefore: episode.hp, hp,
      gameMs: clock.now() - episode.at, detail })
    require('../telemetry').record({ level: 'tactical', skill: episode.action.id, skillVersion: 1, threat: episode.level,
      candidates: episode.candidates, selected: episode.action.id, sec: (clock.now() - episode.at) / 1000,
      hp0: episode.hp, hp, result: hp <= 0 ? 'died' : result, alive: hp > 0, detail })
  }

  private escapeObservation(state: TacticalState): EscapeObservation {
    const position = this.session.bot?.entity?.position || { x: 0, y: 0, z: 0 }
    const actions: ActionId[] = []
    const add = (id: ActionId, enabled: boolean | undefined) => { if (enabled) actions.push(id) }
    add('Flee', state.escapeRoute); add('CreateDistance', state.escapeRoute)
    add('FlightEscape', state.flightEscape); add('PearlEscape', state.pearlEscape); add('EnterPortal', state.portal)
    add('WebBoatEscape', state.webBoatEscape)
    add('BoatLavaHop', state.boatLavaHop)
    add('UseFireResistance', state.fireResistancePotion && !state.fireResistance); add('ClimbOut', state.lavaClimb && state.fireResistance)
    add('Hide', state.cover && !state.lava)
    if (state.shelter) add(state.shelter, state.blocks > 0 && !state.lava)
    return { at: state.at, position: { x: position.x, y: position.y, z: position.z },
      threatDistance: state.enemies.filter(enemy => enemy.threatening).reduce<number | null>((distance, enemy) => distance === null ? enemy.distance : Math.min(distance, enemy.distance), null),
      exits: this.session._tacticalExitGeometry || '',
      available: actions.length > 0, actions }
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
      if (reason !== 'unavailable' && reason !== 'disconnected') this.interruptSkill(this.level)
      this.substantive = false
      this.escapes.clear()
      this.needsObservation = true
      this.session.replanRevision = (this.session.replanRevision || 0) + 1
      if (this.incident) {
        const hp = this.session.bot?.health ?? 0
        require('../telemetry').record({ level: 'tactical_episode', threat: this.incident.threat,
          actions: [...this.incident.actions], sec: (clock.now() - this.incident.at) / 1000,
          hp0: this.incident.hp, hp, result: hp <= 0 ? 'died' : reason, replanRevision: this.session.replanRevision })
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
