import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { installSight } from './arena/watch'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function liveFight() {
  const at = { x: .5, y: 64, z: .5 }, stand = { x: 2.5, y: 64, z: .5 }
  const fight = (x = 0, extra = {}) => ({ kind: 'fight', data: { target: 'Champ', committed: true, digAvoid: [{ x, y: 63, z: 0 }], swarmStand: stand, ...extra } })
  let task = fight(), resolve: (v: any) => void, reject: (e: Error) => void
  const calls: any[] = [], intent = { m: 'fight', p: { target: 'Champ', roundScope: 'blue:1', fightId: 'fight-1' }, pending: true }
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: task, last: intent,
    swarmFight: { id: 'fight-1', round: 1, target: 'Champ', roundScope: 'blue:1', intent },
    c: { call(method, params) { calls.push({ method, params }); return method === 'fight_guard' ? new Promise((r, e) => { resolve = r; reject = e }) : Promise.resolve({}) } } }
  const sw: any = { generation: 1, now: () => 1000, alive: () => true, pos: { A: { p: at } }, log() {}, detail: r => r.detail, refresh: () => ({ task }) }
  const { preempt } = swarmTurn(sw)
  return { b, sw, calls, fight, preempt: () => preempt(b), set: t => { task = t }, ack: v => v instanceof Error ? reject(v) : resolve(v) }
}

test('live fight guard coalesces pending changes, clears protection and never aborts the same combat phase', async () => {
  const f = liveFight(), first = f.fight(1)
  f.set(first)
  assert.equal(f.preempt(), false)
  assert.deepEqual(f.calls.map(c => c.method), ['fight_guard'])
  f.set(f.fight(2)); f.preempt(); f.preempt()
  assert.equal(f.calls.length, 1, 'only one update is pending')
  f.ack({ detail: { accepted: true } }); await flush()
  assert.equal(f.b.swarmTask, first)
  f.preempt(); assert.equal(f.calls.length, 2, 'latest guard follows the first acknowledgement')
  f.ack({ detail: { accepted: true } }); await flush()
  f.set(f.fight(2, { digAvoid: [], swarmStand: null })); f.preempt()
  assert.deepEqual(f.calls.at(-1).params.digAvoid, []); assert.equal(f.calls.at(-1).params.swarmStand, null)
  f.ack({ detail: { accepted: true } }); await flush()
  f.preempt(); assert.equal(f.calls.length, 3, 'acknowledged snapshot is not resent')
  assert.equal(f.b.last.m, 'fight')
})

test('j ordinary-fight to shove and back updates one live fight including changed edge coordinates', async () => {
  const f = liveFight(), to = { x: 539.5, y: 118, z: 595.5 }
  for (const extra of [{ shove: true, shoveAt: to }, { shove: true, shoveAt: { ...to, z: 596.5 } }, { shove: false }]) {
    const task = f.fight(0, extra)
    f.set(task)
    assert.equal(f.preempt(), false, 'the same enemy and round retain the active fight')
    assert.equal(f.calls.at(-1).method, 'fight_guard')
    assert.deepEqual(f.calls.at(-1).params.shoveAt, extra.shove ? extra.shoveAt : null)
    f.ack({ detail: { accepted: true } }); await flush()
    assert.equal(f.b.swarmTask, task)
  }
  assert.equal(f.calls.length, 3)
  assert.equal(f.b.last.m, 'fight')
})

test('pending shove update coalesces a new edge and its late ack cannot undo retreat', async () => {
  const f = liveFight(), to = { x: 539.5, y: 118, z: 595.5 }
  f.set(f.fight(0, { shove: true, shoveAt: to })); f.preempt()
  assert.deepEqual(f.calls.map(c => c.method), ['fight_guard'])
  f.set(f.fight(0, { shove: true, shoveAt: { ...to, z: 596.5 } })); f.preempt()
  assert.equal(f.calls.length, 1)
  const retreat = { kind: 'flee', data: { target: 'Champ' } }
  f.set(retreat); assert.equal(f.preempt(), true)
  f.ack({ detail: { accepted: true } }); await flush()
  assert.equal(f.b.swarmTask, retreat)
  assert.deepEqual(f.calls.map(c => c.method), ['fight_guard', 'stop'])
})

