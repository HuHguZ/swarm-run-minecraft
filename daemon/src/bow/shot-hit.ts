import { damageTypeName } from '../gamedata'

// Two releases can be in flight together. A native spawn belongs to one release only.
const claimed = new WeakSet<object>()

export function observeShotHit(bot, target, rocket: boolean, count: number, onHit: () => void, onSpawn?: (packet, bytes) => void) {
  const client = bot._client, shooter = bot.entity.id, victim = target.id, projectiles = new Set<number>()
  const types = bot.registry?.entitiesByName
  let rawPacket, rawBytes
  function spawn(packet) {
    if (!packet || packet.objectData !== shooter || !Number.isInteger(packet.entityId) || claimed.has(packet)) return
    const matches = rocket ? packet.type === types?.firework_rocket?.id
      : packet.type === types?.arrow?.id || packet.type === types?.spectral_arrow?.id
    if (!matches || !Number.isInteger(packet.type)) return
    claimed.add(packet)
    projectiles.add(packet.entityId)
    if (projectiles.size >= count) stopSpawns()
    onSpawn?.(packet, packet === rawPacket ? rawBytes : undefined)
  }
  function raw(packet, meta, bytes) {
    if (meta?.name === 'spawn_entity' && packet.objectData === shooter) { rawPacket = packet; rawBytes = bytes }
  }
  function stopSpawns() {
    if (onSpawn) client.removeListener('packet', raw)
    client.removeListener('spawn_entity', spawn)
  }
  function damage(packet) {
    if (packet.entityId !== victim || packet.sourceCauseId !== shooter + 1 || !projectiles.has(packet.sourceDirectId - 1) ||
        damageTypeName(packet.sourceTypeId) !== (rocket ? 'fireworks' : 'arrow')) return
    close()
    onHit()
  }
  function close() {
    stopSpawns()
    client.removeListener('damage_event', damage)
    bot.removeListener('end', close)
    bot.removeListener('respawn', close)
  }
  if (onSpawn) client.on('packet', raw)
  client.on('spawn_entity', spawn)
  client.on('damage_event', damage)
  bot.once('end', close)
  bot.once('respawn', close)
  return close
}
