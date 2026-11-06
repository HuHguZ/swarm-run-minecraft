import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'
import { REPO_ROOT } from '../daemon/src/paths'

function fixture({ planDelay = 0, defence = false, noPlan = false, planFailures = [] as string[], names = ['BlueA', 'BlueB'] } = {}) {
  let at = 100000, plans = 0, resetDuringPlan = false, gate: (() => void) | undefined
  const calls: any[] = [], pos: any = {}, bots: any[] = []
  const sw: any = { now: () => at, generation: 1, arena: { x: 0, z: 0, r: 10 }, bots, pos,
    alive: () => true, teamOf: b => b.team, hostile: (_b, id) => id === 'Red', panic: () => false,
    log: text => calls.push({ log: text }) }
  for (const name of names) {
    pos[name] = { p: { x: 0, y: 64, z: 0 }, inv: { wind_charge: 4 } }
    const b: any = { name, team: 'blue', last: defence ? { m: 'lava_escape', pending: true } : { m: 'fight', pending: true } }
    b.c = { call: async (method, p) => {
      calls.push({ name, method, p })
      if (method === 'wind_report' && p.cancel) return { detail: { ok: true } }
      if (method === 'wind_report' && p.probe) return { detail: { ok: true, coordination: p.coordination, ready: true, targetVisible: true } }
      if (method === 'wind_report') return { detail: { ok: true, coordination: p.coordination, ready: true, gameTick: 100 + Math.floor((at - 100000) / 50),
        report: { id: name, position: pos[name].p, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 100 + Math.floor((at - 100000) / 50) } } }
      if (method === 'enemy_wind_plan') {
        plans++; const tick = 100 + Math.floor((at - 100000) / 50)
        if (gate) await new Promise<void>(r => { gate = r })
        at += plans === 1 ? planDelay : 0
        if (resetDuringPlan) sw.generation++
        const failure = planFailures[plans - 1] || (noPlan ? 'no_useful_native_chain' : undefined)
        if (failure) return { detail: { ok: false, why: failure, gameTick: tick } }
        return { detail: { ok: true, gameTick: tick, plan: { gameTick: tick, target: p.target, shots: p.throwers.map((r, i) => ({ thrower: r.id, fireTick: tick + p.leadTicks + i * 2, arrivalTick: tick + p.leadTicks + i * 2 + 3 })) } } }
      }
      if (method === 'wind_out') return { detail: { fired: true, launchConfirmed: true, burstSeen: false } }
      throw new Error('unexpected RPC ' + method)
    } }
    bots.push(b)
  }
  const { swarmWind } = require('./swarm/swarm-driver/wind')
  const api = swarmWind(sw), seen = [{ id: 'Red', visible: true, position: { x: 7, y: 66, z: 0 }, velocity: { x: .1, y: .2, z: 0 } }]
  return { api, sw, bots, calls, seen, resetDuringPlan: () => { resetDuringPlan = true },
    blockPlan: () => { gate = () => {} }, releasePlan: () => gate?.() }
}

// Execute both actual arena wrappers: the inner wrapper records action identity,
// and the outer one can reject a call before it reaches the atomic RPC.
function arenaWrappers(f) {
  const source = readFileSync(path.join(REPO_ROOT, 'farm/arena/watch.ts'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('  const CLIMB_OK = '), end = source.indexOf('\n}\n\nexport function watchStatus')
  assert.ok(start > 0 && end > start)
  const js = require('esbuild').transformSync(source.slice(start, end), { loader: 'ts' }).code
  vm.runInNewContext(js, { bots: f.bots, pos: f.sw.pos, arena: f.sw.arena, ctx: { between: false },
    humanClose: () => false, ascentActive: () => false, L: null, X: 0, Y: 64, Z: 0 })
}
const settleWind = () => new Promise<void>(r => setImmediate(r))
function wingFixture() {
  const f = fixture(), gates: (() => void)[] = []
  f.sw.arena.y = 64; f.sw.boardOf = () => ({ enemies: () => f.seen })
  const seen = [{ ...f.seen[0], airborne: true }]
  for (const b of f.bots) {
    Object.assign(f.sw.pos[b.name].inv, { elytra: 1, firework_rocket: 8 }); b.last = { m: 'goto', pending: false }
    const original = b.c.call
    b.c.call = (method, p) => {
      if (method !== 'wing_orbit') return original(method, p)
      f.calls.push({ name: b.name, method, p })
      return new Promise(resolve => gates.push(() => resolve({ detail: { ok: true } })))
    }
  }
  arenaWrappers(f)
  f.api.windWing(f.bots[0], seen); f.api.windWing(f.bots[0], seen)
  assert.ok(f.bots.every(b => b.swarmReserved && b.last.m === 'wing_orbit'))
  for (const b of f.bots) f.sw.pos[b.name].gliding = true
  return { ...f, close: async () => { gates.forEach(done => done()); await settleWind(); await settleWind() } }
}

test('flying throwers request flying reports and dispatch a known-safe shared wind plan', async () => {
  const f = fixture()
  for (const b of f.bots) { f.sw.pos[b.name].gliding = true; b.last = { m: 'wing_orbit', pending: true } }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
  assert.ok(f.calls.filter(c => c.method === 'wind_report').every(c => c.p.flying === true))
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 2)
})

test('a ready local throw takes priority on the controller clock, without holding other targets or a new life', async t => {
  let wall = 1000
  t.mock.method(performance, 'now', () => wall)
  const f = fixture()
  const [a, b] = f.bots
  f.sw.hostile = (_b, target) => target === 'Red' || target === 'Other'
  const first = { type: 'wind_bid', id: 1, target: 'Red', entity: 9, tick: 100, ticks: 6 }
  assert.equal(f.api.windBid(a, first), true)
  assert.equal(f.api.windBid(b, { ...first, id: 2, tick: 123 }), false, 'a clock ahead by 23 ticks cannot steal a live reservation')
  assert.equal(f.api.windBid(b, { ...first, target: 'Other' }), true)
  assert.equal(await f.api.windObserve(a, f.seen, 100000), false)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0)
  f.api.windBid(a, { ...first, type: 'wind_bid_done', shot: { tick: 101, ticks: 5 } })
  wall += 210
  assert.equal(f.api.windBid(b, { ...first, tick: 129 }), false, 'the actual flight extends the release window')
  f.api.windBid(a, { ...first, type: 'wind_bid_done' })
  assert.equal(f.api.windBid(b, { ...first, tick: 109 }), true)
  f.api.windBid(a, { ...first, type: 'wind_bid_done' }) // an old cancellation cannot release b
  assert.equal(f.api.windBid(a, { ...first, id: 3, tick: 109 }), false)
  f.api.windBid(b, { ...first, type: 'wind_bid_done' })
  assert.equal(f.api.windBid(a, { ...first, id: 3, tick: 109 }), true)
  assert.equal(f.api.windBid(b, { ...first, entity: 10, tick: 109 }), true)
  f.sw.generation++
  assert.equal(f.api.windBid(a, { ...first, entity: 10, tick: 109 }), true)
})

