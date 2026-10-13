import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const { Session } = require('../src/session')
const edges = require('../src/edges'), blockmoves = require('../src/blockmoves')

test('strict approach still forbids digging and scaffolding after an inventory-triggered movements rebuild', t => {
  t.mock.method(edges, 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(blockmoves, 'on', () => false)
  const registry = require('minecraft-data')('1.21.11')
  const bot: any = { registry, entity: { position: new Vec3(.5, 64, .5), effects: {}, metadata: [], velocity: new Vec3(0, 0, 0), onGround: true }, health: 20, food: 20,
    inventory: { slots: Array(46).fill(null), items: () => [{ name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id, count: 1 }, { name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 64 }] },
    blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }), game: { dimension: 'overworld' },
    pathfinder: { movements: null, setMovements(m) { this.movements = m } } }
  const session = Object.assign(Object.create(Session.prototype), { bot, surfaceStrict: true, surfaceWalk: true })
  session.updateMovements(true)
  assert.equal(bot.pathfinder.movements.canDig, false)
  assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, [])
  session.surfaceStrict = false
  session.updateMovements(true)
  assert.equal(bot.pathfinder.movements.canDig, true)
})
