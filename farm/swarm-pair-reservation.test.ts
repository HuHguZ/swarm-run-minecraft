import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'
import { createDriverState } from './swarm/swarm-driver/state'

function fixture () {
  const stops: Array<(value: any) => void> = []
  const actor: any = { name: 'A' }, helper: any = { name: 'B' }, next: any = { name: 'C' }
  for (const bot of [actor, helper, next]) bot.c = {
    async call (method: string) {
      if (bot === helper && method === 'stop') return new Promise(resolve => stops.push(resolve))
      return { detail: { physics: { onGround: true, pos: { x: 1, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, attributes: {} } } }
    }
  }
  const sw: any = createDriverState({ bots: [actor, helper, next],
    pos: { A: { p: { x: 0, y: 64, z: 0 } }, B: { p: { x: 1, y: 64, z: 0 }, inv: { wind_charge: 4 } }, C: { p: { x: 2, y: 64, z: 0 } } },
    alive: () => true, arena: {}, now: () => 1000, log () {} })
  const cleanup: string[] = []
  const board: any = { upsert () {}, claim: () => ({ claim: { token: 'claim' } }), resetRound () {},
    release (id: string) { cleanup.push(`release:${id}`) }, cancel (id: string) { cleanup.push(`cancel:${id}`) } }
  sw.boards.set('blue', board)
  Object.assign(sw, { retries: new Map(), sites: new Map(), teamOf: () => 'blue', fighting: () => false,
    panic: () => false, renew: () => true,
    execute: async (_bot: any, method: string) => method === 'wind_receive' ? { plan: {}, gameTick: 100 } : { ok: false },
    detail: (r: any) => r?.detail })
  return { actor, helper, next, sw, board, cleanup, stops, pair: swarmPosition(sw).pairedWind }
}

test('a late wind pair releases its own boolean reservation after losing its generation', async () => {
  const f = fixture()
  const pair = f.pair(f.actor, { board: f.board }, { x: 5, y: 70, z: 0 })
  await new Promise(setImmediate)
  assert.equal(f.helper.swarmReserved, true)
  f.sw.generation++
  f.stops[0]({})
  await pair
  assert.equal(f.helper.swarmReserved, undefined)
  assert.equal(f.helper.swarmWindReservation, undefined)
  assert.deepEqual(f.cleanup, [], 'old pair must not release or cancel a task in the new generation')
})

test('an old pair finally cannot clear a fresh reservation after the real round reset', async () => {
  const f = fixture()
  const old = f.pair(f.actor, { board: f.board }, { x: 5, y: 70, z: 0 })
  await new Promise(setImmediate)
  swarmLifecycle(f.sw).reset()
  const fresh = f.pair(f.next, { board: f.board }, { x: 6, y: 70, z: 0 })
  await new Promise(setImmediate)
  assert.equal(f.stops.length, 2)
  const freshOwner = f.helper.swarmWindReservation
  f.stops[0]({})
  await old
  assert.equal(f.helper.swarmReserved, true, 'fresh helper reservation belongs to the second pair')
  assert.equal(f.helper.swarmWindReservation, freshOwner)
  assert.deepEqual(f.cleanup, [], 'the first pair cannot clean the current round board')
  f.stops[1]({})
  await fresh
  assert.equal(f.helper.swarmReserved, undefined)
  assert.equal(f.helper.swarmWindReservation, undefined)
})
