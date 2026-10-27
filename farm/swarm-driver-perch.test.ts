// Отказ полёта помнит план, даже если бот уже отбежал от места взлёта.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { perchFor } from '../daemon/src/swarm/plan-judges'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'

test('a rejected perch stays unavailable to that bot after moving, then becomes eligible again', async () => {
  for (const why of ['гребень выше 48 бл. — не перелететь', 'нет элитр или ракет']) {
    let now = 1000
    const perch = { x: 30, y: 80, z: 0 }, calls = []
    const member = id => ({ id, team: 'blue', position: { x: 0, y: 64, z: 0 }, health: 20, strength: 1, role: 'fighter' as const, inventory: { elytra: 1, firework_rocket: 12 } })
    const a = member('A'), b = member('B'), board = new SwarmBoard('blue', () => now)
    board.setMembers([a, b])
    const state: any = { board, enemies: [], options: { perches: [perch] }, perched: new Map() }
    assert.deepEqual(perchFor(state, a), perch)
    const sw: any = { now: () => now, alive: () => true, log: () => {}, pos: {}, arena: {}, generation: 0,
      blocked: () => false, failed: () => {}, detail: r => r.detail, rangedAdvantage: () => false }
    const bot = { name: 'A', c: { async call(method) { calls.push(method); return { detail: { ok: false, why } } } } }
    await swarmTurnTasks(sw).turnFlee({ b: bot, board, task: { position: perch, data: { perch: true, target: 'Foe' } }, round: 0,
      m: { id: 'A', p: a.position, inv: a.inventory }, enemies: [], context: { members: [a, b] } } as any)
    assert.deepEqual(calls, ['fly_to', 'flee'])
    a.position.x += 3
    board.setMembers([a, b])
    assert.equal(perchFor(state, a), null, why)
    assert.deepEqual(perchFor(state, b), perch, 'отказ одного бота не закрывает насест союзнику')
    now += 15000
    assert.deepEqual(perchFor(state, a), perch, 'короткая память не запрещает насест навсегда')
  }
})

test('perch fallback consumes precise flight state and remembers an actual nearby touchdown', async () => {
  for (const scenario of ['missed', 'success', 'cancelled']) {
    const perch = { x: 30, y: 80, z: 0 }, actual = { x: 33.5, y: scenario === 'missed' ? 73.5 : 80, z: .5 }
    const member: any = { id: 'A', team: 'blue', position: { x: 0, y: 64, z: 0 }, health: 20, strength: 1, role: 'fighter', inventory: { elytra: 1, firework_rocket: 12 } }
    const m: any = { p: { ...member.position }, inv: { ...member.inventory } }, board = new SwarmBoard('blue', () => 1000)
    board.setMembers([member])
    const calls: any[] = [], b: any = { name: 'A', c: { async call(method, params) {
      calls.push({ method, params })
      if (method === 'fly_to') return { status: scenario === 'cancelled' ? 'interrupted' : 'done',
        detail: { ok: scenario === 'success', why: scenario === 'missed' ? 'landing_missed' : null, at: actual, ground: actual },
        state: { pos: { x: Math.floor(actual.x), y: actual.y, z: 0 }, inventory: { elytra: 1, firework_rocket: 10 } } }
      return { detail: { ok: false } }
    } } }
    const sw: any = { now: () => 1000, alive: () => true, log: () => {}, pos: { A: m }, arena: {}, generation: 0,
      cooldown: new Map(), detail: r => r.detail, rangedAdvantage: () => false }
    Object.assign(sw, swarmRetry(sw))
    const tc: any = { b, board, task: { position: perch, data: { perch: true, target: 'Foe' } }, round: 0, m, enemies: [], context: { members: [member] } }
    const actions = swarmTurnTasks(sw)
    await actions.turnFlee(tc)
    assert.deepEqual(m.p, actual, 'fallback starts at the precise receipt, not the pre-flight or rounded status position')
    assert.equal(m.inv.firework_rocket, 10)
    if (scenario === 'cancelled') {
      assert.equal(board.facts().length, 0, 'cancellation is not a terrain failure')
      assert.equal(calls.length, 1)
      continue
    }
    await actions.turnFlee(tc)
    assert.equal(calls.filter(c => c.method === 'fly_to').length, 1, scenario)
    if (scenario === 'success') assert.ok(calls.some(c => c.method === 'swarm_hold'), 'a nearby successful pad is occupied instead of launching again')
    else assert.equal(calls.filter(c => c.method === 'flee').length, 2, 'a missed pad keeps the ordinary escape available')
  }
})

