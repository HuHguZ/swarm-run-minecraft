import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, shapeBoxes, supportAt, HAZARD, type Point } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
import edges = require('../edges')
import pick = require('../pick')
import boom = require('../boom')

// WindChargeItem / AbstractWindCharge / ServerExplosion, reviewed 1.21.11 (PVP-RESEARCH б.8).
export const WIND = Object.freeze({ speed: 1.5, reach: 2.4, knockback: 1.22, surfaceOffset: .25, forgivenessTicks: 40, dispersion: .0172275 })
const vector = (p: Point) => new Vec3(p.x, p.y, p.z)
const finite = (p: Point) => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const yawTo = (a: Point, b: Point) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const positionKey = (p: Point) => `${p.x},${p.y},${p.z}`
export interface WindReport { id: string; position: Point; velocity: Point; onGround: boolean; eyeHeight?: number; yaw?: number; gameTick?: number; attributes?: Record<string, any>; effects?: Record<string, any>; control?: Record<string, boolean> }
export interface WindShot { from: Vec3; aim: Vec3; yaw: number; pitch: number; velocity: Vec3; ticks: number; impact: Vec3; burst: Vec3; normal: Vec3; block: Point }
export interface WindArena { x: number; z: number; r: number; killY?: number }
interface WindStep { yaw: number; control: Record<string, boolean>; pos: Point; vel: Point; onGround: boolean }
export interface WindPairPlan {
  target: Point
  arena?: WindArena
  shot: WindShot
  jumpTick: number
  runTicks: number
  receiver: { start: Point; velocity: Point; attributes: any; effects: any; food: number; signature: string; native?: any; land: Vec3; settled: boolean; steps: WindStep[]; boomTick: number }
  thrower: { id: string; start: Point; velocity: Point; land: Point; safe: boolean; recoil: Point }
  spear?: { target: string; name: string; delay: number; hitTick: number; damage: number; ordinary: { damage: number; ticks: number }; price: any }
  progress?: { startTick: number; executed: number; movement: Point; receiver: string; token: string; gameTick: number; sampledAt: number; validForMs: number; cases: WindPairPlan['receiver'][] }
}
const pairProgress = new WeakMap<object, { startTick: number; step: () => number; read: () => any }>()
let pairSequence = 0
const launchedProgress = new WeakMap<object, Map<string, number>>()

/** Read only the receiver's own executed physics, through the existing wind report RPC. */
export async function windPairProgress(session: any, { startTick, afterStep }: { startTick: number; afterStep?: number }) {
  let active = pairProgress.get(session.bot)
  if (afterStep !== undefined && (!active || active.startTick !== startTick || active.step() <= afterStep)) {
    await session.bot.waitForTicks(1)
    active = pairProgress.get(session.bot)
  }
  return active?.startTick === startTick ? active.read() : { ok: false, phase: 'not_running' }
}
export function windInside(pos: Point, arena?: WindArena, half = Math.fround(.6) / 2): boolean {
  return finite(pos) && (!arena || Number.isFinite(arena.x) && Number.isFinite(arena.z) && Number.isFinite(arena.r) && arena.r > half &&
    Math.abs(pos.x - arena.x) + half <= arena.r && Math.abs(pos.z - arena.z) + half <= arena.r && (arena.killY === undefined || Number.isFinite(arena.killY) && pos.y > arena.killY))
}

export function worldTick(bot: any): number | null {
  const c = bot.ndClock
  if (c?.age === null || c?.age === undefined || !Number.isFinite(c.serverTicks) || !Number.isFinite(c.ticks)) return null
  const tick = Number(c.age) + c.ticks - c.serverTicks
  return Number.isSafeInteger(tick) ? tick : null
}

export function windImpulse(bot: any, feet: Point, center: Point, { resistance, eyeHeight = 1.62, height = 1.8 }: { resistance?: number; eyeHeight?: number; height?: number } = {}): Vec3 {
  const value = resistance ?? bot.entity?.attributes?.['minecraft:explosion_knockback_resistance']?.value ?? 0
  if (!finite(feet) || !finite(center) || !Number.isFinite(value)) return new Vec3(0, 0, 0)
  const result = boom.blast(bot, center, WIND.reach / 2, feet, { h: height, eyeH: eyeHeight,
    def: { armor: 0, tough: 0, epf: 0, kbRes: Math.min(1, Math.max(0, value)), resist: 0 } })
  return result.kb.scaled(WIND.knockback)
}

// Shared launch: both a friendly floor burst and an enemy body hit inherit the shooter's movement.
export function windLaunch(from: Vec3, aim: Vec3, moved = new Vec3(0, 0, 0)) {
  if (![from, aim, moved].every(finite)) return null
  const delta = aim.minus(from)
  const a = moved.dot(moved) - WIND.speed ** 2, b = -2 * delta.dot(moved), c = delta.dot(delta)
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0 || c < 1e-8) return null
  const times = Math.abs(a) < 1e-9 ? [-c / b] : [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)]
  const time = times.filter(t => t > 0 && Number.isFinite(t)).sort((x, y) => x - y)[0]
  if (!time || time > 30) return null
  const velocity = delta.scaled(1 / time), direction = velocity.scaled(1 / velocity.norm())
  const look = velocity.minus(moved).scaled(1 / WIND.speed)
  return { velocity, direction, time, yaw: Math.atan2(-look.x, -look.z), pitch: Math.asin(Math.max(-1, Math.min(1, look.y))) }
}

