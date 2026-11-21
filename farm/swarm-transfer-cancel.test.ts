import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { assist } from '../daemon/src/pvp/team-assist'
import { Vec3 } from '../daemon/src/pvp/vec3'
import { swarmRetry } from './swarm/swarm-driver/retry'

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

function lastSteps(gap: number, nativeRefusal = false) {
  const f = fixture(), p = f.sw.pos
  f.board.enemies = () => []
  f.sw.transfers.get('blue')[0].data = { recipient: 'B', item: 'arrow', count: 16, reserve: 2 }
  p.A.inv = { arrow: 18 }; p.B.p = { x: nativeRefusal ? 1 : gap, y: 64, z: 0 }
  f.sw.lootArena = () => ({ x: 0, z: 0, r: 60, killY: 40 })
  f.sw.travelCost = () => ({ walk: 1, fly: Infinity })
  let drops = 0, attempts = 0, onGround = 0
  f.sw.go = async (actor, at) => {
    f.calls.push({ bot: actor.name, method: 'goto' })
    if (actor === f.donor) return { status: 'failed' }
    p.B.p = { x: at.x + 1, y: at.y, z: at.z }
    return { status: 'done' }
  }
  for (const actor of [f.donor, f.recipient]) {
    const raw = actor.c.call
    actor.c.call = async (method, params) => {
      if (method !== 'assist') return raw(method, params)
      if (params.mode === 'toss') {
        attempts++
        if (nativeRefusal && attempts === 1) { p.B.p = { x: gap, y: 64, z: 0 }; return { ok: false, outOfReach: true } }
        assert.ok(Math.abs(p.B.p.x - p.A.p.x) <= 3)
        drops++; p.A.inv.arrow -= params.count; onGround += params.count
      } else { p.B.inv.arrow = (p.B.inv.arrow || 0) + onGround; onGround = 0 }
      return { ok: true }
    }
  }
  return { ...f, drops: () => drops, attempts: () => attempts, start() {
    f.releaseStop({ status: 'done' })
    return swarmPosition(f.sw).transfer(f.donor, { board: f.board, members: [f.member] })
  } }
}

test('the recipient closes a stalled handoff, including a distance rejection before the native drop', async () => {
  for (const [gap, refused] of [[3.2, false], [5.5, true]] as const) {
    const f = lastSteps(gap, refused)
    await f.start()
    assert.equal(f.calls.filter(c => c.bot === 'B' && c.method === 'goto').length, 1)
    assert.equal(f.attempts(), refused ? 2 : 1)
    assert.equal(f.drops(), 1); assert.equal(f.acknowledgements(), 1)
    assert.equal(f.sw.pos.A.inv.arrow, 2); assert.equal(f.sw.pos.B.inv.arrow, 16)
    assert.equal(f.recipient.swarmReserved, undefined)
  }
})

test('the courier fills only the remaining request after the receiver picks up arrows en route', async () => {
  for (const picked of [0, 6, 16]) {
    const f = lastSteps(5.5)
    f.sw.pos.B.inv.arrow = 4 // the order is for 16 additional arrows, even with a starting stock
    const receive = f.recipient.c.call
    f.recipient.c.call = async (method, params) => {
      if (method === 'assist' && params.mode === 'pickup') assert.equal(params.ownedTarget, 20)
      return receive(method, params)
    }
    const walk = f.sw.go
    f.sw.go = async (actor, ...args) => {
      const reply = await walk(actor, ...args)
      if (actor === f.recipient) f.sw.pos.B.inv.arrow += picked
      return reply
    }
    await f.start()
    assert.equal(f.sw.pos.B.inv.arrow, 20)
    assert.equal(f.sw.pos.A.inv.arrow, 18 - (16 - picked))
    assert.equal(f.drops(), picked === 16 ? 0 : 1)
    assert.equal(f.acknowledgements(), f.drops())
    assert.equal(f.sw.telemetry.transfers, f.drops())
  }
})

test('an independent inventory gain after a refused toss is not credited to the donor', async () => {
  const f = lastSteps(1)
  const raw = f.donor.c.call
  f.donor.c.call = async (method, p) => {
    if (method !== 'assist') return raw(method, p)
    f.sw.pos.B.inv.arrow = 16
    return { ok: false, why: 'не вижу его' }
  }
  await f.start()
  assert.equal(f.acknowledgements(), 0); assert.equal(f.sw.telemetry.transfers, 0)
})

