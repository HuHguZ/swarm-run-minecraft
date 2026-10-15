'use strict'
// План закрытого штрека вслепую по шаблону бастиона (template-view): скрытая клетка — символ куска гипотезы, вне кусков — незерак,
// видимая рядом — как в мире. Настоящие скрытые блоки план не читает.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

function bot (blockAt: (p: any) => any) {
  const registry = require('prismarine-registry')('1.21.11')
  return { registry, entity: { position: new Vec3(100.5, 64, 100.5), eyeHeight: 1.62, height: 1.8 }, inventory: { items: () => [{ name: 'iron_pickaxe' }] },
    game: { dimension: 'the_nether', minY: 0, height: 256 }, world: { getColumn: () => null }, blockAt }
}

test('шаблон: золото куска wall_base в скрытой клетке — охраняемое, вне кусков — твёрдое, мир за стеной не читается', () => {
  const SL = require('../src/sealed')
  const { templateView } = require('../src/bastion/template-view')
  let reads = 0
  const b = bot(() => { reads++; return null })
  const piece = { piece: 'units/walls/wall_base', r: 0, t: { x: 0, y: 30, z: 0 } }
  const v = templateView(b, [piece])
  // Золото шаблона [5,3,10] → мир (5,33,10): далеко от тела (100,64,100) — по шаблону.
  assert.equal(v.cls(5, 33, 10), SL.GUARD)
  assert.equal(v.name(5, 33, 10), 'gold_block')
  // Вне всех кусков — незерак (твёрдое).
  assert.equal(v.cls(60, 33, 60), SL.SOLID)
  assert.equal(reads, 0, 'скрытые клетки не читаются из мира')
})
