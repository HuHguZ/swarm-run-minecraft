'use strict'
// Лук (bow.ts): подтверждение натяжения по нативным пакетам (USING_ITEM своей сущности и возраст мира).

// Self USING_ITEM metadata acknowledges the requested hand's native use. A time packet
// preceding that receipt cannot date its start: the first subsequent native
// age is a conservative start bound, with no client prediction credit.
function observeCharge (bot, { item = 'bow', hand = 'hand' }: { item?: string; hand?: 'hand' | 'off-hand' } = {}) {
  const client = bot._client; const clock = bot.ndClock
  const off = hand === 'off-hand'
  const key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  let failure = !client?.on || key < 0 || typeof clock?.age !== 'bigint' || !Number.isSafeInteger(clock?.serverTicks)
    ? item + '_native_authority_unavailable' : null
  let armed = false; let using = false; let acknowledged = false; let closed = false
  let slot = bot.quickBarSlot; let start = null; let previousAge = null; let previousTicks = null
  let stopped
  const cancelled = new Promise(resolve => { stopped = resolve })
  const fail = why => { if (!failure) { failure = why; stopped(why) } }
  const check = () => {
    if (armed && (off ? bot.inventory?.slots?.[45]?.name !== item : bot.quickBarSlot !== slot || bot.heldItem?.name !== item)) fail(item + '_slot_changed')
    return failure
  }
  const metadata = packet => {
    if (!armed || packet?.entityId !== bot.entity?.id || check()) return
    for (const entry of packet.metadata ?? []) if (entry.key === key && typeof entry.value === 'number') {
      using = (entry.value & 3) === (off ? 3 : 1)
      if (using) acknowledged = true
      else if (acknowledged) fail(item + '_native_use_ended')
    }
  }
  const age = () => {
    if (!armed || !acknowledged || !using || check()) return
    const ticks = clock.serverTicks; const actualAge = clock.age
    if (typeof actualAge !== 'bigint' || !Number.isSafeInteger(ticks)) { fail(item + '_native_authority_unavailable'); return }
    if (previousAge !== null && (actualAge < previousAge || ticks < previousTicks || actualAge - previousAge !== BigInt(ticks - previousTicks))) { fail(item + '_world_changed'); return }
    if (start === null) start = ticks
    previousAge = actualAge; previousTicks = ticks
  }
  const ended = () => fail(item + '_disconnected')
  const died = () => fail(item + '_died')
  const respawned = () => fail(item + '_world_changed')
  const changed = () => { check() }
  const cooldown = packet => { if (off && String(packet?.cooldownGroup || '').split(':').pop() === item && packet.cooldownTicks > 0) fail(item + '_cooldown') }
  client?.on?.('entity_metadata', metadata); client?.on?.('update_time', age)
  client?.on?.('set_cooldown', cooldown)
  bot.on('end', ended); bot.on('death', died); bot.on('respawn', respawned); bot.on('heldItemChanged', changed)
  if (off) bot.inventory?.on?.('updateSlot', changed)
  const close = () => {
    closed = true; armed = false
    client?.removeListener?.('entity_metadata', metadata); client?.removeListener?.('update_time', age)
    client?.removeListener?.('set_cooldown', cooldown)
    bot.removeListener('end', ended); bot.removeListener('death', died); bot.removeListener('respawn', respawned); bot.removeListener('heldItemChanged', changed)
    if (off) bot.inventory?.removeListener?.('updateSlot', changed)
    stopped(null)
  }
  const ticks = () => start === null || previousTicks === null ? null : previousTicks - start
  return {
    start () { if (closed || check()) return false; armed = true; slot = bot.quickBarSlot; if (check()) return false; bot.activateItem(off); return true },
    why: check, cancelled,
    ready (required = 20) { return !closed && !check() && acknowledged && using && (required === 0 || (ticks() !== null && ticks() >= required)) },
    snapshot () { return { useConfirmed: acknowledged, confirmedTicks: ticks() } },
    close,
    cancel () { const started = armed; close(); if (started) { try { if (off) bot.deactivateItem(); else bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch {} } }
  }
}

export { observeCharge }
