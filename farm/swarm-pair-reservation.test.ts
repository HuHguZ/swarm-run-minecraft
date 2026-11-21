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

test('two throwers cannot book overlapping landings until the first pair leaves its route', async () => {
  const f = fixture(), calls: string[] = []
  const other = { name: 'D', c: { async call(method) { calls.push(method); return {} } } }
  f.sw.bots.push(other); f.sw.pos.D = { p: { x: 2.5, y: 64, z: 0 }, inv: { wind_charge: 1 } }
  const at = { x: 5.5, y: 67, z: .5 }, adjacent = { ...at, x: at.x + .4 }
  const first = f.pair(f.actor, { board: f.board }, at)
  await new Promise(setImmediate)
  try {
    assert.equal(await f.pair(f.next, { board: f.board }, adjacent), false)
    assert.deepEqual(calls, [], 'the second thrower continues working')
  } finally { f.stops[0]({}); await first }
  await f.pair(f.next, { board: f.board }, adjacent)
  assert.deepEqual(calls, ['stop','status'], 'the empty landing can be priced again')
})

for (const end of ['external order', 'wall deadline', 'replaced claim']) test(`a waiting wind pair releases on ${end} while game time is frozen`, async t => {
  const f = fixture()
  let commanded = false, ownClaim = true, wall = 0
  t.mock.method(performance, 'now', () => wall)
  f.sw.commandOwnsMovement = o => o === f.helper && commanded
  f.sw.renew = () => ownClaim
  f.helper.swarmExecuting = true
  const pair = swarmPosition(f.sw).pairedWind(f.actor, { board: f.board }, { x: 5, y: 70, z: 0 })
  await new Promise(setImmediate)
  f.stops[0]({})
  await new Promise(setImmediate)
  if (end === 'replaced claim') ownClaim = false
  else if (end === 'external order') commanded = true
  else wall = 5001
  let timeout: NodeJS.Timeout
  try {
    assert.equal(await Promise.race([pair, new Promise(resolve => { timeout = setTimeout(() => resolve('still reserved'), 1000) })]), false)
    assert.equal(f.helper.swarmReserved, undefined)
    if (end === 'replaced claim') assert.ok(!f.cleanup.some(s => s.startsWith('cancel:')))
  } finally { clearTimeout(timeout); f.helper.swarmExecuting = false; await pair }
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

test('a perch with no personal access uses its priced helper exactly once and respects a new movement order', async () => {
  for (const commanded of [false, true]) {
    const f = fixture(), sw = f.sw, calls: string[] = [], at = { x: 4.5, y: 67, z: .5 }
    let owns = false
    f.helper.c.call = async m => {
      calls.push('helper:' + m)
      return { detail: { physics: { pos: sw.pos.B.p, velocity: { x: 0, y: 0, z: 0 }, onGround: true } } }
    }
    const plan = { target: at, thrower: { id: 'B' } }
    Object.assign(sw, { blocked: () => false, failed() {}, cleared() {}, commandOwnsMovement: o => o === f.helper && owns,
      execute: async (b, m, p) => {
        calls.push(b.name + ':' + m)
        if (m === 'swarm_position') {
          assert.equal(p.windPartner?.id, 'B')
          owns = commanded
          return { observed: true, candidates: [{ at, score: 12, methods: [
            { kind: 'wind', cost: 3, skill: 'wind_receive', plan, params: {} }] }] }
        }
        if (m === 'wind_receive' && p.dryRun) { assert.equal(p.plan, plan); return { plan, gameTick: 100 } }
        if (m === 'wind_boost' && p.dryRun) return { ok: true, gameTick: 101 }
        assert.equal(p.startTick, 141)
        assert.equal(p.plan, plan)
        return { ok: true, at, received: true, launchConfirmed: true }
      } })
    Object.assign(f.board, { enemies: () => [], recordFact() {}, ack() {} })
    const ok = await swarmPosition(sw).positionStep(f.actor, { board: f.board, member: {}, members: [] }, 'ranged')
    assert.equal(!!ok, !commanded)
    assert.equal(calls.filter(m => m === 'helper:stop').length, commanded ? 0 : 1)
    assert.equal(calls.filter(m => m === 'A:wind_receive').length, commanded ? 0 : 2)
    assert.equal(calls.filter(m => m === 'B:wind_boost').length, commanded ? 0 : 2)
    assert.equal(calls.includes('A:wind_leap'), false)
  }
})
