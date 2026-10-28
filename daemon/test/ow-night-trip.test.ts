import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { declarationsOf } from './source-fixture'
import { campaignTs, withSetters } from './campaign-source'
import { cjsContext } from './cjs-context'

// ND_OW_NIGHT_TRIP (ow 27.10): оценённый ночной заход «вода → литьё у озера» не вето-ится общим ночным запретом наземных ходов.
const source = campaignTs()
const start = source.indexOf('async function act (')
const actCode = source.slice(start, source.indexOf('\n}', start) + 2)
const code = transformSync(declarationsOf(source, 'nightTrip', 'setNightTrip', 'NIGHT_STAGES') + '\n' + actCode +
  '\nthis.act=act;this.setNightTrip=setNightTrip', { loader: 'ts' }).code

function fixture () {
  const calls: string[] = []
  const context: any = {
    state: { health: 20, food: 20, playPolicy: { mode: 'speedrun' }, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 } },
    sit: { night: true, surface: true, foes: 0 }, process: { env: {} }, stage: 'water', known: {},
    weakAndHungry: () => false, telParams: (_m: string, p: any) => p, seamSnapshot: () => null, have: () => 0, dim: () => 'overworld', y: () => 70, nightHold: () => true, castNear: () => false,
    REFUGE_PASS: new Set(), refugeRunning: () => false, strategyExecuting: false, strategyInterrupted: false,
    died: false, fighting: false, resting: false, hunting: false, restIdleUntil: Infinity,
    telemetry: { on: () => false }, gameClock: { now: () => 1000 }, acceptResult: () => {}, earlyShield: async () => {},
    awayFromDanger: () => null, E2E: false, routeEntered: false, OW_DEEP: false, SELF_GUARDED: new Set(), mobInTheWay: async () => false,
    log: () => {}, rest: async () => {}, stopLava: async () => null,
    call: async (method: string) => { calls.push(method); return { status: 'done', detail: {}, events: [] } }
  }
  vm.runInNewContext(code, cjsContext(withSetters(context)))
  return { context, calls }
}

test('without the trip a night surface goto stays vetoed', async () => {
  const f = fixture()
  await assert.rejects(f.context.act('goto', { x: 10, z: 10 }), /ночь, брони нет/)
  assert.deepEqual(f.calls, [])
})

test('ND_OW_NIGHT_TRIP: the priced night trip walks to the water', async () => {
  const f = fixture()
  f.context.setNightTrip(true)
  assert.equal((await f.context.act('goto', { x: 10, z: 10 })).status, 'done')
  assert.deepEqual(f.calls, ['goto'])
  f.context.setNightTrip(false)
  await assert.rejects(f.context.act('goto', { x: 10, z: 10 }), /ночь, брони нет/)
})
