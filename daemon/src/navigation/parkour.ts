import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, containsWater, dimensions, groundedHazardClear, invalidateStands, shapeBoxes, standPositions, supportAt, waterEntries, type CollisionBlock, type CollisionWorld, type Point } from './geometry'
import { clearanceMargin, detour } from './shape-detour'
import { hasFallMitigation, landingDamage } from './landing'
import { supportRoute, forgetCell, landingKey, transitionKey, onClimbable, climbColumn, highRidge, WOOD_DOOR, type LandingOption, type RoutingDiagnostics } from './support-route'

export interface Control { forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sprint: boolean; sneak: boolean }
export interface State {
  pos: Vec3; vel: Vec3; yaw: number; pitch: number; control: Control; onGround: boolean;
  isInWeb: boolean; isInLava: boolean; isInWater: boolean; jumpQueued: boolean; jumpTicks: number;
  isCollidedHorizontally: boolean; isCollidedVertically: boolean
}
export interface Step { yaw: number; control: Control }
export interface WaterLaunch { ticks: number; yawOffset?: number; sprint?: boolean }
export interface MovementBot extends CollisionWorld {
  version: string; health?: number; food?: number;
  entity: { id?: number; position: Vec3; velocity: Vec3; yaw: number; pitch: number; onGround: boolean; isInWeb?: boolean; isInLava?: boolean; isInWater?: boolean; attributes?: Record<string, { value: number }> };
  physics: NonNullable<CollisionWorld['physics']> & { stepHeight?: number; simulatePlayer(state: State, world: { getBlock(p: Vec3): ReturnType<CollisionWorld['blockAt']> }): State };
  _ndSimOrig?: MovementBot['physics']['simulatePlayer'];
  _ndParkourForecast?: { from: Point; next?: Point; until: number; hp: number }
  _client?: { on(event: string, listener: Parameters<import('node:events').EventEmitter['on']>[1]): unknown; removeListener(event: string, listener: Parameters<import('node:events').EventEmitter['removeListener']>[1]): unknown }
  _ndReflexSession?: { tactics?: { snapshot(): { state?: { enemies: Array<{ threatening: boolean }> } | null } } }
  _ndClutch?: { stats: { water_saved: number }; waterPlan?: unknown; peak?: number | null; forecast?: unknown }
  setControlState(key: keyof Control, value: boolean): void;
  clearControlStates(): void;
  look(yaw: number, pitch: number, force?: boolean): Promise<void>;
  waitForTicks(ticks: number): Promise<void>;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  pathfinder?: { setGoal(goal: null): void };
  emit?(event: string, value: unknown): void
  canSeeBlock?(block: CollisionBlock): boolean
  world?: { raycast(from: Vec3, direction: Vec3, distance: number, match: (block: CollisionBlock, iterator: { intersect(shapes: CollisionBlock['shapes'], position: Point): boolean }) => boolean): unknown }
}
export interface Cancellation { aborted: boolean; onAbort?: Array<() => void> }
export interface PlanningDiagnostics { why?: string; frames: number; profiles: number; closest?: { pos: Point; vel: Point; onGround: boolean; distance: number }; workMs?: number; reboundCeiling?: number; momentum?: { runway: Point; entry: Point; contact: Point; contactTick: number } }
/** `maxFrames` bounds planning by native forecast ticks: deterministic at any server tick rate and machine load. `planningMs` is a wall-clock cap. */
export interface JumpOptions { beam?: number; maxTicks?: number; tolerance?: number; web?: boolean; sprint?: boolean; allowWalk?: boolean; planningMs?: number; maxFrames?: number; diagnostics?: PlanningDiagnostics; bounce?: Point; chain?: Point[]; climb?: Point; maxFallDamage?: number }
/** Forecast-tick budget of one routed landing (≈180 ms of the former wall budget on an idle core). */
export const ROUTE_FRAMES = 6000
/** Default forecast-frame cap of one standalone jump (a wall-around needs ~31k): deterministic, never unbounded. */
export const JUMP_FRAMES = 60000
/**
 * Game-time horizon readers see on a live ownership marker. A marker is valid
 * while its owner holds it: every owner deletes it on exit, and position (0.1
 * block from the last observed or next forecast frame) and health void it at
 * once. Its `until` therefore never lapses by game time alone: at 750 TPS the
 * client can run one physics frame per 11+ server ticks (Author49: a refreshed
 * 500 ms marker lapsed between two frames of a jump over lava, the reflex took
 * the body and released its keys — it fell into the lava and died).
 */
export const FORECAST_TTL_MS = 2000
/** Ownership marker of a verified native trajectory, live until its owner removes it. */
export function forecastOwner(from: Point, hp: number, next: Point = from): NonNullable<MovementBot['_ndParkourForecast']> {
  const clock = require('../game-clock') as { now(): number }
  return { from: { ...from }, next: { ...next }, hp, get until() { return clock.now() + FORECAST_TTL_MS } }
}
/** A budget-refused route edge is retried once with this many times the frames, after cheaper alternatives. */
/** Radius of the one-off wide support graph when the 24-block disc cannot reach the goal. */
const WIDE_RADIUS = 40
const DEFERRED_SCALE = Number(process.env.ND_ROUTE_DEFERRED_SCALE ?? 4); const DEFERRED_COST = Number(process.env.ND_ROUTE_DEFERRED_COST ?? 8)
// allowDamage (спуск по уступам, descent.ts): урон падения не больше damage после тика посадки — не отказ; без сверки
// квитанции с точкой прогноза (тело тормозит на уступе — позиция уходит от прогноза дальше 0.1, и `fall` отвергал посадку).
export interface JumpPlan { steps: Step[]; states: State[]; target: Point; ticks: number; fall?: { damage: number; support: Point; supportName: string; tick: number; pos: Point }; allowDamage?: { damage: number; tick: number } }
interface TrajectorySample {
  tick: number; pos: Point; velocity: Point; onGround: boolean; hp?: number;
  expected: { pos: Point; velocity: Point; onGround: boolean; jumpQueued: boolean; jumpTicks: number };
  observation?: { actual: ReturnType<typeof bodyObservation>; expected: ReturnType<typeof bodyObservation> }
}
const { PlayerState } = require('../tick-plugins').getPhysics() as { PlayerState: new(bot: MovementBot, control: Control) => State }
export const IDLE: Control = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
const flat = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z)
const controls = (extra: Partial<Control> = {}): Control => ({ ...IDLE, ...extra })
function clone(st: State): State { return Object.assign(Object.create(Object.getPrototypeOf(st)) as State, st, { pos: st.pos.clone(), vel: st.vel.clone(), control: { ...st.control } }) }
function worldOf(bot: MovementBot) {
  const cells = new Map<string, ReturnType<CollisionWorld['blockAt']>>()
  return { getBlock(p: Vec3) {
    const q = p.floored(); const key = `${q.x},${q.y},${q.z}`
    if (!cells.has(key)) cells.set(key, bot.blockAt(q, false))
    return cells.get(key)
  } }
}
function geometryOf(bot: MovementBot, world: ReturnType<typeof worldOf>): CollisionWorld {
  return { blockAt: p => world.getBlock(p), physics: bot.physics, game: bot.game }
}
export function visibleLanding(bot: MovementBot, target: Point, geometry: CollisionWorld = bot): boolean {
  const support = supportAt(geometry, target, .04)
  if (!support) return false
  if (!bot.world) return !bot.canSeeBlock || bot.canSeeBlock(support.block)
  // The center of a distant floor block is buried behind its near neighbour.
  // Observe the real exposed landing surface rather than the block's center.
  const from = bot.entity.position.offset(0, 1.62, 0)
  const to = new Vec3(target.x, target.y + .015, target.z); const delta = to.minus(from); const distance = delta.norm()
  try { return !bot.world.raycast(from, delta.normalize(), distance, (block, iterator) => !!block && iterator.intersect(block.shapes, block.position)) } catch { return false }
}
function simulator(bot: MovementBot) { return (bot._ndSimOrig ?? bot.physics.simulatePlayer).bind(bot.physics) }
const reboundApexes = new WeakMap<object, Map<string, number>>()
/**
 * Highest feet Y after one unobstructed rebound from this spring, for a walk-off
 * or a jump from `fromY`. Vertical integration does not depend on horizontal
 * travel; any wall can only lower it. Native integrator over the spring layer only.
 */
export function reboundApex(bot: MovementBot, spring: Point, fromY: number, jump: boolean): number {
  const support = supportAt(bot, spring, .04)
  if (support?.block.name !== 'slime_block' || fromY < support.top) return -Infinity
  const cache = reboundApexes.get(bot.physics) ?? new Map<string, number>()
  reboundApexes.set(bot.physics, cache)
  const key = `${support.top},${Math.round((fromY - support.top) * 4096)},${jump}`
  const known = cache.get(key)
  if (known !== undefined) return known
  const slime = support.block; const layer = Math.floor(slime.position.y)
  const world = { getBlock: (p: Vec3) => { const q = p.floored(); return q.y === layer ? Object.assign(Object.create(Object.getPrototypeOf(slime)) as CollisionBlock, slime, { position: q }) : null } }
  const state = new PlayerState(bot, controls()); const sim = simulator(bot)
  state.pos = new Vec3(Math.floor(spring.x) + .5, fromY, Math.floor(spring.z) + .5); state.vel = new Vec3(0, 0, 0)
  state.onGround = jump; state.jumpTicks = 0; state.jumpQueued = false
  let bounced = false; let apex = -Infinity
  for (let tick = 0; tick < 400; tick++) {
    state.control = controls({ jump: jump && tick === 0 }); sim(state, world)
    if (!bounced) bounced = state.onGround && state.vel.y > 0
    else if (state.vel.y > 0) apex = Math.max(apex, state.pos.y)
    else { apex = Math.max(apex, state.pos.y); break }
  }
  cache.set(key, apex)
  return apex
}
/** Feet apex after a spring chain: each later spring is entered falling from the previous apex. */
export function chainApex(bot: MovementBot, springs: readonly Point[], fromY: number, jump: boolean): number {
  let y = fromY
  for (const [i, spring] of springs.entries()) y = reboundApex(bot, spring, y, i === 0 && jump)
  return y
}
function safeFallCost(bot: MovementBot, damage: number): boolean {
  try {
    const tactical = bot._ndReflexSession?.tactics?.snapshot()
    if (tactical && (!tactical.state || tactical.state.enemies.some(enemy => enemy.threatening))) return false
    const safety = require('../combat-safety').inspect(bot, { minHealth: 12 })
    return safety.action === 'fight' && safety.threats.length === 0 && (bot.health ?? 0) - damage > safety.threshold
  } catch { return false }
}
/**
 * Accepted fall damage of one planned landing. 1 HP: only onto a mitigating floor (hay, honey) from a walk-off.
 * 2..MAX_FALL_DAMAGE (explicit, e.g. a map drop with no mitigator — CP28 house → islands is 6–7 blocks): any
 * non-hazard floor, still only with full safety (no threats, health above the combat-safety threshold after it)
 * and the typed fall damage receipt at the forecast landing.
 */
