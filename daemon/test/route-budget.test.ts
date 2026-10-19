'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as NG from '../src/nether-grid'
import NR = require('../src/nether-route')
const { C } = NG
const from = { x: 2, y: 4, z: 4 }
function corridor (n = 160) {
  const g = new NG.Grid(NG.headerOf([0, 0, 0, n, 8, 8]))
  g.data.fill(C.HARD)
  for (let x = 1; x < n; x++) for (const y of [4, 5]) g.setRaw(x, y, 4, C.AIR)
  return g
}
test('дальняя цель возвращает исполнимую ногу до 64 блоков, не весь путь', async () => {
  const p = await NR.plan(corridor(), from, { x: 150, y: 4, z: 4 }, { blocks: 0, partial: true })
  assert.ok(p.path.length > 0)
  assert.ok(p.path.length <= 64, `steps=${p.path.length}`)
  assert.equal(p.ok, false)
  assert.equal(p.more, true)
})
test('неизвестная цель отбрасывается до поиска, даже если partial=true', async () => {
  const g = corridor(70); g.setRaw(60, 4, 4, C.UNKNOWN)
  const p = await NR.plan(g, from, { x: 60, y: 4, z: 4 }, { partial: true })
  assert.equal(p.nodes, 0)
  assert.equal(p.path.length, 0)
})
test('непроходимая клетка цели отбрасывается до поиска', async () => {
  const g = corridor(70)
  const p = await NR.plan(g, from, { x: 60, y: 4, z: 6 }, { partial: true })
  assert.equal(p.nodes, 0)
})
test('малый бюджет отдаёт только связный прогресс, без переполнения узлов', async () => {
  const p = await NR.plan(corridor(70), from, { x: 60, y: 4, z: 4 }, { maxNodes: 20, partial: true, blocks: 0 })
  assert.ok(p.nodes <= 20, `nodes=${p.nodes}`)
  assert.ok(p.path.length > 0)
  let at = from
  for (const mv of p.path) { assert.deepEqual(mv.from, at); at = mv.to }
  assert.equal(p.more, true)
})
test('тревога проверяется до первого большого куска', async () => {
  const p = await NR.plan(corridor(70), from, { x: 60, y: 4, z: 4 }, { alarm: () => true })
  assert.equal(p.path.length, 0)
  assert.equal(p.why2, 'тревога')
})
test('параллельные планы не перебивают рабочие массивы друг друга', async () => {
  const a = corridor(70); const b = corridor(70)
  const pp = await Promise.all([NR.plan(a, from, { x: 60, y: 4, z: 4 }, { yieldMs: 0, blocks: 0 }), NR.plan(b, from, { x: 55, y: 4, z: 4 }, { yieldMs: 0, blocks: 0 })])
  assert.ok(pp.every(p => p.ok))
})
