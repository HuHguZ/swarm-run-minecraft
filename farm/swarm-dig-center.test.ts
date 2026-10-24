import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'

test('L captured precise own position keeps the approach outside 1.6 instead of rounding it into centering range', async () => {
  const exact = { x: 542.328744, y: 120, z: 592.5 }, floored = { x: 542, y: 120, z: 592 }
  const stand = { x: 540.5, y: 120, z: 591.5 }
  assert.ok(Math.hypot(floored.x - stand.x, floored.z - stand.z) < 1.6)
  assert.ok(Math.hypot(exact.x - stand.x, exact.z - stand.z) > 1.6)
  for (const mode of ['exact', 'legacy', 'missing']) {
    const calls: string[] = [], holes: any[] = []
    const task: any = { id: 'pvp:t', kind: 'goto', assignedTo: 't', position: { x: 541, y: 119, z: 591 },
      data: { target: 'Champ', dig: '541,119,591', undermine: true, blocks: ['quartz_bricks', 'obsidian'], stands: [stand] } }
    const member: any = { id: 't', team: 'blue', role: 'fighter', health: 20, strength: 20, position: exact }
    const board = new SwarmBoard('blue', () => 1000)
    board.setMembers([member]); board.upsert(task)
    const b: any = { name: 't', swarmTask: task, c: { call: async (method, params) => {
      calls.push(method)
      if (method === 'status') {
        if (mode === 'missing') throw new Error('offline')
        // This is the real producer contract: own physics is optional and avoids a swarm sighting scan.
        return { state: { pos: floored }, detail: mode === 'exact' && params?.physics ? { physics: { pos: exact } } : {} }
      }
      if (method === 'goto') return { status: 'done' }
      if (method === 'center_in') return { status: 'done', detail: { ok: true, at: stand } }
      if (method === 'swarm_work') return { status: 'done', detail: { ok: true } }
      throw new Error('unexpected RPC ' + method)
    } } }
    const sw: any = { now: () => 1000, alive: () => true, log() {}, pos: {}, bots: [], arena: {}, home() {},
      cooldown: new Map(), holes, planned: new Map(), walls: new Map(), ladderRoutes: [], generation: 1,
      detail: r => r.detail || r, teamOf: () => 'blue', ownProtection: () => [], say2() {}, siteFailed() {} }
    await swarmTurnWork(sw).turnDig({ b, context: { members: [member] }, board, task, round: 1, m: { p: exact } } as any)
    assert.equal(calls.includes('goto'), mode !== 'legacy', mode + ': unchanged 1.6 gate uses the best available position')
    assert.equal(calls.filter(c => c === 'status').length, 1, 'no extra observation RPC')
    assert.equal(holes.length, 1, mode + ': legacy fallbacks still finish the native work path')
  }
})

test('digging uses the precise centering receipt, never the floored status position', async () => {
  const stand = { x: 1.5, y: 64, z: .5 }, floored = { x: 1, y: 64, z: 0 }
  for (const scenario of ['centered', 'missing', 'invalid', 'refused', 'too_far', 'interrupted', 'reassigned']) {
    const calls: string[] = [], holes: any[] = []
    const task: any = { id: 'pvp:worker', assignedTo: 'worker', kind: 'goto', position: { x: 0, y: 63, z: 0 },
      data: { target: 'Champ', dig: '0,63,0', undermine: true, blocks: ['sandstone', 'obsidian'], stands: [stand], drop: Infinity } }
    const member: any = { id: 'worker', team: 'blue', role: 'fighter', health: 20, strength: 20, position: floored }
    const board = new SwarmBoard('blue', () => 1000)
    board.setMembers([member]); board.upsert(task)
    const b: any = { name: 'worker', swarmTask: task, c: { call: async (method: string) => {
      calls.push(method)
      if (method === 'status') return { state: { pos: floored } }
      if (method === 'center_in') {
        if (scenario === 'reassigned') b.swarmTask = { data: { dig: '9,63,9' } }
        const at = scenario === 'missing' ? undefined : scenario === 'invalid' ? { ...stand, x: NaN } :
          scenario === 'too_far' ? { ...stand, x: 2 } : stand
        return { status: scenario === 'interrupted' ? 'interrupted' : 'done', detail: { ok: scenario !== 'refused', at } }
      }
      if (method === 'swarm_work') return { status: 'done', detail: { ok: true } }
      throw new Error('unexpected RPC ' + method)
    } } }
    const sw: any = { now: () => 1000, alive: () => true, log() {}, pos: {}, bots: [], arena: {}, home() {},
      cooldown: new Map(), holes, planned: new Map(), walls: new Map(), ladderRoutes: [], generation: 1,
      detail: r => r.detail || r, teamOf: () => 'blue', ownProtection: () => [], say2() {}, siteFailed() {} }
    const m = { p: floored }
    await swarmTurnWork(sw).turnDig({ b, context: { members: [member] }, board, task, round: 1, m } as any)
    const expected = scenario === 'centered' ? 2 : 0
    assert.equal(calls.filter(c => c === 'swarm_work').length, expected, scenario)
    assert.equal(holes.length, expected ? 1 : 0, scenario)
    if (expected) {
      assert.equal(holes[0].bottomY, 62, 'the hole records only the lowest confirmed cleared block')
      assert.equal(calls.filter(c => c === 'status').length, 1, 'the receipt must not be overwritten by another floored status')
      assert.deepEqual(m.p, stand)
    }
  }
})
