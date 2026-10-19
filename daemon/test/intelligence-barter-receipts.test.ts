import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

test('actual booth packet handlers count delivered barter stacks once, excluding gold, babies and another collector', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/bastion/booth-trade.js'), 'utf8')
  const start = source.indexOf('async function boothTrade(')
  const end = source.indexOf('\nconst MEMO', start)
  assert.ok(start >= 0 && end > start)
  const client = new EventEmitter()
  const bot = new EventEmitter()
  const self = { id: 1, position: new Vec3(.5, 100, .5) }
  const piglin = { id: 2, name: 'piglin', position: new Vec3(.5, 102, 2.5), baby: false }
  const baby = { id: 3, name: 'piglin', position: new Vec3(3.5, 102, 2.5), baby: true }
  const entities: Record<number, unknown> = { 1: self, 2: piglin, 3: baby }
  Object.assign(bot, { _client: client, entity: self, entities,
    inventory: { items: () => [{ name: 'gold_ingot', count: 141 }] },
    registry: { entitiesByName: { item: { id: 99 } } } })
  const item = (id: number, name: string, count: number, collector: unknown, origin = piglin, type = 99) => {
    const dropped = { id, name: 'item', position: origin.position.offset(0, 1.49, 0), getDroppedItem: () => ({ name, count }) }
    entities[id] = dropped
    client.emit('spawn_entity', { entityId: id, type, x: dropped.position.x, y: dropped.position.y, z: dropped.position.z })
    client.emit('entity_metadata', { entityId: id })
    client.emit('entity_metadata', { entityId: id })
    if (collector) { bot.emit('playerCollect', collector, dropped); bot.emit('playerCollect', collector, dropped) }
  }
  const context: Record<string, unknown> = { gameClock: { now: () => 1000 }, Vec3,
    countOf: (_bot, name) => name === 'gold_ingot' ? 141 : 0, BF: { enabled: () => false },
    mobs: () => [piglin, baby], isBaby: (_bot, entity) => entity.baby,
    pitLike: () => true, sleep: async () => {},
    junkOut: async () => {
      item(10, 'quartz', 8, self)
      item(11, 'potion', 1, null)
      item(12, 'gold_ingot', 1, self)
      item(13, 'arrow', 4, { id: 8 })
      item(14, 'ender_pearl', 4, self, baby)
      item(15, 'obsidian', 1, self, piglin, 100)
    } }
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = boothTrade', cjsContext(context))
  const run = context.run as (session: unknown, ctl: unknown, st: unknown, bo: unknown, until: number) => Promise<Record<string, unknown>>
  const result = await run({ bot }, { aborted: true }, {}, { kind: 'pit', O: { x: 0, y: 102, z: 1 }, M: { x: 0, y: 102, z: 0 } }, 10000)
  assert.equal(result.barterReceipts, 3, 'only three adult piglin non-gold item entities were observed')
  assert.equal(result.barterDelivered, 1, 'eight quartz units in one collected stack are one receipt')
  assert.equal(result.spent, 0, 'receipt evidence is independent of disappearing gold')
  assert.equal(client.listenerCount('spawn_entity'), 0)
  assert.equal(client.listenerCount('entity_metadata'), 0)
  assert.equal(bot.listenerCount('playerCollect'), 0)
})
