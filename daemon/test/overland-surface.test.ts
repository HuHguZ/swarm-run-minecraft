const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { situation } = require('../src/director')

test('F3 skylight distinguishes a tall cave from the surface when the ceiling is beyond 24 blocks', () => {
  const bot: any = { entity: { position: new Vec3(530, 1, 468), metadata: {} }, health: 20, food: 20,
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, inventory: { items: () => [], emptySlotCount: () => 30 },
    entities: {}, blockAt: p => ({ position: p, skyLight: 0, name: 'air', boundingBox: 'empty' }) }
  assert.equal(situation({ session: { bot } }).surface, false)
  bot.blockAt = p => ({ position: p, skyLight: 15, name: 'air', boundingBox: 'empty' })
  assert.equal(situation({ session: { bot } }).surface, true)
  bot.game.dimension = 'the_nether'
  bot.blockAt = p => ({ position: p, skyLight: 0, name: 'air', boundingBox: 'empty' })
  assert.equal(situation({ session: { bot } }).surface, true, 'Nether uses its existing local roof observation')
})
