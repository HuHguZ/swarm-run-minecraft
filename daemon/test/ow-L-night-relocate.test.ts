import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { campaignTs } from './campaign-source'

const source = campaignTs()
const start = source.indexOf('async function nightWorkStepInner (')
assert.ok(start >= 0)
const body = source.slice(start, source.indexOf('\n}', start) + 2)
function fixture({ enabled = true, night = true, cost = 0, move = true } = {}) {
  const calls: string[] = []
  const c: any = { process: { env: { ND_NIGHT_RELOCATE: '1', ND_OW_NIGHT_RELOCATE_REACH: enabled ? '1' : '0' } },
    state: { pos: { x: 11, y: 63, z: 24 }, health: 20 }, sit: { surface: true, night, tod: night ? 16000 : 1000, work: {} },
    known: {}, dim: () => 'overworld', died: false, strategyInterrupted: false, nightWorkEnabled: true, nightWorkSafe: true,
    intelligence: { environment: { observe: async () => ({}) } }, READY: { nether: () => false },
    have: r => r instanceof RegExp || typeof r?.test === 'function' ? Number(r.test('stone_pickaxe')) : 0,
    portalFar: () => Infinity, portalBuckets: () => 1, near3: () => false,
    nightWorkBlocked: () => false, nightWorkFailures: new Map(), nightRelocated: new Set(),
    nightWorkDependency: () => '', nightKitRoute: () => false, nightKitPoint: () => false, nightKitCastHere: () => true,
    setStage: () => {}, log: () => {}, refresh: async () => {}, sense: async () => {},
    nightWorkSafety: { price: () => cost },
    awayFromWater: async () => { calls.push('move'); if (move) c.state.pos.x += 20 },
    act: async method => { calls.push(method); return { status: 'done' } } }
  vm.runInNewContext(transformSync(body + '\nthis.step=nightWorkStepInner', { loader: 'ts' }).code, c)
  return { c, calls }
}
test('L: exhausted surface work reaches the priced relocation branch (C1-09 shoreline loop)', async () => {
  const f = fixture()
  assert.equal((await f.c.step())?.progress, true)
  assert.deepEqual(f.calls, ['move'])
})
test('L: flag off retains surface handoff; daytime and a more expensive route do not relocate', async () => {
  for (const opts of [{ enabled: false }, { night: false }, { cost: 10000 }]) {
    const f = fixture(opts)
    assert.equal(await f.c.step(), null)
    assert.deepEqual(f.calls, [])
  }
})
test('L: an unchanged failed relocation is not retried every poll', async () => {
  const f = fixture({ move: false })
  assert.equal(await f.c.step(), null)
  assert.equal(await f.c.step(), null)
  assert.deepEqual(f.calls, ['move'])
})
test('L: a refused surface job still reaches the alternative relocation', async () => {
  const f = fixture()
  f.c.known.portal = { x: 11, y: 63, z: 25 }
  f.c.READY.nether = () => true
  f.c.portalFar = () => 1
  f.c.enterNether = async () => ({ error: 'no safe path' })
  assert.equal((await f.c.step())?.progress, true)
  assert.deepEqual(f.calls, ['move'])
})
