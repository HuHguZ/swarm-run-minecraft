'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { pullDrop } from '../src/edges/knockback'

// Нативная физика 1.21.11: пол на y 63, яма (без пола до y 40) на x 2..4; бот в x 0.5.
function field (pit = true) {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const { Physics } = require('prismarine-physics')
  const read = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y)
    const hole = pit && x >= 2 && x <= 4
    const name = y < 64 && !(hole && y >= 40) ? 'stone' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].minStateId)
    b.position = p.floored()
    return b
  }
  const bot: any = { version: '1.21.11', registry, game: { dimension: 'overworld' }, health: 20, food: 20,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, -0.0784, 0), onGround: true, height: 1.8,
      effects: {}, attributes: {}, yaw: 0, pitch: 0 },
    jumpTicks: 0, jumpQueued: false, inventory: { slots: [] }, blockAt: read,
    physics: Physics(registry, { getBlock: read }) }
  return bot
}

test('удочка: рыболов за ямой тянет в неё; с этой стороны или без ямы — нет', () => {
  assert.ok(pullDrop(field(), new Vec3(12.5, 64, .5)), 'за ямой в 12 бл. — тянет через неё')
  assert.equal(pullDrop(field(false), new Vec3(12.5, 64, .5)), null, 'ямы нет')
  assert.equal(pullDrop(field(), new Vec3(-11.5, 64, .5)), null, 'тянет прочь от ямы')
})