test('late guard acknowledgement never revives an old round, task, fight or emergency intent', async () => {
  for (const changed of ['round', 'task', 'fight', 'intent']) for (const accepted of [true, false]) {
    const f = liveFight(), original = f.b.swarmTask
    f.set(f.fight(1)); f.preempt()
    assert.equal(f.calls[0]?.method, 'fight_guard')
    if (changed === 'round') f.sw.generation++
    if (changed === 'task') f.b.swarmTask = { kind: 'flee', data: {} }
    if (changed === 'fight') f.b.swarmFight = { ...f.b.swarmFight, id: 'fight-2' }
    if (changed === 'intent') f.b.last = { m: 'evade', pending: true }
    const task = f.b.swarmTask
    f.ack({ detail: { accepted } }); await flush()
    assert.equal(f.b.swarmTask, task, changed)
    assert.equal(f.calls.some(c => c.method === 'stop'), false, `${changed}: no late stop of a replacement intent`)
    if (changed !== 'task') assert.equal(f.b.swarmTask, original)
  }
})

test('guard rejection falls back once; real target, offensive mode and retreat changes still stop', async () => {
  for (const reply of [{ detail: { accepted: false } }, new Error('unsupported RPC')]) {
    const f = liveFight()
    f.set(f.fight(1)); f.preempt(); assert.equal(f.calls[0]?.method, 'fight_guard')
    f.ack(reply); await flush()
    f.set(f.fight(2)); f.preempt(); f.preempt()
    assert.deepEqual(f.calls.map(c => c.method), ['fight_guard', 'stop'])
  }
  for (const task of [{ kind: 'flee', data: { panic: true } }, { kind: 'flee', data: { target: 'Champ' } }, { kind: 'fight', data: { target: 'Other' } },
    { kind: 'fight', data: { target: 'Champ', fountain: 'close' } }]) {
    const g = liveFight(); g.set(task); assert.equal(g.preempt(), true)
    assert.deepEqual(g.calls.map(c => c.method), ['stop'])
  }
  const pending = liveFight(), retreat = { kind: 'flee', data: { target: 'Champ' } }
  pending.set(pending.fight(1)); pending.preempt()
  pending.set(retreat); assert.equal(pending.preempt(), true)
  pending.ack({ detail: { accepted: true } }); await flush()
  assert.equal(pending.b.swarmTask, retreat)
  assert.deepEqual(pending.calls.map(c => c.method), ['fight_guard', 'stop'])
})

test('real turnFight creates unique scoped ids and removes only its own completed receipt', async () => {
  const at = { x: .5, y: 64, z: .5 }, foe = { id: 'Champ', seenAt: 1000, position: { x: 2.5, y: 64, z: .5 } }
  const calls: any[] = [], task = { kind: 'fight', position: foe.position, data: { target: foe.id, committed: true } }
  let finish: (v: any) => void
  const b: any = { name: 'A', swarmTask: task, c: { call(method, params) {
    calls.push({ method, params }); b.last = { m: method, p: params, pending: true }
    return new Promise(r => { finish = r })
  } } }
  const sw: any = { generation: 2, now: () => 1000, bots: [b], alive: () => true, pos: { A: { p: at } },
    log() {}, home: () => at, teamOf: () => 'blue', rangedAdvantage: () => false, onslaught: () => false, detail: r => r.detail, cooldown: new Map() }
  const { turnFight } = swarmTurnWork(sw)
  const tc: any = { b, board: {}, task, round: 2, m: { p: at, inv: {} }, enemies: [foe], context: { members: [] }, foe, contact: true }
  let prior = ''
  for (let k = 0; k < 2; k++) {
    const running = turnFight(tc)
    const owner = b.swarmFight, params = calls.at(-1).params
    assert.ok(owner?.id); assert.notEqual(owner.id, prior); prior = owner.id
    assert.equal(params.fightId, owner.id); assert.equal(params.roundScope, 'blue:2'); assert.equal(owner.intent, b.last)
    assert.deepEqual(params.digAvoid, []); assert.equal(params.swarmStand, null)
    assert.equal(params.shoveAt, null)
    if (k === 1) b.swarmFight = { id: 'replacement' }
    finish({ status: 'done', detail: { landed: 1 } }); await running
    assert.equal(b.swarmFight?.id, k === 1 ? 'replacement' : undefined)
  }
})