test('a delayed launch receipt cannot open a second grant after the provisional release window', t => {
  let wall = 1000
  t.mock.method(performance, 'now', () => wall)
  const { api, bots: [a, b] } = fixture()
  const request = { type: 'wind_bid', id: 1, target: 'Red', entity: 9, tick: 100, ticks: 5 }
  assert.equal(api.windBid(a, request), true)
  wall += 205
  assert.equal(api.windBid(b, { ...request, tick: 124 }), false)
  wall += 9
  api.windBid(a, { ...request, type: 'wind_bid_done', shot: { tick: 103, ticks: 6 } })
  wall += 500
  assert.equal(api.windBid(b, { ...request, tick: 140 }), false)
  api.windBid(a, { ...request, type: 'wind_bid_done' })
  assert.equal(api.windBid(b, { ...request, tick: 140 }), true)
  wall += 7001
  assert.equal(api.windBid(a, { ...request, id: 2, tick: 280 }), true, 'a missing receipt still expires')
})

test('one observed follow-up may coexist with a released lead, but no extra dispatch can overlap it', async t => {
  t.mock.method(performance, 'now', () => 1000)
  const { api, bots: [lead, next, other], calls, seen } = fixture({ names: ['Lead', 'Next', 'Other'] })
  const request = { type: 'wind_bid', id: 1, target: 'Red', entity: 9, tick: 100, ticks: 5 }
  const follow = { ...request, id: 2, prefix: 42, ticks: 8 }
  assert.equal(api.windBid(lead, request), true)
  assert.equal(api.windBid(next, follow), false, 'the lead can still release another shot')
  api.windBid(lead, { ...request, type: 'wind_bid_done', shot: { tick: 101, ticks: 5 } })
  assert.equal(api.windBid(next, follow), true, 'a flight already released must not block its follow-up')
  assert.equal(api.windBid(other, { ...follow, id: 3, prefix: 43 }), false)
  api.windBid(lead, { ...request, type: 'wind_bid_done' })
  api.windBid(next, { ...follow, type: 'wind_bid_done', prefix: 43 })
  assert.equal(api.windBid(other, { ...request, id: 3 }), false, 'only the matching follow-up can clear its reservation')
  assert.equal(await api.windObserve(lead, seen), false)
  assert.equal(calls.filter(c => c.method === 'wind_out').length, 0)
  api.windBid(next, { ...follow, type: 'wind_bid_done' })
  assert.equal(api.windBid(other, { ...follow, prefix: 0 }), false, 'an invalid projectile ID must not reserve a slot')
  assert.equal(await api.windObserve(lead, seen), true)
  assert.equal(calls.filter(c => c.method === 'wind_out').length, 3)
})

test('shared wind considers a visible opponent at the physical edge before the nearer central opponent', async () => {
  const f = fixture()
  f.sw.hostile = (_bot, id) => id === 'Red' || id === 'Edge'
  const centre = { ...f.seen[0], position: { x: 1, y: 64, z: 0 } }
  const edge = { ...centre, id: 'Edge', position: { x: 9, y: 64, z: 0 } }
  await f.api.windObserve(f.bots[0], [centre, edge])
  assert.equal(f.calls.find(c => c.method === 'enemy_wind_plan')?.p.target, 'Edge')
})

test('shared planning chooses the newer direct observer from overlapping team sightings', async () => {
  for (const mode of ['fresh', 'stale', 'lost sight', 'other target', 'old round', 'no body report']) {
    const f = fixture(), [slow, fast] = f.bots
    f.sw.hostile = (_bot, id) => id === 'Red' || id === 'Other'
    let hold, unblock
    for (const bot of f.bots) {
      const call = bot.c.call
      bot.c.call = async (method, p) => {
        const reply = await call(method, p)
        if (bot === slow && method === 'wind_report' && !p.coordination && hold) {
          const pending = hold; hold = undefined
          await pending
        }
        if (bot === fast && method === 'wind_report' && !p.cancel) {
          reply.detail.gameTick += 5
          reply.detail.report.gameTick += 5
          if (mode === 'no body report' && !p.coordination) reply.detail.ok = false
        }
        if (method === 'enemy_wind_plan') {
          if (bot === slow) return {detail: {ok: false, why: 'clock_sync_changed', gameTick: 107}}
          reply.detail.gameTick += 5
          reply.detail.plan.gameTick += 5
          for (const shot of reply.detail.plan.shots) { shot.fireTick += 5; shot.arrivalTick += 5 }
        }
        return reply
      }
    }
    hold = new Promise(resolve => { unblock = resolve })
    const first = f.api.windObserve(slow, f.seen)
    const sight = mode === 'other target' ? [{...f.seen[0], id: 'Other'}] : f.seen
    assert.equal(await f.api.windObserve(fast, sight, mode === 'stale' ? 98999 : 100000), false)
    if (mode === 'lost sight') assert.equal(await f.api.windObserve(fast, [{...f.seen[0], visible: false}], 100000), false)
    if (mode === 'old round') f.sw.generation++
    unblock()
    const result = mode === 'old round' ? (await first, await f.api.windObserve(slow, f.seen)) : await first
    assert.equal(result, mode === 'fresh', mode)
    assert.deepEqual(f.calls.filter(c => c.method === 'enemy_wind_plan').map(c => c.name), [mode === 'fresh' ? fast.name : slow.name], mode)
    if (mode === 'fresh') assert.equal(f.calls.filter(c => c.method === 'wind_report' && !c.p.coordination).length, 2)
  }
})

function finishFixture({ plan = false, ready = false, names = ['BlueA', 'BlueB'] } = {}) {
  const f = fixture({ noPlan: !plan, names })
  const finish = { target: 'Red', at: { x: 6, y: 64, z: 0 }, ticks: 24, gameTick: 100 }
  f.sw.pos.BlueB.inv.mace = 1
  f.bots[1].last = { m: 'goto', pending: false }
  const state = { tick: 104, ground: true, ready }
  let complete: ((result: any) => void) | undefined
  for (const bot of f.bots) {
    const call = bot.c.call
    bot.c.call = async (method, p) => {
      if (method === 'pearl_ambush') {
        f.calls.push({ name: bot.name, method, p })
        return new Promise((resolve, reject) => { complete = result => result instanceof Error ? reject(result) : resolve(result) })
      }
      const reply = await call(method, p)
      if (method === 'enemy_wind_plan') reply.detail.finish = finish
      if (method === 'wind_report' && !p.coordination) {
        reply.detail.ready = state.ready
        if (p.flying === false) {
          reply.detail.ready = true
          reply.detail.gameTick = state.tick
          reply.detail.report.gameTick = state.tick
          reply.detail.report.onGround = state.ground
        }
      }
      return reply
    }
  }
  return { ...f, finish, state, complete: async (result: any = { detail: { ok: true } }) => { complete?.(result); await settleWind() } }
}

