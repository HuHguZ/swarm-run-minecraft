import { campaignRequire, campaignScript } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
import { withClockFixture } from './clock-fixture'

function fixture({ noPath = false } = {}) {
  const calls: any[] = []
  class Socket { on() {} }
  const context: any = { require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync() {} } : campaignRequire(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: ['node', 'campaign.js'], env: {} },
    console: { log() {}, error() {} }, setTimeout, Date,
    testState: { health: 20, food: 20, pos: { x: 156, y: -10, z: 194 }, dimension: 'overworld', playPolicy: { mode: 'speedrun' },
      inventory: { iron_pickaxe: 1, water_bucket: 1, bucket: 1, flint_and_steel: 1, cobblestone: 40 } },
    testAct: async (method, params) => {
      calls.push({ method, params })
      if (noPath && calls.length === 1) return { status: 'failed', error: 'No path to the goal' }
      context.module.exports.known.portal = { x: 156, y: -10, z: 194 }
      return { status: 'done', detail: {} }
    } }
  vm.runInNewContext(campaignScript() +
    `\nstate = testState; sit = { surface: false, foes: 0, free: 25, night: true };
    known.lava = { x: 156, y: -10, z: 196 };
    sense = readMemory = recoverGuard = unclutter = ensureFlint = lootSeenStructures = async () => {};
    act = testAct;
    castForKit = async () => ({ status: 'done', detail: { stopped: 'места на берегу нет' } });
    module.exports = { cast: stageRun('cast'), walkAway, known };`, cjsContext(withClockFixture(context)))
  return { calls, cast: context.module.exports.cast, walkAway: context.module.exports.walkAway }
}

test('the actual cast stage keeps the observed bank height when seeking another frame site', async () => {
  const f = fixture()
  await f.cast()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'goto')
  assert.equal(f.calls[0].params.y, -10)
  assert.equal(f.calls[0].params.surface, 'strict')
})

test('a failed bank route keeps its height and excavation restriction on retry', async () => {
  const f = fixture({ noPath: true })
  await f.walkAway(12, Math.PI / 2, -10)
  assert.equal(f.calls.length, 2)
  for (const call of f.calls) {
    assert.equal(call.method, 'goto')
    assert.equal(call.params.y, -10)
    assert.equal(call.params.surface, 'strict')
  }
})

test('ordinary surface exploration retains its existing XZ fallback', async () => {
  const f = fixture({ noPath: true })
  await f.walkAway(12)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].params.y, undefined)
  assert.equal(f.calls[1].params.y, undefined)
  assert.equal(f.calls[1].params.surface, undefined)
})
