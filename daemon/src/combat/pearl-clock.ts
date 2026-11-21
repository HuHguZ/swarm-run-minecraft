import * as gameClock from '../game-clock'
import { worldTick } from './team-wind'

// ETA is in game ticks at the observer. Older senders have no shared world tick.
export function pearlDeadline(session: any, bot: any, ctl: any, report: any) {
  const body = bot?.entity, clock = bot?.ndClock, eta = Number(report.eta), timed = report.gameTick !== undefined
  let lastTick = bot && worldTick(bot)
  if (!body || !report.at || ![report.at.x, report.at.y, report.at.z, eta].every(Number.isFinite) || eta < 0 ||
      timed && (!Number.isSafeInteger(report.gameTick) || !Number.isSafeInteger(report.gameTick + eta) ||
        lastTick == null || report.gameTick > lastTick + 20)) return null
  const arrivalTick = timed ? report.gameTick + eta : null
  const arrival = gameClock.now() + eta * 50
  const left = () => {
    if (ctl.aborted || 'bot' in session && session.bot !== bot || bot.entity !== body || bot.ndClock !== clock || clock?.disposed || clock?.frozen) return -Infinity
    if (arrivalTick === null) return arrival - gameClock.now()
    const tick = worldTick(bot)
    if (tick === null || tick < lastTick) return -Infinity
    lastTick = tick
    return (arrivalTick - tick) * 50
  }
  return { timed, left }
}
