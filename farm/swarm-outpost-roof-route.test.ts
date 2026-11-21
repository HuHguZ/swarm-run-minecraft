import test from 'node:test'
import assert from 'node:assert/strict'
import { climbOutpost } from './swarm/swarm-driver/outpost-step'
import type { SwarmPosition, SwarmTask } from '../daemon/src/swarm/types'

const pos = (x,y,z) => ({ x, y, z }), key = p => [p.x,p.y,p.z].join(',')
for (const change of ['none', 'old wall stair', 'lost post', 'occupied roof', 'arriving enemy', 'forbidden passage', 'void', 'unsafe arena', 'no confirmed post']) {
  test('observed roof access after ' + change, async () => {
    const origin = pos(30,64,40), step = pos(32,64,41), post = pos(32,65,42), roof = pos(31,66,41), target = pos(31,66,39)
    const task = (id: string, blueprint: string, position: SwarmPosition, status: SwarmTask['status']): SwarmTask =>
      ({ id, kind: 'build', data: { blueprint }, position, status })
    const cell = task('missing','room',target,'claimed'), finishedPost = task('marker','beacon',post,'done')
    const tasks = [task('wall','room',pos(31,65,41),'done'), task('cap','room',roof,'done'), cell]
    if (change !== 'no confirmed post') tasks.push(finishedPost)
    const ground = new Set([key(pos(32,63,41)), key(pos(33,63,41)), key(post), key(roof)])
    if (change === 'void') ground.delete(key(pos(32,63,41)))
    const inspected: number[] = [], walks: string[] = [], placements: string[] = []
    let safety = 0
    const climbed = await climbOutpost({ plan: { origin }, bot: { c: { async call(_method,p: any) {
      if (p.placementSafety) return { status: 'done', detail: { underThreat: change === 'arriving enemy' && ++safety >= 2 } }
      inspected.push(p.cells.length)
      return { detail: { cells: p.cells.map(at => {
        const occupied = change === 'occupied roof' && inspected.length >= 2 && key(at) === key(pos(31,67,41))
        const solid = ground.has(key(at)) && !(change === 'lost post' && inspected.length >= 2 && key(at) === key(post))
        return { at, existing: { name: solid ? 'stone' : 'air', solid, occupied, exitBlocked: false } }
      }) } }
    } } }, arena: change === 'unsafe arena' ? { x: 30, z: 40, r: 2, killY: 62 } : undefined,
      cell, tasks, item: 'cobblestone', count: 10, position: pos(34.5,64,41.5), allies: [], contained: [],
      knownStep: change === 'old wall stair' ? pos(28,64,40) : undefined,
      forbidden: p => change === 'forbidden passage' && key(p) === key(step), owns: () => true, detail: (r: any) => r.detail,
      approach: async p => { walks.push(key(p)); return { status: 'done' } },
      placeStep: async p => { placements.push(key(p)); return true } })
    const canClimb = change === 'none' || change === 'old wall stair'
    assert.equal(climbed, canClimb)
    assert.deepEqual(placements, canClimb ? [key(step)] : [])
    assert.equal(walks.includes(key(pos(31.5,67,41.5))), canClimb)
    assert.ok(inspected.every(n => n <= 64))
    if (change === 'no confirmed post') assert.deepEqual(inspected, [])
  })
}

test('dense nearby landmarks share a single 64-cell inspection when no landing is visible', async () => {
  const origin = pos(0,64,0), cell: SwarmTask = { id: 'roof', kind: 'build', data: { blueprint: 'room' }, position: pos(0,66,0) }
  const tasks: SwarmTask[] = [cell], survey: string[][] = []
  const done = (p, blueprint) => tasks.push({ kind: 'build', status: 'done', id: key(p), position: p, data: { blueprint } })
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    if (Math.abs(x) <= 1 && Math.abs(z) <= 1) {
      done(pos(x,65,z),'room')
      if (x || z) done(pos(x,66,z),'room')
    } else done(pos(x,65,z),'other')
  }
  await climbOutpost({ plan: { origin }, tasks, cell, item: 'stone', count: 12, position: pos(4.5,64,0), allies: [], contained: [],
    forbidden: () => false, owns: () => true, detail: r => r.detail, approach: () => assert.fail('unseen landing'),
    placeStep: () => assert.fail('unseen footing'), bot: { c: { async call(_m,p: any) { survey.push(p.cells.map(key)); return { detail: { cells: [] } } } } } })
  assert.equal(survey.length, 1)
  assert.equal(new Set(survey[0]).size, survey[0].length)
  assert.ok(survey[0].length <= 64 && survey[0].length > 50)
})