export const MAX_FALL_DAMAGE = 4
function fallBudget(bot: MovementBot, requested?: number): number {
  const want = Math.min(MAX_FALL_DAMAGE, Math.floor(requested ?? 0))
  return want >= 1 && safeFallCost(bot, want) ? want : 0
}
export function simulatePlan(bot: MovementBot, steps: readonly Step[], observe?: (state: State) => void, initial?: State): State {
  const state = initial ? clone(initial) : new PlayerState(bot, controls()); const world = worldOf(bot); const sim = simulator(bot)
  for (const step of steps) { state.yaw = step.yaw; state.control = { ...step.control }; sim(state, world); observe?.(state) }
  return state
}
function onTarget(bot: CollisionWorld, state: State, target: Point, tolerance: number): boolean {
  return state.onGround && Math.abs(state.pos.y - target.y) < .03 && flat(state.pos, target) < tolerance && !!supportAt(bot, state.pos, .04) && bodyClear(bot, state.pos)
}
export function settledLanding(bot: MovementBot, state: Pick<State, 'pos' | 'vel' | 'onGround'>, target: Point, tolerance = .35): boolean {
  const support = supportAt(bot, state.pos, .02)
  return state.onGround && state.vel.y <= 0 && Math.hypot(state.vel.x, state.vel.z) < .035 && flat(state.pos, target) < tolerance &&
    state.pos.y >= target.y - .03 && state.pos.y <= target.y + (bot.physics.stepHeight ?? 0) + .03 &&
    !!support && Math.abs(support.top - state.pos.y) < .02 && bodyClear(bot, state.pos)
}
function rest(bot: MovementBot, state: State, world: ReturnType<typeof worldOf>, tolerance: number, target: Point): { steps: Step[]; states: State[] } | null {
  const sim = simulator(bot); const st = clone(state); const steps: Step[] = []; const states: State[] = []
  const geometry = geometryOf(bot, world)
  for (let i = 0; i < 6; i++) {
    const step = { yaw: st.yaw, control: controls({ sneak: true }) }
    st.control = step.control; sim(st, world)
    if (!onTarget(geometry, st, target, tolerance)) return null
    steps.push(step); states.push(clone(st))
  }
  return Math.hypot(st.vel.x, st.vel.z) < .035 ? { steps, states } : null
}

function* directSearch(bot: MovementBot, target: Point, opts: JumpOptions, world: ReturnType<typeof worldOf>, route: ReturnType<typeof detour>): Generator<void, JumpPlan | null> {
  const sim = simulator(bot); const geometry = geometryOf(bot, world)
  const base = new PlayerState(bot, controls()); let slice = performance.now() + .25
  const budget = fallBudget(bot, opts.maxFallDamage)
  const reboundRises = new Map<number, number>(); let observedCeiling = -Infinity
  const contact = opts.bounce ?? opts.climb
  // Springs in contact order: a chain falls from one rebound onto the next slime
  // (CP25: sponge top → slime 149 → slime 148 → plateau 151).
  const springs = opts.bounce ? [opts.bounce, ...(opts.chain ?? [])] : []
  // A launch family whose unobstructed native rebound stays below the landing
  // cannot reach it with any run-up or steering; refuse it before enumeration.
  const springLaunch = opts.bounce ? [false, true].filter(jump => chainApex(bot, springs, base.pos.y, jump) + (bot.physics.stepHeight ?? 0) >= target.y) : []
  if (opts.bounce && !springLaunch.length) {
    if (opts.diagnostics) { opts.diagnostics.why = 'rebound_ceiling'; opts.diagnostics.reboundCeiling = Math.max(chainApex(bot, springs, base.pos.y, false), chainApex(bot, springs, base.pos.y, true)) + (bot.physics.stepHeight ?? 0) }
    return null
  }
  // A ladder's thin native shape leaves less than the ordinary route cushion
  // beside its center. Use the actual body boundary for the catch, and let every
  // native forecast frame verify clearance before any controls are executed.
  const contactRoute = contact ? detour(geometry, bot.entity.position, contact, opts.climb ? 0 : .03) : null
  const springRoutes = springs.map((spring, i) => i ? detour(geometry, springs[i - 1], spring, .03) : contactRoute!)
  const extended = !!contact || flat(base.pos, target) > 4 && route(base.pos).distance <= flat(base.pos, target) + .5
  // Cheap native control profiles handle ordinary local landings before the
  // beam. Steering toward a predicted stopping position also removes initial
  // lateral speed; the integrator supplies the acceleration and friction.
  const spanSteps = Math.max(2, Math.ceil(flat(base.pos, target) * 4))
  // Powder snow on the straight approach slows a walk to ~0.11 block/tick; give
  // such an edge the full 60-tick horizon (still below the 140-tick freeze) and
  // try jumps and sprinting first: the unmodelled freeze speed malus (LivingEntity.tryAddFrost)
  // grows with time inside (s6-pk-powder2: slow 64-tick walks fell 0.3 block short).
  let powderPath = false
  for (let i = 0; i <= spanSteps && !powderPath; i++) {
    const t = i / spanSteps
    powderPath = geometry.blockAt(new Vec3(base.pos.x + (target.x - base.pos.x) * t, base.pos.y + (target.y - base.pos.y) * t, base.pos.z + (target.z - base.pos.z) * t).floored(), false)?.name === 'powder_snow'
  }
  const horizon = Math.min(contact ? 180 : 60, Math.max(powderPath ? Number(process.env.ND_POWDER_HORIZON ?? 45) : 0, opts.maxTicks ?? (opts.climb ? 180 : contact ? 90 : 38)))
  let quickest: JumpPlan | null = null
  let continuous = !!opts.allowWalk && Math.abs(target.y - base.pos.y) < .2
  for (let i = 1; continuous && i <= spanSteps; i++) {
    const t = i / spanSteps; const at = new Vec3(base.pos.x + (target.x - base.pos.x) * t, base.pos.y + (target.y - base.pos.y) * t, base.pos.z + (target.z - base.pos.z) * t)
    continuous = !!supportAt(geometry, at, .08) && bodyClear(geometry, at, { powder: true })
  }
  // A rise within the native step height (snow layers, slabs, carpets) is an
  // ordinary walk as well; the forecast verifies every stepped frame.
  const stepped = !!opts.allowWalk && target.y - base.pos.y <= (bot.physics.stepHeight ?? 0) + 1e-6
  const launches = continuous || stepped || target.y < base.pos.y - .2 ? powderPath ? [true, false] : [false, true] : [true]
  let edgeRunup = 0
  if (opts.bounce && (bot.food ?? 20) > 6 && opts.sprint !== false) {
    // Prioritise the existing profile that jumps from the last supported part
    // of this observed approach. The native integrator supplies its run-up;
    // this ordering earns no speed and every final trajectory is still checked.
    const approach = clone(base)
    for (let tick = 0; tick < 10; tick++) {
      const waypoint = contactRoute!(approach.pos).waypoint
      const dx = waypoint.x - approach.pos.x - approach.vel.x
      const dz = waypoint.z - approach.pos.z - approach.vel.z
      approach.yaw = Math.atan2(-dx, -dz); approach.control = controls({ forward: true, sprint: true }); sim(approach, world)
      if (!approach.onGround || !supportAt(geometry, approach.pos, .04) || !bodyClear(geometry, approach.pos)) break
      edgeRunup = tick + 1
    }
  }
  // A slime landing bounces unless sneak is held at the contact tick (native
  // and vanilla isSuppressingBounce); crouch only on the final descent.
  const springTarget = supportAt(geometry, target, .04)?.block.name === 'slime_block'
  const runups = extended ? [0, 2, 4, 6, 1, 3, 5, 7, 8, 10] : [0, 2, 4, 6]
  const nearEdge = [Math.max(0, edgeRunup - 1), edgeRunup]
  const orderedRunups = opts.bounce ? [...new Set([...nearEdge, ...runups])] : runups
  for (const jump of opts.bounce ? [true, false].filter(jump => springLaunch.includes(jump)) : launches) for (const runup of jump ? orderedRunups : [0]) for (const sprint of opts.bounce || powderPath ? [true, false] : [false, true]) for (const airSprint of extended ? opts.bounce ? [true, false] : [false, true] : [false]) for (const coast of extended ? opts.bounce ? [0, 2, 4, 6, 8, 1] : [2, 4, 6, 8, 0, 1] : [2, 4, 6, 8]) {
    if (opts.diagnostics) opts.diagnostics.profiles++
    if (sprint && (opts.sprint === false || (bot.food ?? 20) <= 6)) continue
    const state = clone(base); const steps: Step[] = []; const states: State[] = []
    let airborne = false; let fallDistance = 0; let contacted = false; let fall: JumpPlan['fall']; let hit = 0
    for (let tick = 0; tick < horizon; tick++) {
      if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
      const spring = hit < springs.length ? springs[hit] : null
      const destination = spring ?? (contact && !contacted ? contact : target)
      const waypoint = (spring ? springRoutes[hit] : contactRoute && !contacted ? contactRoute : route)(state.pos).waypoint
      const braking = flat(waypoint, destination) < .01 ? state.onGround && state.vel.y <= 0 ? 1 : coast : 0
      const dx = waypoint.x - state.pos.x - state.vel.x * braking
      const dz = waypoint.z - state.pos.z - state.vel.z * braking
      const yaw = Math.atan2(-dx, -dz)
      // Settle (sneak, stop sprinting) only on the target's level: an intermediate higher step (CP28 roof: jump onto a
      // slab 166.5, then step down to 166) must stay walkable, sneaking there pins the body to the slab edge.
      const settled = airborne && state.onGround && state.vel.y <= 0 && Math.abs(state.pos.y - target.y) < .03
      const damping = springTarget && airborne && (!contact || contacted) && state.vel.y < 0 && state.pos.y < target.y + 1.25
      // Sneak-centering after a landing would crawl through powder snow at 0.3x
      // (s6-pk-powder5: 47 ticks of sneaking fell 0.3 block short); walk out instead.
      const settledOutside = settled && !(powderPath && geometry.blockAt(state.pos.floored(), false)?.name === 'powder_snow')
      const step = { yaw, control: controls({ forward: Math.hypot(dx, dz) > .025, sprint: sprint && (!airborne || airSprint) && !settled && !damping, sneak: settledOutside || damping,
        jump: jump && tick === runup || !!opts.climb && onClimbable(geometry, state.pos) }) }
      const previous = state.pos.clone(); state.yaw = yaw; state.control = step.control; sim(state, world)
      noteForecast(opts.diagnostics, state, target)
      airborne ||= !state.onGround; fallDistance += Math.max(0, previous.y - state.pos.y)
      if (opts.climb && onClimbable(geometry, state.pos)) { contacted = true; fallDistance = 0 }
      // LivingEntity.handleOnClimbable and Entity.makeStuckInBlock reset the fall.
      else if (onClimbable(geometry, state.pos) || state.isInWeb) fallDistance = 0
      if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < Math.min(base.pos.y, target.y, ...springs.map(p => p.y)) - .4 || !bodyClear(geometry, state.pos, { web: opts.web, powder: true }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) break
      if (state.onGround) {
        const support = supportAt(geometry, state.pos, .04)
        const damage = support ? landingDamage(support.block, fallDistance, bot.entity.attributes) : 0
        if (damage > 0) {
          if (!support || damage > budget || fall || contact || target.y >= base.pos.y || budget <= 1 && (jump || !hasFallMitigation(support.block))) break
          fall = { damage, support: { ...support.block.position }, supportName: support.block.name, tick: steps.length, pos: { ...state.pos } }
        }
        if (opts.bounce && support?.block.name === 'slime_block' && state.vel.y > .1) {
          // Only the expected spring advances the chain; any other slime is plain physics.
          if (hit < springs.length && flat(state.pos, springs[hit]) < 1.8 && Math.abs(support.top - springs[hit].y) < .05) hit++
          contacted = hit === springs.length
          if (opts.diagnostics) {
            // The observed spring contact supplies its actual native velocity.
            // An obstacle-free coast is an optimistic height bound, never an
            // executable trajectory. It avoids retrying higher destinations
            // after all bounded launch profiles have already been exhausted.
            let rise = reboundRises.get(state.vel.y)
            if (rise === undefined) {
              const upward = clone(state); upward.control = controls(); upward.jumpQueued = false
              let top = upward.pos.y
              for (let i = 0; i < 40 && upward.vel.y > 0; i++) { sim(upward, { getBlock: () => null }); top = Math.max(top, upward.pos.y) }
              rise = upward.vel.y > 0 ? Infinity : top - state.pos.y
              reboundRises.set(state.vel.y, rise)
            }
            observedCeiling = Math.max(observedCeiling, state.pos.y + rise + (bot.physics.stepHeight ?? 0))
            opts.diagnostics.reboundCeiling = observedCeiling
          }
        }
        fallDistance = 0
      }
      steps.push(step); states.push(clone(state))
      if ((!contact || contacted) && (airborne || opts.allowWalk) && state.vel.y <= 0 && onTarget(geometry, state, target, opts.tolerance ?? .22)) {
        const stopping = rest(bot, state, world, opts.tolerance ?? .22, target)
        if (stopping) {
          const plan = { steps: [...steps, ...stopping.steps], states: [...states, ...stopping.states], target: { ...target }, ticks: steps.length + stopping.steps.length, ...(fall ? { fall } : {}) }
          // Through powder snow keep the quickest profile: time inside builds the freeze malus.
          if (!powderPath) return plan
          if (!quickest || plan.ticks < quickest.ticks) quickest = plan
          break
        }
      }
      // A jump often touches the near edge of a broad destination before its
      // center. Continue supported centering there, without another jump; a landing
      // on a step above the target (up to a jump) may also walk on and step down
      // (CP28 roof: slab 166.5 between 165.5 and the 166 floor).
      const above = state.pos.y - target.y
      // A near-level touch (path block, carpet: < .25) keeps the old rule and forces the jump families.
      const stepAbove = above >= .25 && above <= 1.25
      if (airborne && state.onGround && state.vel.y <= 0 && (stepAbove ? flat(state.pos, target) > 3 : Math.abs(above) > .03 || flat(state.pos, target) > 1.5)) break
    }
  }
  return quickest
}

