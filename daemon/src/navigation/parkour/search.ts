// Паркур: поиск прыжка по прогнозу кадров — прямой, с разбегом, с уступа; план и его прогноз.
import { Vec3 } from 'vec3'
import { bodyClear, dimensions, groundedHazardClear, standPositions, supportAt, type Point } from '../geometry'
import { detour } from '../shape-detour'
import { hasFallMitigation, landingDamage } from '../landing'
import { onClimbable, climbColumn } from '../support-route'
import { worldOf, simulator, geometryOf, PlayerState, controls, fallBudget, chainApex, flat, clone, withinArena, onTarget, rest, reboundApex } from './model'
import type { MovementBot, JumpOptions, JumpPlan, Step, State, PlanningDiagnostics, Cancellation } from './model'

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
      if (!withinArena(bot, state.pos, opts.arena)) break
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
        const stopping = rest(bot, state, world, opts.tolerance ?? .22, target, opts.arena)
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
        if (!withinArena(bot, state.pos, opts.arena)) break
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
          const stopping = rest(bot, state, world, opts.tolerance ?? .22, target, opts.arena)
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

// A shelf below an overhang needs a real rim launch before steering back under it.
function* ledgeSearch(bot: MovementBot, target: Point, opts: JumpOptions, world: ReturnType<typeof worldOf>): Generator<void, JumpPlan | null> {
  if (!opts.allowWalk || target.y >= bot.entity.position.y - .55) return null
  const geometry = geometryOf(bot, world), sim = simulator(bot), base = new PlayerState(bot, controls())
  const half = dimensions(bot).half, exits: Array<{ at: Vec3; cost: number }> = [], budget = fallBudget(bot, opts.maxFallDamage)
  const center = base.pos.floored()
  for (let x = center.x - 4; x <= center.x + 4; x++) for (let z = center.z - 4; z <= center.z + 4; z++) {
    if (Math.hypot(x + .5 - base.pos.x, z + .5 - base.pos.z) > 4.5) continue
    for (const stand of standPositions(geometry, { x, y: base.pos.y, z }, { rise: 0, drop: 0 })) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        // Align beside the observed corner while still supported: all sideways
        // distance cannot be earned during the few air ticks of a shallow drop.
        const aim = dx ? target.z - stand.z : target.x - stand.x, room = .5 - half - .01
        for (const offset of new Set([0, Math.max(-room, Math.min(room, aim))])) {
          const launch = stand.offset(dx ? 0 : offset, 0, dx ? offset : 0)
          const at = launch.offset(dx * (.5 + half + .03), 0, dz * (.5 + half + .03))
          if (!supportAt(geometry, launch, .04) || !bodyClear(geometry, launch) || !withinArena(bot, at, opts.arena) || supportAt(geometry, at, .04) || !bodyClear(geometry, at)) continue
          exits.push({ at, cost: flat(base.pos, at) + flat(at, target) })
        }
      }
    }
  }
  exits.sort((a, b) => a.cost - b.cost)
  let slice = performance.now() + .25
  for (const exit of exits.slice(0, 8)) for (const coast of [2, 4, 6, 0]) for (const slow of [true, false]) for (const crouch of [false, true]) {
    if (opts.diagnostics) opts.diagnostics.profiles++
    const approach = detour(geometry, base.pos, exit.at), state = clone(base), steps: Step[] = [], states: State[] = []
    let airborne = false, fallDistance = 0, fall: JumpPlan['fall']
    for (let tick = 0; tick < Math.min(100, opts.maxTicks ?? 60); tick++) {
      if (performance.now() >= slice) { yield; slice = performance.now() + .25 }
      const waypoint = airborne ? target : approach(state.pos).waypoint
      const braking = airborne || state.onGround && state.pos.y < base.pos.y - .55 ? coast : 0
      const dx = waypoint.x - state.pos.x - state.vel.x * braking, dz = waypoint.z - state.pos.z - state.vel.z * braking
      const nearRim = flat(state.pos, exit.at)
      const settled = state.onGround && Math.abs(state.pos.y - target.y) < .03
      const step = { yaw: Math.atan2(-dx, -dz), control: controls({ forward: Math.hypot(dx, dz) > .025,
        sneak: settled || crouch && airborne || slow && !airborne && nearRim < .8 && nearRim > .12 }) }
      const previous = state.pos.clone(); state.yaw = step.yaw; state.control = step.control; sim(state, world)
      noteForecast(opts.diagnostics, state, target)
      if (!withinArena(bot, state.pos, opts.arena)) break
      airborne ||= !state.onGround && state.pos.y < base.pos.y - .01
      fallDistance += Math.max(0, previous.y - state.pos.y)
      const posture = { ...geometry, physics: { ...geometry.physics, playerHeight: state.ndPoseHeight ?? dimensions(geometry).height } }
      if (state.isInLava || state.isInWater || state.isInWeb || state.pos.y < target.y - .4 || !bodyClear(posture, state.pos) || !groundedHazardClear(posture, state.pos, state.vel.y, state.onGround)) break
      if (state.onGround) {
        const support = supportAt(geometry, state.pos, .04)
        const damage = support ? landingDamage(support.block, fallDistance, bot.entity.attributes) : 0
        if (damage > budget || damage && fall) break
        if (damage && support) fall = { damage, support: { ...support.block.position }, supportName: support.block.name, tick: steps.length, pos: { ...state.pos } }
        fallDistance = 0
        if (airborne && Math.abs(state.pos.y - target.y) > .03) break
      }
      steps.push(step); states.push(clone(state))
      if (airborne && onTarget(geometry, state, target, opts.tolerance ?? .22)) {
        const stopping = rest(bot, state, world, opts.tolerance ?? .22, target, opts.arena)
        if (stopping) return { steps: [...steps, ...stopping.steps], states: [...states, ...stopping.states], target: { ...target }, ticks: steps.length + stopping.steps.length, ...(fall ? { fall } : {}) }
      }
    }
  }
  return null
}

