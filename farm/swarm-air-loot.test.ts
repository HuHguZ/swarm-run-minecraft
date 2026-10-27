import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLoot } from './swarm/swarm-driver/loot'

test('air loot uses flight for roof and distant loot, walks nearby and after landing, and respects interruption', async () => {
  for (const mode of ['roof', 'low-roof', 'roof-failed', 'far', 'near', 'no-rockets', 'failed', 'interrupted', 'reset', 'lease']) {
    let now = 1000
    const roof = mode.includes('roof')
    const calls: any[] = [], target = { x: mode === 'lease' ? 12 : mode === 'near' ? 4 : mode === 'low-roof' ? 0 : 60, y: mode === 'lease' ? 74 : mode === 'low-roof' ? 66 : roof ? 97 : 64, z: 0, climbFrom: 80, tier: 5 }
    const pos: any = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { elytra: 1, firework_rocket: mode === 'no-rockets' ? 1 : 48, cobblestone: mode === 'roof-failed' ? 64 : 0 }, armor: {} } }
    const b = { name: 'A', team: 'blue', c: { async call(method, p: any = {}) {
      calls.push({ method, p })
      if (method === 'fly_to') {
        if (mode === 'lease') now += 24000
        if (mode === 'reset') { sw.generation++; return { status: 'done', detail: { ok: true } } }
        if (mode === 'interrupted') return { status: 'interrupted', detail: { ok: false } }
        if (mode.endsWith('failed')) return { status: 'done', detail: { ok: false, why: 'негде сесть' } }
        pos.A.p = { x: p.at.x - 3, y: p.at.y, z: p.at.z }
        return { status: 'done', detail: { ok: true, walkIn: true } }
      }
      if (method === 'status') return { state: { pos: pos.A.p, inventory: pos.A.inv, armor: {} } }
      if (method === 'blocks_around') return { detail: { found: [target] } }
      if (method === 'chest_take') return { detail: { took: { diamond_boots: 1 } } }
      if (method === 'goto') { if (mode === 'lease') now += 4000; pos.A.p = { x: p.x, y: p.y, z: p.z }; return { status: 'done', detail: { arrived: pos.A.p } } }
      return { detail: {} }
    } } }
    const sw = createDriverState({ bots: [b], pos, alive: () => true, now: () => now, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.A.p, hostile: () => false, log: () => {}, arms: true, chestTops: roof ? [target] : [] })
    Object.assign(sw, swarmRetry(sw))
    Object.assign(sw, swarmTeam(sw))
    Object.assign(sw, swarmMoves(sw))
    Object.assign(sw, swarmLoot(sw))
    sw.boardOf(b).setMembers(sw.membersOf(b))
    if (roof) assert.equal(await sw.tour(b, sw.boardOf(b)), true, 'roof-only tour requires neither pillars nor pearls')
    else if (mode === 'lease') assert.equal(await sw.loot(b, sw.boardOf(b), true), true, 'lease survives landing plus final approach')
    else await sw.go(b, target, 1, 4, sw.arena, true)
    assert.equal(calls.some(c => c.method === 'fly_to'), !['near', 'no-rockets'].includes(mode), mode)
    assert.equal(calls.some(c => c.method === 'goto'), !['interrupted', 'reset'].includes(mode), mode)
    if (roof) assert.ok(sw.toured.get('blue').get(0).done)
    if (mode === 'roof-failed') assert.ok(calls.find(c => c.method === 'goto').p.exactY, 'failed flight preserves the pillar fallback')
    if (mode === 'failed') {
      calls.length = 0
      pos.A.p = { x: 0, y: 64, z: 0 }
      await sw.go(b, target, 1, 4, sw.arena, true)
      assert.equal(calls.some(c => c.method === 'fly_to'), false, 'same failed launch waits for changed state')
    }
  }
})

for (const waitAt of ['fly_to', 'status']) for (const change of ['current', 'cancelled', 'reset', 'dead']) {
  test(`air approach after deferred ${waitAt} respects ${change} ownership before walking or recording failure`, async () => {
    const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done }); return { promise, resolve } }
    const fly = deferred(), state = deferred(), calls: string[] = [], owner = { cancelled: false }
    const from = { x: 0, y: 64, z: 0 }, target = { x: 60, y: 64, z: 0 }, inventory = { elytra: 1, firework_rocket: 16 }
    const updated = { pos: { x: 1, y: 64, z: 0 }, inventory: { elytra: 1, firework_rocket: 15 } }
    let alive = true
    const pos = { A: { p: from, hp: 20, inv: inventory } }
    const b = { name: 'A', swarmTurnOwner: owner, c: { call(method) {
      calls.push(method)
      if (method === 'fly_to') return fly.promise
      if (method === 'status') return state.promise
      assert.equal(method, 'goto')
      return Promise.resolve({ status: 'done', detail: { arrived: target } })
    } } }
    const sw = createDriverState({ bots: [b], pos, alive: () => alive, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => from, log() {} })
    Object.assign(sw, swarmRetry(sw), { lootSafe: () => true })
    Object.assign(sw, swarmMoves(sw))
    const generation = sw.generation, failedFlight = { status: 'done', detail: { ok: false, why: 'landing_missed' } }
    const running = sw.go(b, target, 2, 4, sw.arena, true)
    assert.deepEqual(calls, ['fly_to'])
    if (waitAt === 'status') { fly.resolve(failedFlight); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['fly_to', 'status']) }
    if (change === 'cancelled') owner.cancelled = true
    if (change === 'reset') sw.generation++
    if (change === 'dead') alive = false
    fly.resolve(failedFlight)
    await new Promise(resolve => setImmediate(resolve))
    state.resolve({ state: updated })
    const reply = await running
    if (change === 'current') {
      assert.deepEqual(calls, ['fly_to', 'status', 'goto'], 'a failed current flight keeps its legitimate walking fallback')
      assert.equal(reply.status, 'done'); assert.equal(sw.retries.size, 1)
      assert.deepEqual(pos.A.p, updated.pos); assert.deepEqual(pos.A.inv, updated.inventory)
    } else {
      assert.deepEqual(calls, waitAt === 'fly_to' ? ['fly_to'] : ['fly_to', 'status'], 'an obsolete approach cannot issue the old fallback goto')
      assert.equal(reply.status, 'interrupted'); assert.equal(reply.detail.interrupted, true)
      assert.equal(sw.retries.size, 0, 'accepted cancellation must not poison failure memory')
      assert.equal(pos.A.p, from); assert.equal(pos.A.inv, inventory, 'a late cancelled snapshot cannot overwrite the current inventory')
      if (change === 'cancelled') { assert.equal(sw.generation, generation); assert.equal(alive, true) }
    }
  })
}
