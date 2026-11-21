import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm'
import { swarmBuild } from './swarm/swarm-driver/build'
import { swarmRetry } from './swarm/swarm-driver/retry'

// Cross-section of the east gallery. The opposite upper wall has no face from below.
for (const view of ['open', 'unknown', 'void', 'lost-wall', 'occupied', 'exit', 'planned-door', 'one-block', 'lost-claim', 'interrupted']) test('last outpost wall, exterior step: ' + view, async () => {
  const board = new SwarmBoard('blue', () => 1000), origin = { x: 667, y: 144, z: 606 }
  const wall = { x: 666, y: 145, z: 606 }, top = { x: 668, y: 145, z: 606 }, step = { x: 669, y: 144, z: 606 }
  const at = (x, y, z = 606) => ({ x, y, z }), key = p => [p.x, p.y, p.z].join(',')
  const points = [at(666,144), at(667,144), at(668,144), top, wall, at(667,146), at(668,146)]
  const req = { kind: 'outpost', origin, id: 'site', cells: points.map(at => ({ at, kind: 'place' })), protected: view === 'planned-door' ? [step] : [] }
  const pos = { Mason: { p: at(669.5,144,607.5), inv: { cobblestone: view === 'one-block' ? 1 : 8 } } }
  const worker = { id: 'Mason', team: 'blue', role: 'miner-builder' as const, position: pos.Mason.p, health: 20, strength: 1, inventory: pos.Mason.inv }
  board.setMembers([worker, { ...worker, id: 'Ally' }])
  const writes: string[] = [], walks = [], upper = '668.5,146,606.5', middle = '669.5,145,606.5'
  let active = false, hasStep = false, high = false
  const b = { name: 'Mason', c: { async call(method, p) {
    if (method === 'swarm_pose' && p.cells) return { detail: { cells: p.cells.map(at => {
      let existing: any = { name: 'air', solid: false, occupied: false, exitBlocked: false }
      if (key(at) === key(top) && view !== 'lost-wall' || at.x === step.x && at.y === step.y - 1 && view !== 'void') existing = { ...existing, name: 'cut_sandstone', solid: true }
      if (at.x === step.x && at.z === step.z && at.y === step.y - 1 && view === 'unknown') existing = undefined
      if (key(at) === key(step)) existing = { ...existing, occupied: view === 'occupied', exitBlocked: view === 'exit' }
      return { at, existing }
    }) } }
    if (method === 'swarm_pose') return { detail: { poses: [], existing: { name: 'air' } } }
    if (method !== 'swarm_work') return {}
    if (!active) return { detail: { at: p.at, done: true, after: 'cobblestone' } }
    if (key(p.at) === key(step)) {
      writes.push(key(step))
      if (view === 'interrupted') return { status: 'interrupted', by: { type: 'tactical' }, detail: { aborted: true, why: 'direct_threat' } }
      if (view === 'lost-claim') board.cancel('build:site:' + key(wall))
      hasStep = true
      return { detail: { at: p.at, done: true, after: 'cobblestone' } }
    }
    if (!high) return { detail: { at: p.at, done: false, noVisibleSupport: true, why: 'no_visible_support' } }
    writes.push(key(p.at))
    return { detail: { at: p.at, done: true, after: 'cobblestone' } }
  } } }
  const sw: any = { bots: [b], pos, blueprints: new Map(), placed: new Map(), now: () => 1000, alive: () => true,
    teamOf: () => 'blue', telemetry: { built: 0 }, log() {}, say() {}, detail: r => r?.detail || {},
    buildGo: async (_b, to) => {
      walks.push(key(to))
      if (key(to) === upper) high = hasStep && walks.includes(middle)
      return { status: 'done', detail: { arrived: to } }
    }, renew: (board, b, c) => board.renew(c.id, b.name, c.claim.token, 25000) }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw), ctx = { board, member: worker, members: [worker] }
  await buildStep(b, ctx, req)
  for (const task of board.tasks().filter(t => t.status !== 'done' && key(t.position) !== key(wall) && t.position.y < 146)) {
    const claim = board.claim(task.id, 'Ally')
    assert.ok(board.ack(task.id, 'Ally', { confirmed: true, token: claim.claim.token, position: task.position, block: task.data.block }))
  }
  active = true
  await buildStep(b, ctx, req)
  const placed = view === 'open'
  assert.deepEqual(writes, placed ? [key(step), key(wall)] : ['lost-claim','interrupted'].includes(view) ? [key(step)] : [])
  assert.equal(board.tasks().some(t => key(t.position) === key(wall) && t.status === 'done'), placed)
  assert.equal(walks.includes(middle), placed)
})