/** Shared native block surface and quarter-block burst offset; flight/entity policy belongs to callers. */
export function windBlockImpact(bot: any, from: Vec3, direction: Vec3, distance: number) {
  const hit = pick.blockOnRay(bot, from, direction, distance)
  if (!hit) return null
  const impact = from.plus(direction.scaled(hit.t))
  const faces: Vec3[] = []
  for (const box of shapeBoxes(hit.block)) for (const axis of ['x', 'y', 'z'] as const) for (const sign of [-1, 1]) {
    const plane = box[(sign < 0 ? 'min' : 'max') + axis.toUpperCase()]
    if (Math.abs(impact[axis] - plane) < 1e-5) { const n = new Vec3(0, 0, 0); n[axis] = sign; faces.push(n) }
  }
  const normal = faces.sort((x, y) => x.dot(direction) - y.dot(direction))[0]
  if (!normal) return null
  return { distance: hit.t, impact, burst: impact.plus(normal.scaled(WIND.surfaceOffset)), normal, block: hit.block, pos: hit.pos }
}

// No gravity/drag: solve the inherited shooter movement exactly, then take the FIRST real block hit.
export function windShot(bot: any, from: Vec3, aim: Vec3, moved = new Vec3(0, 0, 0), owner?: string | number): WindShot | null {
  const launch = windLaunch(from, aim, moved)
  if (!launch) return null
  const { velocity, direction } = launch, delta = aim.minus(from)
  let unknown = false
  const observed = { ...bot, blockAt(p: Vec3) { const block = bot.blockAt(p, false); if (!block) unknown = true; return block } }
  const hit = windBlockImpact(observed, from, direction, delta.norm() + .05)
  if (unknown || !hit || hit.distance < delta.norm() - .02 || HAZARD.test(hit.block.name)) return null
  for (const entity of Object.values(bot.entities || {}) as any[]) {
    if (!entity || entity === bot.entity || entity.id === bot.entity?.id && entity.id !== undefined || entity.username === owner && owner !== undefined || entity.id === owner && owner !== undefined ||
        !(entity.username || entity.type === 'player' || entity.type === 'mob' || entity.name === 'armor_stand')) continue
    if (!pick.canHit(bot, entity, { range: 64 })) continue
    // Read the third body's geometry only AFTER our own LOS succeeds.
    const feet = entity.position, half = (entity.width || .6) / 2, height = entity.height || 1.8
    const body = pick.rayBox(from, direction, { x: feet.x - half, y: feet.y, z: feet.z - half }, { x: feet.x + half, y: feet.y + height, z: feet.z + half }, hit.distance)
    if (body !== null && body < hit.distance - .01) return null
  }
  return { from: from.clone(), aim: aim.clone(), yaw: launch.yaw, pitch: launch.pitch, velocity,
    ticks: Math.max(1, Math.ceil(hit.distance / velocity.norm())), impact: hit.impact, burst: hit.burst, normal: hit.normal, block: { ...hit.pos } }
}

export function windLanding(bot: any, state: { pos: Point; vel: Point; onGround: boolean }, target: Point): boolean {
  if (!state.onGround || state.vel.y > 0 || Math.hypot(state.vel.x, state.vel.z) >= .035 || !bodyClear(bot, state.pos) || Math.abs(state.pos.y - target.y) > .03 || Math.hypot(state.pos.x - target.x, state.pos.z - target.z) > .22) return false
  const intended = supportAt(bot, target, .04), actual = supportAt(bot, state.pos, .04)
  return !!intended && !!actual && positionKey(intended.block.position) === positionKey(actual.block.position) && Math.abs(actual.top - state.pos.y) < .02 &&
    state.pos.x > intended.box.minX + .001 && state.pos.x < intended.box.maxX - .001 && state.pos.z > intended.box.minZ + .001 && state.pos.z < intended.box.maxZ - .001
}

function floorAim(bot: any, x: number, z: number, y: number): Vec3 | null {
  for (let cy = Math.floor(y); cy >= Math.floor(y) - 3; cy--) {
    const block = bot.blockAt(new Vec3(Math.floor(x), cy, Math.floor(z)), false)
    if (!block) return null
    if (HAZARD.test(block.name)) return null
    for (const box of shapeBoxes(block).sort((a, b) => b.maxY - a.maxY)) if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) return new Vec3(x, box.maxY, z)
  }
  return null
}