test('retry memory retains A after B and keeps each signature tied to its own launch position', () => {
  const a = { name: 'A' }, b = { name: 'B' }, pos = { A: { p: { x: 0, y: 64, z: 0 } }, B: { p: { x: 0, y: 64, z: 0 } } }
  const retry = swarmRetry({ pos } as any)
  retry.failed(a, 'fly:A', 'target-A')
  assert.equal(retry.blocked(a, 'fly:A', 'target-A'), true)
  assert.equal(retry.blocked(a, 'fly:A', 'target-B'), false, 'a new destination remains available')
  pos.A.p.x = 1.5
  retry.failed(a, 'fly:A', 'target-B')
  assert.equal(retry.blocked(a, 'fly:A', 'target-A'), true, 'choosing B must not forget A')
  assert.equal(retry.blocked(a, 'fly:A', 'target-B'), true)
  assert.equal(retry.blocked(b, 'fly:B', 'target-A'), false, 'another actor has no failure')
  pos.A.p.x = 2.01
  assert.equal(retry.blocked(a, 'fly:A', 'target-A'), false, 'moving beyond A origin reopens A')
  assert.equal(retry.blocked(a, 'fly:A', 'target-B'), true, 'B retains its different physical origin')
  pos.A.p.x = 3.51
  assert.equal(retry.blocked(a, 'fly:A', 'target-B'), false)
  assert.equal(retry.retries.size, 0, 'movement prunes obsolete origins instead of accumulating them')
})

test('A-B-A perch selection cannot forget unchanged terrain when the existing planner fact expires', async () => {
  let now = 1000
  const a = { x: 30, y: 80, z: 0 }, b = { x: 0, y: 80, z: 30 }, calls: any[] = []
  const member: any = { id: 'A', team: 'blue', position: { x: 0, y: 64, z: 0 }, health: 20, strength: 1, role: 'fighter', inventory: { elytra: 1, firework_rocket: 12 } }
  const m: any = { p: { ...member.position }, inv: { ...member.inventory } }, board = new SwarmBoard('blue', () => now)
  board.setMembers([member])
  const bot = { name: 'A', c: { async call(method, params) {
    calls.push({ method, params })
    return { status: 'done', detail: { ok: false, why: 'landing_missed', at: { ...m.p } } }
  } } }
  const sw: any = { now: () => now, alive: () => true, log() {}, pos: { A: m }, arena: {}, generation: 0,
    cooldown: new Map(), detail: r => r.detail, rangedAdvantage: () => false }
  Object.assign(sw, swarmRetry(sw))
  const actions = swarmTurnTasks(sw), run = position => actions.turnFlee({ b: bot, board, task: { position, data: { perch: true, target: 'Foe' } },
    round: 0, m, enemies: [], context: { members: [member] } } as any)
  await run(a)
  await run(b)
  assert.equal(calls.filter(c => c.method === 'fly_to').length, 2)
  assert.equal(board.facts().length, 2)
  now += 15001
  assert.equal(board.facts().length, 0, 'the existing fifteen-second planning memory really expired')
  await run(a)
  assert.equal(calls.filter(c => c.method === 'fly_to').length, 2, 'expiry alone does not change the failed physical request')
  m.p.x += 2.01
  await run(a)
  assert.equal(calls.filter(c => c.method === 'fly_to').length, 3, 'movement still gives the same destination another chance')
})

test('cleared and the real round reset remove every signature without changing other retry keys', () => {
  const at = { x: 0, y: 64, z: 0 }, bot = { name: 'A', c: { async call() { return {} } } }
  const sw: any = createDriverState({ bots: [bot], pos: { A: { p: at, hp: 20, inv: {} } }, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 80 }, log() {}, home: () => at })
  Object.assign(sw, swarmRetry(sw))
  sw.failed(bot, 'fly:A', 'target-A'); sw.failed(bot, 'fly:A', 'target-B'); sw.failed(bot, 'pearl:A', 'target-A')
  sw.cleared('fly:A')
  assert.equal(sw.blocked(bot, 'fly:A', 'target-A'), false)
  assert.equal(sw.blocked(bot, 'fly:A', 'target-B'), false)
  assert.equal(sw.blocked(bot, 'pearl:A', 'target-A'), true)
  sw.failed(bot, 'fly:A', 'target-A'); sw.failed(bot, 'fly:A', 'target-B')
  swarmLifecycle(sw).reset()
  assert.equal(sw.retries.size, 0)
  assert.equal(sw.blocked(bot, 'fly:A', 'target-A'), false)
  assert.equal(sw.blocked(bot, 'fly:A', 'target-B'), false)
})

test('a temporary missing position is not evidence that the actor moved away from a failed attempt', () => {
  const bot = { name: 'A' }, position = { p: { x: 0, y: 64, z: 0 } }, pos: any = { A: position }
  const retry = swarmRetry({ pos } as any)
  retry.failed(bot, 'fly:A', 'target-A')
  delete pos.A
  assert.equal(retry.blocked(bot, 'fly:A', 'target-A'), false, 'unknown pose cannot authorize a physical comparison')
  pos.A = position
  assert.equal(retry.blocked(bot, 'fly:A', 'target-A'), true, 'the unchanged observed origin must retain its failure')
})
