import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'
import { windReportAt } from '../src/combat/enemy-wind'
import { WIND_REPORT_AGE_TICKS } from '../src/combat/team-wind'

function fixture(tick, reportTicks) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock: p => { const b = Block.fromProperties(p.y < 153 ? 'stone' : p.y === 153 ? 'smooth_sandstone_slab' : 'air', p.y === 153 ? { type: 'bottom' } : {}, 0); b.position = p.floored(); return b } }
  const ndClock: any = Object.assign(new EventEmitter(), { age: BigInt(tick), serverTicks: 0, ticks: 0, frozen: false, disposed: false })
  let observation = 1000, wall = 1000
  const foe: any = Object.assign(new EventEmitter(), { id: 2, username: 'Champ', type: 'player', position: new Vec3(525, 156, 600.6), velocity: new Vec3(0, .4, 0), onGround: false, height: 1.8, width: .6, metadata: [], equipment: [],
    _ndObservationNow: () => observation, _ndPositionReceipts: [null, { t: observation, kind: 'entity_move_look' }] })
  const bot: any = Object.assign(new EventEmitter(), { username: 'NeuroFarm31c', version: '1.21.11', registry, ndClock, health: 20, food: 20,
    game: { minY: -64, height: 384 }, entity: { id: 1, username: 'NeuroFarm31c', position: new Vec3(528.7, 153.5, 598.2), velocity: new Vec3(0, -.0784, 0), onGround: true, attributes: {}, effects: {}, yaw: 0 },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [], items: () => [] }, players: { Champ: { entity: foe } }, entities: { 2: foe }, blockAt: p => world.getBlock(p),
    physics: require('../src/tick-plugins').getPhysics().Physics(registry, world) })
  const ctl = { aborted: false, onAbort: [] as (() => void)[] }, session: any = { bot, current: { name: 'fight', ctl } }
  let timer: any, timerCleared = false
  const calls: any[] = [], reportCalls: any[] = [], finishCalls: any[] = []
  let terminal = false, crossed = false, reject: (() => void) | undefined, fresh = true
  const file = path.resolve(__dirname, '../src/combat/enemy-wind-execute.js'), module = { exports: {} as any }
  const req = stubRequire(file, {
    './team-wind': { WIND_REPORT_AGE_TICKS, worldTick: b => Number(b.ndClock.age) + b.ndClock.ticks - b.ndClock.serverTicks },
    './enemy-wind': { installWindTracking: () => {}, windMotionFresh: () => fresh, windReportAt: (b, r, t) => { reportCalls.push({ id: r.id, from: r.gameTick, to: t }); return windReportAt(b, r, t) },
      planEnemyWind: (_b, e, reports, options) => {
        calls.push({ e: e.position.clone(), receipt: e._ndPositionReceipts[1], reports, options })
        if (reject) { reject(); return null }
        return { target: e.username, shots: [], nominal: { out: terminal, exited: terminal || crossed } }
      },
      windFinishOpportunity: (b, e, arena, _world, deadline) => {
        finishCalls.push({ receipt: e._ndPositionReceipts[1], arena, deadline })
        return { target: e.username, at: e.position.offset(0, -3, 0), ticks: 24, gameTick: Number(b.ndClock.age) + b.ndClock.ticks - b.ndClock.serverTicks, frames: [{}] }
      } },
    '../pvp/search': { observedCollision: () => bot },
    '../game-clock': { wall: { monotonic: () => wall, setTimeout: fn => { timer = fn; return 1 }, clearTimeout: () => { timerCleared = true } } }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const reports = reportTicks.map((gameTick, i) => ({ id: ['NeuroFarm31c', 'NeuroFarm31d', 'NeuroFarm31e', 'NeuroWind31'][i], gameTick,
    position: { x: 528.7, y: 153.5, z: [598.2, 605.8, 607.8, 596.2][i] }, velocity: { x: 0, y: -.0784000015258789, z: 0 }, onGround: true, control: {} }))
  const params = { target: 'Champ', throwers: reports.slice(0, 3), allies: reports, arena: { x: 600.5, z: 600.5, r: 80, killY: 113 }, leadTicks: 4, maxShots: 3 }
  return { bot, foe, ndClock, ctl, session, calls, reportCalls, finishCalls, params, run: (extra = {}) => module.exports.enemyWindPlan(session, { ...params, ...extra }),
    terminal() { terminal = true },
    crossing() { crossed = true },
    reject(onPlan = () => {}) { reject = onPlan },
    receive(position: Vec3) {
      foe.position.update(position)
      foe._ndPositionReceipts = [foe._ndPositionReceipts[1], { t: observation += 50, kind: 'entity_move_look' }]
      foe.emit('ndPositionObserved')
    },
    gust() { fresh = false },
    elapse(ms: number) { wall += ms },
    step(n = 1) { ndClock.ticks += n; bot.emit('physicsTick') }, expire() { timer?.() },
    clean() { if (calls.length || finishCalls.length) bot.emit('end'); assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('end'), 0); assert.equal(bot.listenerCount('death'), 0); assert.equal(bot.listenerCount('kicked'), 0); assert.equal(ndClock.listenerCount('state'), 0); assert.equal(ctl.onAbort.length, 0); if (timer) assert.equal(timerCleared, true) } }
}