test('a released drop cannot take movement from a recipient already escaping danger', async () => {
  for (const received of [true, false]) {
    const f = lastSteps(1)
    const toss = f.donor.c.call, recv = f.recipient.c.call
    let pickups = 0, blocked = 0
    f.sw.failed = () => { blocked++ }
    f.donor.c.call = async (method, params) => {
      const result = await toss(method, params)
      if (params?.mode === 'toss') {
        f.sw.pos.B.rescuing = true
        if (received) f.sw.pos.B.inv.arrow = params.count
      }
      return result
    }
    f.recipient.c.call = (method, params) => {
      if (params?.mode === 'pickup') pickups++
      return recv(method, params)
    }
    await f.start()
    assert.equal(pickups, 0)
    assert.equal(f.acknowledgements(), Number(received))
    assert.equal(blocked, 0)
  }
})

test('a replacement reservation during the pre-drop inventory read keeps the item in the donor bag', async () => {
  const f = lastSteps(1), replacement = {}
  const receive = f.recipient.c.call
  f.recipient.c.call = async (method, params) => {
    const answer = await receive(method, params)
    if (method === 'status') f.recipient.swarmReserved = replacement
    return answer
  }
  await f.start()
  assert.equal(f.drops(), 0)
  assert.equal(f.sw.pos.A.inv.arrow, 18)
  assert.equal(f.recipient.swarmReserved, replacement)
})

test('an old supply stop releases a still-busy recipient when another action owns the reservation', async () => {
  const f = fixture(), other = {}
  f.recipient.swarmExecuting = true
  const job = swarmPosition(f.sw).transfer(f.donor, { board: f.board, members: [f.member] })
  f.recipient.swarmReserved = other
  f.releaseStop({ status: 'done' })
  let settled = false
  void job.then(() => { settled = true })
  try {
    await new Promise(setImmediate)
    assert.equal(settled, true)
    assert.equal(f.recipient.swarmReserved, other)
    assert.equal(f.acknowledgements(), 0)
  } finally {
    f.donor.swarmTurnOwner.cancelled = true
    f.recipient.swarmExecuting = false
    await job
  }
})

test('a receiver stays in cover, out of sight of hostiles, inside the arena and within a short walk', async () => {
  for (const protect of [
    f => { f.recipient.swarmPosition = { cover: 1, at: f.sw.pos.B.p } },
    f => { f.recipient.arrowThreat = { at: 1000, active: true } },
    f => { f.sw.lootSafe = () => false },
    f => { f.sw.lootArena = () => ({ x: 5, z: 0, r: 4 }) },
    f => { f.sw.travelCost = () => ({ walk: 20, fly: 0 }) }
  ]) {
    const f = lastSteps(5.5)
    protect(f)
    await f.start()
    assert.equal(f.calls.some(c => c.bot === 'B' && c.method === 'goto'), false)
    assert.equal(f.drops(), 0); assert.equal(f.acknowledgements(), 0)
    assert.equal(f.recipient.swarmReserved, undefined)
  }
})

test('a cancelled meeting or an ambiguous drop cannot spend the reserve or retry a toss', async () => {
  const f = lastSteps(5.5)
  const walk = f.sw.go
  f.sw.go = async (actor, ...args) => {
    const reply = await walk(actor, ...args)
    if (actor === f.recipient) f.donor.swarmTurnOwner.cancelled = true
    return reply
  }
  await f.start()
  assert.equal(f.attempts(), 0); assert.equal(f.acknowledgements(), 0)
  assert.equal(f.recipient.swarmReserved, undefined)

  const g = lastSteps(1)
  let uncertain = 0
  const raw = g.donor.c.call
  g.donor.c.call = async (method, p) => { if (method === 'assist' && p.mode === 'toss') { uncertain++; throw new Error('lost reply') } return raw(method, p) }
  await g.start()
  assert.equal(uncertain, 1)
  assert.equal(g.calls.some(c => c.bot === 'B' && c.method === 'goto'), false)
  assert.equal(g.acknowledgements(), 0); assert.equal(g.recipient.swarmReserved, undefined)
})

