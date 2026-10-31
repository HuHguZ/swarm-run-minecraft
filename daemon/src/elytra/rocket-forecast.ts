import * as clock from '../game-clock'
import { TICK_MS } from './consts'

const records = new WeakMap<object, { producer: any; rockets: Map<number, { until: number; gameUntil: number } | null> }>()
const componentName = value => String(value).replace(/^minecraft:/, '')

function flightOf (bot, entity) {
  const keys = bot.registry?.entitiesByName?.[entity?.name]?.metadataKeys
  const itemIndex = keys?.indexOf('fireworks_item'), targetIndex = keys?.indexOf('attached_to_target')
  if (!(itemIndex >= 0) || !(targetIndex >= 0)) return null
  if (entity.metadata?.[targetIndex] !== bot.entity?.id + 1) return undefined
  const item = entity.metadata?.[itemIndex]
  if (!(item?.itemCount > 0) || !Array.isArray(item.components) || !Array.isArray(item.removeComponents)) return null
  const fireworks = item.components.find(c => componentName(c.type) === 'fireworks')
  const removed = item.removeComponents.some(c => componentName(c) === 'fireworks')
  if (removed) return fireworks ? null : 0 // No Fireworks component: the native constructor's factor is1.
  if (!fireworks) return 1 // No override: Items.FIREWORK_ROCKET has Fireworks(1, []).
  const flight = fireworks.data?.flightDuration
  return Number.isInteger(flight) && flight >= 0 && flight <= 255 ? flight : null
}

// This is a forecast only. Actual client thrust remains owned by usedFirework/entityGone and physics.
export function rocketForecast (bot): { boost: number; boostMin: number; boostMax: number; boostUntil: number | null } {
  let state = records.get(bot)
  if (!state) {
    state = { producer: bot.ndClock || clock, rockets: new Map() }
    records.set(bot, state)
    const current = state
    const sync = () => {
      const producer = bot.ndClock || clock
      if (producer !== current.producer) { current.rockets.clear(); current.producer = producer }
      return producer.observationNow()
    }
    bot.on('usedFirework', id => {
      const at = sync(), flight = flightOf(bot, bot.entities?.[id])
      if (flight === undefined) return
      // Jar: lifetime=10*(1+Flight)+nextInt(6)+nextInt(7); expire after ++life > lifetime.
      // Fix the mean expiry at this observation; conditioning anew each tick would defeat route caching.
      if (Number.isFinite(at) && flight !== null) {
        const mean = (10 * (1 + flight) + 6.5) * TICK_MS
        current.rockets.set(id, { until: at + mean, gameUntil: current.producer.now() + mean })
      } else current.rockets.set(id, null)
    })
    bot.on('entityGone', entity => { if (entity) current.rockets.delete(entity.id) })
    for (const event of ['death', 'respawn', 'end']) bot.on(event, () => current.rockets.clear())
  }
  const producer = bot.ndClock || clock
  if (producer !== state.producer) { state.rockets.clear(); state.producer = producer }
  const at = producer.observationNow(), gameAt = producer.now()
  let until = null, remaining = 0, maximum = 0, unknown = state.rockets.size === 0
  for (const rocket of state.rockets.values()) {
    if (!rocket) { unknown = true; continue }
    if (until === null || rocket.until > until) until = rocket.until
    // Observations catch a starved body; game time also consumes quanta when interpolation rounds down.
    const left = Math.min(rocket.until - at, rocket.gameUntil - gameAt) / TICK_MS
    remaining = Math.max(remaining, Math.ceil(left))
    // The latest native expiry is 5.5 ticks after the fixed mean, for every Flight value.
    maximum = Math.max(maximum, Math.ceil(left + 5.5))
  }
  const active = bot.entity?.elytraFlying && Math.max(0, bot.fireworkRocketDuration || 0)
  // Missing/late observations retain the previous nominal upper model, with immediate expiry still possible.
  if (unknown) return { boost: active || 0, boostMin: 0, boostMax: active || 0, boostUntil: null }
  const boost = active && Number.isFinite(remaining) ? Math.min(active, remaining) : 0
  // Past the native expiry, continuing client thrust means its release packet is still unobserved.
  const boostMax = active && Number.isFinite(maximum) ? maximum > 0 ? Math.min(active, maximum) : active : 0
  // A receipt dates our observation, not the earlier native birth. Even the very next step may lose thrust.
  return { boost, boostMin: 0, boostMax, boostUntil: active ? until : null }
}
