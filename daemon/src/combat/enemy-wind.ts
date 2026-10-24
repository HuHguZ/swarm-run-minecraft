import { Vec3 } from 'vec3'
import { type Point, supportAt } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
import edges = require('../edges')
import pick = require('../pick')
import { observedCollision } from '../pvp/search'
import { seesPlayer, visiblePlayerItem, observePlayerGear } from '../pvp/last-seen'
import { WIND, windLaunch, windImpulse, windInside, worldTick, type WindArena, type WindReport } from './team-wind'

const vec = (p: Point) => new Vec3(p.x, p.y, p.z)
const finite = (p: Point) => !!p && [p.x, p.y, p.z].every(Number.isFinite)
interface Frame { pos: Vec3; vel: Vec3; onGround: boolean }
export interface EnemyWindShot {
  thrower: string; fireDelay: number; ticks: number; from: Vec3; aim: Vec3; yaw: number; pitch: number
  velocity: Vec3; burst: Vec3; feet: Vec3; fireTick?: number; arrivalTick?: number
}
export interface EnemyWindOptions { arena: WindArena; startTick?: number; maxShots?: number; allies?: WindReport[]; delays?: number[]; reactAfterHit?: boolean; juggle?: boolean }

// Blast Protection has a separate attribute from netherite's ordinary knockback resistance; glint hides its level.
export function windResistance(foe: any): { lo: number; hi: number } {
  const armor = (foe.equipment || []).slice(2, 6).map(visiblePlayerItem)
  const unknown = Math.max(0, Math.min(4, foe._ndUnknownArmorSlots || 0))
  return { lo: 0, hi: Math.min(1, .6 * (unknown + armor.filter(it => it?.enchanted).length)) }
}

