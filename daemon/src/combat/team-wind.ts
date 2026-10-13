import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, shapeBoxes, supportAt, HAZARD, type Point } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
const edges = require('../edges')
const pick = require('../pick')
const boom = require('../boom')

// WindChargeItem / AbstractWindCharge / ServerExplosion, reviewed 1.21.11 (PVP-RESEARCH б.8).
export const WIND = Object.freeze({ speed: 1.5, reach: 2.4, knockback: 1.22, surfaceOffset: .25, forgivenessTicks: 40, dispersion: .0172275 })
const vector = (p: Point) => new Vec3(p.x, p.y, p.z)
const finite = (p: Point) => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const yawTo = (a: Point, b: Point) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const positionKey = (p: Point) => `${p.x},${p.y},${p.z}`
export interface WindReport { id: string; position: Point; velocity: Point; onGround: boolean; eyeHeight?: number; attributes?: Record<string, any>; effects?: Record<string, any> }
export interface WindShot { from: Vec3; aim: Vec3; yaw: number; pitch: number; velocity: Vec3; ticks: number; impact: Vec3; burst: Vec3; normal: Vec3; block: Point }
export interface WindArena { x: number; z: number; r: number; killY?: number }
interface WindStep { yaw: number; control: Record<string, boolean>; pos: Point; vel: Point; onGround: boolean }
export interface WindPairPlan {
  target: Point
  arena?: WindArena
  shot: WindShot
  jumpTick: number
  runTicks: number
  receiver: { start: Point; land: Vec3; settled: boolean; steps: WindStep[]; boomTick: number }
  thrower: { id: string; start: Point; velocity: Point; land: Point; safe: boolean; recoil: Point }
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

// No gravity/drag: solve the inherited shooter movement exactly, then take the FIRST real block hit.
export function windShot(bot: any, from: Vec3, aim: Vec3, moved = new Vec3(0, 0, 0), owner?: string | number): WindShot | null {
  if (![from, aim, moved].every(finite)) return null
  const delta = aim.minus(from)
  const a = moved.dot(moved) - WIND.speed ** 2, b = -2 * delta.dot(moved), c = delta.dot(delta)
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0 || c < 1e-8) return null
  const times = Math.abs(a) < 1e-9 ? [-c / b] : [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)]
  const time = times.filter(t => t > 0 && Number.isFinite(t)).sort((x, y) => x - y)[0]
  if (!time || time > 30) return null
  const velocity = delta.scaled(1 / time), direction = velocity.scaled(1 / velocity.norm())
  let unknown = false
  const observed = { ...bot, blockAt(p: Vec3) { const block = bot.blockAt(p, false); if (!block) unknown = true; return block } }
  const hit = pick.blockOnRay(observed, from, direction, delta.norm() + .05)
  if (unknown || !hit || hit.t < delta.norm() - .02) return null
  const impact = from.plus(direction.scaled(hit.t))
  const faces: Vec3[] = []
  for (const box of shapeBoxes(hit.block)) for (const axis of ['x', 'y', 'z'] as const) for (const sign of [-1, 1]) {
    const plane = box[(sign < 0 ? 'min' : 'max') + axis.toUpperCase()]
    if (Math.abs(impact[axis] - plane) < 1e-5) { const n = new Vec3(0, 0, 0); n[axis] = sign; faces.push(n) }
  }
  const normal = faces.sort((x, y) => x.dot(direction) - y.dot(direction))[0]
  if (!normal || HAZARD.test(hit.block.name)) return null
  for (const entity of Object.values(bot.entities || {}) as any[]) {
    if (!entity || entity === bot.entity || entity.id === bot.entity?.id && entity.id !== undefined || entity.username === owner && owner !== undefined || entity.id === owner && owner !== undefined ||
        !(entity.username || entity.type === 'player' || entity.type === 'mob' || entity.name === 'armor_stand')) continue
    if (!pick.canHit(bot, entity, { range: 64 })) continue
    // Read the third body's geometry only AFTER our own LOS succeeds.
    const feet = entity.position, half = (entity.width || .6) / 2, height = entity.height || 1.8
    const body = pick.rayBox(from, direction, { x: feet.x - half, y: feet.y, z: feet.z - half }, { x: feet.x + half, y: feet.y + height, z: feet.z + half }, hit.t)
    if (body !== null && body < hit.t - .01) return null
  }
  const look = velocity.minus(moved).scaled(1 / WIND.speed)
  return { from: from.clone(), aim: aim.clone(), yaw: Math.atan2(-look.x, -look.z), pitch: Math.asin(Math.max(-1, Math.min(1, look.y))), velocity,
    ticks: Math.max(1, Math.ceil(hit.t / velocity.norm())), impact, burst: impact.plus(normal.scaled(WIND.surfaceOffset)), normal, block: { ...hit.pos } }
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

