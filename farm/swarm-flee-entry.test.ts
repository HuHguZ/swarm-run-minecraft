import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { SwarmBoard, planPvp } from '../daemon/src/swarm'

test('найденное укрытие: сначала оценить выход, последний бой только после cornered', async () => {
  for (const cornered of [false, true]) {
    const calls: any[] = [], arena = { x: 0, y: 64, z: 0, r: 24, killY: 40 }
    const b = { name: 'A', c: { async call(method, params) { calls.push({ method, params }); return { detail: { cornered } } } } }
    const p = { x: 0, y: 70, z: 0 }, enemy = { id: 'Foe', position: { ...p, x: 2 }, seenAt: 1000 }
    const sw = { now: () => 1000, arena, generation: 1, alive: () => true, log() {}, detail: x => x.detail,
      rangedAdvantage: () => true }
    await swarmTurnTasks(sw).turnFlee({ b, round: 1, m: { id: 'A', p }, enemies: [enemy], context: { members: [] },
      board: {}, member: {}, task: { position: p, data: { hide: true, target: 'DistantArcher' } } })
    assert.equal(calls[0].method, 'flee', 'край или прокоп ещё могут дать выход из укрытия')
    assert.deepEqual(calls[0].params.arena, arena)
    assert.deepEqual(calls.map(c => c.method), cornered ? ['flee', 'fight'] : ['flee'])
    if (cornered) { assert.equal(calls[1].params.lastStand, true); assert.equal(calls[1].params.target, 'Foe') }
  }
})

test('быстрый преследователь не запрещает телу оценить спуск и прорыв', () => {
  const board = new SwarmBoard('blue', () => 1000, 3000)
  const members = [{ id: 'A', team: 'blue', position: { x: 0, y: 70, z: 0 }, health: 20, strength: 1,
    inventory: {}, armor: [], role: 'fighter' as const }]
  board.setMembers(members)
  board.observe('A', 1000, { id: 'Foe', position: { x: 2, y: 70, z: 0 }, velocity: { x: -.4, y: 0, z: 0 },
    equipment: { weapon: 'netherite_sword', armor: ['netherite_chestplate'] }, visible: true })
  const task = planPvp(board, members, { aggressive: true }).get('A')!
  assert.equal(task.kind, 'flee', 'скорость на горизонтали не доказывает, что выхода вниз нет')
  assert.equal(task.data?.lastStand, undefined)
})
