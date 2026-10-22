import test from 'node:test'
import assert from 'node:assert/strict'
import { glideChaseGoal } from '../src/pvp/turn-air'

const ahead = (p: { x: number; z: number }) => () => p

test('glide chase: a flyer leaving us is chased to the ground under where he will be in a second', () => {
  const goal = glideChaseGoal({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 1.2, z: 0 }, ahead({ x: 34, z: 0 }))
  assert.deepEqual(goal, { x: 34, z: 0 })
})

test('glide chase: a flyer circling close above is not chased (his dive is met by sky defence)', () => {
  assert.equal(glideChaseGoal({ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 0, z: 1.2 }, ahead({ x: 6, z: 24 })), null)
  assert.equal(glideChaseGoal({ x: 0, z: 0 }, { x: 6, z: 0 }, { x: -1, z: 0 }, ahead({ x: -14, z: 0 })), null)
})

test('glide chase: far away he is chased even when not flying straight away', () => {
  assert.ok(glideChaseGoal({ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 0, z: 1 }, ahead({ x: 30, z: 20 })))
})

test('glide chase: the goal stays inside the arena when he flies out over the wall', () => {
  const goal = glideChaseGoal({ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 1.5, z: 0 }, ahead({ x: 80, z: 10 }), { x: 0, z: 0, r: 40 })
  assert.ok(goal)
  assert.ok(Math.abs(goal.x) <= 38 && Math.abs(goal.z) <= 38, JSON.stringify(goal))
  assert.ok(goal.x > 30, 'still toward him')
})
