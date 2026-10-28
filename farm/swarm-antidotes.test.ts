import test from 'node:test'
import assert from 'node:assert/strict'
import { antidoteDeliveryValue } from './swarm/swarm-driver/antidotes'
import { withOffHand } from './swarm/swarm-driver/common'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { swarmPosition } from './swarm/swarm-driver/position'
import { SwarmBoard, planTransfers } from '../daemon/src/swarm'
import { antidoteExchange } from '../daemon/src/swarm/antidotes'

function fixture() {
  const report = (poison: boolean) => ({ receivedAt: 1000, using: false, state: {
    health: 20, damagePerTick: 0, effects: poison ? [{ name: 'poison', amplifier: 1, remainingTicks: 600 }] : [],
    inventory: { honey_bottle: poison ? 0 : 2, milk_bucket: 0 }
  } })
  const members: any[] = ['A', 'B'].map((id, i) => ({ id, team: 'blue', health: 20, strength: 20,
    position: { x: i * 2, y: 64, z: 0 }, inventory: { honey_bottle: i ? 0 : 2 }, antidote: report(!!i) }))
  const bots: any[] = members.map(m => ({ name: m.id }))
  const sw: any = { now: () => 1000, bots, teamOf: () => 'blue', alive: () => true, panic: () => false,
    pos: Object.fromEntries(members.map(m => [m.id, { p: m.position, hp: m.health, inv: m.inventory, antidote: m.antidote }])) }
  return { sw, members, bots }
}

function deliveryFixture() {
  const f = fixture(), calls: string[] = [], [donor, recipient] = f.bots
  for (const member of f.members) member.role = 'fighter'
  f.sw.pos.B.p = { x: 4.29, y: 64, z: 0 }; f.members[1].position = f.sw.pos.B.p
  const board = new SwarmBoard('blue', () => f.sw.now(), 8000)
  const status = name => ({ state: { pos: f.sw.pos[name].p, inventory: { ...f.sw.pos[name].inv }, antidote: f.sw.pos[name].antidote } })
  donor.c = { async call(method, params) {
    calls.push(`A:${method}`)
    if (method === 'status') return status('A')
    assert.equal(method, 'assist'); assert.equal(params.mode, 'toss')
    f.sw.pos.A.inv.honey_bottle--; return { ok: true }
  } }
  recipient.c = { async call(method, params) {
    calls.push(`B:${method}`)
    if (method === 'status') return status('B')
    if (method === 'antidote_pause') return { ready: true }
    assert.equal(method, 'assist'); assert.equal(params.mode, 'pickup')
    f.sw.pos.B.inv.honey_bottle++; return { ok: true }
  } }
  Object.assign(f.sw, { generation: 1, transfers: new Map(), fighting: () => true, blocked: () => false,
    telemetry: { transfers: 0 }, detail: r => r.detail ?? r, log() {}, failed() {}, cleared() {}, lootArena: () => undefined,
    renew: (b, actor, claim) => b.renew(claim.id, actor.name, claim.claim.token, 45000),
    async go(actor, target) { calls.push('A:go'); f.sw.pos.A.p = { ...target, x: target.x - 2 }; return { status: 'arrived' } } })
  const plan = () => {
    for (const member of f.members) {
      const quote = antidoteExchange(member, f.sw.now(), ['honey_bottle'])
      member.needs = quote.needs; member.reserve = quote.reserve
    }
    const tasks = planTransfers(board, f.members, (a, b, item) => antidoteDeliveryValue(f.sw, a.id, b.id, item, f.members) > 0)
    f.sw.transfers.set('blue', tasks); return tasks
  }
  return { ...f, donor, recipient, board, calls, plan }
}

