'use strict'
// Рефлекс «крипер рядом» (поток survival, 02.10): autopilot.creeperNeed — когда бросать дело и отбегать.
// Механика 1.21.11 Creeper.SwellGoal: шипит с < 3 бл., гаснет дальше 7; фитиль 30 тиков.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { creeperNeed, CREEPER } = require('../src/autopilot')

function bot (creepers, gameMode = 'survival') {
  const entities: Record<string, any> = {} as Record<string, any>
  creepers.forEach((c, i) => { entities[10 + i] = { id: 10 + i, name: 'creeper', position: new Vec3(c.d, 64, 0), metadata: { 16: c.swelling ? 1 : -1 } } })
  return {
    health: 20,
    game: { gameMode },
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    registry: { entitiesByName: { creeper: { metadataKeys: Array.from({ length: 20 }, (_, i) => i === 16 ? 'swell_dir' : 'k' + i) } } }
  }
}

test('крипер вплотную (< 3.3 бл.) — уходить ещё до шипения', () => {
  const n = creeperNeed(bot([{ d: 2.8 }]))
  assert.ok(n)
  assert.equal(n.swelling, false)
})

test('шипящий крипер в 6 бл. — уходить; тихий в 5 бл. — нет', () => {
  assert.ok(creeperNeed(bot([{ d: 6, swelling: true }])))
  assert.equal(creeperNeed(bot([{ d: 5 }])), null)
  assert.equal(creeperNeed(bot([{ d: CREEPER.swellDist + 0.5, swelling: true }])), null)
})

test('ближний из двух; в творческом — не уходить', () => {
  const n = creeperNeed(bot([{ d: 6, swelling: true }, { d: 2 }]))
  assert.equal(Math.round(n.d), 2)
  assert.equal(creeperNeed(bot([{ d: 2 }], 'creative')), null)
})
test('шипящий в 4 бл. — раньше нешипящего в 3', () => {
  const n = creeperNeed(bot([{ d: 3, swelling: false }, { d: 4, swelling: true }]))
  assert.equal(Math.round(n.d), 4)
})