function receiverRun(bot: any, target: Vec3, shot: WindShot, runTicks: number, jumpTick: number, arena?: WindArena, remaining?: { plan: WindPairPlan; elapsed: number; burstTick?: number }) {
  const state = edges.stateOf(bot, edges.IDLE)
  const native = structuredClone(state), burstTick = remaining?.burstTick ?? shot.ticks
  const simulate = edges.simOf(bot), world = edges.worldOf(bot), steps: WindStep[] = []
  const launchYaw = yawTo(state.pos, target)
  let peak = state.pos.y, settled = 0, lifted = false
  for (let tick = 0; tick < 90; tick++) {
    const control = { ...edges.IDLE }
    state.yaw = launchYaw
    if (tick < runTicks) { control.forward = true; control.sprint = true }
    if (tick === jumpTick) control.jump = true
    if (remaining) {
      const cursor = remaining.elapsed + tick, intended = remaining.plan.receiver.steps[cursor]
      const next = cursor <= remaining.plan.shot.ticks && intended ? intended : windSteer(bot, state, target, arena)
      state.yaw = next.yaw; Object.assign(control, next.control)
    }
    if (tick === burstTick) {
      const impulse = windImpulse(bot, state.pos, shot.burst)
      if (impulse.norm() < .05) return null
      state.vel = state.vel.plus(impulse)
    }
    if (tick > burstTick || remaining && tick === burstTick) {
      const steering = windSteer(bot, state, target, arena)
      state.yaw = steering.yaw; Object.assign(control, steering.control)
    }
    state.control = control; simulate(state, world)
    if (!state.onGround) lifted = true
    peak = Math.max(peak, state.pos.y)
    if (state.isInLava || state.isInWater || !bodyClear(bot, state.pos) || !windInside(state.pos, arena)) return null
    steps.push({ yaw: state.yaw, control, pos: { ...state.pos }, vel: { ...state.vel }, onGround: state.onGround })
    if (tick > burstTick && lifted && state.onGround) {
      if (Math.abs(state.pos.y - target.y) > .03) return null
      const support = supportAt(bot, state.pos, .04)
      const fall = tick - burstTick <= WIND.forgivenessTicks ? Math.min(peak - state.pos.y, shot.burst.y - state.pos.y) : peak - state.pos.y
      if (!support || landingDamage(support.block, fall, bot.entity.attributes) > 0) return null
      if (windLanding(bot, state, target)) settled++; else settled = 0
      if (settled >= 6) return { start: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, attributes: structuredClone(bot.entity.attributes || {}), effects: structuredClone(bot.entity.effects || {}), food: bot.food, signature: receiverSignature(bot), native, land: state.pos.clone(), settled: true, steps, boomTick: burstTick }
      if (steps.length > burstTick + 8 && Math.hypot(state.pos.x - target.x, state.pos.z - target.z) > .8) return null
    }
    if (state.pos.y < bot.entity.position.y - 3) return null
  }
  return null
}

/** Rebase on executed input; replaying steps zero would repeat the sprint/jump preparation. */
export function remainingWindPlan(bot: any, plan: WindPairPlan, elapsed: number, burstTick = plan.shot.ticks): WindPairPlan | null {
  if (!Number.isInteger(elapsed) || elapsed < 1) return null
  const sight = (require('./ally-safety') as typeof import('./ally-safety')).allyWorld(bot), observed = { ...bot, blockAt: sight.blockAt }
  const receiver = receiverRun(observed, vector(plan.target), plan.shot, 0, -1, plan.arena, { plan, elapsed, burstTick })
  if (!receiver || bodyIntercepts(plan.shot, receiver)) return null
  return { ...plan, receiver }
}

function throwerRun(bot: any, report: WindReport, shot: WindShot, arena?: WindArena) {
  const proxy = { ...bot, entity: { ...bot.entity, position: vector(report.position), velocity: vector(report.velocity), onGround: report.onGround, effects: report.effects || {}, attributes: report.attributes || {} } }
  const state = edges.cloneState(edges.stateOf(proxy, edges.IDLE), edges.IDLE)
  const simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const recoil = windImpulse(proxy, state.pos, shot.burst, { eyeHeight: report.eyeHeight || 1.62 })
  let peak = state.pos.y, settled = 0
  for (let tick = 0; tick < 80; tick++) {
    if (tick === shot.ticks) state.vel = state.vel.plus(recoil)
    state.control = { ...edges.IDLE }; simulate(state, world)
    peak = Math.max(peak, state.pos.y)
    if (state.isInLava || state.isInWater || !bodyClear(bot, state.pos) || !windInside(state.pos, arena)) return null
    if (tick > shot.ticks && state.onGround) {
      const support = supportAt(bot, state.pos, .04)
      const fall = tick - shot.ticks <= WIND.forgivenessTicks ? Math.min(peak - state.pos.y, shot.burst.y - state.pos.y) : peak - state.pos.y
      if (!support || landingDamage(support.block, fall, report.attributes) > 0) return null
      if (Math.hypot(state.vel.x, state.vel.z) < .035) settled++; else settled = 0
      if (settled >= 6) return { id: report.id, start: report.position, velocity: report.velocity, land: { ...state.pos }, safe: true, recoil: { ...recoil } }
    }
    if (state.pos.y < report.position.y - 3) return null
  }
  return null
}

