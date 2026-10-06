'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { GameClock, wall, follow, snapshot, changes } = require('../src/game-clock')

test('game delays and intervals use ticks, with cancellation and callback arguments', () => {
  const c = new GameClock({ manual: true, epoch: 1000 })
  const seen = []
  c.setTimeout(x => seen.push([x, c.now()]), 120, 'after3')
  const cancelled = c.setTimeout(() => seen.push('bad'), 50)
  c.clearTimeout(cancelled)
  const repeating = c.setInterval(() => seen.push(['interval', c.now()]), 100)
  c.advanceTicks(3)
  assert.deepEqual(seen, [['interval', 1100], ['after3', 1150]])
  c.clearInterval(repeating)
  c.advanceTicks(2)
  assert.equal(seen.length, 2)
  c.dispose()
})

test('freeze and step consume exactly the requested ticks without expiring game budgets', async () => {
  const c = new GameClock({ manual: true, epoch: 1000 })
  let done = false
  const sleep = c.sleep(150).then(() => { done = true })
  c.setState({ tick_rate: 100, is_frozen: true })
  c.pulse(); c.pulse()
  assert.equal(c.now(), 1000)
  c.step(2)
  c.pulse(); c.pulse(); c.pulse()
  await Promise.resolve()
  assert.equal(c.now(), 1100)
  assert.equal(done, false)
  c.step(1); c.pulse()
  await sleep
  assert.equal(c.now(), 1150)
  c.dispose()
})

test('tick rate changes do not change deadlines or simulate more than one tick per pulse', () => {
  const c = new GameClock({ manual: true, epoch: 0 })
  c.advanceTicks(10)
  c.setState({ tick_rate: 100, is_frozen: false })
  assert.equal(c.now(), 500)
  c.pulse()
  assert.equal(c.now(), 550)
  assert.equal(c.snapshot().tickRate, 100)
  c.setState({ tick_rate: 5, is_frozen: false })
  assert.equal(c.now(), 550)
  c.dispose()
})

test('scheduled callbacks preserve reflex AsyncLocalStorage ownership', () => {
  const als = new AsyncLocalStorage()
  const c = new GameClock({ manual: true })
  let owner
  als.run('worker', () => c.setTimeout(() => { owner = als.getStore() }, 50))
  als.run('physics', () => c.advanceTicks(1))
  assert.equal(owner, 'worker')
  c.dispose()
})

test('server age uses elapsed ticks, never daylight time or absolute world age', () => {
  const c = new GameClock({ manual: true, epoch: 0 })
  c.syncAge(1000000n)
  c.advanceTicks(20)
  c.syncAge(1000020n)
  assert.equal(c.now(), 1000)
  // Dimension age/rewind is a new anchor, not a million-tick catchup.
  c.syncAge(2000n)
  assert.equal(c.now(), 1000)
  c.dispose()
})

test('bound clock listens to protocol controls and stops on end', () => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const c = new GameClock({ manual: true }).attach(bot)
  bot._client.emit('set_ticking_state', { tick_rate: 60, is_frozen: true })
  bot._client.emit('step_tick', { tick_steps: 2 })
  c.pulse(); c.pulse(); c.pulse()
  assert.equal(c.snapshot().ticks, 2)
  bot.emit('end')
  c.pulse()
  assert.equal(c.snapshot().ticks, 2)
  assert.equal(bot._client.listenerCount('set_ticking_state'), 0)
})

function driver (t, { quantum = 0, turnMs = .25 }: any = {} as Record<string, any>) {
  let now = 0
  const timers = new Map()
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(wall, 'setTimeout', (fn, delay) => {
    const handle = { unref () {} }
    timers.set(handle, { fn, at: now + (quantum ? Math.ceil(delay / quantum) * quantum : delay) })
    return handle
  })
  t.mock.method(wall, 'clearTimeout', handle => timers.delete(handle))
  if (wall.setImmediate) {
    t.mock.method(wall, 'setImmediate', fn => {
      const handle = { unref () { this.unreferenced = true } }
      timers.set(handle, { fn, at: now + turnMs })
      return handle
    })
    t.mock.method(wall, 'clearImmediate', handle => timers.delete(handle))
  }
  function next () {
    return [...timers].sort((a, b) => a[1].at - b[1].at)[0]
  }
  const result = {
    now: () => now,
    blockedTo: at => { now = at },
    pending: () => timers.size,
    referenced: () => [...timers.keys()].filter(handle => !handle.unreferenced).length,
    async turn () {
      const scheduled = next()
      assert.ok(scheduled, 'the clock scheduled another native timer turn')
      timers.delete(scheduled[0])
      now = Math.max(now, scheduled[1].at)
      scheduled[1].fn()
      await new Promise<any>(resolve => setImmediate(resolve))
    },
    async advanceTo (at) {
      while (next()?.[1].at <= at) await result.turn()
      now = at
    }
  }
  return result
}

