'use strict'
// S8c (07.10, замечание проверки д): up --reup гасит только свои слоты диапазона.
import test = require('node:test')
import assert = require('node:assert/strict')
const { reupPlan } = require('./farm')

test('--reup: свой снимок (тот же поток) — down; чужой или без снимка — отказ; не поднятый — только чистка записи', () => {
  const slots = { 8: { code: 's8c-a' }, 9: { code: 's1d-b' }, 10: {}, 11: { code: 's8c-old' } }
  const up = new Set([8, 9, 10, 11])
  assert.deepEqual(reupPlan([8], slots, 's8c-b', i => up.has(i)), { down: [8], refuse: [] })
  assert.deepEqual(reupPlan([8, 9, 10, 11], slots, 's8c-b', i => up.has(i)), { down: [8, 11], refuse: [9, 10] })
  // Без --code (живое дерево) владельца не узнать — поднятый слот не гасим.
  assert.deepEqual(reupPlan([8], slots, undefined, i => up.has(i)), { down: [], refuse: [8] })
  // Слот не поднят: запись в slots.json — чистка, записи нет — ничего.
  assert.deepEqual(reupPlan([9, 12], slots, 's8c-b', () => false), { down: [9], refuse: [] })
})