test('priced far antidote delivery goes through the real transfer planner and approach before toss, pickup and inventory acknowledgement', async () => {
  const f = deliveryFixture(), tasks = f.plan()
  assert.equal(tasks.length, 1)
  assert.equal(await swarmPosition(f.sw).transfer(f.donor, { members: f.members, board: f.board }), true)
  assert.ok(f.calls.indexOf('A:go') >= 0 && f.calls.indexOf('A:go') < f.calls.indexOf('A:assist'))
  assert.ok(f.calls.indexOf('A:assist') < f.calls.indexOf('B:assist'))
  assert.equal(f.sw.pos.A.inv.honey_bottle, 1); assert.equal(f.sw.pos.B.inv.honey_bottle, 1)
  assert.equal(f.sw.telemetry.transfers, 1); assert.equal(f.board.tasks()[0].status, 'done')
  assert.equal(f.recipient.swarmReserved, undefined)
})

test('far delivery still declines an expired effect, expensive lost combat opportunity, or the donors last needed dose', () => {
  for (const change of [
    f => { f.sw.now = () => 40000 },
    f => { f.sw.pos.B.antidote.state.damagePerTick = 10 },
    f => { f.sw.pos.A.antidote.state.effects = f.sw.pos.B.antidote.state.effects; f.sw.pos.A.inv.honey_bottle = 1 }
  ]) {
    const f = deliveryFixture(); change(f)
    assert.equal(f.plan().length, 0); assert.deepEqual(f.calls, [])
  }
})

test('recipient first-life death during the real approach prevents toss and releases the transfer claim', async () => {
  const f = deliveryFixture(), tasks = f.plan(); assert.equal(tasks.length, 1)
  const go = f.sw.go
  f.sw.go = async (...args) => { const result = await go(...args); f.sw.alive = name => name !== 'B'; return result }
  assert.equal(await swarmPosition(f.sw).transfer(f.donor, { members: f.members, board: f.board }), false)
  assert.ok(f.calls.includes('A:go')); assert.ok(!f.calls.includes('A:assist'))
  assert.equal(f.recipient.swarmReserved, undefined); assert.equal(f.board.tasks()[0].status, 'pending')
})

test('an approach receipt without actual close coordinates cannot bypass the execution toss range', async () => {
  const f = deliveryFixture(); assert.equal(f.plan().length, 1)
  f.sw.go = async () => { f.calls.push('A:go'); return { status: 'arrived' } }
  assert.equal(await swarmPosition(f.sw).transfer(f.donor, { members: f.members, board: f.board }), false)
  assert.ok(f.calls.includes('A:go')); assert.ok(!f.calls.includes('A:assist'))
  assert.equal(f.sw.pos.A.inv.honey_bottle, 2); assert.equal(f.sw.telemetry.transfers, 0)
  assert.equal(f.recipient.swarmReserved, undefined); assert.equal(f.board.tasks()[0].status, 'pending')
})

test('nearby spare honey is worth delivering for an aged, active poison receipt', () => {
  const f = fixture()
  assert.ok(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members) > 0)
  assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'diamond_sword', f.members), 0)
  f.sw.now = () => 40000
  assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members), 0)
})

test('emergency antidote delivery keeps physical rescue, drink and life guards', () => {
  for (const mutate of [
    (f: any) => { f.sw.pos.A.rescuing = true },
    (f: any) => { f.sw.pos.B.rescuing = true },
    (f: any) => { f.sw.pos.B.antidote.using = true },
    (f: any) => { f.sw.alive = (id: string) => id !== 'A' },
    (f: any) => { f.bots[1].last = { m: 'lava_escape', pending: true } },
    (f: any) => { f.bots[0].last = { m: 'clear_web', pending: true } },
    (f: any) => { f.bots[0].last = { m: 'antidote', pending: true } },
    (f: any) => { f.bots[1].last = { m: 'antidote', pending: true } },
    (f: any) => { f.bots[1].shieldHold = true; f.bots[1].last = { m: 'swarm_hold', pending: true } }
  ]) {
    const f = fixture(); mutate(f)
    assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members), 0)
  }
})

