import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'

test('отход от лучника сначала проверяет местное укрытие, сравнивая его с насестом', async () => {
  for (const covered of [true, false]) {
    const calls: any[] = [], perch = { x: 30, y: 80, z: 0 }
    const b = { name: 'A', c: { async call(method, params) {
      calls.push({ method, params })
      return { status: 'done', detail: { ok: method === 'take_cover' ? covered : true } }
    } } }
    const sw: any = { now: () => 1000, generation: 0, alive: () => true, log: () => {}, pos: {},
      arena: { x: 0, y: 64, z: 0, r: 60 }, blocked: () => false, failed: () => {}, detail: r => r.detail }
    await swarmTurnTasks(sw).turnFlee({ b, board: {}, context: { members: [] }, round: 0,
      m: { id: 'A', p: { x: 0, y: 64, z: 0 }, inv: {} },
      task: { kind: 'flee', position: perch, data: { perch: true, target: 'Foe' } },
      enemies: [{ id: 'Foe', threat: 'bow', seenAt: 1000, position: { x: 14, y: 64, z: 0 } }] } as any)
    assert.equal(calls[0].method, 'take_cover', 'колонна рядом проверяется до полёта через гребень')
    assert.deepEqual(calls[0].params.nearerThan, perch)
    assert.equal(calls[0].params.localOnly, true)
    assert.deepEqual(calls[0].params.arena, sw.arena)
    assert.equal(calls.some(c => c.method === 'fly_to'), !covered, 'без укрытия остаётся прежний воздушный отход')
  }
})

test('местное укрытие не подставляет спину мечнику и не перебивает владельца реакции', async () => {
  for (const close of [true, false]) {
    const calls = [], b: any = { name: 'A', c: { async call(method) {
      calls.push(method)
      return method === 'take_cover' ? { status: 'interrupted', by: { owner: 'Tactical' } } : { detail: { ok: true } }
    } } }
    const sw: any = { now: () => 1000, generation: 0, alive: () => true, log: () => {}, pos: {}, cooldown: new Map(),
      arena: {}, detail: r => r.detail, blocked: () => false, rangedAdvantage: () => false }
    await swarmTurnTasks(sw).turnFlee({ b, board: {}, context: { members: [] }, round: 0,
      m: { id: 'A', p: { x: 0, y: 64, z: 0 }, inv: {} },
      task: { kind: 'flee', position: { x: 30, y: 80, z: 0 }, data: { hide: true, target: 'Archer' } },
      enemies: [{ id: 'Archer', threat: 'bow', seenAt: 1000, position: { x: 14, y: 64, z: 0 } },
        ...(close ? [{ id: 'Sword', seenAt: 1000, position: { x: 2, y: 64, z: 0 } }] : [])] } as any)
    assert.deepEqual(calls, close ? ['flee'] : ['take_cover'])
    if (!close) assert.equal(b.swarmFightReply.status, 'interrupted', 'следующий ход дождётся наблюдения после реакции')
  }
})
