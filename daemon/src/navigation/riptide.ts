import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, intersects, supportAt, verticalLift, type Point } from './geometry'
import { landingDamage } from './landing'
import { executePlan, forecastOwner, IDLE, planImpulseLanding, planImpulseLandingAsync, simulatePlan, type Cancellation, type JumpPlan, type MovementBot, type State, type Step, type WaterLaunch } from './parkour'
import { hitboxOf } from '../pick'
import { visibleAllies, allyAt, allyWorld } from '../combat/ally-safety'

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
const { PlayerState } = (require('../tick-plugins') as typeof import('../tick-plugins')).getPhysics() as { PlayerState: new(bot: MovementBot, control: typeof IDLE) => State }

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
  // ponytail: флаг на боте, а не параметр сквозь runRiptide — связка «Тягун → булава» (utility/fight riptideSmash) разрешает
  // посадку с уроном (удар булавой гасит падение) и забирает полёт после взлёта; параметр — если появится второй такой вызов.
  const mace = (bot as any)._ndRiptideMace as { maxDamage: number } | undefined
  const plan = planImpulseLanding(bot, start.state, target, 160, mace ? { maxDamage: mace.maxDamage } : undefined)
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

// LivingEntity.checkAutoSpinAttack uses AABB.minmax(previous,current), not a point ray or capsule.
// Unknown allied HP cannot buy the native 8 raw damage. Predict the full 20 attack ticks at release.
function alliedSpinSafe(bot: MovementBot, level: number, yaw: number, pitch: number, plan: RiptidePlan): boolean {
  const allies = visibleAllies(bot)
  if (!allies.length) return true
  const sight = allyWorld(bot) as MovementBot, start = riptideStart(sight, level, yaw, pitch)
  if (!start) return false
  const frames: Vec3[][] = []
  for (const steps of [Array.from({ length: 20 }, (_, i) => plan.steps[i] || { yaw, control: IDLE }), idleSteps(bot, 20)]) {
    const path: Vec3[] = []
    simulatePlan(sight, steps, state => path.push(state.pos.clone()), start.state)
    frames.push(path)
  }
  const pending: Vec3[] = []
  simulatePlan(sight, idleSteps(bot, 20), state => pending.push(state.pos.clone()), new PlayerState(sight, IDLE))
  frames.push(pending)
  const clear = (points: Vec3[], fromTick: number, toTick: number) => {
    const own = bodyBox(sight, points[0])
    for (const p of points.slice(1)) {
      const next = bodyBox(sight, p)
      for (const axis of ['X', 'Y', 'Z']) { own[`min${axis}`] = Math.min(own[`min${axis}`], next[`min${axis}`]); own[`max${axis}`] = Math.max(own[`max${axis}`], next[`max${axis}`]) }
    }
    for (const ally of allies) {
      const box = hitboxOf(bot, ally), a = allyAt(bot, ally, fromTick), b = allyAt(bot, ally, toTick)
      // An observed obstacle or later input can stop the ally along its current velocity forecast.
      const feet = [ally.position, a, b]
      const other = { minX: Math.min(...feet.map(p => p.x)) - box.w / 2, maxX: Math.max(...feet.map(p => p.x)) + box.w / 2,
        minY: Math.min(...feet.map(p => p.y)), maxY: Math.max(...feet.map(p => p.y)) + box.h,
        minZ: Math.min(...feet.map(p => p.z)) - box.w / 2, maxZ: Math.max(...feet.map(p => p.z)) + box.w / 2 }
      if (intersects(own, other)) return false
    }
    return true
  }
  if (!clear([bot.entity.position, start.state.pos], 0, 0)) return false
  for (let tick = 1; tick <= 20; tick++) {
    const points = frames.flatMap(path => [tick === 1 ? start.state.pos : path[tick - 2], path[tick - 1]])
    // Before the receipt, runtime sends a no-impulse coast; also bound received push and the landing controller.
    if (points.some(p => !bodyClear(sight, p, { water: true })) || !clear(points, tick - 1, tick)) return false
  }
  return true
}

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

