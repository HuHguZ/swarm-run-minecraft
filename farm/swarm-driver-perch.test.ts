// Отказ полёта помнит план, даже если бот уже отбежал от места взлёта.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { perchFor } from '../daemon/src/swarm/plan-judges'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { swarmRetry } from './swarm/swarm-driver/retry'

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
