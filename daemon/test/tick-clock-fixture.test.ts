'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { warmFixture, waitForMob } from '../scenes/infra/try-tick-clock'

function fixture (states) {
  let at = 0; let calls = 0
  return {
    wall: { monotonic: () => at, sleep: async ms => { at += ms } },
    call: async (method, params) => {
      assert.equal(method, 'status')
      assert.equal(params.physics, true)
      const patch = states[Math.min(calls++, states.length - 1)]
      return { state: { dimension: 'overworld', health: 20, food: 20, pos: { x: 2800, y: 200, z: 2800 },
        clock: { running: true, frozen: false, tickRate: 250, lagTicks: patch.lagTicks ?? 0, ticks: calls * 50 }, ...patch },
      detail: { physics: { onGround: patch.onGround ?? true } } }
    }
  }
}

test('warmup waits through startup lag and requires a continuous healthy interval', async () => {
  const f = fixture([{ lagTicks: 80 }, {} as Record<string, any>, {} as Record<string, any>, { health: 17 }, {} as Record<string, any>, {} as Record<string, any>, {} as Record<string, any>, {} as Record<string, any>, {} as Record<string, any>, {} as Record<string, any>])
  const r = await warmFixture(f.call, 250, { wall: f.wall, timeoutMs: 5000 })
  assert.equal(r.status, 'done')
  assert.equal(r.maxLagTicks, 80)
  assert.equal(r.realSeconds, 1.8)
  assert.equal(r.health, 20)
})

test('persistent lag fails warmup and retains the actual lag', async () => {
  const f = fixture([{ lagTicks: 1171 }])
  await assert.rejects(warmFixture(f.call, 250, { wall: f.wall, timeoutMs: 600 }), (error: any) => {
    assert.equal(error.warmup.status, 'failed')
    assert.equal(error.warmup.maxLagTicks, 1171)
    assert.equal(error.warmup.lagTicks, 1171)
    return true
  })
})

test('warmup does not heal or accept a hungry, airborne, or frozen body', async () => {
  for (const patch of [{ health: 17 }, { food: 0 }, { onGround: false },
    { clock: { running: true, frozen: true, tickRate: 250, lagTicks: 0 } }]) {
    const f = fixture([patch])
    await assert.rejects(warmFixture(f.call, 250, { wall: f.wall, timeoutMs: 600 }), /warmup failed/)
  }
})

test('combat starts only after a delayed zombie spawn is observed', async () => {
  let at = 0; let calls = 0
  const wall = { monotonic: () => at, sleep: async ms => { at += ms } }
  const call = async (method, params) => {
    assert.equal(method, 'observe')
    assert.equal(params.radius, 4)
    return { detail: { entities: calls++ < 3 ? [] : [{ name: 'Zombie' }] }, state: { clock: { lagTicks: 17 } } }
  }
  const r = await waitForMob(call, 'zombie', { wall })
  assert.equal(r.status, 'done')
  assert.equal(r.realSeconds, 0.15)
  assert.equal(r.lagTicks, 17)
})

test('missing combat target fails preparation without resummoning it', async () => {
  let at = 0
  const wall = { monotonic: () => at, sleep: async ms => { at += ms } }
  const call = async method => { assert.equal(method, 'observe'); return { detail: { entities: [{ name: 'Zombified Piglin' }] } } }
  await assert.rejects(waitForMob(call, 'zombie', { wall, timeoutMs: 200 }), /not observed within 200 wall ms/)
})
