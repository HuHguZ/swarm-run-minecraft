import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'

// cl28b (15×15, 28.10): цель шла по ярусам Колизея, обрыв под ней менялся 17 ↔ 7–9 бл. — сброс включался и выключался
// каждую секунду (189 смен «сброс да/нет» при живом крае), и бойцы метались между сбросом и резервом.
test('начатый сброс держится, пока край ранит; новый — только с полной ценностью; без края — снят', () => {
  const p = (x: number, y = 120, z = 594) => ({ x, y, z })
  const members: SwarmMember[] = Array.from({ length: 6 }, (_, i) => ({ id: 'b' + i, team: 'blue', position: p(548 + i), health: 20, strength: 30, role: 'fighter', weapon: 'iron_sword', inventory: { iron_sword: 1 } }))
  let now = 1000
  const foe: any = { id: 'Foe', position: p(545), equipment: { weapon: 'iron_sword', armor: [] } }
  const fresh = () => { const b = new SwarmBoard('blue', () => now, 8000); b.setMembers(members); return b }
  const see = (b: SwarmBoard) => b.observe('b0', now, { ...foe, visible: true })
  const shovers = (plan: Map<string, any>) => [...plan.values()].filter(t => t.data?.shove).map(t => t.assignedTo).sort()
  const deep = { x: -1, z: 0, at: 1, drop: 17 }, shallow = { x: -1, z: 0, at: 1, drop: 9 }

  const board = fresh(); see(board)
  const first = planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => deep })
  const started = shovers(first)
  assert.ok(started.length > 0, 'обрыв 17 бл. — сброс')
  for (const t of first.values()) board.upsert(t)

  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => shallow })), started, 'обрыв 9 бл. ещё ранит — начатый сброс не рвётся')

  const other = fresh(); see(other)
  assert.deepEqual(shovers(planPvp(other, members, { aggressive: true, quorum: 1, edgeOf: () => shallow })), [], 'с 9 бл. новый сброс не начинают')

  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => null })), [], 'края нет — сброса нет')
})
