import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'

function fixture(cover: boolean) {
  const at = { x: 0, y: 64, z: 0 }, calls: any[] = []
  const foe = { id: 'E', position: { x: 4, y: 64, z: 0 }, seenAt: 1000 }
  const running = { kind: 'fight', data: { target: 'E' }, position: at }
  const task = { kind: 'goto', data: { target: 'E', ...(cover ? { hold: 'shield', antidoteCover: 'B', face: foe.position, range: .6 } : {}) }, position: at }
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: running, last: { m: 'fight', pending: true },
    c: { async call(method: string, params: any) { calls.push({ method, params }); return {} } } }
  const member = { id: 'A', position: at, health: 20, inventory: { iron_sword: 1 } }
  const board = { enemies: () => [foe], tasks: () => [], facts: () => [] }
  const context = { task, board, member, members: [member, { id: 'B' }] }
  const sw: any = { generation: 1, now: () => 1000, alive: () => true, log() {}, pos: { A: { p: at, inv: member.inventory } }, arena: {},
    refresh: () => context, say() {}, onslaught: () => false, chestAtHand: () => false,
    detail: (r: any) => r, async execute(actor: any, method: string, params: any) { calls.push({ method, params }); return {} }, async reactCamp() {} }
  Object.assign(sw, swarmTurnTasks(sw))
  return { driver: swarmTurn(sw), b, task, calls }
}

test('antidote cover preempts the same nearby fight and dispatches a real shield hold', async () => {
  const f = fixture(true)
  assert.equal(f.driver.preempt(f.b), true)
  assert.equal(f.b.swarmTask, f.task)
  assert.deepEqual(f.calls.map(c => c.method), ['stop'])
  f.b.swarmExecuting = false
  await f.driver.turn(f.b)
  assert.deepEqual(f.calls.map(c => c.method), ['stop', 'swarm_hold'])
  assert.equal(f.calls[1].params.shield, true)
  assert.deepEqual(f.calls[1].params.allies, ['A', 'B'])
})

test('an ordinary goto still preserves the same nearby fight', () => {
  const f = fixture(false)
  assert.equal(f.driver.preempt(f.b), false)
  assert.deepEqual(f.calls, [])
})
