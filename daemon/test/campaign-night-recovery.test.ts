import { declarationsOf } from './source-fixture'
import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const source = campaignTs()
const declaration = (name: string) => {
  const start = source.indexOf(`async function ${name} (`)
  assert.ok(start >= 0)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
const weak = declarationsOf(source, 'weakAndHungry')

function fixture({ night = true, mode = 'speedrun', hp = 1, food = 10, raw = 0, hold = false } = {}) {
  const calls: string[] = []
  const context: any = {
    state: { health: hp, food, playPolicy: { mode }, dimension: 'overworld', pos: { x: -352, y: 36, z: -636 } },
    sit: { night, foes: 0 }, process: { env: {} }, stage: 'MineIron', known: {}, FOOD: /cooked_/, RAW: /mutton/,
    have: (re: RegExp) => re.test('mutton') ? raw : 0, dim: () => 'overworld', nightHold: () => hold,
    REFUGE_PASS: new Set(), refugeRunning: () => false, strategyExecuting: false, strategyInterrupted: false,
    died: false, fighting: false, resting: false, hunting: false, restIdleUntil: Infinity,
    telemetry: { on: () => false }, gameClock: { now: () => 1000 }, acceptResult: () => {},
    E2E: false, routeEntered: false, OW_DEEP: false, SELF_GUARDED: new Set(), mobInTheWay: async () => false,
    log: () => {}, rest: async () => {}, stopLava: async () => null, call: async (method: string) => {
      calls.push(method)
      return { status: 'done', detail: { stopped: 'здоровья 1 — дальше не копаю', dug: 0, steps: 0 }, events: [] }
    }
  }
  vm.runInNewContext(transformSync(weak + '\n' + declaration('act') + '\nthis.act=act;this.urgent=weakAndHungry', { loader: 'ts' }).code, cjsContext(withSetters(context)))
  return { context, calls }
}

test('W23 night health-refused stairs yield the MineIron step to existing food recovery', async () => {
  const f = fixture()
  await assert.rejects(f.context.act('dig_down', { mode: 'stairs', depth: 20 }), /сначала еда/)
  assert.equal(f.context.urgent(), true)
  assert.deepEqual(f.calls, ['dig_down'], 'the caller yields after its first actual no-progress receipt')
})

test('daytime recovery keeps the same handoff, while ordinary night policy remains unchanged', async () => {
  const day = fixture({ night: false })
  await assert.rejects(day.context.act('dig_down', {}), /сначала еда/)
  const ordinary = fixture({ mode: 'casual' })
  assert.equal(ordinary.context.urgent(), false)
  assert.equal((await ordinary.context.act('dig_down', {})).status, 'done')
})

for (const options of [{ hp: 20 }, { food: 18 }, { raw: 1 }]) test(`night food recovery uses the existing condition: ${JSON.stringify(options)}`, () => {
  assert.equal(fixture(options).context.urgent(), false)
})

test('a night held underground keeps working at hp 6-11 without food, below 6 it still yields (cl-h/cl-j 14.10: night hunts)', () => {
  assert.equal(fixture({ hp: 8, hold: true }).context.urgent(), false)
  assert.equal(fixture({ hp: 8 }).context.urgent(), true)
  assert.equal(fixture({ hp: 5, hold: true }).context.urgent(), true)
})