test('a fresh inside landing can hand off to one grounded mace helper with no ready thrower', async () => {
  const f = finishFixture(), [observer, helper] = f.bots
  arenaWrappers(f)
  try {
    await f.api.windObserve(observer, f.seen)
    assert.deepEqual(f.calls.find(c => c.method === 'enemy_wind_plan')?.p.throwers, [])
    assert.equal(f.calls.find(c => c.method === 'enemy_wind_plan')?.p.finish, true)
    const dispatches = () => f.calls.filter(c => c.method === 'pearl_ambush')
    assert.deepEqual(structuredClone(dispatches()), [{ name: helper.name, method: 'pearl_ambush',
      p: { kind: 'wind', owner: 'Red', at: f.finish.at, eta: f.finish.ticks, gameTick: f.finish.gameTick, arena: f.sw.arena } }])
    assert.ok(helper.swarmReserved)
    assert.ok(!f.calls.some(c => c.method === 'wind_out' || c.p?.coordination))
    f.state.ready = true
    await f.api.windObserve(observer, [{ ...f.seen[0], position: { x: 7.1, y: 66, z: 0 } }])
    assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 2, 'mace does not hold the team planning lock')
    assert.equal(dispatches().length, 1)
    await f.complete()
    assert.equal(helper.swarmReserved, undefined)
    await f.api.windObserve(observer, [{ ...f.seen[0], position: { x: 7.2, y: 66, z: 0 } }])
    assert.equal(dispatches().length, 1, 'one finish per forecast landing window')
  } finally { await f.complete() }
})

test('the BS ground handoff skips the mace helper on the distant upper ledge', async () => {
  const f = finishFixture(), [observer, helper] = f.bots
  Object.assign(f.sw.arena, { x: 600.5, z: 600.5, r: 77, ellipse: { a: 77, b: 65 } })
  f.finish.at = { x: 601.6691301367341, y: 120, z: 607.2115865176124 }
  f.finish.ticks = 36
  f.state.tick = f.finish.gameTick
  f.sw.pos[helper.name].p = { x: 596.8334631196759, y: 150.5, z: 543.4942680193658 }
  try {
    await f.api.windObserve(observer, f.seen)
    assert.ok(f.calls.some(c => c.method === 'enemy_wind_plan' && c.p.finish))
    assert.ok(!f.calls.some(c => c.method === 'pearl_ambush' || c.method === 'wind_report' && c.p.flying === false))
    assert.equal(helper.swarmReserved, undefined)
  } finally { await f.complete() }
})

test('a fresh unavailable or out-of-reach report lets the next reachable mace helper take the handoff', async () => {
  for (const mode of ['busy', 'moved']) {
    const f = finishFixture({ names: ['BlueA', 'BlueB', 'BlueC'] }), [observer, nearest, next] = f.bots
    f.finish.ticks = 36
    f.sw.pos[nearest.name].p = { x: 5, y: 64, z: 0 }
    f.sw.pos[next.name].p = { x: 3, y: 64, z: 0 }
    f.sw.pos[next.name].inv.mace = 1
    next.last = { m: 'goto', pending: false }
    const call = nearest.c.call
    nearest.c.call = async (method, p) => {
      const reply = await call(method, p)
      if (method === 'wind_report' && p.flying === false) {
        if (mode === 'busy') reply.detail.ready = false
        else reply.detail.report.position = { x: -60, y: 64, z: 0 }
      }
      return reply
    }
    try {
      await f.api.windObserve(observer, f.seen)
      assert.deepEqual(f.calls.filter(c => c.method === 'wind_report' && c.p.flying === false).map(c => c.name), [nearest.name, next.name], mode)
      assert.deepEqual(f.calls.filter(c => c.method === 'pearl_ambush').map(c => c.name), [next.name], mode)
      assert.equal(nearest.swarmReserved, undefined)
      assert.ok(next.swarmReserved)
    } finally { await f.complete() }
  }
})

test('an explicit untouched no-route result hands the same live landing to the next helper', async () => {
  const f = finishFixture({ names: ['BlueA', 'BlueB', 'BlueC'] }), [observer, nearest, next] = f.bots
  arenaWrappers(f)
  f.finish.ticks = 26; f.state.tick = 100
  f.sw.pos[nearest.name].p = { x: 7, y: 66, z: 0 }
  f.sw.pos[next.name].p = { x: 9, y: 64, z: 0 }; f.sw.pos[next.name].inv.mace = 1
  next.last = { m: 'goto', pending: false }
  const dispatched = () => f.calls.filter(c => c.method === 'pearl_ambush').map(c => c.name)
  try {
    await f.api.windObserve(observer, f.seen)
    assert.deepEqual(dispatched(), [nearest.name])
    assert.ok(nearest.swarmReserved); assert.equal(next.swarmReserved, undefined)
    f.state.tick = 101
    await f.complete({ status: 'done', detail: { ok: false, retry: 'no_route_before_move', gameTick: 101, entity: 7 } })
    assert.deepEqual(dispatched(), [nearest.name, next.name])
    assert.equal(f.calls.filter(c => c.method === 'pearl_ambush').at(-1).p.entity, 7)
    assert.equal(nearest.swarmReserved, undefined); assert.ok(next.swarmReserved)
  } finally { await f.complete() }
})

test('a helper lost during the fresh route receipt cannot strand the live handoff', async () => {
  const f = finishFixture({ names: ['BlueA', 'BlueB', 'BlueC', 'BlueD'] }), [observer, first, gone, last] = f.bots
  f.finish.ticks = 65; f.state.tick = 100; f.sw.arena.r = 77
  for (const [helper, x] of [[first, 7], [gone, -30], [last, -35]] as const) {
    Object.assign(f.sw.pos[helper.name], { p: { x, y: 64, z: 0 }, hp: 20 })
    Object.assign(f.sw.pos[helper.name].inv, { mace: 1, ender_pearl: 1 })
    helper.last = { m: 'goto', pending: false }
  }
  const call = gone.c.call
  gone.c.call = async (method, p) => {
    const reply = await call(method, p)
    if (method === 'wind_report' && p.flying === false) delete f.sw.pos[gone.name]
    return reply
  }
  try {
    await f.api.windObserve(observer, f.seen)
    f.state.tick = 101
    await f.complete({ status: 'done', detail: { ok: false, retry: 'no_route_before_move', gameTick: 101, entity: 7 } })
    assert.deepEqual(f.calls.filter(c => c.method === 'wind_report' && c.p.flying === false).map(c => c.name),
      [first.name, gone.name, last.name])
    assert.deepEqual(f.calls.filter(c => c.method === 'pearl_ambush').map(c => c.name), [first.name, last.name])
    assert.equal(first.swarmReserved, undefined)
    assert.equal(gone.swarmReserved, undefined)
    assert.ok(last.swarmReserved)
  } finally { await f.complete() }
})

