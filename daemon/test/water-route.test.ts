'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { findNearestLand, findSwimRoute } from '../src/movement'

// Known pond, four blocks deep, with a roof over the starting cell only.
// The bank is five blocks above the bottom; no mining is needed to reach it.
function pond (oxygen = 20) {
  return {
    oxygenLevel: oxygen,
    entity: { position: new Vec3(0.5, 0, 0.5) },
    blockAt (at) {
      const p = at.floored()
      let name = 'stone'
      if (p.z === 0 && p.x >= 0 && p.x <= 2 && p.y >= 0 && p.y <= 6) name = p.y <= 4 ? 'water' : 'air'
      if (p.x === 0 && p.z === 0 && p.y === 2) name = 'stone'
      if (p.x === 3 && p.z === 0) name = p.y === 4 ? 'dirt' : p.y >= 5 && p.y <= 6 ? 'air' : 'stone'
      return { name, boundingBox: /water|air/.test(name) ? 'empty' : 'block', position: p }
    }
  }
}

test('берег выше трёх блоков не теряется при поиске выхода со дна', () => {
  assert.deepEqual(findNearestLand(pond(), 6), new Vec3(3, 5, 0))
})

test('потолок над своей клеткой не закрывает путь в соседнюю открытую воду и на берег', () => {
  const route = findSwimRoute(pond())
  assert.equal(route.kind, 'land')
  assert.deepEqual(route.target, new Vec3(3, 5, 0))
  assert.deepEqual(route.path[0], new Vec3(1, 0, 0), 'сначала выплыть из-под своего потолка вбок')
  for (const p of route.path) {
    const bot = pond()
    assert.equal(bot.blockAt(p).boundingBox, 'empty')
    assert.equal(bot.blockAt(p.offset(0, 1, 0)).boundingBox, 'empty')
  }
})

test('при малом запасе воздуха ближайший вдох предшествует более дальнему берегу', () => {
  const route = findSwimRoute(pond(2))
  assert.equal(route.kind, 'air')
  assert.equal(pond().blockAt(route.target.offset(0, 1, 0)).name, 'air')
  assert.ok(route.path.length < findSwimRoute(pond()).path.length)
})

for (const barrier of ['stone', 'lava', null]) {
  test(`выход не строится через ${barrier || 'непрогруженную клетку'}`, () => {
    const bot = pond()
    const read = bot.blockAt.bind(bot)
    bot.blockAt = p => {
      if (p.floored().x === 1) return barrier === null ? null : { name: barrier, boundingBox: barrier === 'lava' ? 'empty' : 'block', position: p.floored() }
      return read(p)
    }
    assert.equal(findSwimRoute(bot), null)
  })
}
