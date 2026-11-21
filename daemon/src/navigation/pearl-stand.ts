import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import { isAlly } from '../combat/ally-safety'
import { eyeHeight } from '../pick'
import { reachFrom } from '../pvp/body'
import { gearPartVisible, seesPlayer } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import { owner } from '../reflex-lock'
import { isSpear, MAX_R } from '../spear'
import { incoming } from '../threats'
import type { Session } from '../session'
import { bodyClear, supportAt, type CollisionWorld, type Point } from './geometry'
import { executePlan } from './parkour/execute'
import { flat, settledLanding, withinArena, type Cancellation, type MovementArena, type State } from './parkour/model'
import { planJumpAsync } from './parkour/search'

const TOLERANCE = .08

// Shooting clears the movement controls. Require support under the feet even after residual sideways drift.
export function stablePearlPost(bot, arena?: MovementArena, observed?: CollisionWorld) {
  const me = bot.entity, p = me?.position, v = me?.velocity
  if (!arena || !p || !v || !me.onGround || !bot.physics || !withinArena(bot, p, arena) ||
      v.y > 0 || Math.hypot(v.x, v.z) >= .035) return false
  const terrain = observed ?? observedCollision(bot)
  const support = supportAt(terrain, p, .02)
  if (!support || Math.abs(support.top - p.y) > .02 || !bodyClear(terrain, p)) return false
  // Maximum horizontal retention on ground is below the airborne factor of .91.
  const x = p.x + v.x / (1 - .91), z = p.z + v.z / (1 - .91)
  const stands = (x: number, z: number) => x >= support.box.minX && x <= support.box.maxX && z >= support.box.minZ && z <= support.box.maxZ
  return stands(p.x, p.z) && stands(x, z) && withinArena(bot, { x, y: p.y, z }, arena, p)
}

// A teammate can name a launch point. Only the runner's own sight can supply the walkable segment.
export async function pearlStand(session: Pick<Session, 'bot' | 'current' | 'require'>, ctl: Cancellation, { at, arena }: { at?: Point; arena?: MovementArena }) {
  const bot = session.require(), start = bot.entity.position.clone(), hp = bot.health ?? 20, deadline = clock.now() + 2000
  let lastFeet = start
  const result = (ok: boolean, why?: string, ticks = 0) => ({ ok, at: { ...(bot.entity?.position ?? lastFeet) }, ticks, ...(why && { why }) })
  if (!at || ![at.x, at.y, at.z].every(Number.isFinite) || flat(start, at) > 2 || Math.abs(start.y - at.y) > TOLERANCE) return result(false, 'outside_local_step')
  const target = new Vec3(at.x, start.y, at.z)
  const owns = () => session.bot === bot && (!('current' in session) || session.current?.ctl === ctl) && !owner(session)
  const active = () => owns() && !ctl.aborted && bot.entity && !bot.currentWindow && !bot.vehicle && clock.now() < deadline && (bot.health ?? 20) >= hp && hp > 0
  const observe = () => Object.assign(Object.create(bot), { blockAt: observedCollision(bot).blockAt })
  const footing = (terrain: CollisionWorld, p: Vec3, from: Vec3) => {
    if (Math.abs(start.y - p.y) > .001 || !withinArena(terrain, p, arena, from) || !bodyClear(terrain, p, { from })) return false
    const support = supportAt(terrain, p, .01)
    return !!support && p.x >= support.box.minX && p.x <= support.box.maxX && p.z >= support.box.minZ && p.z <= support.box.maxZ
  }
  const danger = (p: Vec3) => {
    if (incoming(bot, { horizonTicks: 10 }).length) return true
    return Object.values(bot.players || {}).some(({ entity: e, gamemode }: any) => {
      if (!e?.position || e === bot.entity || gamemode === 3 || isAlly(bot, e)) return false
      // Broad phase only selects which nearby bodies need a sight ray. A decision still requires personal sight.
      const half = (bot.entity.width || .6) / 2, dx = Math.max(0, Math.abs(e.position.x - p.x) - half), dz = Math.max(0, Math.abs(e.position.z - p.z) - half)
      if (dx * dx + dz * dz > MAX_R * MAX_R || !seesPlayer(bot, e)) return false
      const d = reachFrom(e.position.offset(0, eyeHeight(bot, e), 0), { position: p, width: bot.entity.width, height: bot.entity.height })
      return d <= 3 || d <= MAX_R && gearPartVisible(bot, e, 0) && isSpear((e.equipment?.[0] ?? e.heldItem)?.name)
    })
  }
  if (!active() || !bot.entity.onGround || danger(start)) return result(false, 'unsafe_start')
  const terrain = observe(), n = Math.max(1, Math.ceil(flat(start, target) * 5))
  let prior = start
  for (let i = 0; i <= n; i++) {
    const p = start.plus(target.minus(start).scaled(i / n))
    if (!footing(terrain, p, prior)) return result(false, 'no_observed_footing')
    prior = p
  }
  if (flat(start, target) < TOLERANCE && bot.entity.velocity.y <= 0 && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < .003) return result(true)
  const safeStep = (world: CollisionWorld, next: State) => {
    if (!active()) return false
    lastFeet = bot.entity.position.clone()
    return next.onGround && footing(world, next.pos, lastFeet) && !danger(next.pos)
  }
  const confirmed = (st: State) => {
    const view = observe()
    return safeStep(view, st) && Math.abs(st.pos.y - at.y) <= TOLERANCE && settledLanding(view, st, target, TOLERANCE)
  }
  const plan = await planJumpAsync(terrain, ctl, target, { allowWalk: true, sprint: false, tolerance: TOLERANCE,
    maxFallDamage: 0, maxTicks: 24, maxFrames: 1200, arena })
  if (!active() || !bot.entity.position.equals(start)) return result(false, 'launch_changed')
  if (!plan || plan.steps.some(s => s.control.jump) || plan.states.some(s => !s.onGround || !footing(terrain, s.pos, s.pos))) return result(false, 'no_safe_walk')
  const r = await executePlan(bot, ctl, { ...plan, arena }, confirmed, undefined, observe, { owns, step: safeStep })
  return result(r.ok, r.why, r.ticks)
}