function bodyIntercepts(shot: WindShot, receiver: { steps: WindStep[]; start: Point }): boolean {
  for (let tick = 0; tick < shot.ticks; tick++) {
    const feet = tick ? receiver.steps[tick - 1]?.pos : receiver.start
    if (!feet) return true
    const box = bodyBox({ blockAt: () => null }, feet), origin = shot.from.plus(shot.velocity.scaled(tick))
    const next = receiver.steps[tick]?.pos || feet
    const margin = Math.max(0, Math.min(Math.fround(.3), (tick - 1) / 20)) + WIND.speed * WIND.dispersion * Math.sqrt(3) * (tick + 1)
    const limit = Math.min(shot.velocity.norm(), shot.from.distanceTo(shot.impact) - shot.velocity.norm() * tick)
    const hit = pick.rayBox(origin, shot.velocity.scaled(1 / shot.velocity.norm()),
      { x: Math.min(box.minX, next.x - .3) - margin, y: Math.min(box.minY, next.y) - margin, z: Math.min(box.minZ, next.z - .3) - margin },
      { x: Math.max(box.maxX, next.x + .3) + margin, y: Math.max(box.maxY, next.y + 1.8) + margin, z: Math.max(box.maxZ, next.z + .3) + margin }, limit)
    if (hit !== null && hit < limit - .01) return true
  }
  return false
}

export function teamWindPlan(bot: any, report: WindReport, target: Point, { arena, accept, candidateStart = 0, maxCandidates = Infinity }: { arena?: WindArena; accept?: (plan: WindPairPlan) => boolean; candidateStart?: number; maxCandidates?: number } = {}): { best: WindPairPlan | null; tried: number; considered: number; next: number | null; why?: string; gameTick: number | null } {
  const result = { best: null as WindPairPlan | null, tried: 0, considered: 0, next: null as number | null, gameTick: worldTick(bot), why: 'no_safe_native_trajectory' }
  if (!finite(target) || !finite(report.position) || !finite(report.velocity) || !report.id || !report.onGround || !bot.entity.onGround || !bodyClear(bot, target) || !supportAt(bot, target, .03) || ![target, report.position, bot.entity.position].every(p => windInside(p, arena))) return result
  const to = vector(target), start = bot.entity.position, yaw = yawTo(start, to), dir = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const from = vector(report.position).offset(0, report.eyeHeight || 1.62, 0)
  const moved = vector(report.velocity); if (report.onGround) moved.y = 0
  const cache = edges.worldOf(bot), observed = { ...bot, blockAt: (p: Vec3) => cache.getBlock(p) }
  for (const back of [.4, .8, 1.2, 1.6]) {
    const aim = floorAim(observed, start.x - dir.x * back, start.z - dir.z * back, start.y)
    if (!aim || !windInside(aim, arena, 0)) continue
    const shot = windShot(observed, from, aim, moved, report.id); if (!shot) continue
    const thrower = throwerRun(observed, report, shot, arena); if (!thrower) continue
    for (const runTicks of [0, 2, 4]) for (const jumpTick of [...new Set([-1, 0, Math.max(0, shot.ticks - 2), Math.max(0, shot.ticks - 1), shot.ticks])]) {
      const index = result.considered++
      if (index < candidateStart) continue
      if (result.tried >= maxCandidates) return { ...result, next: index, why: 'native_candidate_budget' }
      result.tried++
      const receiver = receiverRun(observed, to, shot, runTicks, jumpTick, arena)
      if (receiver && !bodyIntercepts(shot, receiver)) {
        const best = { target: { ...target }, ...(arena ? { arena: { ...arena } } : {}), shot, jumpTick, runTicks, receiver, thrower }
        if (!accept || accept(best)) return { ...result, best, why: undefined }
      }
    }
  }
  return result
}

function burstSpread(shot: WindShot): number {
  let spread = 0
  const axis = Math.abs(shot.normal.x) > .5 ? 'x' : Math.abs(shot.normal.y) > .5 ? 'y' : 'z'
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const velocity = vector(shot.velocity).plus(new Vec3(x, y, z).scaled(WIND.speed * WIND.dispersion))
    const ticks = (shot.impact[axis] - shot.from[axis]) / velocity[axis]
    if (!Number.isFinite(ticks) || ticks < 0) continue
    spread = Math.max(spread, vector(shot.from).plus(velocity.scaled(ticks)).distanceTo(vector(shot.impact)))
  }
  return spread + .01
}

export function matchingBurst(packet: any, expected: Point, shot?: WindShot): boolean {
  const center = packet?.center || packet
  const impulse = packet?.playerKnockback
  if (!finite(center) || !finite(impulse) || vector(impulse).norm() <= .01 || Math.abs(packet.radius - WIND.reach / 2) > 1e-5 || packet.explosionParticle?.type !== 'gust_emitter_small') return false
  if (!shot) return vector(center).distanceTo(vector(expected)) <= .08
  const offset = vector(center).minus(vector(expected))
  const planeError = Math.abs(offset.dot(vector(shot.normal)))
  const impact = vector(center).minus(vector(shot.normal).scaled(WIND.surfaceOffset))
  return planeError < .01 && offset.norm() <= burstSpread(shot) && ['x', 'y', 'z'].every(axis => impact[axis] >= shot.block[axis] - .01 && impact[axis] <= shot.block[axis] + 1.01)
}

