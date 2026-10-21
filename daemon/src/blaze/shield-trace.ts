// Diagnostics only. The damage packet owns its source ids; health event order owns no attribution.
import * as clock from '../game-clock'
import { damageTypeName } from '../gamedata'

export function attachShieldTrace(bot, guard, radar, phase = () => '') {
  if (process.env.ND_BLAZE_SHIELD_TRACE !== '1') return { close () {} }
  const client = bot._client, key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  const vec = p => p ? [p.x, p.y, p.z] : null
  let seq = 0, age = null, metadata = null, use = null, release = null, clutch = null
  const gone = new Map<number, any>()
  const stamp = () => ({ seq: ++seq, t: clock.now(), clientTick: bot.ndClock?.ticks ?? null,
    serverTick: bot.ndClock?.serverTicks ?? null, age: bot.ndClock?.age?.toString() ?? null })
  const entity = e => e ? { id: e.id, name: e.name, p: vec(e.position), v: vec(e.velocity) } : null
  const onAge = p => { age = { ...stamp(), packetAge: p?.age?.toString() ?? null } }
  const onMetadata = p => {
    if (p?.entityId !== bot.entity?.id) return
    const value = p.metadata?.find(m => m.key === key)?.value
    if (typeof value === 'number') metadata = { ...stamp(), flags: value }
  }
  const onUse = e => {
    const record = { ...stamp(), ...e, witness: 'guard_intent_not_wire_receipt' }
    if (e?.action === 'raise') use = record
    else release = record
  }
  const onClutch = e => {
    if (e?.what === 'placed') clutch = { ...stamp(), what: e.what, cell: vec(e.cell) }
  }
  const onGone = e => {
    if (e && /^(arrow|spectral_arrow|small_fireball|fireball)$/.test(e.name)) {
      gone.set(e.id, { ...stamp(), ...entity(e), witness: 'entityGone_last_seen' })
      if (gone.size > 32) gone.delete(gone.keys().next().value)
    }
  }
  const onDamage = p => {
    if (p?.entityId !== bot.entity?.id) return
    const type = damageTypeName(p.sourceTypeId)
    if (!/^(arrow|fireball|unattributed_fireball)$/.test(type || '')) return
    // Protocol source ids are entityId+1; zero is absent. Do not guess a missing source from the last health event.
    const causeId = p.sourceCauseId > 0 ? p.sourceCauseId - 1 : null
    const directId = p.sourceDirectId > 0 ? p.sourceDirectId - 1 : null
    const direct = directId === null ? null : entity(bot.entities?.[directId])
    const lastDirect = directId === null ? null : gone.get(directId)
    const flights = radar.trace?.() ?? []
    const flight = directId === null ? null : flights.find(b => b.id === directId) ?? null
    const state = guard.traceState?.() ?? null
    const row = { ...stamp(), k: 'damage', type, typeId: p.sourceTypeId, phase: phase(),
      packet: { sourceCauseId: p.sourceCauseId, sourceDirectId: p.sourceDirectId, sourcePosition: vec(p.sourcePosition) },
      source: { causeId, directId, cause: causeId === null ? null : entity(bot.entities?.[causeId]), direct,
        lastDirect: lastDirect && clock.now() - lastDirect.t <= 1000 ? lastDirect : null },
      self: { p: vec(bot.entity.position), v: vec(bot.entity.velocity), yaw: bot.entity.yaw, pitch: bot.entity.pitch,
        sharedFlags: bot.entity.metadata?.[0] ?? null, livingFlags: bot.entity.metadata?.[key] ?? null,
        held: bot.heldItem?.name ?? null, offhand: bot.inventory?.slots?.[45]?.name ?? null,
        hpAtCallback: bot.health ?? null },
      nativeUse: guard.nativeUse(), blocking: guard.blocking(), failure: guard.failure?.() ?? null, shield: state,
      directFireball: flight, incoming: radar.incoming(clock.now(), true).slice(0, 8),
      latest: { use, release, metadata, age, clutch } }
    console.log('[blaze-shield-trace]', JSON.stringify(row))
  }
  client.on('damage_event', onDamage); client.on('entity_metadata', onMetadata); client.on('update_time', onAge)
  bot.on('nd_blazeShieldUse', onUse); bot.on('nd_clutch', onClutch); bot.on('entityGone', onGone)
  return { close () {
    client.removeListener('damage_event', onDamage); client.removeListener('entity_metadata', onMetadata); client.removeListener('update_time', onAge)
    bot.removeListener('nd_blazeShieldUse', onUse); bot.removeListener('nd_clutch', onClutch); bot.removeListener('entityGone', onGone)
    gone.clear()
  } }
}
