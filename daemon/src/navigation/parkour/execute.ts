// Паркур: исполнение плана прыжка по тикам со сверкой тела и прогноза, прыжок к цели, спуск на уступ.
import { Vec3 } from 'vec3'
import { bodyBox, bodyClear, supportAt, type CollisionBlock, type Point } from '../geometry'
import { PlayerState, controls, JUMP_FRAMES, onTarget, settledLanding, MAX_FALL_DAMAGE, ROUTE_FRAMES, withinArena, safeFallCost, forecastOwner, simulator, worldOf, IDLE } from './model'
import type { MovementBot, Cancellation, JumpOptions, PlanningDiagnostics, MovementArena, JumpPlan, State, Control } from './model'
import { planJumpAsync } from './search'

interface TrajectorySample {
  tick: number; pos: Point; velocity: Point; onGround: boolean; hp?: number;
  expected: { pos: Point; velocity: Point; onGround: boolean; jumpQueued: boolean; jumpTicks: number };
  observation?: { actual: ReturnType<typeof bodyObservation>; expected: ReturnType<typeof bodyObservation> }
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
  const clock = require('../../game-clock') as { now(): number }
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
  const result = await executePlan(bot, ctl, { ...plan, arena: opts.arena }, st => onTarget(bot, st, target, opts.tolerance ?? .25))
  // A real step-height collision can settle on an adjacent partial top inside
  // the destination footprint. Macro routing may continue from that observed
  // support after six actual stable ticks; explicit targets remain exact.
  const last = result.samples.slice(-6) as Array<{ pos: Point; velocity: Point; onGround: boolean }>
  const adjusted = !result.ok && result.why === 'landing_not_confirmed' && opts.allowWalk && last.length === 6 && last.every(sample =>
    settledLanding(bot, { pos: new Vec3(sample.pos.x, sample.pos.y, sample.pos.z), vel: new Vec3(sample.velocity.x, sample.velocity.y, sample.velocity.z), onGround: sample.onGround }, target, Math.max(.35, opts.tolerance ?? .25)))
  return { ...result, ...(adjusted ? { ok: true, why: undefined } : {}), planningMs, planningTicks, forecast: { diagnostics, ...(plan.fall ? { fall: plan.fall } : {}), ...(adjusted ? { adjustedLanding: { ...bot.entity.position } } : {}) } }
}
/** A bounded local descent; every input and landing remains native player motion. */
export async function ledgeTo(session: { require(): MovementBot }, ctl: Cancellation, opts: { at: Point; maxFallDamage?: number; timeoutSeconds?: number; arena?: MovementArena }) {
  const bot = session.require(), target = opts?.at, seconds = opts?.timeoutSeconds ?? 8, damage = opts?.maxFallDamage ?? 0
  const refuse = (why: string) => ({ ok: false, landed: false, why, ticks: 0, samples: [], at: { ...bot.entity.position } })
  if (!target || ![target.x, target.y, target.z, seconds, damage].every(Number.isFinite) || Math.abs(target.x) > 29999984 || Math.abs(target.z) > 29999984 ||
    target.y < (bot.game?.minY ?? -64) || target.y >= (bot.game?.minY ?? -64) + (bot.game?.height ?? 384) || seconds < .5 || seconds > 30 || damage < 0 || damage > MAX_FALL_DAMAGE) return refuse('invalid_ledge_request')
  if (opts.arena !== undefined && (!opts.arena || typeof opts.arena !== 'object')) return refuse('invalid_ledge_request')
  if (target.y >= bot.entity.position.y - .55) return refuse('target_is_not_lower')
  if (ctl.aborted) return refuse('interrupted')
  const clock: typeof import('../../game-clock') = require('../../game-clock')
  let expired = false
  const local: Cancellation = { get aborted() { return expired || ctl.aborted }, onAbort: [] }
  const abort = () => { for (const callback of [...local.onAbort!]) callback() }
  ctl.onAbort?.push(abort)
  const timer = clock.setTimeout(() => { expired = true; abort() }, seconds * 1000)
  try {
    const result = await executeJump(bot, local, target, { allowWalk: true, maxTicks: 80, maxFrames: ROUTE_FRAMES, maxFallDamage: damage, arena: opts.arena })
    return { ...result, ...(expired ? { ok: false, why: 'timeout' } : {}), landed: result.ok && !expired, at: { ...bot.entity.position } }
  } finally {
    clock.clearTimeout(timer)
    const index = ctl.onAbort?.indexOf(abort) ?? -1
    if (index >= 0) ctl.onAbort!.splice(index, 1)
  }
}
export async function executePlan(bot: MovementBot, ctl: Cancellation, plan: JumpPlan, confirmed: (state: State) => boolean, completeWhen?: () => boolean): Promise<{ ok: boolean; why?: string; ticks: number; samples: unknown[] }> {
  const samples: TrajectorySample[] = []; const hp = bot.health ?? 20
  if (!withinArena(bot, bot.entity.position, plan.arena) || plan.states.some(state => !withinArena(bot, state.pos, plan.arena))) return { ok: false, why: 'outside_arena', ticks: 0, samples }
  if (plan.fall && (plan.fall.damage < 1 || plan.fall.damage > MAX_FALL_DAMAGE || !bot._client || !safeFallCost(bot, plan.fall.damage))) return { ok: false, why: 'unsafe_fall_cost', ticks: 0, samples }
  if (plan.allowDamage && (plan.allowDamage.damage > MAX_FALL_DAMAGE || !safeFallCost(bot, plan.allowDamage.damage))) return { ok: false, why: 'unsafe_fall_cost', ticks: 0, samples }
  const clock = require('../../game-clock') as { now(): number }
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
    const landedOnForecast = (exact = true) => {
      if (!plan.fall || tick <= plan.fall.tick) return false
      const expected = plan.states[Math.min(tick - 1, plan.states.length - 1)]; const p = bot.entity.position
      const support = supportAt(bot, p, .02)
      return bot.entity.onGround && bot.entity.velocity.y <= 0 && expected.onGround && (!exact || p.distanceTo(expected.pos) <= .1) && bodyClear(bot, p) &&
        !!support && Math.abs(support.top - p.y) < .02 && support.block.name === plan.fall.supportName &&
        new Vec3(support.block.position.x, support.block.position.y, support.block.position.z).distanceTo(new Vec3(plan.fall.support.x, plan.fall.support.y, plan.fall.support.z)) < .01
    }
    const onHealth = () => {
      if (done || !plan.fall) return
      const current = bot.health ?? 0
      lost += Math.max(0, lastHp - current); lastHp = current
      if (!lost) return
      // The typed packet already bound this fall to its actual native contact.
      // Supported centering can drift inside the shelf without taking new damage.
      if (lost > plan.fall.damage || !landedOnForecast(!fallReceipt) || !safeFallCost(bot, 0)) { finish(false, 'hurt_during_trajectory'); return }
      // A health update may precede its typed fall packet. Hold this confirmed
      // floor within the existing six-tick resting window until both arrive.
      if (fallReceipt) own.hp = current
    }
    const onDamage = (packet: { entityId: number; sourceTypeId: number; sourceCauseId: number; sourceDirectId: number }) => {
      if (done || packet.entityId !== bot.entity.id) return
      if (fallReceipt || (require('../../gamedata') as typeof import('../../gamedata')).damageTypeName(packet.sourceTypeId) !== 'fall' || packet.sourceCauseId || packet.sourceDirectId || !landedOnForecast()) {
        finish(false, 'unexpected_damage_receipt'); return
      }
      fallReceipt = true; onHealth()
    }
    const applyStep = () => {
      const step = plan.steps[tick]
      if (plan.arena) {
        const next = new PlayerState(bot, step.control); next.yaw = step.yaw
        simulator(bot)(next, worldOf(bot))
        if (!withinArena(bot, next.pos, plan.arena)) { finish(false, 'outside_arena'); return }
      }
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
        if (!withinArena(bot, p, plan.arena)) { finish(false, 'outside_arena'); return }
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
        if (done) return
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
