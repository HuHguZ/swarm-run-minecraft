// Паркур: один вход для режимов (прыжок, лестница, край, паутина, вода, трезубец, маршрут, варианты, спуск).
import { type Point } from '../geometry'
import { flat } from './model'
import type { MovementBot, Cancellation, JumpOptions, WaterLaunch } from './model'
import { executeJump } from './execute'
import { catchWeb, enterWater } from './water'
import { dropOff, climb, holdEdge } from './moves'
import { localOptions, route } from './route'

export async function navigate(bot: MovementBot, ctl: Cancellation, options: JumpOptions & { target: Point; mode?: 'jump' | 'climb' | 'edge' | 'webcatch' | 'waterentry' | 'riptide' | 'route' | 'options' | 'drop'; ticks?: number; wait?: number; maxLandings?: number; timeoutSeconds?: number; launch?: WaterLaunch; waypoints?: readonly Point[]; automatic?: boolean; pitch?: number }) {
  if (options.mode === 'options') return { ok: true, options: localOptions(bot, { toward: options.target }) }
  if (options.mode === 'route') return route(bot, ctl, { toward: options.target, maxLandings: options.maxLandings, maxTicks: options.maxTicks, beam: options.beam, waypoints: options.waypoints, timeoutSeconds: options.timeoutSeconds, maxFallDamage: options.maxFallDamage })
  if (options.mode === 'webcatch') return catchWeb(bot, ctl, options.target, options.wait)
  if (options.mode === 'waterentry') return enterWater(bot, ctl, options.target, options.ticks, options.launch, options.automatic)
  if (options.mode === 'riptide') {
    const me = bot.entity.position; const target = options.target
    return (require('../../utility') as typeof import('../../utility')).riptide(bot, Math.atan2(me.x - target.x, me.z - target.z), options.pitch ?? Math.atan2(target.y - me.y, flat(me, target)), { target, ctl, launch: options.launch })
  }
  if (options.mode === 'drop') return dropOff(bot, ctl, options.target, options.ticks)
  if (options.mode === 'climb') return climb(bot, ctl, options.target, options.ticks)
  if (options.mode === 'edge') return holdEdge(bot, ctl, options.target, options.ticks)
  return executeJump(bot, ctl, options.target, options)
}