test('arena fight_guard passes climbing filters and preserves the real last intent', async () => {
  const calls: any[] = [], intent = { m: 'fight', p: { fightId: 'one' }, pending: true }
  const b: any = { name: 'A', team: 'blue', climbing: true, last: intent,
    c: { async call(method, params) { calls.push({ method, params }); return { status: 'done', detail: { accepted: true } } } } }
  const ctx: any = { i: 31, arms: false, bots: [b], names: ['A'], pos: { A: { p: { x: .5, y: 64, z: .5 } } },
    humans: {}, X: 0, Y: 64, Z: 0, R: 24, rcon() {}, log() {}, alive: () => true, deathAt: {}, home: () => '0 0', hostile: () => true }
  installSight(ctx)
  assert.equal((await b.c.call('fight_guard', { fightId: 'one' })).detail.accepted, true)
  assert.deepEqual(calls.map(c => c.method), ['fight_guard'])
  assert.equal(b.last, intent); assert.equal(intent.pending, true)
})

test('vacate goto keeps its exact destination when only other dig allocations change', () => {
  const at = { x: .5, y: 64, z: .5 }, stand = { x: 2.5, y: 64, z: .5 }
  const goto = (digAvoid, swarmStand = stand, target = 'Champ'): any => ({ kind: 'goto', position: swarmStand,
    data: { target, digAvoid, swarmStand } })
  let task = goto([{ x: 0, y: 63, z: 0 }]), calls: string[] = []
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: task, c: { call: async method => { calls.push(method) } } }
  const { preempt } = swarmTurn({ generation: 1, now: () => 1000, alive: () => true, log() {}, pos: { A: { p: at } }, refresh: () => ({ task }) } as any)
  task = goto([{ x: 1, y: 63, z: 0 }])
  assert.equal(preempt(b), false, 'goto never consumed the old reservation snapshot')
  assert.deepEqual(calls, [])
  task = goto([], { ...stand, x: stand.x + .25 })
  assert.equal(preempt(b), false, 'a stand nudge under half a block keeps the running goto')
  assert.deepEqual(calls, [])
  task = goto([], { ...stand, x: stand.x + .75 })
  assert.equal(preempt(b), true, 'a stand moved half a block or more redirects goto')
  assert.deepEqual(calls, ['stop'])
  task = goto([], task.position, 'Other')
  assert.equal(preempt(b), true, 'a real target change still stops the old goto')
})

test('a shove sector reassignment keeps the same fight; mode and safety changes still preempt', () => {
  const fight = (shove: boolean, slot: number) => ({ kind: 'fight', data: { target: 'Champ', shove, slot } })
  const calls: string[] = []
  let task = fight(true, 2)
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: fight(true, 1), c: { call: async method => { calls.push(method) } } }
  const { preempt } = swarmTurn({ now: () => 1000, alive: () => true, pos: { A: { p: { x: 0, y: 64, z: 0 } } }, log() {}, refresh: () => ({ task }) } as any)
  assert.equal(preempt(b), false, 'ordinary sector redistribution must not restart the same shove')
  assert.equal(calls.length, 0)
  task = fight(false, 2)
  assert.equal(preempt(b), true, 'leaving the shove mode still changes the fight contract')
  task = fight(true, 3)
  assert.equal(preempt(b), true, 'entering a shove still updates the fight contract')
})

