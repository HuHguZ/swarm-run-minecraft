'use strict'
// Решатель броска жемчуга (pearl-hop.js): угол, отказ при стене, пустоте и малом хп.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as hop from '../src/pearl-hop'

// Мир: остров end_stone радиуса R с верхом y = top, платформа 5×5 обсидиана на y = 48 у (100, 0),
// extra — Map 'x,y,z' -> имя блока.
function world ({ R = 60, top = 60, extra = new Map() }: any = {} as Record<string, any>) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    let name = 'air'
    if (extra.has(k)) name = extra.get(k)
    else if (y <= top && y >= top - 8 && x * x + z * z <= R * R) name = 'end_stone'
    else if (y === 48 && x >= 98 && x <= 102 && z >= -2 && z <= 2) name = 'obsidian'
    return { name, boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block' }
  }
}
const feetP = new Vec3(100.5, 49, 0.5)

test('бросок с платформы на остров: угол найден, посадка на end_stone, к цели ближе', () => {
  const w = world({ R: 70 })
  const r = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5))
  assert.ok(r.plan, JSON.stringify(r.why))
  const p = r.plan
  assert.ok(p.pitch > 0 && p.pitch < 60 * Math.PI / 180, `наклон ${p.pitch}`)
  assert.equal(p.feet.y, 61)
  assert.ok(p.feet.x < 75, `посадка x ${p.feet.x}`)
  // повтор полёта с тем же углом — та же посадка
  const s = hop.simulate(w, { x: feetP.x, y: feetP.y + hop.EYE, z: feetP.z }, hop.velOf(p.yaw, p.pitch))
  assert.ok(s.tp && Math.abs(s.tp.x - p.tp.x) < 1e-9)
})

test('цель далеко за дальностью — бросок не дальше дальности, но с прогрессом', () => {
  const w = world({ R: 70 })
  const r = hop.planHop(w, feetP, new Vec3(-60.5, 61, 0.5))
  assert.ok(r.plan)
  assert.ok(r.plan.rem < 160 - 25, `остаток ${r.plan.rem}`)
})

test('стена на пути — дуга не врезается: либо высокая дуга, либо отказ, но не посадка в стену', () => {
  const extra = new Map()
  // стена обсидиана x = 75, z −6..6, y 49..90 — между платформой и островом
  for (let y = 49; y <= 90; y++) for (let z = -6; z <= 6; z++) extra.set(`75,${y},${z}`, 'obsidian')
  const w = world({ R: 70, extra })
  const r = hop.planHop(w, feetP, new Vec3(40.5, 61, 0.5), { lateral: [0] })
  if (r.plan) {
    // если нашёлся — траектория обходит стену сверху и садится за ней
    assert.ok(r.plan.feet.x < 75, `посадка ${r.plan.feet.x}`)
  } else {
    assert.ok(Object.keys(r.why).some(k => /врезается|посадка/.test(k)), JSON.stringify(r.why))
  }
  // стена до неба — отказ
  for (let y = 91; y <= 160; y++) for (let z = -6; z <= 6; z++) extra.set(`75,${y},${z}`, 'obsidian')
  const r2 = hop.planHop(world({ R: 70, extra }), feetP, new Vec3(40.5, 61, 0.5), { lateral: [0] })
  assert.equal(r2.plan, null)
})

test('пустота: острова нет в дальности — отказ; край острова — не цель', () => {
  const r = hop.planHop(world({ R: 10 }), feetP, new Vec3(0.5, 61, 0.5))
  assert.equal(r.plan, null)
  // узкая полоска (1 блок) над пустотой — край со всех сторон
  const extra = new Map()
  for (let x = 60; x <= 80; x++) extra.set(`${x},60,0`, 'end_stone')
  const r2 = hop.planHop(world({ R: 10, extra }), feetP, new Vec3(60.5, 61, 0.5), { lateral: [0] })
  assert.equal(r2.plan, null)
})

test('вода и лава — не посадка', () => {
  const extra = new Map()
  for (let x = -80; x <= 80; x++) for (let z = -80; z <= 80; z++) extra.set(`${x},60,${z}`, 'lava')
  const r = hop.planHop(world({ R: 70, extra }), feetP, new Vec3(30.5, 61, 0.5))
  assert.equal(r.plan, null)
})

