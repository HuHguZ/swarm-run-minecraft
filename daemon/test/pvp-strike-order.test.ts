'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { strikeSlot, strikeWait, WINDOW_MS, SLOT_MS } from '../src/pvp/strike-order'

test('очередь: место среди присутствующих, отсутствующие не в счёт; карта по целям', () => {
  const present = new Set(['a', 'c'])
  assert.equal(strikeSlot(['a', 'b', 'c'], 'c', 'T', present), 1, 'b нет у цели — c второй')
  assert.equal(strikeSlot(['a', 'b', 'c'], 'a', 'T', present), 0)
  assert.equal(strikeSlot({ T: ['c', 'a'] }, 'a', 'T', present), 1)
  assert.equal(strikeSlot({ X: ['a'] }, 'a', 'T', present), 0, 'очереди для этой цели нет')
  assert.equal(strikeSlot(null, 'a', 'T', present), 0)
  // По кругу от ударившего: a ударил — следующий b (нет у цели) → c первым, a — последним.
  assert.equal(strikeSlot(['a', 'b', 'c'], 'c', 'T', present, 'a'), 0)
  assert.equal(strikeSlot(['a', 'b', 'c'], 'a', 'T', present, 'a'), 1)
  assert.equal(strikeSlot(['a', 'b', 'c'], 'a', 'T', new Set(['b', 'c']), 'b'), 1, 'после b — c, потом a')
  assert.equal(strikeWait(1000, 900, 2), 900 + WINDOW_MS + 2 * SLOT_MS - 1000)
})

// Трое с мечами (перезарядка 12.5 т) по одной цели 20 с: удар внутри окна неуязвимости (10 т) пропадает и сбрасывает
// заряд бившего (LivingEntity.hurtServer, Player.attack). Без очереди все бьют в тик конца окна; с очередью — по местам.
function simulate (staggered: boolean) {
  const TICK = 50
  const atk = [0, 1, 2].map(k => ({ k, last: -1e9 }))
  const names = ['a', 'b', 'c']; const all = new Set(names)
  let hurtAt = -1e9; let hurtBy = -1; let landed = 0; let wasted = 0
  for (let t = 0; t < 20000; t += TICK) {
    // Решают одновременно, по тому, что видели к началу тика (entityHurt приходит всем сразу).
    const swing = atk.filter(a => t - a.last >= 625 && strikeWait(t, hurtAt, staggered ? strikeSlot(names, names[a.k], 'T', all, hurtBy >= 0 ? names[hurtBy] : null) : 0) === 0)
    let opened = false
    for (const a of swing) {
      a.last = t
      if (!opened && t - hurtAt >= WINDOW_MS) { opened = true; landed++ } else wasted++
    }
    if (opened) { hurtAt = t; hurtBy = swing[0].k }
  }
  return { landed, wasted }
}

test('очередь ударов: трое чередуются без пустых взмахов, попаданий не меньше', () => {
  const naive = simulate(false)
  const order = simulate(true)
  assert.ok(order.wasted < naive.wasted, JSON.stringify({ naive, order }))
  assert.ok(order.landed >= naive.landed, JSON.stringify({ naive, order }))
  // Предел — одно попадание на окно (10 т): за 20 с не больше 40; по кругу — почти все.
  assert.ok(order.landed >= 38 && order.wasted <= 5, JSON.stringify({ naive, order }))
})
