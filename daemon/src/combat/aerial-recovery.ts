const clock = require('../game-clock')

export function beginAerialRecovery(bot: any, ctl: { aborted: boolean }, durationMs = 750) {
  const until = clock.now() + durationMs
  const active = () => !ctl.aborted && bot.health > 0 && !bot.entity.onGround && clock.now() < until
    && (bot.inventory.slots[6]?.name === 'elytra' || bot.inventory.items().some((item: any) => item.name === 'elytra') || bot.inventory.slots[45]?.name === 'elytra')
  bot._ndAerialRecovering = active
  return () => { if (bot._ndAerialRecovering === active) bot._ndAerialRecovering = null }
}
