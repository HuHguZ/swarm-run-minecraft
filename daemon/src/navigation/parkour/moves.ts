// Паркур: удержание края, лестница, спуск, дверь.
import { Vec3 } from 'vec3'
import { bodyClear, supportAt, type Point } from '../geometry'
import { WOOD_DOOR } from '../support-route'
import { simulator, PlayerState, controls, worldOf, flat, clone, IDLE } from './model'
import type { MovementBot, Cancellation, Control } from './model'

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

/**
 * Lab only: walk off the current ledge toward `target` with ordinary keys, release them in the air
 * and leave the fall to the reflexes (clutch: water, ladder, blocks). Reports the observed landing.
 */
export async function dropOff(bot: MovementBot, ctl: Cancellation, target: Point, ticks = 240) {
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
  const pick = require('../../pick') as { eyeOf(bot: unknown): Vec3; blockSeen(bot: unknown, p: Vec3, o?: { range?: number }): boolean }
  const eye = pick.eyeOf(bot)
  const half = [lower, lower.offset(0, 1, 0)].find(p => eye.distanceTo(p.offset(.5, .5, .5)) <= 4.5 && pick.blockSeen(bot, p, { range: 4.5 }))
  if (!half) return { ok: false, why: 'door_not_visible' }
  await body.lookAt(half.offset(.5, .5, .5), true)
  await body.activateBlock(bot.blockAt(half, false))
  for (let tick = 0; tick < 20 && !ctl.aborted; tick++) { if (isOpen()) return { ok: true }; await bot.waitForTicks(1) }
  return { ok: false, why: ctl.aborted ? 'interrupted' : 'door_not_opened' }
}
