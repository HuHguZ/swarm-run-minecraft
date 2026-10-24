import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmPosition } from './swarm/swarm-driver/position'

test('the existing pair coordinator carries spear combat through shared ticks and acknowledges only both physical receipts', async () => {
  for (const confirmed of [false, true]) {
    const calls: any[] = [], acknowledgements: any[] = []
    let completeReceiver: (r: any) => void, started = false, prepared = false
    const b: any = { name: 'A', c: { call: async (method, params) => {
      calls.push({ who: 'A', method, params })
      assert.equal(method, 'wind_report'); assert.ok(started && prepared)
      return { detail: { ok: true, executed: 1, plan: { spear: { price: { setupTicks: 10 } }, progress: { startTick: params.startTick, executed: 1 } } } }
    } } }
    const thrower: any = { name: 'B', c: { call: async method => method === 'status' ? { detail: { physics: { onGround: true, pos: { x: -2, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, attributes: {} } } } : {} } }
    const board = { upsert() {}, claim: () => ({ claim: { token: 'claim' } }), ack: (...args) => acknowledgements.push(args), release() {}, cancel() {} }
    const sw: any = { now: () => 1000, bots: [b, thrower], pos: { A: { p: { x: 0, y: 1, z: 0 } }, B: { p: { x: -2, y: 1, z: 0 }, inv: { wind_charge: 1 } } },
      arena: { x: 0, z: 0, r: 30 }, alive: () => true, teamOf: () => 'blue', fighting: () => false, panic: () => false, renew: () => true, log() {}, detail: r => r?.detail,
      execute: async (who, method, params) => {
        calls.push({ who: who.name, method, params })
        if (params.dryRun) return method === 'wind_receive' ? { plan: { spear: { price: { setupTicks: 10 } } }, gameTick: 500 } : { ok: true, gameTick: 501 }
        if (params.prepareOnly) { prepared = true; return { ok: true, gameTick: 501 } }
        if (method === 'wind_receive') { started = true; return new Promise(resolve => { completeReceiver = resolve }) }
        assert.ok(params.plan.progress?.executed >= 1, 'dry ACK cannot authorize a throw before actual receiver progress')
        completeReceiver({ ok: true, received: true, combat: { hit: true }, at: { x: 5, y: 6, z: 0 } })
        return { ok: confirmed, fired: true, launchConfirmed: confirmed }
      } }
    const result = await swarmPosition(sw).pairedWind(b, { board }, { x: 5, y: 6, z: 0 }, { enemy: 'Foe', incomingDps: 2 })
    assert.equal(!!result, confirmed)
    assert.equal(calls[0].params.enemy, 'Foe'); assert.equal(calls[0].params.incomingDps, 2)
    const sends = calls.filter(c => /^(wind_receive|wind_boost)$/.test(c.method) && !c.params.dryRun && !c.params.prepareOnly)
    assert.equal(sends.length, 2); assert.ok(sends.every(c => c.params.startTick === 511))
    assert.equal(sends[0].params.enemy, 'Foe')
    assert.ok(calls.findIndex(c => c.method === 'wind_report') < calls.findIndex(c => c.method === 'wind_boost' && c.params.plan.progress))
    assert.equal(acknowledgements[0][2].confirmed, confirmed)
    assert.equal(thrower.swarmReserved, undefined)
  }
})


test('a bounded failed combat proposal leaves its helper working and retries exhausted search only after world signature changes', async () => {
  for (const partial of [false, true]) {
    let queries = 0, stops = 0, claims = 0
    const failures = new Map(), b: any = { name: 'A' }, thrower: any = { name: 'B', c: { call: async method => {
      if (method === 'stop') stops++
      return { detail: { physics: { onGround: true, pos: { x: -2, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, attributes: {} } } }
    } } }
    const sw: any = { now: () => 1000, bots: [b, thrower], pos: { A: { p: { x: 0, y: 1, z: 0 }, inv: { netherite_spear: 1 } }, B: { p: { x: -2, y: 1, z: 0 }, inv: { wind_charge: 1 } } },
      arena: {}, alive: () => true, teamOf: () => 'blue', fighting: () => false, panic: () => false,
      blocked: (_b, key, signature) => failures.get(key) === signature, failed: (_b, key, signature) => failures.set(key, signature),
      execute: async () => { queries++; return { plan: null, partial } } }
    const board = { upsert() {}, claim() { claims++; return null } }, pair = swarmPosition(sw).pairedWind
    await pair(b, { board }, { x: 5, y: 6, z: 0 }, { enemy: 'Foe', incomingDps: 2 })
    await pair(b, { board }, { x: 5, y: 6, z: 0 }, { enemy: 'Foe', incomingDps: 2 })
    assert.equal(queries, partial ? 2 : 1)
    assert.equal(stops, 0); assert.equal(claims, 0); assert.equal(thrower.swarmReserved, undefined)
    await pair(b, { board }, { x: 5, y: 7, z: 0 }, { enemy: 'Foe', incomingDps: 2 })
    assert.equal(queries, partial ? 3 : 2, 'a moved target opens the native search without a timer')
  }
})

test('a delayed own progress report cannot launch after the pair loses its round, claim or rescue ownership', async () => {
  for (const lost of ['round', 'claim', 'receiver-rescue', 'helper-rescue', 'dead']) {
    let finishReceiver: (r: any) => void, claimed = true, living = true, launches = 0
    const b: any = { name: 'A', c: { call: async () => {
      if (lost === 'round') sw.generation++
      if (lost === 'claim') claimed = false
      if (lost === 'receiver-rescue') sw.pos.A.rescuing = true
      if (lost === 'helper-rescue') sw.pos.B.rescuing = true
      if (lost === 'dead') living = false
      return { detail: { ok: true, executed: 1, plan: { progress: { executed: 1 } } } }
    } } }
    const helper: any = { name: 'B', c: { call: async () => ({ detail: { physics: { onGround: true, pos: { x: -2, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, attributes: {} } } }) } }
    const sw: any = { generation: 1, now: () => 1000, bots: [b, helper], pos: { A: { p: { x: 0, y: 1, z: 0 } }, B: { p: { x: -2, y: 1, z: 0 }, inv: { wind_charge: 1 } } },
      arena: {}, alive: () => living, teamOf: () => 'blue', fighting: () => false, panic: () => false, renew: () => claimed, detail: r => r?.detail, log() {},
      execute: async (_who, method, p) => {
        if (p.dryRun) return { plan: { spear: { price: { setupTicks: 10 } } }, gameTick: 500 }
        if (p.prepareOnly) return { ok: true, gameTick: 500 }
        if (method === 'wind_receive') return new Promise(resolve => { finishReceiver = resolve })
        launches++; finishReceiver({ ok: false }); return { ok: false, fired: true }
      } }
    const board = { upsert() {}, claim: () => ({ claim: { token: 'claim' } }), ack() {}, release() {}, cancel() {} }
    const running = swarmPosition(sw).pairedWind(b, { board }, { x: 5, y: 6, z: 0 }, { enemy: 'Foe' })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    finishReceiver({ ok: false }); await running
    assert.equal(launches, 0, lost)
    assert.equal(helper.swarmReserved, undefined)
  }
})