// Match 41, 12:56:41: ac released 13 cobblestone before o found that the pack was full.
function fullBagTransfer (scenario: 'full' | 'partial' | 'exchange' | 'cancel' | 'failedDiscard') {
  const f = fixture(), bag = f.sw.pos, item = scenario === 'exchange' || scenario === 'cancel' || scenario === 'failedDiscard' ? 'diamond_sword' : 'cobblestone'
  const requested = item === 'cobblestone' ? 13 : 1
  const slots: any[] = Array.from({ length: 46 }, (_, slot) => slot >= 9 && slot < 45 ? { slot, name: 'shield', count: 1 } : null)
  if (scenario === 'partial') slots[9] = { slot: 9, name: item, count: 62 }
  if (item === 'diamond_sword') slots[9] = { slot: 9, name: 'rotten_flesh', count: 1 }
  const inv = () => Object.fromEntries([...new Set<string>(slots.filter(Boolean).map(s => s.name))].map(n => [n, slots.filter(s => s?.name === n).reduce((a, s) => a + s.count, 0)]))
  const body = { entity: { position: new Vec3(1, 64, 0), height: 1.8 }, players: { A: { entity: { position: new Vec3(0, 64, 0), height: 1.8 } } },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }),
    inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(x => !x).length },
    async lookAt() {}, async tossStack(s) { if (scenario === 'failedDiscard') throw Error('inventory changed'); slots[s.slot] = null } }
  bag.A.inv = { [item]: requested + 2 }; bag.B.inv = inv()
  f.board.enemies = () => []
  f.sw.transfers.get('blue')[0].data = { item, count: requested, reserve: 2, recipient: 'B', recipientBeforeOwned: bag.B.inv[item] || 0 }
  const tossed: number[] = [], events: string[] = []
  let onGround = 0
  for (const actor of [f.donor, f.recipient]) actor.c.call = async (method, params) => {
    if (method === 'status') {
      const receipt = actor === f.recipient ? slots.slice(9, 45).map(s => s && { ...s, plain: true }) : [{ name: item, count: bag.A.inv[item], plain: true }, ...Array(35).fill(null)]
      return { state: { inventory: actor === f.recipient ? inv() : { ...bag.A.inv }, pos: bag[actor.name].p }, ...(params?.items && { detail: { storage: receipt } }) }
    }
    if (method !== 'assist') return {}
    events.push(params.mode)
    if (params.mode === 'prepare_pickup') {
      const r = await assist({ require: () => body }, params)
      if (scenario === 'cancel') bag.B.rescuing = true
      return r
    }
    if (params.mode === 'toss') { tossed.push(params.count); bag.A.inv[item] -= params.count; onGround += params.count }
    if (params.mode === 'pickup') {
      const partial = slots.find(s => s?.name === 'cobblestone' && s.count < 64)
      if (partial) { const n = Math.min(64 - partial.count, onGround); partial.count += n; onGround -= n }
      const slot = slots.findIndex((s, i) => i >= 9 && i < 45 && !s)
      if (slot >= 0 && onGround) { slots[slot] = { slot, name: item, count: onGround }; onGround = 0 }
    }
    return { ok: true }
  }
  return { f, tossed, events, slots, left: () => onGround, async start() { return swarmPosition(f.sw).transfer(f.donor, { board: f.board, members: [f.member] }) } }
}

test('a full receiver keeps the thirteen cobblestone with the courier; a partial stack accepts only what fits', async () => {
  for (const [scenario, expected] of [['full', 0], ['partial', 2]] as const) {
    const t = fullBagTransfer(scenario)
    await t.start()
    assert.deepEqual(t.tossed, expected ? [expected] : [])
    assert.equal(t.left(), 0)
    assert.equal(t.f.sw.pos.A.inv.cobblestone, 15 - expected)
    assert.equal(t.f.acknowledgements(), 0, 'two blocks cannot complete an order for thirteen')
  }
})

test('a valuable handoff waits for a freed slot and rechecks danger and failed discard before releasing the item', async () => {
  for (const scenario of ['exchange', 'cancel', 'failedDiscard'] as const) {
    const t = fullBagTransfer(scenario)
    await t.start()
    assert.equal(t.events[0], 'prepare_pickup')
    const delivered = scenario === 'exchange'
    assert.deepEqual(t.tossed, delivered ? [1] : [])
    assert.equal(t.left(), 0)
    assert.equal(t.f.sw.pos.A.inv.diamond_sword, delivered ? 2 : 3)
    assert.equal(t.f.acknowledgements(), Number(delivered))
    assert.equal(t.f.recipient.swarmReserved, undefined)
  }
})

test('the same full receiver can keep working until a bag or slot layout changes', async () => {
  for (const layoutOnly of [false, true]) {
    const t = fullBagTransfer('full'), sw = t.f.sw
    let time = 1000
    sw.now = () => time
    Object.assign(sw, swarmRetry(sw))
    if (layoutOnly) for (const slot of [9, 10]) t.slots[slot] = { slot, name: 'diamond', count: 32 }
    await t.start()
    const attempts = t.events.length
    await t.start()
    assert.equal(t.events.length, attempts)
    t.slots[9] = null
    if (layoutOnly) {
      // Consolidating two half stacks keeps all totals unchanged.
      t.slots[10].count = 64
      time += 3001
    } else sw.pos.B.inv.shield--
    await t.start()
    assert.deepEqual(t.tossed, [13])
    assert.equal(t.f.acknowledgements(), 1)
  }
})
