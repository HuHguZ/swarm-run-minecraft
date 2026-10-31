// Рывок удочкой по нашему телу — как у ванильного клиента (29.10, Claude, арена). Сервер (FishingHook.retrieve → pullEntity, jar
// 1.21.11) меняет скорость зацепленного и шлёт крючку entity_status 31; скорость игрока ведёт клиент — ванильный в handleEntityEvent(31)
// сам добавляет себе 0.1 × (владелец − я), а mineflayer событие 31 не знает: бота удочкой не дёрнуть, человека — да. Честная игра:
// тело дёргается так же, как дёрнулся бы игрок.
// hooked_entity в метаданных крючка — id зацепленного + 1 (0 — никого); владелец — objectData пакета появления крючка.
import { now } from './game-clock'
export function pullOf (me: { x: number, y: number, z: number }, owner: { x: number, y: number, z: number }) {
  return { x: (owner.x - me.x) * .1, y: (owner.y - me.y) * .1, z: (owner.z - me.z) * .1 }
}
export function install (bot) {
  if (!bot?._client || bot._ndRodPhysics) return
  const type = bot.registry?.entitiesByName?.fishing_bobber?.id
  const key = bot.registry?.entitiesByName?.fishing_bobber?.metadataKeys?.indexOf('hooked_entity') ?? -1
  if (type === undefined || key < 0) return
  const hooks = new Map<number, { owner: number, hooked: number }>()
  bot._ndRodPhysics = { hooks, pulls: 0 }
  const spawn = p => { if (p?.type === type) hooks.set(p.entityId, { owner: Number(p.objectData) || 0, hooked: 0 }) }
  const meta = p => {
    const h = hooks.get(p?.entityId); if (!h) return
    for (const m of p.metadata || []) if (m.key === key && typeof m.value === 'number') h.hooked = m.value - 1
  }
  const status = p => {
    const h = hooks.get(p?.entityId)
    if (!h || p.entityStatus !== 31 || !bot.entity || h.hooked !== bot.entity.id) return
    const owner = bot.entities?.[h.owner]
    if (!owner?.position) return
    const d = pullOf(bot.entity.position, owner.position)
    bot.entity.velocity.x += d.x; bot.entity.velocity.y += d.y; bot.entity.velocity.z += d.z
    bot._ndRodPhysics.pulls++
    bot.emit('nd_rodPulled', { at: now(), v: d, from: owner.username || owner.name })
  }
  const gone = p => { for (const id of p?.entityIds || []) hooks.delete(id) }
  bot._client.on('spawn_entity', spawn); bot._client.on('entity_metadata', meta)
  bot._client.on('entity_status', status); bot._client.on('entity_destroy', gone)
  bot.once?.('end', () => {
    bot._client.removeListener('spawn_entity', spawn); bot._client.removeListener('entity_metadata', meta)
    bot._client.removeListener('entity_status', status); bot._client.removeListener('entity_destroy', gone)
  })
}
