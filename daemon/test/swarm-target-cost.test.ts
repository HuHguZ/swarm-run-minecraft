import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import judges = require('../src/swarm/plan-judges')

test('20 fighters price each eligible opponent once per assignment and use new reports on the next plan', t => {
  let now = 10000
  const at = (x: number, z: number) => ({ x, y: 120, z })
  const members: SwarmMember[] = Array.from({ length: 20 }, (_, i) => ({ id: `Blue${i}`, team: 'blue',
    role: 'fighter', strength: 40, health: 20, position: at(i % 5 * 8, Math.floor(i / 5) * 8),
    inventory: { diamond_sword: 1 }, weapon: 'diamond_sword', armor: ['iron_chestplate', 'iron_leggings'] }))
  const board = new SwarmBoard('blue', () => now)
  board.setMembers(members)
  const see = (id: string, x: number, z: number) => board.observe('Blue0', now,
    { id, position: at(x, z), visible: true, equipment: { weapon: 'stone_sword', armor: [] } })
  for (let i = 0; i < 20; i++) {
    const cell = i * 7 % 20
    see(`Red${i}`, cell % 5 * 8 + 4, Math.floor(cell / 5) * 8)
  }
  const options = { doctrine: 'wave' as const, quorum: 1, foesLeft: 20, lootZones: [{ ...at(18, 0), tier: 2 }] }
  const visits = new Set<string>(), original = judges.targetCost
  let calls = 0
  t.mock.method(judges, 'targetCost', (frame, member, foe) => {
    visits.add(`${member.id}/${foe.id}`); calls++
    return original(frame, member, foe)
  })
  const run = () => planPvp(board, members, options)
  const first = run()
  assert.equal(first.size, 20)
  assert.ok(new Set([...first.values()].map(t => t.data?.target).filter(Boolean)).size > 1)
  assert.equal(visits.size, 400)
  assert.equal(calls, visits.size, 'repeated duel and terrain pricing for the same member and enemy')
  now += 30000
  for (let i = 0; i < 4; i++) see(`Red${i}`, 3 + i * 8, 8)
  visits.clear(); calls = 0
  const four = run()
  const targets = [...four.values()].map(t => t.data?.target).filter(Boolean)
  assert.ok(targets.length && targets.every(id => ['Red0', 'Red1', 'Red2', 'Red3'].includes(id)))
  assert.equal(visits.size, 80)
  assert.equal(calls, visits.size)
  now += 30000
  see('New', 1, 1)
  members[19].health = 0
  const next = run()
  assert.equal(next.size, 19)
  assert.deepEqual(new Set([...next.values()].map(t => t.data?.target).filter(Boolean)), new Set(['New']))
  assert.equal(calls, 80, 'the single possible target needs no price comparison')
})
