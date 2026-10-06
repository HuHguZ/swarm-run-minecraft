import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, containsWater, dimensions, groundedHazardClear, shapeBoxes, standPositions, supportAt, waterEntries, type CollisionBlock, type CollisionWorld, type Point } from './geometry'
import { detour } from './shape-detour'
import { hasFallMitigation, landingDamage } from './landing'
import { supportRoute, landingKey, transitionKey, onClimbable, climbColumn, type LandingOption, type RoutingDiagnostics } from './support-route'

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
export interface JumpOptions { beam?: number; maxTicks?: number; tolerance?: number; web?: boolean; sprint?: boolean; allowWalk?: boolean; planningMs?: number; diagnostics?: PlanningDiagnostics; bounce?: Point; climb?: Point; maxFallDamage?: number }
export interface JumpPlan { steps: Step[]; states: State[]; target: Point; ticks: number; fall?: { damage: number; support: Point; supportName: string; tick: number; pos: Point } }
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
function safeFallCost(bot: MovementBot, damage: number): boolean {
  try {
    const tactical = bot._ndReflexSession?.tactics?.snapshot()
    if (tactical && (!tactical.state || tactical.state.enemies.some(enemy => enemy.threatening))) return false
    const safety = require('../combat-safety').inspect(bot, { minHealth: 12 })
    return safety.action === 'fight' && safety.threats.length === 0 && (bot.health ?? 0) - damage > safety.threshold
  } catch { return false }
}
function fallBudget(bot: MovementBot, requested?: number): number { return requested === 1 && safeFallCost(bot, 1) ? 1 : 0 }
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
  const reboundRises = new Map<number, number>()
  const contact = opts.bounce ?? opts.climb
  // A ladder's thin native shape leaves less than the ordinary route cushion
  // beside its center. Use the actual body boundary for the catch, and let every
  // native forecast frame verify clearance before any controls are executed.
  const contactRoute = contact ? detour(geometry, bot.entity.position, contact, opts.climb ? 0 : .03) : null
  const extended = !!contact || flat(base.pos, target) > 4 && route(base.pos).distance <= flat(base.pos, target) + .5
  // Cheap native control profiles handle ordinary local landings before the
  // beam. Steering toward a predicted stopping position also removes initial
  // lateral speed; the integrator supplies the acceleration and friction.
  const spanSteps = Math.max(2, Math.ceil(flat(base.pos, target) * 4))
  let continuous = !!opts.allowWalk && Math.abs(target.y - base.pos.y) < .2
  for (let i = 1; continuous && i <= spanSteps; i++) {
    const t = i / spanSteps; const at = new Vec3(base.pos.x + (target.x - base.pos.x) * t, base.pos.y + (target.y - base.pos.y) * t, base.pos.z + (target.z - base.pos.z) * t)
    continuous = !!supportAt(geometry, at, .08) && bodyClear(geometry, at)
  }
  const launches = continuous || target.y < base.pos.y - .2 ? [false, true] : [true]
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
  const runups = extended ? [0, 2, 4, 6, 1, 3, 5, 7, 8, 10] : [0, 2, 4, 6]
  const nearEdge = [Math.max(0, edgeRunup - 1), edgeRunup]
  const orderedRunups = opts.bounce ? [...new Set([...nearEdge, ...runups])] : runups
  for (const jump of opts.bounce ? [true, false] : launches) for (const runup of jump ? orderedRunups : [0]) for (const sprint of opts.bounce ? [true, false] : [false, true]) for (const airSprint of extended ? opts.bounce ? [true, false] : [false, true] : [false]) for (const coast of extended ? opts.bounce ? [0, 2, 4, 6, 8, 1] : [2, 4, 6, 8, 0, 1] : [2, 4, 6, 8]) {
    if (opts.diagnostics) opts.diagnostics.profiles++
    if (sprint && (opts.sprint === false || (bot.food ?? 20) <= 6)) continue
    const state = clone(base); const steps: Step[] = []; const states: State[] = []
    let airborne = false; let fallDistance = 0; let contacted = false; let fall: JumpPlan['fall']
    for (let tick = 0; tick < Math.min(contact ? 180 : 60, opts.maxTicks ?? (opts.climb ? 180 : contact ? 90 : 38)); tick++) {
      if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
      const destination = contact && !contacted ? contact : target
      const waypoint = (contactRoute && !contacted ? contactRoute : route)(state.pos).waypoint
      const braking = flat(waypoint, destination) < .01 ? state.onGround && state.vel.y <= 0 ? 1 : coast : 0
      const dx = waypoint.x - state.pos.x - state.vel.x * braking
      const dz = waypoint.z - state.pos.z - state.vel.z * braking
      const yaw = Math.atan2(-dx, -dz)
      const settled = airborne && state.onGround && state.vel.y <= 0
      const step = { yaw, control: controls({ forward: Math.hypot(dx, dz) > .025, sprint: sprint && (!airborne || airSprint) && !settled, sneak: settled,
        jump: jump && tick === runup || !!opts.climb && onClimbable(geometry, state.pos) }) }
      const previous = state.pos.clone(); state.yaw = yaw; state.control = step.control; sim(state, world)
      noteForecast(opts.diagnostics, state, target)
      airborne ||= !state.onGround; fallDistance += Math.max(0, previous.y - state.pos.y)
      if (opts.climb && onClimbable(geometry, state.pos)) { contacted = true; fallDistance = 0 }
      if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < Math.min(base.pos.y, target.y, opts.bounce?.y ?? Infinity) - .4 || !bodyClear(geometry, state.pos, { web: opts.web }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) break
      if (state.onGround) {
        const support = supportAt(geometry, state.pos, .04)
        const damage = support ? landingDamage(support.block, fallDistance, bot.entity.attributes) : 0
        if (damage > 0) {
          if (!support || damage > budget || fall || jump || contact || target.y >= base.pos.y || !hasFallMitigation(support.block)) break
          fall = { damage, support: { ...support.block.position }, supportName: support.block.name, tick: steps.length, pos: { ...state.pos } }
        }
        if (opts.bounce && support?.block.name === 'slime_block' && state.vel.y > .1) {
          contacted = true
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
            opts.diagnostics.reboundCeiling = Math.max(opts.diagnostics.reboundCeiling ?? -Infinity, state.pos.y + rise + (bot.physics.stepHeight ?? 0))
          }
        }
        fallDistance = 0
      }
      steps.push(step); states.push(clone(state))
      if ((!contact || contacted) && (airborne || opts.allowWalk) && state.vel.y <= 0 && onTarget(geometry, state, target, opts.tolerance ?? .22)) {
        const stopping = rest(bot, state, world, opts.tolerance ?? .22, target)
        if (stopping) return { steps: [...steps, ...stopping.steps], states: [...states, ...stopping.states], target: { ...target }, ticks: steps.length + stopping.steps.length, ...(fall ? { fall } : {}) }
      }
      // A jump often touches the near edge of a broad destination before its
      // center. Continue supported centering there, without another jump.
      if (airborne && state.onGround && state.vel.y <= 0 && (Math.abs(state.pos.y - target.y) > .03 || flat(state.pos, target) > 1.5)) break
    }
  }
  return null
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
        if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < base.pos.y - .4 || !bodyClear(geometry, state.pos, { web: opts.web }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) break
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
  if (flat(bot.entity.position, target) > (opts.bounce ? 14 : 6) || !opts.climb && target.y - bot.entity.position.y > 1.25 || !supportAt(bot, target, .04) || !bodyClear(bot, target) || opts.bounce && (supportAt(bot, opts.bounce, .04)?.block.name !== 'slime_block' || !bodyClear(bot, opts.bounce)) || opts.climb && (!column || column.top < Math.floor(target.y) || !bodyClear(bot, opts.climb))) { if (opts.diagnostics) opts.diagnostics.why = 'unsupported_or_obstructed_target'; return null }
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
        const fallDistance = (node.state.onGround ? 0 : node.fallDistance) + Math.max(0, node.state.pos.y - state.pos.y)
        if (!jumped && !state.onGround && !supportAt(geometry, state.pos, .01)) continue
        if (state.isInLava || state.isInWater || !opts.web && state.isInWeb || state.pos.y < Math.min(bot.entity.position.y, target.y) - .4) continue
        if (!bodyClear(geometry, state.pos, { web: opts.web }) || !groundedHazardClear(geometry, state.pos, state.vel.y, state.onGround)) continue
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
export async function planJumpAsync(bot: MovementBot, ctl: Cancellation, target: Point, opts: JumpOptions = {}): Promise<JumpPlan | null> {
  const search = jumpSearch(bot, target, opts, () => ctl.aborted)
  let workMs = 0
  for (;;) {
    if (ctl.aborted || workMs > (opts.planningMs ?? Infinity)) { if (opts.diagnostics) opts.diagnostics.why = ctl.aborted ? 'interrupted' : 'planning_budget'; return null }
    const began = performance.now(); const step = search.next(); workMs += performance.now() - began
    if (opts.diagnostics) opts.diagnostics.workMs = workMs
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

export async function executeJump(bot: MovementBot, ctl: Cancellation, target: Point, opts: JumpOptions = {}): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[]; planningMs: number; forecast?: unknown }> {
  bot.pathfinder?.setGoal(null)
  bot.clearControlStates(); bot.setControlState('sneak', true)
  const start = forecastStart(bot, target); const diagnostics: PlanningDiagnostics = { frames: 0, profiles: 0 }
  const began = performance.now(); const plan = await planJumpAsync(bot, ctl, target, { ...opts, diagnostics })
  const planningMs = performance.now() - began
  if (!plan) return { ok: false, why: diagnostics.why ?? 'no_safe_native_trajectory', ticks: 0, samples: [], planningMs, forecast: { ...start, diagnostics, observation: {
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
  return { ...result, ...(adjusted ? { ok: true, why: undefined } : {}), planningMs, forecast: { diagnostics, ...(plan.fall ? { fall: plan.fall } : {}), ...(adjusted ? { adjustedLanding: { ...bot.entity.position } } : {}) } }
}
export async function executePlan(bot: MovementBot, ctl: Cancellation, plan: JumpPlan, confirmed: (state: State) => boolean, completeWhen?: () => boolean): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[] }> {
  const samples: TrajectorySample[] = []; const hp = bot.health ?? 20
  if (plan.fall && (plan.fall.damage !== 1 || !bot._client || !safeFallCost(bot, plan.fall.damage))) return { ok: false, why: 'unsafe_fall_cost', ticks: 0, samples }
  const clock = require('../game-clock') as { now(): number }
  const previous = bot._ndParkourForecast
  const own = { from: { ...bot.entity.position }, next: { ...bot.entity.position }, until: clock.now() + 100, hp }
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
        else if ((bot.health ?? hp) < hp) { finish(false, 'hurt_during_trajectory'); return }
        own.from = { ...p }; own.until = clock.now() + 100
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
        void wait.catch(fail)
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
function* impulseLandingSearch(bot: MovementBot, initial: State, target?: Point, maxTicks = 160): Generator<void, JumpPlan | null> {
  const world = worldOf(bot); const geometry = geometryOf(bot, world); const sim = simulator(bot)
  let slice = performance.now() + .25
  for (const coast of target ? [3, 6, 10, 0] : [0]) {
    const state = clone(initial); const steps: Step[] = []; const states: State[] = []
    let peak = state.pos.y; let settled = 0; let landing: Point | null = null
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
      const safeFloor = state.onGround && state.vel.y <= 0 && !!support && landingDamage(support.block, peak - state.pos.y, bot.entity.attributes) === 0
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
export function planImpulseLanding(bot: MovementBot, initial: State, target?: Point, maxTicks = 160): JumpPlan | null {
  const search = impulseLandingSearch(bot, initial, target, maxTicks)
  for (;;) { const step = search.next(); if (step.done) return step.value }
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
    const clock = require('../game-clock') as { now(): number }; const hp = bot.health ?? 20
    const saved = bot._ndClutch.stats.water_saved; const samples: Array<{ pos: Point; velocity: Point; onGround: boolean; isInWater: boolean; hp?: number }> = []
    const previous = bot._ndParkourForecast
    const own = { from: { ...bot.entity.position }, next: { ...bot.entity.position }, until: clock.now() + 100, hp }
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
        own.from = { ...bot.entity.position }; own.until = clock.now() + 100
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
export async function catchWeb(bot: MovementBot, ctl: Cancellation, target: Point) {
  const plan = planWebCatch(bot, target)
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

export async function navigate(bot: MovementBot, ctl: Cancellation, options: JumpOptions & { target: Point; mode?: 'jump' | 'climb' | 'edge' | 'webcatch' | 'waterentry' | 'riptide' | 'route' | 'options'; ticks?: number; maxLandings?: number; timeoutSeconds?: number; launch?: WaterLaunch; waypoints?: readonly Point[]; automatic?: boolean; pitch?: number }) {
  if (options.mode === 'options') return { ok: true, options: localOptions(bot, { toward: options.target }) }
  if (options.mode === 'route') return route(bot, ctl, { toward: options.target, maxLandings: options.maxLandings, maxTicks: options.maxTicks, beam: options.beam, waypoints: options.waypoints, timeoutSeconds: options.timeoutSeconds, maxFallDamage: options.maxFallDamage })
  if (options.mode === 'webcatch') return catchWeb(bot, ctl, options.target)
  if (options.mode === 'waterentry') return enterWater(bot, ctl, options.target, options.ticks, options.launch, options.automatic)
  if (options.mode === 'riptide') {
    const me = bot.entity.position; const target = options.target
    return require('../utility').riptide(bot, Math.atan2(me.x - target.x, me.z - target.z), options.pitch ?? Math.atan2(target.y - me.y, flat(me, target)), { target, ctl, launch: options.launch })
  }
  if (options.mode === 'climb') return climb(bot, ctl, options.target, options.ticks)
  if (options.mode === 'edge') return holdEdge(bot, ctl, options.target, options.ticks)
  return executeJump(bot, ctl, options.target, options)
}

export async function route(bot: MovementBot, ctl: Cancellation, { toward: finalGoal, maxLandings = 40, maxTicks = 38, beam = 24, waypoints = [], timeoutSeconds = 120, maxFallDamage = 0 }: { toward: Point; maxLandings?: number; maxTicks?: number; beam?: number; waypoints?: readonly Point[]; timeoutSeconds?: number; maxFallDamage?: number }): Promise<{ ok: boolean; why?: string; landings: unknown[]; at: Point; visited: string[] }> {
  const clock = require('../game-clock') as { now(): number }
  const deadline = clock.now() + Math.max(1, Math.min(3600, timeoutSeconds)) * 1000
  const parentCtl = ctl; const expired = () => clock.now() >= deadline
  // Stop within the route's budget so its partial report reaches runIntent
  // before the outer deadline's twenty-second unwind allowance.
  ctl = { get aborted() { return parentCtl.aborted || expired() }, onAbort: parentCtl.onAbort }
  const visited = new Map<string, number>(); const traversed = new Set<string>(); const landings: unknown[] = []; const rejected: unknown[] = []; const blocked = new Set<string>(); const reboundCeilings = new Map<string, number>()
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
    let waypoints = remaining.length ? remaining : await supportRoute(geometry, me, toward, unavailable, flat(me, toward) > 14 ? 24 : 14, routing, reboundCeilings, () => ctl.aborted, damageBudget)
    if (ctl.aborted) return report(false, 'interrupted')
    if (!remaining.length && flat(me, toward) <= 14 && toward.y > me.y + 1.25 && (!waypoints.length || waypoints[waypoints.length - 1].target.y <= me.y + .2)) {
      // An inner platform can be a local minimum while the authored route bends
      // back around the tower. Widen the loaded graph once, before wandering.
      waypoints = await supportRoute(geometry, me, toward, unavailable, 24, routing, reboundCeilings, () => ctl.aborted, damageBudget)
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
      !unavailable.has(transitionKey(me, option.target, option.bounce)) &&
      (option === first || !(option.target.y < me.y - .25 && option.target.distanceTo(new Vec3(toward.x, toward.y, toward.z)) > me.distanceTo(new Vec3(toward.x, toward.y, toward.z)) + .25)))
      .filter((option, i, all) => all.findIndex(other => other.key === option.key) === i)
    let advanced = false
    for (const option of options.slice(0, 12)) {
      if (ctl.aborted) return report(false, 'interrupted')
      const result = await executeJump(bot, ctl, option.target, { beam, maxTicks: option.climb ? 180 : option.bounce ? 90 : maxTicks, bounce: option.bounce, climb: option.climb, allowWalk: true, planningMs: 180, maxFallDamage: damageBudget })
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
      const summary = { target: option.target, mode: option.mode ?? 'jump', bounce: option.bounce, climb: option.climb, support: option.support, waypoints: waypoints.slice(0, 10).map(p => ({ ...p.target, mode: p.mode, bounce: p.bounce, climb: p.climb })), routing, planningMs: result.planningMs, forecast: result.forecast, ok: result.ok, why: result.why, ticks: result.ticks, at: { ...actual }, hp: bot.health, actualLanding, trajectory }
      bot.emit?.('nd_parkour_route', summary)
      if (result.ticks) landings.push(summary)
      else rejected.push(summary)
      // A refused forecast only blocks its particular edge. It never means
      // this support was visited; a different intermediate landing can reach it.
      if (result.ok || actualLanding) {
        traversed.add(transitionKey(me, option.target, option.bounce))
        traversed.add(transitionKey(me, bot.entity.position, option.bounce))
        for (const key of new Set([option.key, landingKey(bot.entity.position)])) visited.set(key, (visited.get(key) ?? 0) + 1)
        advanced = true; failedPlans = 0; remaining = result.ok && option === first ? waypoints.slice(1) : []; break
      }
      blocked.add(transitionKey(me, option.target, option.bounce))
      const diagnostics = result.forecast && typeof result.forecast === 'object' && 'diagnostics' in result.forecast ? result.forecast.diagnostics as PlanningDiagnostics : undefined
      if (!result.ticks && option.bounce && !diagnostics?.why && Number.isFinite(diagnostics?.reboundCeiling)) reboundCeilings.set(`${landingKey(me)}~${landingKey(option.bounce)}`, diagnostics!.reboundCeiling!)
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
      const key = landingKey(target)
      const gain = toward ? me.distanceTo(new Vec3(toward.x, toward.y, toward.z)) - target.distanceTo(new Vec3(toward.x, toward.y, toward.z)) : target.y - me.y
      options.push({ target, key, support: support.block.name, score: gain * 2 - Math.max(0, me.y - target.y) * 2 - (visited.get(key) ?? 0) * 3 - flat(me, target) * .08 })
    }
  }
  const ascending = toward && toward.y > me.y + 1.25
  return options.sort((a, b) => (ascending ? Number(b.target.y > me.y + .2) - Number(a.target.y > me.y + .2) : 0) || b.score - a.score)
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