test('the initial ground handoff waits out same-target wind leases', async () => {
  for (const mode of ['released lead', 'live follow', 'lease during receipt', 'cancelled lead', 'other target']) {
    const f = finishFixture(), [observer, helper] = f.bots
    f.sw.hostile = (_b, name) => name === 'Red' || name === 'Other'
    const bid = { type: 'wind_bid', id: 1, target: mode === 'other target' ? 'Other' : 'Red', entity: 7, tick: 100, ticks: 5,
      ...(mode === 'live follow' ? { prefix: 4 } : {}) }
    const lead = () => assert.equal(f.api.windBid(observer, bid), true)
    if (mode === 'lease during receipt') {
      const call = helper.c.call
      helper.c.call = async (method, p) => {
        const reply = await call(method, p)
        if (method === 'wind_report' && p.flying === false) lead()
        return reply
      }
    } else {
      lead()
      if (mode === 'released lead' || mode === 'cancelled lead') f.api.windBid(observer, {
        ...bid, type: 'wind_bid_done', ...(mode === 'released lead' ? { shot: { tick: 100, ticks: 5 } } : {})
      })
    }
    try {
      await f.api.windObserve(observer, f.seen)
      const allowed = mode === 'cancelled lead' || mode === 'other target'
      assert.equal(f.calls.some(c => c.method === 'pearl_ambush'), allowed, mode)
      assert.equal(!!helper.swarmReserved, allowed, mode)
    } finally { await f.complete() }
  }
})

test('only an untouched current no-route result can pass the same landing to another helper', async () => {
  for (const mode of ['uncertain failure', 'rejected', 'interrupted', 'expired', 'stale result', 'round changed', 'defence', 'owner replaced', 'live lead', 'live follow-up']) {
    const f = finishFixture({ names: ['BlueA', 'BlueB', 'BlueC'] }), [observer, nearest, next] = f.bots
    f.finish.ticks = 26; f.state.tick = 100
    f.sw.pos[nearest.name].p = { x: 7, y: 66, z: 0 }
    f.sw.pos[next.name].p = { x: 9, y: 64, z: 0 }; f.sw.pos[next.name].inv.mace = 1
    next.last = { m: 'goto', pending: false }
    const replacement = {}
    try {
      await f.api.windObserve(observer, f.seen)
      const reply = { status: 'done', detail: { ok: false, retry: 'no_route_before_move', gameTick: 101, entity: 7 } }
      if (mode === 'uncertain failure') delete (reply.detail as any).retry
      if (mode === 'interrupted') reply.status = 'interrupted'
      if (mode === 'expired') reply.detail.gameTick = 126
      if (mode === 'stale result') reply.detail.gameTick = 99
      if (mode === 'round changed') f.sw.generation++
      if (mode === 'defence') next.last = { m: 'evade', pending: true }
      if (mode === 'owner replaced') nearest.swarmReserved = replacement
      if (mode === 'live lead' || mode === 'live follow-up') assert.equal(f.api.windBid(observer, {
        type: 'wind_bid', id: 1, target: 'Red', entity: 7, tick: 101, ticks: 5, ...(mode === 'live follow-up' ? { prefix: 4 } : {})
      }), true)
      f.state.tick = reply.detail.gameTick
      await f.complete(mode === 'rejected' ? new Error('socket closed') : reply)
      assert.deepEqual(f.calls.filter(c => c.method === 'pearl_ambush').map(c => c.name), [nearest.name], mode)
      assert.equal(nearest.swarmReserved, mode === 'owner replaced' ? replacement : undefined, mode)
      assert.equal(next.swarmReserved, undefined, mode)
    } finally { await f.complete() }
  }
})

test('ground reach retains the native wind leap and a timed own pearl as approach options', async () => {
  for (const route of ['wind', 'pearl', 'low-health pearl']) {
    const f = finishFixture(), [observer, helper] = f.bots, m = f.sw.pos[helper.name]
    f.finish.ticks = route === 'wind' ? 36 : 65
    m.p.x = route === 'wind' ? -8 : -30
    if (route !== 'wind') m.inv.ender_pearl = 1
    m.hp = route === 'low-health pearl' ? 9 : 20
    try {
      await f.api.windObserve(observer, f.seen)
      assert.equal(f.calls.some(c => c.method === 'pearl_ambush'), route !== 'low-health pearl', route)
    } finally { await f.complete() }
  }
})

test('a live or unconfirmed wind release retains priority over a reported landing', async () => {
  for (const lost of [false, true]) {
    const f = finishFixture({ plan: true, ready: true })
    if (lost) {
      const observer = f.bots[0], call = observer.c.call
      observer.c.call = async (method, p) => {
        const reply = await call(method, p)
        if (method === 'wind_out') throw Error('unknown launch')
        return reply
      }
      const helper = f.bots[1], callHelper = helper.c.call
      helper.c.call = async (method, p) => {
        const reply = await callHelper(method, p)
        return method === 'wind_out' ? { detail: { fired: false } } : reply
      }
    }
    await f.api.windObserve(f.bots[0], f.seen)
    assert.ok(f.calls.some(c => c.method === 'wind_out'))
    assert.ok(!f.calls.some(c => c.method === 'pearl_ambush'))
  }
})

test('a nonterminal chain hands off only after all wind release attempts refuse', async () => {
  for (const outcome of ['inside', 'crossing', 'outside']) {
    const f = finishFixture({ plan: true, ready: true })
    for (const bot of f.bots) {
      const call = bot.c.call
      bot.c.call = async (method, p) => {
        const reply = await call(method, p)
        if (method === 'enemy_wind_plan' && outcome !== 'inside') reply.detail.plan.worst = { exited: true, out: outcome === 'outside' }
        return method === 'wind_out' ? { detail: { fired: false, why: 'changed_interception' } } : reply
      }
    }
    try {
      await f.api.windObserve(f.bots[0], f.seen)
      assert.ok(f.calls.some(c => c.method === 'wind_out' && c.p.replan))
      const ground = f.calls.findIndex(c => c.method === 'pearl_ambush')
      if (outcome === 'outside') assert.equal(ground, -1)
      else assert.ok(ground > f.calls.findIndex(c => c.method === 'wind_report' && c.p.cancel), outcome)
    } finally { await f.complete() }
  }
})

test('ground finish preserves exact time, target, grounding and current owner', async () => {
  for (const mode of ['expired', 'airborne', 'outside', 'wrong-target', 'defence', 'wing', 'round-change', 'new-owner']) {
    const f = finishFixture({ ready: true }), helper = f.bots[1]
    if (mode === 'expired') f.state.tick = f.finish.gameTick + f.finish.ticks
    if (mode === 'airborne') f.state.ground = false
    if (mode === 'outside') f.finish.at.x = 11
    if (mode === 'wrong-target') f.finish.target = 'Another'
    if (mode === 'defence') helper.maceDefense = { until: 100001 }
    if (mode === 'wing') helper.last = { m: 'wing_orbit', pending: true }
    const foreign = {}
    const call = helper.c.call
    helper.c.call = async (method, p) => {
      const reply = await call(method, p)
      if (method === 'wind_report' && p.flying === false) {
        if (mode === 'round-change') f.sw.generation++
        if (mode === 'new-owner') helper.swarmReserved = foreign
      }
      return reply
    }
    await f.api.windObserve(f.bots[0], f.seen)
    assert.ok(!f.calls.some(c => c.method === 'pearl_ambush'), mode)
    assert.equal(helper.swarmReserved, mode === 'new-owner' ? foreign : undefined, mode)
  }
})

