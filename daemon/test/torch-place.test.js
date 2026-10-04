'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { placeBlockAt } = require('../src/build')

function fixture (item) {
  const target = new Vec3(0, 1, 0)
  let placed = false
  let calls = 0
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) }, entities: {},
    heldItem: { name: item, type: 1 }, inventory: { items: () => [{ name: item, type: 1 }] },
    blockAt: p => ({ position: p,
      name: p.equals(target) ? (placed ? 'wall_torch' : 'water') : 'stone',
      boundingBox: p.equals(target) ? 'empty' : 'block' }),
    lookAt: async () => {},
    placeBlock: async (_ref, face) => {
      calls++
      assert.notEqual(face.y, -1, 'обычный факел не крепится к потолку')
      placed = true
    } }
  return { bot, target, calls: () => calls }
}

test('неколлизионный факел можно поставить в клетке головы на стену, пустая рамка не является отказом', async () => {
  const f = fixture('torch')
  const r = await placeBlockAt(f.bot, f.target, { item: 'torch' })
  assert.equal(r.ok, true)
  assert.equal(r.placed, 'wall_torch')
  assert.equal(f.calls(), 1)
})

test('полный блок по-прежнему не ставится в собственную голову', async () => {
  const f = fixture('cobblestone')
  const r = await placeBlockAt(f.bot, f.target, { item: 'cobblestone' })
  assert.equal(r.ok, false)
  assert.equal(f.calls(), 0)
})