test('кристалл на пути — отказ от этой дуги', () => {
  const w = world({ R: 70 })
  const r0 = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5), { lateral: [0] })
  assert.ok(r0.plan)
  const mid = r0.plan
  // кристалл в вершине траектории
  const s = hop.simulate(w, { x: feetP.x, y: feetP.y + hop.EYE, z: feetP.z }, hop.velOf(mid.yaw, mid.pitch))
  const top = s.path.reduce((m, q) => q.y > m.y ? q : m, s.path[0])
  const r = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5), { lateral: [0], obstacles: [{ pos: top, r: 3, name: 'end_crystal' }], maxTries: 3 })
  assert.ok(!r.plan || Math.hypot(r.plan.tp.x - mid.tp.x, r.plan.tp.z - mid.tp.z) > 0.5 || r.plan.arc !== mid.arc)
})

test('worth: мало хп, нет жемчуга, нет выигрыша — не бросать; мост через пустоту — бросать', () => {
  assert.equal(hop.worth({ walkSec: 60, hopSec: 2, dmg: 3.4, hp: 14, hpMin: 12, pearls: 5, reserve: 1 }).go, false)
  assert.equal(hop.worth({ walkSec: 60, hopSec: 2, dmg: 3.4, hp: 20, pearls: 1, reserve: 1 }).go, false)
  assert.equal(hop.worth({ walkSec: 6, hopSec: 2, dmg: 3.4, hp: 20, pearls: 5, reserve: 1 }).go, false)
  const w = hop.worth({ walkSec: 40, hopSec: 2.5, restSec: 10, dmg: 3.4, hp: 20, pearls: 5, reserve: 1 })
  assert.equal(w.go, true)
  assert.ok(w.gain > 20)
})

test('урон переноса: «Защита II» ×4 → 3.4, без брони — 5', () => {
  const bot = (lvl) => ({ inventory: { slots: [0, 0, 0, 0, 0, ...[5, 6, 7, 8].map(() => lvl ? { enchants: [{ name: 'protection', lvl }] } : null)] }, entity: {} as Record<string, any> })
  assert.equal(hop.pearlDamage(bot(0)), 5)
  assert.equal(hop.pearlDamage(bot(2)), 3.4)
  const modern = { entity: {}, registry: { enchantments: [{ name: 'protection' }] }, inventory: { slots: [null, null, null, null, null,
    { enchants: { enchantments: [] }, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 0, level: 4 }] } }]]) }] } }
  assert.equal(hop.pearlDamage(modern), 4.2)
})

test('пешком: пустота по пути дороже, чем суша', () => {
  const w = world({ R: 70 })
  const a = hop.walkEstimate(w, feetP, new Vec3(8.5, 61, 0.5))
  const b = hop.walkEstimate(world({ R: 110 }), new Vec3(100.5, 61, 0.5), new Vec3(8.5, 61, 0.5))
  assert.ok(a.voids >= 25, `пустот ${a.voids}`)
  assert.ok(a.sec > b.sec)
})

test('route composes three rising platforms and refuses a chain that spends its health or pearl reserve', () => {
  const levels = [[0, 100], [24, 108], [48, 116], [72, 124]]
  const terrain = (x, y, z) => {
    const solid = levels.some(([at, top]) => Math.abs(x - at) <= 5 && Math.abs(z) <= 5 && y >= top - 3 && y <= top)
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
  }
  const from = new Vec3(.5, 101, .5); const goal = new Vec3(72.5, 125, .5)
  const options = { pearls: 4, reserve: 1, hp: 20, hpMin: 1, dmg: 5, hpSec: .1, maxHops: 3, maxR: 30, lateral: [0] }
  const route = hop.planRoute(terrain, from, goal, options)
  assert.equal(route.plans.length, 3)
  assert.deepEqual(route.plans.map(plan => plan.feet.y), [109, 117, 125])
  assert.equal(route.damage, 15)
  assert.ok(route.seconds < hop.walkEstimate(terrain, from, goal).sec)
  for (const plan of route.plans) assert.equal(hop.settle(terrain, plan.tp).ok, true)
  assert.ok(hop.planRoute(terrain, from, goal, { ...options, hpMin: 12 }).plans.length <= 1)
  assert.ok(hop.planRoute(terrain, from, goal, { ...options, reserve: 3 }).plans.length <= 1)
  assert.equal(hop.planRoute(terrain, from, goal, { ...options, reserve: 4 }).plans.length, 0)
})