test('simultaneous Colosseum escorts separate their launch lanes and reuse the completed lane', async () => {
  const f = fixture({ names: ['BlueA', 'BlueB', 'BlueC', 'BlueD'] })
  Object.assign(f.sw.arena, { y: 64, ellipse: { a: 77, b: 65 } })
  f.sw.boardOf = () => ({ enemies: () => f.seen })
  const releases: (() => void)[] = []
  for (const bot of f.bots) {
    Object.assign(f.sw.pos[bot.name].inv, { elytra: 1, firework_rocket: 8 })
    bot.last = { m: 'goto', pending: false }
    const call = bot.c.call
    bot.c.call = (method, p) => {
      if (method !== 'wing_orbit') return call(method, p)
      f.calls.push({ name: bot.name, method, p })
      return new Promise(resolve => releases.push(() => resolve({ detail: { ok: true } })))
    }
  }
  arenaWrappers(f)
  const seen = [{ ...f.seen[0], airborne: true }]
  try {
    for (let i = 0; i < 3; i++) f.api.windWing(f.bots[0], seen)
    const orbits = () => f.calls.filter(c => c.method === 'wing_orbit')
    assert.deepEqual(orbits().map(c => c.p.lane).sort(), [-1, 0, 1])
    releases[0](); await settleWind()
    f.api.windWing(f.bots[0], seen)
    assert.equal(orbits().length, 4)
    assert.equal(orbits()[3].p.lane, orbits()[0].p.lane)
  } finally { releases.forEach(done => done()); await settleWind() }
})

for (const known of [true, false]) test(`a ${known ? 'reported' : 'just refused'} rescue hands the escort to a free teammate and permits a retry on release`, async () => {
  const f = fixture(), [rescuer, teammate] = f.bots
  f.sw.arena.y = 64
  f.sw.boardOf = () => ({ enemies: () => f.seen })
  f.sw.pos[rescuer.name].rescuing = known
  let rescueActive = true
  for (const b of f.bots) {
    Object.assign(f.sw.pos[b.name].inv, { elytra: 1, firework_rocket: 8 })
    b.last = { m: 'goto', pending: false }
    const call = b.c.call
    b.c.call = async (method, p) => {
      if (method !== 'wing_orbit') return call(method, p)
      f.calls.push({ name: b.name, method, p })
      return b === rescuer && rescueActive
        ? { status: 'failed', error: 'спасаюсь на элитрах', code: 'RESCUE_BUSY' }
        : { detail: { ok: true } }
    }
  }
  arenaWrappers(f)
  const seen = [{ ...f.seen[0], airborne: true }]
  const escorts = () => f.calls.filter(c => c.method === 'wing_orbit').map(c => c.name)
  if (!known) {
    f.api.windWing(rescuer, seen)
    await settleWind()
    assert.deepEqual(escorts(), [rescuer.name])
    assert.equal(f.sw.pos[rescuer.name].rescuing, true, 'the real RPC wrapper observes the rescue refusal')
  }
  f.api.windWing(rescuer, seen)
  await settleWind()
  const during = known ? [teammate.name] : [rescuer.name, teammate.name]
  assert.deepEqual(escorts(), during, 'while rescue owns the body the free teammate can escort')
  rescueActive = false
  f.sw.pos[rescuer.name].rescuing = false
  f.api.windWing(rescuer, seen)
  await settleWind()
  assert.deepEqual(escorts(), [...during, rescuer.name], 'rescue did not fly the rejected escort, so the same target remains eligible')
  if (!known) assert.ok(f.calls.some(c => c.log?.includes('облёт спасаюсь на элитрах')))
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('shared wind coordinates every ally and releases the same order after dispatch', async () => {
  const f = fixture({ names: ['BlueA', 'BlueB', 'BlueC'] })
  f.sw.pos.BlueC.inv.wind_charge = 0
  assert.equal(await f.api.windObserve(f.bots[0], f.seen), true)
  const reports = f.calls.filter(c => c.method === 'wind_report' && c.p.coordination && !c.p.cancel)
  const order = reports[0].p.coordination
  assert.ok(order)
  assert.ok(f.calls.findIndex(c => c.method === 'enemy_wind_plan') < f.calls.indexOf(reports[0]))
  assert.deepEqual(reports.map(c => c.name), ['BlueA', 'BlueB', 'BlueC'])
  assert.ok(f.calls.filter(c => c.method === 'wind_out').every(c => c.p.coordination === order))
  const releases = f.calls.filter(c => c.method === 'wind_report' && c.p.cancel)
  assert.deepEqual(releases.map(c => [c.name, c.p.target, c.p.coordination]), reports.map(c => [c.name, 'Red', order]))
})

test('the release checks all allies from the newer order acknowledgements', async () => {
  const f = fixture()
  for (const bot of f.bots) {
    const call = bot.c.call
    bot.c.call = async (method, p) => {
      const result = await call(method, p)
      if (method === 'wind_report' && p.coordination && !p.cancel) {
        result.detail.gameTick++
        result.detail.report = { ...result.detail.report, gameTick: result.detail.gameTick, position: { x: 0, y: 65, z: 0 } }
      }
      return result
    }
  }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen), true)
  const releases = f.calls.filter(c => c.method === 'wind_out')
  assert.equal(releases.length, 2)
  for (const { p } of releases) assert.deepEqual(p.allies.map(r => [r.id, r.gameTick, r.position.y]), [['BlueA', 101, 65], ['BlueB', 101, 65]])
})

test('a lost coordination acknowledgement cancels even the ally whose response was lost', async () => {
  const f = fixture()
  const blue = f.bots[1], call = blue.c.call
  blue.c.call = async (method, p) => {
    const reply = await call(method, p)
    if (method === 'wind_report' && p.coordination && !p.cancel) throw new Error('lost acknowledgement')
    return reply
  }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen), false)
  assert.ok(f.calls.some(c => c.method === 'enemy_wind_plan'))
  assert.ok(!f.calls.some(c => c.method === 'wind_out'))
  assert.deepEqual(f.calls.filter(c => c.method === 'wind_report' && c.p.cancel).map(c => c.name), ['BlueA', 'BlueB'])
})

test('only an acknowledged empty chain can reprice one fresh independent cast', async () => {
  for (const lost of [false, true]) {
    const f = fixture()
    const second = f.bots[1]
    for (const bot of f.bots) {
      const call = bot.c.call
      bot.c.call = async (method, p) => {
        const reply = await call(method, p)
        if (method !== 'wind_out' || p.replan) return reply
        if (lost && bot === second) throw Error('lost after dispatch')
        return { detail: { fired: false, why: 'changed_interception' } }
      }
    }
    assert.equal(await f.api.windObserve(f.bots[0], f.seen), !lost)
    const retries = f.calls.filter(c => c.method === 'wind_out' && c.p.replan)
    assert.equal(retries.length, lost ? 0 : 1)
    if (!lost) assert.equal(retries[0].p.target, 'Red')
  }
})

