import { Vec3 } from 'vec3'
import { wall, observationNow } from '../game-clock'
import { type Point, supportAt, verticalLift } from '../navigation/geometry'
import { landingDamage, windFallDamage } from '../navigation/landing'
import edges = require('../edges')
import pick = require('../pick')
import { observedCollision } from '../pvp/search'
import { createLastSeen, seesPlayer, visiblePlayerItem, observePlayerGear } from '../pvp/last-seen'
import { thrownTracker, projectileView, projectileVelocity } from '../threats'
import { isAlly } from './ally-safety'
import { WIND, WIND_FORECAST_TICKS, WIND_REPORT_AGE_TICKS, arenaRoom, windLaunch, windBlockImpact, windImpulse, windInside, windGust, worldTick, windOutside, windOutward, windAboveWorld, type WindArena, type WindReport } from './team-wind'

const vec = (p: Point) => new Vec3(p.x, p.y, p.z)
const finite = (p: Point) => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const expired = (deadline?: number) => deadline !== undefined && wall.monotonic() > deadline
interface Frame { pos: Vec3; vel: Vec3; onGround: boolean }
type WindCollision = ReturnType<typeof observedCollision>
/** One synchronous release pass owns both raw Blocks and observed collision results, including unknowns. */
export function windCollisionWorld(bot: any): WindCollision {
  const raw = edges.worldOf(bot), sight = observedCollision(bot, p => raw.getBlock(p), true), seen = edges.worldOf(sight)
  return { ...sight, blockAt: (p: Vec3) => seen.getBlock(p) }
}
export { WIND_FORECAST_TICKS } from './team-wind'
export interface EnemyWindShot {
  thrower: string; fireDelay: number; ticks: number; from: Vec3; aim: Vec3; yaw: number; pitch: number
  velocity: Vec3; burst: Vec3; feet: Vec3; aimHeight?: number; fireTick?: number; arrivalTick?: number
}
export interface EnemyWindOptions { arena: WindArena; startTick?: number; maxShots?: number; allies?: WindReport[]; delays?: number[]; reactAfterHit?: boolean; juggle?: boolean; deadline?: number; waitForHit?: boolean; collision?: WindCollision; protect?: Array<{ x: number, y: number, z: number }>; visiblePrefix?: boolean; expectedPrefix?: number; certifyRelease?: boolean }

// Blast Protection has a separate attribute from netherite's ordinary knockback resistance; glint hides its level.
export function windResistance(foe: any): { lo: number; hi: number } {
  const armor = (foe.equipment || []).slice(2, 6).map(visiblePlayerItem)
  const unknown = Math.max(0, Math.min(4, foe._ndUnknownArmorSlots || 0))
  return { lo: 0, hi: Math.min(1, .6 * (unknown + armor.filter(it => it?.enchanted).length)) }
}

function bodyState(bot: any, body: WindReport | any) {
  // Летящий на элитрах — полётом по его взгляду (prismarine elytraFlying, элитры в слоте 6), а не падающим телом (29.10).
  const entity = { position: vec(body.position), velocity: vec(body.velocity), onGround: !!body.onGround, elytraFlying: !!body.gliding,
    yaw: body.yaw || 0, pitch: body.gliding ? body.pitch || 0 : 0, effects: body.effects || {}, attributes: body.attributes || {}, _ndPoseHeight: body.gliding ? .6 : body.height || 1.8 }
  const slots: any[] = []; if (body.gliding) slots[6] = { name: 'elytra' }
  return edges.stateOf({ ...bot, entity, food: 20, inventory: { slots, items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 }, { ...edges.IDLE, ...body.control })
}

/** Radio snapshots have their own server tick; never silently treat an old ally pose as current. */
export function windReportAt(bot: any, report: WindReport, gameTick: number, deadline?: number, collision?: WindCollision): WindReport | null {
  if (expired(deadline) || !Number.isSafeInteger(report?.gameTick) || !Number.isSafeInteger(gameTick) ||
      gameTick < report.gameTick! || gameTick - report.gameTick! > WIND_REPORT_AGE_TICKS || !finite(report.position) || !finite(report.velocity) ||
      report.launchMovement !== undefined && !finite(report.launchMovement)) return null
  if (report.gameTick === gameTick) return { ...report, position: { ...report.position }, velocity: { ...report.velocity } }
  const state = bodyState(bot, report), world = edges.worldOf(collision || observedCollision(bot)), simulate = edges.simOf(bot)
  let previous = state.pos.clone()
  for (let tick = report.gameTick!; tick < gameTick; tick++) {
    if (expired(deadline)) return null
    previous = state.pos.clone(); simulate(state, world)
  }
  return { ...report, position: { ...state.pos }, velocity: { ...state.vel }, launchMovement: { ...state.pos.minus(previous) }, onGround: state.onGround, yaw: state.yaw, gameTick }
}

// ProjectileUtil.computeMargin, AbstractHurtingProjectile.tick/setPos, AbstractWindCharge.onHitEntity (1.21.11).
function bodyHit(origin: Vec3, direction: Vec3, length: number, feet: Point, age: number, width = .6, height = 1.8, previous = feet) {
  const margin = Math.max(0, Math.min(Math.fround(.3), Math.fround((age - 2) / 20))), half = Math.fround(width) / 2 + margin
  const hit = pick.rayBox(origin, direction, { x: Math.min(feet.x, previous.x) - half, y: Math.min(feet.y, previous.y) - margin, z: Math.min(feet.z, previous.z) - half },
    { x: Math.max(feet.x, previous.x) + half, y: Math.max(feet.y, previous.y) + Math.fround(height) + margin, z: Math.max(feet.z, previous.z) + half }, length)
  return hit !== null && hit > 0 && hit < length ? hit : null // Native AABB.clip requires an entering face strictly inside this segment.
}

function preservesContact(shot: EnemyWindShot, incumbent: EnemyWindShot, frames: Frame[], width: number, height: number) {
  const age = incumbent.ticks, arrival = incumbent.fireDelay + age, spread = WIND.speed * WIND.dispersion
  const touches = (ray: EnemyWindShot, feet: Point, dx: number, dy: number, dz: number) => {
    const velocity = ray.velocity.offset(dx, dy, dz), length = velocity.norm()
    return bodyHit(ray.from.plus(velocity.scaled(age - 1)), velocity.scaled(1 / length), length, feet, age, width, height) !== null
  }
  for (const frame of [frames[arrival - 1], frames[arrival]]) {
    if (!frame) return false
    for (const x of [-spread, spread]) for (const y of [-spread, spread]) for (const z of [-spread, spread])
      if (touches(incumbent, frame.pos, x, y, z) && !touches(shot, frame.pos, x, y, z)) return false
  }
  return true
}

function preservesEarlierContact(shot: EnemyWindShot, incumbent: EnemyWindShot, frames: Frame[], width: number, height: number) {
  const last = incumbent.ticks, spread = WIND.speed * WIND.dispersion
  if (!frames[incumbent.fireDelay + last + 1]) return false
  const entry = (ray: EnemyWindShot, phase: number, x: number, y: number, z: number) => {
    const velocity = ray.velocity.offset(x, y, z), length = velocity.norm(), direction = velocity.scaled(1 / length)
    for (let age = Math.max(1, ray.ticks - 1); age <= last; age++) {
      const feet = frames[ray.fireDelay + age + phase].pos
      const hit = bodyHit(ray.from.plus(velocity.scaled(age - 1)), direction, length, feet, age, width, height)
      if (hit !== null) return age + hit / length
    }
    return Infinity
  }
  // A nominally earlier ray can still contact on the incumbent tick in an adjacent body phase.
  for (const phase of [-1, 0, 1]) for (const x of [-spread, spread]) for (const y of [-spread, spread]) for (const z of [-spread, spread]) {
    if (entry(shot, phase, x, y, z) > entry(incumbent, phase, x, y, z)) return false
  }
  return true
}

// Native triangular launch noise has independent bounded components. Intersect their
// expanding box with a block shape at the same continuous time on all three axes.
function windSpreadTouches(from: Vec3, velocity: Vec3, cell: number[], shape: number[], end: number, start = 0) {
  let enter = start, leave = end
  const spread = WIND.speed * WIND.dispersion
  for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
    const lo = cell[i] + shape[i] - from[axis], hi = cell[i] + shape[i + 3] - from[axis]
    const fast = velocity[axis] + spread, slow = velocity[axis] - spread
    if (fast > 0) enter = Math.max(enter, lo / fast)
    else if (fast < 0) leave = Math.min(leave, lo / fast)
    else if (lo > 0) return false
    if (slow > 0) leave = Math.min(leave, hi / slow)
    else if (slow < 0) enter = Math.max(enter, hi / slow)
    else if (hi < 0) return false
    if (enter > leave) return false
  }
  return true
}

function windStaticBody(feet: Vec3, width: number, height: number) {
  const margin = Math.fround(.3), side = Math.fround(width) / 2 + margin, top = Math.fround(height) + margin
  return { feet, width, height, lo: feet.offset(-side, -margin, -side), hi: feet.offset(side, top, side) }
}

function windStaticContact(from: Vec3, velocity: Vec3, direction: Vec3, length: number, body: ReturnType<typeof windStaticBody>) {
  const entry = pick.rayBox(from, velocity, body.lo, body.hi, Infinity)
  if (entry === null) return null
  const first = Math.floor(entry) + 1
  if (!Number.isSafeInteger(first)) return null
  // ProjectileUtil's margin stops growing at age eight. A later entry needs one exact native segment.
  for (let age = first; age <= Math.max(8, first); age++) {
    const origin = from.plus(velocity.scaled(age - 1))
    const hit = bodyHit(origin, direction, length, body.feet, age, body.width, body.height)
    if (hit !== null) return age - 1 + hit / length
  }
  return null
}

// shortcut: eight miss directions against visible ally poses, expand when continuous moving bodies can be bounded.
export function windAllyTailSafe(bot: any, foe: any, shot: EnemyWindShot, allies: WindReport[], collision: WindCollision, deadline: number) {
  const { from, velocity, burst } = shot
  if (!allies.length || windAboveWorld(bot, from)) return true
  const intended = burst.minus(from).dot(velocity) / velocity.dot(velocity), margin = Math.fround(.3), side = Math.fround(.6) / 2 + margin
  const bodies = allies.flatMap(ally => {
    const height = ally.gliding || ally.eyeHeight === .4 ? .6 : ally.eyeHeight === 1.27 ? 1.5 : 1.8
    const { x, y, z } = ally.position, top = Math.fround(height) + margin
    return windSpreadTouches(from, velocity, [x, y, z], [-side, -margin, -side, side, top, side], Infinity, intended)
      ? [windStaticBody(vec(ally.position), .6, height)] : []
  })
  if (!bodies.length) return true

  const box = pick.hitboxOf(bot, foe), target = windStaticBody(shot.feet, box.w, box.h)
  const spread = WIND.speed * WIND.dispersion
  const known = { blockAt(p: Vec3) { return expired(deadline) ? null : collision.blockAt(p) } }
  for (const x of [-spread, spread]) for (const y of [-spread, spread]) for (const z of [-spread, spread]) {
    const ray = velocity.offset(x, y, z), length = ray.norm()
    if (!length) continue
    const direction = ray.scaled(1 / length)
    let first = Infinity
    for (const body of bodies) {
      const contact = windStaticContact(from, ray, direction, length, body)
      if (contact !== null && contact > intended) first = Math.min(first, contact)
    }
    if (!Number.isFinite(first) || windAboveWorld(bot, from.plus(ray.scaled(Math.floor(first))))) continue
    // This witness must be able to miss even the selected forecast hull, which a close centred shot can cover.
    const targetContact = windStaticContact(from, ray, direction, length, target)
    if (targetContact !== null && targetContact < first) continue
    if (!windBlockImpact(known, from, direction, first * length, length)) return false
  }
  return true
}

function windCoverClear(bot: any, { from, velocity, burst, ticks }: EnemyWindShot, blockShapes: Map<string, number[][] | null>, deadline?: number) {
  const end = Math.min(ticks, burst.minus(from).dot(velocity) / velocity.dot(velocity))
  const cells = new Set<string>(), full = [0, 0, 0, 1, 1, 1], spread = WIND.speed * WIND.dispersion
  for (let start = 0; start < end; start++) {
    if (expired(deadline)) return false
    const next = Math.min(start + 1, end), a = from.plus(velocity.scaled(start)), b = from.plus(velocity.scaled(next))
    const lo = (axis: 'x' | 'y' | 'z') => Math.floor(Math.min(a[axis] - spread * start, b[axis] - spread * next))
    const hi = (axis: 'x' | 'y' | 'z') => Math.floor(Math.max(a[axis] + spread * start, b[axis] + spread * next))
    const x1 = hi('x'), y1 = hi('y'), z1 = hi('z'), y0 = lo('y'), z0 = lo('z')
    for (let x = lo('x'); x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const key = `${x},${y},${z}`
      if (cells.has(key)) continue
      cells.add(key)
      let shapes = blockShapes.get(key)
      if (shapes?.length === 0) continue
      const cell = [x, y, z]
      if (!windSpreadTouches(from, velocity, cell, full, end)) continue
      if (shapes === undefined) {
        const block = bot.blockAt(new Vec3(x, y, z), false)
        shapes = block ? pick.shapesOf(block) ?? [] : null
        blockShapes.set(key, shapes)
      }
      if (!shapes || shapes.some(shape => windSpreadTouches(from, velocity, cell, shape, end))) return false
    }
  }
  return true
}