function bodyState(bot: any, body: WindReport | any) {
  const entity = { position: vec(body.position), velocity: vec(body.velocity), onGround: !!body.onGround,
    yaw: body.yaw || 0, pitch: 0, effects: body.effects || {}, attributes: body.attributes || {}, _ndPoseHeight: body.height || 1.8 }
  return edges.stateOf({ ...bot, entity, food: 20, inventory: { slots: [], items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 }, { ...edges.IDLE, ...body.control })
}

/** Radio snapshots have their own server tick; never silently treat an old ally pose as current. */
export function windReportAt(bot: any, report: WindReport, gameTick: number): WindReport | null {
  if (!Number.isSafeInteger(report?.gameTick) || !Number.isSafeInteger(gameTick) ||
      gameTick < report.gameTick! || gameTick - report.gameTick! > 20 || !finite(report.position) || !finite(report.velocity)) return null
  if (report.gameTick === gameTick) return { ...report, position: { ...report.position }, velocity: { ...report.velocity } }
  const state = bodyState(bot, report), world = edges.worldOf(observedCollision(bot)), simulate = edges.simOf(bot)
  for (let tick = report.gameTick!; tick < gameTick; tick++) simulate(state, world)
  return { ...report, position: { ...state.pos }, velocity: { ...state.vel }, onGround: state.onGround, yaw: state.yaw, gameTick }
}

// ProjectileUtil.computeMargin, AbstractHurtingProjectile.tick/setPos, AbstractWindCharge.onHitEntity (1.21.11).
function bodyHit(origin: Vec3, direction: Vec3, length: number, feet: Point, age: number, width = .6, height = 1.8) {
  const margin = Math.max(0, Math.min(Math.fround(.3), (age - 2) / 20)), half = width / 2 + margin
  return pick.rayBox(origin, direction, { x: feet.x - half, y: feet.y - margin, z: feet.z - half },
    { x: feet.x + half, y: feet.y + height + margin, z: feet.z + half }, length)
}

function segment(bot: any, foe: any, feet: Point, from: Vec3, velocity: Vec3, age: number, owner?: string, tick = age) {
  const origin = from.plus(velocity.scaled(age - 1)), length = velocity.norm(), direction = velocity.scaled(1 / length)
  let unknown = false
  const world = { blockAt(p: Vec3) { const b = bot.blockAt(p, false); if (!b) unknown = true; return b } }
  const block = pick.blockOnRay(world, origin, direction, length)
  if (unknown) return { blocked: true }
  const hit = bodyHit(origin, direction, length, feet, age, foe.width, foe.height)
  if (block && (hit === null || block.t < hit)) return { blocked: true }
  for (const entity of [bot.entity, ...Object.values(bot.entities || {})] as any[]) {
    if (entity === bot.entity && bot._ndWindOwnReported) continue
    if (!entity?.position || entity.id === foe.id || entity.username === owner || entity.id === bot.entity?.id && bot.entity?.username === owner ||
        !(entity.username || entity.type === 'player' || entity.type === 'mob')) continue
    if (!entity._ndReportedAlly && entity !== bot.entity && !pick.canHit(bot, entity, { range: 64 })) continue
    const position = entity._ndWindFrames ? entity._ndWindFrames[tick]?.pos : entity.position
    if (!position) return { blocked: true }
    const other = bodyHit(origin, direction, length, position, age, entity.width, entity.height)
    if (other !== null && (hit === null || other < hit)) return { blocked: true }
  }
  if (hit === null) return { blocked: false }
  return { blocked: false, burst: origin.plus(direction.scaled(hit)) }
}

/** Aimed entity hit, including gravity in the supplied native body frames; no invented air detonation point. */
export function enemyWindShot(bot: any, foe: any, report: WindReport, frames: Frame[], { fireDelay = 0, height = 1.4, allies = [] as WindReport[] } = {}): EnemyWindShot | null {
  if (!finite(report.position) || !finite(report.velocity) || !frames.length || !Number.isSafeInteger(fireDelay) || fireDelay < 0) return null
  if (allies.length) {
    const now = worldTick(bot)
    if (now === null) return null
    const team = allies.map(ally => windReportAt(bot, ally, now))
    if (team.some(ally => !ally)) return null
    const world = edges.worldOf(observedCollision(bot))
    bot = teamWorld({ ...bot, blockAt: p => world.getBlock(p) }, team, new Map())
  }
  const from = vec(report.position).offset(0, report.eyeHeight || 1.62, 0), moved = vec(report.velocity)
  if (report.onGround) moved.y = 0
  let flight = from.distanceTo(frames[Math.min(fireDelay, frames.length - 1)].pos) / WIND.speed, launch, aim: Vec3
  for (let iter = 0; iter < 4; iter++) {
    const at = frames[Math.min(frames.length - 1, fireDelay + Math.max(1, Math.ceil(flight)))]
    aim = at.pos.offset(0, Math.min(height, (foe.height || 1.8) - .05), 0)
    launch = windLaunch(from, aim, moved); if (!launch) return null
    flight = launch.time
  }
  for (let age = 1; age <= Math.min(30, frames.length - fireDelay - 1); age++) {
    const at = frames[fireDelay + age], hit = segment(bot, foe, at.pos, from, launch.velocity, age, report.id, fireDelay + age)
    if (hit.blocked) return null
    if (hit.burst) {
      if (age > 5 && (require('../mace') as typeof import('../mace')).shieldAtUs(bot, foe, report.position)) return null
      return { thrower: report.id, fireDelay, ticks: age, from, aim: aim!, yaw: launch.yaw, pitch: launch.pitch,
        velocity: launch.velocity, burst: hit.burst, feet: at.pos.clone() }
    }
  }
  return null
}

/** Forecast every affected ally's whole body; proximity alone is neither permission nor a veto. */
export function windTeamSafe(bot: any, allies: WindReport[], shots: Array<Pick<EnemyWindShot, 'ticks' | 'burst'> & { fireDelay?: number }>, arena?: WindArena, tracks = new Map<WindReport, Frame[]>(), requireLanding = false): boolean {
  const world = edges.worldOf(bot), simulate = edges.simOf(bot)
  const minimumImpulse = requireLanding ? 1e-9 : .01
  for (const ally of allies) {
    if (!finite(ally.position) || !finite(ally.velocity)) return false
    const proxy = { ...bot, entity: { attributes: ally.attributes || {} } }
    const track = teamFrames(bot, ally, tracks)
    if (!shots.some(shot => {
      const at = track![(shot.fireDelay || 0) + shot.ticks]
      return at && windImpulse(proxy, at.pos, shot.burst, { eyeHeight: ally.eyeHeight || 1.62 }).norm() > minimumImpulse
    })) continue
    const state = bodyState(bot, ally)
    let affected = false, peak = state.pos.y, burstY = -Infinity, burstTick = -Infinity
    for (let tick = 1; tick <= 80; tick++) {
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

function teamFrames(bot: any, report: WindReport, tracks: Map<WindReport, Frame[]>): Frame[] {
  let frames = tracks.get(report)
  if (!frames) {
    const state = bodyState(bot, report), world = edges.worldOf(bot), simulate = edges.simOf(bot)
    frames = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
    for (let tick = 1; tick <= 65; tick++) { simulate(state, world); frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }) }
    tracks.set(report, frames)
  }
  return frames
}

function teamWorld(bot: any, team: WindReport[], tracks: Map<WindReport, Frame[]>) {
  const entities = { ...bot.entities }, snapshot = { ...bot, entities, _ndWindOwnReported: team.some(ally => ally.id === bot.entity.username) }
  for (const ally of team) entities[`wind:${ally.id}`] = { id: `wind:${ally.id}`, username: ally.id,
    type: 'player', position: vec(ally.position), width: .6, height: 1.8, _ndReportedAlly: true, _ndWindFrames: teamFrames(snapshot, ally, tracks) }
  return snapshot
}

function rollout(bot: any, foe: any, shots: EnemyWindShot[], arena: WindArena, resistance: number, accepted = 0) {
  const state = bodyState(bot, foe), simulate = edges.simOf(bot), world = edges.worldOf(bot)
  const frames: Frame[] = [{ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround }]
  const done = new Set<number>(), meleeResist = edges.resistOf(bot, foe)
  const impacts: Array<{ fireDelay: number; ticks: number; burst: Vec3 }> = []
  const initial = Math.max(Math.abs(state.pos.x - arena.x), Math.abs(state.pos.z - arena.z))
  let progress = 0, out = false, outTick = null, lastHurt = -Infinity, air = 0, landed = false
  for (let tick = 1; tick <= 65; tick++) {
    // The victim can steer back towards the arena: do not price an AFK trajectory as an unavoidable kill.
    // reactAfterHit: he cannot see the charge coming — until the first burst he keeps his own (unknown → no) input.
    if (!foe.reactAfterHit || impacts.length) {
      state.yaw = Math.atan2(state.pos.x - arena.x, state.pos.z - arena.z)
      state.control = { ...edges.IDLE, forward: true, sprint: true }
    } else state.control = { ...edges.IDLE }
    simulate(state, world)
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i], age = tick - shot.fireDelay
      if (done.has(i) || age <= 0 || age > 30) continue
      const hit = segment(bot, foe, state.pos, shot.from, shot.velocity, age, shot.thrower, tick)
      if (hit.blocked) { done.add(i); continue }
      if (!hit.burst) continue
      done.add(i)
      impacts.push({ fireDelay: shot.fireDelay, ticks: age, burst: hit.burst })
      if (accepted & (1 << i) && tick - lastHurt >= 10) {
        state.vel = edges.knockback(state.vel, edges.KB_HIT * (1 - meleeResist), -shot.velocity.x, -shot.velocity.z, state.onGround)
        lastHurt = tick
      }
      state.vel = state.vel.plus(windImpulse(bot, state.pos, hit.burst, { resistance, height: foe.height || 1.8 }))
    }
    frames.push({ pos: state.pos.clone(), vel: state.vel.clone(), onGround: state.onGround })
    // Air time until the first landing: how long the swarm can keep juggling him.
    if (!landed && state.onGround) landed = true; else if (!landed) air++
    progress = Math.max(progress, Math.max(Math.abs(state.pos.x - arena.x), Math.abs(state.pos.z - arena.z)) - initial)
    if (!out && (Math.abs(state.pos.x - arena.x) - .3 > arena.r || Math.abs(state.pos.z - arena.z) - .3 > arena.r)) { out = true; outTick = tick }
    // Below the arena's death line (dug hole, off the outer wall onto the far terrain) is the same result as leaving the square.
    if (state.pos.y < (arena.killY ?? -64) - 1) { if (!out) { out = true; outTick = tick } break }
  }
  return { frames, impacts, progress, out, ticks: outTick, position: state.pos.clone(), air }
}

