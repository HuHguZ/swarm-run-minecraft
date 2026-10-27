import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmTurn } from './swarm/swarm-driver/turn'

function fixture () {
  let releaseStop!: (value: any) => void
  const stopped = new Promise(resolve => { releaseStop = resolve })
  const calls: Array<{ bot: string; method: string }> = []
  const at = { x: 5, y: 64, z: 0 }
  const donor: any = { name: 'A', swarmExecuting: true, swarmTurnOwner: { cancelled: false }, swarmTask: { kind: 'goto', data: {} } }
  const recipient: any = { name: 'B' }
  const pos: any = {
    A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { diamond_sword: 1 } },
    B: { p: { x: 1, y: 64, z: 0 }, hp: 20, inv: {} }
  }
  const member = { id: 'B', position: pos.B.p, health: 20, maxHealth: 20, inventory: pos.B.inv, reserve: {} }
  const enemy = { id: 'E', position: { x: 20, y: 64, z: 0 }, seenAt: 1000, equipment: { weapon: 'netherite_sword' } }
  let firstStop = true, received = false, acknowledgements = 0
  for (const bot of [donor, recipient]) bot.c = {
    async call (method: string, params?: any) {
      calls.push({ bot: bot.name, method })
      if (bot === recipient && method === 'stop' && firstStop) { firstStop = false; return stopped }
      if (method === 'status') return { state: { pos: pos[bot.name].p, inventory: { ...pos[bot.name].inv } } }
      if (method === 'assist' && params.mode === 'toss') { pos.A.inv.diamond_sword--; return { ok: true } }
      if (method === 'assist' && params.mode === 'pickup') { pos.B.inv.diamond_sword = 1; received = true; return { ok: true } }
      return {}
    }
  }
  const board: any = {
    enemyTtlMs: 10000, enemies: () => [enemy], claim: () => ({ claim: { token: 'owned' } }), renew: () => true,
    release () {}, recordFact () {}, ack () { acknowledgements++; return true }
  }
  const delivery = { id: 'supply', assignedTo: 'A', data: { recipient: 'B', item: 'diamond_sword', count: 1, reserve: 0 } }
  const sw: any = {
    now: () => 1000, generation: 1, bots: [donor, recipient], pos, alive: () => true, teamOf: () => 'blue',
    fighting: () => false, panic: () => false, blocked: () => false, lootSafe: () => true, lootArena: () => ({}), renew: () => true,
    transfers: new Map([['blue', [delivery]]]), telemetry: { transfers: 0 }, log () {},
    // An exposed long meeting is too risky until the recipient has reached cover.
    travelCost: () => ({ walk: 1000, fly: 1000 }), positionQueries: 0, failed () {}, cleared () {}, detail: (r: any) => r,
    async execute (bot: any, method: string) {
      calls.push({ bot: bot.name, method })
      return method === 'swarm_position'
        ? { observed: true, candidates: [{ score: 1, cover: 1, at, methods: [{ kind: 'walk', skill: 'goto', cost: 1, params: at }] }] }
        : { arrived: at }
    },
    async go (bot: any, to: any) { calls.push({ bot: bot.name, method: 'goto' }); pos[bot.name].p = { ...to }; return { arrived: to } },
    refresh: () => ({ task: { kind: 'recover', data: {}, position: pos.A.p }, member: { id: 'A', health: 1, maxHealth: 20 }, board, members: [member] })
  }
  return { donor, recipient, calls, sw, board, member, releaseStop, received: () => received, acknowledgements: () => acknowledgements }
}

test('accepted courier preemption cannot start recipient positioning after a late stop reply', async () => {
  const f = fixture()
  const delivery = swarmPosition(f.sw).transfer(f.donor, { board: f.board, members: [f.member] })
  await new Promise(setImmediate)
  assert.deepEqual(f.calls, [{ bot: 'B', method: 'stop' }])
  assert.equal(swarmTurn(f.sw).preempt(f.donor), true)
  assert.equal(f.donor.swarmTurnOwner.cancelled, true)
  const before = f.calls.length
  f.releaseStop({ status: 'interrupted' })
  await delivery
  assert.deepEqual(f.calls.slice(before), [], 'the cancelled courier must not position, move or supply its recipient')
  assert.equal(f.recipient.swarmReserved, undefined, 'the old delivery must still release its reservation')
  assert.equal(f.sw.positionQueries, 0)
  assert.equal(f.acknowledgements(), 0)
})

test('current courier can reach cover and complete the same deferred delivery', async () => {
  const f = fixture()
  const delivery = swarmPosition(f.sw).transfer(f.donor, { board: f.board, members: [f.member] })
  await new Promise(setImmediate)
  f.releaseStop({ status: 'done' })
  assert.equal(await delivery, true)
  assert.equal(f.received(), true)
  assert.equal(f.sw.telemetry.transfers, 1)
  assert.equal(f.acknowledgements(), 1)
  assert.equal(f.recipient.swarmReserved, undefined)
  assert.equal(f.calls.some(c => c.bot === 'B' && c.method === 'goto'), true)
})
