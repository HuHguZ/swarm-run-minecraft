import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { functionSource } from './source-fixture'
import { CAMPAIGN } from './campaign-source'

function fixture() {
  const calls: Array<{ method: string, params: any }> = []
  const inv: Record<string, number> = {}
  let result: any = {status: 'failed', error: 'no visible gravel'}
  const ctx: any = { process: {env: {ND_OW_FAST_FLINT: '1'}},
    state: {dimension: 'overworld', health: 20, playPolicy: {mode: 'speedrun'}, pos: {x: 0, y: 68, z: 0}},
    sit: {surface: true, foes: 0}, known: {lava: {x: 24, y: 68, z: 0}},
    died: false, strategyInterrupted: false, lavaSourceKnown: true, earlyFlintSeen: new Set(),
    dim: () => ctx.state.dimension, have: (name: string) => inv[name] || 0,
    refresh: async () => {}, log() {},
    act: async (method: string, params: any) => {calls.push({method, params}); return result}
  }
  vm.runInNewContext(functionSource(CAMPAIGN, 'earlyFlint', {ts: true}) + '\nthis.early = earlyFlint', ctx)
  return {ctx, inv, calls, early: ctx.early as () => Promise<boolean>, setResult: (value: any) => {result = value}}
}

test('O early flint makes one bounded fair dry request and refusal never blocks iron', async () => {
  const f = fixture()
  assert.equal(await f.early(), true)
  assert.equal(f.calls.length, 1)
  const {method, params} = f.calls[0]
  assert.equal(method, 'mine'); assert.equal(params.block, 'gravel')
  assert.equal(params.count, 1); assert.equal(params.dry, true); assert.equal(params.fair, true)
  assert.equal(params.radius, 12); assert.equal(params.timeoutSeconds, 12)
  assert.ok(!f.calls.some(c => /explore|flint_grind|goto/.test(c.method)))
})

test('O early flint does not repeat an unchanged failed shore for HP or inventory changes', async () => {
  const f = fixture(); await f.early()
  f.ctx.state.health = 19; f.inv.dirt = 10; f.ctx.state.pos.x = 1
  await f.early(); assert.equal(f.calls.length, 1)
  f.ctx.known.lava = {x: 30, y: 68, z: 0}
  await f.early(); assert.equal(f.calls.length, 2)
})

test('O early flint preserves tactical ownership even without a global interruption flag', async () => {
  const f = fixture(); f.setResult({status: 'interrupted'})
  assert.equal(f.ctx.strategyInterrupted, false)
  assert.equal(await f.early(), false)
  await f.early(); assert.equal(f.calls.length, 1)
})

test('O early flint keeps raw gravel, flint and existing igniters without further work', async () => {
  for (const item of ['gravel', 'flint', 'flint_and_steel', 'fire_charge']) {
    const f = fixture(); f.inv[item] = 1
    assert.equal(await f.early(), true); assert.equal(f.calls.length, 0, item)
  }
})

test('O early flint is optional and limited to a known safe surface lake approach', async () => {
  const changes = [
    (f: any) => {f.ctx.process.env.ND_OW_FAST_FLINT = '0'},
    (f: any) => {f.ctx.state.dimension = 'the_nether'},
    (f: any) => {f.ctx.state.playPolicy.mode = 'casual'},
    (f: any) => {f.ctx.sit.surface = false}, (f: any) => {f.ctx.sit.night = true},
    (f: any) => {f.ctx.sit.dusk = true}, (f: any) => {f.ctx.sit.foes = 1},
    (f: any) => {f.ctx.lavaSourceKnown = false}, (f: any) => {f.ctx.known.lava = null},
    (f: any) => {f.ctx.known.lava.y = 10}, (f: any) => {f.ctx.known.lava.x = 200},
    (f: any) => {f.ctx.known.portal = {x: 1, y: 68, z: 0}},
    (f: any) => {f.ctx.state.health = 5}
  ]
  for (const change of changes) {const f = fixture(); change(f); assert.equal(await f.early(), true); assert.equal(f.calls.length, 0)}
})