test('Air41 native anchor burst keeps the producer deadline while followers replay all confirmed ticks', async t => {
  // Actual target worker: xbow/opposite-gliders, ages 20745507..510 and
  // outgoing tick_end turns. No event loop turn ran between these age receipts.
  const events = [
    ['age', 20061.8019, 20745507], ['age', 20063.3674, 20745508],
    ['age', 20063.3809, 20745509], ['age', 20063.6156, 20745510],
    ['turn', 20063.9127], ['turn', 20063.9962], ['turn', 20064.1603], ['turn', 20064.254]
  ]
  for (const predictionTicks of [20, 0]) {
    const time = driver(t, { turnMs: 0 })
    time.blockedTo(20061.8019)
    const c = new GameClock({ epoch: 0, predictionTicks })
    Object.assign(c, { ticks: 7377, serverTicks: 7377, age: 20745506n, serverAt: 20060.8494,
      tickRate: 750, effectiveRate: 734.7801537779886,
      sampleAt: 20037.4103, sampleAge: 20745493n, pacingSampled: true })
    const seen = []
    c.on('tick', tick => seen.push(tick))
    c.start()
    try {
      for (const [kind, at, age] of events) {
        time.blockedTo(at)
        if (kind === 'age') {
          const before = seen.length
          c.syncAge(BigInt(age))
          assert.equal(seen.length, before, 'a packet receipt does not emit physics synchronously')
        } else await time.turn()
        assert.ok(c.ticks <= c.serverTicks + predictionTicks, 'native prediction cap remains bounded')
      }
      assert.deepEqual(seen, predictionTicks ? [7381] : [7378, 7379, 7380, 7381],
        'four confirmed grants advance world elapsed with one producer frame, not four physical steps in 0.3413 ms')
      if (predictionTicks) {
        time.blockedTo(20063.9127 + 1000 / c.effectiveRate)
        await time.turn()
        assert.equal(c.ticks, 7382, 'the next physical frame resumes at the paced deadline')
      }
    } finally { c.dispose() }
    assert.equal(time.pending(), 0)
  }
})

test('Author40 callback work is included in the physical pacing interval', async t => {
  const time = driver(t, { turnMs: .005 })
  const c = new GameClock({ epoch: 0 })
  // Native Author40: 18,985 physical steps in 37,965 wall ms, while the
  // server advanced 28,400 ticks. The old scheduler adds its full 750 TPS
  // interval after callback work, yielding the observed ~500 physical TPS.
  const callbackMs = 37965 / 18985 - 1000 / 750
  Object.assign(c, { ticks: 520, tickRate: 750, effectiveRate: 750 })
  const starts: number[] = []
  c.on('tick', () => {
    starts.push(time.now())
    time.blockedTo(time.now() + callbackMs)
  })
  c.start()
  try {
    while (starts.length < 100) await time.turn()
    const gaps = starts.slice(1).map((at, i) => at - starts[i])
    assert.ok(Math.min(...gaps) >= 1000 / 750 - 1e-9, 'callback cost cannot create catch-up physics bursts')
    assert.ok(Math.max(...gaps) <= 1000 / 750 + .01, 'callback work must not add a second delay to every physical step')
    assert.equal(c.ticks, 620)
  } finally { c.dispose() }
  assert.equal(time.pending(), 0)
})

