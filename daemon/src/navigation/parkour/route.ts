// Паркур: маршрут по опорам (посадки, отложенные рёбра, широкий граф, трезубец), ближние варианты, прыжок в бою.
import { Vec3 } from 'vec3'
import { bodyClear, invalidateStands, standPositions, supportAt, type Point } from '../geometry'
import { clearanceMargin, detour } from '../shape-detour'
import { supportRoute, forgetCell, landingKey, transitionKey, highRidge, type LandingOption, type RoutingDiagnostics } from '../support-route'
import { ROUTE_FRAMES, flat, worldOf, geometryOf, fallBudget, reboundApex, settledLanding, visibleLanding } from './model'
import type { MovementBot, Cancellation, PlanningDiagnostics } from './model'
import { executeJump } from './execute'
import { openDoor } from './moves'

/** A budget-refused route edge is retried once with this many times the frames, after cheaper alternatives. */
/** Radius of the one-off wide support graph when the 24-block disc cannot reach the goal. */
const WIDE_RADIUS = 40
const DEFERRED_SCALE = Number(process.env.ND_ROUTE_DEFERRED_SCALE ?? 4); const DEFERRED_COST = Number(process.env.ND_ROUTE_DEFERRED_COST ?? 8)

type RouteOptions = { toward: Point; maxLandings?: number; maxTicks?: number; beam?: number; waypoints?: readonly Point[]; timeoutSeconds?: number; maxFallDamage?: number; frames?: number }
// Рывок «Тягуном» (riptide.runRiptide). utility.riptide без трезубца или воды отвечает { ok: false, why } без ticks — такой
// отказ ворота ok || ticks > 0 не проходит, поэтому итог riptideTo здесь читается как итог runRiptide.
type RiptideRun = import('../riptide').RiptideResult
type RouteResult = { ok: boolean; why?: string; landings: unknown[]; rejected: unknown[]; reachedGoals: unknown[]; goalIndex: number; at: Point; visited: string[] }
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
  const clock = require('../../game-clock') as { now(): number }
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
      const boost = await (require('../../utility') as typeof import('../../utility')).riptideTo(bot, ctl, toward) as RiptideRun
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
    const boost = await (require('../../utility') as typeof import('../../utility')).riptideTo(bot, ctl, position) as RiptideRun
    if (boost.ok || boost.ticks > 0) return { ...boost, samples: boost.samples ?? [] }
  }
  return { ok: false, why: 'no_local_landing', ticks: 0, samples: [] }
}