function segment(bot: any, foe: any, feet: Point, from: Vec3, velocity: Vec3, age: number, owner?: string, tick = age, sight?: Map<any, boolean>,
  previousFeet?: Point, surface?: Vec3, eitherAllyPhase = false, previousBodies?: Map<any, Point>) {
  const origin = from.plus(velocity.scaled(age - 1)), length = velocity.norm(), direction = velocity.scaled(1 / length)
  if (windAboveWorld(bot, origin)) return { blocked: true }
  let unknown = false
  const world = { blockAt(p: Vec3) { const b = bot.blockAt(p, false); if (!b) unknown = true; return b } }
  const block = pick.blockOnRay(world, origin, direction, length)
  if (unknown) return { blocked: true }
  const box = foe.position ? pick.hitboxOf(bot, foe) : { w: foe.width, h: foe.height }
  const hit = bodyHit(origin, direction, length, feet, age, box.w, box.h, previousFeet)
  const blockFirst = block && (hit === null || block.t < hit)
  if (blockFirst && (!surface || !block.pos.equals(surface))) return { blocked: true }
  const terminal = blockFirst ? block.t : hit
  for (const entity of [bot.entity, ...Object.values(bot.entities || {})] as any[]) {
    if (entity === bot.entity && bot._ndWindOwnReported) continue
    if (!entity?.position || entity.id === foe.id || !!owner && (entity.username === owner || entity.id === bot.entity?.id && bot.entity?.username === owner) ||
        !(entity.username || entity.type === 'player' || entity.type === 'mob')) continue
    if (!entity._ndReportedAlly && entity !== bot.entity) {
      const visible = sight?.get(entity) ?? pick.canHit(bot, entity, { range: 64 })
      sight?.set(entity, visible)
      if (!visible) continue
    }
    if (age === 1 && entity._ndWindReceiptShape &&
        windSpreadTouches(from, velocity, [0, 0, 0], entity._ndWindReceiptShape, terminal === null ? 1 : terminal / length)) return { blocked: true }
    const position = entity._ndWindFrames ? entity._ndWindFrames[tick]?.pos : entity.position
    if (!position) return { blocked: true }
    if (age === 1 && entity._ndWindGliding) {
      // The modeled body may already cover the muzzle, while the preceding native phase still has an entering face.
      const prior = entity._ndWindFrames[tick - 1], current = entity._ndWindFrames[tick]
      const height = Math.fround(.6), half = Math.fround(.6) / 2
      const containsMuzzle = (p: Point) => Math.abs(origin.x - p.x) <= half && Math.abs(origin.z - p.z) <= half && origin.y >= p.y && origin.y <= p.y + height
      if (prior && current && !prior.onGround && !current.onGround && containsMuzzle(current.pos) && !containsMuzzle(prior.pos) && current.pos.minus(origin).dot(direction) > 0) return { blocked: true }
    }
    const previous = eitherAllyPhase ? entity._ndWindFrames?.[tick - 1]?.pos : previousBodies?.get(entity)
    const other = bodyHit(origin, direction, length, position, age, entity.width, entity.height, previous)
    if (other !== null && (terminal === null || other < terminal)) return { blocked: true }
  }
  if (blockFirst) return { blocked: true, surface: true }
  if (hit === null) return { blocked: false }
  return { blocked: false, burst: origin.plus(direction.scaled(hit)) }
}

/** Aimed entity hit, including gravity in the supplied native body frames; no invented air detonation point. */
export function enemyWindShot(bot: any, foe: any, report: WindReport, frames: Frame[], { fireDelay = 0, height = 1.4, allies = [] as WindReport[], tracks = new Map<WindReport, Frame[]>() } = {}, sight = new Map<any, boolean>(), deadline?: number, collision?: WindCollision): EnemyWindShot | null {
  if (expired(deadline) || !finite(report.position) || !finite(report.velocity) || report.launchMovement !== undefined && !finite(report.launchMovement) ||
      !frames.length || !Number.isSafeInteger(fireDelay) || fireDelay < 0) return null
  const box = foe.position ? pick.hitboxOf(bot, foe) : { w: foe.width, h: foe.height }
  if (collision) bot = { ...bot, blockAt: (p: Vec3) => collision.blockAt(p) }
  if (fireDelay) {
    const flight = collision ? bot : { ...bot, blockAt: observedCollision(bot).blockAt }
    const track = teamFrames(flight, report, tracks, deadline, fireDelay)
    if (!track) return null
    const { pos, vel, onGround } = track[fireDelay]
    report = { ...report, position: pos, velocity: vel, launchMovement: pos.minus(track[fireDelay - 1].pos), onGround }
  }
  const from = vec(report.position).offset(0, report.eyeHeight || 1.62, 0), moved = vec(report.launchMovement || report.velocity)
  if (report.onGround) moved.y = 0
  let flight = from.distanceTo(frames[Math.min(fireDelay, frames.length - 1)].pos) / WIND.speed, launch, aim: Vec3
  for (let iter = 0; iter < 4; iter++) {
    const at = frames[Math.min(frames.length - 1, fireDelay + Math.max(1, Math.ceil(flight)))]
    aim = at.pos.offset(0, Math.min(height, (box.h || 1.8) - .05), 0)
    launch = windLaunch(from, aim, moved); if (!launch) break
    flight = launch.time
  }
  let teamReady = false, teamFailed = false, why = 'none:miss'
  const checked = (aim: Vec3, launch: NonNullable<ReturnType<typeof windLaunch>>): EnemyWindShot | null => {
    // A straight charge must enter the target body before any world or allied collision can matter.
    const length = launch.velocity.norm(), direction = launch.velocity.scaled(1 / length)
    let contact = 0
    for (let age = 1; age < frames.length - fireDelay; age++) {
      if (expired(deadline)) return null
      if (bodyHit(from.plus(launch.velocity.scaled(age - 1)), direction, length, frames[fireDelay + age].pos, age, box.w, box.h) !== null) { contact = age; break }
    }
    if (!contact) return null
    // All alternative rays belong to this one snapshot and share its lazy native ally tracks.
    if (!teamReady) {
      teamReady = true
      if (allies.some(ally => typeof report.id !== 'string' || !report.id || ally.id !== report.id)) {
        const now = worldTick(bot)
        if (now === null) { teamFailed = true; return null }
        const team = allies.map(ally => {
          const at = windReportAt(bot, ally, now, deadline, collision)
          return at && ally.gameTick === now ? ally : at
        })
        if (team.some(ally => !ally)) { teamFailed = true; return null }
        const world = edges.worldOf(collision || observedCollision(bot))
        const prepared = teamWorld({ ...bot, blockAt: p => world.getBlock(p) }, team, tracks, deadline)
        if (!prepared) { teamFailed = true; return null }
        bot = prepared
      }
    }
    // Fair LOS is shared only inside this synchronous call, including alternative launch proposals.
    for (let age = 1; age <= contact; age++) {
      if (expired(deadline)) return null
      const at = frames[fireDelay + age], hit = segment(bot, foe, at.pos, from, launch.velocity, age, report.id, fireDelay + age, sight)
      if (hit.blocked) { why = 'none:blocked'; return null }
      if (hit.burst) return { thrower: report.id, fireDelay, ticks: age, from, aim, aimHeight: height, yaw: launch.yaw, pitch: launch.pitch,
        velocity: launch.velocity, burst: hit.burst, feet: at.pos.clone() }
    }
    return null
  }
  // Preserve an already valid ordinary proposal exactly; unreachable guesses are not proof of no interception.
  const ordinary = launch && checked(aim!, launch)
  if (ordinary) return ordinary
  let previousAim = aim
  for (let age = 1; age < frames.length - fireDelay; age++) {
    if (teamFailed || expired(deadline)) return null
    const aim = frames[fireDelay + age].pos.offset(0, Math.min(height, (box.h || 1.8) - .05), 0)
    if (previousAim?.equals(aim)) continue
    previousAim = aim
    const alternative = windLaunch(from, aim, moved)
    if (!alternative) continue
    const shot = checked(aim, alternative)
    if (shot) return shot
  }
  planTrace(why)
  return null
}

/** Forecast every affected ally's whole body; proximity alone is neither permission nor a veto. */
export function windTeamSafe(bot: any, allies: WindReport[], shots: Array<Pick<EnemyWindShot, 'ticks' | 'burst'> & { fireDelay?: number }>, arena?: WindArena, tracks = new Map<WindReport, Frame[]>(), requireLanding = false, deadline?: number): boolean {
  if (expired(deadline)) return false
  const horizon = Math.max(0, ...shots.map(shot => (shot.fireDelay || 0) + shot.ticks))
  if (!Number.isSafeInteger(horizon) || horizon > WIND_FORECAST_TICKS) return false
  const world = edges.worldOf(bot), simulate = edges.simOf(bot)
  const minimumImpulse = requireLanding ? 1e-9 : .01
  for (const ally of allies) {
    if (!finite(ally.position) || !finite(ally.velocity)) return false
    if (!shots.length) continue
    const proxy = { ...bot, entity: { attributes: ally.attributes || {} } }
    const track = teamFrames(bot, ally, tracks, deadline, horizon)
    if (!track) return false
    if (!shots.some(shot => {
      const at = track![(shot.fireDelay || 0) + shot.ticks]
      return at && windImpulse(proxy, at.pos, shot.burst, { eyeHeight: ally.eyeHeight || 1.62 }).norm() > minimumImpulse
    })) continue
    const state = bodyState(bot, ally)
    let affected = false, peak = state.pos.y, burstY = -Infinity, burstTick = -Infinity
    for (let tick = 1; tick <= 80; tick++) {
      if (expired(deadline)) return false
      simulate(state, world)
      for (const shot of shots) if (tick === (shot.fireDelay || 0) + shot.ticks) {
        const impulse = windImpulse(proxy, state.pos, shot.burst, { eyeHeight: ally.eyeHeight || 1.62 })
        if (impulse.norm() > minimumImpulse) { affected = true; state.vel = state.vel.plus(impulse); burstY = shot.burst.y; burstTick = tick }
      }
      peak = Math.max(peak, state.pos.y)
      if (!affected) continue
      if (!windInside(state.pos, arena) || state.isInLava) return false
      if (state.onGround && tick > burstTick) {
        const support = supportAt(bot, state.pos, .05)
        const fall = tick - burstTick <= WIND.forgivenessTicks ? Math.min(peak - state.pos.y, burstY - state.pos.y) : peak - state.pos.y
        if (!support || landingDamage(support.block, fall, ally.attributes) > 0) return false
      }
    }
    if (requireLanding && affected && !state.onGround && !state.isInWater) return false
  }
  return true
}

function teamFrames(bot: any, report: WindReport, tracks: Map<WindReport, Frame[]>, deadline?: number, horizon = WIND_FORECAST_TICKS): Frame[] | null {
  if (expired(deadline) || !Number.isSafeInteger(horizon) || horizon < 0 || horizon > WIND_FORECAST_TICKS) return null
  let frames = tracks.get(report)
  if (!frames) {
    const state = bodyState(bot, report)
    frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
    // This native state belongs only to the caller's synchronous snapshot/map, never the next release.
    Object.defineProperty(frames, 'nativeState', { value: state })
    tracks.set(report, frames)
  }
  if (frames.length > horizon) return frames
  const state = (frames as any).nativeState, world = edges.worldOf(bot), simulate = edges.simOf(bot)
  if (!state) { tracks.delete(report); return teamFrames(bot, report, tracks, deadline, horizon) }
  while (frames.length <= horizon) {
    if (expired(deadline)) { tracks.delete(report); return null }
    simulate(state, world); frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
  }
  return frames
}

function teamWorld(bot: any, team: WindReport[], tracks: Map<WindReport, Frame[]>, deadline?: number) {
  const entities = { ...bot.entities }, snapshot = { ...bot, entities, _ndWindOwnReported: team.some(ally => ally.id === bot.entity.username) }
  for (const ally of team) {
    const frames = teamFrames(snapshot, ally, tracks, deadline, 0)
    if (!frames) return null
    const lazy = new Proxy(frames, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) return teamFrames(snapshot, ally, tracks, deadline, Number(key))?.[Number(key)]
      return Reflect.get(target, key, receiver)
    } })
    const position = vec(ally.position), seen: Point & { ageTicks?: number } = ally.velocity
    const age = Math.min(20, seen.ageTicks ?? 0)
    let receiptShape: number[] | undefined
    if (!ally.onGround && age > 0 && (seen.x || seen.y || seen.z)) {
      // A delayed visible ally may have crossed the muzzle while this client still sees its old feet.
      // Cover the receipt-to-now displacement without assuming the ally continued on every axis.
      const half = Math.fround(.6) / 2, { x, y, z } = position, h = ally.gliding ? .6 : 1.8
      receiptShape = [x + Math.min(0, seen.x * age) - half, y + Math.min(0, seen.y * age), z + Math.min(0, seen.z * age) - half,
        x + Math.max(0, seen.x * age) + half, y + Math.max(0, seen.y * age) + h, z + Math.max(0, seen.z * age) + half]
    }
    entities[`wind:${ally.id}`] = { id: `wind:${ally.id}`, username: ally.id,
      type: 'player', position, width: .6, height: 1.8, _ndReportedAlly: true, _ndWindGliding: !!ally.gliding, _ndWindFrames: lazy, _ndWindReceiptShape: receiptShape }
  }
  return snapshot
}

type WindRay = Pick<EnemyWindShot, 'thrower' | 'fireDelay' | 'from' | 'velocity'>

