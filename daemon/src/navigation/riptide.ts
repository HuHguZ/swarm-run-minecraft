import { Vec3 } from 'vec3'
import { bodyClear, supportAt, verticalLift, type Point } from './geometry'
import { landingDamage } from './landing'
import { executePlan, forecastOwner, IDLE, planImpulseLanding, planImpulseLandingAsync, simulatePlan, type Cancellation, type JumpPlan, type MovementBot, type State, type Step, type WaterLaunch } from './parkour'

interface RiptideItem { name: string; durabilityUsed?: number; maxDurability?: number }
export interface RiptideBot extends MovementBot {
  entity: MovementBot['entity'] & { id: number }
  registry: { entitiesByName: Record<string, { metadataKeys?: string[] }> }
  heldItem?: RiptideItem | null
  equip(item: RiptideItem, destination: 'hand'): Promise<void>
  activateItem(): void
  deactivateItem(): void
  quickBarSlot: number
  setQuickBarSlot(slot: number): void
  ndClock?: { serverNow(): number }
  _client: { on(event: string, listener: (packet: MetadataPacket) => void): void; removeListener(event: string, listener: (packet: MetadataPacket) => void): void }
}
interface MetadataPacket { entityId: number; metadata: Array<{ key: number; value: unknown }> }
export interface RiptidePlan extends JumpPlan { lift: number; impulse: Vec3 }
const { PlayerState } = require('../tick-plugins').getPhysics() as { PlayerState: new(bot: MovementBot, control: typeof IDLE) => State }

