'use strict'
// Paper 1.21.11 LivingEntity.travelInWater: sprint uses horizontal drag 0.9f;
// vertical drag stays 0.8f. prismarine-physics uses waterInertia for both axes
// and never changes it for sprint. Keep the correction local to a water tick.
function install (bot) {
  if (!bot.physics || bot.__ndSwimmingFixed) return false
  const physics = bot.physics
  const raw = physics.simulatePlayer
  physics.simulatePlayer = function (state, world) {
    const water = world.getBlock(state.pos.offset(0, 0.5, 0))
    const sprint = state.control.sprint && state.control.forward && (bot.food ?? 20) > 6 && /^(water|bubble_column)$/.test(water?.name || '') && !bot.vehicle
    if (!sprint) return raw.call(physics, state, world)
    const old = physics.waterInertia
    physics.waterInertia = Math.fround(0.9)
    try {
      const result = raw.call(physics, state, world)
      if (result.isInWater && result.vel.y !== physics.outOfLiquidImpulse) {
        // Preserve the original vertical simulation, including jump out of water.
        result.vel.y = (result.vel.y + physics.waterGravity) * old / physics.waterInertia - physics.waterGravity
      }
      return result
    } finally { physics.waterInertia = old }
  }
  bot.__ndSwimmingFixed = true
  return true
}
module.exports = { install }