/** Receding native forecast: choose one physical input; twelve future frames price its inertia. */
export function windSteer(bot: any, input: any, target: Point, arena?: WindArena): { yaw: number; control: Record<string, boolean>; land?: Point } {
  const simulate = edges.simOf(bot), world = edges.worldOf(bot), to = vector(target), grounded = input.onGround
  const sameSupport = supportAt(bot, input.pos, .03)?.block.position
  const desiredSupport = supportAt(bot, target, .03)?.block.position
  const onTarget = grounded && sameSupport && desiredSupport && positionKey(sameSupport) === positionKey(desiredSupport) && Math.abs(input.pos.y - target.y) < .03
  const distance = Math.hypot(input.pos.x - target.x, input.pos.z - target.z)
  const base = { ...edges.IDLE, sneak: grounded }
  if (onTarget) return { yaw: yawTo(input.pos, target), control: { ...base, forward: distance > .06 }, land: { ...input.pos } }
  const options = [
    { yaw: yawTo(input.pos, target), control: { ...base, forward: true } },
    { yaw: yawTo(input.pos, target), control: { ...base } },
    { yaw: Math.atan2(input.vel.x, input.vel.z), control: { ...base, forward: true } }
  ]
  let best = options[1], score = Infinity, land: Point | undefined
  for (const option of options) {
    const state = edges.cloneState(input, option.control); state.yaw = option.yaw
    let valid = true
    for (let tick = 0; tick < 12; tick++) {
      if (tick) {
        state.yaw = yawTo(state.pos, target)
        state.control = { ...edges.IDLE, sneak: state.onGround, forward: Math.hypot(state.pos.x - target.x, state.pos.z - target.z) > (state.onGround ? .06 : .16) }
      } else state.control = option.control
      simulate(state, world)
      if (state.isInLava || state.isInWater || !bodyClear(bot, state.pos) || !windInside(state.pos, arena)) { valid = false; break }
      if (state.onGround) break
    }
    if (!valid) continue
    const cost = Math.hypot(state.pos.x - target.x, state.pos.z - target.z) + Math.abs(state.pos.y - target.y) * 4
    if (cost < score) { score = cost; best = option; land = { ...state.pos } }
  }
  return { ...best, land }
}

async function waitTick(bot: any, ctl: any): Promise<boolean> {
  if (ctl.aborted || !bot.entity || bot.health <= 0) return false
  await bot.waitForTicks(1)
  return !ctl.aborted && !!bot.entity && bot.health > 0
}
// Ждущего подброса бьют (стрела, огонь, меч) — ожидание снято: сильный бот 14 с стоял в wind_receive под стрелами с «Огнём»
// и сгорел (игра пользователя 25.10).
async function waitStart(bot: any, ctl: any, tick: number) {
  if (!Number.isSafeInteger(tick) || worldTick(bot) === null || worldTick(bot)! >= tick) return false
  const hp0 = bot.health ?? 20
  while (worldTick(bot)! < tick) if (!(await waitTick(bot, ctl)) || (bot.health ?? 20) < hp0 - 1) return false
  return worldTick(bot)! <= tick + 1
}