test('a reserved replacement can reprice the cast when the selected hand becomes busy', async () => {
  const f = fixture()
  const original = f.bots[0].c.call
  f.bots[0].c.call = async (method, p) => {
    const reply = await original(method, p)
    if (method === 'enemy_wind_plan') reply.detail.plan.shots = reply.detail.plan.shots.slice(0, 1)
    if (method === 'wind_out') return { detail: { fired: false, why: 'hands_or_defence_busy' } }
    return reply
  }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen), true)
  const retry = f.calls.find(c => c.method === 'wind_out' && c.p.replan)
  assert.equal(retry.name, 'BlueB')
  assert.equal(retry.p.target, 'Red')
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('a busy thrower is replaced by a ready witness even when a blind ally is closer', async () => {
  const f = fixture({ names: ['BlueA', 'BlueB', 'BlueC'] })
  f.sw.pos.BlueB.p.x = 6
  f.sw.pos.BlueC.p.x = 1
  for (const bot of f.bots) {
    const call = bot.c.call
    bot.c.call = async (method, p) => {
      const reply = await call(method, p)
      if (method === 'enemy_wind_plan') reply.detail.plan.shots = reply.detail.plan.shots.slice(0, 1)
      if (method === 'wind_report' && p.probe && bot.name === 'BlueB') reply.detail.targetVisible = false
      if (method === 'wind_out' && bot.name === 'BlueA') return { detail: { fired: false, why: 'hands_or_defence_busy' } }
      if (method === 'wind_out' && bot.name === 'BlueB') return { detail: { fired: false, why: 'target_not_visible' } }
      return reply
    }
  }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen), true)
  const release = f.calls.filter(c => c.method === 'wind_out')
  assert.deepEqual(release.map(c => [c.name, c.p.replan]), [['BlueA', undefined], ['BlueC', true]])
  assert.ok(f.calls.filter(c => c.method === 'wind_report' && c.p.probe).every(c => c.p.coordination === release[0].p.coordination))
})

test('the exact wing movement lease survives real wrapper queries, shared dispatch and atomic cleanup', async () => {
  const f = wingFixture(), tokens = f.bots.map(b => b.swarmReserved), actions = f.bots.map(b => b.last)
  try {
    assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
    assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 2)
    for (const [i, b] of f.bots.entries()) {
      assert.equal(b.last, actions[i]); assert.equal(b.last.pending, true)
      assert.equal(b.swarmReserved, tokens[i], 'atomic cleanup cannot release the movement owner')
    }
  } finally { await f.close() }
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('real arena wrappers retain the wing action for queries and atomic wind, with movement and climbing protected', async () => {
  const f = wingFixture()
  try {
    for (const b of f.bots) {
      const action = b.last
      for (const method of ['wind_report', 'enemy_wind_plan', 'wind_out']) {
        const result = await b.c.call(method, method === 'enemy_wind_plan' ? { throwers: [], leadTicks: 4 } : {})
        assert.notEqual(result.status, 'skipped', method)
        assert.equal(b.last, action); assert.equal(action.pending, true)
      }
      for (const method of ['fight', 'wind_push', 'fly_to']) assert.equal((await b.c.call(method, {})).status, 'skipped', method)
      assert.equal(b.last, action)
      b.climbing = true
      assert.equal((await b.c.call('wind_out', {})).status, 'skipped', 'a beside hand action cannot interrupt climbing')
      assert.equal(b.last, action); b.climbing = false
    }
  } finally { await f.close() }
})

test('a different reservation, action, round or target cannot borrow an old wing lease', async () => {
  for (const mode of ['foreign', 'action', 'round', 'target']) {
    const f = wingFixture()
    if (mode === 'round') f.sw.generation++
    if (mode === 'target') { f.seen[0].id = 'Other'; f.sw.hostile = () => true }
    for (const b of f.bots) {
      if (mode === 'foreign') b.swarmReserved = {}
      if (mode === 'action') b.last = { ...b.last }
    }
    const tokens = f.bots.map(b => b.swarmReserved)
    try {
      assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false, mode)
      assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0, mode)
      f.bots.forEach((b, i) => assert.equal(b.swarmReserved, tokens[i], mode))
    } finally { await f.close() }
  }
})

test('flying wind admission still preserves general reservations, defence, recovery and fresh panic', async () => {
  for (const mode of ['reserved', 'defence', 'climbing', 'web', 'combo', 'flee', 'rearm', 'shove', 'panic']) {
    const f = fixture()
    for (const b of f.bots) {
      f.sw.pos[b.name].gliding = true; b.last = { m: 'wing_orbit', pending: true }
      if (mode === 'reserved') b.swarmReserved = {}
      if (mode === 'defence') b.maceDefense = { until: 100001 }
      if (mode === 'climbing') b.climbing = true
      if (mode === 'web') b.webRescue = true
      if (mode === 'combo') f.sw.pos[b.name].combo = {}
      if (mode === 'flee') b.swarmTask = { kind: 'flee' }
      if (mode === 'rearm') b.swarmTask = { kind: 'fight', data: { rearm: true } }
      if (mode === 'shove') b.swarmTask = { kind: 'fight', data: { shove: true } }
    }
    if (mode === 'panic') f.sw.panic = () => true
    assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false, mode)
    assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0, mode)
  }
})