function* momentumSearch(bot: MovementBot, target: Point, opts: JumpOptions, world: ReturnType<typeof worldOf>): Generator<void, JumpPlan | null> {
  const base = new PlayerState(bot, controls()); const span = flat(base.pos, target)
  if (!opts.allowWalk || opts.bounce || opts.climb || opts.sprint === false || (bot.food ?? 20) <= 6 || target.y <= base.pos.y + .2 || span < 3) return null
  const geometry = geometryOf(bot, world); const sim = simulator(bot); const targetSupport = supportAt(geometry, target, .04)
  if (!targetSupport) return null
  // Stopping on every floor center discards momentum. A loaded, supported
  // runway may instead earn two native jumps in one forecast; only the final
  // requested landing must stop. Never invent the intermediate velocity.
  const runways: Vec3[] = []; let slice = performance.now() + .25
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
    for (const at of standPositions(geometry, { x: Math.floor(base.pos.x) + dx, y: base.pos.y, z: Math.floor(base.pos.z) + dz }, { rise: .03, drop: .03 })) {
      const distance = flat(base.pos, at)
      if (distance < 1 || distance > 3.5 || flat(at, target) < span + .75) continue
      let connected = true
      for (let i = 1, count = Math.ceil(distance * 4); connected && i <= count; i++) {
        const t = i / count; const p = new Vec3(base.pos.x + (at.x - base.pos.x) * t, base.pos.y, base.pos.z + (at.z - base.pos.z) * t)
        connected = !!supportAt(geometry, p, .04) && bodyClear(geometry, p)
      }
      if (connected) runways.push(at)
    }
  }
  runways.sort((a, b) => flat(b, target) - flat(a, target))
  const { half } = dimensions(geometry); const box = targetSupport.box
  for (const runway of runways.slice(0, 3)) {
    const approachStats: PlanningDiagnostics | undefined = opts.diagnostics ? { frames: 0, profiles: 0 } : undefined
    const approach = yield* directSearch(bot, runway, { ...opts, allowWalk: true, diagnostics: approachStats }, world, detour(geometry, base.pos, runway))
    if (opts.diagnostics && approachStats) { opts.diagnostics.frames += approachStats.frames; opts.diagnostics.profiles += approachStats.profiles }
    if (!approach) continue
    const initial = approach.states[approach.states.length - 1]
    // Aim for the exposed part of the real support first, then center while
    // grounded. Requiring the far block center during flight wastes its edge.
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
    const entry = new Vec3(clamp(initial.pos.x, box.minX - half + .15, box.maxX + half - .15), target.y,
      clamp(initial.pos.z, box.minZ - half + .15, box.maxZ + half - .15))
    if (!bodyClear(geometry, entry) || !supportAt(geometry, entry, .04)) continue
    for (const runup of [0, 1, 2, 4]) for (const firstCoast of [0, 2, 4]) for (const coast of [0, 2, 4]) {
      if (opts.diagnostics) opts.diagnostics.profiles++
      const state = clone(initial); const steps: Step[] = [...approach.steps]; const states: State[] = [...approach.states]
      let airborne = false; let contacted = false; let secondAir = false; let jumpNext = false; let fallDistance = 0; let contact: Point | undefined; let contactTick = -1
      const maxTicks = Math.min(90, (opts.maxTicks ?? 38) * 2)
      for (let tick = 0; steps.length < maxTicks; tick++) {
        if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
        const centered = contacted && secondAir && state.onGround && Math.abs(state.pos.y - target.y) < .03
        const waypoint = centered ? target : entry; const braking = centered ? 1 : contacted ? coast : firstCoast
        const dx = waypoint.x - state.pos.x - state.vel.x * braking; const dz = waypoint.z - state.pos.z - state.vel.z * braking
        const step = { yaw: Math.atan2(-dx, -dz), control: controls({ forward: Math.hypot(dx, dz) > .025, sprint: !centered, sneak: centered, jump: jumpNext || tick === runup }) }
        jumpNext = false; const previous = state.pos.clone(); state.yaw = step.yaw; state.control = step.control; sim(state, world)
        noteForecast(opts.diagnostics, state, target); airborne ||= !state.onGround
        fallDistance += Math.max(0, previous.y - state.pos.y)
        if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < base.pos.y - .4 || !bodyClear(geometry, state.pos, { web: opts.web, powder: true }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) break
        if (state.onGround && state.vel.y <= 0) {
          // Native SELF movement clips Y before horizontal travel. Its real
          // contact can carry the body past the edge in that same tick; verify
          // the collided floor under the previous footprint as well.
          const support = supportAt(geometry, state.pos, .04) ?? supportAt(geometry, previous, Math.max(.04, previous.y - state.pos.y + .03))
          if (!support || Math.abs(support.top - state.pos.y) > .03 || landingDamage(support.block, fallDistance, bot.entity.attributes) > 0) break
          if (!contacted && airborne && state.isCollidedVertically && Math.abs(state.pos.y - initial.pos.y) < .03) { contacted = true; jumpNext = true; contact = { ...state.pos }; contactTick = steps.length }
          else if (contacted && secondAir && Math.abs(state.pos.y - target.y) > .03) break
          fallDistance = 0
        }
        if (contacted && !state.onGround) secondAir = true
        steps.push(step); states.push(clone(state))
        if (secondAir && state.vel.y <= 0 && onTarget(geometry, state, target, opts.tolerance ?? .22)) {
          const stopping = rest(bot, state, world, opts.tolerance ?? .22, target)
          if (stopping) {
            if (opts.diagnostics && contact) opts.diagnostics.momentum = { runway: { ...initial.pos }, entry: { ...entry }, contact, contactTick }
            return { steps: [...steps, ...stopping.steps], states: [...states, ...stopping.states], target: { ...target }, ticks: steps.length + stopping.steps.length }
          }
        }
      }
    }
  }
  return null
}

function* jumpSearch(bot: MovementBot, target: Point, opts: JumpOptions = {}, cancelled?: () => boolean): Generator<void, JumpPlan | null> {
  if (![target.x, target.y, target.z].every(Number.isFinite) || !bot.physics || !bot.entity?.onGround || bot.entity.isInLava || bot.entity.isInWater) { if (opts.diagnostics) opts.diagnostics.why = 'invalid_native_start'; return null }
  const column = opts.climb ? climbColumn(bot, opts.climb, cancelled, opts.planningMs) : null
  const springs = opts.bounce ? [opts.bounce, ...(opts.chain ?? [])] : []
  if (flat(bot.entity.position, target) > (opts.bounce ? 6 + 8 * springs.length : 6) || !opts.climb && target.y - bot.entity.position.y > 1.25 || !supportAt(bot, target, .04) || !bodyClear(bot, target) || springs.some(spring => supportAt(bot, spring, .04)?.block.name !== 'slime_block' || !bodyClear(bot, spring)) || opts.climb && (!column || column.top < Math.floor(target.y) || !bodyClear(bot, opts.climb))) { if (opts.diagnostics) opts.diagnostics.why = 'unsupported_or_obstructed_target'; return null }
  const tolerance = opts.tolerance ?? .22
  const world = worldOf(bot); const sim = simulator(bot)
  const geometry = geometryOf(bot, world); const route = detour(geometry, bot.entity.position, target)
  const direct = yield* directSearch(bot, target, opts, world, route)
  if (direct) return direct
  if (opts.bounce || opts.climb) return null
  const momentum = yield* momentumSearch(bot, target, opts, world)
  if (momentum) return momentum
  interface Node { state: State; steps: Step[]; states: State[]; jumped: boolean; airTicks: number; fallDistance: number; score: number }
  let nodes: Node[] = [{ state: new PlayerState(bot, controls()), steps: [], states: [], jumped: false, airTicks: 0, fallDistance: 0, score: flat(bot.entity.position, target) }]
  // ponytail: bounded native-physics beam, not a global A*. Use the route planner
  // for distant goals; this searches one local obstacle and one landing only.
  // Rounding a solid obstruction needs both run-up and return trajectories.
  // Allocate the existing bounded search capacity from the observed detour,
  // rather than let a cheap direct-hop budget prune every returning branch.
  const obstructed = route(bot.entity.position).distance > flat(bot.entity.position, target) + .5
  const beam = Math.max(obstructed ? 96 : 8, Math.min(96, opts.beam ?? 40)); const maxTicks = Math.min(60, opts.maxTicks ?? 38)
  let slice = performance.now() + .25
  for (let tick = 0; tick < maxTicks; tick++) {
    const next = new Map<string, Node>()
    for (const node of nodes) {
      const at = node.state.pos
      const waypoint = route(at).waypoint
      const targetYaw = Math.atan2(at.x - waypoint.x, at.z - waypoint.z)
      const headings = [targetYaw, ...Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)]
      const actions: Step[] = [{ yaw: node.state.yaw, control: controls() }, { yaw: node.state.yaw, control: controls({ sneak: true }) }]
      for (const yaw of headings) {
        actions.push({ yaw, control: controls({ forward: true, sprint: opts.sprint !== false && (bot.food ?? 20) > 6 }) })
        if (!node.jumped) actions.push({ yaw, control: controls({ forward: true, sneak: true }) })
        if (!node.jumped && node.state.onGround) actions.push({ yaw, control: controls({ forward: true, jump: true, sprint: opts.sprint !== false && (bot.food ?? 20) > 6 }) })
      }
      for (const step of actions) {
        // At 750 TPS a physics turn is only 1.33ms. Yield within the action
        // expansion, rather than after dozens of complete native forecasts.
        if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
        const state = clone(node.state); state.yaw = step.yaw; state.control = step.control
        sim(state, world)
        noteForecast(opts.diagnostics, state, target)
        const jumped = node.jumped || step.control.jump && state.vel.y > 0
        const airTicks = jumped ? node.airTicks + 1 : 0
        const fallDistance = state.isInWeb || onClimbable(geometry, state.pos) ? 0 : (node.state.onGround ? 0 : node.fallDistance) + Math.max(0, node.state.pos.y - state.pos.y)
        if (!jumped && !state.onGround && !supportAt(geometry, state.pos, .01)) continue
        if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < Math.min(bot.entity.position.y, target.y) - .4) continue
        if (!bodyClear(geometry, state.pos, { web: opts.web, powder: true }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) continue
        if (state.onGround) {
          const support = supportAt(geometry, state.pos, .04)
          if (support && landingDamage(support.block, fallDistance, bot.entity.attributes) > 0) continue
        }
        const steps = [...node.steps, step]; const states = [...node.states, clone(state)]
        if ((jumped || opts.allowWalk) && onTarget(geometry, state, target, tolerance)) {
          const stopping = rest(bot, state, world, tolerance, target)
          if (stopping) return { steps: [...steps, ...stopping.steps], states: [...states, ...stopping.states], target: { ...target }, ticks: steps.length + stopping.steps.length }
        }
        // Landing elsewhere ends this local jump. Supported centering on the
        // destination's actual plane is still part of this one landing.
        if (node.jumped && state.onGround && (Math.abs(state.pos.y - target.y) > .03 || flat(state.pos, target) > 1.5)) continue
        const local = route(state.pos)
        const dx = local.waypoint.x - state.pos.x; const dz = local.waypoint.z - state.pos.z
        const d = Math.hypot(dx, dz)
        const closing = d > .01 ? (state.vel.x * dx + state.vel.z * dz) / d : 0
        const score = local.distance - Math.min(.45, closing * 2) + Math.max(0, target.y - state.pos.y) * .6 + (jumped ? 0 : .25) + (state.isCollidedHorizontally ? .12 : 0)
        const key = `${Math.round(state.pos.x * 12)},${Math.round(state.pos.y * 12)},${Math.round(state.pos.z * 12)},${Math.round(state.vel.x * 20)},${Math.round(state.vel.z * 20)},${airTicks}`
        const old = next.get(key)
        if (!old || score < old.score) next.set(key, { state, steps, states, jumped, airTicks, fallDistance, score })
      }
    }
    // Keep sorting bounded per launch cohort as well as keeping the beam. One
    // large synchronous sort otherwise starves the accelerated physics clock.
    const cohorts = new Map<number, Node[]>()
    for (const node of next.values()) {
      const cohort = cohorts.get(node.airTicks) ?? []
      if (!cohorts.has(node.airTicks)) cohorts.set(node.airTicks, cohort)
      cohort.push(node)
    }
    const ordered: Node[] = []; const remaining: Node[] = []
    // Keep supported approach states alongside each air-time cohort; an early
    // jump may not crowd out the run-up needed to return behind a wall.
    for (const cohort of cohorts.values()) {
      yield; slice = performance.now() + .25
      cohort.sort((a, b) => a.score - b.score)
      const keep = Math.min(cohort.length, cohort[0].jumped ? obstructed ? 8 : 2 : obstructed ? Math.ceil(beam / 3) : 8)
      ordered.push(...cohort.slice(0, keep)); remaining.push(...cohort.slice(keep))
    }
    yield; slice = performance.now() + .25
    // Direct motion has a total budget. Explicit wall-around skills retain
    // their tested launch cohorts; routing can bound the time of one hard edge.
    nodes = [...ordered, ...remaining.sort((a, b) => a.score - b.score).slice(0, Math.max(0, beam - ordered.length))]
    if (process.env.ND_PARKOUR_DEBUG === '1') console.log('[parkour-search]', tick, nodes.slice(0, 2).map(n => ({ pos: n.state.pos, vel: n.state.vel, jumped: n.jumped, score: n.score })))
    if (!nodes.length) break
  }
  return null
}

