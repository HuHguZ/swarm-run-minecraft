import test from 'node:test'
import assert from 'node:assert/strict'
import { perchFor } from '../src/swarm/plan-judges'
import { SwarmBoard } from '../src/swarm/board'

test('насест от лучника: дальний (вне 32 бл.) лучше ближнего, но ближний — лучше никакого', () => {
  const m: any = { id: 'A', position: { x: 0, y: 64, z: 0 }, armor: ['elytra'], inventory: { firework_rocket: 10 } }
  const near = { x: 14, y: 70, z: 0 }, far = { x: -40, y: 70, z: 0 }
  const S: any = (archer: boolean, perches: any[]) => ({ enemies: [{ id: 'Foe', position: { x: 2, y: 64, z: 0 }, threat: archer ? 'bow' : 'melee' }],
    board: new SwarmBoard('blue'), options: { perches }, perched: new Map(), archer: (e: any) => e.threat === 'bow' })
  assert.deepEqual(perchFor(S(true, [near, far]), m), far)
  assert.deepEqual(perchFor(S(true, [near]), m), near)
})
