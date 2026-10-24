import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { dislodgeSeconds } from '../src/swarm/dislodge'

test('pricing a dig checks active work without cloning the entire task board', () => {
  const board = new SwarmBoard('blue', () => 1000)
  board.upsert({ id: 'dig', kind: 'goto', data: { target: 'Champ', dig: '0,119,0' } })
  board.tasks = () => { throw new Error('full task snapshot in the pricing hot loop') }
  const state = pvpState(board), S: any = { board, state }, foe: any = { id: 'Champ', position: { x: .5, y: 120, z: .5 } }
  assert.equal(dislodgeSeconds(S, foe, 'dig:0,119,0', 10, 20), 10)
  assert.equal(state.dislodgeWork?.get('Champ:dig:0,119,0')?.active, true)
})

test('the active-work query respects target, method, expiry and a confirmed completion', () => {
  let now = 1000
  const board = new SwarmBoard('blue', () => now)
  board.setMembers([{ id: 'A', team: 'blue', position: { x: 0, y: 120, z: 0 }, health: 20, strength: 1, role: 'fighter' }])
  board.upsert({ id: 'dig', kind: 'goto', expiresAt: 1100, data: { target: 'Champ', dig: '0,119,0' } })
  board.upsert({ id: 'shove', kind: 'fight', assignedTo: 'A', data: { target: 'Champ', shove: true } })
  assert.equal(board.dislodging('Champ', 'dig:0,119,0'), true)
  assert.equal(board.dislodging('Other', 'dig:0,119,0'), false)
  assert.equal(board.dislodging('Champ', 'dig:1,119,0'), false)
  now = 1100
  assert.equal(board.dislodging('Champ', 'dig:0,119,0'), false)
  assert.equal(board.dislodging('Champ', 'shove'), true)
  const task = board.claim('shove', 'A')!
  assert.equal(board.ack('shove', 'A', { confirmed: true, token: task.claim.token }), true)
  assert.equal(board.dislodging('Champ', 'shove'), false)
})