export function planJump(bot: MovementBot, target: Point, opts: JumpOptions = {}): JumpPlan | null {
  const search = jumpSearch(bot, target, opts)
  for (;;) { const step = search.next(); if (step.done) return step.value }
}
/** Optimistic feet ceiling (apex + native step height) for any launch from `from` via this spring. */
export function reboundCeiling(bot: MovementBot, from: Point, spring: Point): number {
  return Math.max(reboundApex(bot, spring, from.y, false), reboundApex(bot, spring, from.y, true)) + (bot.physics.stepHeight ?? 0)
}
export async function planJumpAsync(bot: MovementBot, ctl: Cancellation, target: Point, opts: JumpOptions = {}): Promise<JumpPlan | null> {
  const diagnostics = opts.diagnostics ?? { frames: 0, profiles: 0 }
  const search = jumpSearch(bot, target, { ...opts, diagnostics }, () => ctl.aborted)
  let workMs = 0
  for (;;) {
    if (ctl.aborted || workMs > (opts.planningMs ?? Infinity) || diagnostics.frames > (opts.maxFrames ?? Infinity)) { diagnostics.why = ctl.aborted ? 'interrupted' : 'planning_budget'; return null }
    const began = performance.now(); const step = search.next(); workMs += performance.now() - began
    diagnostics.workMs = workMs
    if (step.done) return step.value
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function noteForecast(stats: PlanningDiagnostics | undefined, state: State, target: Point): void {
  if (!stats) return
  stats.frames++
  const distance = state.pos.distanceTo(new Vec3(target.x, target.y, target.z))
  if (!stats.closest || distance < stats.closest.distance) stats.closest = { pos: { ...state.pos }, vel: { ...state.vel }, onGround: state.onGround, distance }
}

function forecastStart(bot: MovementBot, target: Point) {
  const support = supportAt(bot, target, .04)
  return { native: new PlayerState(bot, controls()), targetClear: bodyClear(bot, target), targetSupport: support && {
    name: support.block.name, position: support.block.position, properties: support.block.getProperties?.(), shapes: support.block.shapes, top: support.top
  } }
}

// Capture the same loaded blocks the body controller sees, only on a refused
// execution. The layer below the feet distinguishes fluid-edge contact from a
// later damage receipt while the actual body has already moved upward again.
export function bodyObservation(bot: MovementBot, pos: Point) {
  const body = bodyBox(bot, pos); const cells: Array<{ position: Point; name?: string; properties?: Record<string, string | number | boolean>; shapes?: CollisionBlock['shapes']; loaded: boolean }> = []
  for (let x = Math.floor(body.minX); x <= Math.floor(body.maxX); x++) for (let z = Math.floor(body.minZ); z <= Math.floor(body.maxZ); z++) for (let y = Math.floor(body.minY) - 1; y <= Math.floor(body.maxY); y++) {
    const block = bot.blockAt(new Vec3(x, y, z), false)
    cells.push({ position: { x, y, z }, loaded: !!block, name: block?.name, properties: block?.getProperties?.(), shapes: block?.shapes })
  }
  return { body, clear: bodyClear(bot, pos), cells }
}

export async function executeJump(bot: MovementBot, ctl: Cancellation, target: Point, opts: JumpOptions = {}): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[]; planningMs: number; planningTicks?: number; forecast?: unknown }> {
  bot.pathfinder?.setGoal(null)
  bot.clearControlStates(); bot.setControlState('sneak', true)
  const start = forecastStart(bot, target); const diagnostics: PlanningDiagnostics = { frames: 0, profiles: 0 }
  const clock = require('../game-clock') as { now(): number }
  const began = performance.now(); const gameBegan = clock.now(); const plan = await planJumpAsync(bot, ctl, target, { maxFrames: JUMP_FRAMES, ...opts, diagnostics })
  // Wall time is this machine's CPU; game ticks are what the body stood still.
  const planningMs = performance.now() - began; const planningTicks = Math.round((clock.now() - gameBegan) / 50)
  if (!plan) return { ok: false, why: diagnostics.why ?? 'no_safe_native_trajectory', ticks: 0, samples: [], planningMs, planningTicks, forecast: { ...start, diagnostics, observation: {
    start: { at: { ...start.native.pos }, ...bodyObservation(bot, start.native.pos) },
    target: { at: { ...target }, ...bodyObservation(bot, target) },
    ...(opts.climb ? { climb: { at: { ...opts.climb }, ...bodyObservation(bot, opts.climb) } } : {}),
    ...(diagnostics.closest ? { closest: { at: { ...diagnostics.closest.pos }, ...bodyObservation(bot, diagnostics.closest.pos) } } : {})
  } } }
  // The forecast keeps an inner centering margin. Actual completion also checks
  // the full supported, collision-free body after six stopping ticks; a tiny
  // coordinate drift inside that safe footprint is not a failed landing.
  const result = await executePlan(bot, ctl, plan, st => onTarget(bot, st, target, opts.tolerance ?? .25))
  // A real step-height collision can settle on an adjacent partial top inside
  // the destination footprint. Macro routing may continue from that observed
  // support after six actual stable ticks; explicit targets remain exact.
  const last = result.samples.slice(-6) as Array<{ pos: Point; velocity: Point; onGround: boolean }>
  const adjusted = !result.ok && result.why === 'landing_not_confirmed' && opts.allowWalk && last.length === 6 && last.every(sample =>
    settledLanding(bot, { pos: new Vec3(sample.pos.x, sample.pos.y, sample.pos.z), vel: new Vec3(sample.velocity.x, sample.velocity.y, sample.velocity.z), onGround: sample.onGround }, target, Math.max(.35, opts.tolerance ?? .25)))
  return { ...result, ...(adjusted ? { ok: true, why: undefined } : {}), planningMs, planningTicks, forecast: { diagnostics, ...(plan.fall ? { fall: plan.fall } : {}), ...(adjusted ? { adjustedLanding: { ...bot.entity.position } } : {}) } }
}
export async function executePlan(bot: MovementBot, ctl: Cancellation, plan: JumpPlan, confirmed: (state: State) => boolean, completeWhen?: () => boolean): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[] }> {
  const samples: TrajectorySample[] = []; const hp = bot.health ?? 20
  if (plan.fall && (plan.fall.damage < 1 || plan.fall.damage > MAX_FALL_DAMAGE || !bot._client || !safeFallCost(bot, plan.fall.damage))) return { ok: false, why: 'unsafe_fall_cost', ticks: 0, samples }
  if (plan.allowDamage && (plan.allowDamage.damage > MAX_FALL_DAMAGE || !safeFallCost(bot, plan.allowDamage.damage))) return { ok: false, why: 'unsafe_fall_cost', ticks: 0, samples }
  const clock = require('../game-clock') as { now(): number }
  const previous = bot._ndParkourForecast
  const own = forecastOwner(bot.entity.position, hp)
  bot._ndParkourForecast = own
  bot.clearControlStates()
  let tick = 0; let lastHp = hp; let lost = 0; let fallReceipt = false
  return new Promise((resolve, reject) => {
    let done = false
    const clean = () => {
      bot.removeListener('physicsTick', onTick); bot.removeListener('end', abort); bot.removeListener('death', abort)
      if (plan.fall) { bot.removeListener('health', onHealth); bot._client?.removeListener('damage_event', onDamage) }
      const index = ctl.onAbort?.indexOf(abort) ?? -1
      if (index >= 0) ctl.onAbort!.splice(index, 1)
      if (bot._ndParkourForecast === own) { if (previous) bot._ndParkourForecast = previous; else delete bot._ndParkourForecast }
      if (!bot._ndClutch?.waterPlan) { bot.clearControlStates(); bot.setControlState('sneak', true) }
    }
    const finish = (ok: boolean, why?: string) => {
      if (done) return
      done = true
      const last = samples.at(-1)
      if (!ok && last) {
        last.observation = { actual: bodyObservation(bot, last.pos), expected: bodyObservation(bot, last.expected.pos) }
        Object.assign(last, { fallReflex: { at: clock.now(), position: { ...bot.entity.position },
          marker: bot._ndParkourForecast && { ...bot._ndParkourForecast }, forecast: bot._ndClutch?.forecast } })
      }
      clean(); resolve({ ok, why, ticks: tick, samples })
    }
    const fail = (error: unknown) => { if (!done) { done = true; clean(); reject(error) } }
    const abort = () => finish(false, 'interrupted')
    const landedOnForecast = () => {
      if (!plan.fall || tick <= plan.fall.tick) return false
      const expected = plan.states[Math.min(tick - 1, plan.states.length - 1)]; const p = bot.entity.position
      const support = supportAt(bot, p, .02)
      return bot.entity.onGround && bot.entity.velocity.y <= 0 && expected.onGround && p.distanceTo(expected.pos) <= .1 && bodyClear(bot, p) &&
        !!support && Math.abs(support.top - p.y) < .02 && support.block.name === plan.fall.supportName &&
        new Vec3(support.block.position.x, support.block.position.y, support.block.position.z).distanceTo(new Vec3(plan.fall.support.x, plan.fall.support.y, plan.fall.support.z)) < .01
    }
    const onHealth = () => {
      if (done || !plan.fall) return
      const current = bot.health ?? 0
      lost += Math.max(0, lastHp - current); lastHp = current
      if (!lost) return
      if (lost > plan.fall.damage || !landedOnForecast() || !safeFallCost(bot, 0)) { finish(false, 'hurt_during_trajectory'); return }
      // A health update may precede its typed fall packet. Hold this confirmed
      // floor within the existing six-tick resting window until both arrive.
      if (fallReceipt) own.hp = current
    }
    const onDamage = (packet: { entityId: number; sourceTypeId: number; sourceCauseId: number; sourceDirectId: number }) => {
      if (done || packet.entityId !== bot.entity.id) return
      if (fallReceipt || require('../gamedata').damageTypeName(packet.sourceTypeId) !== 'fall' || packet.sourceCauseId || packet.sourceDirectId || !landedOnForecast()) {
        finish(false, 'unexpected_damage_receipt'); return
      }
      fallReceipt = true; onHealth()
    }
    const applyStep = () => {
      const step = plan.steps[tick]
      // Mineflayer force-look updates the observed yaw synchronously. Awaiting
      // it here would hold old keys across a whole physics catch-up batch.
      void bot.look(step.yaw, 0, true).catch(fail)
      own.next = { ...plan.states[tick].pos }
      for (const key of Object.keys(IDLE) as Array<keyof Control>) bot.setControlState(key, step.control[key])
    }
    const onTick = () => {
      if (done) return
      try {
        if (ctl.aborted || (bot.health ?? 20) <= 0) { abort(); return }
        const frame = Math.min(tick, plan.steps.length - 1)
        const step = plan.steps[frame]; const expected = plan.states[frame]; tick++
        const p = bot.entity.position
        const sample = { tick, pos: { x: p.x, y: p.y, z: p.z }, onGround: bot.entity.onGround, isInWeb: !!bot.entity.isInWeb, isInWater: !!bot.entity.isInWater, isInLava: !!bot.entity.isInLava, velocity: { ...bot.entity.velocity }, hp: bot.health, yaw: step.yaw, control: step.control,
          expected: { pos: { ...expected.pos }, velocity: { ...expected.vel }, onGround: expected.onGround, jumpQueued: expected.jumpQueued, jumpTicks: expected.jumpTicks } }
        samples.push(sample)
        bot.emit?.('nd_parkour', samples[samples.length - 1])
        // Actual correction or damage invalidates this forecast immediately,
        // before another synchronous native tick can reuse its old controls.
        if (p.distanceTo(expected.pos) > .65) {
          Object.assign(sample, { divergence: p.distanceTo(expected.pos) })
          finish(false, 'physics_diverged'); return
        }
        if (plan.fall) { onHealth(); if (done) return }
        // Квитанция сервера может опередить посадку клиента на тик-два (s6c-desc-flex6, первый заход): допуск с тика посадки − 2.
        else if ((bot.health ?? hp) < hp && !(plan.allowDamage && tick >= plan.allowDamage.tick - 1 && hp - (bot.health ?? 0) <= plan.allowDamage.damage)) { finish(false, 'hurt_during_trajectory'); return }
        own.from = { ...p }
        if (completeWhen?.() && (!plan.fall || fallReceipt && lost > 0)) { const ok = confirmed(new PlayerState(bot, controls())); finish(ok, ok ? undefined : 'landing_not_confirmed'); return }
        if (tick < plan.steps.length) applyStep()
        else {
          if (plan.fall && (!fallReceipt || !lost)) {
            if (tick < plan.steps.length + 6) return
            finish(false, 'fall_damage_not_confirmed'); return
          }
          const ok = confirmed(new PlayerState(bot, controls())); finish(ok, ok ? undefined : 'landing_not_confirmed')
        }
      } catch (error) { fail(error) }
    }
    bot.on('physicsTick', onTick); bot.on('end', abort); bot.on('death', abort); ctl.onAbort?.push(abort)
    if (plan.fall) { bot.on('health', onHealth); bot._client?.on('damage_event', onDamage) }
    try {
      if (ctl.aborted || (bot.health ?? 20) <= 0) abort()
      else if (!plan.steps.length) { const ok = confirmed(new PlayerState(bot, controls())); finish(ok, ok ? undefined : 'landing_not_confirmed') }
      else {
        applyStep()
        // Receipt-bound motion can finish before the last forecast frame. Wait
        // one observed frame at a time so no abandoned waiter advances a fake
        // clock or retains the old stage across a native physics burst.
        const wait = completeWhen ? (async () => { while (!done) await bot.waitForTicks(1) })() : bot.waitForTicks(plan.steps.length + (plan.fall ? 6 : 0))
        // A stalled client frame under farm load (Author50, 654 TPS) must end this
        // edge with its samples, not discard the whole route report.
        void wait.catch((error: Error) => /Timeout waiting for game ticks/.test(String(error?.message)) ? finish(false, 'tick_wait_timeout') : fail(error))
      }
    } catch (error) { fail(error) }
  })
}