test('a fresh enemy report dispatches distinct throwers on shared ticks without stopping their fights', async () => {
  const f = fixture(), result = await f.api.windObserve(f.bots[0], f.seen, 100000)
  assert.equal(result, true)
  const shots = f.calls.filter(c => c.method === 'wind_out')
  assert.equal(shots.length, 2); assert.notEqual(shots[0].name, shots[1].name)
  assert.equal(shots[0].p.plan.shots[1].fireTick - shots[0].p.plan.shots[0].fireTick, 2)
  assert.equal(f.calls.some(c => c.method === 'stop'), false)
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('all three ready throwers reach the native planner and its three-shot reply dispatches unchanged', async () => {
  const f = fixture({ names: ['BlueA', 'BlueB', 'BlueC', 'BlueD'] }), actions = f.bots.map(b => b.last)
  f.sw.pos.BlueD.inv.wind_charge = 0
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
  const query = f.calls.find(c => c.method === 'enemy_wind_plan'), shots = f.calls.filter(c => c.method === 'wind_out')
  assert.equal(query.p.maxShots, 3)
  assert.deepEqual(query.p.throwers.map(r => r.id), ['BlueA', 'BlueB', 'BlueC'])
  assert.equal(query.p.allies.length, 4, 'an uncharged ally remains in the safety reports')
  assert.deepEqual(shots.map(c => c.name), ['BlueA', 'BlueB', 'BlueC'])
  assert.deepEqual(shots[0].p.plan.shots.map(s => s.fireTick), [102, 104, 106])
  assert.ok(shots.every(c => c.p.plan === shots[0].p.plan), 'all executors receive the same certified schedule')
  assert.ok(f.bots.every((b, i) => !b.swarmReserved && b.last === actions[i]))
  assert.equal(f.calls.some(c => c.method === 'stop'), false)
})

test('one or two ready throwers naturally set the offered shot budget', async () => {
  for (const ready of [1, 2]) {
    const f = fixture()
    if (ready === 1) f.sw.pos.BlueB.inv.wind_charge = 0
    assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
    const query = f.calls.find(c => c.method === 'enemy_wind_plan')
    assert.equal(query.p.maxShots, ready)
    assert.equal(query.p.throwers.length, ready)
    assert.equal(f.calls.filter(c => c.method === 'wind_out').length, ready)
    assert.ok(f.bots.every(b => !b.swarmReserved))
  }
})

test('a planner reply exceeding the offered ready-shot budget still cannot dispatch', async () => {
  const f = fixture({ names: ['BlueA', 'BlueB', 'BlueC'] }), original = f.bots[0].c.call
  f.bots[0].c.call = async (method, p) => {
    const result = await original(method, p)
    if (method === 'enemy_wind_plan') result.detail.plan.shots.push({ ...result.detail.plan.shots[0] })
    return result
  }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0)
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('active defensive actions are neither reserved nor cancelled for wind out', async () => {
  const f = fixture({ defence: true })
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false)
  assert.equal(f.calls.length, 0)
})

test('wind preflight without an enemy or charges does not prime the strategic panic cache', async () => {
  for (const noCharges of [false, true]) {
    const f = fixture(), panic: string[] = []
    f.sw.panic = b => { panic.push(b.name); return false }
    if (noCharges) for (const b of f.bots) f.sw.pos[b.name].inv.wind_charge = 0
    assert.equal(await f.api.windObserve(f.bots[0], noCharges ? f.seen : [], 100000), false)
    assert.deepEqual(panic, [], 'an unused wind opportunity must not cache a strategic safety verdict')
    assert.equal(f.calls.length, 0)
  }
})

test('wind preflight evaluates panic only for selected charged throwers at dispatch', async () => {
  const f = fixture(), panic: string[] = []
  f.sw.pos.BlueB.inv.wind_charge = 0
  f.sw.panic = b => { panic.push(b.name); return false }
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
  assert.deepEqual(panic, ['BlueA'])
  assert.equal(f.calls.filter(c => c.method === 'wind_report' && !c.p.coordination).length, 2, 'uncharged allies still provide friendly safety reports')
  assert.deepEqual(f.calls.filter(c => c.method === 'wind_out').map(c => c.name), ['BlueA'])
})

test('fresh panic during native planning prevents dispatch without leaving reservations', async () => {
  const f = fixture(); f.blockPlan()
  const first = f.api.windObserve(f.bots[0], f.seen, 100000)
  for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r))
  f.sw.panic = () => true
  f.releasePlan()
  assert.equal(await first, false)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0)
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('a cold or delayed plan is replanned with measured lead instead of firing its expired ticks', async () => {
  const f = fixture({ planDelay: 250 })
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
  const queries = f.calls.filter(c => c.method === 'enemy_wind_plan')
  assert.equal(queries.length, 2); assert.ok(queries[1].p.leadTicks > queries[0].p.leadTicks)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 2)
})

test('the next team observation starts with its measured planner latency', async () => {
  const f = fixture({ planDelay: 250 })
  const [observer, nextObserver] = f.bots
  await f.api.windObserve(observer, f.seen)
  const before = f.calls.filter(c => c.method === 'enemy_wind_plan')
  assert.equal(before.length, 2)

  const moved = [{ ...f.seen[0], position: { ...f.seen[0].position, x: 7.1 } }]
  await f.api.windObserve(nextObserver, moved)
  const next = f.calls.filter(c => c.method === 'enemy_wind_plan')[2]
  assert.ok(next)
  assert.ok(next.p.leadTicks >= 5, `the next observer forgot the measured latency: ${next.p.leadTicks} ticks`)

  f.sw.generation++
  await f.api.windObserve(nextObserver, moved)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').at(-1).p.leadTicks, 2, 'a new round starts without stale latency')
})

test('a cold planning deadline retries with fresh reports and its measured planning cost', async () => {
  for (const planDelay of [80, 150, 200]) {
    const f = fixture({ planDelay, planFailures: ['planning_deadline'] })
    assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), true)
    const queries = f.calls.filter(c => c.method === 'enemy_wind_plan')
    assert.equal(queries.length, 2)
    assert.equal(queries[0].p.leadTicks, 2)
    assert.equal(queries[1].p.leadTicks, Math.ceil(planDelay / 50) + 1)
    assert.ok(queries[1].p.throwers.every(r => r.gameTick === 100 + Math.floor(planDelay / 50)), 'the retry owns fresh reports, not expired snapshots')
    assert.equal(f.calls.filter(c => c.method === 'wind_report' && !c.p.coordination).length, 4)
    assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 2)
    assert.ok(f.bots.every(b => !b.swarmReserved))
  }
})

test('deadline retries remain bounded and release their pending team state after exhaustion or round change', async () => {
  const f = fixture({ planDelay: 150, planFailures: ['planning_deadline', 'planning_deadline'] })
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 2)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0)
  assert.ok(f.bots.every(b => !b.swarmReserved))
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, f.sw.now()), true, 'an exhausted search leaves the next independent opportunity available')
  const changed = fixture({ planDelay: 150, planFailures: ['planning_deadline'] }); changed.resetDuringPlan()
  assert.equal(await changed.api.windObserve(changed.bots[0], changed.seen, 100000), false)
  assert.equal(changed.calls.filter(c => c.method === 'enemy_wind_plan').length, 1)
})

test('non-deadline plan failures do not trigger a cold retry', async () => {
  for (const why of ['no_useful_native_chain', 'invalid_or_stale_reports', 'target_not_visible', 'pending_wind_observation', 'clock_sync_changed']) {
    const f = fixture({ planDelay: 150, planFailures: [why] })
    assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false, why)
    assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 1, why)
    assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0, why)
    assert.ok(f.bots.every(b => !b.swarmReserved))
  }
})

for (const fresh of [true, false]) test(`a confirmed old ally report triggers one full refresh (${fresh ? 'updated' : 'missing'})`, async () => {
  const f = fixture({ planFailures: ['invalid_or_stale_reports'] }), [observer, ally] = f.bots
  const call = ally.c.call
  let reads = 0
  ally.c.call = async (method, p) => {
    const reply = await call(method, p)
    if (method !== 'wind_report' || p.coordination) return reply
    if (++reads === 1) return { detail: { ...reply.detail, gameTick: 78, report: { ...reply.detail.report, gameTick: 78 } } }
    return fresh ? reply : { detail: { ok: false } }
  }
  assert.equal(await f.api.windObserve(observer, f.seen), fresh)
  const queries = f.calls.filter(c => c.method === 'enemy_wind_plan')
  assert.deepEqual(queries.map(q => q.p.allies.map(r => [r.id, r.gameTick])),
    [[['BlueA', 100], ['BlueB', 78]], ...(fresh ? [[['BlueA', 100], ['BlueB', 100]]] : [])])
  assert.equal(f.calls.filter(c => c.method === 'wind_report' && !c.p.coordination).length, 4)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, fresh ? 2 : 0)
})

