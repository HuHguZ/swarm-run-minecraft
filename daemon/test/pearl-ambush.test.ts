import test from 'node:test'
import assert from 'node:assert/strict'

test('pearl ambush: launch so the mace falls onto the landing point just after he appears', () => {
  const { ambushFlight, ambushPlan } = require('../src/combat/pearl-ambush')
  // Взлёт булавы — вершина 8 бл.: падение до 1.2 над тем же полом — 28 тиков.
  assert.equal(ambushFlight(0), 28)
  assert.ok(ambushFlight(2) < ambushFlight(0), 'он выше — встречаем раньше')
  assert.equal(ambushFlight(9), null, 'выше вершины — не достать')
  // 2 с до появления: полный заряд булавы; 1.5 с — неполный; 1.2 с — без заряда (опоздание до 0.3 с); 1 с — поздно.
  assert.equal(ambushPlan(2000, 0).charge, 9)
  assert.equal(ambushPlan(1500, 0).charge, 5)
  assert.equal(ambushPlan(1200, 0).charge, 0)
  assert.equal(ambushPlan(1000, 0), null)
  assert.deepEqual(ambushPlan(2000, 0, 800), ambushPlan(1200, 0), 'бег съедает время')
})
