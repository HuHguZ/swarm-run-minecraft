import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
const begin = source.indexOf('async function executeStrategy (')
assert.ok(begin >= 0)
const code = transformSync(source.slice(begin, source.indexOf('\n}', begin) + 2) + '\nthis.run=executeStrategy', { loader: 'ts' }).code

async function scout(knownLava = false, interrupted = false) {
  const calls: { method: string, params: any }[] = []
  const context: any = {
    strategyExecuting: false, strategyInterrupted: false,
    state: { pos: { x: 204, y: 64, z: 41 } }, known: { lava: knownLava && { x: 210, y: 63, z: 42 } },
    lavaScoutCells: new Set(), lavaScoutViews: 0, dim: () => 'overworld', graphFact() {}, skyLavaLook: async () => null,
    act: async (method, params) => { calls.push({ method, params }); if (interrupted) context.strategyInterrupted = true; return { status: 'done' } }
  }
  vm.runInNewContext(code, context)
  const result = await context.run({ skill: 'scoutLava' }, new AbortController().signal)
  return { calls, result }
}

test('the actual graph ScoutLava caller requests lava accepted by portal casting', async () => {
  const f = await scout()
  assert.deepEqual(f.calls.map(x => x.method), ['observe', 'explore'])
  assert.equal(f.calls[1].params.lavaSource, true)
  assert.equal(f.calls[1].params.surface, true)
})

test('an already known lava site avoids another search', async () => {
  const f = await scout(true)
  assert.deepEqual(f.calls.map(x => x.method), ['observe'])
})

test('a tactical handoff keeps the actual graph scout interrupted', async () => {
  assert.equal((await scout(false, true)).result.outcome, 'INTERRUPTED')
})
