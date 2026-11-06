import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

test('pearl ambush: launch so the mace falls onto the landing point just after he appears', () => {
  const { ambushFlight, ambushPlan } = require('../src/combat/pearl-ambush')
  // Взлёт булавы — вершина 8 бл.: падение до 1.2 над тем же полом — 28 тиков.
  assert.equal(ambushFlight(0), 28)
  assert.ok(ambushFlight(2) < ambushFlight(0), 'он выше — встречаем раньше')
  assert.equal(ambushFlight(9), null, 'выше вершины — не достать')
  // 2 с до появления: полный заряд булавы; 1.5 с — неполный; 1.2 с — без заряда (опоздание до 0.3 с); 1 с — поздно.
  assert.equal(ambushPlan(2000, 0).charge, 9)
  assert.equal(ambushPlan(1500, 0).charge, 5)
  assert.equal(ambushPlan(1200, 0).charge, 0)
  assert.equal(ambushPlan(1000, 0), null)
  assert.deepEqual(ambushPlan(2000, 0, 800), ambushPlan(1200, 0), 'бег съедает время')
})

function fixture(wind = false) {
  const at = new Vec3(1, 120, .5), ticks = { now: 1004 }, calls: any[] = []
  const raw = { id: 7, username: 'Red', type: 'player', position: at.clone(), onGround: false, isValid: true }
  Object.defineProperty(raw, 'velocity', { get() { throw Error('private velocity') } })
  const bot: any = { entity: { id: 1, position: new Vec3(.5, 120, .5), onGround: true }, ndClock: {}, health: 20,
    players: { Red: { entity: raw } }, inventory: { items: () => [{ name: 'mace' }, { name: 'wind_charge', count: 2 }], slots: [] },
    clearControlStates() {}, look: async () => {}, setControlState() {} }
  const f = { bot, raw, at, ticks, calls, closed: 0, visible: true, refreshes: 0,
    forecast: () => ({ target: 'Red', at: at.clone(), gameTick: ticks.now, ticks: 1050 - ticks.now }),
    onSmash: (_e, _opts) => {}, onTick: () => {}, leaps: [] as boolean[], leapAvailable: true, handoff: true }
  const file = path.resolve(__dirname, '../src/combat/pearl-ambush.js'), module = { exports: {} as any }
  const req = stubRequire(file, {
    '../game-clock': { now: () => ticks.now * 50, setTimeout: (fn, ms) => queueMicrotask(() => { ticks.now += ms / 50; f.onTick(); fn() }),
      wall: { monotonic: () => 0 } },
    '../pvp/last-seen': { createLastSeen: () => ({ observe: e => e && ({ ...e, _ndVisible: f.visible }), close: () => { f.closed++ } }) },
    '../bow/track': { observedVelocity: () => new Vec3(0, 0, 0) },
    './team-wind': { worldTick: () => ticks.now, windInside: () => true },
    './enemy-wind': { windFinishOpportunity: () => { f.refreshes++; return f.forecast() } },
    '../mace/hands': { windCount: require('../src/mace/hands').windCount, ensureHotbar: async () => true, hotbarIndex: () => -1 },
    '../utility/trident': { tridents: () => [] },
    '../wind-leap': { leap: async (_session, _ctl, _to, p) => { f.leaps.push(!!p.dryRun); return { ok: f.leapAvailable, handedOff: f.handoff && typeof p.handoff === 'function' } } },
    '../mace': { windSmash: async (_bot, _ctl, e, opts) => { calls.push(ticks.now); f.onSmash(e, opts); return { launched: true } },
      descend: async (_bot, _ctl, e, opts) => { calls.push(ticks.now); f.onSmash(e, opts); return { hit: {} } } }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  return { ...f, state: f, run: (more: any = {}) => module.exports.pearlAmbush({ require: () => bot }, { aborted: false },
    { kind: wind ? 'wind' : undefined, owner: 'Red', at, eta: 50, gameTick: 1000, arena: { x: 0, z: 0, r: 80 }, ...more }) }
}

test('wind interception reports a retry only when no route was found before movement', async () => {
  for (const attempted of [false, true]) {
    const f = fixture(true)
    f.bot.entity.position = new Vec3(-12.9, 120, .5)
    f.bot.blockAt = () => null
    f.state.forecast = () => ({ target: 'Red', at: f.at.clone(), gameTick: f.ticks.now, ticks: 1030 - f.ticks.now })
    f.state.leapAvailable = attempted; f.state.handoff = false
    f.bot.look = () => assert.fail('route unexpectedly looked or moved')
    f.bot.setControlState = () => assert.fail('route unexpectedly moved')
    const result = await f.run({ eta: 30 })
    assert.equal(result.ok, false)
    assert.equal(f.leaps.some(dry => !dry), attempted)
    assert.equal(result.retry, attempted ? undefined : 'no_route_before_move')
    if (!attempted) {
      assert.equal(result.gameTick, 1004)
      assert.equal(result.entity, 7)
      assert.match(result.why, /1300 мс/)
    }
  }
})

test('a transferred wind interception refuses a new target life before trying a route', async () => {
  const f = fixture(true)
  const result = await f.run({ entity: 8 })
  assert.equal(result.ok, false)
  assert.equal(result.retry, undefined)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.leaps, [])
})

test('a native forecast ages by its original tick, and legacy pearl ETA still starts at receipt', async () => {
  const native = fixture(), legacy = fixture()
  assert.equal((await native.run()).ok, true)
  assert.equal((await legacy.run({ gameTick: undefined })).ok, true)
  assert.deepEqual(native.calls, [1012])
  assert.deepEqual(legacy.calls, [1016])
})

test('a pearl anchor a tick ahead of the local clock retains the original arrival', async () => {
  const f = fixture()
  assert.equal((await f.run({ gameTick: 1005 })).ok, true)
  assert.deepEqual(f.calls, [1017])
  const wrongEpoch = fixture()
  assert.equal((await wrongEpoch.run({ gameTick: 2000 })).ok, false)
  assert.deepEqual(wrongEpoch.calls, [])
})

test('wind landing attack requires the same visible opponent after the real arrival', async () => {
  const f = fixture(true)
  f.state.onSmash = (e, opts) => {
    f.ticks.now = 1049; f.raw.onGround = true
    assert.equal(opts.ready(), false)
    f.ticks.now = 1050; f.raw.onGround = false
    assert.equal(opts.ready(), false)
    f.raw.onGround = true
    assert.equal(opts.ready(), true)
    assert.equal(e.id, 7)
    f.state.visible = false
    assert.equal(e.isValid, false, 'the packet callback may run after sight is lost')
    assert.equal(e.id, undefined)
    f.state.visible = true
    assert.equal(e.isValid, true)
    f.bot.players.Red.entity = { ...f.raw, id: 8 }
    assert.equal(e.isValid, false, 'same name with a new entity cannot inherit the strike')
    assert.equal(e.id, undefined)
  }
  assert.equal((await f.run()).ok, true)
  assert.deepEqual(f.calls, [1012])
  assert.equal(f.state.closed, 1)
})

test('wind ambush can wait through a short uncertain post-gust observation', async () => {
  const f = fixture(true), forecast = f.state.forecast
  f.state.forecast = () => f.ticks.now === 1012 ? null : forecast()
  assert.equal((await f.run()).ok, true)
  assert.deepEqual(f.calls, [1013])
  assert.ok(f.state.refreshes >= 2)
})

test('wind ambush never spends a charge on an unconfirmed landing', async () => {
  const f = fixture(true)
  f.state.forecast = () => null
  assert.equal((await f.run()).ok, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.state.closed, 1)
})

test('ground wind interception hands its last offhand charge to the direct leap and mace descent', async () => {
  const f = fixture(true)
  f.at.x = f.raw.position.x = 8
  f.bot.inventory.items = () => [{ name: 'mace' }]
  f.bot.inventory.slots[45] = { name: 'wind_charge', count: 1 }
  f.bot.blockAt = p => ({ boundingBox: p.y < 120 ? 'block' : 'empty' })
  f.state.forecast = () => ({ target: 'Red', at: f.at.clone(), gameTick: f.ticks.now, ticks: 1040 - f.ticks.now })
  f.state.onSmash = (_e, opts) => { assert.equal(opts.ready(), false, 'the predicted landing is not yet a strike target') }
  const result = await f.run({ eta: 40 })
  assert.deepEqual(f.state.leaps, [true, false])
  assert.equal(result.travel, 'ветер+спуск')
  assert.equal(result.hit, true)
})

test('a later observed landing retimes the same approach without an early launch', async () => {
  const f = fixture(true), forecast = f.state.forecast
  f.state.forecast = () => ({ ...forecast(), ticks: 1052 - f.ticks.now })
  assert.equal((await f.run()).ok, true)
  assert.deepEqual(f.calls, [1014])
})

test('wind ambush refuses a future anchor or a replaced native clock', async () => {
  const future = fixture(true), replaced = fixture(true)
  replaced.state.onTick = () => { replaced.bot.ndClock = {} }
  assert.equal((await future.run({ gameTick: 1005 })).ok, false)
  assert.equal((await replaced.run()).ok, false)
  assert.deepEqual([...future.calls, ...replaced.calls], [])
})
