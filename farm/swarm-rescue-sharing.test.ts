import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmPosition } from './swarm/swarm-driver/position'

function fixture() {
  const calls: Array<{ name: string; method: string }> = []
  const bot = (name: string) => ({ name, c: { async call(method: string) { calls.push({ name, method }); return {} } } })
  const actor = bot('A'), other = bot('B'), p = { x: 0, y: 64, z: 0 }
  let claims = 0
  const board = {
    enemies: () => [], upsert() {},
    claim() { claims++; return { claim: { token: 'owned' } } },
    renew: () => false, release() {}, cancel() {}
  }
  const sw: any = { now: () => 1000, generation: 1, bots: [actor, other],
    pos: { A: { p, inv: {}, hp: 20 }, B: { p: { ...p, x: 1 }, inv: { wind_charge: 4 }, hp: 20, rescuing: true } },
    alive: () => true, teamOf: () => 'blue', fighting: () => false, panic: () => false,
    blocked: () => false, lootSafe: () => true, renew: () => false, detail: (r: any) => r,
    transfers: new Map(), telemetry: {}, log() {} }
  return { calls, actor, other, board, sw, claims: () => claims }
}

test('another courier cannot stop a recipient whose own body is rescuing', async () => {
  const f = fixture()
  f.sw.transfers.set('blue', [{ id: 'supply', assignedTo: 'A', data: { recipient: 'B', item: 'cobblestone', count: 1 } }])
  const result = await swarmPosition(f.sw).transfer(f.actor, { board: f.board, members: [] })
  assert.equal(result, false)
  assert.deepEqual(f.calls, [], 'delivery must leave the autonomous rescue running')
  assert.equal(f.claims(), 0, 'a rescuing recipient cannot be reserved for delivery')
})

test('navigation pair cannot stop a rescuing helper before its on-ground preview', async () => {
  const f = fixture()
  const result = await swarmPosition(f.sw).pairedWind(f.actor, { board: f.board }, { x: 0, y: 72, z: 0 })
  assert.equal(result, false)
  assert.deepEqual(f.calls, [], 'non-combat wind pairing must not stop an airborne rescue')
  assert.equal(f.claims(), 0, 'a rescuing helper cannot be reserved for wind setup')
})

test('delivery and navigation can reserve the same helper after its actual rescue status clears', async () => {
  const delivery = fixture()
  delivery.sw.pos.B.rescuing = false
  delivery.sw.transfers.set('blue', [{ id: 'supply', assignedTo: 'A', data: { recipient: 'B', item: 'cobblestone', count: 1 } }])
  await swarmPosition(delivery.sw).transfer(delivery.actor, { board: delivery.board, members: [] })
  assert.deepEqual(delivery.calls, [{ name: 'B', method: 'stop' }]); assert.equal(delivery.claims(), 1)
  const wind = fixture()
  wind.sw.pos.B.rescuing = false
  await swarmPosition(wind.sw).pairedWind(wind.actor, { board: wind.board }, { x: 0, y: 72, z: 0 })
  assert.deepEqual(wind.calls, [{ name: 'B', method: 'stop' }]); assert.equal(wind.claims(), 1)
})
