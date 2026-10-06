'use strict'
// Жемчуг как ход goto (hopgoto.js): время пешком по узлам A*, решение «бросать / идти».
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const hg = require('../src/hopgoto')

const node = (x, y, z, extra: any = {} as Record<string, any>) => Object.assign(new Vec3(x, y, z), { toBreak: [], toPlace: [], cost: 1 }, extra)

test('pathSeconds: шаг 4.317 бл/с, вода вдвое медленнее, подъём, копка и постановка pathfinder\'а', () => {
  const from = new Vec3(0.5, 64, 0.5)
  const flat = []
  for (let x = 1; x <= 10; x++) flat.push(node(x + 0.5, 64, 0.5))
  assert.equal(hg.pathSeconds(flat, from), Math.round(10 / hg.WALK * 10) / 10)
  assert.equal(hg.pathSeconds(flat, from, { liquidAt: () => true }), Math.round(20 / hg.WALK * 10) / 10)
  const climb = [node(0.5, 65, 0.5, { toPlace: [{} as Record<string, any>] }), node(0.5, 66, 0.5, { toPlace: [{} as Record<string, any>] })]
  assert.equal(hg.pathSeconds(climb, from), Math.round((0.25 + 0.8) * 2 * 10) / 10)
  const dig = [node(1.5, 64, 0.5, { toBreak: [{} as Record<string, any>, {} as Record<string, any>], cost: 1 + 2 * (1 + 3 * 0.75) })]
  assert.ok(hg.pathSeconds(dig, from) > 2)
  assert.equal(hg.pathSeconds([], from), 0)
})

test('on/options: по умолчанию экономный планировщик включён, резерв 12 (очи Края), порог 20 % и 4 с', () => {
  const was = process.env.ND_PEARL_GOTO
  delete process.env.ND_PEARL_GOTO
  try {
    assert.equal(hg.on(undefined), true)
    assert.equal(hg.on(true), true)
    assert.equal(hg.on(false), false)
    assert.equal(hg.on({ reserve: 0 }), true)
    process.env.ND_PEARL_GOTO = '1'
    assert.equal(hg.on(undefined), true)
    assert.equal(hg.on(false), false)
    process.env.ND_PEARL_GOTO = '0'
    assert.equal(hg.on(undefined), false)
  } finally { if (was === undefined) delete process.env.ND_PEARL_GOTO; else process.env.ND_PEARL_GOTO = was }
  const o = hg.options(true)
  assert.equal(o.reserve, 12)
  assert.equal(o.minShare, 0.2)
  assert.equal(hg.options({ reserve: 2 }).reserve, 2)
})

test('maybeHop: жемчуга не больше резерва — не бросает и путь не считает', async () => {
  const bot = { inventory: { items: () => [{ name: 'ender_pearl', count: 12 }] }, entity: { position: new Vec3(0, 64, 0), onGround: true }, pathfinder: {} as Record<string, any> }
  const r = await hg.maybeHop({ bot }, null, { x: 40, y: 64, z: 0 }, {} as Record<string, any>, { reserve: 12 })
  assert.equal(r.hopped, false)
  assert.match(r.why, /резерв 12/)
})