// Итог рывка: ok/why/ticks, сэмплы фаз (ход к воде, активация, заряд, квитанция); при успехе — уровень, сила, смещение, посадка.
export interface RiptideResult {
  ok: boolean; why?: string; ticks: number; samples?: unknown[]
  launchSamples?: unknown[]; activationSamples?: unknown[]; chargeSamples?: unknown[]; acknowledgementSamples?: unknown[]
  chargedTicks?: number; serverSpin?: boolean; useServerAt?: number; releaseServerAt?: number; releaseState?: unknown
  level?: number; strength?: number; moved?: number; landing?: Point
}
export async function runRiptide(bot: RiptideBot, ctl: Cancellation, item: RiptideItem, level: number, yaw: number, pitch: number,
  wet: (state?: State) => boolean, releaseAtTick: (release: () => void) => Promise<unknown>, target?: Point, launch?: WaterLaunch): Promise<RiptideResult> {
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
    // Charge/landing controllers use a neutral pitch; restore the validated launch before its packet boundary.
    await bot.look(yaw, pitch, true)
    let alliedCollision = false, releaseAimChanged = false
    // Прицел боя (ctx.aim) за тот же тик поворачивает к врагу поверх нашего взгляда — выпуск со сбитым взглядом не шлём, а
    // повторяем на следующих тиках (стенд 24.10: «Тягун» в бою срывался riptide_release_aim_changed почти каждый раз).
    for (let tries = 0; tries < 4 && !released && !alliedCollision && !ctl.aborted; tries++) {
    releaseAimChanged = false
    await releaseAtTick(() => {
      // Some callers are already on the sent frame; utility.onTickThen waits
      // one real tick. Accept only those two observed native positions.
      if (ctl.aborted || (bot.health ?? hp) < hp || !wet() || Math.min(bot.entity.position.distanceTo(releaseFrom), bot.entity.position.distanceTo(boundary.pos)) > .1) return
      const actualImpulse = riptideImpulse(level, bot.entity.yaw, bot.entity.pitch), intendedImpulse = riptideImpulse(level, yaw, pitch)
      if (!actualImpulse || !intendedImpulse) { releaseAimChanged = true; return }
      if (actualImpulse.distanceTo(intendedImpulse) > 1e-5) {
        // Чужой поворот (прицел, щит, рефлексы) успел в пакет этого тика. Сервер берёт угол рывка из последнего пакета
        // поворота (TridentItem.releaseUsing → getYRot/getXRot), так что свой пакет look прямо перед выпуском возвращает
        // проверенный угол — без лишнего тика (повтор тиками срывался: стенд 24.10, 2 из 2 со страховкой).
        const conv = require('mineflayer/lib/conversions')
        bot.entity.yaw = yaw; bot.entity.pitch = pitch
        try { (bot._client as any).write('look', { yaw: Math.fround(conv.toNotchianYaw(yaw)), pitch: Math.fround(conv.toNotchianPitch(pitch)), onGround: bot.entity.onGround, flags: { onGround: bot.entity.onGround, hasHorizontalCollision: false } }) } catch { releaseAimChanged = true; return }
      }
      const current = planRiptide(bot, level, yaw, pitch, target)
      if (!current) return
      if (!alliedSpinSafe(bot, level, yaw, pitch, current)) { alliedCollision = true; return }
      releaseState = { pos: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: bot.entity.onGround, isInWater: bot.entity.isInWater }
      releaseServerAt = bot.ndClock?.serverNow()
      released = true; bot.deactivateItem()
    })
    if (!releaseAimChanged) break
    }
    if (!released) return { ok: false, why: alliedCollision ? 'riptide_allied_spin_collision' : releaseAimChanged ? 'riptide_release_aim_changed' : 'riptide_release_not_sent', ticks: charged }
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
    if ((bot as any)._ndRiptideMace) return { ok: true, handedOff: true, level, strength: 1.5 + .75 * (level - 1), chargedTicks: charged, serverSpin: true, ticks: charged, moved: 0 } as any
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

/** Steep riptide arc onto a target for the riptide → mace combo: plain player ballistics after the native impulse + 1.2 lift
 * (gravity .08, drag .98, air ×.91). Of the arcs whose fall passes over him (≤ 2.5 bl.) at least 5.8 above his feet, the
 * lowest: a miss costs the fall (fallDistance − 3), so maxApex caps it. Riptide III is 3 bl./t — to land within 14 bl. it goes
 * 33–38 up, a miss is death; Riptide I lands 5–11 bl. away from 6–12 up.
 * ponytail: без заряда ветра под себя в падении (сброс fallDistance) — с ним годились бы и высокие дуги II–III. */
export function riptideArc(level: number, from: Point, target: Point, maxApex = Infinity) {
  return riptideArcs(level, from, target, maxApex, [0])[0] ?? null
}
/** All acceptable arcs, the course also turned by the given offsets (around allies in the spin path): lowest first per course. */
export function riptideArcs(level: number, from: Point, target: Point, maxApex = Infinity, turns = [0, .25, -.25, .5, -.5], minApex = 5.8) {
  const direct = Math.atan2(-(target.x - from.x), -(target.z - from.z)), out: { yaw: number; pitch: number; miss: number; apex: number; ticks: number }[] = []
  for (const turn of turns) {
    const yaw = direct + turn
    let best: { yaw: number; pitch: number; miss: number; apex: number; ticks: number } | null = null
    for (let pitch = 1.4; pitch >= .1; pitch -= .05) {
      const v0 = riptideImpulse(level, yaw, pitch)
      if (!v0) continue
      let p = { x: from.x, y: from.y + 1.2, z: from.z }, v = { x: v0.x, y: v0.y, z: v0.z }, apex = p.y, miss = Infinity, ticks = 0
      for (let t = 0; t < 80; t++) {
        p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }; v = { x: v.x * .91, y: (v.y - .08) * .98, z: v.z * .91 }
        apex = Math.max(apex, p.y)
        if (v.y < 0 && p.y <= target.y + 2.5) { miss = Math.hypot(p.x - target.x, p.z - target.z); ticks = t + 1; break }
      }
      const high = apex - target.y
      if (high >= minApex && high <= maxApex && miss <= 2.5 && (!best || high < best.apex)) best = { yaw, pitch, miss, apex: high, ticks }
    }
    if (best) out.push(best)
  }
  return out
}
/** Pre-launch check of one arc: a safe native landing (with the mace allowance on the bot) and no ally in the spin path. */
export function riptideArcSafe(bot: MovementBot, level: number, yaw: number, pitch: number) {
  // Без цели посадки — как сам рывок связки (runRiptide из utility/fight без target).
  const plan = planRiptide(bot, level, yaw, pitch)
  if (!plan) return 'посадки нет'
  return alliedSpinSafe(bot, level, yaw, pitch, plan) ? null : 'свой на пути'
}

