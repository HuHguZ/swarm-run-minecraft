'use strict'
// План хода по сетке Ада (src/nether-route.js plan, src/nether-grid.js) — поток nether 03.10.
const test = require('node:test')
const assert = require('node:assert/strict')
const NG = require('../src/nether-grid')
const { plan } = require('../src/nether-route')
const { C } = NG

// Коробка 40×20×12: всё незерак, пол y 10; коридор воздуха на y 11–12 по z 5 от x 2 до 30.
function world () {
  const g = new NG.Grid(NG.headerOf([0, 0, 0, 39, 19, 11]))
  g.data.fill(C.SOFT)
  for (let x = 2; x <= 30; x++) for (const y of [11, 12]) g.setRaw(x, y, 5, C.AIR)
  return g
}

test('класс блока по имени: незерак, лава, золото, забор, лозы', () => {
  assert.equal(NG.classOfName('minecraft:netherrack'), C.SOFT)
  assert.equal(NG.classOfName('lava'), C.LAVA)
  assert.equal(NG.classOfName('gold_block'), C.GUARD)
  assert.equal(NG.classOfName('nether_brick_fence'), C.PARTIAL)
  assert.equal(NG.classOfName('weeping_vines_plant'), C.PASS)
  assert.equal(NG.classOfName('polished_blackstone_bricks'), C.STONE)
})

test('по коридору — без копки; к цели в толще — штреком', async () => {
  const g = world()
  const a = await plan(g, { x: 2, y: 11, z: 5 }, { x: 30, y: 11, z: 5 }, {} as Record<string, any>)
  assert.equal(a.ok, true)
  assert.equal(a.digs, 0)
  const b = await plan(g, { x: 2, y: 11, z: 5 }, { x: 20, y: 11, z: 9 }, {} as Record<string, any>)
  assert.equal(b.ok, true)
  assert.ok(b.digs > 0)
  assert.deepEqual(b.end, { x: 20, y: 11, z: 9 })
})

test('клетку у лавы не вскрывает: обход', async () => {
  const g = world()
  // Лава стеной по x 10, z 6..11 на y 11–12 — копать z 6 у неё нельзя, коридор z 5 касается её гранью (идти можно).
  for (let z = 6; z <= 11; z++) for (const y of [11, 12]) g.setRaw(10, y, z, C.LAVA)
  const p = await plan(g, { x: 2, y: 11, z: 5 }, { x: 14, y: 11, z: 8 }, {} as Record<string, any>)
  assert.equal(p.ok, true)
  for (const s of p.path) for (const [x, y, z] of s.dig) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) assert.notEqual(g.get(x + dx, y + dy, z + dz), C.LAVA, `копка ${x},${y},${z} у лавы`)
  }
})

test('пропасть: мост блоками, без блоков — пути нет', async () => {
  const g = new NG.Grid(NG.headerOf([0, 0, 0, 29, 19, 4]))
  g.data.fill(C.AIR)
  // Две площадки y 10 (пол), между ними воздух до дна x 10..14.
  for (let x = 0; x <= 29; x++) for (let z = 0; z <= 4; z++) if (x < 10 || x > 14) g.setRaw(x, 10, z, C.STONE)
  const a = await plan(g, { x: 5, y: 11, z: 2 }, { x: 20, y: 11, z: 2 }, { blocks: 16 })
  assert.equal(a.ok, true)
  assert.equal(a.path.filter(s => s.kind === 'bridge').length, 5)
  const b = await plan(g, { x: 5, y: 11, z: 2 }, { x: 20, y: 11, z: 2 }, { blocks: 0 })
  assert.equal(b.ok, false)
})

test('observed server receipt cost favors a longer dry air corridor over repeated mining round trips', async () => {
  const g = new NG.Grid(NG.headerOf([0, 0, 0, 19, 19, 11]))
  g.data.fill(C.SOFT)
  for (const y of [11, 12]) {
    for (let x = 2; x <= 14; x++) g.setRaw(x, y, 2, C.AIR)
    for (let z = 2; z <= 5; z++) {
      g.setRaw(2, y, z, C.AIR); g.setRaw(14, y, z, C.AIR)
    }
  }
  const from = { x: 2, y: 11, z: 5 }; const goal = { x: 14, y: 11, z: 5 }
  const local = await plan(g, from, goal, { blocks: 0, digWaitSeconds: 0 })
  const confirmed = await plan(g, from, goal, { blocks: 0, digWaitSeconds: 2.8 })
  assert.equal(local.ok, true)
  assert.ok(local.digs > 0)
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.digs, 0)
  assert.ok(confirmed.steps > local.steps)
})
