'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { IMPULSE, lungeGain, lungeWorth } from '../src/pvp/lunge'

test('выпад: импульс 0.458 × уровень (lunge.json), рывок на земле ≈ уровень блоков', () => {
  assert.equal(IMPULSE, 0.458)
  const g1 = lungeGain(1); const g3 = lungeGain(3)
  assert.ok(g1 > 0.9 && g1 < 1.1, String(g1))
  assert.ok(Math.abs(g3 - 3 * g1) < 1e-9, 'линейно по уровню')
})

test('выпад: колю, когда погоня близко и сытости хватит с запасом; в воде, на элитрах, верхом — нет', () => {
  assert.equal(lungeWorth({ level: 1, food: 20, chaseD: 4 }), true)
  assert.equal(lungeWorth({ level: 1, food: 20, chaseD: 12 }), false, 'погони нет — бесплатный спринт-прыжок')
  assert.equal(lungeWorth({ level: 3, food: 9, chaseD: 4 }), false, 'после укола сытость ≤ 6 — ни спринта, ни выпада')
  assert.equal(lungeWorth({ level: 1, food: 8, chaseD: 4 }), true)
  for (const k of ['inWater', 'flying', 'riding']) assert.equal(lungeWorth({ level: 1, food: 20, chaseD: 4, [k]: true }), false, k)
  assert.equal(lungeWorth({ level: 0, food: 20, chaseD: 4 }), false)
})
