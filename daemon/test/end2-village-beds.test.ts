// Поток end2 (sr27): кровати на дракона из деревни (ND_END2_VILLAGE_BEDS) — кровать в цене захода 75 с, а не 15 с ночлега.
import test from 'node:test'
import assert from 'node:assert/strict'

const needs = { iron: 0, lighter: false, food: 0, portal: true, diamondPick: false, beds: 5, gold: 0 }
const load = (flag: string | undefined) => {
  const k = require.resolve('../src/campaign/structure-value')
  delete require.cache[k]
  const old = process.env.ND_END2_VILLAGE_BEDS
  if (flag === undefined) delete process.env.ND_END2_VILLAGE_BEDS; else process.env.ND_END2_VILLAGE_BEDS = flag
  try { return require('../src/campaign/structure-value') as typeof import('../src/campaign/structure-value') } finally {
    if (old === undefined) delete process.env.ND_END2_VILLAGE_BEDS; else process.env.ND_END2_VILLAGE_BEDS = old
    delete require.cache[k]
  }
}

test('end2 village beds: деревня в 128 бл. с 4 кроватями по шаблону — заход окупается только с ценой кровати на дракона', () => {
  const outside = { food: 0, bed: 4 }
  const off = load(undefined).structureWorth('village', 128, needs, [], false, outside)
  const on = load('1').structureWorth('village', 128, needs, [], false, outside)
  assert.ok(off && on)
  assert.ok(off.net <= 0, `без флага мимо (net ${off.net})`)
  assert.ok(on.net > 0, `с флагом иду (net ${on.net})`)
  assert.equal(load('1').itemSeconds('bed', 7, needs), 5 * 75, 'сверх недостачи кровати не ценятся')
})
