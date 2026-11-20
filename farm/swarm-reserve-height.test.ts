import test from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../daemon/arena/colosseum'
import { generate } from '../daemon/arena/colosseum-arms'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'

const layout = generate('team1'), grid = C.model({ R: 24, ceilH: 16 }).g
for (const [x, y, z, block] of [...layout.field, ...layout.set]) grid.set(x, y, z, block === 'air' ? '' : block.replace(/\{.*$/, ''))
const solid = (x, y, z) => {
  const block = grid.get(x, y, z)
  return block ? !/carpet|banner|lantern|button|torch|ladder|lava/.test(block) : y === -1 && Math.abs(x) <= layout.R && Math.abs(z) <= layout.R
}
// Same existing operator-map callback supplied by arena/watch; no new catalogue.
const surfaceY = (x, z, top) => {
  const rx = Math.floor(x - 600), rz = Math.floor(z - 600)
  for (let y = Math.floor(top - 120); y >= -2; y--) if (solid(rx, y - 1, rz) && !solid(rx, y, rz) && !solid(rx, y + 1, rz)) return 120 + y
  return null
}
const from = { x: 551.4964378549855, y: 139, z: 648.5268453175636 }
const destination = { x: 562.9045078978955, y: 139, z: 607.1571198515772 }

function fixture(data: any = { reserve: true, sentry: true }, at = destination, surface = surfaceY) {
  const calls: any[] = [], pos = { A: { p: { ...from }, hp: 20, inv: {}, armor: {} } }
  const task = { kind: 'goto', position: { ...at }, data }
  const b: any = { name: 'A', team: 'blue', swarmTask: task, c: { async call(method, params) {
    calls.push({ method, params }); return { status: 'done', detail: {} }
  } } }
  const sw = createDriverState({ bots: [b], pos, alive: () => true, now: () => 1000, surfaceY: surface,
    arena: { x: 600.5, y: 120, z: 600.5, r: 80 }, home: () => pos.A.p, log() {} })
  Object.assign(sw, swarmMoves(sw))
  const run = () => swarmTurnWork(sw).turnGoto({ b, context: { members: [{ id: 'A' }] }, task, round: 0, m: pos.A, enemies: [], contact: false } as any)
  return { calls, task, pos, run }
}

test('a distant virtual sentry goal uses the known surface and the existing descent path', async () => {
  const f = fixture()
  assert.equal(surfaceY(destination.x, destination.z, destination.y), 120)
  await f.run()
  assert.equal(f.calls[0].params.y, 120, 'the inherited Y139 is air above the field')
  assert.equal(f.calls[0].params.climb, true, 'the existing go enables its descent handling')
  assert.equal(f.calls[0].params.timeoutSeconds, 10)
  assert.deepEqual(f.task.position, destination, 'the shared task is not mutated')
})

test('an unknown surface does not invent a lower reserve destination', async () => {
  const f = fixture(undefined, undefined, () => null)
  await f.run()
  assert.equal(f.calls[0].params.y, 139)
  assert.equal(f.calls[0].params.climb, undefined)
})

test('an occupied reserve holds while explicit destinations preserve their requested height', async () => {
  const here = { x: 580.5, y: 150.5, z: 545.4996132202406 }, occupied = fixture(undefined, here)
  occupied.pos.A.p = { ...here }
  await occupied.run()
  assert.equal(occupied.calls[0].method, 'swarm_hold', 'the occupied upper reserve must not issue another instant self-goto')
  assert.equal(occupied.calls[0].params.timeoutSeconds, 3)
  assert.deepEqual(occupied.calls[0].params.allies, ['A'])
  assert.deepEqual(occupied.calls[0].params.enemies, [])
  const cases = [
    fixture({ reserve: true, sentry: true, target: 'Enemy' }),
    fixture({ reserve: true, sentry: true, search: true, searchAt: destination }),
    fixture({ reserve: true, sentry: true, swarmStand: destination }),
    fixture({ reserve: true, sentry: true, hold: 'ambush' }),
    fixture({ loot: true })
  ]
  for (const f of cases) { await f.run(); assert.equal(f.calls[0].params.y, 139) }
})
