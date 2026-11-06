export const WIND_BID_REPLY_TICKS = 2
export const WIND_BID_RELEASE_MS = (WIND_BID_REPLY_TICKS + 2) * 50
export interface WindBid {
  target: string
  entity: number
  tick: number
  ticks: number
  prefix?: number
}
export type WindBidFinish = (shot?: Pick<WindBid, 'tick' | 'ticks'>) => void
export type WindRadio = (bid: WindBid, signal?: AbortSignal) => Promise<WindBidFinish | undefined>

const orders = new WeakMap<object, {
  id: string
  target: string
  bot: any
  entity: any
  clock: any
  tick: number
  until: number
  close: () => void
}>()

export function windOrder(session: any, tick: number | null) {
  const order = orders.get(session)
  if (!order) return undefined
  const bot = session.bot
  if (bot !== order.bot || bot.entity !== order.entity || bot.ndClock !== order.clock ||
    bot.ndClock?.frozen || bot.ndClock?.disposed || !(bot.health > 0) ||
    tick === null || tick < order.tick || tick > order.until) {
    order.close()
    return undefined
  }
  return order
}

const lifeEvents = ['death', 'respawn', 'end', 'kicked']

export function reserveWindOrder(session: any, id: string, target: string, tick: number, until: number) {
  const old = windOrder(session, tick)
  if (old && (old.id !== id || old.target !== target)) return false
  if (old) {
    old.until = until
    return true
  }
  const bot = session.bot
  const order = { id, target, bot, entity: bot.entity, clock: bot.ndClock, tick, until, close }
  function close() {
    if (orders.get(session) === order) orders.delete(session)
    for (const event of lifeEvents) bot.removeListener(event, close)
  }
  orders.set(session, order)
  for (const event of lifeEvents) bot.on(event, close)
  return true
}

export function cancelWindOrder(session: any, id: string, target: string) {
  const order = orders.get(session)
  if (order?.id === id && order.target === target) order.close()
}