// Exact own-report ticks from the immutable P native capture03:43:47.269/375/484Z.
for (const [tick, reports] of [[10828148, [10828148, 10828149, 10828149, 10828148]], [10828150, [10828150, 10828151, 10828151, 10828152]], [10828152, [10828152, 10828154, 10828154, 10828154]]] as const) {
  test(`captured own reports wait forward to their fixed native epoch ${tick}`, async () => {
    const f = fixture(tick, reports), fixed = JSON.stringify(f.params), max = Math.max(...reports)
    let done = false
    const pending = Promise.resolve(f.run()).then(r => { done = true; return r })
    await Promise.resolve(); assert.equal(done, false, 'a valid future own report is not a stale snapshot')
    assert.equal(f.calls.length, 0, 'do not observe/plan in an older epoch')
    f.foe.position.y = 157.1
    for (let i = tick; i < max; i++) f.step()
    const result = await pending
    assert.equal(result.ok, true); assert.equal(result.gameTick, max)
    assert.equal(f.calls[0].e.y, 157.1, 'enemy observation is fresh after the wait')
    assert.ok(f.reportCalls.every(r => r.to >= r.from && r.to - r.from <= 20))
    assert.ok(f.calls[0].reports.every(r => r.gameTick === max))
    assert.equal(JSON.stringify(f.params), fixed, 'never rewrite captured timestamps or positions')
    f.clean()
  })
}

test('already-current reports have no mandatory wait', async () => {
  const f = fixture(500, [500, 500, 500, 500]), pending = f.run()
  assert.equal(f.calls.length, 1); assert.equal((await pending).ok, true); f.clean()
})

test('a landing can be requested with no ready caster and sends only the compact native sample', async () => {
  const f = fixture(500, [500, 500, 500, 500])
  const result = await f.run({ throwers: [], finish: true })
  assert.equal(result.why, 'no_useful_native_chain')
  assert.equal(f.calls.length, 0)
  assert.equal(f.finishCalls.length, 1)
  assert.deepEqual(result.finish, { target: 'Champ', at: f.foe.position.offset(0, -3, 0), ticks: 24, gameTick: 500 })
  f.clean()
})

test('a viable terminal wind plan takes priority over the optional ground landing', async () => {
  const f = fixture(500, [500, 500, 500, 500]); f.terminal()
  const result = await f.run({ finish: true })
  assert.equal(result.ok, true)
  assert.equal(result.finish, undefined)
  assert.equal(f.finishCalls.length, 0)
  f.clean()
})

test('an airborne crossing without a durable exit keeps the optional ground landing', async () => {
  const f = fixture(500, [500, 500, 500, 500]); f.crossing()
  const result = await f.run({ finish: true })
  assert.equal(result.ok, true)
  assert.equal(result.finish?.target, 'Champ')
  assert.equal(f.finishCalls.length, 1)
  f.clean()
})

test('a rejected chain yields to a queued visible receipt before forecasting the ground finish', async () => {
  const f = fixture(500, [500, 500, 500, 500]), landing = new Vec3(526, 152, 600.6)
  const received = new Promise<void>(resolve => f.reject(() => setImmediate(() => {
    f.receive(landing.offset(0, 3, 0)); f.step(); resolve()
  })))
  const result = await f.run({ finish: true })
  await received
  try {
    assert.equal(result.why, 'no_useful_native_chain')
    assert.equal(result.gameTick, 501)
    assert.deepEqual(result.finish, { target: 'Champ', at: landing, ticks: 24, gameTick: 501 })
    assert.equal(f.calls.length, 1); assert.equal(f.finishCalls.length, 1)
    assert.equal(f.calls[0].receipt.t, 1000); assert.equal(f.finishCalls[0].receipt.t, 1050)
    assert.equal(f.finishCalls[0].receipt.kind, 'entity_move_look')
    assert.equal(f.finishCalls[0].deadline, f.calls[0].options.deadline)
  } finally { f.clean() }
})

