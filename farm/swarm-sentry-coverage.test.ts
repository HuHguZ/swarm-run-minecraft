import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmWind } from './swarm/swarm-driver/wind'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'
import { Vec3 } from '../daemon/src/pvp/vec3'
import { swarmSightings } from '../daemon/src/swarm-senses'

// Real sentry/move callbacks; only the RPC boundary is in memory.
function fixture(points: { x: number; z: number }[]) {
  const calls: any[] = [], replies: ((r?: any) => void)[] = []
  let time = 100000
  const bots: any[] = points.map((p, k) => ({ name: `helper${k}`, team: 'red',
    swarmTask: { kind: 'fight', data: { target: 'foe', finishing: true } },
    last: { m: 'goto', pending: true, p: { x: 2.5, y: 1, z: .5, range: .5 } } }))
  const pos = Object.fromEntries(bots.map((b, k) => [b.name, { p: { ...points[k], y: 1 }, hp: 20, inv: { mace: 1, wind_charge: 8 } }]))
  for (const b of bots) b.c = { call(method, params) {
    calls.push({ actor: b.name, method, params })
    const action = method === 'goto' ? (b.last = { m: method, pending: true, p: params }) : null
    return new Promise(resolve => replies.push((r = { status: 'done' }) => { if (action) action.pending = false; resolve(r) }))
  } }
  const sw: any = { bots, pos, generation: 1, now: () => time, alive: () => true, teamOf: b => b.team,
    hostile: (_b, name) => name === 'foe', panic: () => false, log() {},
    arena: { x: .5, y: 1, z: .5, r: 24 }, boardOf: () => ({ enemies: () => [] }) }
  Object.assign(sw, swarmRetry(sw), swarmMoves(sw))
  const sentries = swarmWind(sw).sentries
  return { bots, calls, replies, pos, sw, advance: () => { time += 2100 }, observe: (x = .5, z = .5) => sentries(bots[0], [{ id: 'foe', visible: true, position: { x, y: 1, z } }]),
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

test('a 20-player sentry allocation evaluates personal panic only for actual prospective assignees', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => ({ x: 18.5, z: i / 40 }))), evaluated: string[] = []
  f.sw.panic = b => { evaluated.push(b.name); return false }
  try {
    f.observe()
    assert.equal(f.calls.length, 3)
    assert.deepEqual(evaluated, f.calls.map(c => c.actor))
  } finally { await f.close() }
})

test('an ordinary free helper outside the held ring still adds sentry coverage', async () => {
  const f = fixture([{ x: 18.5, z: .5 }])
  f.bots[0].swarmTask = { kind: 'loot', data: {} }; f.bots[0].last.pending = false
  try { f.observe(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'goto'); assert.equal(f.calls[0].params._hunt, true) }
  finally { await f.close() }
})

for (const owner of ['current weak loot', 'planned loot race', 'native flee']) test(`31k at 32 blocks keeps ${owner} instead of rushing to the 9-block mace post`, async () => {
  const f = fixture([{ x: 32.5, z: .5 }]), b = f.bots[0]
  b.swarmTask = { kind: 'loot', data: { weak: owner === 'current weak loot', lootTier: 3 } }
  if (owner === 'planned loot race') f.sw.planned = new Map([['red', new Map([[b.name, { kind: 'loot', data: { race: true } }]])]])
  if (owner === 'native flee') b.last = { m: 'flee', pending: true }
  try {
    f.observe()
    assert.equal(f.calls.length, 0)
    if (owner === 'native flee') b.last.pending = false
    b.swarmTask.data.weak = false; f.sw.planned?.clear(); f.advance(); f.observe()
    assert.equal(f.calls[0]?.method, 'goto', 'a ready fighter can still take the guard post')
  } finally { await f.close() }
})

