'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { options, querySample, analyze } from '../scenes/infra/try-tick-speed'
interface TickSample { name: string; rate: number; status: string; realSeconds?: number; ticks?: number; actualServerTPS?: number; lagTicks: number }
const trial = (actual: number): { sceneExit: number; runnerExit: number; queries: Record<string, number>[]; rows: TickSample[] } => ({ sceneExit: 0, runnerExit: 0, queries: [{ target: 100, mspt: 4, p95MSPT: 5 }], rows:
  ['wait40', 'walk24', 'dig-stone', 'fight-zombie'].map(name => ({ name, rate: 100, status: 'done', realSeconds: 8, ticks: actual * 8, actualServerTPS: actual, lagTicks: 0 })) })
test('benchmark requires a farm slot and bounds the existing wait RPC', () => {
  assert.throws(() => options(['--slot', '0']))
  assert.throws(() => options(['--slot', '31', '--rates', '1600']))
  assert.deepEqual(options(['--slot', '31']).rates, [100, 200, 400, 800])
})
test('target rate alone never wins; actual server ticks and full skills are required', () => {
  const slow = analyze(100, [trial(20), trial(20)], { seconds: 8 })
  assert.equal(slow.stable, false)
  assert.equal(slow.actualServerTPS, 20)
  const partial = analyze(100, [trial(85), trial(85)], { seconds: 8 })
  assert.equal(partial.stable, true, 'lower target attainment is separate from safe measured acceleration')
  assert.equal(partial.targetReached, false)
  const good = analyze(100, [trial(100), trial(100)], { seconds: 8 })
  assert.equal(good.stable, true)
  const missing = trial(100); missing.rows.pop()
  assert.equal(analyze(100, [trial(100), missing], { seconds: 8 }).failures.combat, 1)
  const unknown = trial(100); delete unknown.rows[0].actualServerTPS
  assert.equal(analyze(100, [unknown, trial(100)], { seconds: 8 }).stable, false)
  const failed = trial(100); failed.sceneExit = 1
  assert.equal(analyze(100, [failed, trial(100)], { seconds: 8 }).stable, false)
})
test('rate-change rows are excluded, one sample is provisional, lag prevents selection', () => {
  const a = trial(100); a.rows.push({ name: 'wait4', rate: 40, status: 'failed', lagTicks: 1000 })
  assert.equal(analyze(100, [a, trial(100)], { seconds: 8 }).stable, true)
  assert.equal(analyze(100, [a], { seconds: 8 }).stable, false)
  a.rows[1].lagTicks = 21
  assert.equal(analyze(100, [a, trial(100)], { seconds: 8 }).stable, false)
})
test('RCON query preserves native P95, MSPT and overload status', () => {
  const row = querySample("The game is running, but can't keep up with the target tick rate\nTarget tick rate: 800.0 per second.\nAverage time per tick: 1.43ms (Target: 1.25ms)\nPercentiles: P50: 0.2ms P95: 2.3ms P99: 4.0ms. Sample: 100")
  assert.equal(row.target, 800); assert.equal(row.mspt, 1.43); assert.equal(row.p95MSPT, 2.3); assert.equal(row.overloaded, true)
})

test('steady probe completes waits above the per-RPC 300 second cap', async () => {
  const { waitInChunks }: typeof import('../scenes/infra/try-tick-clock') = require('../scenes/infra/try-tick-clock')
  const chunks = []
  const result = await waitInChunks(async (method, p) => {
    assert.equal(method, 'wait')
    chunks.push(p.seconds)
    return { status: 'done', detail: { waited: p.seconds }, state: { clock: { ticks: 6400 } } }
  }, 320)
  assert.deepEqual(chunks, [300, 20])
  assert.equal(result.detail.waited, 320)
  const failed = await waitInChunks(async () => ({ status: 'interrupted' }), 600)
  assert.equal(failed.status, 'interrupted')
})