function bounds(bot: any, foe: any, shots: EnemyWindShot[], arena: WindArena, resistance: number, team?: WindReport[], tracks?: Map<WindReport, Frame[]>) {
  let worst = rollout(bot, foe, shots, arena, resistance)
  if (team && !windTeamSafe(bot, team, worst.impacts, arena, tracks)) return null
  for (let mask = 1; mask < 1 << shots.length; mask++) {
    const run = rollout(bot, foe, shots, arena, resistance, mask)
    if (team && !windTeamSafe(bot, team, run.impacts, arena, tracks)) return null
    if (Number(run.out) < Number(worst.out) || run.out === worst.out && run.progress < worst.progress) worst = run
  }
  return worst
}

function enemyView(bot: any, raw: any) {
  const metadata: any[] = []; metadata[0] = raw.metadata?.[0]; metadata[8] = raw.metadata?.[8]
  const gear = raw._ndVisible === undefined ? observePlayerGear(bot, raw) : null
  // Скорость — по наблюдённым позициям (bow/track): сырой entity.velocity чужого игрока — из редких entity_velocity и
  // живёт, пока не придёт новый (стенд 24.10: сырая 0.49 вверх, на деле −0.17 — ждали ноги на 129.2, он был на 124;
  // заряды по летящему не попадали ни разу).
  const observedV = (require('../bow/track') as typeof import('../bow/track')).observedVelocity(raw)
  return { id: raw.id, username: raw.username, position: vec(raw.position), velocity: vec(observedV || raw.velocity || { x: 0, y: 0, z: 0 }),
    onGround: !!raw.onGround, width: raw.width || .6, height: raw.height || 1.8, yaw: raw.yaw, metadata,
    equipment: (gear?.equipment || raw.equipment || []).map(visiblePlayerItem), _ndUnknownArmorSlots: gear?.unknownArmorSlots ?? raw._ndUnknownArmorSlots ?? 0 }
}