function rollout(bot: any, foe: any, shots: WindRay[], arena: WindArena, resistance: number, accepted = 0, sight = new Map<any, boolean>(), deadline?: number, landingOnly = false, unknown?: { step?: number }, beforeMotion?: number) {
  if (expired(deadline)) return null
  const state = bodyState(bot, foe), simulate = edges.simOf(bot), known = edges.worldOf(bot)
  const frames: Frame[] = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
  const world = unknown ? { getBlock(p) {
    const block = known.getBlock(p)
    if (!block) unknown.step ??= frames.length
    return block
  } } : known
  const step = (body: typeof state) => {
    if (foe.groundAnchor && body.onGround && body.pos.equals(foe.position) && body.vel.equals(foe.velocity) && !groundDrive(body.control)) return
    simulate(body, world)
  }
  const done = new Set<number>(), meleeResist = edges.resistOf(bot, foe)
  const impacts: Array<{ fireDelay: number; ticks: number; burst: Vec3 }> = []
  // All candidates in one plan share its initial public direction; crossing the centre cannot turn an opposing gust into gain.
  const radius = (p: Point) => arena.ellipse ? Math.hypot((p.x - arena.x) / arena.ellipse.a, (p.z - arena.z) / arena.ellipse.b) * Math.min(arena.ellipse.a, arena.ellipse.b) : Math.max(Math.abs(p.x - arena.x), Math.abs(p.z - arena.z))
  const initial = radius(state.pos)
  const axis = foe.outward, scale = axis && arena.ellipse ? Math.min(arena.ellipse.a, arena.ellipse.b) * Math.hypot(axis.x / arena.ellipse.a, axis.z / arena.ellipse.b) : 1
  let outwardEffect: number | undefined = foe.keepObservedInput && !foe.protect && axis ? 0 : undefined
  let beforeImpact: ReturnType<typeof edges.stateOf> | null = null
  let endpointTick: number | null = !shots.length && state.onGround ? 0 : null
  let blockedBeforeLanding = false
  let out = false, exited = false, fallOut = false, outTick = null, lastHurt = -Infinity, burstTick = -Infinity, air = 0, landed = false, clear = Infinity, reach = Infinity
  let assessFall = foe.assessFall !== false && !!arena.ellipse && !foe.protect && !foe.gliding &&
    (shots.length === 1 || !shots.length && !state.onGround)
  let fallPeak = state.pos.y, impactFeetY = state.pos.y, fallDamage = 0
  const killY = arena.killY ?? -64
  const beforeMask = beforeMotion ?? 0
  const applyImpact = (i: number, tick: number) => {
    const shot = shots[i], age = tick - shot.fireDelay
    if (done.has(i) || age <= 0) return
    const hit = segment(bot, foe, state.pos, shot.from, shot.velocity, age, shot.thrower, tick, sight, undefined, undefined, beforeMotion !== undefined)
    if (hit.blocked) { done.add(i); return }
    if (!hit.burst) return
    // Price each hit group on its next body step, including a collision before this tick's movement.
    if (outwardEffect !== undefined && !beforeImpact) beforeImpact = edges.cloneState(state, state.control)
    done.add(i)
    impacts.push({ fireDelay: shot.fireDelay, ticks: age, burst: hit.burst })
    burstTick = tick
    impactFeetY = state.pos.y
    if (accepted & (1 << i) && tick - lastHurt >= 10) {
      state.vel = edges.knockback(state.vel, edges.KB_HIT * (1 - meleeResist), -shot.velocity.x, -shot.velocity.z, state.onGround)
      lastHurt = tick
    }
    const height = state.ndPoseHeight ?? foe.height ?? 1.8
    const eyeHeight = state.ndPoseHeight == null ? foe.eyeHeight : height === .6 ? .4 : height === 1.5 ? 1.27 : 1.62
    state.vel = state.vel.plus(windImpulse(bot, state.pos, hit.burst, { resistance, height, eyeHeight }))
  }
  for (let tick = 1; tick <= WIND_FORECAST_TICKS; tick++) {
    if (expired(deadline)) return null
    // The victim can steer back towards the arena: do not price an AFK trajectory as an unavoidable kill.
    // reactAfterHit: he cannot see the charge coming — until the first burst he keeps his own (unknown → no) input.
    // Летящий правит взглядом, а не бегом к центру: держит свой курс (взгляд в прогнозе не меняем).
    if (foe.gliding) state.control = { ...edges.IDLE }
    else if (!foe.keepObservedInput && (!foe.reactAfterHit || impacts.length)) {
      state.yaw = Math.atan2(state.pos.x - arena.x, state.pos.z - arena.z)
      state.control = { ...edges.IDLE, forward: true, sprint: true }
    } else if (foe.run) { state.yaw = foe.run.yaw; state.control = { ...edges.IDLE, ...foe.run.control } }
    else state.control = { ...edges.IDLE }
    if (beforeMask) for (let i = 0; i < shots.length; i++) if (beforeMask & (1 << i)) applyImpact(i, tick)
    const without = beforeImpact && edges.cloneState(beforeImpact, state.control)
    if (without) without.yaw = state.yaw
    const rising = state.vel.y > 0
    step(state)
    if (endpointTick === null && (state.isCollidedHorizontally || rising && state.isCollidedVertically)) blockedBeforeLanding = true
    if (without) {
      if (expired(deadline)) return null
      step(without)
      if (expired(deadline)) return null
      outwardEffect! += state.pos.minus(without.pos).dot(axis) * scale
      beforeImpact = null
    }
    for (let i = 0; i < shots.length; i++) if (!(beforeMask & (1 << i))) applyImpact(i, tick)
    frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
    // Отвод таранщика (foe.protect — глаза своих): ближе всего его тело к своим за 20 т. — достанет ли копьё.
    if (foe.protect && (foe.gliding ? tick <= 20 : !landed)) for (const q of foe.protect) {
      const d = state.pos.offset(0, .3, 0).distanceTo(q); clear = Math.min(clear, d)
      // Первый тик, когда его копьё достаёт (wind-out CONTACT = 3.5): отложенный удар — время на щит (5 т.) и встречное копьё.
      if (d < 3.5 && reach === Infinity) reach = tick
    }
    // Air time until the first landing: how long the swarm can keep juggling him.
    if (!landed && state.onGround) landed = true; else if (!landed) air++
    if (assessFall) {
      if (state.isInWater || state.isInLava || state.isOnLadder) fallPeak = state.pos.y
      fallPeak = Math.max(fallPeak, state.pos.y)
      if (state.onGround) {
        if (!shots.length || impacts.length && tick > burstTick && done.size === shots.length) {
          assessFall = false
          const drop = fallPeak - state.pos.y
          if (drop > 3 && !state.isInWater && !state.isInLava) {
            const support = supportAt(bot, state.pos, .05)
            if (support) {
              const damage = windFallDamage(support.block, drop, state.pos.y, shots.length ? impactFeetY : undefined, {
                equipment: foe.equipment || [], unknownArmorSlots: foe._ndUnknownArmorSlots,
                gliding: foe.gliding, ordinaryFall: foe.ordinaryFall !== false
              })
              if (damage && !damage.visibleTotem) fallDamage = damage.lower
            }
          }
        }
        fallPeak = state.pos.y
      }
    }
    if (endpointTick === null && state.onGround && (!shots.length || impacts.length && tick > burstTick && done.size === shots.length)) endpointTick = tick
    if (windOutside(arena, state.pos, foe.width)) {
      exited = true
      fallOut ||= state.pos.y < killY
      if (!arena.ellipse || state.onGround || state.pos.y < killY) {
        endpointTick ??= tick
        if (!out) { out = true; outTick = tick }
      }
    } else if (arena.ellipse && out && !fallOut) {
      // A living target can run back from an exterior ledge before the forecast ends.
      out = false; outTick = null
    }
    // An interior fall ends the forecast. Only legacy square arenas count a hole as an exit.
    if (state.pos.y < killY - 1) {
      if (!arena.ellipse && !out) { out = true; outTick = tick }
      break
    }
    if (landingOnly && endpointTick !== null) break
  }
  if (beforeImpact && state.pos.y >= killY - 1) {
    // A legal final-tick hit has no next movement in frames; price just that step, without extending the shot horizon.
    if (expired(deadline)) return null
    const actual = edges.cloneState(state, state.control), without = edges.cloneState(beforeImpact, state.control)
    without.yaw = actual.yaw
    step(actual)
    if (expired(deadline)) return null
    step(without)
    if (expired(deadline)) return null
    outwardEffect! += actual.pos.minus(without.pos).dot(axis) * scale
  }
  endpointTick ??= frames.length - 1
  const position = frames[endpointTick].pos.clone(), progress = axis ? position.minus(foe.position).dot(axis) * scale : radius(position) - initial
  return { frames, impacts, progress, out, exited, ticks: outTick, position, air, clear, reach, outwardEffect, endpointTick, fallDamage, blockedBeforeLanding }
}

type WindRun = NonNullable<ReturnType<typeof rollout>>

const windOutcome = (r: WindRun) => ({ out: r.out, exited: r.exited, progress: r.progress, ticks: r.ticks, position: r.position,
  air: r.air, clear: r.clear, reach: r.reach, outwardEffect: r.outwardEffect, fallDamage: r.fallDamage })

interface EnemyWindPlan {
  target: string; targetAt: Vec3; gameTick: number; resistance: ReturnType<typeof windResistance>; tried: number
  fallThreat: boolean; repriceRim: boolean; earlyLift: boolean; lateLift: boolean; relayPrefix?: number; releaseSafeKey?: string
  shots: EnemyWindShot[]; baseline: ReturnType<typeof windOutcome>; nominal: ReturnType<typeof windOutcome>; worst: ReturnType<typeof windOutcome>
}

export function windImpactKey({ fireDelay, ticks, burst }: WindRun['impacts'][number]) {
  return `${fireDelay + ticks},${burst.x},${burst.y},${burst.z}`
}

function bounds(bot: any, foe: any, shots: EnemyWindShot[], arena: WindArena, resistance: number,
  team?: WindReport[], tracks?: Map<WindReport, Frame[]>, sight = new Map<any, boolean>(), deadline?: number,
  compare?: (a: WindRun, b: WindRun) => number, worthCertifying?: (run: WindRun) => boolean, safeImpacts?: Set<string>) {
  let worst: ReturnType<typeof rollout> = null
  for (let mask = 0; mask < 1 << shots.length; mask++) {
    const run = rollout(bot, foe, shots, arena, resistance, mask, sight, deadline)
    if (!run || worthCertifying && !worthCertifying(run)) return null
    if (team) {
      const key = safeImpacts && run.impacts.map(windImpactKey).join(';')
      if (key !== undefined && safeImpacts?.has(key)) {
        if (expired(deadline)) return null
      } else {
        if (!windTeamSafe(bot, team, run.impacts, arena, tracks, false, deadline)) return null
        if (key !== undefined) safeImpacts?.add(key)
      }
    }
    if (!worst || (compare ? compare(run, worst) < 0 : foe.protect ? run.clear < worst.clear : Number(run.out) < Number(worst.out) || run.out === worst.out && run.progress < worst.progress)) worst = run
  }
  return worst
}

type AirDrive = { yaw: number; lookYaw: number; control: typeof edges.IDLE }
type CoastReceipt = { previous: any; current: any; delta: number | null; velocity: Vec3 | null; life: any; observer: any; gust?: number; epoch?: number; handedOff?: boolean; drive?: AirDrive; turnRevision?: number }
const coastVelocities = new WeakMap<object, CoastReceipt>()
const sprintVelocities = new WeakMap<object, CoastReceipt>()
function coastTravel(velocity: number, ticks: number, drag: number, minimum: number, gravity = 0, acceleration = 0) {
  let displacement = 0
  for (let i = 0; i < ticks; i++) {
    if (Math.abs(velocity) < minimum) velocity = 0
    velocity += acceleration
    displacement += velocity; velocity = (velocity - gravity) * drag
  }
  return { displacement, velocity }
}
/** LivingEntity.aiStep zeroes small vertical motion before travel, including a whole stationary apex tick. */
function coastTicks(bot: any, previous: number, current: number) {
  const { gravity, airdrag, negligeableVelocity } = bot.physics
  if (![gravity, airdrag, negligeableVelocity, previous, current].every(Number.isFinite) ||
      gravity <= 0 || airdrag <= 0 || airdrag >= 1 || negligeableVelocity < 0) return null
  const run = (velocity: number, ticks: number) => coastTravel(velocity, ticks, airdrag, negligeableVelocity, gravity)
  const quantum = 1 / 4096
  let count: number | null = null, firstCount: number | null = null
  for (let first = 1; first <= 10; first++) {
    const span = Math.abs(previous) + gravity * first * first + negligeableVelocity
    const inverse = (value: number, upper: boolean) => {
      let lo = -span, hi = span
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2, delta = run(mid, first).displacement
        if (upper ? delta <= value : delta < value) lo = mid; else hi = mid
      }
      return run(upper ? lo : hi, first)
    }
    const lo = inverse(previous - quantum, false), hi = inverse(previous + quantum, true)
    if (lo.displacement > previous + quantum || hi.displacement < previous - quantum) continue
    for (let last = 1; last <= 10; last++) {
      if (run(lo.velocity, last).displacement > current + quantum || run(hi.velocity, last).displacement < current - quantum) continue
      if (count !== null && count !== last) return null
      if (count === null) firstCount = first
      else if (firstCount !== first) firstCount = null
      count = last
    }
  }
  return count === null ? null : { first: firstCount, last: count }
}

/** Invert native clipped travel inside the two position packets' quantization interval. */
function coastAxis(bot: any, axis: string, delta: number, ticks: number, acceleration = 0): number | null {
  const quantum = 1 / 4096, gravity = axis === 'y' ? bot.physics.gravity : 0
  const drag = axis === 'y' ? bot.physics.airdrag : bot.physics.airborneInertia, minimum = bot.physics.negligeableVelocity
  if (![gravity, drag, minimum].every(Number.isFinite) || drag <= 0 || drag >= 1 || minimum < 0) return null
  const run = (start: number) => ({ start, ...coastTravel(start, ticks, drag, minimum, gravity, acceleration) })
  const span = Math.abs(delta) + (gravity + Math.abs(acceleration)) * ticks * ticks + minimum + quantum
  const inverse = (value: number, upper: boolean) => {
    let lo = -span, hi = span
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2, displacement = run(mid).displacement
      if (upper ? displacement <= value : displacement < value) lo = mid; else hi = mid
    }
    return run(upper ? lo : hi)
  }
  const lo = inverse(delta - quantum, false), hi = inverse(delta + quantum, true)
  if (lo.start > hi.start || lo.displacement > delta + quantum || hi.displacement < delta - quantum) return null
  // Continuous travel's endpoint uncertainty cannot exceed the two packets' velocity envelope.
  // A larger jump straddles a native reset branch with materially different future motion.
  if (hi.velocity - lo.velocity > 2 * quantum) return null
  return (lo.start + hi.start) / 2
}

function observedAirTurn(raw: any, earlier: any, previous: any, current: any): number | null {
  if (raw._ndGlideBoosted || raw.yaw !== current.yaw || (raw._ndGlideRevision ?? 0) !== (current.revision ?? 0) ||
      ![earlier, previous, current].every(r => r && /^(rel_entity_move|entity_move_look)$/.test(r.kind) &&
        !r.grounded && !r.flying && !r.boosted && Number.isFinite(r.yaw) && r.pitch === current.pitch)) return null
  const turn = (a, b) => {
    const angle = b.yaw - a.yaw
    if (!angle) return a.revision === b.revision ? 0 : null
    // A single combined move+look update accounts for the revision without bridging a pose or boost change.
    if (b.kind !== 'entity_move_look' || !Number.isSafeInteger(a.revision) || b.revision !== a.revision + 1) return null
    return Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)))
  }
  const first = turn(earlier, previous), last = turn(previous, current)
  return first !== null && last !== null && first + last > 0 ? Math.max(first, last) : null
}

