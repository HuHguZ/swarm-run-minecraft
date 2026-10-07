import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const U = require('../src/utility')

// s7b 06.10 (просьба пользователя: удочкой подтягивать в комбо, и контрмеры).
function botAt (items: any[]) {
  return { entity: { id: 7, position: new Vec3(0.5, 100, 0.5) }, inventory: { items: () => items, slots: [] }, entities: {} as any, blockAt: () => ({ name: 'stone', boundingBox: 'block' }), _ndRodPull: { owners: new Map(), mine: null } }
}
const him = (z: number) => ({ id: 9, type: 'player', username: 'B', position: new Vec3(0.5, 100, z), height: 1.8, metadata: {} })

test('удочка: убегающий и «под удар» — подтяг; со щитом и вплотную — нет', () => {
  const b: any = botAt([{ name: 'fishing_rod' }])
  assert.equal(U.rodPlan(b, him(-8.5), { d: 9, dy: 0, sees: true, vel: { x: 0, y: 0, z: -0.2 } })?.why, 'удочкой подтянул убегающего')
  assert.equal(U.rodPlan(b, him(-5.5), { d: 6, dy: 0, sees: true, vel: { x: 0, y: 0, z: 0 } })?.why, 'удочкой подтянул под удар')
  assert.equal(U.rodPlan(b, him(-5.5), { d: 6, dy: 0, sees: true, blocking: true }), null, 'щит поднят — не тянуть под удар')
  assert.equal(U.rodPlan(b, him(-2.5), { d: 3, dy: 0, sees: true }), null, 'ближе 3.5')
  assert.equal(U.rodPlan(botAt([]), him(-5.5), { d: 6, dy: 0, sees: true }), null, 'удочки нет')
})

test('удочка: его поплавок на мне узнаётся по метаданным зацепа (мой id + 1) и хозяину', () => {
  const b: any = botAt([])
  const e = him(-6.5)
  b._ndRodPull.owners.set(100, 9)
  b.entities[100] = { id: 100, name: 'fishing_bobber', metadata: { 8: 8 } }
  assert.equal(U.hookedBy(b, e)?.id, 100)
  b.entities[100].metadata[8] = 0
  assert.equal(U.hookedBy(b, e), null, 'не зацеплен')
  b.entities[100].metadata[8] = 8
  b._ndRodPull.owners.set(100, 11)
  assert.equal(U.hookedBy(b, e), null, 'чужой поплавок')
})