function receiverRun(bot: any, target: Vec3, shot: WindShot, runTicks: number, jumpTick: number, arena?: WindArena) {
  const state = edges.cloneState(edges.stateOf(bot, edges.IDLE), edges.IDLE)
  const simulate = edges.simOf(bot), world = edges.worldOf(bot), steps: WindStep[] = []
  const launchYaw = yawTo(state.pos, target)
  let peak = state.pos.y, settled = 0, lifted = false
  for (let tick = 0; tick < 90; tick++) {
    const control = { ...edges.IDLE }
    state.yaw = launchYaw
    if (tick < runTicks) { control.forward = true; control.sprint = true }
    if (tick === jumpTick) control.jump = true
    if (tick === shot.ticks) {
      const impulse = windImpulse(bot, state.pos, shot.burst)
      if (impulse.norm() < .05) return null
      state.vel = state.vel.plus(impulse)
    }
    if (tick > shot.ticks) {
      const steering = windSteer(bot, state, target, arena)
      state.yaw = steering.yaw; Object.assign(control, steering.control)
    }
    state.control = control; simulate(state, world)
    if (!state.onGround) lifted = true
    peak = Math.max(peak, state.pos.y)
    if (state.isInLava || state.isInWater || !bodyClear(bot, state.pos) || !windInside(state.pos, arena)) return null
    steps.push({ yaw: state.yaw, control, pos: { ...state.pos }, vel: { ...state.vel }, onGround: state.onGround })
    if (tick > shot.ticks && lifted && state.onGround) {
      if (Math.abs(state.pos.y - target.y) > .03) return null
      const support = supportAt(bot, state.pos, .04)
      const fall = tick - shot.ticks <= WIND.forgivenessTicks ? Math.min(peak - state.pos.y, shot.burst.y - state.pos.y) : peak - state.pos.y
      if (!support || landingDamage(support.block, fall, bot.entity.attributes) > 0) return null
      if (windLanding(bot, state, target)) settled++; else settled = 0
      if (settled >= 6) return { start: { ...bot.entity.position }, land: state.pos.clone(), settled: true, steps, boomTick: shot.ticks }
      if (steps.length > shot.ticks + 8 && Math.hypot(state.pos.x - target.x, state.pos.z - target.z) > .8) return null
    }
    if (state.pos.y < bot.entity.position.y - 3) return null
  }
  return null
}

function throwerRun(bot: any, report: WindReport, shot: WindShot, arena?: WindArena) {
  const proxy = { ...bot, entity: { ...bot.entity, position: vector(report.position), velocity: vector(report.velocity), onGround: report.onGround, effects: report.effects || {}, attributes: report.attributes || {} } }
  const state = edges.cloneState(edges.stateOf(proxy, edges.IDLE), edges.IDLE)
  const simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const recoil = windImpulse(proxy, state.pos, shot.burst, { eyeHeight: report.eyeHeight || 1.62 })
  let peak = state.pos.y, settled = 0
  for (let tick = 0; tick < 80; tick++) {
    if (tick === shot.ticks) state.vel = state.vel.plus(recoil)
    state.control = { ...edges.IDLE, sneak: tick > shot.ticks && state.onGround }; simulate(state, world)
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
    const limit = Math.min(shot.velocity.norm(), shot.from.distanceTo(shot.impact) - shot.velocity.norm() * tick)
    const hit = pick.rayBox(origin, shot.velocity.scaled(1 / shot.velocity.norm()), { x: box.minX, y: box.minY, z: box.minZ }, { x: box.maxX, y: box.maxY, z: box.maxZ }, limit)
    if (hit !== null && hit < limit - .01) return true
  }
  return false
}

