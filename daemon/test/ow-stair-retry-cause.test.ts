'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { REPO_ROOT } from '../src/paths'

// Run the actual toSurface body, replacing only game/RPC boundaries.
function fixture(flag: string | undefined, move: boolean | number = false, world = 'overworld') {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'daemon/campaign/underground.ts'), 'utf8')
  const start = source.indexOf('async function toSurface (')
  const end = source.indexOf('\nexport { descend, toSurface }', start)
  assert.ok(start >= 0 && end > start)
  const field = source.indexOf('let owStairNoProgress')
  const state = { pos: { x: 40, y: 14, z: -65 } }
  const entrance = { x: -15, y: 68, z: -20, dim: world }
  const calls: string[] = []
  const context: any = { module: { exports: {} }, process: { env: { ND_OW_STAIR_RETRY_CAUSE: flag, ND_OW_STAIR_HOME: '1' } },
    state, stairEntrance: entrance, sit: { surface: false, inWater: false }, died: false,
    gameClock: { now: () => 1000 }, sense: async () => {}, leaveWater: async () => {},
    dim: () => world, y: () => state.pos.y, log: () => {}, spares: async () => {}, ensurePick: async () => true,
    have: () => 0, fillerCount: () => 0,
    act: async method => {
      calls.push(method)
      if (method === 'goto' && move) state.pos.x += typeof move === 'number' ? move : 1
      return { status: 'done', detail: { stopped: 'fixture no progress' } }
    } }
  vm.runInNewContext((field >= 0 && field < start ? source.slice(field, start) : '') +
    source.slice(start, end) + '\nmodule.exports = toSurface', context)
  return { run: () => context.module.exports(1), state, entrance, calls }
}

test('L: a confirmed unchanged stair origin skips its repeated goto and reaches the native climb fallback', async () => {
  const f = fixture('1')
  await f.run(); await f.run()
  assert.deepEqual(f.calls, ['goto', 'surface', 'surface'])
})
test('L: sub-block jitter inside the same standing cell does not reopen the failed route', async () => {
  const f = fixture('1', .1)
  await f.run(); await f.run()
  assert.equal(f.calls.filter(x => x === 'goto').length, 1)
})
test('L: default and zero retain both legacy stair attempts', async () => {
  for (const flag of [undefined, '0']) {
    const f = fixture(flag)
    await f.run(); await f.run()
    assert.equal(f.calls.filter(x => x === 'goto').length, 2)
  }
})
test('L: moving the body or changing the remembered stair entrance permits a new first attempt', async () => {
  for (const changed of ['origin', 'entrance']) {
    const f = fixture('1')
    await f.run()
    if (changed === 'origin') f.state.pos.x++
    else f.entrance.z++
    await f.run()
    assert.equal(f.calls.filter(x => x === 'goto').length, 2, changed)
  }
})
test('L: partial movement never freezes a useful return route', async () => {
  const f = fixture('1', true)
  await f.run(); await f.run()
  assert.equal(f.calls.filter(x => x === 'goto').length, 2)
})
// ne 21.10: в Аду поверхности нет — toSurface не поднимается вовсе (столб в открытое ставил под шары ифритов, c87-int3-s20).
test('L: in the Nether toSurface does not climb at all', async () => {
  const f = fixture('1', false, 'the_nether')
  assert.equal(await f.run(), false)
  assert.deepEqual(f.calls, [])
})