export async function windReceive(session: any, ctl: any, p: { thrower: WindReport; to?: Point; enemy?: string; incomingDps?: number; dryRun?: boolean; plan?: WindPairPlan; startTick?: number; arena?: WindArena }) {
  const bot = session.bot
  const proposal = p.plan ? { best: p.plan, tried: 0, gameTick: worldTick(bot) } : p.enemy
    ? (require('./spear-wind') as typeof import('./spear-wind')).spearWindPlan(bot, p.thrower, p.enemy, { arena: p.arena, incomingDps: p.incomingDps })
    : teamWindPlan(bot, p.thrower, p.to!, { arena: p.arena })
  if (p.dryRun || !proposal.best) return { ok: !!proposal.best, plan: proposal.best, tried: proposal.tried, partial: 'partial' in proposal && proposal.partial, gameTick: proposal.gameTick, why: proposal.best ? 'plan' : 'no_safe_native_trajectory' }
  const plan = proposal.best
  if (vector(plan.receiver.start).distanceTo(bot.entity.position) > .15 || !bodyClear(bot, plan.target)) return { ok: false, why: 'receiver_start_changed' }
  let received = false, tickReceived = -1, currentTick = -1, progressTick = 0, feedback: (() => void) | null = null
  const onExplosion = (packet: any) => {
    const arrival = currentTick - progressTick
    const timing = plan.spear ? arrival >= 0 && arrival <= plan.shot.ticks + 1 : Math.abs(arrival - plan.shot.ticks) <= 3
    if (!received && currentTick >= 0 && timing && matchingBurst(packet, plan.shot.burst, plan.shot)) {
      received = true; tickReceived = currentTick; attack?.boosted(); if (plan.spear) feedback?.()
    }
  }
  bot._client.on('explosion', onExplosion)
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  const attack = plan.spear ? await (require('./spear-wind') as typeof import('./spear-wind')).braceSpearWind(bot, ctl, plan) : null
  if (plan.spear && !attack) { bot._client.removeListener('explosion', onExplosion); return { ok: false, why: 'spear_charge_not_ready' } }
  try {
    if (!(await waitStart(bot, ctl, p.startTick!))) return { ok: false, why: 'shared_world_tick_required_or_missed' }
    if (plan.spear && worldTick(bot)! + plan.spear.hitTick < attack!.readyAt) return { ok: false, why: 'native_spear_delay_not_ready_at_contact' }
    if (plan.spear && (vector(plan.receiver.start).distanceTo(bot.entity.position) > .15 || !receiverMotionMatches(plan, bot.entity) || receiverSignature(bot) !== plan.receiver.signature || !bot.usingHeldItem || bot.health <= plan.spear.price.self))
      return { ok: false, why: 'spear_receiver_changed_during_preparation' }
    return await new Promise<any>(resolve => {
      let settled = 0, done = false, previous = bot.entity.position.clone(), movement = new Vec3(0, 0, 0), cachedKey = '', cached: any = null
      let lastFrameTick = worldTick(bot), continuousClock = true
      const token = `${bot.username}:${p.startTick}:${++pairSequence}:${JSON.stringify(plan.target)}`
      const samples = []
      const finish = (ok: boolean, why?: string) => {
        if (done) return
        done = true; bot.removeListener('physicsTick', onTick)
        const index = ctl.onAbort?.indexOf(cancel) ?? -1
        if (index >= 0) ctl.onAbort.splice(index, 1)
        const combat = attack?.result()
        resolve({ ok: ok && (!combat || combat.hit), why: ok && combat && !combat.hit ? 'spear_contact_not_confirmed' : why, received, tickReceived, at: { ...bot.entity.position }, target: plan.target, ticks: currentTick, samples, ...(combat ? { combat } : {}) })
      }
      const cancel = () => finish(false, 'interrupted')
      if (plan.spear) pairProgress.set(bot, { startTick: p.startTick!, step: () => currentTick, read() {
        if (done || received) return { ok: false, phase: 'finished' }
        if (currentTick < 1) return { ok: false, phase: 'preparing' }
        if (!continuousClock || lastFrameTick === null || worldTick(bot) !== lastFrameTick) return { ok: false, phase: 'clock_changed' }
        if (attack?.result().cancelled || !bot.usingHeldItem || bot.heldItem?.name !== plan.spear!.name || receiverSignature(bot) !== plan.receiver.signature)
          return { ok: false, phase: 'receiver_changed' }
        const key = JSON.stringify([currentTick, bot.entity.position, bot.entity.velocity, bot.health])
        if (cachedKey === key) return cached
        cachedKey = key
        const reprice = (require('./spear-wind') as typeof import('./spear-wind')).repriceSpearWind
        const remaining = remainingWindPlan(bot, plan, currentTick), cases: WindPairPlan['receiver'][] = []
        if (!remaining || !reprice(bot, remaining, currentTick, p.incomingDps || 0))
          return (cached = { ok: false, phase: 'running', executed: currentTick, why: 'remaining_native_flight_not_worth_or_safe' })
        let worstSpear = remaining.spear!
        // One frame of receipt advancement plus every projectile/body frame ordering.
        // The minimum native contact must pay for every certified arrival, including an immediate burst.
        for (let arrival = 0; arrival <= plan.shot.ticks + 1; arrival++) {
          const variant = arrival === plan.shot.ticks ? remaining : remainingWindPlan(bot, plan, currentTick, arrival)
          if (!variant || !reprice(bot, variant, currentTick, p.incomingDps || 0))
            return (cached = { ok: false, phase: 'running', executed: currentTick, why: 'arrival_phase_not_worth_or_safe', arrival })
          cases.push(variant.receiver)
          if (variant.spear!.price.rate < worstSpear.price.rate) worstSpear = variant.spear!
        }
        remaining.spear = worstSpear
        remaining.progress = { startTick: p.startTick!, executed: currentTick, movement: { ...movement }, receiver: bot.username, token,
          gameTick: lastFrameTick, sampledAt: Date.now(), validForMs: Math.min(50, 1000 / (bot.ndClock?.tickRate || 20)), cases }
        progressTick = currentTick
        return (cached = { ok: true, phase: 'running', executed: currentTick, plan: remaining, gameTick: worldTick(bot) })
      } })
      const apply = () => {
        bot.clearControlStates()
        const step = plan.receiver.steps[Math.min(currentTick, plan.receiver.steps.length - 1)]
        const next = !received && currentTick <= plan.shot.ticks ? step : windSteer(bot, edges.stateOf(bot, edges.IDLE), plan.target, p.arena || plan.arena)
        // Apply synchronously before the next native tick, including a server catch-up batch.
        void bot.look(next.yaw, attack?.pitch(next.yaw) ?? 0, true).catch(cancel)
        for (const [key, value] of Object.entries(next.control)) bot.setControlState(key, value)
        samples.push({ tick: currentTick, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: bot.entity.onGround, control: next.control, predicted: 'land' in next ? next.land : undefined })
      }
      const onTick = () => {
        if (done) return
        const tick = worldTick(bot)
        if (tick === null || lastFrameTick === null || tick !== lastFrameTick + 1) continuousClock = false
        lastFrameTick = tick
        currentTick++
        movement = bot.entity.position.minus(previous); previous = bot.entity.position.clone()
        if (ctl.aborted || bot.health <= 0) { cancel(); return }
        if (!windInside(bot.entity.position, p.arena || plan.arena)) { finish(false, 'arena_boundary'); return }
        if (!received && currentTick > progressTick + plan.shot.ticks + 4) { finish(false, 'planned_wind_burst_not_received'); return }
        if (received && windLanding(bot, { pos: bot.entity.position, vel: bot.entity.velocity, onGround: bot.entity.onGround }, plan.target)) settled++; else settled = 0
        if (settled >= 6) { finish(true); return }
        if (bot.entity.isInLava || bot.entity.position.y < plan.receiver.start.y - 3) { finish(false, 'unsafe_actual_flight'); return }
        if (currentTick >= 95) { finish(false, 'landing_not_confirmed'); return }
        apply()
      }
      currentTick = 0; feedback = apply; ctl.onAbort?.push(cancel); bot.on('physicsTick', onTick); apply()
    })
  } finally { pairProgress.delete(bot); feedback = null; attack?.close(); bot._client.removeListener('explosion', onExplosion); bot.clearControlStates() }
}