/** Fit a vanilla non-sprint input only when two physically timed visible intervals distinguish it from coasting. */
function airDrive(bot: any, earlier: any, previous: any, current: any, first: number, last: number, turn = 0, sprint = false) {
  const { airborneInertia, airborneAcceleration, negligeableVelocity } = bot.physics
  if (![airborneInertia, airborneAcceleration, negligeableVelocity].every(Number.isFinite) || airborneAcceleration <= 0) return
  const lookYaw = current.yaw, angleStep = 2 * Math.PI / 256, quantum = 1 / 4096, ticks = first + last
  const before = vec(previous).minus(vec(earlier)), delta = vec(current).minus(vec(previous))
  const y = coastAxis(bot, 'y', before.y, first), vy = coastAxis(bot, 'y', delta.y, last)
  if (y === null || vy === null) return
  let selected: { drive: AirDrive; initial: Vec3; latest: Vec3; firstYaw: number; tolerance: number } | undefined
  for (const [forward, right] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    // 1.21.11 travel uses .98 digital controls, normalized for a diagonal. Entity look packets carry one byte per angle.
    const norm = Math.hypot(forward, right), scale = airborneAcceleration * (sprint ? 1.3 : 1) * .98 / Math.max(1, .98 * norm)
    // The position receipts bound the observed turn, not the exact tick at which the player turned.
    const tolerance = 2 * quantum + norm * scale * (angleStep + turn) * ticks * (ticks + 1) / 2
    const fit = (yaw: number) => {
      const firstYaw = turn ? previous.yaw + (yaw - lookYaw) : yaw
      const push = (angle: number) => [(-forward * Math.sin(angle) + right * Math.cos(angle)) * scale,
        (-forward * Math.cos(angle) - right * Math.sin(angle)) * scale]
      const [ax, az] = push(yaw), [firstX, firstZ] = firstYaw === yaw ? [ax, az] : push(firstYaw)
      const match = (axis: 'x' | 'z', a: number, next: number) => {
        const v = coastAxis(bot, axis, before[axis], first, a)
        if (v === null) return null
        const end = coastTravel(v, first, airborneInertia, negligeableVelocity, 0, a).velocity
        const predicted = coastTravel(end, last, airborneInertia, negligeableVelocity, 0, next).displacement
        return Math.abs(predicted - delta[axis]) <= tolerance ? v : null
      }
      const x = match('x', firstX, ax); if (x === null) return
      const z = match('z', firstZ, az); if (z === null) return
      const vx = coastAxis(bot, 'x', delta.x, last, ax), vz = coastAxis(bot, 'z', delta.z, last, az)
      if (vx === null || vz === null) return
      return { drive: { yaw, lookYaw, control: { ...edges.IDLE, forward: forward > 0, back: forward < 0, right: right > 0, left: right < 0, sprint } },
        initial: new Vec3(x, y, z), latest: new Vec3(vx, vy, vz), firstYaw, tolerance }
    }
    // At the velocity reset threshold a half angle byte can change whether a component is clipped.
    const candidate = fit(lookYaw) ?? (norm ? fit(lookYaw - angleStep / 2) ?? fit(lookYaw + angleStep / 2) : undefined)
    if (!candidate) continue
    if (!norm || selected) return // Idle or another native input is also compatible with these receipts.
    selected = candidate
  }
  return selected
}
/** Fit the already chosen IDLE model to visible positions; unobserved air inputs remain a forecast uncertainty. */
function coastVelocity(bot: any, raw: any, body: any, collision?: WindCollision, sprint = false): Vec3 | null | undefined {
  const cache = sprint ? sprintVelocities : coastVelocities
  if (raw._ndVisible !== true) { cache.delete(raw); return } // Raw history can include positions received behind a wall.
  const [previous, current] = raw._ndPositionReceipts || []
  const relative = r => r.kind === 'rel_entity_move' || r.kind === 'entity_move_look'
  if (!previous || !current || !(relative(previous) || !sprint && previous.kind === 'reacquired') || !relative(current) ||
      previous.grounded || current.grounded || current.t < previous.t || current.t - previous.t > 10 * 50 || !finite(previous) || !finite(current)) {
    cache.delete(raw); return null
  }
  const life = bot.players?.[raw.username]?.entity || raw, tracking = windObservations.get(bot)
  const affected = tracking?.affected.get(raw.id), impulse = sprint && tracking?.velocities.get(life)
  const gustAt = affected?.raw === life ? affected.at : undefined
  const gust = sprint ? Math.max(gustAt === undefined ? -Infinity : affected?.motionAt ?? gustAt,
    impulse && impulse.observer === bot.entity && impulse.clock === bot.ndClock ? impulse.at : -Infinity) : gustAt
  const old = cache.get(raw)
  const epoch = raw._ndMotionEpoch
  const cached = old?.life === life && old.observer === bot.entity && old.gust === gust && old.epoch === epoch ? old : undefined
  if (cached?.previous === previous && cached.current === current &&
      (cached.turnRevision === undefined || cached.turnRevision === raw._ndGlideRevision)) return cached.velocity
  const delta = current.y - previous.y
  const entry: CoastReceipt = { previous, current, delta, velocity: null, life, observer: bot.entity, gust, epoch }
  cache.set(raw, entry)
  // Packet receive time can compress unequal native intervals into one JS turn. Only two compatible displacements
  // identify the last count; an ambiguous/new phase must not become a confident pre/post-impulse average.
  let before = cached?.current === previous ? cached.delta : null
  let earlier = before !== null ? cached?.previous : undefined
  const received = raw._ndEarlierPositionReceipt
  let receivedTurn: number | null = null
  if (before === null && Number.isSafeInteger(epoch) && finite(received) && relative(received) && relative(previous) &&
      !received.grounded && !received.flying && !previous.flying && !current.flying &&
      received.t <= previous.t && previous.t - received.t <= 10 * 50 && (gust === undefined || received.t > gust)) {
    const samePhase = received.revision === previous.revision && previous.revision === current.revision &&
      (raw._ndGlideRevision ?? 0) === (current.revision ?? 0)
    if (!samePhase) receivedTurn = observedAirTurn(raw, received, previous, current)
    if (samePhase || receivedTurn !== null) { earlier = received; before = previous.y - received.y }
  }
  if (before === null && Number.isSafeInteger(epoch) && cached?.delta != null && relative(cached.current) && relative(previous) &&
      !cached.current.grounded && !cached.current.flying && !previous.flying && !current.flying &&
      cached.current.t < previous.t && previous.t - cached.current.t <= 10 * 50 &&
      cached.current.revision === previous.revision && previous.revision === current.revision) {
    const bridge = previous.y - cached.current.y
    if (coastTicks(bot, cached.delta, bridge) !== null) { before = bridge; earlier = cached.current }
  }
  const timing = before !== null ? coastTicks(bot, before, delta) : null
  if (!timing) return null
  const ticks = timing.last
  const known = edges.worldOf(collision || observedCollision(bot)), simulate = edges.simOf(bot)
  let unknown = false, collided = false
  const world = { getBlock(p) { const block = known.getBlock(p); if (!block) unknown = true; return block } }
  const run = (velocity: Vec3, position = previous, count = ticks, drive?: AirDrive) => {
    unknown = collided = false
    const state = bodyState(bot, { ...body, ...drive, position, velocity })
    for (let tick = 0; tick < count; tick++) {
      simulate(state, world)
      if (unknown || state.onGround || state.isInWater || state.isInLava) return null
      if (state.isCollidedHorizontally || state.isCollidedVertically) { collided = true; return null }
    }
    return state
  }
  if (timing.first !== null && body.ordinaryFall && body.height === 1.8 && Number.isSafeInteger(epoch) && finite(earlier) && (!sprint || relative(earlier)) &&
      !earlier.grounded && !earlier.flying && !previous.flying && !current.flying && Number.isFinite(current.yaw) &&
      (gust === undefined || earlier.t > gust)) {
    const sameLook = earlier.yaw === current.yaw && previous.yaw === current.yaw &&
      (!sprint || earlier.revision === current.revision && previous.revision === current.revision)
    const turn = sameLook ? 0 : receivedTurn ?? observedAirTurn(raw, earlier, previous, current)
    if (turn !== null && (!sprint || turn <= 2 * Math.PI / 256 + 1e-12 && current.revision - earlier.revision <= 1)) {
      const fitted = airDrive(bot, earlier, previous, current, timing.first, ticks, turn, sprint)
      const leading = fitted && run(fitted.initial, earlier, timing.first, { ...fitted.drive, yaw: fitted.firstYaw })
      if (fitted && leading && leading.vel.distanceTo(fitted.latest) <= fitted.tolerance && leading.pos.distanceTo(vec(previous)) <= fitted.tolerance) {
        const trailing = run(fitted.latest, previous, ticks, fitted.drive)
        if (trailing && trailing.pos.distanceTo(vec(current)) <= fitted.tolerance) {
          entry.drive = fitted.drive
          if (turn) entry.turnRevision = current.revision
          return entry.velocity = trailing.vel.clone()
        }
      }
    }
  }
  if (sprint) return // Keep the prior estimate unless the sprint input fits both observed intervals.
  const noncoast = () => { entry.delta = null; return null }
  if (receivedTurn !== null) return noncoast() // The cross-revision receipt was usable only for a uniquely fitted turn.
  const zero = run(new Vec3(0, 0, 0))
  if (!zero) return noncoast()
  const velocity = new Vec3(0, 0, 0)
  let wallProbe = false
  for (const axis of ['x', 'y', 'z'] as const) {
    const unit = new Vec3(0, 0, 0); unit[axis] = 1
    const trial = run(unit), response = trial && trial.pos[axis] - zero.pos[axis]
    if (!response) {
      if (!collided || !Number.isSafeInteger(epoch)) return noncoast()
      wallProbe = true
      break
    }
    velocity[axis] = (current[axis] - zero.pos[axis]) / response
  }
  let fitted = wallProbe ? null : run(velocity)
  if (!wallProbe && !fitted) return noncoast()
  // A nearby obstacle can block an artificial unit probe without touching the measured path.
  if (!fitted || fitted.pos.distanceTo(vec(current)) > 1e-6) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = coastAxis(bot, axis, current[axis] - previous[axis], ticks)
      if (value === null) return noncoast()
      velocity[axis] = value
    }
    fitted = run(velocity)
    if (!fitted || ['x', 'y', 'z'].some(axis => Math.abs(fitted!.pos[axis] - current[axis]) >
      1 / 4096 + Number.EPSILON * Math.max(1, Math.abs(current[axis])) * 8)) return noncoast()
  }
  return entry.velocity = fitted.vel.clone()
}

const groundMotion = new WeakMap<object, {
  current: any; life: any; observer: any; epoch: number; gust?: number; velocity: Vec3; control: typeof edges.IDLE
}>()
const groundDrive = (control?: typeof edges.IDLE) => control?.forward || control?.back || control?.left || control?.right || control?.jump