function* jumpSearch(bot: MovementBot, target: Point, opts: JumpOptions = {}, cancelled?: () => boolean): Generator<void, JumpPlan | null> {
  if (![target.x, target.y, target.z].every(Number.isFinite) || !bot.physics || !bot.entity?.onGround || bot.entity.isInLava || bot.entity.isInWater) { if (opts.diagnostics) opts.diagnostics.why = 'invalid_native_start'; return null }
  if (!withinArena(bot, bot.entity.position, opts.arena) || !withinArena(bot, target, opts.arena)) { if (opts.diagnostics) opts.diagnostics.why = 'outside_arena'; return null }
  const column = opts.climb ? climbColumn(bot, opts.climb, cancelled, opts.planningMs) : null
  const springs = opts.bounce ? [opts.bounce, ...(opts.chain ?? [])] : []
  if (flat(bot.entity.position, target) > (opts.bounce ? 6 + 8 * springs.length : 6) || !opts.climb && target.y - bot.entity.position.y > 1.25 || !supportAt(bot, target, .04) || !bodyClear(bot, target) || springs.some(spring => supportAt(bot, spring, .04)?.block.name !== 'slime_block' || !bodyClear(bot, spring)) || opts.climb && (!column || column.top < Math.floor(target.y) || !bodyClear(bot, opts.climb))) { if (opts.diagnostics) opts.diagnostics.why = 'unsupported_or_obstructed_target'; return null }
  const tolerance = opts.tolerance ?? .22
  const world = worldOf(bot); const sim = simulator(bot)
  const geometry = geometryOf(bot, world); const route = detour(geometry, bot.entity.position, target)
  const direct = yield* directSearch(bot, target, opts, world, route)
  if (direct) return direct
  if (opts.bounce || opts.climb) return null
  const ledge = yield* ledgeSearch(bot, target, opts, world)
  if (ledge) return ledge
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
        if (!withinArena(bot, state.pos, opts.arena)) continue
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
          const stopping = rest(bot, state, world, tolerance, target, opts.arena)
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