export function planWebCatch(bot: MovementBot, target: Point): JumpPlan | null {
  if (bot.entity.onGround || bot.entity.velocity.y >= -.08 || bot.blockAt(new Vec3(target.x, target.y, target.z))?.name !== 'cobweb') return null
  const base = new PlayerState(bot, controls()); const world = worldOf(bot); const sim = simulator(bot)
  const yaw = Math.atan2(base.pos.x - target.x, base.pos.z - target.z)
  // Already airborne: nine short forecasts, no A* or world-scale planning.
  for (const angle of [yaw, ...Array.from({ length: 8 }, (_, i) => i * Math.PI / 4), null]) {
    const state = clone(base); const steps: Step[] = []; const states: State[] = []
    let caught = 0
    for (let tick = 0; tick < 24; tick++) {
      const step = { yaw: angle ?? yaw, control: controls({ forward: angle !== null && !caught }) }
      state.yaw = step.yaw; state.control = step.control; sim(state, world)
      steps.push(step); states.push(clone(state))
      if (state.isInLava || state.onGround || state.pos.y < target.y - 1 || !bodyClear(bot, state.pos, { web: true })) break
      caught = state.isInWeb && Math.abs(state.vel.y) < .16 ? caught + 1 : 0
      if (caught >= 4) return { steps, states, target: { ...target }, ticks: steps.length }
    }
  }
  return null
}

export function inWaterCell(bot: CollisionWorld, state: State, cell: Point): boolean {
  const { half } = dimensions(bot)
  return state.isInWater && state.pos.x - half >= cell.x + .001 && state.pos.x + half <= cell.x + .999 &&
    state.pos.z - half >= cell.z + .001 && state.pos.z + half <= cell.z + .999 && state.pos.y < cell.y + .9 && state.pos.y >= cell.y - .02 &&
    bodyClear(bot, state.pos, { water: true })
}

/** Forecast earned launch momentum with the same air integrator and controller. */
/** `fallFrom`: the real start of an ongoing fall (higher than the initial frame); `maxDamage`: accepted landing damage. */
function* impulseLandingSearch(bot: MovementBot, initial: State, target?: Point, maxTicks = 160, { fallFrom = -Infinity, maxDamage = 0 }: { fallFrom?: number; maxDamage?: number } = {}): Generator<void, JumpPlan | null> {
  const world = worldOf(bot); const geometry = geometryOf(bot, world); const sim = simulator(bot)
  let slice = performance.now() + .25
  for (const coast of target ? [3, 6, 10, 0] : [0]) {
    const state = clone(initial); const steps: Step[] = []; const states: State[] = []
    let peak = Math.max(state.pos.y, fallFrom); let settled = 0; let landing: Point | null = null
    for (let tick = 0; tick < Math.min(180, maxTicks); tick++) {
      if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
      const stop = clone(state); stop.control = controls()
      for (let i = 0; i < coast; i++) sim(stop, world)
      const dx = (target?.x ?? stop.pos.x) - stop.pos.x; const dz = (target?.z ?? stop.pos.z) - stop.pos.z
      const step = { yaw: target ? Math.atan2(-dx, -dz) : state.yaw, control: controls({ forward: !!target && !settled && Math.hypot(dx, dz) > .025, sneak: !!settled && !state.isInWater }) }
      state.yaw = step.yaw; state.control = step.control; sim(state, world); peak = Math.max(peak, state.pos.y)
      if (state.isInLava || state.isInWeb || !bodyClear(geometry, state.pos, { water: true })) break
      const support = supportAt(geometry, state.pos, .04)
      const wet = state.isInWater && (!target || inWaterCell(geometry, state, new Vec3(target.x, target.y, target.z).floored()))
      const safeFloor = state.onGround && state.vel.y <= 0 && !!support && landingDamage(support.block, peak - state.pos.y, bot.entity.attributes) <= maxDamage
      const dry = safeFloor && (!target || onTarget(geometry, state, target, .25))
      // Earned launch speed may touch the near edge before native friction
      // settles at the goal. Center on the same safe plane with this controller.
      if (state.onGround && !wet && !dry && !(safeFloor && target && Math.abs(state.pos.y - target.y) < .03)) break
      if (wet || dry) { landing ??= { ...state.pos }; settled++ } else { settled = 0; landing = null }
      steps.push(step); states.push(clone(state))
      if (settled >= 6 && Math.hypot(state.vel.x, state.vel.z) < .035 && landing) return { steps, states, target: target ?? landing, ticks: steps.length }
    }
  }
  return null
}
export function planImpulseLanding(bot: MovementBot, initial: State, target?: Point, maxTicks = 160, limits?: { fallFrom?: number; maxDamage?: number }): JumpPlan | null {
  const search = impulseLandingSearch(bot, initial, target, maxTicks, limits)
  for (;;) { const step = search.next(); if (step.done) return step.value }
}

/**
 * Steer an ongoing fall onto the nearby floor that hurts least (hay, honey,
 * slime — 1.21.11 fallOn rules in landing.ts), when it beats the floor straight
 * below. `fallFrom` is the observed top of this fall. Native forecast only.
 */