test('a donor keeps its own antidote and a recipient with a dose needs no emergency delivery', () => {
  const f = fixture()
  f.sw.pos.A.antidote.state.effects = f.sw.pos.B.antidote.state.effects
  f.sw.pos.A.inv.honey_bottle = 1
  assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members), 0)
  f.sw.pos.A.inv.honey_bottle = 2
  f.sw.pos.B.inv.honey_bottle = 1
  assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members), 0)
  f.sw.pos.B.inv.honey_bottle = 0
  f.sw.pos.B.antidote.state.inventory.honey_bottle = 1
  assert.equal(antidoteDeliveryValue(f.sw, 'A', 'B', 'honey_bottle', f.members), 0, 'own dose receipt also includes the offhand')
})

test('milk in the offhand remains available to the team without treating other buckets as antidotes', () => {
  assert.equal(withOffHand({ milk_bucket: 1 }, { item: 'milk_bucket', count: 1 }).milk_bucket, 2)
  assert.equal(withOffHand({}, { item: 'water_bucket', count: 1 }).water_bucket, undefined)
})

test('recovery uses the real antidote RPC and keeps ordinary recovery after a refusal', async () => {
  for (const consumed of [true, false]) {
    const calls: any[] = [], at = { x: 0, y: 64, z: 0 }
    const b = { name: 'B', c: { async call(method: string, params: any) { calls.push({ method, params }); return { consumed } } } }
    const sw: any = { generation: 1, alive: () => true, arena: {}, detail: (r: any) => r }
    await swarmTurnTasks(sw).turnRecover({ b, round: 1, context: { members: [{ id: 'B' }, { id: 'C' }] },
      board: {}, member: {}, m: { p: at }, enemies: [{ id: 'E' }],
      task: { data: { doctrine: 'ring', antidote: { item: 'honey_bottle', cover: 'C' } }, position: at } })
    assert.deepEqual(calls.map(x => x.method), consumed ? ['antidote'] : ['antidote', 'eat'])
    assert.deepEqual(calls[0].params.allies, ['B', 'C'])
    assert.deepEqual(calls[0].params.enemies, ['E'])
    assert.equal(calls[0].params.cover, 'C')
  }
})

test('a cancelled recovery cannot start eating after a late antidote refusal', async () => {
  const calls: string[] = [], b: any = { name: 'B', swarmTurnOwner: { cancelled: false } }
  b.c = { async call(method: string) { calls.push(method); b.swarmTurnOwner.cancelled = true; return { consumed: false } } }
  const sw: any = { generation: 1, alive: () => true, detail: (r: any) => r }
  await swarmTurnTasks(sw).turnRecover({ b, round: 1, context: { members: [] }, board: {}, member: {},
    m: {}, enemies: [], task: { data: { antidote: { item: 'milk_bucket' } } } })
  assert.deepEqual(calls, ['antidote'])
})

test('delivery asks the body atomically before pausing a recipient with a stale idle report', async () => {
  const f = fixture(), calls: string[] = []
  const [donor, recipient] = f.bots
  recipient.c = { async call(method: string) { calls.push(method); return { detail: { ready: false, why: 'drinking' } } } }
  const task = { id: 'antidote-delivery', assignedTo: 'A', data: { recipient: 'B', item: 'honey_bottle', count: 1, reserve: 0 } }
  let acknowledgements = 0
  const board: any = { enemies: () => [], claim: () => ({ claim: { token: 'owned' } }),
    release() {}, ack() { acknowledgements++; return true } }
  Object.assign(f.sw, { generation: 1, transfers: new Map([['blue', [task]]]), fighting: () => false,
    blocked: () => false, telemetry: { transfers: 0 }, detail: (r: any) => r.detail ?? r,
    log() {}, failed() {}, cleared() {} })
  assert.equal(await swarmPosition(f.sw).transfer(donor, { members: f.members, board }), false)
  assert.deepEqual(calls, ['antidote_pause'])
  assert.equal(recipient.swarmReserved, undefined)
  assert.equal(acknowledgements, 0)
})
