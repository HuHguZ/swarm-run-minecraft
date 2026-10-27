import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmRetry } from './swarm/swarm-driver/retry'

function fixture(why = 'landing_missed') {
  const calls: any[] = []
  const pos: any = { A: { p: { x: 600.5, y: 120, z: 600.5 }, inv: { elytra: 1, firework_rocket: 48 }, armor: {} } }
  const b = { name: 'A', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'fly_to') return { status: 'done', detail: { ok: false, why } }
    if (method === 'status') return { state: { pos: { ...pos.A.p }, inventory: { ...pos.A.inv } } }
    return { status: 'failed', detail: { why: 'No path to goal' } }
  } } }
  const sw: any = { arena: { x: 600, y: 120, z: 600, r: 80 }, pos, generation: 1, alive: () => true, now: () => 1000, log: () => {}, lootSafe: () => true }
  Object.assign(sw, swarmRetry(sw), swarmMoves(sw))
  return { sw, pos, calls, go: at => sw.go(b, at, 2, 4, sw.arena, true), flights: () => calls.filter(c => c.method === 'fly_to') }
}

const first = { x: 800, y: 140, z: 600.5 }, alias = { x: 900, y: 140, z: 600.5 }
for (const why of ['landing_missed', 'гребень выше 48 бл. — не перелететь']) {
  test(`loot flight does not repeat the identical bounded request through another raw alias: ${why}`, async () => {
    const f = fixture(why), origin = { ...f.pos.A.p }
    assert.deepEqual(f.sw.bounded(first), f.sw.bounded(alias), 'both logical targets describe exactly the same RPC destination')
    await f.go(first)
    await f.go(alias)
    assert.deepEqual(f.pos.A.p, origin, 'the failed ground fallback has not moved the launch pose')
    assert.equal(f.pos.A.inv.firework_rocket, 48, 'no fresh resource arrived')
    assert.equal(f.flights().length, 1, 'the same physical request must share its remembered failure')
  })
}

test('a genuinely different bounded destination is still a fresh flight opportunity', async () => {
  const f = fixture()
  await f.go(first)
  await f.go({ x: 600.5, y: 140, z: 900 })
  assert.equal(f.flights().length, 2)
  assert.notDeepEqual(f.flights()[0].params.at, f.flights()[1].params.at)
})

test('the unchanged raw destination remains blocked after its failed flight', async () => {
  const f = fixture()
  await f.go(first)
  await f.go(first)
  assert.equal(f.flights().length, 1)
})

for (const changed of ['rockets', 'launch pose']) test(`a changed ${changed} reopens the same physical flight`, async () => {
  const f = fixture()
  await f.go(first)
  if (changed === 'rockets') f.pos.A.inv.firework_rocket++
  else f.pos.A.p.x += 2.01
  await f.go(first)
  assert.equal(f.flights().length, 2)
  assert.deepEqual(f.flights()[0].params.at, f.flights()[1].params.at)
})