test('Author40 confirmed elapsed reconciles a genuinely blocked producer without replaying interval callbacks', () => {
  const c = new GameClock({ epoch: 1791253944407 - 520 * 50 })
  Object.assign(c, { ticks: 520, serverTicks: 858 })
  c.pulse()
  const start = c.now()
  let expired = 0; let intervals = 0; let tickEvents = 0
  c.setTimeout(() => { expired++ }, (29258 - 858) * 50)
  c.setInterval(() => { intervals++ }, 50)
  c.on('tick', () => { tickEvents++ })
  // The two actual Author40 snapshots: physical callbacks fell behind by
  // 9,753 world ticks; none of those grants require an extra physics frame.
  Object.assign(c, { ticks: 19505, serverTicks: 29258 })
  try {
    c.pulse()
    assert.equal(c.now() - start, 28400 * 50)
    assert.equal(c.snapshot().lagTicks, 0)
    assert.equal(expired, 1)
    assert.equal(intervals, 1)
    assert.equal(tickEvents, 1)
  } finally { c.dispose() }
})

test('server TPS samples aggregate packet jitter over at least one second', async t => {
  const time = driver(t)
  const c = new GameClock({ manual: true, epoch: 0 })
  c.setState({ tick_rate: 100 })
  c.syncAge(0n)
  for (const [at, age] of [[100, 20n], [400, 40n], [500, 60n], [800, 80n], [1000, 100n]]) {
    await time.advanceTo(at)
    c.syncAge(age)
    assert.equal(c.effectiveRate, 100)
  }
  await time.advanceTo(1800)
  c.syncAge(140n)
  assert.equal(c.effectiveRate, 100)
  await time.advanceTo(2000)
  c.syncAge(150n)
  assert.equal(c.effectiveRate, 50, 'sustained server slowdown is still measured')
  c.dispose()
})

test('cold native pacing uses confirmed air30 anchors before its first one-second sample', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 750 })
  c.syncAge(13293405n)
  // Actual air30 update_time receipts, relative to its first running anchor.
  // Requested 750 reaches predictionTicks before the next confirmed packet;
  // native player positions then stand still while arrows keep world-ticking.
  const anchors = [[73.1714, 20], [140.1637, 40], [204.4973, 60], [263.1321, 80],
    [319.9899, 100], [366.0808, 120], [429.2835, 140], [499.6569, 160]]
  let lastTickAt = null; let largestGap = 0
  c.on('tick', () => {
    if (lastTickAt !== null && lastTickAt >= anchors[1][0]) largestGap = Math.max(largestGap, time.now() - lastTickAt)
    lastTickAt = time.now()
  })
  c.start()
  for (const [at, age] of anchors) {
    await time.advanceTo(at); c.syncAge(13293405n + BigInt(age))
    assert.ok(c.ticks <= c.serverTicks + c.predictionTicks, 'early pacing preserves the native prediction cap')
  }
  const longestNativeTick = Math.max(...anchors.map(([at], i) => (at - (anchors[i - 1]?.[0] ?? 0)) / 20))
  const coldGap = largestGap
  assert.ok(largestGap <= longestNativeTick * 2, `confirmed cold pacing must not stall a moving player: gap ${largestGap}ms`)
  assert.ok(c.effectiveRate < 750, 'actual cold receipt rate replaces the unmeasured request')
  assert.equal(c.sampleAt, 0, 'early estimates retain the original one-second aggregation window')
  await time.advanceTo(1011.4144); c.syncAge(13293825n)
  const sampled = c.effectiveRate
  assert.ok(Math.abs(sampled - 420000 / 1011.4144) < 1e-9)
  await time.advanceTo(1012.4144); c.syncAge(13293845n)
  assert.equal(c.effectiveRate, sampled, 'after the first full window, a batched receipt does not replace steady pacing')
  t.diagnostic(`air30 cold replay: largest player tick gap ${coldGap}ms, measured ${sampled}TPS`)
  c.dispose()
})

