'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { placeBlockAt } from '../src/build'

function fixture (item, target = new Vec3(0, 1, 0)) {
  let placed = false
  let calls = 0
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) }, entities: {} as Record<string, any>,
    heldItem: { name: item, type: 1 }, inventory: { items: () => [{ name: item, type: 1 }] },
    blockAt: p => ({ position: p,
      name: p.equals(target) ? (placed ? (item === 'torch' ? 'wall_torch' : item) : 'water') : 'stone',
      boundingBox: p.equals(target) ? 'empty' : 'block' }),
    lookAt: async () => {},
    placeBlock: async (_ref, face) => {
      calls++
      if (item === 'torch') assert.notEqual(face.y, -1, 'обычный факел не крепится к потолку')
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

test('паутина с пустой collision рамкой подтверждается фактическим блоком и не тратится повторно', async () => {
  const f = fixture('cobweb', new Vec3(1, 0, 0))
  const result = await placeBlockAt(f.bot, f.target, { item: 'cobweb' })
  assert.equal(result.ok, true)
  assert.equal(result.placed, 'cobweb')
  const again = await placeBlockAt(f.bot, f.target, { item: 'cobweb' })
  assert.equal(again.already, 'cobweb')
  assert.equal(f.calls(), 1)
})
