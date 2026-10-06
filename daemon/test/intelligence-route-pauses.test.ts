const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { Vec3 } = require('vec3')

function routeFixture ({ alarms = 7, abortOnRelease = false, advanceOnRelease = 0, declinedGuard = false, cancelledGuard = false } = {}) {
  const source = fs.readFileSync(process.env.NR_TEST_SOURCE || path.join(__dirname, '../src/nether-route.js'), 'utf8')
  const start = source.indexOf('async function routeTo(')
  assert.ok(start >= 0)
  const body = source.slice(start, source.indexOf('\nmodule.exports', start))
  let now = 0
  let calls = 0
  let releases = 0
  let steps = 0
  const bot = { entity: { position: new Vec3(0.5, 11, 0.5) }, inventory: { items: () => [] }, health: 20 }
  const session = { bot, reflex: null as object | null, emergencyOff: false }
  const ctl = {
    aborted: false,
    async waitReflex () {
      if (!session.reflex) return
      releases++
      now += advanceOnRelease
      session.reflex = null
      if (abortOnRelease) this.aborted = true
    }
  }
  const deps = {
    './ne-guard': { swatInstall () {}, attach () {}, hot: () => declinedGuard || cancelledGuard ? { why: 'hoglin в 2.5 бл.' } : null,
      react: async () => ({ acted: false, cancelled: cancelledGuard }), meleeFoes: () => [] },
    './tunnel': { makeToolFilter: () => null },
    './blaze': { hasEffect: () => false },
    './sealed': { FILL_NAMES: [] }
  }
  const context = {
    require: name => { assert.ok(deps[name], `unexpected dependency ${name}`); return deps[name] },
    process: { env: {} }, setImmediate,
    gameClock: { now: () => now },
    gridOf: () => ({ mark () {} }), feetCell: () => bot.entity.position.floored(),
    bastionZones: () => [], liveDangers: () => [], spawnerHot: () => [],
    receiptCostFor: () => ({ costs: { seconds: () => 0 }, context: {} }),
    inLava: () => false, syncAround: () => 0, C: { BLOCK: 1 },
    budgetOn: () => false, makeRoom: async () => {},
    threatCheck: async () => false, eatIfLow: async () => {},
    xyz: p => ({ x: p.x, y: p.y, z: p.z }), log () {},
    async plan () {
      calls++
      if (calls <= alarms) {
        session.reflex = { action: 'Shield' }
        return { ok: false, path: [], nodes: 0, why2: 'тревога' }
      }
      return { ok: true, path: [{ kind: 'flat', to: { x: 1, y: 11, z: 0 }, dig: [] }] }
    },
    async stepOne () {
      assert.equal(session.reflex, null, 'movement waits for the actual tactical release')
      assert.equal(ctl.aborted, false)
      steps++
      bot.entity.position = new Vec3(1.5, 11, 0.5)
      return 'ok'
    }
  }
  const routeTo = vm.runInNewContext(`${body}\nrouteTo`, context)
  return { session, ctl, run: seconds => routeTo(session, ctl, { x: 1, y: 11, z: 0, maxPlans: 1, timeoutSeconds: seconds }), stats: () => ({ calls, releases, steps }) }
}

test('seven tactical planning pauses preserve one physical route attempt and its goal', async () => {
  const f = routeFixture()
  const result = await f.run(20)
  assert.equal(result.ok, true)
  assert.equal(result.plans, 1)
  assert.equal(result.pausedPlans, 7)
  assert.deepEqual(f.stats(), { calls: 8, releases: 7, steps: 1 })
  assert.equal(f.session.emergencyOff, false)
})

test('abort during tactical release never resumes a physical route step', async () => {
  const f = routeFixture({ abortOnRelease: true })
  const result = await f.run(20)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'прервано')
  assert.deepEqual(f.stats(), { calls: 1, releases: 1, steps: 0 })
})

test('tactical planning pauses remain bounded by the original route deadline', async () => {
  const f = routeFixture({ advanceOnRelease: 1000 })
  const result = await f.run(3)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'время вышло')
  assert.equal(result.plans, 0)
  assert.deepEqual(f.stats(), { calls: 3, releases: 3, steps: 0 })
})

test('a declined tactical guard preserves the validated route instead of consuming its attempt as a replan', async () => {
  const f = routeFixture({ alarms: 0, declinedGuard: true })
  const result = await f.run(20)
  assert.equal(result.ok, true)
  assert.equal(result.guards || 0, 0)
  assert.deepEqual(f.stats(), { calls: 1, releases: 0, steps: 1 })
})

test('a cancelled guard cannot start a route planner or move the disconnected body', async () => {
  const f = routeFixture({ alarms: 0, cancelledGuard: true })
  const result = await f.run(20)
  assert.equal(result.ok, false)
  assert.deepEqual(f.stats(), { calls: 0, releases: 0, steps: 0 })
})
