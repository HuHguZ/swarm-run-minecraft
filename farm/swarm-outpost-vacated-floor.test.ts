import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm'
import { swarmBuild } from './swarm/swarm-driver/build'
import { swarmRetry } from './swarm/swarm-driver/retry'

for (const view of ['vacated', 'occupied', 'hidden', 'exit', 'taken', 'distant', 'unavailable']) test('outpost floor reinspection: near cell ' + view, async () => {
  const board = new SwarmBoard('blue', () => 1000), near = { x: 0, y: 63, z: 0 }, far = { ...near, x: 3 }
  // A connected floor. Only the nearer previously occupied spot and the last, farther cell remain.
  const cells = [near, { ...near, x: 1 }, { ...near, x: 2 }, far].map(at => ({ at, kind: 'place' }))
  const request = { kind: 'outpost', origin: { x: 0, y: 64, z: 0 }, cells }
  const members = ['Mason', 'Ally'].map(id => ({ id, team: 'blue', role: 'miner-builder' as const, position: { ...near },
    health: 20, strength: 1, inventory: { cobblestone: 16 } }))
  board.setMembers(members)
  let first = true, inspections = 0
  const works = [], bot = { name: 'Mason', c: { async call(method, p) {
    if (method === 'swarm_pose' && p.cells) {
      inspections++
      assert.deepEqual(p.cells.map(c => c.x), [near.x])
      assert.equal(p.cells[0].bodyFor, 'cobblestone')
      assert.equal(p.cells[0].exitFor, 'cobblestone')
      assert.equal(board.tasks().filter(t => t.claim?.owner === 'Mason').length, 0)
      if (view === 'unavailable') throw new Error('survey unavailable')
      if (view === 'taken') board.claim(board.tasks().find(t => t.position.x === near.x).id, 'Ally')
      return { detail: { cells: view === 'hidden' ? [] : [{ at: near, existing: { name: 'air', occupied: view === 'occupied', exitBlocked: view === 'exit' } }] } }
    }
    if (method === 'swarm_pose') return { detail: { existing: { name: 'air' } } }
    if (method === 'swarm_work') {
      works.push(p.at.x)
      if (first) return { detail: { done: false, at: p.at, why: 'в клетке стоит player', occupiedByEntity: true } }
      return { detail: { done: true, at: p.at, before: 'air', after: 'cobblestone', why: 'placed' } }
    }
    return {}
  } } }
  const sw: any = { bots: [bot], pos: { Mason: { p: members[0].position, inv: members[0].inventory } }, blueprints: new Map(),
    placed: new Map(), now: () => 1000, alive: () => true, teamOf: () => 'blue', telemetry: { built: 0 }, log() {}, say() {},
    detail: r => r?.detail || {}, buildGo: async () => ({ status: 'done' }), renew: (b, w, c) => b.renew(c.id, w.name, c.claim.token, 25000) }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw), context = { member: members[0], members, board }
  await buildStep(bot, context, request)
  assert.deepEqual(works, [near.x])
  for (const cell of board.tasks().filter(t => t.position.x === 1 || t.position.x === 2)) {
    const claim = board.claim(cell.id, 'Ally')
    assert.ok(board.ack(cell.id, 'Ally', { confirmed: true, token: claim.claim.token, position: cell.position, block: cell.data.block }))
  }
  first = false
  if (view !== 'occupied') members[1].position = { ...near, z: -1 }
  if (view === 'distant') members[0].position = sw.pos.Mason.p = { ...near, x: -5 }
  await buildStep(bot, context, request)
  assert.equal(inspections, view === 'distant' ? 0 : 1)
  assert.deepEqual(works, [near.x, view === 'vacated' ? near.x : far.x])
  assert.equal(board.tasks().filter(t => t.status === 'done').length, 3)
})