// TridentItem.releaseUsing and the vanilla riptide enchantment component,
// Paper 1.21.11: charge >=10, linear strength1.5+.75*(level-1), SELF lift1.2f.
export function riptideImpulse(level: number, yaw: number, pitch: number): Vec3 | null {
  if (!Number.isInteger(level) || level < 1 || level > 3 || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null
  const strength = Math.fround(1.5 + .75 * (level - 1))
  const x = Math.fround(-Math.sin(yaw) * Math.cos(pitch)); const y = Math.fround(Math.sin(pitch)); const z = Math.fround(-Math.cos(yaw) * Math.cos(pitch))
  const length = Math.fround(Math.sqrt(Math.fround(Math.fround(x * x) + Math.fround(y * y)) + Math.fround(z * z)))
  const scale = Math.fround(strength / length)
  return new Vec3(Math.fround(x * scale), Math.fround(y * scale), Math.fround(z * scale))
}

function riptideStart(bot: MovementBot, level: number, yaw: number, pitch: number, initial?: State): { state: State; lift: number; impulse: Vec3 } | null {
  const impulse = riptideImpulse(level, yaw, pitch)
  const state = initial ? Object.assign(Object.create(Object.getPrototypeOf(initial)) as State, initial, { pos: initial.pos.clone(), vel: initial.vel.clone(), control: { ...IDLE } }) : new PlayerState(bot, IDLE)
  if (!impulse || !bodyClear(bot, state.pos, { water: true })) return null
  const lift = state.onGround ? verticalLift(bot, state.pos, 1.1999999284744263) : 0
  if (lift == null) return null
  state.pos.y += lift; state.vel = state.vel.plus(impulse); state.yaw = yaw; state.pitch = pitch
  if (lift > 0) state.onGround = false
  return { state, lift, impulse }
}
export function planRiptide(bot: MovementBot, level: number, yaw: number, pitch: number, target?: Point, initial?: State): RiptidePlan | null {
  const start = riptideStart(bot, level, yaw, pitch, initial)
  if (!start) return null
  const plan = planImpulseLanding(bot, start.state, target)
  return plan ? { ...plan, lift: start.lift, impulse: start.impulse } : null
}

// Charging is real movement too: forecast the 13 use ticks and the next native
// packet boundary before committing the item, with the existing integrator.
function motionPlan(bot: MovementBot, steps: Step[], initial?: State): JumpPlan | null {
  let safe = true; let peak = Math.max(initial?.pos.y ?? bot.entity.position.y, bot._ndClutch?.peak ?? -Infinity)
  const states: State[] = []
  const state = simulatePlan(bot, steps, state => {
    peak = Math.max(peak, state.pos.y)
    if (state.isInLava || state.isInWeb || !bodyClear(bot, state.pos, { water: true })) safe = false
    if (state.isInWater) peak = state.pos.y
    if (state.onGround && state.vel.y <= 0) {
      const support = supportAt(bot, state.pos, .04)
      // Native move resolves vertical contact before this frame's horizontal
      // motion. Its ground flag can outlive footprint support for one edge tick.
      if (support) {
        if (landingDamage(support.block, peak - state.pos.y, bot.entity.attributes) > 0) safe = false
        peak = state.pos.y
      }
    }
    states.push(Object.assign(Object.create(Object.getPrototypeOf(state)) as State, state, { pos: state.pos.clone(), vel: state.vel.clone(), control: { ...state.control } }))
  }, initial)
  return safe ? { steps, states, ticks: steps.length, target: { ...state.pos } } : null
}
const idleSteps = (bot: MovementBot, ticks: number): Step[] => Array.from({ length: ticks }, () => ({ yaw: bot.entity.yaw, control: IDLE }))

/** A few native launch angles to one observed target; no item use or actual controls. */
export async function planRiptideTo(bot: MovementBot, ctl: Cancellation, level: number, target: Point, wet: (state?: State) => boolean): Promise<{ yaw: number; pitch: number; plan: RiptidePlan } | null> {
  const from = bot.entity.position
  if (ctl.aborted || bot._ndClutch?.waterPlan || !wet() || !bodyClear(bot, target, { water: true })) return null
  const span = Math.hypot(target.x - from.x, target.z - from.z)
  if (span > 32 || target.y - from.y > 48) return null
  const charged = motionPlan(bot, idleSteps(bot, 14))?.states.at(-1)
  if (!charged || !wet(charged)) return null
  const yaw = Math.atan2(charged.pos.x - target.x, charged.pos.z - target.z)
  const direct = Math.atan2(target.y - charged.pos.y, Math.hypot(target.x - charged.pos.x, target.z - charged.pos.z))
  for (const pitch of [...new Set([direct, 0, .6, 1, 1.3])]) {
    if (ctl.aborted) return null
    const start = riptideStart(bot, level, yaw, pitch, charged)
    if (!start) continue
    const landing = await planImpulseLandingAsync(bot, ctl, start.state, target)
    if (landing) return { yaw, pitch, plan: { ...landing, lift: start.lift, impulse: start.impulse } }
  }
  return null
}

export async function runRiptide(bot: RiptideBot, ctl: Cancellation, item: RiptideItem, level: number, yaw: number, pitch: number,
  wet: (state?: State) => boolean, releaseAtTick: (release: () => void) => Promise<unknown>, target?: Point, launch?: WaterLaunch) {
  if (!wet()) return { ok: false, why: 'riptide_requires_confirmed_water_or_rain', ticks: 0 }
  if (item.maxDurability != null && item.durabilityUsed != null && item.durabilityUsed + 1 >= item.maxDurability) return { ok: false, why: 'trident_next_damage_would_break', ticks: 0 }
  if (launch && (!Number.isInteger(launch.ticks) || launch.ticks < 1 || launch.ticks > 6 || !Number.isFinite(launch.yawOffset ?? 0))) return { ok: false, why: 'invalid_riptide_approach', ticks: 0 }
  const approachSteps: Step[] = launch ? Array.from({ length: launch.ticks }, () => ({ yaw: yaw + (launch.yawOffset ?? 0), control: { ...IDLE, forward: true, sprint: launch.sprint === true } })) : []
  const approach = launch ? motionPlan(bot, approachSteps) : null
  if (launch && !approach) return { ok: false, why: 'no_safe_riptide_approach', ticks: 0 }
  const prefix = motionPlan(bot, idleSteps(bot, 14), approach?.states.at(-1))
  const start = prefix?.states.at(-1)
  if (!start || !wet(start) || !planRiptide(bot, level, yaw, pitch, target, start)) return { ok: false, why: 'no_safe_riptide_charge_and_landing', ticks: 0 }
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  if (index < 0) return { ok: false, why: 'riptide_receipt_registry_unavailable', ticks: 0 }
  const hp = bot.health ?? 20; const from = bot.entity.position.clone()
  let activated = false; let using = false; let useStarted = false; let useServerAt: number | undefined
  let released = false; let accepted = false; let charged = 0; let landed = false
  let launchSamples: unknown[] = []; let activationSamples: unknown[] = []; let chargeSamples: unknown[] = []; let acknowledgementSamples: unknown[] = []; let releaseState: unknown; let releaseServerAt: number | undefined
  const previous = bot._ndParkourForecast
  let boundaryOwner: MovementBot['_ndParkourForecast']
  const receipt = (packet: MetadataPacket) => {
    if (packet.entityId !== bot.entity.id) return
    for (const entry of packet.metadata) if (entry.key === index && typeof entry.value === 'number') {
      if (released && (entry.value & 4) !== 0) accepted = true
      if (activated && !released) {
        using = (entry.value & 3) === 1
        if (using && !useStarted) { useStarted = true; useServerAt = bot.ndClock?.serverNow() }
      }
    }
  }
  bot._client.on('entity_metadata', receipt)
  try {
    await bot.equip(item, 'hand')
    if (bot.heldItem?.name !== 'trident') return { ok: false, why: 'trident_not_held', ticks: 0 }
    bot.pathfinder?.setGoal(null); bot.clearControlStates()
    if (launch) {
      const fresh = motionPlan(bot, approachSteps)
      const subsequent = fresh && motionPlan(bot, idleSteps(bot, 14), fresh.states.at(-1))?.states.at(-1)
      if (!fresh || !subsequent || !wet(subsequent) || !planRiptide(bot, level, yaw, pitch, target, subsequent)) return { ok: false, why: 'riptide_approach_no_longer_safe', ticks: 0 }
      const walked = await executePlan(bot, ctl, fresh, state => state.pos.distanceTo(fresh.states.at(-1)!.pos) < .3)
      launchSamples = walked.samples
      if (!walked.ok) return { ...walked, launchSamples }
      if (ctl.aborted || bot._ndClutch?.waterPlan) return { ok: false, why: 'interrupted', ticks: walked.ticks, launchSamples }
      bot.clearControlStates()
    }
    const equipped = motionPlan(bot, idleSteps(bot, 14))?.states.at(-1)
    if (!equipped || !wet(equipped) || !planRiptide(bot, level, yaw, pitch, target, equipped)) return { ok: false, why: 'riptide_charge_no_longer_safe', ticks: 0 }
    await bot.look(yaw, pitch, true); activated = true; bot.activateItem()
    if (!using) {
      const pending = motionPlan(bot, idleSteps(bot, 30))
      if (!pending) return { ok: false, why: 'riptide_activation_coast_unsafe', ticks: 0 }
      const waiting = await executePlan(bot, ctl, pending, () => using, () => using)
      activationSamples = waiting.samples
      if (!waiting.ok && waiting.why !== 'landing_not_confirmed') return { ...waiting, activationSamples }
    }
    if (!using) return { ok: false, why: 'riptide_use_not_confirmed', ticks: 0, activationSamples }
    // ServerEntity sends main-hand using bit1 to self. Old client catch-up
    // frames before this receipt cannot count toward TridentItem's >=10 ticks.
    const acknowledged = motionPlan(bot, idleSteps(bot, 14))?.states.at(-1)
    if (!acknowledged || !wet(acknowledged) || !planRiptide(bot, level, yaw, pitch, target, acknowledged)) return { ok: false, why: 'riptide_charge_no_longer_safe', ticks: 0, activationSamples }
    const charging = motionPlan(bot, idleSteps(bot, 13))
    if (!charging) return { ok: false, why: 'riptide_charge_no_longer_safe', ticks: 0 }
    const charge = await executePlan(bot, ctl, charging, state => state.pos.distanceTo(charging.states.at(-1)!.pos) < .3 && wet())
    charged = charge.ticks; chargeSamples = charge.samples
    if (!charge.ok) return { ...charge, why: charge.why ?? 'riptide_charge_became_unsafe_or_dry', launchSamples, chargeSamples }
    const serverCharged = () => useServerAt == null || (bot.ndClock!.serverNow() - useServerAt >= 13 * 50)
    if (using && !serverCharged()) {
      const pending = motionPlan(bot, idleSteps(bot, 30))
      if (!pending) return { ok: false, why: 'riptide_charge_coast_unsafe', ticks: charged, activationSamples, chargeSamples }
      const ready = () => using && serverCharged()
      const waiting = await executePlan(bot, ctl, pending, () => ready() && wet(), () => !using || ready())
      charged += waiting.ticks; chargeSamples = chargeSamples.concat(waiting.samples)
      if (!waiting.ok && waiting.why !== 'landing_not_confirmed') return { ...waiting, chargedTicks: charged, activationSamples, chargeSamples }
    }
    if (!using || !serverCharged()) return { ok: false, why: 'riptide_charge_not_confirmed', ticks: charged, activationSamples, chargeSamples }
    if (ctl.aborted) return { ok: false, why: 'interrupted', ticks: charged }
    if (bot._ndClutch?.waterPlan) return { ok: false, why: 'interrupted', ticks: charged }
    bot.clearControlStates()
    const boundary = motionPlan(bot, idleSteps(bot, 1))?.states.at(-1)
    let forecast = boundary && planRiptide(bot, level, yaw, pitch, target, boundary)
    if (!forecast || !boundary || !wet(boundary)) return { ok: false, why: 'riptide_release_no_longer_safe', ticks: charged }
    const releaseFrom = bot.entity.position.clone()
    boundaryOwner = forecastOwner(releaseFrom, hp, boundary.pos)
    bot._ndParkourForecast = boundaryOwner
    await releaseAtTick(() => {
      // Some callers are already on the sent frame; utility.onTickThen waits
      // one real tick. Accept only those two observed native positions.
      if (ctl.aborted || (bot.health ?? hp) < hp || !wet() || Math.min(bot.entity.position.distanceTo(releaseFrom), bot.entity.position.distanceTo(boundary.pos)) > .1) return
      if (!planRiptide(bot, level, yaw, pitch, target)) return
      releaseState = { pos: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: bot.entity.onGround, isInWater: bot.entity.isInWater }
      releaseServerAt = bot.ndClock?.serverNow()
      released = true; bot.deactivateItem()
    })
    if (!released) return { ok: false, why: 'riptide_release_not_sent', ticks: charged }
    if (!accepted) {
      // The server receipt may arrive several real movement frames after the
      // release. Keep the same controller owning a separately validated coast;
      // a one-frame marker cannot describe those later airborne positions.
      const coasting = motionPlan(bot, idleSteps(bot, 30))
      if (!coasting) return { ok: false, why: 'riptide_acknowledgement_coast_unsafe', ticks: charged }
      const waiting = await executePlan(bot, ctl, coasting, () => accepted, () => accepted)
      acknowledgementSamples = waiting.samples
      if (!waiting.ok && waiting.why !== 'landing_not_confirmed') return { ...waiting, chargedTicks: charged, serverSpin: accepted, launchSamples, activationSamples, chargeSamples, useServerAt, releaseServerAt, releaseState, acknowledgementSamples }
    }
    if (!accepted) return { ok: false, why: 'riptide_server_spin_not_confirmed', ticks: charged, serverSpin: false, launchSamples, activationSamples, chargeSamples, useServerAt, releaseServerAt, releaseState, acknowledgementSamples }
    // Earned vanilla client prediction only after the server's auto-spin flag.
    // It replaces the old utility prediction; fixtures never inject velocity.
    forecast = planRiptide(bot, level, yaw, pitch, target)
    if (!forecast) return { ok: false, why: 'accepted_riptide_landing_changed', ticks: charged, serverSpin: true }
    bot.entity.position.y += forecast.lift
    bot.entity.velocity = bot.entity.velocity.plus(forecast.impulse)
    if (forecast.lift > 0) bot.entity.onGround = false
    const result = await executePlan(bot, ctl, forecast, state => {
      const last = forecast!.states[forecast!.states.length - 1]
      return state.pos.distanceTo(last.pos) < .3 && (state.onGround || state.isInWater) && bodyClear(bot, state.pos, { water: true })
    })
    landed = result.ok
    return { ...result, level, strength: 1.5 + .75 * (level - 1), chargedTicks: charged, serverSpin: true, moved: bot.entity.position.distanceTo(from), landing: { ...bot.entity.position }, launchSamples, activationSamples, chargeSamples, useServerAt, releaseServerAt, releaseState, acknowledgementSamples }
  } finally {
    bot._client.removeListener('entity_metadata', receipt)
    if (boundaryOwner && bot._ndParkourForecast === boundaryOwner) { if (previous) bot._ndParkourForecast = previous; else delete bot._ndParkourForecast }
    if ((landed || bot.entity.onGround || bot.entity.isInWater) && !bot._ndClutch?.waterPlan) bot.clearControlStates()
    if (!released) { try { bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch {} }
  }
}