test('a rejected chain retains one ordinary recent finish forecast with no new receipt', async () => {
  const f = fixture(500, [500, 500, 500, 500]); f.reject()
  const result = await f.run({ finish: true })
  assert.deepEqual(result.finish, { target: 'Champ', at: f.foe.position.offset(0, -3, 0), ticks: 24, gameTick: 500 })
  assert.equal(f.calls.length, 1); assert.equal(f.finishCalls.length, 1)
  assert.equal(f.finishCalls[0].receipt, f.calls[0].receipt)
  f.clean()
})

for (const [mode, why, change] of [
  ['owner change', 'clock_sync_changed', f => { f.session.current = { name: 'retreat' } }],
  ['clock replacement', 'clock_sync_changed', f => { f.bot.ndClock = { ...f.ndClock } }],
  ['disconnect', 'clock_sync_changed', f => { f.bot.emit('end') }],
  ['target replacement', 'target_not_visible', f => { f.bot.players.Champ.entity = { ...f.foe } }],
  ['lost sight', 'target_not_visible', f => { f.receive(new Vec3(525, 151, 600.6)) }],
  ['new gust', 'pending_wind_observation', f => { f.gust() }],
  ['expired budget', 'planning_deadline', f => { f.elapse(201) }],
] as const) test(`a ground finish cannot use a rejected chain's stale sight after ${mode}`, async () => {
  const f = fixture(500, [500, 500, 500, 500])
  const changed = new Promise<void>(resolve => f.reject(() => setImmediate(() => { change(f); resolve() })))
  const result = await f.run({ finish: true })
  await changed
  try {
    assert.equal(result.why, why)
    assert.equal(result.finish, undefined)
    assert.equal(f.calls.length, 1); assert.equal(f.finishCalls.length, 0)
  } finally { f.clean() }
})

test('RPC planning is bounded by the first scheduled native fire tick', async () => {
  const f = fixture(500, [500, 500, 500, 500])
  assert.equal((await f.run()).ok, true)
  assert.equal(f.calls[0].options.deadline, 1000 + f.params.leadTicks * 50)
  f.clean()
})

for (const rate of [10, 40]) test(`RPC planning uses the native observation rate (${rate} TPS)`, async () => {
  const f = fixture(500, [500, 500, 500, 500])
  f.ndClock.observationRate = () => rate
  assert.equal((await f.run()).ok, true)
  assert.equal(f.calls[0].options.deadline, 1000 + f.params.leadTicks * 1000 / rate)
  f.clean()
})

test('an already-current frozen clock cannot start an unbounded native plan', async () => {
  const f = fixture(500, [500, 500, 500, 500])
  f.ndClock.frozen = true
  assert.equal((await f.run()).why, 'clock_sync_paused')
  assert.equal(f.calls.length, 0)
  f.clean()
})

for (const mode of ['owner', 'abort', 'body', 'death', 'end', 'kicked', 'pause', 'skip', 'timeout']) {
  test(`a forward report wait cancels cleanly on ${mode}`, async () => {
    const f = fixture(500, [500, 502, 502, 500]), pending = Promise.resolve(f.run())
    if (mode === 'owner') f.session.current = { name: 'retreat', ctl: { aborted: false } }
    if (mode === 'abort') { f.ctl.aborted = true; for (const fn of [...f.ctl.onAbort]) fn() }
    if (mode === 'body') f.session.bot = { ...f.bot }
    if (['death', 'end', 'kicked'].includes(mode)) f.bot.emit(mode)
    if (mode === 'pause') { f.ndClock.frozen = true; f.ndClock.emit('state') }
    if (mode === 'skip') f.step(5)
    else if (mode === 'timeout') f.expire()
    else f.step()
    const result = await pending
    assert.equal(result.ok, false); assert.notEqual(result.why, 'stale_reports', 'report age is valid; clock/ownership invalidated the wait')
    assert.equal(f.calls.length, 0); f.clean()
  })
}

test('the existing age window is checked again after synchronization', async () => {
  const f = fixture(500, [480, 520, 520, 500]), pending = Promise.resolve(f.run())
  for (let i = 0; i < 20; i++) f.step()
  const result = await pending
  assert.equal(result.ok, false); assert.equal(result.why, 'invalid_or_stale_reports'); assert.equal(f.calls.length, 0); f.clean()
})