test('world observations use server ticks despite a 114-tick client backlog, without changing physics', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 1000 })
  c.setState({ tick_rate: 750 })
  c.advanceTicks(10)
  c.syncAge(1000n)
  c.syncAge(1114n)
  assert.equal(c.snapshot().lagTicks, 114)
  assert.equal(c.serverNow(), 7200)
  await time.advanceTo(4)
  assert.equal(c.serverNow(), 7350)
  assert.equal(c.now(), 1500, 'server observation time never advances client physics')
  await time.advanceTo(100)
  assert.equal(c.serverNow(), 8200, 'extrapolation is bounded by one native time-packet interval')
  const observedBeforeFreeze = c.observationNow()
  c.setState({ is_frozen: true })
  assert.equal(c.serverNow(), 7200)
  await time.advanceTo(1000)
  assert.equal(c.serverNow(), 7200, 'a frozen world does not interpolate wall time')
  assert.equal(c.observationNow(), observedBeforeFreeze, 'elapsed observation time freezes without an age correction')
  c.step(2); c.pulse(); c.pulse()
  assert.equal(c.serverNow(), 7300, 'native step grants advance frozen observations')
  assert.equal(c.observationNow(), observedBeforeFreeze + 100)
  c.syncAge(1116n)
  assert.equal(c.serverNow(), 7300, 'confirmed steps are not counted twice')
  assert.equal(c.observationNow(), observedBeforeFreeze + 100, 'confirmed age must not count native steps twice')
  c.setState({ is_frozen: false })
  await time.advanceTo(1004)
  assert.equal(c.observationNow(), observedBeforeFreeze + 250, 'thaw resumes elapsed observations without counting frozen wall time')
  c.dispose()
  const firstReadFrozen = new GameClock({ epoch: 1000 })
  firstReadFrozen.setState({ tick_rate: 750, is_frozen: true })
  firstReadFrozen.syncAge(1000n)
  firstReadFrozen.step(2); firstReadFrozen.pulse(); firstReadFrozen.pulse()
  const initial = firstReadFrozen.observationNow()
  assert.equal(firstReadFrozen.observationNow(), initial, 'initializing after native frozen steps must not count them twice')
  firstReadFrozen.syncAge(1002n)
  assert.equal(firstReadFrozen.observationNow(), initial)
  firstReadFrozen.dispose()
})

test('manual and unanchored observation clocks retain the gameplay clock fallback', () => {
  for (const c of [new GameClock({ manual: true, epoch: 1000 }), new GameClock({ epoch: 1000 })]) {
    c.advanceTicks(3)
    assert.equal(c.serverNow(), c.now())
    assert.equal(c.observationNow(), c.now())
    if (c.manual) { c.syncAge(1000n); c.syncAge(1100n); assert.equal(c.serverNow(), c.now()) }
    c.dispose()
  }
})

