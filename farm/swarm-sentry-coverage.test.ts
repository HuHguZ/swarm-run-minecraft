import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmWind } from './swarm/swarm-driver/wind'
import { swarmMoves } from './swarm/swarm-driver/moves'

// Real sentry/move callbacks; only the RPC boundary is in memory.
function fixture(points: { x: number; z: number }[]) {
  const calls: any[] = [], replies: (() => void)[] = []
  const bots: any[] = points.map((p, k) => ({ name: `helper${k}`, team: 'red',
    swarmTask: { kind: 'fight', data: { target: 'foe', finishing: true } },
    last: { m: 'goto', pending: true, p: { x: 2.5, y: 1, z: .5, range: .5 } } }))
  const pos = Object.fromEntries(bots.map((b, k) => [b.name, { p: { ...points[k], y: 1 }, hp: 20, inv: { mace: 1, wind_charge: 8 } }]))
  for (const b of bots) b.c = { call(method, params) {
    calls.push({ actor: b.name, method, params })
    return new Promise(resolve => replies.push(() => resolve({ status: 'done' })))
  } }
  const sw: any = { bots, pos, generation: 1, now: () => 100000, alive: () => true, teamOf: b => b.team,
    hostile: (_b, name) => name === 'foe', panic: () => false, log() {},
    arena: { x: .5, y: 1, z: .5, r: 24 }, boardOf: () => ({ enemies: () => [] }) }
  Object.assign(sw, swarmMoves(sw))
  const sentries = swarmWind(sw).sentries
  return { bots, calls, pos, observe: () => sentries(bots[0], [{ id: 'foe', visible: true, position: { x: .5, y: 1, z: .5 } }]),
    close: async () => { replies.forEach(reply => reply()); await new Promise(resolve => setImmediate(resolve)) } }
}

test('sentry preserves a sole occupied sector and its active finishing approach', async () => {
  const f = fixture([{ x: 6.5, z: .5 }]), old = f.bots[0].last
  try {
    f.observe()
    assert.equal(f.calls.length, 0, 'moving the only holder into an empty sector adds no coverage and replaces its chase')
    assert.equal(f.bots[0].last, old)
    assert.equal(f.bots[0].swarmReserved, undefined)
  } finally { await f.close() }
})

test('sentry may move one duplicate holder, while the last holder retains the old sector', async () => {
  const f = fixture([{ x: 6.5, z: .5 }, { x: 7.5, z: .5 }])
  try { f.observe(); assert.equal(f.calls.length, 1, 'two holders in one sector can add exactly one new occupied sector') }
  finally { await f.close() }
})

test('sentry can add both missing sectors with a spare holder and a free helper', async () => {
  const f = fixture([{ x: 6.5, z: .5 }, { x: 7.5, z: .5 }, { x: 18.5, z: .5 }])
  try { f.observe(); assert.equal(f.calls.length, 2); assert.equal(new Set(f.calls.map(c => c.actor)).size, 2) }
  finally { await f.close() }
})

test('an ordinary free helper outside the held ring still adds sentry coverage', async () => {
  const f = fixture([{ x: 18.5, z: .5 }])
  f.bots[0].swarmTask = { kind: 'loot', data: {} }; f.bots[0].last.pending = false
  try { f.observe(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'goto'); assert.equal(f.calls[0].params._hunt, true) }
  finally { await f.close() }
})

test('a blocked finishing chase outside the held ring remains eligible for useful sentry work', async () => {
  const f = fixture([{ x: 18.5, z: .5 }])
  f.bots[0].last = { m: 'goto', pending: false, result: { status: 'failed', detail: { why: 'noPath' } } }
  try { f.observe(); assert.equal(f.calls.length, 1) } finally { await f.close() }
})

for (const method of ['fight', 'clear_web', 'dodge_blast']) test(`sentry preserves pending ${method} ownership`, async () => {
  const f = fixture([{ x: 18.5, z: .5 }]); f.bots[0].last.m = method
  try { f.observe(); assert.equal(f.calls.length, 0) } finally { await f.close() }
})