test('vacate phase follows the required stand and new support underfoot, not distant dig allocations', () => {
  const at = { x: .5, y: 64, z: .5 }, stand = { x: 2.5, y: 64, z: .5 }
  const far = { x: 12, y: 63, z: 12 }, other = { x: 13, y: 63, z: 12 }
  const fight = (digAvoid, swarmStand = stand): any => ({ kind: 'fight', data: { target: 'Champ', digAvoid, swarmStand } })
  let task = fight([far])
  const calls: any[] = [], logs: string[] = []
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: task,
    c: { call: async (method, params) => { calls.push({ method, params }) } } }
  const sw: any = { now: () => 1000, alive: () => true, pos: { A: { p: at } }, log: text => logs.push(text),
    refresh: () => ({ task, member: { id: 'A', position: at } }) }
  const { preempt } = swarmTurn(sw)
  task = fight([other])
  assert.equal(preempt(b), false, 'unrelated work must not stop a safe fight at the same stand')
  assert.equal(calls.length, 0)

  task = fight([other], { ...stand, x: stand.x + 1 })
  assert.equal(preempt(b), true, 'a different required stand interrupts the old fight')
  assert.deepEqual(calls.pop(), { method: 'stop', params: undefined })

  task = fight([other, { x: 0, y: 63, z: 0 }], task.data.swarmStand)
  assert.equal(preempt(b), true, 'a newly reserved support underfoot requires immediate evacuation')
  assert.deepEqual(calls.pop(), { method: 'stop', params: undefined })
  assert.match(logs.at(-1)!, /0,63,0/)
  assert.equal(preempt(b), false, 'the same evacuation does not restart')

  b.swarmTask = fight([far])
  task = fight([other, { x: 0, y: 62, z: 0 }])
  assert.equal(preempt(b), false, 'a different floor does not require evacuation')

  task = fight([other, { x: 1, y: 63, z: 0 }])
  assert.equal(preempt(b), true, 'a new dig cell on the way to the unchanged stand refreshes the fight snapshot')
  assert.deepEqual(calls.pop(), { method: 'stop', params: undefined })

  b.swarmTask = { kind: 'goto', data: { dig: '12,63,12', undermine: true } }
  task = { kind: 'goto', data: { dig: '13,63,12', undermine: true } }
  assert.equal(preempt(b), true, 'a different dig cell still interrupts its worker')
  assert.deepEqual(calls.pop(), { method: 'stop', params: { _climb: true } })
  task = { kind: 'goto', data: { dig: '13,63,12', undermine: false } }
  assert.equal(preempt(b), true, 'changing the dig mode still interrupts its worker')
  assert.deepEqual(calls.pop(), { method: 'stop', params: { _climb: true } })
})

// cl28p (15×15, 28.10): «fight → fight (shove:B → shove:B) [goto]» 70 за раунд — точка сброса двигалась с целью на доли блока,
// и каждый пересчёт рвал подход за спину цели. Подход, уже ведущий в пределах своей точности к новой точке, — тот же подход.
test('shove approach survives a small shoveAt drift; a far move still restarts it', () => {
  const foe = { id: 'Champ', position: { x: 10, y: 64, z: 0 }, seenAt: 1000 }
  const task = (x: number, z = 0) => ({ kind: 'fight', data: { target: 'Champ', shove: true, shoveAt: { x, y: 64, z } } })
  const run = (x: number, z = 0, me = { x: 0, y: 64, z: 0 }) => {
    const calls: string[] = [], intent = { m: 'goto', pending: true }
    const b: any = { name: 'A', swarmExecuting: true, swarmTask: task(7), last: intent,
      swarmReposition: { at: { x: 12.5, y: 64, z: 0 }, range: .8, reason: 'shove', round: 1, target: 'Champ', intent },
      c: { call: async method => { calls.push(method) } } }
    const next = task(x, z)
    const { preempt } = swarmTurn({ generation: 1, now: () => 1000, alive: () => true, pos: { A: { p: me } }, log() {},
      refresh: () => ({ task: next, board: { enemies: () => [foe] } }) } as any)
    return { stopped: preempt(b), b, next }
  }
  const small = run(7, .4)
  assert.equal(small.stopped, false, 'край сместился на 0.4 бл.: точка подхода — на 0.3, подход идёт дальше')
  assert.equal(small.b.swarmTask, small.next)
  assert.equal(run(10, -3).stopped, false, 'далеко от точки: поправка 3.5 бл. меньше половины оставшихся 12.5 — иду, поправлю по прибытии')
  assert.equal(run(10, -3, { x: 11, y: 64, z: -1 }).stopped, true, 'почти дошёл, а точка ушла на другую сторону цели — подход заново')
})
