import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { install } from '../src/rod-pull'
import { installRodPull, hookedBy, myHook } from '../src/utility/rod'

// Ванильный клиент на entity_status 31 крючка сам добавляет себе 0.1 × (владелец − я) (FishingHook.handleEntityEvent → pullEntity);
// mineflayer этого не делал — бота удочкой было не дёрнуть.
test('зацепили удочкой — тело получает рывок к владельцу, как ванильный клиент; чужой крючок не трогает', () => {
  const registry = require('minecraft-data')('1.21.11')
  const client = new EventEmitter()
  const bot: any = Object.assign(new EventEmitter(), { registry, _client: client,
    entity: { id: 5, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) }, entities: { 9: { position: new Vec3(10, 64, 0) } } })
  install(bot)
  const key = registry.entitiesByName.fishing_bobber.metadataKeys.indexOf('hooked_entity')
  client.emit('spawn_entity', { entityId: 77, type: registry.entitiesByName.fishing_bobber.id, objectData: 9 })
  client.emit('entity_status', { entityId: 77, entityStatus: 31 })
  assert.deepEqual(bot.entity.velocity.toArray(), [0, 0, 0], 'не зацеплен — не дёргает')
  client.emit('entity_metadata', { entityId: 77, metadata: [{ key, value: 6 }] })
  client.emit('entity_status', { entityId: 77, entityStatus: 31 })
  assert.deepEqual(bot.entity.velocity.toArray(), [1, 0, 0], '0.1 × 10 бл. к владельцу')
})

for (const nativeFirst of [true, false]) test(`native rod physics and combat bookkeeping coexist (native first: ${nativeFirst})`, () => {
  const registry = require('minecraft-data')('1.21.11')
  const client = new EventEmitter()
  const bot: any = Object.assign(new EventEmitter(), { registry, _client: client,
    entity: { id: 5, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) },
    entities: { 9: { id: 9, position: new Vec3(10, 64, 0) }, 77: { id: 77, name: 'fishing_bobber', metadata: { 8: 6 } } } })
  try {
    let events = 0
    bot.on('nd_rodPulled', () => { events++ })
    if (nativeFirst) install(bot)
    installRodPull(bot)
    install(bot)
    installRodPull(bot)
    const type = registry.entitiesByName.fishing_bobber.id
    const key = registry.entitiesByName.fishing_bobber.metadataKeys.indexOf('hooked_entity')
    client.emit('spawn_entity', { entityId: 77, type, objectData: 9 })
    client.emit('entity_metadata', { entityId: 77, metadata: [{ key, value: 6 }] })
    assert.equal(hookedBy(bot, bot.entities[9])?.id, 77, 'combat sees the hostile hook')
    client.emit('entity_status', { entityId: 77, entityStatus: 31 })
    assert.deepEqual(bot.entity.velocity.toArray(), [1, 0, 0], 'one native impulse, without duplicate or old vertical offset')
    assert.equal(events, 1)
    assert.equal(bot._ndRodPull.pulled, 1, 'combat telemetry retains the native pull event')
    client.emit('spawn_entity', { entityId: 78, type, objectData: 5 })
    bot.entities[78] = { id: 78, metadata: { 8: 10 } }
    assert.equal(myHook(bot)?.hooked, 9, 'own rod bookkeeping still works')
    assert.equal(client.listenerCount('entity_status'), 1)
  } finally { bot.emit('end') }
})