test('an already gliding free wind escort needs no takeoff rocket while ground and protected owners retain their gates', async () => {
  for (const state of ['gliding', 'ground', 'no_elytra', 'fly_to', 'climbing', 'reserved', 'defence', 'panic']) {
    const f = fixture(); f.sw.arena.y = 64; f.sw.boardOf = () => ({ enemies: () => f.seen })
    for (const b of f.bots) {
      Object.assign(f.sw.pos[b.name], { gliding: state !== 'ground' })
      Object.assign(f.sw.pos[b.name].inv, { elytra: state === 'no_elytra' ? 0 : 1, firework_rocket: 0 })
      b.last = { m: state === 'fly_to' ? 'fly_to' : 'goto', pending: state === 'fly_to' }
      if (state === 'climbing') b.climbing = true
      if (state === 'reserved') b.swarmReserved = {}
      if (state === 'defence') b.maceDefense = { until: 100001 }
      const original = b.c.call
      b.c.call = async (method, p) => {
        if (method !== 'wing_orbit') return original(method, p)
        f.calls.push({ name: b.name, method, p }); return { detail: { ok: true } }
      }
    }
    if (state === 'panic') f.sw.panic = () => true
    arenaWrappers(f)
    f.api.windWing(f.bots[0], [{ ...f.seen[0], airborne: true }])
    assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, state === 'gliding' ? 1 : 0, state)
    await settleWind(); await settleWind()
    assert.ok(f.bots.every(b => state === 'reserved' || !b.swarmReserved))
  }
})

test('a free pearl popper sees an observed offhand charge without an inventory count', async () => {
  for (const state of ['offhand', 'inventory', 'none', 'shield', 'protected', 'gliding', 'gliding_reserved', 'gliding_defence', 'gliding_fly_to']) {
    const f = fixture(); f.sw.arena.y = 64; f.sw.boardOf = () => ({ enemies: () => [] })
    for (const b of f.bots) {
      f.sw.pos[b.name] = { p: { x: 45, y: 64, z: 0 }, inv: { wind_charge: state === 'inventory' ? 1 : 0 }, gliding: state.startsWith('gliding'),
        offHand: { item: state === 'offhand' || state === 'protected' || state.startsWith('gliding') ? 'wind_charge' : 'shield', count: 1 } }
      b.last = { m: state === 'gliding_fly_to' ? 'fly_to' : 'goto', pending: state === 'gliding_fly_to' }
      if (state === 'protected' || state === 'gliding_defence') b.maceDefense = { until: 100001 }
      if (state === 'gliding_reserved') b.swarmReserved = {}
      const original = b.c.call
      b.c.call = async (method, p) => {
        if (method !== 'pearl_pop') return original(method, p)
        f.calls.push({ name: b.name, method, p }); return { detail: { ok: true } }
      }
    }
    f.api.pearlObserve(f.bots[0], [{ id: 99, owner: 'Red', at: { x: 0, y: 64, z: 0 }, eta: 80 }])
    assert.equal(f.calls.filter(c => c.method === 'pearl_pop').length, state === 'offhand' || state === 'inventory' || state === 'gliding' ? 2 : 0, state)
    await settleWind()
  }
})

test('round changes invalidate pending plans and leave no reservations', async () => {
  const f = fixture(); f.resetDuringPlan()
  assert.equal(await f.api.windObserve(f.bots[0], f.seen, 100000), false)
  assert.equal(f.calls.filter(c => c.method === 'wind_out').length, 0)
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('a stationary scene is priced once; changed enemy motion or allied positions permit a new native plan', async () => {
  const f = fixture({ noPlan: true })
  await f.api.windObserve(f.bots[0], f.seen, 100000)
  for (let i = 0; i < 30; i++) await f.api.windObserve(f.bots[i % 2], f.seen, 100000)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 1)
  f.seen[0].velocity.y = -.2; await f.api.windObserve(f.bots[0], f.seen, 100000)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 2)
  f.sw.pos.BlueB.p.x = 1; await f.api.windObserve(f.bots[0], f.seen, 100000)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 3)
})

test('overlapping reports share one pending team chain and release it after completion', async () => {
  const f = fixture(); f.blockPlan()
  const first = f.api.windObserve(f.bots[0], f.seen, 100000)
  for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r))
  assert.equal(await f.api.windObserve(f.bots[1], f.seen, 100000), false)
  f.releasePlan(); assert.equal(await first, true)
  assert.equal(f.calls.filter(c => c.method === 'enemy_wind_plan').length, 1)
})

test('arena wrappers keep the movement owner for wind radio and beside throws; reports remain available during digging', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'farm/arena/watch.ts'), 'utf8')
  const climb = vm.runInNewContext(source.match(/const CLIMB_OK = (\/[^\n]+\/)/)![1])
  const passive = vm.runInNewContext(source.match(/const action = (\/[^\n]+\/)\.test\(m\)/)![1])
  for (const method of ['wind_report', 'enemy_wind_plan', 'wind_out']) assert.equal(passive.test(method), true, method + ' must not replace the pending fight/defence')
  for (const method of ['wind_report', 'enemy_wind_plan']) assert.equal(climb.test(method), true, method + ' is a read-only report')
  assert.equal(climb.test('wind_out'), false, 'a beside throw cannot interrupt a dig hand action')
  assert.equal(passive.test('fight'), false); assert.equal(passive.test('swarm_hold'), false)
})

test('a free gliding spear fighter can follow a recently wind-hit enemy without holding a charge', async () => {
  for (const mode of ['follow', 'untouched', 'grounded target', 'gliding target', 'grounded helper', 'no spear']) {
    const f = fixture(), helper = f.bots[0], report = f.sw.pos[helper.name]
    for (const body of f.bots) f.sw.pos[body.name].inv = {}
    f.sw.arena.y = 64
    f.sw.boardOf = () => ({ enemies: () => f.seen })
    helper.last = { m: 'goto', pending: false }
    report.armor = { torso: 'elytra' }; report.gliding = mode !== 'grounded helper'
    report.inv = { firework_rocket: 4, netherite_spear: mode === 'no spear' ? 0 : 1 }
    helper.c.call = async (method, p) => { f.calls.push({ method, p }); return { detail: { ok: true } } }
    f.api.windWing(helper, [{ ...f.seen[0], airborne: mode !== 'grounded target', gliding: mode === 'gliding target', windAffected: mode !== 'untouched' }])
    await settleWind()
    assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, mode === 'follow' ? 1 : 0, mode)
  }
})