test('air27 packet intervals date moving targets at observed TPS and recover a corrected age', t => {
  // Actual update_time receipt intervals from the six clean air27 lanes,
  // requested 750 TPS; all measurements end before the body's 1 s sampler.
  const receipts = [
    [[7593.4569, 11433453], [7652.9525, 11433473], [7740.211, 11433493], [7795.7903, 11433513], [7884.2011, 11433533]],
    [[9794.6061, 11434204], [9847.9102, 11434224], [9902.6037, 11434244], [9944.3084, 11434264]],
    [[11109.9915, 11434615], [11149.9712, 11434635], [11189.8129, 11434655], [11223.5516, 11434675], [11262.7288, 11434695]],
    [[15094.0685, 11434889], [15138.537, 11434909], [15173.3566, 11434929]],
    [[16335.2575, 11435348], [16380.0864, 11435368], [16417.2762, 11435388]],
    [[17743.9992, 11435849], [17771.7902, 11435869], [17796.2578, 11435889], [17837.0223, 11435909]]
  ]
  let at = 0
  t.mock.method(wall, 'monotonic', () => at)
  for (const lane of receipts) {
    const c = new GameClock({ epoch: 0 })
    c.setState({ tick_rate: 750 })
    for (const [mono, age] of lane) { at = mono; c.syncAge(BigInt(age)) }
    const first = lane[0]; const last = lane.at(-1)
    const observed = (last[1] - first[1]) * 1000 / (last[0] - first[0])
    const pacingBeforeObservation = c.effectiveRate
    const before = c.serverNow()
    at += 4
    assert.ok(Math.abs(c.serverNow() - before - observed * .004 * 50) < 1e-7,
      `observer must use confirmed ${observed.toFixed(1)} TPS, not requested 750`)
    assert.equal(c.effectiveRate, pacingBeforeObservation, 'observation reads must not change the measured body rate')
    assert.equal(c.ticks, 0, 'observation reads must not advance physics or timers')
    c.setState({ is_frozen: true })
    const frozen = c.serverNow(); at += 100
    assert.equal(c.serverNow(), frozen)
    c.dispose()
  }

  const Vec3 = require('vec3')
  const bow = require('../src/bow')
  const c = new GameClock({ epoch: 0 })
  c.setState({ tick_rate: 750 })
  at = 17700; c.syncAge(11435841n)
  const entity = { position: new Vec3(4100.5, 178.85006786078213, 3115.8119138688944), metadata: [128], onGround: false }
  const tracker = bow.trackTarget(entity, () => c.serverNow())
  // Actual opposing-glider positions: +20 extrapolation cap, then a native
  // age confirmation of only +8. A correction must not discard later moves.
  at = 17739.5941; tracker.update()
  at = 17742.3096; entity.position.set(4100.5, 178.69821239203213, 3115.5453123063944); tracker.update()
  at = 17743.9992; c.syncAge(11435849n)
  at = 17744.1238; entity.position.set(4100.5, 178.48019481390713, 3115.2833494157694); tracker.update()
  at = 17746.9648; entity.position.set(4100.5, 177.87081981390713, 3114.3893064470194); tracker.update()
  const v = tracker.vel()
  assert.ok(v.y < 0 && v.z < 0, 'fresh native positions after an age correction must retain the observed 3D direction')
  assert.ok(tracker.at(3).z < entity.position.z, 'lead must follow the actual opposing movement instead of zero velocity')
  assert.equal(c.ticks, 0)
  c.dispose()
})

test('air28 native corrections neither compress movement time nor erase a glider velocity', t => {
  const clock = require('../src/game-clock')
  const bow = require('../src/bow')
  const Vec3 = require('vec3')
  let at = 3427.904
  t.mock.method(wall, 'monotonic', () => at)
  const c = new GameClock({ epoch: 0 })
  clock.activate(c)
  c.setState({ tick_rate: 750 })
  c.syncAge(11911591n)
  const entity = { position: new Vec3(4106.943599630026, 177.8903499984741, 3120.5), metadata: [128], onGround: false }
  const tracker = bow.trackTarget(entity)
  at = 3456.2953; tracker.update()
  // Recorded air28 bow/both-falling cap -> full +20 age confirmation.
  at = 3461.5388; c.syncAge(11911611n)
  at = 3461.6166; entity.position.set(4108.093746114401, 174.3114925765991, 3120.5); tracker.update()
  const dt = (3461.5388 - 3456.2953) * .75 + (3461.6166 - 3461.5388) * 20 / (3461.5388 - 3427.904)
  assert.ok(Math.abs(tracker.vel().x - 1.150146484375 / dt) < 1e-8,
    'confirming an anchor must not turn native vX into 26.67 blocks/tick')
  assert.equal(c.ticks, 0, 'observation intervals never simulate the player')
  c.dispose()

  const glider = new GameClock({ epoch: 0 })
  clock.activate(glider)
  glider.setState({ tick_rate: 750 })
  at = 13727; glider.syncAge(11913325n)
  const e = { position: new Vec3(4105.941890645651, 179.7670589828491, 3120.5), metadata: [128], onGround: false }
  const tracked = bow.trackTarget(e)
  at = 13743.937; tracked.update()
  at = 13745.9556; e.position.set(4106.303462911276, 179.4596859359741, 3120.5); tracked.update()
  // Actual partial age +12 and next position before the crossbow release.
  at = 13746.844; glider.syncAge(11913337n)
  at = 13747.7939; e.position.set(4106.504634786276, 179.3066097640991, 3120.5); tracked.update()
  assert.ok(Math.abs(tracked.vel().x - .201171875 / ((13747.7939 - 13745.9556) * .75)) < 1e-8,
    'a backward age correction must keep the next actual movement instead of zero velocity')
  assert.ok(tracked.vel().y < 0)
  assert.equal(glider.effectiveRate, 750)
  assert.equal(glider.ticks, 0)
  glider.dispose()
})

