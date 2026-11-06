import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../src/swarm/board'
import { assignFighters } from '../src/swarm/plan-assign'
import { pvpSectors } from '../src/swarm/plan-jobs'

const at = (x: number, z = .5, y = 120) => ({ x, y, z })
function scene() {
  const member: any = { id: 'guard', team: 'blue', position: at(1.5), health: 20, strength: 40,
    role: 'fighter', inventory: { stone_sword: 1 }, weapon: 'stone_sword' }
  const foe: any = { id: 'Champ', position: at(.5), hpEstimate: 20, seenAt: 10000,
    sources: ['guard'], equipment: { weapon: 'diamond_sword', armor: [] } }
  const board = new SwarmBoard('blue', () => 10000)
  board.setMembers([member])
  board.upsert({ id: 'pvp:guard', assignedTo: 'guard', kind: 'fight', position: at(1.5),
    data: { target: 'Champ', swarmStand: at(1.5) } })
  const task: any = { id: 'pvp:guard', kind: 'fight', data: { target: 'Champ' } }
  const S: any = { board, team: [member], enemies: [foe], state: {}, plan: new Map([['guard', task]]),
    options: {}, diggers: new Map(), digVacate: new Map(), digAvoid: [at(10, 10, 119)], weak: () => false }
  pvpSectors(S)
  S.sectorOf = () => 0; S.ringAt = () => at(3)
  return { S, task, foe, run: () => { assignFighters(S); return task.data.swarmStand } }
}

test('guard keeps an equally useful safe stand while unrelated dig allocations move', () => {
  const f = scene()
  assert.deepEqual(f.run(), at(1.5))
})

test('guard leaves a cleared or reserved support and does not occupy a digger stand', () => {
  const f = scene()
  f.S.digAvoid.push(at(1, 0, 119))
  assert.deepEqual(f.run(), at(3))
  const g = scene()
  g.S.diggers.set('worker', { site: { stands: [at(1.5)] } })
  assert.deepEqual(g.run(), at(3))
})

test('guard follows a moving target instead of preserving a distant stand', () => {
  const f = scene()
  f.foe.position = at(20)
  f.S.ringAt = () => at(22.5)
  assert.deepEqual(f.run(), at(22.5))
})

test('small target motion does not cancel a retained stand still in melee reach', () => {
  const f = scene()
  f.S.board.upsert({ id: 'pvp:guard', assignedTo: 'guard', kind: 'fight', position: at(3),
    data: { target: 'Champ', swarmStand: at(3) } })
  f.foe.position = at(.4); f.S.ringAt = () => at(-2.1)
  assert.deepEqual(f.run(), at(3))
})

test('a fallback guard cannot occupy another guard\'s retained stand', () => {
  const f = scene(), other = { ...f.S.team[0], id: 'other', position: at(4.5) }
  f.S.team.push(other); f.S.board.setMembers(f.S.team)
  f.S.board.upsert({ id: 'pvp:other', assignedTo: 'other', kind: 'fight', position: at(4.5),
    data: { target: 'Champ', swarmStand: at(4.5) } })
  const second = { id: 'pvp:other', kind: 'fight', data: { target: 'Champ' } } as any
  f.S.plan.set('other', second); f.S.digAvoid.push(at(4, 0, 119))
  pvpSectors(f.S)
  f.S.sectorOf = () => 0
  f.S.digVacate.set('other', at(1.5))
  f.run()
  assert.ok(Math.hypot(second.position.x - f.task.position.x, second.position.z - f.task.position.z) >= .6)
})
