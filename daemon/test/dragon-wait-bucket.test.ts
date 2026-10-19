'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import dragon = require('../src/dragon')

test('посадка и два независимых nextInt: два живых, близко', () => {
  assert.equal(typeof dragon.holdingOdds, 'function')
  const o = dragon.holdingOdds(2, new Vec3(15.5, 64.5, 0.5), new Vec3(0.5, 64.5, 0.5))
  assert.equal(o.perch, 0.2); assert.equal(o.distanceBound, 2)
  assert.equal(o.strafeGivenNoPerch, 0.625)
  assert.equal(o.strafe, 0.5)
})
test('вертикальная дистанция участвует, край d²=512 переводит nextInt в 3', () => {
  assert.equal(typeof dragon.holdingOdds, 'function')
  const origin = new Vec3(0, 0, 0)
  assert.equal(dragon.holdingOdds(10, new Vec3(16, 15.999, 0), origin).distanceBound, 2)
  const o = dragon.holdingOdds(10, new Vec3(16, 16, 0), origin)
  assert.equal(o.distanceBound, 3); assert.equal(o.perch, 1 / 13)
  assert.ok(Math.abs(o.strafeGivenNoPerch - 7 / 18) < 1e-12)
})
test('кратчайшее кольцо нового ожидания выдерживает позиционный допуск и снижает STRAFE', () => {
  assert.equal(typeof dragon.dragonWaitBand, 'function')
  const old = process.env.ND_WAIT_BUCKET; process.env.ND_WAIT_BUCKET = '1'
  try {
    const band = dragon.dragonWaitBand({ station: true, crystalActive: false, holdOut: false, ph: 0 })
    const origin = new Vec3(0.5, 64.5, 0.5)
    const o = dragon.holdingOdds(2, origin.offset(band[0] - 0.7, 0, 0), origin)
    assert.equal(o.distanceBound, 3)
    assert.ok(o.strafe < 0.5); assert.equal(o.perch, 0.2)
    assert.ok(band[1] < 27)
  } finally { if (old == null) delete process.env.ND_WAIT_BUCKET; else process.env.ND_WAIT_BUCKET = old }
})
test('посадка, стрельба, ожидание без станции и =0 сохраняют прежние кольца', () => {
  assert.equal(typeof dragon.dragonWaitBand, 'function')
  const old = process.env.ND_WAIT_BUCKET; process.env.ND_WAIT_BUCKET = '1'
  try {
    assert.equal(dragon.dragonWaitBand({ station: true, ph: 2 }), null)
    assert.equal(dragon.dragonWaitBand({ station: true, ph: 3 }), null)
    assert.equal(dragon.dragonWaitBand({ station: true, crystalActive: true, ph: 0 }), null)
    assert.equal(dragon.dragonWaitBand({ station: false, ph: 0 }), null)
    assert.equal(dragon.dragonWaitBand({ station: true, holdOut: true, ph: 0 }), null)
    process.env.ND_WAIT_BUCKET = '0'
    assert.equal(dragon.dragonWaitBand({ station: true, ph: 0 }), null)
  } finally { if (old == null) delete process.env.ND_WAIT_BUCKET; else process.env.ND_WAIT_BUCKET = old }
})
test('движение от станции прерывается на APPROACH, LANDING, сидячей фазе или потере дракона', () => {
  assert.equal(typeof dragon.dragonWaitStop, 'function')
  for (const ph of [0, 1, 8]) assert.equal(dragon.dragonWaitStop(ph), null)
  for (const ph of [2, 3, 4, 5, 6, 7, 9, null]) assert.ok(dragon.dragonWaitStop(ph))
})