test('air33 compressed position receipts cannot imply multiple native moves in less than their tick count', t => {
  const bow = require('../src/bow')
  const Vec3 = require('vec3')
  let at = 0
  t.mock.method(wall, 'monotonic', () => at)
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 750 })
  const e: any = Object.assign(new EventEmitter(), { position: new Vec3(4104.7, 180, 3120.5), onGround: true,
    metadata: [], _ndObservationNow: () => c.observationNow() })
  const tracked = bow.trackTarget(e)
  const age = (mono, tick) => { at = mono; c.syncAge(BigInt(tick)) }
  const move = (mono, x, y, kind = 'rel_entity_move') => {
    at = mono; e.position.set(x, y, 3120.5)
    e._ndPositionReceipts = [e._ndPositionReceipts?.[1] ?? null,
      { x, y, z: 3120.5, t: c.observationNow(), grounded: e.onGround, kind }]
    e.emit('ndPositionObserved')
  }
  // Actual Air33 update_time anchors: the first full window measured ~658 TPS,
  // then only 20 confirmed ticks arrived after 68.96 ms. This is a packet
  // delivery observation, not proof that the body's full-window rate is wrong.
  age(6049.4396, 15130213)
  age(7023.2258, 15130853)
  move(7040.594, 4104.7, 180, 'sync_entity_position')
  age(7053.0468, 15130873)
  e.onGround = false
  move(7115.4961, 4105.781978536276, 179.9215999984741, 'sync_entity_position')
  move(7120.561, 4106.730220723776, 178.4074398422241)
  age(7122.0063, 15130893)
  move(7125.7346, 4107.388423848776, 176.6537777328491)
  move(7128.3189, 4107.854244161276, 175.1554867172241)
  move(7130.5557, 4108.337398458151, 173.4062191390991)
  // The final two distinct position updates belong to native world ticks
  // 15130896 and 15130898. ServerEntity.sendChanges selects at most one
  // position packet per ChunkMap tracker tick; even dirty-state bypasses of
  // PLAYER.updateInterval=2 cannot make two moves take less than two ticks.
  const intervals = 2
  const dx = 4108.337398458151 - 4107.388423848776
  const dy = 173.4062191390991 - 176.6537777328491
  const drag = Math.fround(.98)
  const sum = (1 - drag ** intervals) / (1 - drag)
  const start = (dy + .08 * drag * (intervals - sum) / (1 - drag)) / sum
  const fastestFall = start * drag ** intervals - .08 * drag * sum
  const v = tracked.vel()
  assert.ok(v.x <= dx / intervals + 1e-9,
    `native packet-count lower bound must prevent ${v.x} blocks/tick from compressed arrivals`)
  assert.ok(v.y >= fastestFall - 1e-9, 'the same interval lower bound applies to native fall acceleration')
  assert.equal(c.ticks, 0, 'observation reads do not advance player physics')
})

test('rate and dimension changes discard the previous age sampling window', async t => {
  const time = driver(t)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const c = new GameClock({ manual: true }).attach(bot)
  c.setState({ tick_rate: 100 })
  c.syncAge(1000n)
  await time.advanceTo(1000)
  c.syncAge(1050n)
  assert.equal(c.effectiveRate, 50)
  c.setState({ tick_rate: 60 })
  await time.advanceTo(1100)
  c.syncAge(1056n)
  await time.advanceTo(2100)
  c.syncAge(1116n)
  assert.equal(c.effectiveRate, 60)
  await time.advanceTo(3100)
  c.syncAge(1146n)
  assert.equal(c.effectiveRate, 30)
  bot.emit('respawn')
  assert.equal(c.effectiveRate, 60)
  assert.equal(c.snapshot().serverTicks, null)
  assert.equal(c.snapshot().lagTicks, null)
  c.syncAge(100000n)
  await time.advanceTo(4100)
  c.syncAge(100060n)
  assert.equal(c.effectiveRate, 60)
  c.dispose()
})

