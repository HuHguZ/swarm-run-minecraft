'use strict'
// Сторож блочного клатча (clutch install): подписки на пакеты блоков, слоты и путь, сброс на телепорте/возрождении и
// останов. Состояние — clutch/guard-state.ts, тик — clutch/guard-step.ts.
import { type ClutchGuard, openGuard, releaseSteering, releaseReservation, removePrediction, receipt, expire, cancelScheduled } from './guard-state'
import { step } from './guard-step'

function install (session, opts) {
  const bot = session.bot
  if (bot._ndClutch) return bot._ndClutch
  const g: ClutchGuard = openGuard(session, opts)
  const { st, pending, spent, Vec3 } = g
  const single = p => receipt(g, new Vec3(p.location.x, p.location.y, p.location.z), p.type)
  const multi = p => {
    // Protocol 1.21.11: one 16^3 section, number records (same decode as blocks.js).
    if (!p.chunkCoordinates) return
    for (const r of p.records) receipt(g, new Vec3(p.chunkCoordinates.x * 16 + ((r >> 8) & 15), p.chunkCoordinates.y * 16 + (r & 15), p.chunkCoordinates.z * 16 + ((r >> 4) & 15)), r >> 12)
  }
  st.expire = () => expire(g)
  st.step = () => step(g)
  const path = r => { st.path = r?.path || [] }
  const slotUpdate = (slot, old, item) => {
    if (!spent.has(slot)) return
    let consumed = !item || !old || old.name !== item.name ? Infinity : Math.max(0, old.count - item.count)
    // Reconcile each shot once. A later denial must not release a reservation
    // belonging to another placement when the inventory update arrived first.
    for (const r of g.reservations) if (r.slot === slot && r.reserved && consumed > 0) { releaseReservation(g, r); consumed-- }
    g.reservations = g.reservations.filter(r => r.reserved)
  }
  const reset = () => { cancelScheduled(g); releaseSteering(g); for (const k of [...pending.keys()]) removePrediction(g, k, true); spent.clear(); g.reservations = []; st.peak = null; st.flight = null; st.blocks = 0; st.path = []; st.waterPlan = null; st.waterAttempted = false; st.forecast = null }
  st.stop = () => {
    st.stopped = true; reset()
    bot.removeListener('physicsTick', st.step); bot.removeListener('path_update', path); bot.removeListener('path_reset', path)
    bot.removeListener('end', st.stop); bot.removeListener('spawn', reset); bot.removeListener('forcedMove', reset)
    bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi)
    bot.inventory.removeListener('updateSlot', slotUpdate)
    if (bot._ndClutch === st) delete bot._ndClutch
  }
  bot._client.on('block_change', single); bot._client.on('multi_block_change', multi)
  bot.inventory.on('updateSlot', slotUpdate)
  bot.on('path_update', path); bot.on('path_reset', path); bot.on('end', st.stop); bot.on('spawn', reset); bot.on('forcedMove', reset)
  if (opts.listen !== false) bot.on('physicsTick', st.step)
  bot._ndClutch = st
  return st
}

export { install }
