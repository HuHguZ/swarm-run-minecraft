// Паркур: типы тела и плана, константы бюджета, кадр нативной физики, арена, падение.
import { Vec3 } from 'vec3'
import { bodyClear, dimensions, supportAt, type CollisionBlock, type CollisionWorld, type Point } from '../geometry'

export interface Control { forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sprint: boolean; sneak: boolean }
export interface State {
  pos: Vec3; vel: Vec3; yaw: number; pitch: number; control: Control; onGround: boolean;
  isInWeb: boolean; isInLava: boolean; isInWater: boolean; jumpQueued: boolean; jumpTicks: number;
  isCollidedHorizontally: boolean; isCollidedVertically: boolean
  ndPoseHeight?: number
}
export interface Step { yaw: number; control: Control }
export interface WaterLaunch { ticks: number; yawOffset?: number; sprint?: boolean }
export interface MovementBot extends CollisionWorld {
  version: string; health?: number; food?: number;
  entity: { id?: number; position: Vec3; velocity: Vec3; yaw: number; pitch: number; onGround: boolean; isInWeb?: boolean; isInLava?: boolean; isInWater?: boolean; attributes?: Record<string, { value: number }>; _ndPoseHeight?: number };
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
export interface MovementArena { x: number; y?: number; z: number; r: number; killY?: number; minY?: number; avoid?: ReadonlyArray<Point & { r: number }> }
export interface JumpOptions { beam?: number; maxTicks?: number; tolerance?: number; web?: boolean; sprint?: boolean; allowWalk?: boolean; planningMs?: number; maxFrames?: number; diagnostics?: PlanningDiagnostics; bounce?: Point; chain?: Point[]; climb?: Point; maxFallDamage?: number; arena?: MovementArena }
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
  const clock = require('../../game-clock') as { now(): number }
  return { from: { ...from }, next: { ...next }, hp, get until() { return clock.now() + FORECAST_TTL_MS } }
}
// allowDamage (спуск по уступам, descent.ts): урон падения не больше damage после тика посадки — не отказ; без сверки
// квитанции с точкой прогноза (тело тормозит на уступе — позиция уходит от прогноза дальше 0.1, и `fall` отвергал посадку).
export interface JumpPlan { steps: Step[]; states: State[]; target: Point; ticks: number; fall?: { damage: number; support: Point; supportName: string; tick: number; pos: Point }; allowDamage?: { damage: number; tick: number }; arena?: MovementArena }
export const { PlayerState } = (require('../../tick-plugins') as typeof import('../../tick-plugins')).getPhysics() as { PlayerState: new(bot: MovementBot, control: Control) => State }
export const IDLE: Control = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
export const flat = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z)
export const controls = (extra: Partial<Control> = {}): Control => ({ ...IDLE, ...extra })
export function withinArena(bot: CollisionWorld, pos: Point, arena?: MovementArena, from: Point = pos): boolean {
  if (!arena) return true
  const half = dimensions(bot).half
  return [arena.x, arena.z, arena.r, ...(arena.y === undefined ? [] : [arena.y]), ...(arena.killY === undefined ? [] : [arena.killY]), ...(arena.minY === undefined ? [] : [arena.minY])].every(Number.isFinite) &&
    Math.abs(pos.x - arena.x) + half <= arena.r - 1 && Math.abs(pos.z - arena.z) + half <= arena.r - 1 &&
    (arena.killY === undefined || pos.y > arena.killY) && (arena.minY === undefined || pos.y >= arena.minY) &&
    (arena.avoid === undefined || Array.isArray(arena.avoid) && arena.avoid.every(e => {
      if (!e || ![e.x, e.y, e.z, e.r].every(Number.isFinite) || e.r < 0) return false
      // Check the swept edge too: safe endpoints can cut a chord through the sphere.
      const dx = pos.x - from.x, dy = pos.y - from.y, dz = pos.z - from.z
      const t = Math.max(0, Math.min(1, ((e.x - from.x) * dx + (e.y - from.y) * dy + (e.z - from.z) * dz) / (dx * dx + dy * dy + dz * dz || 1)))
      return Math.hypot(from.x + dx * t - e.x, from.y + dy * t - e.y, from.z + dz * t - e.z) + 1e-6 >= e.r
    }))
}
// Стоящий уже за границей (сел на внешний гребень, отброс) — арена по xz расширена до него: назад внутрь и вдоль своей кромки
// можно, дальше наружу — нет (cl28r 28.10: на волосок за границей каждый путь боя был noPath — все соседи вне арены).
export function arenaAround<A extends MovementArena | undefined>(bot: CollisionWorld, arena: A, from: Point): A {
  if (!arena || !from || withinArena(bot, from, arena)) return arena
  const out = Math.max(Math.abs(from.x - arena.x), Math.abs(from.z - arena.z)) + dimensions(bot).half - (arena.r - 1)
  return out > 0 ? { ...arena, r: arena.r + out + 1e-6 } : arena
}
export function clone(st: State): State { return Object.assign(Object.create(Object.getPrototypeOf(st)) as State, st, { pos: st.pos.clone(), vel: st.vel.clone(), control: { ...st.control } }) }
export function worldOf(bot: MovementBot) {
  const cells = new Map<string, ReturnType<CollisionWorld['blockAt']>>()
  return { getBlock(p: Vec3) {
    const q = p.floored(); const key = `${q.x},${q.y},${q.z}`
    if (!cells.has(key)) cells.set(key, bot.blockAt(q, false))
    return cells.get(key)
  } }
}
export function geometryOf(bot: MovementBot, world: ReturnType<typeof worldOf>): CollisionWorld {
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
export function simulator(bot: MovementBot) { return (bot._ndSimOrig ?? bot.physics.simulatePlayer).bind(bot.physics) }
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
export function safeFallCost(bot: MovementBot, damage: number): boolean {
  try {
    const tactical = bot._ndReflexSession?.tactics?.snapshot()
    if (tactical && (!tactical.state || tactical.state.enemies.some(enemy => enemy.threatening))) return false
    const safety = (require('../../combat-safety') as typeof import('../../combat-safety')).inspect(bot, { minHealth: 12 })
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
export function fallBudget(bot: MovementBot, requested?: number): number {
  const want = Math.min(MAX_FALL_DAMAGE, Math.floor(requested ?? 0))
  return want >= 1 && safeFallCost(bot, want) ? want : 0
}
export function simulatePlan(bot: MovementBot, steps: readonly Step[], observe?: (state: State) => void, initial?: State): State {
  const state = initial ? clone(initial) : new PlayerState(bot, controls()); const world = worldOf(bot); const sim = simulator(bot)
  for (const step of steps) { state.yaw = step.yaw; state.control = { ...step.control }; sim(state, world); observe?.(state) }
  return state
}
export function onTarget(bot: CollisionWorld, state: State, target: Point, tolerance: number): boolean {
  return state.onGround && Math.abs(state.pos.y - target.y) < .03 && flat(state.pos, target) < tolerance && !!supportAt(bot, state.pos, .04) && bodyClear(bot, state.pos)
}
export function settledLanding(bot: MovementBot, state: Pick<State, 'pos' | 'vel' | 'onGround'>, target: Point, tolerance = .35): boolean {
  const support = supportAt(bot, state.pos, .02)
  return state.onGround && state.vel.y <= 0 && Math.hypot(state.vel.x, state.vel.z) < .035 && flat(state.pos, target) < tolerance &&
    state.pos.y >= target.y - .03 && state.pos.y <= target.y + (bot.physics.stepHeight ?? 0) + .03 &&
    !!support && Math.abs(support.top - state.pos.y) < .02 && bodyClear(bot, state.pos)
}
export function rest(bot: MovementBot, state: State, world: ReturnType<typeof worldOf>, tolerance: number, target: Point, arena?: MovementArena): { steps: Step[]; states: State[] } | null {
  const sim = simulator(bot); const st = clone(state); const steps: Step[] = []; const states: State[] = []
  const geometry = geometryOf(bot, world)
  for (let i = 0; i < 6; i++) {
    const step = { yaw: st.yaw, control: controls({ sneak: true }) }
    st.control = step.control; sim(st, world)
    if (!withinArena(bot, st.pos, arena) || !onTarget(geometry, st, target, tolerance)) return null
    steps.push(step); states.push(clone(st))
  }
  return Math.hypot(st.vel.x, st.vel.z) < .035 ? { steps, states } : null
}