/** Carry the fitted air motion through a matching first contact or its next supported step. */
function firstGroundMotion(bot: any, raw: any, body: any, previous: any, current: any, gust?: number, collision?: WindCollision) {
  const cached = coastVelocities.get(raw), life = bot.players?.[raw.username]?.entity || raw, epoch = raw._ndMotionEpoch
  if (!cached?.velocity || cached.current !== previous || cached.life !== life || cached.observer !== bot.entity ||
      cached.gust !== gust || cached.epoch !== epoch - 1 || !finite(current) ||
      !(current.t >= previous.t && current.t - previous.t <= 10 * 50) ||
      !(cached.velocity.y < 0 && previous.y > current.y)) return
  const control = cached.drive?.control ?? edges.IDLE
  const yaw = cached.drive ? cached.drive.yaw + (raw.yaw - cached.drive.lookYaw) : raw.yaw
  if (!Number.isFinite(yaw)) return
  const state = bodyState(bot, { ...body, position: previous, velocity: cached.velocity, onGround: false, control, yaw })
  const known = edges.worldOf(collision || observedCollision(bot)), simulate = edges.simOf(bot)
  let unknown = false
  const world = { getBlock(p) {
    const block = known.getBlock(p)
    if (!block) unknown = true
    return block
  } }
  const quantum = 1 / 4096, tolerance = 2 * quantum
  const coasting = !cached.drive && body.ordinaryFall && body.height === 1.8
  const receivedTicks = Math.round((current.t - previous.t) / 50)
  const supportWorld = { blockAt: (p: Vec3) => known.getBlock(p) }
  let firstSupport: ReturnType<typeof supportAt> = null
  // One position quantum plus the velocity quantum propagated through each native step.
  let horizontal = quantum, drift = quantum
  for (let tick = 0; tick < 10; tick++) {
    simulate(state, world)
    if (unknown || state.isInWater || state.isInLava || state.isCollidedHorizontally || state.pos.y < current.y - tolerance) return
    if (coasting) { drift *= bot.physics.airborneInertia; horizontal += drift }
    if (firstSupport && !state.onGround) return
    if (!state.onGround) continue
    if (Math.abs(state.pos.y - current.y) > tolerance) return
    const limit = Math.max(tolerance, horizontal)
    if (Math.abs(state.pos.x - current.x) > limit || Math.abs(state.pos.z - current.z) > limit) {
      if (firstSupport || !coasting || receivedTicks !== tick + 2) return
      // Friction uses the block below the center, even when the hull is supported by its neighbor.
      if (Math.floor(state.pos.x - limit) !== Math.floor(state.pos.x + limit) ||
          Math.floor(state.pos.z - limit) !== Math.floor(state.pos.z + limit)) return
      firstSupport = supportAt(supportWorld, state.pos, .01)
      if (!firstSupport) return
      continue
    }
    if (firstSupport) {
      const support = supportAt(supportWorld, state.pos, .01)
      if (!support || support.block.name !== firstSupport.block.name ||
          (['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const).some(axis => support.box[axis] !== firstSupport.box[axis])) return
    }
    const result = { current, life, observer: bot.entity, epoch, gust, velocity: state.vel.clone(), control }
    groundMotion.set(raw, result)
    return result
  }
}

/** Recover ground momentum and the latest input independently, using the native support's travel response. */
function groundInput(bot: any, raw: any, body: any, sprint: boolean, gust?: number, collision?: WindCollision) {
  const [previous, current] = raw._ndPositionReceipts || [], epoch = raw._ndMotionEpoch
  if (raw._ndVisible !== true || !Number.isSafeInteger(epoch) || !current?.grounded) return
  const life = bot.players?.[raw.username]?.entity || raw, entry = groundMotion.get(raw)
  const old = entry?.life === life && entry.observer === bot.entity && entry.epoch === epoch && entry.gust === gust ? entry : undefined
  if (!previous?.grounded && (!previous || current.kind !== 'sync_entity_position' || previous.flying || current.flying ||
      previous.boosted || current.boosted || raw._ndGlideBoosted || current.revision !== previous.revision ||
      (raw._ndGlideRevision ?? 0) !== (current.revision ?? 0))) return
  if (old?.current === current) return { ...old, control: { ...old.control, sprint } }
  if (!previous?.grounded) return firstGroundMotion(bot, raw, body, previous, current, gust, collision)
  const relative = r => /^(rel_entity_move|entity_move_look)$/.test(r?.kind)
  const sneak = body.height === 1.5, yaw = raw.yaw
  const vertical = -bot.physics.gravity * bot.physics.airdrag || 0
  const control = (f: number, s: number) => ({ ...edges.IDLE, forward: f > 0, back: f < 0, right: s > 0, left: s < 0, sprint, sneak })
  const idle = { velocity: new Vec3(0, vertical, 0), control: control(0, 0) }
  const elapsed = current?.t - previous?.t
  if (!relative(current) || !finite(previous) || !finite(current) || !(elapsed >= 0 && elapsed <= 500)) return
  const delta = new Vec3(current.x - previous.x, 0, current.z - previous.z)
  let ticks = Math.max(1, Math.round(elapsed / 50))
  const forward = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)), right = new Vec3(Math.cos(yaw), 0, -Math.sin(yaw))
  const axes = (input: Vec3, minimum: number): [number, number] => {
    if (input.norm() <= minimum || !Number.isFinite(yaw)) return [0, 0]
    const angle = Math.round(Math.atan2(input.dot(right), input.dot(forward)) / (Math.PI / 4)) * Math.PI / 4
    return [Math.round(Math.cos(angle)), Math.round(Math.sin(angle))]
  }
  // A relative position cannot take a fraction of a native tick, even if both packets arrive in the same JS batch.
  const continuous = relative(previous) || previous.kind === 'reacquired'
  const fallback = { velocity: delta.scaled(1 / ticks).offset(0, vertical, 0), control: continuous ? control(...axes(delta, 1 / 4096)) : idle.control }
  if (!continuous || !Number.isFinite(yaw) || previous.y !== current.y) return fallback
  const world = edges.worldOf(collision || observedCollision(bot))
  const support = world.getBlock(vec(previous).offset(0, -.5, 0)), endSupport = world.getBlock(vec(current).offset(0, -.5, 0))
  if (!support || !endSupport || support.type !== endSupport.type) return fallback
  const probe = bodyState(bot, { ...body, position: previous, velocity: right.scaled(.05).offset(0, vertical, 0),
    yaw, control: { forward: true, sprint, sneak } })
  edges.simOf(bot)(probe, world)
  const moved = probe.pos.minus(vec(previous)), drag = probe.vel.dot(right) / moved.dot(right), acceleration = moved.dot(forward)
  if (!probe.onGround || probe.isCollidedHorizontally || probe.isInWater || probe.isInLava ||
      !(drag > 0 && drag < 1 && acceleration > 0)) return fallback

  const prior = old?.current === previous ? old : undefined
  const strength = .98 * (sneak ? bot.physics.sneakSpeed : 1)
  const force = (f: number, s: number) => forward.scaled(f).plus(right.scaled(s)).scaled(acceleration / Math.max(1, strength * Math.hypot(f, s)))
  const interval = (n: number) => {
    const decay = drag ** n, travel = (1 - decay) / (1 - drag)
    return { decay, travel, drive: (n - drag * travel) / (1 - drag) }
  }
  const priorForce = prior && force(Number(prior.control.forward) - Number(prior.control.back), Number(prior.control.right) - Number(prior.control.left))
  if (prior && priorForce && prior.control.sprint === sprint && prior.control.sneak === sneak && previous.yaw === yaw) {
    // A steady native trajectory can resolve a compressed two-tick receipt without reading private input.
    for (const n of [ticks - 1, ticks + 1]) if (n >= 1 && n <= 10) {
      const { travel, drive } = interval(n)
      const expected = prior.velocity.scaled(travel).plus(priorForce.scaled(drive))
      if (Math.hypot(delta.x - expected.x, delta.z - expected.z) <= 2 / 4096) { ticks = n; break }
    }
  }
  const { decay, travel, drive } = interval(ticks)
  const input = prior ? delta.minus(prior.velocity.scaled(travel)).scaled(1 / drive) : delta
  input.y = 0
  const [f, s] = axes(input, prior ? acceleration / 2 : 1 / 4096)
  let applied = force(f, s), inputControl = control(f, s)
  if (prior && priorForce && prior.control.sprint === sprint && applied.distanceTo(input) > acceleration / 2) {
    // An impulse can exceed the native input envelope. Keep the prior input hypothesis and recover its momentum from the displacement.
    applied = priorForce; inputControl = { ...prior.control, sneak }
  }
  const velocity = delta.minus(applied.scaled(drive)).scaled(decay / travel).plus(applied.scaled(drag * travel))
  velocity.y = probe.vel.y
  const result = { current, life, observer: bot.entity, epoch, gust, velocity, control: inputControl }
  groundMotion.set(raw, result)
  return result
}

const FIRST_GROUND_OBSERVATION_MS = 3 * 50

function firstGroundObservationExpired(raw: any, at?: number) {
  const [previous, current] = raw._ndPositionReceipts || []
  return raw._ndVisible === true && current?.grounded && current.kind === 'sync_entity_position' &&
    previous?.grounded === false && /^(rel_entity_move|entity_move_look)$/.test(previous.kind) && current.t > previous.t &&
    Math.max(Math.abs(current.x - previous.x), Math.abs(current.z - previous.z)) > 1 / 4096 &&
    (at ?? raw._ndObservationNow?.()) - current.t >= FIRST_GROUND_OBSERVATION_MS
}

/** Recheck only the existing first-landing observation window after synchronous release pricing. */
export function windGroundObservationExpired(bot: any, raw: any, receiptAt: number, at?: number): boolean {
  const observedAt = at ?? raw._ndObservationNow?.()
  if (!(observedAt - receiptAt >= FIRST_GROUND_OBSERVATION_MS)) return false
  const fair = raw._ndVisible === undefined ? windObservations.get(bot)?.sight.observe(raw) : raw
  return !!fair && !require('../elytra/track').gliding(fair) && firstGroundObservationExpired(fair, observedAt)
}

function enemyView(bot: any, raw: any, collision?: WindCollision) {
  const tracking = windObservations.get(bot), sight = tracking?.sight
  if (raw._ndVisible === undefined && sight) raw = sight.observe(raw) || raw
  const life = bot.players?.[raw.username]?.entity
  const affected = tracking?.affected.get(raw.id), receipts = raw._ndPositionReceipts, [previous, current] = receipts || []
  if (affected && affected.raw === life && !windMotionObserved(affected, receipts)) return null
  if (raw._ndVisible === true && current?.grounded) {
    const before = current.kind === 'sync_entity_position' ? previous :
      previous?.grounded && previous.kind === 'sync_entity_position' ? raw._ndEarlierPositionReceipt : null
    const impulse = life && tracking?.velocities.get(life), coast = coastVelocities.get(raw)
    if (before?.grounded === false && impulse?.observer === bot.entity && impulse.clock === bot.ndClock &&
        impulse.at >= (coast?.current === before ? coast.previous.t : before.t)) {
      groundMotion.delete(raw)
      return null
    }
  }
  const metadata: any[] = []; metadata[0] = raw.metadata?.[0]; metadata[8] = raw.metadata?.[8]
  const gear = raw._ndVisible === undefined ? observePlayerGear(bot, raw) : null
  // Скорость — по наблюдённым позициям (bow/track): сырой entity.velocity чужого игрока — из редких entity_velocity и
  // живёт, пока не придёт новый (стенд 24.10: сырая 0.49 вверх, на деле −0.17 — ждали ноги на 129.2, он был на 124;
  // заряды по летящему не попадали ни разу).
  const observation: typeof import('../bow/track') = require('../bow/track')
  const observedV = observation.observedVelocity(raw)
  const velocity = vec(observedV || raw.velocity || { x: 0, y: 0, z: 0 }), h = Math.hypot(velocity.x, velocity.z)
  const sprint = !!(metadata[0] & 8)
  // Airborne sprint follows visible look: gust momentum can point opposite to the existing forward-input model.
  let run = (raw.onGround ? h > .12 : sprint) ? {
    yaw: !raw.onGround && Number.isFinite(raw.yaw) ? raw.yaw : Math.atan2(-velocity.x, -velocity.z),
    control: { ...edges.IDLE, forward: true, sprint: sprint || raw._ndVisible === undefined && metadata[0] == null && h > .12 }
  } : null
  const box = pick.hitboxOf(bot, raw)
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys || []
  const particles = raw.metadata?.[keys.indexOf('effect_particles')]
  const ordinaryFall = !raw.metadata?.[keys.indexOf('no_gravity')] && !(Array.isArray(particles) ? particles.length : particles)
  const view = { id: raw.id, username: raw.username, position: vec(raw.position), velocity, run, groundAnchor: false, observedRising: false,
    onGround: !!raw.onGround, width: box.w, height: box.h, eyeHeight: pick.eyeHeight(bot, raw), yaw: raw.yaw, metadata,
    gliding: (require('../elytra/track') as typeof import('../elytra/track')).gliding(raw), pitch: raw.pitch || 0,
    equipment: (gear?.equipment || raw.equipment || []).map(visiblePlayerItem), _ndUnknownArmorSlots: gear?.unknownArmorSlots ?? raw._ndUnknownArmorSlots ?? 0, ordinaryFall }
  if (view.onGround && !view.gliding) {
    // The first absolute landing resets motion. An old landing with horizontal travel cannot witness rest.
    if (firstGroundObservationExpired(raw)) return null
    const ground = groundInput(bot, raw, view, sprint, affected?.at, collision)
    if (ground) {
      view.velocity = ground.velocity.clone()
      view.run = run = { yaw: Number.isFinite(raw.yaw) ? raw.yaw : 0, control: ground.control }
    }
  } else groundMotion.delete(raw)
  const airborneRun = !view.onGround && !!run && !view.gliding
  if (airborneRun && !observation.hasObservedPhysicalVelocity(raw)) return null
  view.observedRising = airborneRun && ordinaryFall && raw._ndVisible === true && observedV?.y > 0 &&
    [previous, current].every(r => r?.grounded === false && !r.flying && /^(rel_entity_move|entity_move_look)$/.test(r.kind))
  if (!view.onGround && sprint && !view.gliding && view.ordinaryFall && view.height === 1.8 &&
      Number.isFinite(current?.yaw) && raw.yaw === current.yaw && (raw._ndGlideRevision ?? 0) === (current.revision ?? 0)) {
    const velocity = coastVelocity(bot, raw, view, collision, true), drive = sprintVelocities.get(raw)?.drive
    if (velocity && drive) {
      view.velocity = velocity.clone()
      view.run = run = { control: drive.control, yaw: drive.yaw }
    }
  } else sprintVelocities.delete(raw)
  if (!view.onGround && !run && !view.gliding) {
    if (coastVelocities.get(raw)?.handedOff) coastVelocities.delete(raw)
    const coast = coastVelocity(bot, raw, view, collision)
    if (coast === null) return null
    if (coast) view.velocity = coast.clone()
    const drive = coastVelocities.get(raw)?.drive
    if (drive) view.run = run = { control: drive.control, yaw: drive.yaw + (Number.isFinite(raw.yaw) ? raw.yaw - drive.lookYaw : 0) }
  } else {
    // Starting fall flight changes the pose. The unchanged fresh receipt still owns its certified coast velocity.
    const coast = view.gliding && !view.onGround ? coastVelocities.get(raw) : undefined
    const life = bot.players?.[raw.username]?.entity || raw, epoch = raw._ndMotionEpoch
    const gust = affected?.raw === life ? affected.at : undefined
    if (coast?.velocity && h === 0 && velocity.y === 0 && raw._ndVisible === true && !raw._ndGlideBoosted && Number.isSafeInteger(epoch) &&
        coast.life === life && coast.observer === bot.entity && coast.epoch === epoch && coast.gust === gust &&
        coast.previous === receipts?.[0] && coast.current === receipts?.[1] && !coast.current.flying && !coast.current.boosted &&
        observedV?.ageTicks >= 0 && observedV.ageTicks < 1) {
      view.velocity = coast.velocity.clone()
      coast.handedOff = true
    } else coastVelocities.delete(raw)
  }
  // Repeated reversals can cancel weak sprint drive. A single turn may be the new sustained heading.
  const earlier = raw._ndEarlierPositionReceipt
  if (sprint && run && !view.onGround && !view.gliding && raw._ndVisible === true && h <= bot.physics.airborneAcceleration * 1.3 * .98 &&
      earlier && previous && current && earlier.t <= previous.t && previous.t <= current.t && current.t - earlier.t <= 10 * 50 &&
      observedAirTurn(raw, earlier, previous, current) !== null) {
    const reversed = (from: Point & { yaw: number }, to: Point & { yaw: number }) => {
      const dx = to.x - from.x, dz = to.z - from.z
      const alongLook = (yaw: number) => -dx * Math.sin(yaw) - dz * Math.cos(yaw)
      return Math.cos(to.yaw - from.yaw) < 0 && alongLook(from.yaw) > 1 / 4096 && alongLook(to.yaw) < -1 / 4096
    }
    if (reversed(earlier, previous) && reversed(previous, current)) view.run = run = null
  }
  // Нативная позиция стареет между пакетами; прогноз начинается сейчас, а не в момент последнего пакета.
  const age = Math.min(20, Math.max(0, Math.floor(observedV?.ageTicks || 0)))
  // Two unchanged visible ground receipts witness support even when the block under the feet is occluded.
  // Keep this observed rest pose only while the input and velocity are unchanged; never add a block to the ray world.
  if (raw._ndVisible === true && Number.isSafeInteger(raw._ndMotionEpoch) && view.onGround && !view.gliding &&
      previous?.grounded && current?.grounded && current.t > previous.t && /^(rel_entity_move|entity_move_look)$/.test(current.kind) &&
      view.position.equals(previous) && view.position.equals(current) && view.velocity.x === 0 && view.velocity.z === 0 && !groundDrive(run?.control) &&
      !(collision || observedCollision(bot)).blockAt(view.position.offset(0, -1e-4, 0))) {
    view.groundAnchor = true
    view.velocity.y = -bot.physics.gravity * bot.physics.airdrag
  }
  if (age && !view.groundAnchor) {
    const state = bodyState(bot, view), simulate = edges.simOf(bot), world = edges.worldOf(collision || observedCollision(bot))
    if (run && !view.gliding) { state.yaw = run.yaw; state.control = { ...edges.IDLE, ...run.control } }
    for (let tick = 0; tick < age; tick++) simulate(state, world)
    Object.assign(view, { position: state.pos, velocity: state.vel, onGround: state.onGround })
  }
  return view
}

// Active scheduled throws maintain this same fair motion cache while waiting, without a 65-frame rollout each tick.
export { enemyView as observeEnemyWindMotion }

/** Executor revalidation starts at the latest observed pose, never the old plan's extrapolated enemy state. */
export function enemyWindFrames(bot: any, raw: any, arena: WindArena, shots: EnemyWindShot[] = [], resistance = 0, reactAfterHit = false, collision?: WindCollision): Frame[] {
  if (!raw?.position || !seesPlayer(bot, raw)) return []
  const view = enemyView(bot, raw, collision)
  if (!view) return []
  const world = edges.worldOf(collision || observedCollision(bot))
  const active = shots.map(shot => ({ ...shot, from: vec(shot.from), velocity: vec(shot.velocity) }))
  const foe = { ...view, reactAfterHit, assessFall: false }
  return rollout({ ...bot, blockAt: p => world.getBlock(p) }, foe, active, arena, Math.max(0, Math.min(1, resistance)))?.frames || []
}

/** A visible in-flight allied lift can inform steering before its impact; cast and finish still need fresh motion. */
export function enemyWindLiftFrames(bot: any, raw: any, arena: WindArena, baseline: Frame[], lead: number, deadline: number): Frame[] | null {
  if (raw?._ndVisible !== true || !baseline[1] || expired(deadline)) return null
  const collision = windCollisionWorld(bot), foe = enemyView(bot, raw, collision)
  if (!foe || foe.onGround || foe.gliding || !foe.position.equals(baseline[0].pos) || !foe.velocity.equals(baseline[0].vel)) return null
  const pending = pendingWindHit(bot, raw, baseline.slice(0, lead + 1), [], collision, { witness: true, deadline })
  if (!pending?.witness || baseline[pending.ticks].onGround) return null
  const { from, velocity, age, thrower } = pending.witness
  const world = { ...bot, blockAt: (p: Vec3) => collision.blockAt(p) }, view = { ...foe, reactAfterHit: true, assessFall: false }
  const peak = (frames: Frame[]) => frames.reduce((high, frame) => Math.max(high, frame.pos.y), -Infinity)
  const baselinePeak = peak(baseline)
  let lower: { peak: number; frames: Frame[] } | undefined
  const sight = new Map<any, boolean>()
  for (const offset of [0, 1]) for (const phase of [0, 1]) {
    const shot = { from, velocity, thrower, fireDelay: offset - age }, unknown: { step?: number } = {}
    const run = rollout(world, view, [shot], arena, 0, 0, sight, deadline, true, unknown, phase)
    const hit = run?.impacts[0]
    const contact = hit && hit.fireDelay + hit.ticks
    if (!run || !contact || Math.abs(contact - pending.ticks) > 1 || contact >= (unknown.step ?? Infinity)) return null
    const frames = run.frames.slice(0, unknown.step), height = peak(frames)
    if (height <= baselinePeak) return null
    if (!lower || height < lower.peak) lower = { peak: height, frames }
  }
  if (!lower || expired(deadline)) return null
  planTrace('escort:incoming_lift')
  return lower.frames
}

type ObservedWindImpact = { raw: any; at: number; motionAt?: number; settled?: boolean }
type VisibleVelocityEvent = { at: number; observer: object; clock: unknown }
const windObservations = new WeakMap<object, {
  sight: ReturnType<typeof createLastSeen>; affected: Map<number, ObservedWindImpact>; velocities: WeakMap<object, VisibleVelocityEvent>
}>()

function windMotionObserved(impact: ObservedWindImpact, receipts?: any[]) {
  if (!(receipts?.[0]?.t > (impact.motionAt ?? impact.at) && receipts[1]?.t > receipts[0].t)) return false
  impact.settled = true
  return true
}

/** Projectile removal precedes the next body receipts: a gust does not make the pre-impulse velocity current. */
export function installWindTracking(bot: any) {
  thrownTracker(bot)
  if (windObservations.has(bot)) return
  const sight = createLastSeen(bot), affected = new Map<number, ObservedWindImpact>()
  const velocities = new WeakMap<object, VisibleVelocityEvent>()
  windObservations.set(bot, { sight, affected, velocities })
  const gust = packet => {
    const center = packet?.center
    if (!windGust(packet) || !finite(center) || !seesPlayer(bot, { position: vec(center), height: .01, width: .01 })) return
    const world = edges.worldOf(observedCollision(bot)), observed = { ...bot, blockAt: p => world.getBlock(p) }, at = observationNow()
    for (const player of Object.values(bot.players || {}) as any[]) {
      const raw = player?.entity
      if (!raw?.position || raw === bot.entity || raw.position.distanceTo(vec(center)) > WIND.reach) continue
      const foe = sight.observe(raw)
      if (foe?._ndVisible && windImpulse(observed, foe.position, center, { resistance: 0, height: foe.height || 1.8, eyeHeight: pick.eyeHeight(bot, foe) }).norm() > 0) {
        affected.set(raw.id, { raw, at })
        coastVelocities.delete(foe)
      }
    }
  }
  const velocity = packet => {
    const impact = affected.get(packet?.entityId), raw = impact?.raw
    const player = bot.entities?.[packet?.entityId]
    if (player?.username && player !== bot.entity && bot.players?.[player.username]?.entity === player && seesPlayer(bot, player)) {
      velocities.set(player, { at: player._ndObservationNow?.() ?? observationNow(), observer: bot.entity, clock: bot.ndClock })
    }
    if (!impact || impact.settled || raw !== bot.players?.[raw.username]?.entity) return
    const at = observationNow()
    if (at <= (impact.motionAt ?? impact.at)) return
    const view = sight.observe(raw)
    if (!view?._ndVisible || windMotionObserved(impact, view._ndPositionReceipts)) return
    // Paper can broadcast the same motion on both sides of the first position. The receipt time marks the new phase.
    impact.motionAt = at
    coastVelocities.delete(view)
  }
  const close = () => {
    bot._client.removeListener('explosion', gust); bot._client.removeListener('entity_velocity', velocity)
    bot.removeListener('end', close); sight.close(); windObservations.delete(bot)
  }
  bot._client.on('explosion', gust); bot._client.on('entity_velocity', velocity); bot.once('end', close)
}

/** Two visible positions after the impulse measure its new motion; reacquiring after a LOS gap starts over. */
export function windMotionFresh(bot: any, foe: any): boolean {
  const tracking = windObservations.get(bot), affected = tracking?.affected.get(foe.id)
  if (!tracking || !affected) return true
  const raw = bot.players?.[foe.username]?.entity
  if (raw !== affected.raw) { tracking.affected.delete(foe.id); return true }
  const view = tracking.sight.observe(raw), receipts = view?._ndPositionReceipts
  // Retain the last visible gust epoch so another fair vision cache cannot bridge across that impulse.
  return !!view?._ndVisible && windMotionObserved(affected, receipts)
}

export function recentlyWindAffected(bot: any, target: any): boolean {
  const live = bot.players?.[target?.username]?.entity, impact = windObservations.get(bot)?.affected.get(target?.id)
  return !!(live && live.id === target.id && impact?.raw === live && !isAlly(bot, live) &&
    observationNow() - impact.at <= WIND_FORECAST_TICKS * 50)
}

/** Only a witnessed, settled wind impulse can nominate an inside interception. */
interface WindFinishWindow { target: string; at: Vec3; ticks: number; gameTick: number; frames: Frame[] }
const spearInside = new WeakMap<WindFinishWindow, {
  bot: any; body: any; clock: any; world: any; arena: WindArena; target: any; epoch: number; gust: object
}>()

export function windFinishOpportunity(bot: any, target: any, arena: WindArena, collision?: WindCollision, deadline?: number,
  spear?: 'preflight' | WindFinishWindow): WindFinishWindow | null {
  const gameTick = worldTick(bot)
  if (!arena || gameTick === null || !recentlyWindAffected(bot, target) || expired(deadline)) return null
  const live = bot.players[target.username].entity
  const visible = windObservations.get(bot)!.sight.observe(live)
  if (!visible?._ndVisible || visible.onGround) return null
  const accepted = spear === 'preflight' ? undefined : spear
  const proof = accepted && spearInside.get(accepted)
  const gust = spear ? windObservations.get(bot)!.affected.get(live.id) : undefined
  const epoch = visible._ndMotionEpoch
  const active = accepted && proof && proof.bot === bot && proof.body === bot.entity && proof.clock === bot.ndClock &&
    proof.world === bot.world && proof.arena === arena && proof.target === live && proof.epoch === epoch && proof.gust === gust &&
    gameTick >= accepted.gameTick && gameTick - accepted.gameTick < accepted.ticks
  const world = collision || windCollisionWorld(bot)
  let seedUnknown = false
  const foe = enemyView(bot, visible, active ? { ...world, blockAt(p) {
    const block = world.blockAt(p)
    if (!block) seedUnknown = true
    return block
  } } : world)
  if (!foe || foe.onGround || foe.gliding || seedUnknown) return null
  const unknown: { step?: number } = {}
  const run = rollout({ ...bot, blockAt: p => world.blockAt(p) }, { ...foe, reactAfterHit: true, assessFall: false }, [],
    arena, 0, 0, undefined, deadline, true, unknown)
  // Only a complete forecast can distinguish crossing the rim from landing outside.
  if (!run || run.out || unknown.step !== undefined && (run.exited || windOutside(arena, run.frames[0].pos, foe.width))) return null
  const cut = active ? unknown.step : undefined, landed = run.frames[run.endpointTick].onGround
  // Only the live spear pass can use an airborne prefix. Its ordinary
  // contact planner requires a valid hit strictly before this cutoff.
  if (cut === undefined ? !landed : cut < 2) return null
  const frames = cut === undefined ? run.frames : run.frames.slice(0, cut)
  if (bot._ndThrown?.size && pendingWindHit(bot, live, frames, [], world) || expired(deadline)) return null
  const window = { target: live.username, at: landed ? run.position : frames.at(-1)!.pos, ticks: cut ?? run.endpointTick, gameTick, frames }
  if (spear === 'preflight' && gust && Number.isSafeInteger(epoch)) spearInside.set(window, {
    bot, body: bot.entity, clock: bot.ndClock, world: bot.world, arena, target: live, epoch, gust
  })
  return window
}

function nearWindSurface(origin: Vec3, direction: Vec3, length: number, feet: Vec3) {
  const x = feet.x - origin.x, y = feet.y - origin.y, z = feet.z - origin.z
  const along = Math.max(0, Math.min(length, x * direction.x + y * direction.y + z * direction.z))
  return (x - along * direction.x) ** 2 + (y - along * direction.y) ** 2 +
    (z - along * direction.z) ** 2 <= (WIND.reach + WIND.surfaceOffset) ** 2
}

/** Preserve an unscheduled visible hit or exposed surface gust, then observe its impulse before re-aiming. */
interface PendingWindHit {
  id: number; ticks: number; burst: Vec3
  witness?: { from: Vec3; velocity: Vec3; age: number; thrower: string }
}

function visibleBirthClear(bot: any, foe: any, seen: any, view: any, record: any, velocity: Vec3,
  owner: string, sight: Map<any, boolean>, deadline?: number, fairSight?: ReturnType<typeof createLastSeen>) {
  const birth = view._ndWindMotion?.birth
  const age = Math.ceil((view._ndObservationNow() - record.observedAt) / 50 + 1)
  // Paper 1.21.11 ends deflection grace after the fifth movement. Include one adjacent native age before that boundary.
  if (!birth?.velocity || birth.record !== record || !(age > 1 && age < 5) || !finite(record.p) || !vec(record.p).equals(view.position)) return false
  const [previous, target] = seen?._ndVisible === true ? seen._ndPositionReceipts || [] : []
  if (!finite(previous) || !finite(target)) return false
  const origin = vec(record.p), previousBodies = new Map<any, Point>(), ownStep = bot._ndLaunchMovement?.()
  if (finite(ownStep)) previousBodies.set(bot.entity, vec(bot.entity.position).minus(vec(ownStep)))
  for (const body of Object.values(bot.entities || {}) as any[]) {
    if (expired(deadline)) return false
    if (!body?.username || body === bot.entity || body.id === foe.id || body.username === owner) continue
    const fair = body._ndVisible === true ? body : fairSight?.observe(body)
    const [prior, current] = fair?._ndVisible === true ? fair._ndPositionReceipts || [] : []
    if (finite(prior) && finite(current) && prior.t < current.t && current.t >= record.observedAt) previousBodies.set(body, prior)
  }
  // Check the whole upper phase from the actual spawn position, including the local player and visible bodies in segment.
  for (let step = 1; step <= age; step++) {
    if (expired(deadline)) return false
    const hit = segment(bot, foe, target, origin, velocity, step, owner, 0, sight, previous, undefined, false, previousBodies)
    if (hit.blocked || hit.burst) return false
  }
  return true
}

export function pendingWindHit(bot: any, foe: any, frames: Frame[], scheduled: EnemyWindShot[] = [], collision?: WindCollision,
  watch?: { witness?: boolean; skip?: number; deadline?: number }): PendingWindHit | null {
  const tick = worldTick(bot), time = observationNow()
  if (tick === null) return null
  const sight = new Map<any, boolean>()
  const world = edges.worldOf(collision || observedCollision(bot)), observed = { ...bot, blockAt: p => world.getBlock(p) }
  const box = foe.position ? pick.hitboxOf(bot, foe) : { w: foe.width, h: foe.height }
  const seen = foe._ndVisible === undefined ? windObservations.get(bot)?.sight.observe(foe) : foe
  const target = seen?._ndVisible === true ? seen._ndPositionReceipts?.[1] : undefined
  const unseenTicks = finite(target) ? (time - target.t) / 50 : 0
  let first: PendingWindHit | null = null
  for (const [id, record] of thrownTracker(bot)) {
    if (expired(watch?.deadline)) return null
    if (id === watch?.skip || !/^(?:breeze_)?wind_charge$/.test(record.name)) continue
    const entity = bot.entities?.[id]
    const view = entity && projectileView(bot, entity, time)
    if (!view) continue
    const age = Math.max(0, Math.round((time - (record.observedAt ?? record.t0)) / 50))
    const owner = record.owner === bot.entity.id ? bot.entity : bot.entities[record.owner]
    const receipt = view._ndPositionReceipts[1], native = view._ndWindMotion?.t >= receipt.t
    const motion = native ? view._ndWindMotion.velocity : projectileVelocity(view, time)
    if (!finite(motion)) continue
    const velocity = vec(motion), length = velocity.norm()
    if (length === 0) continue
    // Match the known cast's owner, epoch and native launch envelope, not a different local throw during the same schedule.
    if (owner?.username && scheduled.some(s => s.thrower === owner.username && Number.isSafeInteger(s.fireTick) &&
      Math.abs(s.fireTick! - (tick - age)) <= 1 && finite(s.from) && vec(s.from).distanceTo(vec(record.p)) <= WIND.reach &&
      finite(s.velocity) && vec(s.velocity).distanceTo(velocity) <= 2 * WIND.speed * WIND.dispersion * Math.sqrt(3))) continue
    const at = native ? view._ndWindMotion.t : receipt.t, stale = Math.max(0, (view._ndObservationNow() - at) / 50)
    if (stale > 20) continue
    const witnessed = vec(native ? view._ndWindMotion.position : view.position), direction = velocity.scaled(1 / length)
    // A charge can cross the last visible body before either its burst or a new body packet reaches us.
    if (native && unseenTicks > 0 && unseenTicks <= 20) {
      const sinceTarget = Math.max(0, (target.t - at) / 50), firstAge = Math.max(1, age - Math.round(stale) + 1)
      for (let passed = Math.floor(sinceTarget); passed < stale; passed++) {
        const origin = witnessed.plus(velocity.scaled(passed))
        const hitAt = bodyHit(origin, direction, length * Math.min(1, stale - passed), target, firstAge + passed, box.w, box.h)
        if (hitAt === null || passed + hitAt / length <= sinceTarget) continue
        // A known obstruction before that receipt still consumes the ray. Start at its last actual witness.
        for (let step = 0; step <= passed; step++) {
          const stepVelocity = velocity.scaled(Math.min(1, stale - step)), stepAge = firstAge + step
          const stepFrom = witnessed.plus(velocity.scaled(step)).minus(stepVelocity.scaled(stepAge - 1))
          const hit = segment(observed, foe, target, stepFrom, stepVelocity, stepAge, owner?.username, 0, sight)
          if (hit.blocked) break
          if (hit.burst) {
            if (step === passed) return { id, ticks: 1, burst: hit.burst }
            break
          }
        }
        break
      }
    }
    const relay = watch?.witness && native && record.name === 'wind_charge' && owner?.username && owner !== bot.entity && isAlly(bot, owner)
    const advanced = witnessed.plus(velocity.scaled(stale))
    const estimated = advanced.minus(velocity.scaled(age))
    const birth = relay && stale > 1 && visibleBirthClear(observed, foe, seen, view, record, velocity, owner.username, sight, watch.deadline, windObservations.get(bot)?.sight)
      ? vec(record.p) : undefined
    // Keep the earlier warning and test the cleared birth ray if receipt drift hid its contact.
    for (const from of birth ? [estimated, birth] : [estimated]) {
      const position = from === estimated ? advanced : from.plus(velocity.scaled(age))
      const beforeFirst = first?.ticks ?? frames.length
      let contact = 1, near = 0
      for (; contact < beforeFirst; contact++) {
        const origin = from.plus(velocity.scaled(age + contact - 1))
        if (nearWindSurface(origin, direction, length, frames[contact].pos) ||
            nearWindSurface(origin, direction, length, frames[contact - 1].pos)) near = contact
        if (bodyHit(origin, direction, length, frames[contact].pos, age + contact, box.w, box.h, frames[contact - 1].pos) !== null) break
      }
      let surface: { tick: number; block: Vec3; burst: Vec3 } | undefined
      if (near) {
        // Only a ray close enough to affect either body phase needs a terrain search.
        let unknown = false
        const known = { ...observed, blockAt(p: Vec3) { const b = world.getBlock(p); if (!b) unknown = true; return b } }
        const impact = windBlockImpact(known, position, direction, near * length, length)
        if (impact && !unknown) {
          const step = Math.max(1, Math.ceil(impact.distance / length))
          const pose = { resistance: 0, height: box.h, eyeHeight: pick.eyeHeight(bot, foe) }
          if (step <= near && [frames[step - 1], frames[step]].some(frame => windImpulse(known, frame.pos, impact.burst, pose).norm() > 0) && !unknown) {
            surface = { tick: step, block: impact.pos, burst: impact.burst }
            contact = Math.min(contact, step)
          }
        }
      }
      if (contact >= beforeFirst) continue
      // An earlier block or entity still consumes a ray that could intersect the target.
      for (let step = 1; step <= contact; step++) {
        // An incoming projectile can collide before the next player movement packet advances the body.
        const hit = segment(observed, foe, frames[step].pos, from, velocity, age + step, owner?.username, step, sight, frames[step - 1].pos,
          surface?.tick === step ? surface.block : undefined)
        if (hit.surface && surface) { first = { id, ticks: step, burst: surface.burst }; break }
        if (hit.blocked) break
        if (hit.burst) {
          first = { id, ticks: step, burst: hit.burst }
          if (relay && (stale <= 1 || birth)) first.witness = { from: birth ?? from, velocity, age, thrower: owner.username }
          break
        }
      }
    }
  }
  return first
}

/** A nearby gust alone cannot identify our cast: its native projectile must disappear in the same tick window. */
export function observeOwnWindBurst(bot: any, matches: (packet: any) => boolean, confirmed: () => void) {
  let projectile: number | null = null, gustTick: number | null = null
  const spawn = packet => {
    if (projectile === null && packet.objectData === bot.entity?.id && packet.type === bot.registry.entitiesByName.wind_charge.id) projectile = packet.entityId
  }
  const gust = packet => { if (projectile !== null && matches(packet)) gustTick = worldTick(bot) }
  const gone = packet => {
    const tick = worldTick(bot)
    if (projectile !== null && packet.entityIds?.includes(projectile) && gustTick !== null && tick !== null && Math.abs(tick - gustTick) <= 1) confirmed()
  }
  const close = () => {
    bot._client.removeListener('spawn_entity', spawn); bot._client.removeListener('explosion', gust); bot._client.removeListener('entity_destroy', gone)
    bot.removeListener('end', close)
  }
  bot._client.on('spawn_entity', spawn); bot._client.on('explosion', gust); bot._client.on('entity_destroy', gone)
  bot.once('end', close)
  return close
}

// Отказы выстрела по причине (ND_WIND_TRACE=1), сливаются в [wind-trace] рефлекса.
export const planTraceCounts: Record<string, number> = {}
const planTrace = (k: string) => { if (process.env.ND_WIND_TRACE === '1') planTraceCounts[k] = (planTraceCounts[k] || 0) + 1 }

function followVisibleWind(bot: any, snapshot: any, raw: any, foe: any, report: WindReport, team: WindReport[],
  tracks: Map<WindReport, Frame[]>, sight: Map<any, boolean>, collision: WindCollision, options: EnemyWindOptions,
  resistance: ReturnType<typeof windResistance>, pending: PendingWindHit, baseline: WindRun, now: number, start: number): EnemyWindPlan | null {
  const { arena, deadline } = options, { from, velocity, age, thrower } = pending.witness!
  const confirmsLead = (run: WindRun | null): run is WindRun => !!run && !run.out && run.impacts.length === 1
  const phases = []
  // Reject a missed lead on either body tick before simulating the recoil branches.
  for (const offset of [0, 1]) for (const phase of [0, 1]) {
    const prefix = { from, velocity, thrower, fireDelay: -age + offset }
    const base = rollout(snapshot, foe, [prefix], arena, resistance.lo, 0, sight, deadline, false, undefined, phase)
    if (!confirmsLead(base)) return null
    phases.push({ prefix, phase, base })
  }
  const variants = []
  for (const { prefix, phase, base } of phases) for (const resist of new Set([resistance.lo, resistance.hi])) {
    const without = resist === resistance.lo ? base : rollout(snapshot, foe, [prefix], arena, resist, 0, sight, deadline, false, undefined, phase)
    if (!confirmsLead(without)) return null
    const recoil = rollout(snapshot, foe, [prefix], arena, resist, 1, sight, deadline, false, undefined, phase)
    if (!confirmsLead(recoil)) return null
    variants.push({ prefix, phase, resist, bases: [without, recoil] })
  }
  const blockShapes = new Map<string, number[][] | null>()
  const watch = { skip: pending.id, deadline }, contact = (hit: WindRun['impacts'][number]) => hit.fireDelay + hit.ticks
  const competing = (frames: Frame[], through: number) => bot._ndThrown.size > 1 &&
    pendingWindHit(bot, raw, frames.slice(0, through + 1), [], collision, watch) !== null
  const safeAllies = (impacts: WindRun['impacts']) => [0, 1, 2, 3].every(phase => {
    const adjacent = impacts.map((hit, i) => phase & (1 << i) ? { ...hit, ticks: hit.ticks - 1 } : hit)
    return adjacent.every(hit => contact(hit) > 0) && windTeamSafe(snapshot, team, adjacent, arena, tracks, false, deadline)
  })
  let tried = 0
  // A proven same-tick follow can use the grant before the lead's narrow birth window expires.
  for (const delay of new Set([0, ...(options.delays ?? [2])])) for (const height of [.4, 1.6]) {
    if (expired(deadline)) return null
    const shot = enemyWindShot(snapshot, foe, report, variants[0].bases[0].frames,
      { fireDelay: start - now + delay, height, tracks }, sight, deadline, collision)
    tried++
    if (!shot || contact(shot) <= pending.ticks || !windCoverClear(snapshot, shot, blockShapes, deadline)) continue
    type Pair = { base: WindRun; run: WindRun; gain: number }
    let nominal: Pair | undefined, worst: Pair | undefined, latest = 0
    const weaker = (a: Pair, b: Pair) => (Number(a.run.out) - Number(b.run.out) || Number(a.run.exited) - Number(b.run.exited) || a.gain - b.gain) < 0
    const certified = variants.every(({ prefix, phase, resist, bases }) => [phase, phase | 2].every(order => [0, 1, 2, 3].every(mask => {
      const base = bases[mask & 1], run = rollout(snapshot, foe, [prefix, shot], arena, resist, mask, sight, deadline, false, undefined, order)
      if (!run || run.impacts.length !== 2) return false
      const [first, second] = run.impacts, gain = run.outwardEffect! - base.outwardEffect!
      // Full possible blast resistance can make the follow-up neutral. A weaker hit must still help.
      if (contact(first) !== contact(base.impacts[0]) || contact(second) <= contact(first) ||
          (resist < 1 ? gain <= 0 || run.progress <= base.progress : gain < 0 || run.progress < base.progress) ||
          !windCoverClear(snapshot, { ...shot, ...second }, blockShapes, deadline) || !safeAllies(run.impacts)) return false
      latest = Math.max(latest, contact(second))
      const pair = { base, run, gain }
      if (resist === resistance.lo && (!nominal || weaker(pair, nominal))) nominal = pair
      if (!worst || weaker(pair, worst)) worst = pair
      return true
    })))
    if (!certified || !nominal || !worst || competing(baseline.frames, latest) ||
        variants.some(v => v.bases.some(base => competing(base.frames, latest))) || expired(deadline)) continue
    return { target: foe.username || String(foe.id), targetAt: foe.position, gameTick: now, resistance, tried,
      relayPrefix: pending.id, fallThreat: false, repriceRim: true, earlyLift: false, lateLift: false,
      shots: [{ ...shot, fireTick: now + shot.fireDelay, arrivalTick: now + contact(shot) }],
      baseline: windOutcome(nominal.base), nominal: windOutcome(nominal.run), worst: windOutcome(worst.run) }
  }
  return null
}

/** One small receding chain: different ready throwers, distinct arrivals, exact native projectile/body forecasts. */
export function planEnemyWind(bot: any, raw: any, reports: WindReport[], options: EnemyWindOptions): EnemyWindPlan | null {
  const late = () => expired(options?.deadline)
  if (late()) { planTrace('late:budget'); return null }
  const now = worldTick(bot), arena = options?.arena
  if (now === null || !arena || !raw?.position || !seesPlayer(bot, raw)) return null
  const foe: any = enemyView(bot, raw, options.collision)
  if (!foe) return null
  foe.reactAfterHit = !!options.reactAfterHit
  if (options.protect?.length) foe.protect = options.protect.map(vec)
  const resistance = windResistance(foe), observed = options.collision ?? windCollisionWorld(bot), world = edges.worldOf(observed)
  const allReports = [...new Map([...(options.allies || []), ...reports].map(r => [r.id, r])).values()]
  const team = allReports.map(report => windReportAt(bot, report, now, options.deadline))
  if (team.some(report => report === null)) return null
  const allyTracks = new Map<WindReport, Frame[]>()
  const snapshot = teamWorld({ ...bot, blockAt: p => world.getBlock(p) }, team, allyTracks, options.deadline)
  if (!snapshot) return null
  // Enemy recoil can change the outcome without changing the gust the allies must survive.
  const safeImpacts = new Set<string>()
  const ready = new Set(reports.map(r => r.id)), throwers = team.filter(r => ready.has(r.id))
  const outward = options.protect?.length ? foe.position.minus(new Vec3(arena.x, foe.position.y, arena.z)) : windOutward(arena, foe.position, foe.width)
  if (options.protect?.length && outward.norm()) outward.scale(1 / outward.norm())
  if (!options.protect?.length) foe.outward = outward.clone()
  const rank = (r: WindReport) => { const d = foe.position.minus(vec(r.position)), distance = d.norm(); return distance - 10 * (distance ? d.dot(outward) / distance : 0) }
  throwers.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  const start = options.startTick ?? now + 2
  if (!Number.isSafeInteger(start) || start < now || start > now + 20) return null
  // Price the same observed input with and without our gust; a hypothetical enemy reaction belongs to the worst-case check.
  const nominalFoe = options.protect?.length ? foe : { ...foe, keepObservedInput: true }
  const sight = new Map<any, boolean>(), baseline = rollout(snapshot, nominalFoe, [], arena, 0, 0, sight, options.deadline), shots: EnemyWindShot[] = []
  if (!baseline) return null
  const relay = !!options.visiblePrefix && !options.protect?.length && options.maxShots === 1 && throwers.length === 1
  const pending = options.waitForHit && bot._ndThrown?.size ? pendingWindHit(bot, raw, baseline.frames, [], observed,
    relay ? { witness: true, deadline: options.deadline } : undefined) : null
  if (pending?.ticks === 1) { planTrace('pending_wind_impulse'); return null }
  if (options.expectedPrefix !== undefined && pending?.id !== options.expectedPrefix) return null
  if (relay && pending?.witness && !baseline.out) {
    const result = followVisibleWind(bot, snapshot, raw, nominalFoe, throwers[0], team, allyTracks, sight,
      observed, options, resistance, pending, baseline, now, start)
    if (result) return result
  }
  if (options.expectedPrefix !== undefined) return null
  let nominal = baseline, tried = 0
  const value = (r: NonNullable<ReturnType<typeof rollout>>) => Number(r.out) * 1000 + (options.protect ? Math.min(r.clear, 6) : r.progress + (options.juggle ? .05 * r.air : 0))
  // Full ordinary player health is a danger threshold, never a reading of this player's HP.
  const fallThreat = (r: NonNullable<ReturnType<typeof rollout>>) => r.fallDamage >= 20
  const newFallThreat = (r: NonNullable<ReturnType<typeof rollout>>) => !r.out && fallThreat(r) && !fallThreat(baseline)
  const outcomeRank = (r: NonNullable<ReturnType<typeof rollout>>) =>
    Number(r.exited) + (fallThreat(r) ? 2 : 0) + (arena.ellipse && r.out ? 4 : 0)
  // Admission and the nominal trajectory keep the signed immediate certificate.
  const compare = (a: NonNullable<ReturnType<typeof rollout>>, b: NonNullable<ReturnType<typeof rollout>>) =>
    !options.protect?.length ? outcomeRank(a) - outcomeRank(b) || a.outwardEffect! - b.outwardEffect! || value(a) - value(b) : value(a) - value(b)
  type Choice = { shot: EnemyWindShot; run: WindRun; ranked: WindRun }
  // At the rim or a visible obstruction, keep room for a full next gust.
  const { gravity, airdrag, airborneInertia } = bot.physics
  const decayTicks = 1 / (1 - airborneInertia)
  const gustTravel = WIND.knockback * decayTicks
  const priceTerrain = baseline.blockedBeforeLanding || arenaRoom(arena, baseline.position) <= 2 * gustTravel
  const preserveLanding = priceTerrain && !foe.onGround && options.maxShots === 1
  let gustRise = 0
  if (arena.ellipse && !foe.gliding && !options.protect?.length && gravity > 0 && airdrag > 0 && airdrag < 1) {
    for (let tick = 0, speed = WIND.knockback; tick < WIND_FORECAST_TICKS && speed > 0; tick++, speed = (speed - gravity) * airdrag) gustRise += speed
  }
  const liftWorld = { ...snapshot, entity: { _ndPoseHeight: foe.height } }, liftCache = new Map<string, number | null>()
  const headroom = (r: WindRun) => {
    if (!gustRise || r.out || !r.frames[r.endpointTick].onGround || late()) return null
    const key = r.position.toString()
    if (!liftCache.has(key)) liftCache.set(key, verticalLift(liftWorld, r.position, gustRise, true))
    return liftCache.get(key)!
  }
  const openLift = (r: WindRun) => Number(priceTerrain && headroom(r) === gustRise)
  const matchedOutward = (run: WindRun) => {
    // Compare the same input at landing, or the last available common tick if either forecast ends first.
    const tick = Math.min(run.endpointTick, baseline.frames.length - 1)
    const actual = run.frames[tick].pos, without = baseline.frames[tick].pos
    return (actual.x - without.x) * outward.x + (actual.z - without.z) * outward.z
  }
  const compareLanding = options.protect?.length ? compare : (a: WindRun, b: WindRun) =>
    outcomeRank(a) - outcomeRank(b) || openLift(a) - openLift(b) || matchedOutward(a) - matchedOutward(b) || compare(a, b)
  // Rays share block shapes inside this synchronous plan. Each ray still tests its own spread against them.
  const cover = new Map<EnemyWindShot, boolean>(), coverShapes = new Map<string, number[][] | null>()
  const clear = (shot: EnemyWindShot) => {
    if (!cover.has(shot)) cover.set(shot, windCoverClear(snapshot, shot, coverShapes, options.deadline))
    return Number(cover.get(shot))
  }
  const canRecoverFlight = options.juggle && !foe.onGround && !foe.gliding && !priceTerrain &&
    options.maxShots === 1 && throwers.length === 1
  const recoversFlight = (run: WindRun, before: WindRun, tick: number) => {
    const coast = before.frames[tick], kicked = run.frames[tick]
    return !!coast && !!kicked && !coast.onGround && coast.vel.y <= 0 && kicked.vel.y > 0 && run.air > before.air
  }
  const compareChoice = (run: WindRun, shot: EnemyWindShot, best: Choice, before = nominal) => {
    if (options.protect?.length) return compareLanding(run, best.ranked)
    const priority = outcomeRank(run) - outcomeRank(best.ranked) || openLift(run) - openLift(best.ranked) ||
      (priceTerrain ? clear(shot) - clear(best.shot) : 0)
    if (priority) return priority
    if (arena.ellipse && !outcomeRank(run)) {
      // Another gust or a change of input can invalidate a long flight before the relay arrives.
      const previous = matchedOutward(before)
      const arrival = shot.fireDelay + shot.ticks, bestArrival = best.shot.fireDelay + best.shot.ticks
      const advance = Math.max(0, matchedOutward(run) - previous) / (arrival + decayTicks)
      const incumbent = Math.max(0, matchedOutward(best.ranked) - previous) / (bestArrival + decayTicks)
      if (canRecoverFlight && shot.fireDelay === best.shot.fireDelay && advance > 0 && incumbent > 0) {
        const recovering = recoversFlight(run, before, arrival), kept = recoversFlight(best.ranked, before, bestArrival)
        if (recovering !== kept) {
          const rising = recovering ? shot : best.shot, falling = recovering ? best.shot : shot
          // Preserve every established contact before trading outward speed for another airborne window.
          const preserved = rising.ticks === falling.ticks ? preservesContact(rising, falling, before.frames, foe.width, foe.height)
            : rising.ticks + 1 === falling.ticks && preservesEarlierContact(rising, falling, before.frames, foe.width, foe.height)
          const end = rising.from.plus(rising.velocity.scaled(falling.ticks))
          if (preserved &&
              windCoverClear(snapshot, { ...rising, burst: end }, coverShapes, options.deadline)) return recovering ? 1 : -1
        }
      }
      if (advance !== incumbent) return advance - incumbent
    }
    return compareLanding(run, best.ranked)
  }
  const landingPrice = (run: WindRun, before: WindRun, room: number | null) => {
    // Price known roof loss at the same tick and keep a better first rim landing.
    const beforeRoom = room === null ? null : headroom(before)
    const lostRoom = room !== null && beforeRoom === gustRise ? gustRise - room : 0
    const stalledUnderRoof = options.maxShots === 1 && run.blockedBeforeLanding && room !== null && room < gustRise &&
      beforeRoom !== null && room <= beforeRoom && !outcomeRank(run) && matchedOutward(run) <= matchedOutward(before)
    const worthRoof = !stalledUnderRoof && (lostRoom <= 0 || run.out || newFallThreat(run) || matchedOutward(run) - matchedOutward(before) > lostRoom)
    const first = preserveLanding && run.impacts[0]
    const dropsOffLanding = first && baseline.endpointTick < first.fireDelay + first.ticks &&
      run.position.y < baseline.position.y && run.progress < baseline.progress &&
      room !== null && room <= (headroom(baseline) ?? -Infinity) && !run.out && !run.exited && !newFallThreat(run)
    return { worthRoof, dropsOffLanding }
  }
  let repriceRim = gustRise > 0 && priceTerrain
  const tryLower = arena.ellipse && !foe.gliding && !options.protect?.length && options.maxShots === 1 &&
    throwers.length === 1 && throwers[0].id === bot.entity.username && options.delays?.length === 1
  let selected: Choice | null = null, lowArrival = Infinity
  // Бюджет стены (wall.monotonic): план, досчитанный позже, всё равно уйдёт в stale_release — бросаю расчёт, а не досчитываю
  // до 0.5 с в physicsTick (Kimi AUDIT 27.10: 369 из 736 расчётов — stale_release, p90 251 мс, максимум 494).
  // shortcut: exact ordinary-KB certification keeps its eight-case CPU budget; larger chains need a non-exponential certifier.
  for (let step = 0; step < Math.min(3, options.maxShots ?? 2, throwers.length); step++) {
    let best: Choice | null = null
    let lift: Choice | null = null
    // Only the first expected impulse can invalidate this ray's target forecast.
    const intercept = pending ? nominal.frames.slice(0, pending.ticks) : nominal.frames
    const canLift = !options.protect?.length && compare(nominal, baseline) === 0 && step + 1 < Math.min(3, options.maxShots ?? 2, throwers.length)
    for (const report of throwers.filter(r => !shots.some(s => s.thrower === r.id))) for (const delay of options.delays ?? [0, 2]) {
      let needsLift = gustRise > 0 && nominal.blockedBeforeLanding
      for (const height of [.4, 1.6, .05]) {
        if (height === .05 && !needsLift) continue
        if (late()) { planTrace('late:budget'); return null }
        const shot = enemyWindShot(snapshot, foe, report, intercept, { fireDelay: start - now + delay, height, tracks: allyTracks }, sight, options.deadline, observed)
        tried++
        if (!shot) { planTrace('shot:none'); continue }
        if (tryLower && height === .4) lowArrival = shot.ticks
        if (shots.some(s => s.fireDelay + s.ticks === shot.fireDelay + shot.ticks)) continue
        const trial = [...shots, shot]
        let dominated = false
        let worstRank: WindRun | null = null
        // Both admission and ranking are bounded by the weakest KB branch seen so far.
        const worthCertifying = options.protect?.length ? undefined : run => {
          const terrain = gustRise > 0 && (priceTerrain || nominal.blockedBeforeLanding || run.blockedBeforeLanding)
          repriceRim ||= terrain
          const room = terrain ? headroom(run) : null
          needsLift ||= terrain && (run.blockedBeforeLanding || room !== null && room < gustRise)
          const gain = compare(run, nominal)
          const { worthRoof, dropsOffLanding } = landingPrice(run, nominal, room)
          const useful = gain > 0 && worthRoof && !dropsOffLanding && (!best || compareChoice(run, shot, best) > 0)
          const neutral = !best && !lift && canLift && gain === 0 && worthRoof
          dominated = !(useful || neutral)
          if (!dominated && (!worstRank || compareLanding(run, worstRank) < 0)) worstRank = run
          return !dominated
        }
        const run = bounds(snapshot, nominalFoe, trial, arena, resistance.lo, team, allyTracks, sight, options.deadline,
          options.protect?.length ? undefined : compare, worthCertifying, safeImpacts)
        if (!run) { planTrace(dominated ? 'shot:dominated' : 'shot:ally_unsafe'); continue }
        // With equal outward effect, extra air can set up the next ally's throw.
        // Отвод (options.protect): чем дальше его тело проходит от своих, тем лучше; до 6 бл. — дальше копьё не достаёт с запасом.
        if (!(compare(run, nominal) > 0)) planTrace('shot:no_gain')
        const ranked = worstRank ?? run
        if (compare(run, nominal) > 0 && (!best || compareChoice(ranked, shot, best) > 0)) best = { shot, run, ranked }
        else if (!best && !lift && canLift && compare(run, nominal) === 0 && run.frames.some((frame, tick) =>
          !frame.onGround && nominal.frames[tick] && frame.pos.y > nominal.frames[tick].pos.y)) lift = { shot, run, ranked }
      }
    }
    // Only initial safe lifts may wait for a later thrower's strict benefit.
    best ||= lift
    if (!best) break
    if (tryLower) selected = best
    shots.push(best.shot); nominal = best.run
    if (nominal.out || newFallThreat(nominal)) break
  }
  if (!shots.length || late() || compare(nominal, baseline) <= 0) return null
  let worst = bounds(snapshot, foe, shots, arena, resistance.hi, team, allyTracks, sight, options.deadline, undefined, undefined, safeImpacts)
  if (!worst) return null
  const high = selected?.shot
  if (high?.aimHeight === 1.6 && high.fireDelay === 0 && high.ticks < lowArrival && !nominal.exited && !newFallThreat(nominal) &&
      baseline.frames[high.ticks]?.onGround && high.burst.y >= high.feet.y + foe.eyeHeight) {
    // Preserve the certified ordinary plan and leave at least half the remaining wall budget for release.
    const started = wall.monotonic()
    const deadline = options.deadline === undefined ? undefined : started + (options.deadline - started) / 2
    if (deadline === undefined || started < deadline) {
      const frames = pending ? baseline.frames.slice(0, pending.ticks) : baseline.frames
      const shot = enemyWindShot(snapshot, foe, throwers[0], frames, { height: foe.height * 2 / 3, tracks: allyTracks }, sight, deadline, observed)
      tried++
      if (shot?.ticks === high.ticks && shot.burst.y < shot.feet.y + foe.eyeHeight &&
          preservesContact(shot, high, frames, foe.width, foe.height) &&
          windCoverClear(snapshot, { ...shot, burst: shot.from.plus(shot.velocity.scaled(shot.ticks)) }, coverShapes, deadline)) {
        let terrainUsed = false
        const improved = bounds(snapshot, nominalFoe, [shot], arena, resistance.lo, team, allyTracks, sight, deadline, compare, run => {
          const terrain = gustRise > 0 && (priceTerrain || baseline.blockedBeforeLanding || run.blockedBeforeLanding)
          terrainUsed ||= terrain
          const { worthRoof, dropsOffLanding } = landingPrice(run, baseline, terrain ? headroom(run) : null)
          return compare(run, baseline) > 0 && worthRoof && !dropsOffLanding &&
            compareChoice(run, shot, selected!, baseline) > 0
        }, safeImpacts)
        const safe = improved && bounds(snapshot, foe, [shot], arena, resistance.hi, team, allyTracks, sight, deadline, undefined, undefined, safeImpacts)
        if (improved && safe && !expired(deadline)) {
          shots[0] = shot; nominal = improved; worst = safe; repriceRim ||= terrainUsed
        }
      }
    }
  }
  const crest = options.juggle ? baseline.frames.findIndex(frame => frame.vel.y <= 0) : -1
  const first = shots[0], arrival = first.fireDelay + first.ticks
  const groundedOpening = options.maxShots === 1 && !pending && foe.onGround && !foe.gliding && !foe.run &&
    foe.velocity.x === 0 && foe.velocity.z === 0 && baseline.frames[arrival]?.onGround &&
    (nominal.frames[arrival]?.vel.y ?? 0) > 0 && nominal.frames[arrival + 1]?.onGround === false
  // At the centre, age can cross the crest before the next visible movement arrives.
  const apexOpening = crest === 0 && options.maxShots === 1 && !pending && foe.observedRising && !foe.onGround &&
    Math.abs(foe.position.x - arena.x) <= foe.width / 2 && Math.abs(foe.position.z - arena.z) <= foe.width / 2 &&
    baseline.frames[arrival]?.onGround === false
  // The air counter ends at the first support, so a grounded launch needs its actual post-hit step.
  let earlyLift = false
  if (arena.ellipse && (arrival <= crest || groundedOpening || apexOpening) && arenaRoom(arena, first.feet) > gustTravel) {
    // The projectile can meet either body update on its contact tick.
    const lift = first.feet.minus(first.burst).offset(0, foe.eyeHeight, 0)
    const next = baseline.frames[arrival + 1]
    const after = next ? lift.plus(next.pos.minus(baseline.frames[arrival].pos)) : lift
    earlyLift = (lift.y > 0 && lift.y > lift.dot(outward)) || (after.y > 0 && after.y > after.dot(outward))
  }
  return { target: foe.username || String(foe.id), targetAt: foe.position, gameTick: now, resistance, tried,
    fallThreat: newFallThreat(nominal), repriceRim, earlyLift, lateLift: crest > 0 && arrival > crest,
    shots: shots.map(s => ({ ...s, fireTick: now + s.fireDelay, arrivalTick: now + s.fireDelay + s.ticks })),
    baseline: windOutcome(baseline), nominal: windOutcome(nominal), worst: windOutcome(worst),
    // Current reports normalize without simulation. Only the same ordered, deduplicated team and observed world can reuse this exact burst.
    ...(options.certifyRelease && options.collision === observed && start === now && reports.length === 1 &&
      reports[0].id === bot.entity.username && options.allies?.[0] === reports[0] && options.allies.length === allReports.length &&
      allReports.every((report, i) => report.gameTick === now && report === options.allies![i]) &&
      shots.length === 1 && first.fireDelay === 0 && safeImpacts.has(windImpactKey(first)) && !late()
      ? { releaseSafeKey: windImpactKey(first) } : {}) }
}