test('native confirmed elapsed preserves one paced frame and its microtask window', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 100 })
  c.syncAge(0n)
  c.start()
  await time.advanceTo(600)
  assert.equal(c.ticks, 20, 'prediction stops twenty ticks ahead of the last age packet')
  c.syncAge(60n)
  assert.equal(c.snapshot().serverTicks, 60)
  assert.equal(c.snapshot().lagTicks, 40)
  const resumedAt = time.now()
  const seen = []
  c.setInterval(() => {
    const tick = c.ticks
    seen.push(tick)
    Promise.resolve().then(() => seen.push(`after:${tick}`))
  }, 50)
  await time.turn()
  assert.equal(c.ticks, 60, 'confirmed world elapsed is reconciled on one producer turn')
  assert.deepEqual(seen, [60, 'after:60'], 'due physical intervals execute once, then yield to their continuations')
  assert.equal(c.snapshot().lagTicks, 0)
  await time.advanceTo(time.now() + 10)
  assert.equal(c.ticks, 61, 'normal pacing resumes after catching up')
  assert.ok(time.now() >= resumedAt + 10)
  assert.deepEqual(seen, [60, 'after:60', 61, 'after:61'])
  c.dispose()
})

test('high TPS pacing survives a sixteen millisecond native timer quantum', async t => {
  const time = driver(t, { quantum: 16 })
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.start()
  assert.equal(time.referenced(), 1, 'short waits must keep poll awake without external packets')
  await time.advanceTo(1000)
  assert.equal(c.ticks, 200)
})

test('freeze, completed steps and disposal cancel the short-wait pump', async t => {
  const time = driver(t, { quantum: 16 })
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.start()
  assert.equal(time.pending(), 1)
  c.setState({ is_frozen: true })
  assert.equal(time.pending(), 0)
  await time.advanceTo(100)
  c.step(2)
  await time.advanceTo(200)
  assert.equal(c.ticks, 2)
  assert.equal(time.pending(), 0)
  c.setState({ is_frozen: false })
  const sleeping = c.sleep(1000)
  c.dispose()
  await sleeping
  assert.equal(time.pending(), 0)
  assert.equal(c.timers.size, 0)
  await time.advanceTo(400)
  assert.equal(c.ticks, 2)
})

test('stalled prediction releases the pump and a fresh age packet resumes it', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0 })
  t.after(() => c.dispose())
  c.setState({ tick_rate: 200 })
  c.syncAge(0n)
  c.start()
  await time.advanceTo(200)
  assert.equal(c.ticks, 20)
  assert.equal(time.pending(), 0)
  c.syncAge(20n)
  await time.advanceTo(210)
  assert.equal(c.effectiveRate, 100, 'the first confirmed window also measures the stalled server rate')
  assert.equal(c.ticks, 21, 'prediction resumes at the measured native rate')
})

test('duplicate frozen follower snapshots do not postpone confirmed step grants', async t => {
  const time = driver(t)
  const source: Record<string, any> = { id: 'frozen-regression', ticks: 0, gameMs: 0, tickRate: 20, frozen: true, running: true }
  let c
  changes.once('bound', clock => { c = clock })
  follow(source)
  t.after(() => c.dispose())
  source.ticks = 3
  source.gameMs = 150
  follow(source)
  for (let n = 1; n <= 20; n++) {
    await time.advanceTo(n / 2)
    follow(source)
  }
  assert.equal(snapshot().ticks, 3)
  assert.equal(snapshot().stepping, 0)
  assert.equal(snapshot().lagTicks, 0)
})