for (const opponent of ['NeuroFarm31', 'Human']) test(`team radio only posts mace sentries on a current, accepted, directly visible sighting of ${opponent}`, async () => {
  const f = fixture([{ x: 31.5, z: .5 }, { x: 32.5, z: .5 }]), [witness, guard] = f.bots
  f.pos[witness.name].inv.mace = 0
  const retired = new Set<string>()
  const sw = createDriverState({ ...f.sw, hostile: (_b, id) => id === opponent, alive: id => !retired.has(id), home: () => f.pos[guard.name].p })
  Object.assign(sw, swarmTeam(sw), swarmMoves(sw), swarmRetry(sw), { preempt() {}, panic: () => false })
  sw.sentries = swarmWind(sw).sentries
  const now = sw.now(), player = { id: 2, type: 'player', username: opponent, position: new Vec3(.5, 1, .5), height: 1.8, width: .6, onGround: true }
  let wall = false
  const body = { entity: { position: new Vec3(31.5, 1, .5), onGround: true }, entities: { 2: player }, players: {},
    blockAt(p) { const at = p.floored(), solid = wall && at.x === 15; return { position: at, name: solid ? 'stone' : 'air',
      boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } } }
  const [sight] = swarmSightings(body)
  try {
    sw.observe(witness, [sight], now - 9000)
    assert.equal(f.calls.length, 0, 'the board already discarded this expired status response')
    sw.observe(witness, [sight], now - 3000)
    assert.equal(f.calls.length, 0, 'old memory still helps search but does not direct a new close sentry post')
    wall = true
    const occluded = swarmSightings(body)
    assert.equal(occluded[0].visible, false); assert.equal(occluded[0].nametag, true)
    sw.observe(witness, [...occluded, { ...sight, id: 'neutral' }], now)
    wall = false
    retired.add(witness.name); sw.observe(witness, swarmSightings(body), now)
    assert.equal(f.calls.length, 0, 'a nametag, neutral entity and eliminated observer do not establish a guard post')
    retired.clear(); sw.observe(witness, swarmSightings(body), now)
    assert.deepEqual(f.calls.map(c => [c.actor, c.method]), [[guard.name, 'goto']])
  } finally { await f.close() }
})

test('another witness releases the exact pending guard approach after the flanker receives a retreating loot order', async () => {
  const f = fixture([{ x: 30.5, z: .5 }, { x: 32.5, z: .5 }]), [observer, guard] = f.bots
  f.pos[observer.name].inv.mace = 0
  try {
    f.observe()
    assert.deepEqual(f.calls.map(c => [c.actor, c.method]), [[guard.name, 'goto']])
    f.sw.planned = new Map([['red', new Map([[guard.name, { kind: 'loot', data: { weak: true } }]])]])
    f.advance(); f.observe(); f.advance(); f.observe()
    assert.deepEqual(f.calls.map(c => [c.actor, c.method]), [[guard.name, 'goto'], [guard.name, 'stop']])
  } finally { await f.close() }
})

test('a lone mace guard takes the near open sector without walking across the visible enemy', async () => {
  const f = fixture([{ x: -9, z: 16.5 }])
  try {
    f.observe()
    assert.equal(f.calls.length, 1)
    const { x, z } = f.calls[0].params
    assert.ok(x < .5 && z > .5, `expected the near sector, got ${x},${z}`)
    assert.ok(Math.hypot(x + 9, z - 16.5) < 12)
  } finally { await f.close() }
})

test('a second mace guard fills a distinct sector while the first is still on the way', async () => {
  const f = fixture([{ x: 19.5, z: .5 }, { x: 19.5, z: 1.5 }])
  f.pos.helper1.inv.mace = 0
  try {
    f.observe()
    f.pos.helper1.inv.mace = 1
    f.advance(); f.observe()
    assert.deepEqual(f.calls.map(c => c.actor), ['helper0', 'helper1'])
    assert.notEqual(f.calls[0].params.x, f.calls[1].params.x, 'a pending approach already claims the east sector')
  } finally { await f.close() }
})

test('a guard with a blocked sector can try another and return to the original from a new position', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe()
    f.replies[0]({ status: 'failed', code: 'NO_PATH' }); await new Promise(resolve => setImmediate(resolve))
    f.advance(); f.observe()
    assert.equal(f.calls.length, 2, 'the foe has not moved but the other approaches are open')
    assert.notEqual(f.calls[0].params.x, f.calls[1].params.x)
    f.replies[1]({ status: 'failed', code: 'NO_PATH' }); await new Promise(resolve => setImmediate(resolve))
    f.pos.helper0.p.x += 3
    f.advance(); f.observe()
    assert.equal(f.calls[2]?.params.x, f.calls[0].params.x)
  } finally { await f.close() }
})

test('three unchanged unreachable sectors exhaust the approaches until the guard gains building material', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    for (let i = 0; i < 18; i++) {
      const count = f.calls.length
      f.observe()
      if (f.calls.length > count) f.replies[count]({ status: 'failed', code: 'NO_PATH' })
      await new Promise(resolve => setImmediate(resolve)); f.advance()
    }
    assert.equal(f.calls.length, 3)
    f.pos.helper0.inv.cobblestone = 8; f.observe()
    assert.equal(f.calls[3]?.params.x, f.calls[0].params.x)
  } finally { await f.close() }
})