/** Executor revalidation starts at the latest observed pose, never the old plan's extrapolated enemy state. */
export function enemyWindFrames(bot: any, raw: any, arena: WindArena, shots: EnemyWindShot[] = [], resistance = 0): Frame[] {
  if (!raw?.position || !seesPlayer(bot, raw)) return []
  const world = edges.worldOf(observedCollision(bot))
  const active = shots.map(shot => ({ ...shot, from: vec(shot.from), velocity: vec(shot.velocity) }))
  return rollout({ ...bot, blockAt: p => world.getBlock(p) }, enemyView(bot, raw), active, arena, Math.max(0, Math.min(1, resistance))).frames
}

/** One small receding chain: different ready throwers, distinct arrivals, exact native projectile/body forecasts. */
export function planEnemyWind(bot: any, raw: any, reports: WindReport[], options: EnemyWindOptions) {
  const now = worldTick(bot), arena = options?.arena
  if (now === null || !arena || !raw?.position || !seesPlayer(bot, raw)) return null
  const foe: any = enemyView(bot, raw)
  foe.reactAfterHit = !!options.reactAfterHit
  const resistance = windResistance(foe), observed = observedCollision(bot), world = edges.worldOf(observed)
  const allReports = [...new Map([...(options.allies || []), ...reports].map(r => [r.id, r])).values()]
  const team = allReports.map(report => windReportAt(bot, report, now))
  if (team.some(report => report === null)) return null
  const allyTracks = new Map<WindReport, Frame[]>()
  const snapshot = teamWorld({ ...bot, blockAt: p => world.getBlock(p) }, team, allyTracks)
  const ready = new Set(reports.map(r => r.id)), throwers = team.filter(r => ready.has(r.id))
  const outward = foe.position.minus(new Vec3(arena.x, foe.position.y, arena.z)); if (outward.norm()) outward.scale(1 / outward.norm())
  const rank = (r: WindReport) => { const d = foe.position.minus(vec(r.position)), distance = d.norm(); return distance - 10 * (distance ? d.dot(outward) / distance : 0) }
  throwers.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  const start = options.startTick ?? now + 2
  if (!Number.isSafeInteger(start) || start < now || start > now + 20) return null
  const baseline = rollout(snapshot, foe, [], arena, 0), shots: EnemyWindShot[] = []
  let nominal = baseline, tried = 0
  // shortcut: at most three ranked shooters per step and two delays/heights; replan the next observed trajectory instead of searching a battle.
  for (let step = 0; step < Math.min(3, options.maxShots ?? 2, throwers.length); step++) {
    let best: { shot: EnemyWindShot; run: ReturnType<typeof rollout>; score: number } | null = null
    for (const report of throwers.filter(r => !shots.some(s => s.thrower === r.id)).slice(0, 3)) {
      for (const delay of options.delays ?? [0, 2]) for (const height of [.4, 1.6]) {
        const shot = enemyWindShot(snapshot, foe, report, nominal.frames, { fireDelay: start - now + delay, height })
        tried++
        if (!shot || shots.some(s => s.fireDelay + s.ticks === shot.fireDelay + shot.ticks)) continue
        const trial = [...shots, shot]
        const run = bounds(snapshot, foe, trial, arena, resistance.lo, team, allyTracks)
        if (!run) continue
        // juggle: keeping him airborne longer is worth as much as a little outward progress — the next ally throws again.
        const value = (r: ReturnType<typeof rollout>) => Number(r.out) * 1000 + r.progress + (options.juggle ? .05 * r.air : 0)
        const score = value(run)
        if (score > value(nominal) + .01 && (!best || score > best.score)) best = { shot, run, score }
      }
    }
    if (!best) break
    shots.push(best.shot); nominal = best.run
    if (nominal.out) break
  }
  if (!shots.length) return null
  const worst = bounds(snapshot, foe, shots, arena, resistance.hi, team, allyTracks)
  if (!worst) return null
  const outcome = (r: ReturnType<typeof rollout>) => ({ out: r.out, progress: r.progress, ticks: r.ticks, position: r.position, air: r.air })
  return { target: foe.username || String(foe.id), targetAt: foe.position, gameTick: now, resistance, tried,
    shots: shots.map(s => ({ ...s, fireTick: now + s.fireDelay, arrivalTick: now + s.fireDelay + s.ticks })),
    baseline: outcome(baseline), nominal: outcome(nominal), worst: outcome(worst) }
}
