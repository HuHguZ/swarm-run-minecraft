// Паркур: паутина, вода и мягкая посадка (импульс, вход в воду, ловля паутиной).
import { Vec3 } from 'vec3'
import { bodyClear, containsWater, dimensions, shapeBoxes, supportAt, waterEntries, type CollisionBlock, type CollisionWorld, type Point } from '../geometry'
import { hasFallMitigation, landingDamage } from '../landing'
import { PlayerState, controls, worldOf, simulator, clone, geometryOf, onTarget, forecastOwner, IDLE } from './model'
import type { MovementBot, JumpPlan, Step, State, Cancellation, WaterLaunch, Control } from './model'
import { executePlan } from './execute'

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
  const observed = bot.world ? ((require('../../sight') as typeof import('../../sight')).seesBlock as (bot: MovementBot, block: CollisionBlock) => boolean)(bot, block) : bot.canSeeBlock?.(block)
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
