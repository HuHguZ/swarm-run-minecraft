'use strict'
// Станция у центрального столба (2026-10-01): кровать изголовьем у бедрок-столба на P − 1, опора и заслон —
// обсидиан, бот в окопе за ободом. Мир — точная чаша фонтана (EndPodiumFeature: origin P − 4).
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const REG = require('minecraft-data')('1.21.11')
const dragon = require('../src/dragon')

const P = 65
function world (extra) {
  const o = P - 4
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const k = `${x},${y},${z}`
    if (extra.has(k)) { const n = extra.get(k); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z), shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } }
    const d2 = x * x + z * z
    let name = 'air'
    if (y <= o - 1 && y >= o - 20) name = 'end_stone'
    if (y === o) name = d2 < 6.25 ? 'air' : d2 < 12.25 ? 'bedrock' : 'end_stone'
    if (y === o - 1 && d2 < 12.25) name = 'bedrock'
    if (y > o && d2 < 12.25) name = 'air'
    if (x === 0 && z === 0 && y >= o && y <= o + 3) name = 'bedrock'
    if (y === o + 2 && Math.abs(x) + Math.abs(z) === 1) name = 'wall_torch'
    const solid = name !== 'air' && name !== 'wall_torch'
    return { name, boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
function fakeBot (extra = new Map()) {
  return { entity: { position: new Vec3(8.5, P - 3, 0.5), yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt: world(extra), entities: {} as Record<string, any>, inventory: { items: () => [] }, game: { dimension: 'the_end' }, registry: REG }
}
// Мир «после стройки»: окоп выкопан, обсидиан стоит.
function built (c, kName = 'obsidian') {
  const extra = new Map()
  for (let k = 1; k <= c.dig; k++) extra.set(`${c.B.x},${c.G - k},${c.B.z}`, 'air')
  if (c.place.obsidian) extra.set(`${c.place.K.x},${c.place.K.y},${c.place.K.z}`, kName)
  for (const o of c.obs) extra.set(o.join(','), kName)
  return extra
}

test('станция у столба: подушка у столба на P − 1, 2 обсидиана, бот ниже пути головы, взрыву закрыт', () => {
  const c = dragon.pillarPlan(fakeBot(), P, { dy: -1 })
  assert.ok(c, JSON.stringify(dragon.pillarPlan.why))
  assert.equal(c.yb, P - 1)
  assert.equal(Math.abs(c.H.x) + Math.abs(c.H.z), 1)
  assert.ok(c.nObs <= 2, `обсидиана ${c.nObs}`)
  assert.ok(c.feet.y + 1.8 <= P - 2.6, `макушка ${c.feet.y + 1.8}`)
  assert.ok(c.expo <= 0.02)
  assert.ok(c.seen > 0.5, `видимость дракона ${c.seen}`)
})

test('станция годится с места в окопе (pillarHere), не годится вне клетки окопа', () => {
  const bot = fakeBot()
  const c = dragon.pillarPlan(bot, P, { dy: -1 })
  const b2 = fakeBot(built(c))
  b2.entity.position = c.feet.clone()
  const h = dragon.pillarHere(b2, c)
  assert.ok(h, 'с места окопа')
  assert.ok(h.expo <= 0.04)
  b2.entity.position = c.feet.offset(2, 0, 0)
  assert.equal(dragon.pillarHere(b2, c), null)
})

test('опора K из плачущего обсидиана — своя: при перепланировке ставить её не надо', () => {
  const c = dragon.pillarPlan(fakeBot(), P, { dy: -1 })
  assert.ok(c.place.obsidian, 'в чистом мире опору ставим')
  const extra = new Map([[`${c.place.K.x},${c.place.K.y},${c.place.K.z}`, 'crying_obsidian']])
  const c2 = dragon.pillarPlan(fakeBot(extra), P, { pillow: { x: c.H.x, z: c.H.z }, dy: -1 })
  assert.ok(c2)
  const same = dragon.pillarPlan.all.find(q => q.place.K.x === c.place.K.x && q.place.K.y === c.place.K.y && q.place.K.z === c.place.K.z)
  assert.ok(same, 'вариант с той же опорой есть')
  assert.equal(same.place.obsidian, false)
})

test('подушка над верхом столба (dy 0): опора под изголовьем к столбу, видимость дракона выше, бот так же низко', () => {
  const lo = dragon.pillarPlan(fakeBot(), P, { dy: -1 })
  const hi = dragon.pillarPlan(fakeBot(), P, { dy: 0 })
  assert.ok(hi, JSON.stringify(dragon.pillarPlan.why))
  assert.equal(hi.yb, P)
  assert.equal(hi.P, P)
  assert.deepEqual(hi.sup, [[hi.H.x, P - 1, hi.H.z]])
  assert.equal(Math.abs(hi.H.x) + Math.abs(hi.H.z), 1)
  assert.ok(hi.seen > lo.seen, `видимость ${hi.seen} против ${lo.seen}`)
  assert.ok(hi.feet.y + 1.8 <= P - 2.6)
  assert.ok(hi.expo <= 0.02)
  assert.ok(hi.nObs <= 4, `обсидиана ${hi.nObs}`)
})

test('подушка как можно выше: автовыбор — самая высокая, что ставится и щёлкается из окопа (P + 1 — только при запасе по голове)', () => {
  const bot = fakeBot()
  bot.inventory = { items: () => [{ name: 'obsidian', count: 4 }] }
  const c = dragon.pillarPlanAuto(bot, P)
  assert.ok(c)
  assert.equal(c.yb, P, 'при макушке ≤ P − 2.6 P + 1 из окопа не достать')
  assert.ok(c.nObs <= 4)
  assert.ok(c.feet.y + 1.8 <= P - 2.6)
})
