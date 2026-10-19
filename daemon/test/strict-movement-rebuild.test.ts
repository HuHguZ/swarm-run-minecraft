import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
// mlgDrop живёт в src/edges/mlg: фасад edges переэкспортирует его геттером, подмена — на определяющем модуле
import edgesMlg = require('../src/edges/mlg')
import blockmoves = require('../src/blockmoves')

test('strict approach still forbids digging and scaffolding after an inventory-triggered movements rebuild', t => {
  t.mock.method(edgesMlg, 'mlgDrop', () => ({ ok: false, drop: 3 }))
  t.mock.method(blockmoves, 'on', () => false)
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
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
