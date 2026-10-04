'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')
const { astar } = require('../src/ride')
const { planBoatRoute } = require('../src/boat-route-plan')

function pondFixture (ox, oz) {
  const wet = new Set()
  const key = (x, z) => `${x},${z}`
  // До второго берега можно доплыть по каналу; ближайшая вода у цели —
  // отдельный пруд, к которому никакого водного пути нет.
  for (let x = 0; x <= 8; x++) wet.add(key(ox + x, oz))
  wet.add(key(ox + 12, oz))
  const grid = {
    water: (x, z) => wet.has(key(x, z)),
    neighbours: n => [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => ({ n: { x: n.x + dx, y: n.y, z: n.z + dz }, cost: 1 }))
      .filter(({ n }) => wet.has(key(n.x, n.z)))
  }
  return { grid, start: { x: ox, y: 62, z: oz }, target: { x: ox + 12, z: oz + 1 },
    landingAt: n => n.x === ox + 8 ? { x: ox + 9, y: 63, z: oz } : n.x === ox + 12 ? { x: ox + 12, y: 63, z: oz + 1 } : null }
}

test('лодка выбирает связный берег вместо ближайшего несвязного пруда при произвольной цели', () => {
  for (const [x, z] of [[137, -219], [-742, 306]]) {
    const f = pondFixture(x, z)
    const r = planBoatRoute({ ...f, astar, landingAt: f.landingAt })
    assert.equal(r.complete, true)
    assert.equal(r.goal.x, x + 8)
    assert.equal(r.landing.x, x + 9)
    assert.ok(r.path.every(n => f.grid.water(n.x, n.z)), 'маршрут остаётся в связной воде')
  }
})

test('отсутствующий сухой берег не объявляется завершённой высадкой', () => {
  const f = pondFixture(451, -881)
  const r = planBoatRoute({ ...f, astar, landingAt: () => null })
  assert.equal(r.complete, false)
  assert.equal(r.landing, null)
})

function boatCompletion (beached, stay) {
  const file = path.resolve(__dirname, '../src/ride.js')
  let dismounted = 0
  const context = {
    require: createRequire(file), module: { exports: {} }, process: { env: {} }, console,
    setTimeout, clearTimeout, Buffer, testRide: async (session, ctl, boat, target, report) => { report.beached = beached; return true },
    testDismount: async () => { dismounted++; return true }, testPickup: async () => {}
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nrideBoat = testRide; dismount = testDismount; pickUpBoat = testPickup; sleep = async () => {}; module.exports.testRunBoat = runBoat;', context)
  const boat = { id: 17, name: 'oak_boat', position: new Vec3(451, 62, -881) }
  const bot = { vehicle: boat, entity: { position: boat.position.clone() }, inventory: { items: () => [] } }
  return context.module.exports.testRunBoat({ bot }, { aborted: false }, { kind: 'boat', mode: 'go', stay }, {},
    { x: 475, z: -889 }, Date.now() + 1000).then(report => ({ report, dismounted }))
}

test('водный промежуточный отрезок stay:true сохраняет управление лодкой', async () => {
  const r = await boatCompletion(false, true)
  assert.equal(r.dismounted, 0)
  assert.equal(r.report.arrived, true)
})

test('прибытие по воде без сухой площадки не высаживает тело в воду', async () => {
  const r = await boatCompletion(false, false)
  assert.equal(r.dismounted, 0)
  assert.equal(r.report.arrived, false)
})

test('валидный сухой берег разрешает высадку после прибытия', async () => {
  const r = await boatCompletion(true, false)
  assert.equal(r.dismounted, 1)
  assert.equal(r.report.arrived, true)
})