function receiverSignature(bot: any) { return JSON.stringify([bot.entity.attributes || {}, bot.entity.effects || {}, bot.food]) }

// The receiver exception is earned again at the final packet: replay only the native pre-burst controls from its current visible motion.
function receiverLaunchSafe(bot: any, ally: any, plan: WindPairPlan, shot: WindShot) {
  const velocity = plan.progress ? plan.receiver.velocity : (require('../bow/track') as typeof import('../bow/track')).observedVelocity(ally)
  const sight = (require('./ally-safety') as typeof import('./ally-safety')).allyWorld(bot)
  const proxy = { ...bot, blockAt: sight.blockAt, food: plan.receiver.food, entity: { ...bot.entity, position: ally.position, velocity: vector(velocity), onGround: ally.onGround !== false, attributes: plan.receiver.attributes, effects: plan.receiver.effects } }
  for (const forecast of plan.progress?.cases || [plan.receiver]) {
    if (plan.progress && !forecast.native) return false
    const state = edges.cloneState(edges.stateOf(proxy, edges.IDLE), edges.IDLE), simulate = edges.simOf(proxy), world = edges.worldOf(proxy), steps: WindStep[] = []
    if (plan.progress) Object.assign(state, forecast.native, { pos: ally.position.clone(), vel: vector(velocity), control: { ...edges.IDLE } })
    for (let tick = 0; tick <= shot.ticks; tick++) {
      const intended = forecast.steps[tick]
      if (!intended) return false
      if (plan.progress && tick === forecast.boomTick) state.vel = state.vel.plus(windImpulse(proxy, state.pos, shot.burst))
      state.yaw = intended.yaw; state.control = { ...intended.control }; simulate(state, world)
      if (!bodyClear(proxy, state.pos)) return false
      steps.push({ yaw: state.yaw, control: state.control, pos: { ...state.pos }, vel: { ...state.vel }, onGround: state.onGround })
    }
    if (bodyIntercepts(shot, { start: ally.position, steps })) return false
  }
  return true
}

function freshProgress(bot: any, ally: string, plan: WindPairPlan, startTick: number) {
  const p = plan.progress, age = p && Date.now() - p.sampledAt
  return !!p && p.startTick === startTick && p.receiver === ally && typeof p.token === 'string' && p.token.length > 0 &&
    p.executed >= 1 && p.gameTick === worldTick(bot) && Number.isFinite(age) && age! >= 0 && age! < Math.min(50, p.validForMs, 1000 / (bot.ndClock?.tickRate || 20)) &&
    p.cases?.length > 0 && !launchedProgress.get(bot)?.has(p.token)
}

// Grounded y velocity differs between the native state and position receipts; horizontal motion must still match the owned plan.
function receiverMotionMatches(plan: WindPairPlan, entity: any) {
  const track = require('../bow/track') as typeof import('../bow/track'), velocity = track.observedVelocity(entity), expected = plan.receiver.velocity
  if (plan.progress) {
    if (vector(plan.receiver.start).distanceTo(entity.position) > 4 / 4096) return false
    const moved = plan.progress.movement
    const groundY = y => entity.onGround !== false && (Math.abs(y) < 1e-4 || Math.abs(y + .0784000015258789) < 1e-4) ? 0 : y
    // The public tracker may expose accepted displacement or its native post-drag reconstruction.
    return [moved, expected].some(v => Math.hypot(velocity.x - v.x, groundY(velocity.y) - groundY(v.y), velocity.z - v.z) < 4 / 4096)
  }
  const groundY = y => Math.abs(y) < 1e-4 || Math.abs(y + .0784000015258789) < 1e-4 ? 0 : y
  return entity.onGround !== false && !!expected && Math.hypot(velocity.x - expected.x, groundY(velocity.y) - groundY(expected.y), velocity.z - expected.z) < 1e-4
}

