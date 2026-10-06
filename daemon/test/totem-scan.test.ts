'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { wantTotem } = require('../src/totem')

test('totem skips unavailable equipment and empty sections but detects buried anchors after updates', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const Chunk = require('prismarine-chunk')(registry)
  const Block = require('prismarine-block')(registry)
  const columns = new Map()
  let reads = 0
  const column = (x, z) => {
    const key = `${x},${z}`
    if (!columns.has(key)) {
      const col = new Chunk({ minY: -64, worldHeight: 384 })
      const read = col.getBlockStateId.bind(col)
      col.getBlockStateId = p => { reads++; return read(p) }
      columns.set(key, col)
    }
    return columns.get(key)
  }
  const slots = Array(46).fill(null)
  const bot = {
    health: 20,
    game: { minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry,
    inventory: { slots, items: () => slots.filter(Boolean) },
    nearestEntity: () => null,
    world: { getColumn: column, raycast: () => { throw new Error('threats behind walls still count') } },
    blockAt: p => {
      const b = Block.fromStateId(column(p.x >> 4, p.z >> 4).getBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15)), 0)
      b.position = p.clone()
      return b
    },
    findBlock: () => { throw new Error('full Block search must not be used') }
  }
  assert.deepEqual(wantTotem(bot), { yes: false })
  assert.equal(columns.size, 0, 'no world scan without a usable totem')
  slots[45] = { name: 'totem_of_undying' }
  assert.equal(wantTotem(bot).yes, false)
  assert.equal(reads, 0, 'uniform air sections need no cell reads')
  const set = (x, y, z, name) => column(x >> 4, z >> 4).setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[name].defaultState)
  for (const [x, y, z] of [[0, 64, 0], [2, 64, 0], [1, 63, 0], [1, 65, 0], [1, 64, -1], [1, 64, 1]]) set(x, y, z, 'stone')
  set(1, 64, 0, 'respawn_anchor')
  assert.deepEqual(wantTotem(bot), { yes: true, why: 'взрывчатка рядом' })
  set(1, 64, 0, 'stone')
  set(7, 64, 0, 'respawn_anchor')
  assert.equal(wantTotem(bot).yes, false, 'updates are read afresh and anchors outside radius 6 do not count')
  slots[45] = null
  slots[36] = { name: 'totem_of_undying' }
  set(1, 64, 0, 'respawn_anchor')
  assert.equal(wantTotem(bot).yes, true, 'a totem in the inventory can be equipped')
})
