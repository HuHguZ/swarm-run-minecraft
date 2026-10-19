// Mineflayer geometry and consumable protocols stay outside the pure tactical graph.
type Body = Record<string, any>
interface Controller { aborted: boolean; onAbort?: Array<() => void> }
interface Result { ok: boolean; why?: string; placed?: number; climbed?: number; method?: string; target?: Body; at?: Body }
import * as clock from '../game-clock'
import * as kit from '../fightkit'
import * as unstuck from '../unstuck'
import build = require('../build')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import pick = require('../pick')
const lavaBlock = (block: Body | null): boolean => !!block && /lava/.test(block.name)

export function splashImpact(bot: Body): Body | null {
  const eye = pick.eyeOf(bot)
  const origin = eye.floored()
  const faces = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  let best: Body | null = null
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
    const position = origin.offset(dx, dy, dz)
    const block = bot.blockAt(position)
    if (block?.boundingBox !== 'block' || lavaBlock(block)) continue
    for (const face of faces) {
      const point = pick.faceAim(bot, position, face, { eye, range: 2.8 })
      if (!point) continue
      const distance = point.distanceTo(eye)
      if (!best || distance < best.distance) best = { point, distance }
    }
  }
  return best
}

export function inLava(bot: Body): boolean {
  return !!bot.entity?.isInLava || lavaBlock(bot.blockAt(bot.entity.position)) || lavaBlock(bot.blockAt(bot.entity.position.offset(0, .9, 0)))
}

function reachedShore(bot: Body, target: Body): boolean {
  const point = bot.entity.position
  return !inLava(bot) && bot.entity.onGround && point.y >= target.y - .2 &&
    Math.abs(point.x - target.x) < .25 && Math.abs(point.z - target.z) < .25
}

export function wallExit(bot: Body): Body | null {
  const feet = bot.entity.position.floored()
  let best: Body | null = null
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
    if (Math.hypot(dx, dz) < 1 || Math.hypot(dx, dz) > 8) continue
    for (let dy = 1; dy <= 8; dy++) {
      const point = feet.offset(dx, dy, dz)
      const floor = bot.blockAt(point.offset(0, -1, 0))
      if (floor?.boundingBox !== 'block' || lavaBlock(floor)) continue
      if ([0, 1, 2].some(y => bot.blockAt(point.offset(0, y, 0))?.boundingBox !== 'empty' || lavaBlock(bot.blockAt(point.offset(0, y, 0))))) continue
      const distance = Math.hypot(dx, dz)
      const score = distance + dy * .5
      if (!best || score < best.score) best = { at: point.offset(.5, 0, .5), score, rise: dy }
    }
  }
  return best
}

export function lavaCapabilities(session: Body): { potion: boolean; climb: boolean; exit: string } {
  const bot = session.bot
  const potion = !!kit.findPotion(bot, 'fire_resistance', { splash: false }) ||
    !!kit.findPotion(bot, 'fire_resistance', { splash: true }) && !!splashImpact(bot)
  const pending = session._tacticalLavaClimbGoal
  if (pending) {
    const target = pending.at
    if (reachedShore(bot, target)) {
      delete session._tacticalLavaClimbGoal
      return { potion, climb: false, exit: '' }
    }
    return { potion, climb: !pending.failed && clock.now() < pending.deadline,
      exit: `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}` }
  }
  if (!inLava(bot)) return { potion, climb: false, exit: '' }
  if (!potion && !kit.hasEffect(bot, 'fire_resistance')) return { potion, climb: false, exit: '' }
  const route = unstuck.fluidRoute(bot, lavaBlock, { radius: 10 })
  const wall = build.pickFiller(bot, { steady: true }) ? wallExit(bot) : null
  const exit = route?.target || wall?.at
  return { potion, climb: !!exit, exit: exit ? `${Math.floor(exit.x)},${Math.floor(exit.y)},${Math.floor(exit.z)}` : '' }
}

export async function drinkFireResistance(session: Body, ctl: Controller): Promise<Result> {
  const bot = session.bot
  const impact = splashImpact(bot)
  const item = impact && kit.findPotion(bot, 'fire_resistance', { splash: true }) || kit.findPotion(bot, 'fire_resistance', { splash: false })
  if (!item || ctl.aborted) return { ok: false, why: 'fire resistance unavailable' }
  if (item.name === 'splash_potion') {
    await bot.equip(item, 'hand')
    if (ctl.aborted) return { ok: false, why: 'interrupted before splash' }
    await bot.lookAt(impact!.point, true)
    if (!ctl.aborted) bot.activateItem()
  } else {
    const stop = () => { try { bot.deactivateItem() } catch {} }
    ctl.onAbort?.push(stop)
    try { await kit.consume(bot, item, 'fire_resistance') } finally {
      if (ctl.onAbort) ctl.onAbort = ctl.onAbort.filter(fn => fn !== stop)
    }
  }
  const deadline = clock.now() + 1800
  while (!ctl.aborted && bot.health > 0 && !kit.hasEffect(bot, 'fire_resistance') && clock.now() < deadline) await clock.sleep(100)
  const ok = !ctl.aborted && kit.hasEffect(bot, 'fire_resistance')
  session.bus.emit('drank', { potion: 'fire_resistance', ok, source: 'tactical' })
  return { ok, ...(ok ? { method: 'fire resistance' } : { why: 'fire resistance not confirmed' }) }
}

