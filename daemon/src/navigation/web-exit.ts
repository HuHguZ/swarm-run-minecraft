import { Vec3 } from 'vec3'
import { bodyClear, supportAt } from './geometry'
import { planJumpAsync } from './parkour/search'
import { ROUTE_FRAMES, PlayerState, controls, visibleLanding, type MovementBot, type Cancellation } from './parkour/model'

// Walking to nearby visible floor can free the body sooner than cutting its web.
export async function webExitPlan(bot: MovementBot, ctl: Cancellation, alternativeMs: number) {
  if (!bot.physics || !bot.entity.onGround) return null
  const nativeKey = () => JSON.stringify([new PlayerState(bot, controls()), bot.health, bot.food])
  const before = nativeKey(), from = bot.entity.position.clone(), targets: Vec3[] = []
  for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
    const target = new Vec3(Math.floor(from.x) + .5 + dx, from.y, Math.floor(from.z) + .5 + dz)
    if (bodyClear(bot, target) && visibleLanding(bot, target)) targets.push(target)
  }
  targets.sort((a, b) => a.distanceTo(from) - b.distanceTo(from))
  const planningBot = Object.assign(Object.create(bot), { entity: { ...bot.entity, position: from, velocity: bot.entity.velocity.clone(), attributes: structuredClone(bot.entity.attributes) } })
  const diagnostics = { frames: 0, profiles: 0 }
  for (const target of targets) {
    if (ctl.aborted || before !== nativeKey() || diagnostics.frames >= ROUTE_FRAMES) return null
    const plan = await planJumpAsync(planningBot, ctl, target, { web: true, allowWalk: true, sprint: false, tolerance: .12,
      maxTicks: Math.min(40, Math.floor(alternativeMs / 50)), maxFrames: ROUTE_FRAMES, diagnostics })
    if (ctl.aborted || before !== nativeKey()) return null
    if (plan && bodyClear(bot, target) && plan.ticks * 50 < alternativeMs && plan.steps.every(step => !step.control.jump) && plan.states.every(state =>
      state.onGround && Math.abs(state.pos.y - from.y) < .03 && bodyClear(bot, state.pos, { web: true }) && !!supportAt(bot, state.pos, .04) && visibleLanding(bot, state.pos))) return plan
  }
  return null
}
