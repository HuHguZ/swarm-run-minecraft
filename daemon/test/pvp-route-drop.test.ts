import test from 'node:test'
import assert from 'node:assert/strict'
import { combatMovement } from '../src/pvp/movement'
import { Vec3 } from 'vec3'
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(data as any)
import { Movements, goals } from 'mineflayer-pathfinder'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')

function routeFromLedge (height) {
  const bot: any = { registry: data, game: { minY: -8 }, entity: { position: new Vec3(.5, height, .5), effects: {} },
    inventory: { items: () => [] }, pathfinder: { bestHarvestTool: () => null } }
  bot.blockAt = pos => {
    const p = pos.floored()
    const name = p.y === -1 ? 'smooth_stone' : p.y === height - 1 && p.x >= 0 && p.x < 4 && p.z === 0 ? 'cobblestone' : 'air'
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0); block.position = p; return block
  }
  const mv = bot.pathfinder.movements = new Movements(bot)
  mv.maxDropDown = 9
  const mode = combatMovement(bot, { x: .5, y: 0, z: .5, r: 8 })
  try {
    return new AStar(new Move(0, height, 0, 0, 0), mv,
      new goals.GoalFollow({ position: new Vec3(-.1, 0, 1.5) } as any, 2), 10000, 10000).compute()
  } finally { mode.restore(); assert.equal(mv.maxDropDown, 9) }
}

test('combat route descends three physical blocks from clutch supports without digging them', () => {
  const path = routeFromLedge(3)
  assert.equal(path.status, 'success')
  assert.equal(path.path.length, 1)
  assert.equal(path.path[0].y, 0)
  assert.deepEqual(path.path[0].toBreak, [])
})

test('combat route preserves a direct two-block descent', () => {
  const path = routeFromLedge(2)
  assert.equal(path.status, 'success')
  assert.equal(path.path[0].y, 0)
  assert.deepEqual(path.path[0].toBreak, [])
})

test('combat route still refuses an unpriced four-block descent', () => {
  const path = routeFromLedge(4)
  assert.equal(path.status, 'noPath')
  assert.equal(path.visitedNodes, 4, 'only the four supports are reachable')
  assert.deepEqual(path.path, [])
})
