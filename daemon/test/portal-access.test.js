'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { doorwayPlan } = require('../src/nether')
const pos = new Vec3(-19, 65, -24)
function world (entries = {}) {
  return p => {
    const name = entries[p.toString()] ?? (p.y === 64 ? 'stone' : 'air')
    if (name === '?') return null
    return { name, position: p, diggable: name !== 'bedrock',
      boundingBox: /^(air|water|lava|nether_portal|fire)$/.test(name) ? 'empty' : 'block' }
  }
}
test('порог без пола получает одну опору, рама не копается', () => {
  const read = world({ [pos.offset(0, -1, 0).toString()]: 'air',
    [pos.offset(0, -1, -1).toString()]: 'obsidian', [pos.offset(0, 0, -1).toString()]: 'nether_portal' })
  const plan = doorwayPlan(read, pos)
  assert.deepEqual(plan.floor, pos.offset(0, -1, 0))
  assert.deepEqual(plan.dig, [])
})
test('обычная земля в проходе требует только расчистки ног и головы', () => {
  const plan = doorwayPlan(world({ [pos.toString()]: 'dirt', [pos.offset(0, 1, 0).toString()]: 'stone' }), pos)
  assert.equal(plan.floor, null)
  assert.equal(plan.dig.length, 2)
})
for (const name of ['chest', 'white_bed', 'obsidian', 'bedrock', '?', 'lava', 'water', 'fire']) {
  test(`порог не повреждает и не вскрывает ${name}`, () => {
    assert.equal(doorwayPlan(world({ [pos.toString()]: name }), pos), null)
  })
}
test('землю у лавы не ломаем и пол поверх жидкости не ставим', () => {
  assert.equal(doorwayPlan(world({ [pos.toString()]: 'dirt', [pos.offset(1, 0, 0).toString()]: 'lava' }), pos), null)
  assert.equal(doorwayPlan(world({ [pos.offset(0, -1, 0).toString()]: 'water' }), pos), null)
})