export function planNearbySoftLanding(bot: MovementBot, fallFrom: number): (JumpPlan & { damage: number }) | null {
  if (!bot.physics || bot.entity.onGround || bot.entity.velocity.y >= -.08 || bot.entity.isInWater || bot.entity.isInLava) return null
  const world = worldOf(bot); const from = bot.entity.position
  const floorOf = (x: number, z: number) => {
    for (let y = Math.floor(from.y) - 1; y >= Math.floor(from.y) - 128; y--) {
      const block = world.getBlock(new Vec3(x, y, z))
      if (!block) return null
      const boxes = shapeBoxes(block)
      if (boxes.length) return { block, top: Math.max(...boxes.map(box => box.maxY)) }
    }
    return null
  }
  const below = floorOf(Math.floor(from.x), Math.floor(from.z))
  const baseline = below ? landingDamage(below.block, fallFrom - below.top, bot.entity.attributes) : Infinity
  const candidates: Array<{ target: Point; damage: number; reach: number }> = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const x = Math.floor(from.x) + dx; const z = Math.floor(from.z) + dz; const floor = floorOf(x, z)
    if (!floor || !hasFallMitigation(floor.block)) continue
    const damage = landingDamage(floor.block, fallFrom - floor.top, bot.entity.attributes)
    if (damage < baseline && damage < (bot.health ?? 20)) candidates.push({ target: { x: x + .5, y: floor.top, z: z + .5 }, damage, reach: Math.hypot(x + .5 - from.x, z + .5 - from.z) })
  }
  candidates.sort((a, b) => a.damage - b.damage || a.reach - b.reach)
  for (const candidate of candidates.slice(0, 4)) {
    const plan = planImpulseLanding(bot, new PlayerState(bot, controls()), candidate.target, 160, { fallFrom, maxDamage: candidate.damage })
    if (plan) return { ...plan, damage: candidate.damage }
  }
  return null
}
export async function planImpulseLandingAsync(bot: MovementBot, ctl: Cancellation, initial: State, target: Point, planningMs = 20): Promise<JumpPlan | null> {
  const search = impulseLandingSearch(bot, initial, target); let workMs = 0
  for (;;) {
    if (ctl.aborted || workMs > planningMs) return null
    const began = performance.now(); const step = search.next(); workMs += performance.now() - began
    if (step.done) return step.value
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

export function planWaterEntry(bot: MovementBot, target: Point, maxTicks = 160, launch?: WaterLaunch): JumpPlan | null {
  if (!bot.physics || !bot.entity.onGround && bot.entity.velocity.y >= -.08 || bot.entity.isInLava) return null
  const cell = new Vec3(target.x, target.y, target.z).floored(); const block = bot.blockAt(cell, false)
  if (!block || !containsWater(block) || cell.y >= bot.entity.position.y) return null
  const observed = bot.world ? (require('../sight').seesBlock as (bot: MovementBot, block: CollisionBlock) => boolean)(bot, block) : bot.canSeeBlock?.(block)
  if (!observed) return null
  const base = new PlayerState(bot, controls()); const world = worldOf(bot); const geometry = geometryOf(bot, world); const sim = simulator(bot)
  const prefixSteps: Step[] = []; const prefixStates: State[] = []
  for (let tick = 0; tick < Math.max(0, Math.min(6, launch?.ticks ?? 0)); tick++) {
    const yaw = Math.atan2(base.pos.x - cell.x - .5, base.pos.z - cell.z - .5) + (launch?.yawOffset ?? 0)
    const step = { yaw, control: controls({ forward: true, sprint: launch?.sprint === true }) }
    base.yaw = yaw; base.control = step.control; sim(base, world)
    if (base.isInLava || base.isInWeb || !bodyClear(geometry, base.pos, { water: true })) return null
    prefixSteps.push(step); prefixStates.push(clone(base))
  }
  const entries = waterEntries(geometry, cell).filter(entry => {
    // Some shape tops leave free air but no native water contact. Test the
    // actual fluid detector rather than assume every waterlogged gap is wet.
    const probe = clone(base); probe.pos = entry.clone(); probe.vel = new Vec3(0, 0, 0); probe.control = controls(); sim(probe, world)
    return probe.isInWater
  })
  for (const entry of entries) for (const coast of [6, 10, 3, 15]) {
    const state = clone(base); const steps: Step[] = [...prefixSteps]; const states: State[] = [...prefixStates]
    let caught = 0; let departed = !base.onGround
    for (let tick = 0; tick < Math.min(180, maxTicks); tick++) {
      // Native idle look-ahead supplies the remaining inertia. Different small
      // horizons cover a fast fall and the final braking approach without A*.
      const stop = clone(state); stop.control = controls()
      for (let t = 0; t < coast; t++) sim(stop, world)
      const dx = entry.x - stop.pos.x; const dz = entry.z - stop.pos.z
      const step = { yaw: Math.atan2(-dx, -dz), control: controls({ forward: !caught && Math.hypot(dx, dz) > .012 }) }
      state.yaw = step.yaw; state.control = step.control; sim(state, world)
      departed ||= !state.onGround
      if (state.isInLava || state.isInWeb || state.pos.y < cell.y - .03 || !bodyClear(geometry, state.pos, { water: true })) break
      steps.push(step); states.push(clone(state))
      caught = inWaterCell(geometry, state, cell) ? caught + 1 : 0
      if (caught >= 4 && Math.hypot(state.vel.x, state.vel.z) < .04) return { steps, states, target: { ...cell }, ticks: steps.length }
      // Native water detection happens before motion. Permit that one detector
      // tick at the pool bottom, but never accept a dry wall/rim landing.
      if (departed && state.onGround && !state.isInWater && (state.pos.y >= cell.y + .9 || state.pos.x < cell.x || state.pos.x > cell.x + 1 || state.pos.z < cell.z || state.pos.z > cell.z + 1)) break
    }
  }
  return null
}

/** One bounded rescue forecast over observed water; no airborne route graph. */
export function planNearbyWaterEntry(bot: MovementBot, hint?: Point): JumpPlan | null {
  if (!bot.physics || !bot.world?.raycast && !bot.canSeeBlock) return null
  const world = worldOf(bot)
  const observed = Object.create(bot) as MovementBot
  observed.blockAt = p => world.getBlock(p)
  const tried = new Set<string>(); let candidates = 0
  const tryCell = (cell: Vec3) => {
    const key = `${cell.x},${cell.y},${cell.z}`
    if (tried.has(key)) return null
    tried.add(key)
    const block = world.getBlock(cell)
    if (!block || !containsWater(block)) return null
    candidates++
    return planWaterEntry(observed, cell)
  }
  if (hint) { const plan = tryCell(new Vec3(hint.x, hint.y, hint.z).floored()); if (plan) return plan }
  const from = bot.entity.position; const columns: Vec3[] = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) columns.push(new Vec3(Math.floor(from.x) + dx, 0, Math.floor(from.z) + dz))
  columns.sort((a, b) => Math.hypot(a.x + .5 - from.x, a.z + .5 - from.z) - Math.hypot(b.x + .5 - from.x, b.z + .5 - from.z))
  for (const column of columns) for (let y = Math.floor(from.y) - 1; y >= Math.floor(from.y) - 128; y--) {
    const cell = new Vec3(column.x, y, column.z); const block = world.getBlock(cell)
    if (!block) break
    const plan = tryCell(cell)
    if (plan) return plan
    if (candidates >= 4) return null
    // A dry occupied volume occludes everything deeper in this column.
    if (!containsWater(block) && shapeBoxes(block).some(box => box.maxY > box.minY)) break
  }
  return null
}

export async function enterWater(bot: MovementBot, ctl: Cancellation, target: Point, ticks?: number, launch?: WaterLaunch, automatic = false) {
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  const began = performance.now(); const plan = planWaterEntry(bot, target, ticks, launch)
  const planningMs = performance.now() - began
  if (!plan) return { ok: false, why: 'no_confirmed_free_water_trajectory', ticks: 0, samples: [], planningMs }
  if (automatic) {
    if (!bot.entity.onGround || !bot._ndClutch) return { ok: false, why: 'automatic_fall_guard_unavailable', ticks: 0, samples: [], planningMs }
    const hp = bot.health ?? 20
    const saved = bot._ndClutch.stats.water_saved; const samples: Array<{ pos: Point; velocity: Point; onGround: boolean; isInWater: boolean; hp?: number }> = []
    const previous = bot._ndParkourForecast
    const own = forecastOwner(bot.entity.position, hp)
    bot._ndParkourForecast = own
    let tick = 0
    try {
      // Walk off the prepared edge with ordinary keys, then hand the fall to
      // the existing reflex. Its independent observation chooses the water.
      for (const step of plan.steps.slice(0, 20)) {
        if (ctl.aborted || !bot.entity.onGround) break
        await bot.look(step.yaw, 0, true)
        own.next = { ...plan.states[tick].pos }
        for (const key of Object.keys(IDLE) as Array<keyof Control>) bot.setControlState(key, step.control[key])
        await bot.waitForTicks(1); tick++
        own.from = { ...bot.entity.position }
      }
    } finally {
      if (bot._ndParkourForecast === own) { if (previous) bot._ndParkourForecast = previous; else delete bot._ndParkourForecast }
      // This launch Skill owns only the approach keys. Remove them before the
      // reflex captures its previous controls, without clearing an active rescue.
      if (!bot._ndClutch.waterPlan) bot.clearControlStates()
    }
    try {
      for (; tick < Math.min(180, ticks ?? 160) && !ctl.aborted; tick++) {
        await bot.waitForTicks(1)
        const state = new PlayerState(bot, controls())
        samples.push({ pos: { ...state.pos }, velocity: { ...state.vel }, onGround: state.onGround, isInWater: state.isInWater, hp: bot.health })
        if ((bot.health ?? hp) < hp) return { ok: false, why: 'hurt_during_automatic_rescue', ticks: tick + 1, samples, planningMs }
        if (bot._ndClutch.stats.water_saved > saved) return { ok: inWaterCell(bot, state, plan.target), why: undefined, ticks: tick + 1, samples, planningMs, automatic: true }
      }
      return { ok: false, why: ctl.aborted ? 'interrupted' : 'automatic_rescue_not_confirmed', ticks: tick, samples, planningMs, automatic: true }
    } finally { if (!bot._ndClutch.waterPlan) { bot.clearControlStates(); bot.setControlState('sneak', true) } }
  }
  return { ...await executePlan(bot, ctl, plan, state => inWaterCell(bot, state, plan.target)), planningMs }
}
export async function catchWeb(bot: MovementBot, ctl: Cancellation, target: Point, wait = 40) {
  // A catch requested at a step-off (or before a fall begins) may precede the
  // first falling frame; wait up to `wait` game ticks for a real descent above the web.
  let plan = planWebCatch(bot, target)
  for (let tick = 0; !plan && tick < Math.min(2000, wait) && !ctl.aborted && !bot.entity.isInWeb; tick++) {
    await bot.waitForTicks(1); plan = planWebCatch(bot, target)
  }
  if (!plan) return { ok: false, why: 'no_observed_reachable_web', ticks: 0, samples: [] }
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  return executePlan(bot, ctl, plan, state => state.isInWeb && Math.abs(state.vel.y) < .16)
}

export async function holdEdge(bot: MovementBot, ctl: Cancellation, target: Point, ticks = 30): Promise<{ ok: boolean; ticks: number }> {
  if (!supportAt(bot, target, .04) || !bodyClear(bot, target)) return { ok: false, ticks: 0 }
  const sim = simulator(bot)
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  let tick = 0
  try {
    for (; tick < Math.min(400, ticks) && !ctl.aborted; tick++) {
      const base = new PlayerState(bot, controls()); const world = worldOf(bot)
      const yaw = Math.atan2(base.pos.x - target.x, base.pos.z - target.z)
      let pick = controls({ sneak: true })
      if (flat(base.pos, target) > .04) {
        const state = clone(base); state.yaw = yaw; state.control = controls({ forward: true, sneak: true })
        let safe = true
        for (let t = 0; t < 8; t++) {
          if (t === 1) state.control = controls({ sneak: true })
          sim(state, world)
          if (!state.onGround || !supportAt(bot, state.pos, .04)) { safe = false; break }
        }
        if (safe) pick = controls({ forward: true, sneak: true })
      }
      await bot.look(yaw, 0, true)
      for (const key of Object.keys(IDLE) as Array<keyof Control>) bot.setControlState(key, pick[key])
      await bot.waitForTicks(1)
      if (!bot.entity.onGround) return { ok: false, ticks: tick + 1 }
    }
    return { ok: !ctl.aborted && bot.entity.onGround && flat(bot.entity.position, target) < .12, ticks: tick }
  } finally { bot.clearControlStates(); bot.setControlState('sneak', true) }
}

export async function climb(bot: MovementBot, ctl: Cancellation, target: Point, maxTicks = 180): Promise<{ ok: boolean; ticks: number; why?: string }> {
  if (![target.x, target.y, target.z].every(Number.isFinite)) return { ok: false, ticks: 0, why: 'invalid_target' }
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  const hp = bot.health ?? 20
  let tick = 0; let lastY = bot.entity.position.y; let stagnant = 0
  try {
    for (; tick < Math.min(400, maxTicks) && !ctl.aborted; tick++) {
      if (bot.entity.position.y >= target.y - .04 && bot.entity.onGround && flat(bot.entity.position, target) < .3) return { ok: (bot.health ?? hp) >= hp, ticks: tick }
      // Ladder/vine acceleration, clamps and collision are the native integrator.
      await bot.look(Math.atan2(bot.entity.position.x - target.x, bot.entity.position.z - target.z), 0, true)
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      await bot.waitForTicks(1)
      stagnant = Math.abs(bot.entity.position.y - lastY) < .005 ? stagnant + 1 : 0; lastY = bot.entity.position.y
      if (stagnant > 30 || (bot.health ?? hp) < hp || bot.entity.isInLava) return { ok: false, ticks: tick + 1, why: 'climb_stalled_or_hurt' }
    }
    return { ok: false, ticks: tick, why: ctl.aborted ? 'interrupted' : 'climb_deadline' }
  } finally { bot.clearControlStates() }
}

export async function navigate(bot: MovementBot, ctl: Cancellation, options: JumpOptions & { target: Point; mode?: 'jump' | 'climb' | 'edge' | 'webcatch' | 'waterentry' | 'riptide' | 'route' | 'options' | 'drop'; ticks?: number; wait?: number; maxLandings?: number; timeoutSeconds?: number; launch?: WaterLaunch; waypoints?: readonly Point[]; automatic?: boolean; pitch?: number }) {
  if (options.mode === 'options') return { ok: true, options: localOptions(bot, { toward: options.target }) }
  if (options.mode === 'route') return route(bot, ctl, { toward: options.target, maxLandings: options.maxLandings, maxTicks: options.maxTicks, beam: options.beam, waypoints: options.waypoints, timeoutSeconds: options.timeoutSeconds, maxFallDamage: options.maxFallDamage })
  if (options.mode === 'webcatch') return catchWeb(bot, ctl, options.target, options.wait)
  if (options.mode === 'waterentry') return enterWater(bot, ctl, options.target, options.ticks, options.launch, options.automatic)
  if (options.mode === 'riptide') {
    const me = bot.entity.position; const target = options.target
    return require('../utility').riptide(bot, Math.atan2(me.x - target.x, me.z - target.z), options.pitch ?? Math.atan2(target.y - me.y, flat(me, target)), { target, ctl, launch: options.launch })
  }
  if (options.mode === 'drop') return dropOff(bot, ctl, options.target, options.ticks)
  if (options.mode === 'climb') return climb(bot, ctl, options.target, options.ticks)
  if (options.mode === 'edge') return holdEdge(bot, ctl, options.target, options.ticks)
  return executeJump(bot, ctl, options.target, options)
}

/**
 * Lab only: walk off the current ledge toward `target` with ordinary keys, release them in the air
 * and leave the fall to the reflexes (clutch: water, ladder, blocks). Reports the observed landing.
 */
async function dropOff(bot: MovementBot, ctl: Cancellation, target: Point, ticks = 240) {
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  const hp = bot.health ?? 20; const top = bot.entity.position.y; let tick = 0; let low = top
  await bot.look(Math.atan2(bot.entity.position.x - target.x, bot.entity.position.z - target.z), 0, true)
  bot.setControlState('forward', true)
  try { while (tick < 20 && bot.entity.onGround && !ctl.aborted) { await bot.waitForTicks(1); tick++ } } finally { bot.setControlState('forward', false) }
  if (bot.entity.onGround) return { ok: false, why: 'did_not_leave_ledge', ticks: tick, hp: bot.health }
  while (tick < ticks && !ctl.aborted && !bot.entity.onGround && !bot.entity.isInWater && (bot.health ?? 0) > 0) { await bot.waitForTicks(1); tick++; low = Math.min(low, bot.entity.position.y) }
  if (!ctl.aborted && (bot.health ?? 0) > 0) await bot.waitForTicks(10) // the server's damage receipt follows the landing
  const lost = hp - (bot.health ?? 0)
  return { ok: !ctl.aborted && lost <= 0 && (bot.entity.onGround || !!bot.entity.isInWater), why: ctl.aborted ? 'interrupted' : lost > 0 ? 'hurt' : undefined, hp: bot.health, lost, fall: top - low, ticks: tick, at: { ...bot.entity.position } }
}

/**
 * Open a closed wooden door by hand before a route edge through it: only a half within 4.5 blocks that the
 * eyes actually see (pick.blockSeen, like the client's crosshair), confirmed by the server's block update.
 */
export async function openDoor(bot: MovementBot, ctl: Cancellation, at: Point): Promise<{ ok: boolean; why?: string }> {
  const body = bot as MovementBot & { lookAt(p: Vec3, force?: boolean): Promise<void>; activateBlock(b: unknown): Promise<void> }
  const lower = new Vec3(at.x, at.y, at.z)
  const isOpen = () => String(bot.blockAt(lower, false)?.getProperties?.().open) === 'true'
  const door = bot.blockAt(lower, false)
  if (!door || !WOOD_DOOR.test(door.name)) return { ok: false, why: 'no_wooden_door' }
  if (isOpen()) return { ok: true }
  const pick = require('../pick') as { eyeOf(bot: unknown): Vec3; blockSeen(bot: unknown, p: Vec3, o?: { range?: number }): boolean }
  const eye = pick.eyeOf(bot)
  const half = [lower, lower.offset(0, 1, 0)].find(p => eye.distanceTo(p.offset(.5, .5, .5)) <= 4.5 && pick.blockSeen(bot, p, { range: 4.5 }))
  if (!half) return { ok: false, why: 'door_not_visible' }
  await body.lookAt(half.offset(.5, .5, .5), true)
  await body.activateBlock(bot.blockAt(half, false))
  for (let tick = 0; tick < 20 && !ctl.aborted; tick++) { if (isOpen()) return { ok: true }; await bot.waitForTicks(1) }
  return { ok: false, why: ctl.aborted ? 'interrupted' : 'door_not_opened' }
}

type RouteOptions = { toward: Point; maxLandings?: number; maxTicks?: number; beam?: number; waypoints?: readonly Point[]; timeoutSeconds?: number; maxFallDamage?: number; frames?: number }
type RouteResult = { ok: boolean; why?: string; landings: unknown[]; at: Point; visited: string[] }
export async function route(bot: MovementBot, ctl: Cancellation, options: RouteOptions): Promise<RouteResult> {
  // Loaded collision tops persist across landings; only a nearby block change
  // can alter which body positions a cell supports.
  const standCache = new Map<string, Vec3[]>()
  const onBlock = (_old: unknown, block: { position?: Point } | null) => { if (block?.position) { invalidateStands(standCache, block.position); forgetCell(standCache, block.position) } }
  const listen = bot.on as unknown as (event: string, listener: typeof onBlock) => unknown
  const unlisten = bot.removeListener as unknown as (event: string, listener: typeof onBlock) => unknown
  listen.call(bot, 'blockUpdate', onBlock)
  try { return await routeLandings(bot, ctl, options, standCache) } finally { unlisten.call(bot, 'blockUpdate', onBlock) }
}
async function routeLandings(bot: MovementBot, ctl: Cancellation, { toward: finalGoal, maxLandings = 40, maxTicks = 38, beam = 24, waypoints = [], timeoutSeconds = 120, maxFallDamage = 0, frames = ROUTE_FRAMES }: RouteOptions, standCache: Map<string, Vec3[]>): Promise<RouteResult> {
  const clock = require('../game-clock') as { now(): number }
  const deadline = clock.now() + Math.max(1, Math.min(3600, timeoutSeconds)) * 1000
  const parentCtl = ctl; const expired = () => clock.now() >= deadline
  // Stop within the route's budget so its partial report reaches runIntent
  // before the outer deadline's twenty-second unwind allowance.
  ctl = { get aborted() { return parentCtl.aborted || expired() }, onAbort: parentCtl.onAbort }
  const visited = new Map<string, number>(); const traversed = new Set<string>(); const landings: unknown[] = []; const rejected: unknown[] = []; const blocked = new Set<string>(); const reboundCeilings = new Map<string, number>(); const springFailures = new Map<string, number>(); const deferred = new Set<string>(); const wideTried = new Set<string>(); let wideGoal = -1
  const goals = [...waypoints, finalGoal]; const reachedGoals: unknown[] = []; let goalIndex = 0
  const riptideAttempts = new Set<string>()
  let remaining: LandingOption[] = []; let failedPlans = 0
  const report = (ok: boolean, why?: string) => ({ ok, why: !ok && ctl.aborted ? expired() ? 'route_deadline' : 'interrupted' : why, landings, rejected, reachedGoals, goalIndex, at: { ...bot.entity.position }, visited: [...visited.keys()] })
  bot.pathfinder?.setGoal(null); bot.clearControlStates(); bot.setControlState('sneak', true)
  for (let count = 0; count < Math.min(1000, maxLandings) && !ctl.aborted; count++) {
    const me = bot.entity.position.clone()
    let toward = goals[goalIndex]
    if (flat(me, toward) < .35 && Math.abs(me.y - toward.y) < .03 && bot.entity.onGround) {
      reachedGoals.push({ target: toward, at: { ...me }, hp: bot.health }); goalIndex++; remaining = []; traversed.clear()
      if (goalIndex >= goals.length) return report(true)
      toward = goals[goalIndex]
    }
    const boostKey = transitionKey(me, toward)
    if (!riptideAttempts.has(boostKey) && (flat(me, toward) > 4 || toward.y - me.y > 1.25)) {
      riptideAttempts.add(boostKey)
      const boost = await require('../utility').riptideTo(bot, ctl, toward)
      if (boost.ok || boost.ticks > 0) {
        const summary = { ...boost, target: toward, mode: 'riptide', at: { ...bot.entity.position }, hp: bot.health }
        landings.push(summary); bot.emit?.('nd_parkour_route', summary)
        if (!boost.ok) return report(false, boost.why)
        remaining = []; failedPlans = 0; continue
      }
    }
    if (ctl.aborted) return report(false, 'interrupted')
    const current = `${Math.floor(me.x) + .5},${Math.round(me.y * 32) / 32},${Math.floor(me.z) + .5}`
    visited.set(current, (visited.get(current) ?? 0) + 1)
    const world = worldOf(bot); const geometry = geometryOf(bot, world)
    // Keep the connected macro route across its verified landings. Rebuilding
    // the same loaded graph every few native ticks starves accelerated play.
    if (remaining[0] && (!supportAt(geometry, remaining[0].target, .04) || !bodyClear(geometry, remaining[0].target))) remaining = []
    const routing: RoutingDiagnostics & { cached?: boolean } = { cached: !!remaining.length }
    const unavailable = new Set([...blocked, ...traversed])
    const damageBudget = fallBudget(bot, maxFallDamage)
    // The unobstructed native apex bounds every spring edge; an exhausted
    // family's observed ceiling (walls on the way) tightens it further.
    // A refused spring family from one height also bounds every lower start
    // toward that same landing: vertical rebound energy only falls with height.
    const ceilingOf = (from: Point, spring: Point, to: Point) => from.y <= (springFailures.get(`${landingKey(spring)}>${landingKey(to)}`) ?? -Infinity) + 1e-6 ? -Infinity
      : Math.min(Math.max(reboundApex(bot, spring, from.y, false), reboundApex(bot, spring, from.y, true)), reboundCeilings.get(`${landingKey(from)}~${landingKey(spring)}`) ?? Infinity)
    // Repeated landings on one support mean the graph is circling a dead end;
    // charge revisits so the next optimistic path explores elsewhere.
    // An edge refused only by its frame budget is unproven, not impossible:
    // prefer alternatives, then retry it once with a larger budget.
    const revisit = (from: Point, to: Point, bounce?: Point, chain?: Point[]) => Number(process.env.ND_ROUTE_REVISIT ?? 3) * (visited.get(landingKey(to)) ?? 0) + (deferred.has(transitionKey(from, to, bounce, chain)) ? DEFERRED_COST : 0)
    // Once the 24-block disc failed to reach this goal, keep the wide graph for it.
    const radius = wideGoal === goalIndex ? WIDE_RADIUS : flat(me, toward) > 14 ? 24 : 14
    let waypoints = remaining.length ? remaining : await supportRoute(geometry, me, toward, unavailable, radius, routing, ceilingOf, () => ctl.aborted, damageBudget, standCache, revisit)
    if (ctl.aborted) return report(false, 'interrupted')
    const goalPoint = new Vec3(toward.x, toward.y, toward.z)
    if (!remaining.length && radius < 24 && (!waypoints.length || waypoints[waypoints.length - 1].target.distanceTo(goalPoint) >= .8)) {
      // A nearby goal can be a local minimum while the authored route bends
      // back around the tower (CP18: the loop leaves the 14-block disc).
      // Widen the loaded graph once whenever the local graph cannot reach it.
      waypoints = await supportRoute(geometry, me, toward, unavailable, 24, routing, ceilingOf, () => ctl.aborted, damageBudget, standCache, revisit)
    }
    const wideKey = `${goalIndex}:${landingKey(me)}`
    if (!remaining.length && radius < WIDE_RADIUS && flat(me, toward) <= WIDE_RADIUS && !wideTried.has(wideKey) && (!waypoints.length || waypoints[waypoints.length - 1].target.distanceTo(goalPoint) >= .8)) {
      // The authored path may leave the 24-block disc entirely (CP21→CP22 runs
      // ~70 blocks around the snow plateau). One wide graph per start and goal.
      wideTried.add(wideKey)
      const wide = await supportRoute(geometry, me, toward, unavailable, WIDE_RADIUS, routing, ceilingOf, () => ctl.aborted, damageBudget, standCache, revisit)
      if (wide.length && wide[wide.length - 1].target.distanceTo(goalPoint) < .8) { waypoints = wide; wideGoal = goalIndex }
    }
    if (ctl.aborted) return report(false, 'interrupted')
    const first = waypoints[0]
    // The graph keeps optimistic edges until native physics verifies them. A
    // refused long gap or rebound must not starve a short higher approach just
    // because that approach initially points away from the semantic goal.
    const approaches = failedPlans ? localOptions(bot, { toward, visited, visibleOnly: false })
      .filter(option => option.target.y > me.y + .2 || first && option.target.y >= me.y - .04 && !visited.has(option.key))
      .sort((a, b) => Number(visited.has(a.key)) - Number(visited.has(b.key)) ||
        Number(a.target.y <= me.y + .2) - Number(b.target.y <= me.y + .2) || flat(me, a.target) - flat(me, b.target)).slice(0, 4) : []
    const choices = first ? [] : localOptions(bot, { toward, visited, visibleOnly: false }).filter(option => option.target.y > me.y + .2 || option.score > .5)
    const options = [...approaches, first, ...choices].filter((option): option is NonNullable<typeof option> => !!option &&
      // Returning from a trial approach is a different directed edge. Refuse
      // repeated transitions rather than forbidding its previously visited floor.
      !unavailable.has(transitionKey(me, option.target, option.bounce, option.chain)) &&
      (option === first || !(option.target.y < me.y - .25 && option.target.distanceTo(new Vec3(toward.x, toward.y, toward.z)) > me.distanceTo(new Vec3(toward.x, toward.y, toward.z)) + .25)))
      .filter((option, i, all) => all.findIndex(other => other.key === option.key) === i)
    let advanced = false
    for (const option of options.slice(0, 12)) {
      if (ctl.aborted) return report(false, 'interrupted')
      if (option.door) {
        const opened = await openDoor(bot, ctl, option.door)
        if (!opened.ok) { rejected.push({ from: { ...me }, target: option.target, door: option.door, why: opened.why, ok: false, ticks: 0 }); blocked.add(transitionKey(me, option.target)); remaining = []; continue }
      }
      const result = await executeJump(bot, ctl, option.target, { beam, maxTicks: option.climb ? 180 : option.bounce ? 90 + 60 * (option.chain?.length ?? 0) : maxTicks, bounce: option.bounce, chain: option.chain, climb: option.climb, allowWalk: true, maxFrames: deferred.has(transitionKey(me, option.target, option.bounce, option.chain)) ? frames * DEFERRED_SCALE : frames, maxFallDamage: damageBudget })
      // A bounded native correction may leave a safe body beside the requested
      // center. Keep that exact attempt unconfirmed; rebuild routing only after
      // six observed supported stopping frames at the actual landing.
      const stopping = result.samples.slice(-6) as Array<{ pos: Point; velocity: Point; onGround: boolean }>
      const actual = bot.entity.position
      const observed = geometryOf(bot, worldOf(bot))
      const actualLanding = !result.ok && result.why === 'landing_not_confirmed' && !ctl.aborted && actual.distanceTo(me) > .35 && stopping.length === 6 &&
        stopping.every(sample => {
          const support = supportAt(observed, sample.pos, .02)
          return sample.onGround && sample.velocity.y <= 0 && Math.abs(sample.pos.y - actual.y) < .02 && flat(sample.pos, actual) < .35 &&
            !!support && Math.abs(support.top - sample.pos.y) < .02 && bodyClear(observed, sample.pos)
        }) && settledLanding(bot, { pos: actual, vel: bot.entity.velocity, onGround: bot.entity.onGround }, actual)
        ? { confirmed: true, at: { ...actual }, ticks: 6, samples: stopping } : undefined
      const forecastDiagnostics = result.forecast && typeof result.forecast === 'object' && 'diagnostics' in result.forecast ? result.forecast.diagnostics as PlanningDiagnostics : undefined
      const contactTick = forecastDiagnostics?.momentum?.contactTick
      const trajectory = !result.ok ? result.samples.filter((_, index) => index === 0 || index >= result.samples.length - 12)
        : contactTick === undefined ? undefined : result.samples.filter((_, index) => index < 2 || Math.abs(index - contactTick) <= 2 || index >= result.samples.length - 2)
      const summary = { from: { ...me }, target: option.target, mode: option.mode ?? 'jump', bounce: option.bounce, chain: option.chain, door: option.door, climb: option.climb, support: option.support, waypoints: waypoints.slice(0, 10).map(p => ({ ...p.target, mode: p.mode, bounce: p.bounce, chain: p.chain, climb: p.climb })), routing, planningMs: result.planningMs, planningTicks: result.planningTicks, forecast: result.forecast, ok: result.ok, why: result.why, ticks: result.ticks, at: { ...actual }, hp: bot.health, actualLanding, trajectory }
      bot.emit?.('nd_parkour_route', summary)
      if (result.ticks) landings.push(summary)
      else rejected.push(summary)
      // A refused forecast only blocks its particular edge. It never means
      // this support was visited; a different intermediate landing can reach it.
      if (result.ok || actualLanding) {
        traversed.add(transitionKey(me, option.target, option.bounce, option.chain))
        traversed.add(transitionKey(me, bot.entity.position, option.bounce, option.chain))
        for (const key of new Set([option.key, landingKey(bot.entity.position)])) visited.set(key, (visited.get(key) ?? 0) + 1)
        advanced = true; failedPlans = 0; remaining = result.ok && option === first ? waypoints.slice(1) : []; break
      }
      const edge = transitionKey(me, option.target, option.bounce, option.chain)
      if (!result.ticks && result.why === 'planning_budget' && !deferred.has(edge)) deferred.add(edge)
      else blocked.add(edge)
      const diagnostics = result.forecast && typeof result.forecast === 'object' && 'diagnostics' in result.forecast ? result.forecast.diagnostics as PlanningDiagnostics : undefined
      if (!result.ticks && option.bounce && !option.chain && (!diagnostics?.why || diagnostics.why === 'rebound_ceiling') && Number.isFinite(diagnostics?.reboundCeiling)) reboundCeilings.set(`${landingKey(me)}~${landingKey(option.bounce)}`, diagnostics!.reboundCeiling!)
      if (!result.ticks && option.bounce && !option.chain && result.why !== 'planning_budget') {
        const family = `${landingKey(option.bounce)}>${landingKey(option.target)}`
        springFailures.set(family, Math.max(springFailures.get(family) ?? -Infinity, me.y))
      }
      remaining = []
      if (result.ticks) return report(false, result.why)
    }
    if (!advanced) {
      if (first && options.length && ++failedPlans < 12) continue
      return report(false, 'no_visible_local_trajectory')
    }
  }
  return report(false, ctl.aborted ? 'interrupted' : 'landing_budget')
}

export function localOptions(bot: MovementBot, { toward, radius = 5, visited = new Map<string, number>(), visibleOnly = true }: { toward?: Point; radius?: number; visited?: ReadonlyMap<string, number>; visibleOnly?: boolean } = {}): LandingOption[] {
  const me = bot.entity.position; const options: LandingOption[] = []
  const geometry = geometryOf(bot, worldOf(bot))
  const r = Math.max(1, Math.min(6, radius))
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (dx * dx + dz * dz > r * r || !dx && !dz) continue
    for (const target of standPositions(geometry, new Vec3(Math.floor(me.x) + dx, me.y, Math.floor(me.z) + dz), { rise: 1.25, drop: 2 })) {
      const support = supportAt(geometry, target, .04)
      if (!support || flat(me, target) > 6) continue
      // Loaded client collision data can describe a path around a wall. A sight
      // ray selects visible options for inspection; it cannot prove movement
      // impossible. Routing verifies the complete body with native trajectories.
      if (visibleOnly && !visibleLanding(bot, target, geometry)) continue
      // The graph's wall rule: a wall above the jump apex with no short way around is no fallback
      // option either (CP28 house: 12 rooms-behind-the-wall targets × 300 ms planning budget each).
      if (!visibleOnly && highRidge(geometry, me, target) && (clearanceMargin(geometry, target) > 0 || detour(geometry, me, target)(me).distance > flat(me, target) + .5)) continue
      const key = landingKey(target)
      const gain = toward ? me.distanceTo(new Vec3(toward.x, toward.y, toward.z)) - target.distanceTo(new Vec3(toward.x, toward.y, toward.z)) : target.y - me.y
      options.push({ target, key, support: support.block.name, score: gain * 2 - Math.max(0, me.y - target.y) * 2 - (visited.get(key) ?? 0) * 3 - flat(me, target) * .08 })
    }
  }
  const ascending = toward && toward.y > me.y + 1.25
  return options.sort((a, b) => (ascending ? Number(b.target.y > me.y + .2) - Number(a.target.y > me.y + .2) : 0) || b.score - a.score)
}

