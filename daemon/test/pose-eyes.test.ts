import { test } from 'node:test'
import { strict as assert } from 'node:assert'
const Vec3 = require('vec3')
const pick = require('../src/pick')

test('Minecraft player eye and body geometry follows pose and shared flags', () => {
  const bot: any = { entity: { position: new Vec3(0, 10, 0), metadata: [], height: 1.8 }, getControlState: () => false }
  assert.equal(pick.eyeHeight(bot), 1.62)
  for (const pose of [1, 3, 4]) { bot.entity.metadata[6] = pose; assert.equal(pick.eyeHeight(bot), 0.4) }
  bot.entity.metadata[6] = 5; assert.equal(pick.eyeHeight(bot), 1.27)
  bot.entity.metadata[6] = 0; bot.entity.metadata[0] = 0x80; assert.equal(pick.eyeHeight(bot), 0.4)
  bot.entity.metadata[0] = 0; bot.entity.metadata[13] = 0x80; assert.equal(pick.eyeHeight(bot), 1.62)
})
test('gliding melee aim uses real low eyes and still refuses a wall', () => {
  let wall = false
  const bot: any = { entity: { position: new Vec3(0, 10, 0), metadata: { 6: 1 }, elytraFlying: true },
    registry: { entitiesByName: { player: { metadataKeys: ['shared_flags', '', '', '', '', '', 'pose'] } } },
    blockAt: p => ({ name: wall && Math.floor(p.x) === 1 ? 'stone' : 'air', boundingBox: wall && Math.floor(p.x) === 1 ? 'block' : 'empty', shapes: [[0, 0, 0, 1, 1, 1]] }) }
  const target = { id: 2, type: 'player', name: 'player', position: new Vec3(2.5, 10, 0), width: 0.6, height: 1.8, metadata: { 6: 1 } }
  assert.equal(pick.hitboxOf(bot, target).h, 0.6)
  assert.equal(pick.eyeOf(bot).y, 10.4)
  assert.equal(pick.canHit(bot, target), true)
  wall = true
  assert.equal(pick.canHit(bot, target), false)
})