export async function climbFromLava(session: Body, ctl: Controller): Promise<Result> {
  const bot = session.bot
  const existing = session._tacticalLavaClimbGoal
  if (existing && reachedShore(bot, existing.at)) {
    delete session._tacticalLavaClimbGoal
    return { ok: true, method: 'original shore reached', target: existing.at, at: bot.entity.position.clone() }
  }
  if (existing && (existing.failed || clock.now() >= existing.deadline)) {
    existing.failed = true
    return { ok: false, why: existing.why || 'original shore rescue budget exhausted', target: existing.at }
  }
  const activeGoal = existing || null
  if (!inLava(bot) && !activeGoal) return { ok: true, method: 'already dry' }
  if (!kit.hasEffect(bot, 'fire_resistance')) return { ok: false, why: 'lava climb requires confirmed fire resistance' }
  const context = { bot, session, ctl, mcData: session.mcData, sleep: clock.sleep }
  const route = activeGoal ? null : unstuck.fluidRoute(bot, lavaBlock, { radius: 10 })
  const wall = activeGoal ? { at: activeGoal.at } : wallExit(bot)
  const target = activeGoal?.at || route?.target || wall?.at
  if (!target) return { ok: false, why: 'no loaded shore or usable wall with building blocks' }
  const startY = activeGoal?.startY ?? bot.entity.position.y
  const goal = activeGoal || { at: target, deadline: clock.now() + 12000, startY, placed: 0 }
  session._tacticalLavaClimbGoal = goal
  let lastProgress = goal.lastProgress ?? clock.now()
  let bestY = goal.bestY ?? bot.entity.position.y
  let placed = goal.placed
  const reached = () => reachedShore(bot, target)
  const fail = (why: string): Result => {
    if (!ctl.aborted) { goal.failed = true; goal.why = why }
    return { ok: false, placed, why, target, at: bot.entity.position.clone() }
  }
  const complete = (method: string): Result => ({ ok: true, placed, climbed: bot.entity.position.y - startY, method, target, at: bot.entity.position.clone() })
  const progress = () => {
    if (bot.entity.onGround && bot.entity.position.y > bestY + .3) {
      bestY = bot.entity.position.y; lastProgress = clock.now()
      goal.bestY = bestY; goal.lastProgress = lastProgress
      goal.deadline = lastProgress + 12000
    }
  }
  try {
    bot.pathfinder?.setGoal(null)
    bot.clearControlStates()
    if (route) {
      await unstuck.RUNGS.swimOutLava(context)
      if (reached()) return complete('swam to loaded shore')
    }
    if (!wall || !build.pickFiller(bot, { steady: true })) return fail('swimming did not reach shore and no usable wall with blocks remains')
    while (!ctl.aborted && bot.health > 0 && clock.now() < goal.deadline) {
      if (reached()) return complete('visible wall steps')
      if (!kit.hasEffect(bot, 'fire_resistance')) return fail('fire resistance ended')
      const point = bot.entity.position
      if (!inLava(bot) && bot.entity.onGround && point.y < target.y - .2) {
        for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(key, false)
        await clock.sleep(50)
        if (ctl.aborted) break
        const before = bot.entity.position.y
        const result = await build.towerUp(bot, ctl, 1, { sneak: true, fast: false })
        placed += result.placed || 0
        goal.placed = placed
        session.bus.emit('tactical_phase', { action: 'ClimbOut', phase: 'Tower', before, after: bot.entity.position.y, target, result })
        progress()
        continue
      }
      const dx = target.x - point.x; const dz = target.z - point.z
      const direction = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
      await bot.lookAt(target.offset(0, 1.2, 0), true)
      if (ctl.aborted) break
      bot.setControlState('sneak', false)
      bot.setControlState('jump', inLava(bot) || point.y < target.y - .2)
      bot.setControlState('forward', Math.hypot(dx, dz) > .2)
      const feet = point.floored()
      const step = feet.plus(direction)
      if (feet.y < target.y && Math.hypot(dx, dz) < 2.5 && bot.blockAt(step)?.boundingBox === 'empty' && bot.blockAt(step.offset(0, 1, 0))?.boundingBox === 'empty') {
        bot.setControlState('forward', false)
        const result = await build.placeBlockAt(bot, step, { honest: true, steady: true, timeoutMs: 1000 })
        session.bus.emit('tactical_phase', { action: 'ClimbOut', phase: 'Step', step, position: bot.entity.position.clone(), controls: Object.fromEntries(['forward', 'jump', 'sneak'].map(key => [key, bot.getControlState?.(key)])), result })
        if (result.ok && !result.already) placed++
        goal.placed = placed
        if (!ctl.aborted) { await bot.lookAt(target.offset(0, 1.2, 0), true); bot.setControlState('forward', true) }
      }
      progress()
      await clock.sleep(100)
    }
  } finally {
    if (session._tacticalLavaClimbGoal === goal) {
      if (reached() || bot.health <= 0) delete session._tacticalLavaClimbGoal
      else if (!ctl.aborted) { goal.failed = true; goal.why ||= 'original shore rescue stopped before reaching its goal' }
    }
    try { bot.clearControlStates() } catch {}
  }
  return fail(ctl.aborted ? 'lava climb interrupted' : 'lava climb budget exceeded')
}
