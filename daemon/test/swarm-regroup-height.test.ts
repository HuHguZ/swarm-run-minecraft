import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { planPvp } from '../src/swarm/plan-pvp'
import type { SwarmMember } from '../src/swarm/types'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const NETHERITE = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const member = (id: string, extra: Partial<SwarmMember> = {}): SwarmMember => ({
  id, team: 'blue', position: p(), health: 20, strength: 80, role: 'fighter', weapon: 'netherite_sword',
  armor: NETHERITE, ench: { protection: 16, sharpness: 5 }, inventory: { netherite_sword: 1 }, ...extra
})

function scene(runnerY: number, groupY: number) {
  let now = 1000
  const runner = member('runner', { position: p(0, runnerY), weapon: 'stone_sword', armor: [], ench: {},
    inventory: { stone_sword: 1, elytra: 1, firework_rocket: 8 } })
  const mates = ['b', 'c'].map((id, k) => member(id, { position: p(-40, groupY, k * 2) }))
  const team = [runner, ...mates], board = new SwarmBoard('blue', () => now, 3000)
  board.setMembers(team)
  const see = () => {
    for (const m of team) board.observe(m.id, now, { id: 'foe', position: p(10, runnerY), visible: true,
      equipment: { weapon: 'diamond_sword', armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] } })
  }
  see()
  const plan = () => planPvp(board, team, { perches: [p(-15, runnerY + 19)] }).get(runner.id)!
  return { runner, mates, board, see, plan, at: (t: number) => { now = t } }
}

for (const [runnerY, groupY] of [[163, 120], [120, 163], [120, 120]]) {
  test(`lone retreat joins allies on their floor (${runnerY} to ${groupY}) and ends`, () => {
    const f = scene(runnerY, groupY), task = f.plan()
    assert.equal(task.kind, 'flee')
    assert.equal(pvpState(f.board).retreats.get('runner')?.why, 'один')
    assert.ok(task.data?.regroup && !task.data?.perch)
    assert.deepEqual(task.position, p(-40, groupY, 1), 'the regroup goal must be on the allies floor')
    f.runner.position = { ...task.position }
    f.at(1500); f.see()
    assert.notEqual(f.plan().kind, 'flee', 'joining the actual group ends retreat')
    assert.equal(pvpState(f.board).retreats.has('runner'), false)
  })
}

test('held lone retreat keeps the allies floor after the enemy leaves sight', () => {
  const f = scene(163, 120)
  assert.equal(f.plan().kind, 'flee')
  assert.equal(pvpState(f.board).retreats.get('runner')?.why, 'один')
  f.at(20000)
  assert.equal(f.board.enemies().length, 0)
  const task = f.plan()
  assert.equal(task.kind, 'flee')
  assert.ok(task.data?.regroup && !task.data?.perch)
  assert.deepEqual(task.position, p(-40, 120, 1))
  f.runner.position = { ...task.position }
  f.at(20500)
  assert.notEqual(f.plan().kind, 'flee')
  assert.equal(pvpState(f.board).retreats.has('runner'), false)
})

test('a group spanning two floors uses an occupied floor rather than their average', () => {
  const f = scene(163, 120)
  f.mates[1].position.y = 128
  const task = f.plan()
  assert.equal(task.kind, 'flee')
  assert.ok(task.data?.regroup)
  assert.ok([120, 128].includes(task.position.y), '124 would be between both allies floors')
})
