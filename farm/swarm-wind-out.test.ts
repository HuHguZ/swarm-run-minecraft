import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { REPO_ROOT } from '../daemon/src/paths'

function fixture({ planDelay = 0, defence = false, noPlan = false } = {}) {
  let at = 100000, plans = 0, resetDuringPlan = false, gate: (() => void) | undefined
  const calls: any[] = [], pos: any = {}, bots: any[] = []
  const sw: any = { now: () => at, generation: 1, arena: { x: 0, z: 0, r: 10 }, bots, pos,
    alive: () => true, teamOf: b => b.team, hostile: (_b, id) => id === 'Red', panic: () => false,
    log: text => calls.push({ log: text }) }
  for (const name of ['BlueA', 'BlueB']) {
    pos[name] = { p: { x: 0, y: 64, z: 0 }, inv: { wind_charge: 4 } }
    const b: any = { name, team: 'blue', last: defence ? { m: 'lava_escape', pending: true } : { m: 'fight', pending: true } }
    b.c = { call: async (method, p) => {
      calls.push({ name, method, p })
      if (method === 'wind_report') return { detail: { ok: true, ready: true, gameTick: 100 + (at - 100000) / 50,
        report: { id: name, position: pos[name].p, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 100 + (at - 100000) / 50 } } }
      if (method === 'enemy_wind_plan') {
        plans++; const tick = 100 + (at - 100000) / 50
        if (gate) await new Promise<void>(r => { gate = r })
        at += plans === 1 ? planDelay : 0
        if (resetDuringPlan) sw.generation++
        if (noPlan) return { detail: { ok: false, why: 'no_useful_native_chain', gameTick: tick } }
        return { detail: { ok: true, gameTick: tick, plan: { gameTick: tick, target: 'Red', shots: p.throwers.map((r, i) => ({ thrower: r.id, fireTick: tick + p.leadTicks + i * 2, arrivalTick: tick + p.leadTicks + i * 2 + 3 })) } } }
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

test('a fresh enemy report dispatches distinct throwers on shared ticks without stopping their fights', async () => {
  const f = fixture(), result = await f.api.windObserve(f.bots[0], f.seen, 100000)
  assert.equal(result, true)
  const shots = f.calls.filter(c => c.method === 'wind_out')
  assert.equal(shots.length, 2); assert.notEqual(shots[0].name, shots[1].name)
  assert.equal(shots[0].p.plan.shots[1].fireTick - shots[0].p.plan.shots[0].fireTick, 2)
  assert.equal(f.calls.some(c => c.method === 'stop'), false)
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
  assert.equal(f.calls.filter(c => c.method === 'wind_report').length, 2, 'uncharged allies still provide friendly safety reports')
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