test('the guard gives up its own approach as soon as personal retreat takes priority', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe(); f.sw.panic = () => true; f.observe()
    assert.deepEqual(f.calls.map(c => c.method), ['goto', 'stop'])
  } finally { await f.close() }
})

test('a blocked finishing chase outside the held ring remains eligible for useful sentry work', async () => {
  const f = fixture([{ x: 18.5, z: .5 }])
  f.bots[0].last = { m: 'goto', pending: false, result: { status: 'failed', detail: { why: 'noPath' } } }
  try { f.observe(); assert.equal(f.calls.length, 1) } finally { await f.close() }
})

test('a long sentry approach budgets the walk and releases its exact goto if the visible foe leaves the post', async () => {
  const f = fixture([{ x: 39.5, z: .5 }])
  try {
    f.observe()
    assert.ok(f.calls[0].params.timeoutSeconds >= 6, '30 blocks take more than five seconds even at a sprint')
    f.advance(); f.observe(.5, 4)
    assert.equal(f.calls.length, 1, 'the post still covers the foe')
    f.advance(); f.observe(-18.5); f.advance(); f.observe(-18.5)
    assert.deepEqual(f.calls.map(c => c.method), ['goto', 'stop'])
  } finally { await f.close() }
})

test('a displaced sentry leaves a replacement shield action in control', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe(); f.bots[0].last = { m: 'swarm_hold', pending: true }
    f.advance(); f.observe(-18.5)
    assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  } finally { await f.close() }
})

test('a native arrival holds the sector between polls and a fresh position releases it', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe()
    const { x, y, z } = f.calls[0].params, arrived = { x, y, z }
    f.replies[0]({ status: 'done', detail: { arrived }, state: { pos: arrived } })
    await new Promise(resolve => setImmediate(resolve)); f.advance(); f.observe()
    assert.equal(f.calls.length, 1)
    f.pos.helper0 = { ...f.pos.helper0, p: { x: -16, y: 1, z: .5 } }
    f.advance(); f.observe()
    assert.equal(f.calls[1]?.method, 'goto')
  } finally { await f.close() }
})

test('an old round or a preflight refusal cannot blacklist a sector or release its new owner', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe()
    f.sw.generation++; delete f.bots[0].swarmReserved; f.observe()
    assert.equal(f.calls.length, 2)
    const owner = f.bots[0].swarmReserved
    f.replies[0]({ status: 'failed', code: 'NO_PATH' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.bots[0].swarmReserved, owner)
    f.replies[1]({ status: 'failed', notStarted: true, code: 'DEFENSE_BUSY' })
    await new Promise(resolve => setImmediate(resolve)); f.advance(); f.observe()
    assert.equal(f.calls[2]?.params.x, f.calls[0].params.x)
  } finally { await f.close() }
})

test('a partial approach can continue towards the same sector after the native walk times out', async () => {
  const f = fixture([{ x: 19.5, z: .5 }])
  try {
    f.observe()
    f.replies[0]({ status: 'done', detail: { stopped: 'time', at: { x: 16, y: 1, z: 0 } }, state: { pos: { x: 16.5, y: 1, z: .5 } } })
    await new Promise(resolve => setImmediate(resolve)); f.advance(); f.observe()
    assert.equal(f.calls[1]?.params.x, f.calls[0].params.x)
  } finally { await f.close() }
})

test('a sentry chooses a post inside the elliptical Colosseum rim', async () => {
  const f = fixture([{ x: -14, z: 9.5 }])
  f.sw.arena.ellipse = { a: 23, b: 12 }
  try {
    f.observe(.5, 8)
    assert.ok(f.calls.length === 1)
    const { x, z } = f.calls[0].params
    assert.ok(Math.hypot((x - .5) / 23, (z - .5) / 12) <= 1)
  } finally { await f.close() }
})

for (const method of ['fight', 'clear_web', 'dodge_blast']) test(`sentry preserves pending ${method} ownership`, async () => {
  const f = fixture([{ x: 18.5, z: .5 }]); f.bots[0].last.m = method
  try { f.observe(); assert.equal(f.calls.length, 0) } finally { await f.close() }
})

test('optional mace sentry does not abandon an achieved upper reserve', async () => {
  const f = fixture([{ x: 18.5, z: .5 }]), at = f.pos[f.bots[0].name].p
  f.bots[0].swarmTask = { kind: 'goto', position: at, data: { reserve: true, sentry: true } }
  f.bots[0].last = { m: 'swarm_hold', pending: true }
  f.sw.arms = true; f.sw.chestTops = [{ ...at, tier: 5 }]
  try { f.observe(); assert.equal(f.calls.length, 0) } finally { await f.close() }
})