/**
 * Short combat hop (API for PvP/tactics): the visible local landing within `radius`
 * with the best caller score (`-Infinity` refuses), verified by the native forecast
 * under a small frame budget and executed without fall damage. The caller decides
 * what is better: higher ground, cover, distance from an enemy.
 */
export async function combatHop(bot: MovementBot, ctl: Cancellation, { score, radius = 4, maxFrames = 1500, tries = 3 }: { score: (target: Vec3) => number; radius?: number; maxFrames?: number; tries?: number }): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[]; target?: Vec3 }> {
  if (!bot.physics || !bot.entity?.onGround) return { ok: false, why: 'outside_local_jump_scope', ticks: 0, samples: [] }
  const ranked = localOptions(bot, { radius }).map(option => ({ option, value: score(option.target) }))
    .filter(entry => Number.isFinite(entry.value)).sort((a, b) => b.value - a.value).slice(0, tries)
  for (const { option } of ranked) {
    if (ctl.aborted) break
    const result = await executeJump(bot, ctl, option.target, { allowWalk: true, maxTicks: 30, maxFrames })
    if (result.ok || result.ticks > 0) return { ...result, target: option.target }
  }
  return { ok: false, why: ctl.aborted ? 'interrupted' : 'no_short_hop', ticks: 0, samples: [] }
}

export async function tryLocal(bot: MovementBot, ctl: Cancellation, target: { x: number; y?: number; z: number }): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[] }> {
  const me = bot.entity.position
  if (!bot.physics || !me || !bot.entity.onGround) return { ok: false, why: 'outside_local_jump_scope', ticks: 0, samples: [] }
  const positions = standPositions(bot, new Vec3(Math.floor(target.x), target.y ?? me.y, Math.floor(target.z)), { rise: 1.25, drop: 2 })
  for (const position of positions.slice(0, 3)) {
    if (ctl.aborted) break
    if (flat(me, position) <= 6 && position.y - me.y <= 1.25) {
      const result = await executeJump(bot, ctl, position)
      if (result.ok || result.ticks > 0) return result
    }
    const boost = await require('../utility').riptideTo(bot, ctl, position)
    if (boost.ok || boost.ticks > 0) return { ...boost, samples: boost.samples ?? [] }
  }
  return { ok: false, why: 'no_local_landing', ticks: 0, samples: [] }
}
