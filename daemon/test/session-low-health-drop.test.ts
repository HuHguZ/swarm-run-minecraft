import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as pathing from '../src/session/pathing'
import Move = require('mineflayer-pathfinder/lib/move')

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
// Each test file has its own worker. Keep the paid-drop and MLG controls explicit.
process.env.ND_FREE_DROP = '1'
process.env.ND_MLG = '1'
process.env.ND_MLG_MAX = '60'
delete process.env.ND_MLG_RESERVE

// Same native blocks/Movements as pvp-route-drop; the session installs its real
// wrappers. A single support puts feet at 123, above an unobstructed lower floor.
function fixture({ hp = 4, fall = 3, bucket = false } = {}) {
  const items = bucket ? [{ name: 'water_bucket', type: registry.itemsByName.water_bucket.id, count: 1, slot: 40 }] : []
  const slots = Array(46).fill(null)
  if (bucket) slots[40] = items[0]
  const bot: any = {
    version: '1.21.11', registry, health: hp, food: 20, entities: {},
    game: { dimension: 'overworld', gameMode: 'survival', minY: -64, height: 384 },
    entity: { id: 1, position: new Vec3(669.5, 123, 608.636), velocity: new Vec3(0, 0, 0), onGround: true, effects: {} },
    inventory: { items: () => items, slots }, _ndFallGuard: { barAt: 0 },
    blockAt(pos) {
      const p = pos.floored(), name = p.y === 122 && p.x === 669 && p.z === 608 ? 'oak_planks'
        : p.y === 122 - fall ? 'stone' : 'air'
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
      block.position = p; return block
    },
    pathfinder: { movements: null, bestHarvestTool: () => null, isMoving: () => false, setMovements(m) { this.movements = m } }
  }
  const s: any = Object.assign({ bot, surfaceWalk: false, surfaceStrict: true, pathGoalY: null,
    bridgeWanted: false, sprintWanted: false, stuckCells: new Map() }, pathing)
  s.updateMovements(true)
  const landing = () => bot.pathfinder.movements.getNeighbors(new Move(669, 123, 608, 0, 0))
    .find(n => n.x === 670 && n.y === 123 - fall && n.z === 608)
  return { s, bot, landing }
}

for (const method of ['update', 'refresh']) {
  const prepared = fall => {
    const f = fixture({ hp: method === 'refresh' ? 20 : 4, fall })
    if (method === 'refresh') { f.bot.health = 4; f.s.refreshDrop() }
    return f
  }
  test(`low-health ${method} permits a physical three-block descent without MLG, digging or placement`, () => {
    const step = prepared(3).landing()
    assert.ok(step, 'a safe landing three blocks below the feet must remain reachable')
    assert.deepEqual(step.toBreak, [])
    assert.deepEqual(step.toPlace, [])
  })
  test(`low-health ${method} still refuses a physical four-block descent without MLG`, () => {
    assert.equal(prepared(4).landing(), undefined)
  })
}

test('refresh preserves a foreign movement restriction', () => {
  for (const fall of [1, 2]) {
    const f = fixture({ hp: 20, fall })
    f.bot.pathfinder.movements.maxDropDown = 2
    f.bot.health = 4; f.s.refreshDrop()
    assert.equal(!!f.landing(), fall === 1)
  }
})

test('healthy paid drops retain a physical four-block descent', () => {
  assert.ok(fixture({ hp: 20, fall: 4 }).landing())
})

test('a ready MLG bucket still admits a deeper descent that the unprotected body refuses', () => {
  assert.ok(fixture({ hp: 8, fall: 10, bucket: true }).landing())
  assert.equal(fixture({ hp: 8, fall: 10 }).landing(), undefined)
})