export async function windBoost(session: any, ctl: any, p: { ally: string; plan: WindPairPlan; startTick: number; dryRun?: boolean; prepareOnly?: boolean; arena?: WindArena }) {
  const bot = session.bot, plan = p.plan
  const ally = Object.values(bot.entities || {}).find((e: any) => e.username === p.ally) as any
  if (!ally || !pick.canHit(bot, ally, { range: 32 })) return { ok: false, why: 'ally_not_visible' }
  const charge = bot.inventory.items().find((i: any) => i.name === 'wind_charge')
  if (!charge || (require('../mace') as typeof import('../mace')).windReady?.(bot) === false) return { ok: false, why: 'wind_charge_not_ready' }
  if (!plan || !finite(plan.target) || !finite(plan.thrower.start) || !finite(plan.receiver.start)) return { ok: false, why: 'invalid_plan' }
  if (vector(plan.thrower.start).distanceTo(bot.entity.position) > .15 || vector(plan.receiver.start).distanceTo(ally.position) > .2) return { ok: false, why: 'pair_start_changed' }
  if (![bot.entity.position, ally.position, plan.target].every(at => windInside(at, p.arena || plan.arena))) return { ok: false, why: 'arena_boundary' }
  if (p.dryRun) return { ok: true, gameTick: worldTick(bot) }
  if (plan.spear && !p.prepareOnly && (!plan.progress || plan.progress.executed < 1 || plan.progress.startTick !== p.startTick))
    return { ok: false, why: 'executed_receiver_progress_required' }
  if (plan.spear && !p.prepareOnly && !freshProgress(bot, p.ally, plan, p.startTick)) return { ok: false, why: 'receiver_progress_expired_or_changed' }
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  await bot.equip(charge, 'hand')
  const hands = require('../mace/hands') as typeof import('../mace/hands'), count = hands.windCount(bot)
  let launchConfirmed = false, receiverImpulse = false
  // A fresh native impulse may precede its next position receipt; positional tracking must not hide that change.
  const impulse = packet => { if (packet.entityId === ally.id) receiverImpulse = true }
  bot._client.on('entity_velocity', impulse)
  const cooldown = packet => { if (String(packet.cooldownGroup).replace(/^minecraft:/, '') === 'wind_charge' && packet.cooldownTicks > 0) launchConfirmed = true }
  bot._client.on('set_cooldown', cooldown)
  try {
    if (!p.prepareOnly && !plan.progress && !(await waitStart(bot, ctl, p.startTick))) return { ok: false, why: 'shared_world_tick_required_or_missed' }
    const from = pick.eyeOf(bot), moved = bot.entity.velocity.clone(); if (bot.entity.onGround) moved.y = 0
    const actual = windShot(bot, from, vector(plan.shot.aim), moved)
    if (!actual || actual.burst.distanceTo(vector(plan.shot.burst)) > .08 || !pick.faceAim(bot, vector(actual.block), actual.normal, { range: 32 })) return { ok: false, why: 'actual_charge_ray_changed' }
    await bot.look(actual.yaw, actual.pitch, true)
    bot.entity.yaw = actual.yaw; bot.entity.pitch = actual.pitch
    if (p.prepareOnly) return { ok: true, gameTick: worldTick(bot) }
    let fired = false
    await new Promise<void>(resolve => edges.afterPacket(bot, () => {
      const movement = bot.entity.velocity.clone(); if (bot.entity.onGround) movement.y = 0
      const release = windShot(bot, pick.eyeOf(bot), vector(plan.shot.aim), movement)
      if (!ctl.aborted && !receiverImpulse && (!plan.spear || freshProgress(bot, p.ally, plan, p.startTick)) && release && (!plan.spear || release.ticks === plan.shot.ticks) && release.burst.distanceTo(vector(plan.shot.burst)) <= .08 &&
          vector(plan.thrower.start).distanceTo(bot.entity.position) <= .15 && vector(plan.receiver.start).distanceTo(ally.position) <= .2 &&
          (!plan.spear || receiverMotionMatches(plan, ally)) && receiverLaunchSafe(bot, ally, plan, release) &&
          Math.abs(bot.entity.yaw - release.yaw) <= WIND.dispersion && Math.abs(bot.entity.pitch - release.pitch) <= WIND.dispersion &&
          (!plan.spear || (require('../pvp/body') as typeof import('../pvp/body')).usingItem(bot, ally) === plan.spear.name) &&
          plan.receiver.settled && plan.thrower.safe &&
          (require('./wind-safety') as typeof import('./wind-safety')).windReleaseSafe(bot, release, movement, p.ally)) {
        // The native safety rollout itself can consume the lease's last frame.
        if (!plan.spear || freshProgress(bot, p.ally, plan, p.startTick)) {
          bot.entity.yaw = release.yaw; bot.entity.pitch = release.pitch
          bot.activateItem(); bot.usingHeldItem = false; fired = true
          if (plan.progress) {
            const used = launchedProgress.get(bot) || new Map<string, number>()
            for (const [token, at] of used) if (Date.now() - at >= 50) used.delete(token)
            used.set(plan.progress.token, plan.progress.sampledAt); launchedProgress.set(bot, used)
          }
        }
      }
      resolve()
    }))
    if (fired) for (let tick = 0; tick <= actual.ticks + 2 && !ctl.aborted && !launchConfirmed; tick++) {
      launchConfirmed ||= hands.windCount(bot) < count
      if (!launchConfirmed) await bot.waitForTicks(1)
    }
    return { ok: fired && launchConfirmed, fired, launchConfirmed, why: !fired ? 'charge_intercepted_or_changed_before_release' : launchConfirmed ? undefined : 'launch_unconfirmed', shot: actual, startTick: p.startTick }
  } finally { bot._client.removeListener('set_cooldown', cooldown); bot._client.removeListener('entity_velocity', impulse); bot.clearControlStates() }
}