export function teamWindPlan(bot: any, report: WindReport, target: Point, { arena }: { arena?: WindArena } = {}): { best: WindPairPlan | null; tried: number; why?: string; gameTick: number | null } {
  const result = { best: null as WindPairPlan | null, tried: 0, gameTick: worldTick(bot), why: 'no_safe_native_trajectory' }
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
      result.tried++
      const receiver = receiverRun(observed, to, shot, runTicks, jumpTick, arena)
      if (receiver && !bodyIntercepts(shot, receiver)) return { ...result, best: { target: { ...target }, ...(arena ? { arena: { ...arena } } : {}), shot, jumpTick, runTicks, receiver, thrower }, why: undefined }
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
async function waitStart(bot: any, ctl: any, tick: number) {
  if (!Number.isSafeInteger(tick) || worldTick(bot) === null || worldTick(bot)! >= tick) return false
  while (worldTick(bot)! < tick) if (!(await waitTick(bot, ctl))) return false
  return worldTick(bot)! <= tick + 1
}

export async function windReceive(session: any, ctl: any, p: { thrower: WindReport; to: Point; dryRun?: boolean; plan?: WindPairPlan; startTick?: number; arena?: WindArena }) {
  const bot = session.bot
  const proposal = p.plan ? { best: p.plan, tried: 0, gameTick: worldTick(bot) } : teamWindPlan(bot, p.thrower, p.to, { arena: p.arena })
  if (p.dryRun || !proposal.best) return { ok: !!proposal.best, plan: proposal.best, tried: proposal.tried, gameTick: proposal.gameTick, why: proposal.best ? 'plan' : 'no_safe_native_trajectory' }
  const plan = proposal.best
  if (vector(plan.receiver.start).distanceTo(bot.entity.position) > .15 || !bodyClear(bot, plan.target)) return { ok: false, why: 'receiver_start_changed' }
  let received = false, tickReceived = -1, currentTick = -1
  const onExplosion = (packet: any) => { if (currentTick >= 0 && matchingBurst(packet, plan.shot.burst, plan.shot) && Math.abs(currentTick - plan.shot.ticks) <= 3) { received = true; tickReceived = currentTick } }
  bot._client.on('explosion', onExplosion)
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  try {
    if (!(await waitStart(bot, ctl, p.startTick!))) return { ok: false, why: 'shared_world_tick_required_or_missed' }
    return await new Promise<any>(resolve => {
      let settled = 0, done = false
      const samples = []
      const finish = (ok: boolean, why?: string) => {
        if (done) return
        done = true; bot.removeListener('physicsTick', onTick)
        const index = ctl.onAbort?.indexOf(cancel) ?? -1
        if (index >= 0) ctl.onAbort.splice(index, 1)
        resolve({ ok, why, received, tickReceived, at: { ...bot.entity.position }, target: plan.target, ticks: currentTick, samples })
      }
      const cancel = () => finish(false, 'interrupted')
      const apply = () => {
        bot.clearControlStates()
        const step = plan.receiver.steps[Math.min(currentTick, plan.receiver.steps.length - 1)]
        const next = !received && currentTick <= plan.shot.ticks ? step : windSteer(bot, edges.stateOf(bot, edges.IDLE), plan.target, p.arena || plan.arena)
        // Apply synchronously before the next native tick, including a server catch-up batch.
        void bot.look(next.yaw, 0, true).catch(cancel)
        for (const [key, value] of Object.entries(next.control)) bot.setControlState(key, value)
        samples.push({ tick: currentTick, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: bot.entity.onGround, control: next.control, predicted: 'land' in next ? next.land : undefined })
      }
      const onTick = () => {
        if (done) return
        currentTick++
        if (ctl.aborted || bot.health <= 0) { cancel(); return }
        if (!windInside(bot.entity.position, p.arena || plan.arena)) { finish(false, 'arena_boundary'); return }
        if (!received && currentTick > plan.shot.ticks + 4) { finish(false, 'planned_wind_burst_not_received'); return }
        if (received && windLanding(bot, { pos: bot.entity.position, vel: bot.entity.velocity, onGround: bot.entity.onGround }, plan.target)) settled++; else settled = 0
        if (settled >= 6) { finish(true); return }
        if (bot.entity.isInLava || bot.entity.position.y < plan.receiver.start.y - 3) { finish(false, 'unsafe_actual_flight'); return }
        if (currentTick >= 95) { finish(false, 'landing_not_confirmed'); return }
        apply()
      }
      currentTick = 0; ctl.onAbort?.push(cancel); bot.on('physicsTick', onTick); apply()
    })
  } finally { bot._client.removeListener('explosion', onExplosion); bot.clearControlStates() }
}

export async function windBoost(session: any, ctl: any, p: { ally: string; plan: WindPairPlan; startTick: number; dryRun?: boolean; arena?: WindArena }) {
  const bot = session.bot, plan = p.plan
  const ally = Object.values(bot.entities || {}).find((e: any) => e.username === p.ally) as any
  if (!ally || !pick.canHit(bot, ally, { range: 32 })) return { ok: false, why: 'ally_not_visible' }
  const charge = bot.inventory.items().find((i: any) => i.name === 'wind_charge')
  if (!charge || require('../mace').windReady?.(bot) === false) return { ok: false, why: 'wind_charge_not_ready' }
  if (!plan || !finite(plan.target) || !finite(plan.thrower.start) || !finite(plan.receiver.start)) return { ok: false, why: 'invalid_plan' }
  if (vector(plan.thrower.start).distanceTo(bot.entity.position) > .15 || vector(plan.receiver.start).distanceTo(ally.position) > .2) return { ok: false, why: 'pair_start_changed' }
  if (![bot.entity.position, ally.position, plan.target].every(at => windInside(at, p.arena || plan.arena))) return { ok: false, why: 'arena_boundary' }
  if (p.dryRun) return { ok: true, gameTick: worldTick(bot) }
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  await bot.equip(charge, 'hand')
  try {
    if (!(await waitStart(bot, ctl, p.startTick))) return { ok: false, why: 'shared_world_tick_required_or_missed' }
    const from = pick.eyeOf(bot), moved = bot.entity.velocity.clone(); if (bot.entity.onGround) moved.y = 0
    const actual = windShot(bot, from, vector(plan.shot.aim), moved)
    if (!actual || actual.burst.distanceTo(vector(plan.shot.burst)) > .08 || !pick.faceAim(bot, vector(actual.block), actual.normal, { range: 32 })) return { ok: false, why: 'actual_charge_ray_changed' }
    await bot.look(actual.yaw, actual.pitch, true)
    bot.entity.yaw = actual.yaw; bot.entity.pitch = actual.pitch
    let fired = false
    await new Promise<void>(resolve => edges.afterPacket(bot, () => {
      const movement = bot.entity.velocity.clone(); if (bot.entity.onGround) movement.y = 0
      const release = windShot(bot, pick.eyeOf(bot), vector(plan.shot.aim), movement)
      if (!ctl.aborted && release && release.burst.distanceTo(vector(plan.shot.burst)) <= .08) {
        bot.entity.yaw = release.yaw; bot.entity.pitch = release.pitch
        bot.activateItem(); bot.usingHeldItem = false; fired = true
      }
      resolve()
    }))
    return { ok: fired, fired, why: fired ? undefined : 'charge_intercepted_or_changed_before_release', shot: actual, startTick: p.startTick }
  } finally { bot.clearControlStates() }
}
