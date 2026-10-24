import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as spear from '../src/spear'
import * as itemuse from '../src/itemuse'

// Real inventory plugin: entity_status for ANY entity clears its convenience
// boolean. Our own transmitted/confirmed held-use state is tracked separately.
function scene() {
  const registry = require('prismarine-registry')('1.21.11')
  const data = require('minecraft-data')('1.21.11')
  const bot: any = new EventEmitter(), sent: any[] = []
  Object.assign(bot, {
    registry, version: '1.21.11', QUICK_BAR_START: 36, _client: new EventEmitter(),
    supportFeature: name => data.supportFeature(name), physics: { simulatePlayer() {} },
    setControlState() {}, getControlState() { return false }, health: 20, food: 20,
    entity: { id: 1, username: 'Me', position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, pitch: 0, onGround: true, metadata: [] },
    username: 'Me', game: { gameMode: 'survival', minY: -64 }, players: {}, entities: {},
    blockAt: p => ({ name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] }),
    world: { raycast: () => null }, _ndSwarmAllies: ['Ally']
  })
  bot._client.write = (name, packet) => sent.push({ name, packet })
  require('mineflayer/lib/plugins/inventory')(bot, {})
  bot.quickBarSlot = 0
  bot.inventory.slots[36] = { name: 'diamond_spear', type: registry.itemsByName.diamond_spear.id, count: 1 }
  const ally: any = { id: 2, type: 'player', username: 'Ally', position: new Vec3(4, 100, 3), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6 }
  bot.entities[2] = ally
  itemuse.install(bot); spear.install(bot)
  const start = () => {
    bot.activateItem()
    bot.entity.metadata[8] = 1; bot.emit('entityUpdate', bot.entity)
    assert.equal(bot._ndUse.cur?.name, 'diamond_spear')
    assert.equal(bot._ndUse.cur?.confirmed, true)
  }
  const releases = () => sent.filter(p => p.name === 'block_dig' && p.packet.status === 5).length
  return { bot, ally, start, releases, sent }
}

for (const status of [2, 3, 9]) test(`foreign entity_status ${status} cannot disable a held spear's late ally guard`, () => {
  const { bot, ally, start, releases } = scene()
  start(); bot.emit('physicTick'); assert.equal(releases(), 0, 'clear enemy charge remains active')
  bot._client.emit('entity_status', { entityId: 3, entityStatus: status })
  assert.equal(bot.usingHeldItem, false, 'actual upstream behavior')
  assert.equal(bot._ndUse.cur?.confirmed, true, 'foreign status does not end our own native use')
  ally.position.z = 0
  assert.equal(spear.teamSafe(bot), false)
  bot.emit('physicTick')
  assert.equal(releases(), 1, 'late friendly crossing must release before movement')
  assert.equal(bot._ndUse.cur, null)
  bot.emit('physicTick'); assert.equal(releases(), 1, 'no duplicate release after our own end')
})

for (const ended of ['release', 'own-status9', 'own-metadata', 'slot', 'dead', 'offhand', 'other-spear']) test(`held spear guard preserves ${ended} ownership boundary`, () => {
  const { bot, ally, start, releases } = scene()
  start()
  bot._client.emit('entity_status', { entityId: 3, entityStatus: 3 })
  if (ended === 'release') bot.deactivateItem()
  if (ended === 'own-status9') bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 })
  if (ended === 'own-metadata') { bot.entity.metadata[8] = 0; bot.emit('entityUpdate', bot.entity) }
  if (ended === 'slot') {
    bot.inventory.slots[37] = { name: 'bow', type: bot.registry.itemsByName.bow.id, count: 1 }
    bot.quickBarSlot = 1; bot._client.write('held_item_slot', { slotId: 1 }); bot.emit('physicsTick')
  }
  if (ended === 'dead') { bot.health = 0; bot.emit('death') }
  if (ended === 'offhand') bot._ndUse.cur = { hand: 1, name: 'shield', confirmed: true }
  if (ended === 'other-spear') bot.inventory.slots[36] = { name: 'iron_spear', type: bot.registry.itemsByName.iron_spear.id, count: 1 }
  ally.position.z = 0
  const before = releases(); bot.emit('physicTick')
  assert.equal(releases(), before, 'do not revive ended use or release an unrelated active item')
})