test('followers replay confirmed snapshots without predicting or keeping an idle pump', async t => {
  const time = driver(t)
  const source: Record<string, any> = { id: 'confirmed-follower', ticks: 100, gameMs: 5000, tickRate: 250, frozen: false, running: true }
  let c
  changes.once('bound', clock => { c = clock })
  follow(source)
  t.after(() => c.dispose())
  assert.equal(time.pending(), 0, 'a follower does not predict future daemon ticks')
  const seen = []
  c.setInterval(() => {
    const tick = c.ticks
    seen.push(tick)
    Promise.resolve().then(() => seen.push(`after:${tick}`))
  }, 50)
  let slept = false
  const sleeping = c.sleep(100).then(() => { slept = true })
  source.ticks = 104
  source.gameMs = 5200
  follow(source)
  for (let tick = 101; tick <= 104; tick++) {
    await time.turn()
    assert.equal(c.ticks, tick)
    assert.deepEqual(seen.slice(-2), [tick, `after:${tick}`])
  }
  await sleeping
  assert.equal(slept, true)
  assert.equal(time.pending(), 0)
  await time.advanceTo(1000)
  assert.equal(c.ticks, 104, 'only later snapshots advance the follower')
  source.frozen = true
  follow(source)
  source.ticks = 107
  source.gameMs = 5350
  follow(source)
  for (let tick = 105; tick <= 107; tick++) {
    await time.turn()
    assert.equal(c.ticks, tick)
  }
  assert.equal(c.steps, 0)
  assert.equal(time.pending(), 0)
  source.frozen = false
  source.running = false
  follow(source)
  await time.advanceTo(2000)
  assert.equal(c.ticks, 107, 'an ended source cannot independently resume ticking')
  const cancelledOnReconnect = c.sleep(1000)
  const previous = c
  changes.once('bound', clock => { c = clock })
  follow({ ...source, id: 'replacement-follower', ticks: 2, gameMs: 100, running: true })
  await cancelledOnReconnect
  assert.equal(previous.disposed, true)
  assert.equal(previous.timers.size, 0)
  assert.equal(c.ticks, 2)
  assert.equal(time.pending(), 0)
})

test('lockstep runs each confirmed grant at once with physics, never by measured pace, and resyncs only past the valve', async t => {
  const time = driver(t)
  const c = new GameClock({ epoch: 0, lockstep: true, predictionTicks: 2 })
  t.after(() => c.dispose())
  let physics = 0
  c.on('tick', () => { physics++ })
  c.setState({ tick_rate: 750 })
  c.syncAge(0n)
  c.start()
  await time.advanceTo(5)
  assert.equal(c.ticks, 2, 'at most predictionTicks ahead of the confirmed server tick')
  assert.equal(time.pending(), 0, 'then the clock waits for the server without a pump')
  // The gated server confirms one tick per update_time: each grant is one physics tick on the next turn.
  for (let age = 1n; age <= 100n; age++) { c.syncAge(age); await time.turn() }
  assert.equal(c.ticks, 102)
  assert.equal(physics, 102, 'no tick is skipped')
  assert.ok(time.now() < 100 * 1000 / 750, 'no wall pacing at the requested or measured rate')
  // A lag inside the stall window is replayed tick by tick; past it the server ran on without us: skip, then follow.
  c.syncAge(110n)
  while (time.pending()) await time.turn()
  assert.equal(c.ticks, 112); assert.equal(physics, 112)
  c.syncAge(140n)
  while (time.pending()) await time.turn()
  assert.equal(c.ticks, 142); assert.equal(physics, 115, 'one resync pulse, then the two ticks ahead')
  assert.equal(c.snapshot().lockstep, true)
})

test('lockstep keeps its age anchor across respawn; ordinary clocks re-anchor', () => {
  for (const lockstep of [false, true]) {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    const c = new GameClock({ manual: true, lockstep }).attach(bot)
    bot._client.emit('update_time', { age: 100n })
    c.advanceTicks(3)
    bot._client.emit('update_time', { age: 105n })
    bot.emit('respawn')
    bot._client.emit('update_time', { age: 106n })
    assert.equal(c.serverTicks, lockstep ? 6 : 3)
    c.dispose()
  }
})

test('lockstep options come only from the farm env', () => {
  const { lockstepOptions } = require('../src/game-clock')
  assert.deepEqual(lockstepOptions({}), {})
  assert.deepEqual(lockstepOptions({ ND_LOCKSTEP: '0' }), {})
  assert.deepEqual(lockstepOptions({ ND_LOCKSTEP: '1' }), { lockstep: true, predictionTicks: 2 })
  assert.deepEqual(lockstepOptions({ ND_LOCKSTEP: '1', ND_LOCKSTEP_AHEAD: '4' }), { lockstep: true, predictionTicks: 4 })
  assert.throws(() => lockstepOptions({ ND_LOCKSTEP: '1', ND_LOCKSTEP_AHEAD: '0' }), /1\.\.20/)
})
