export {}
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const source = fs.readFileSync(path.join(__dirname, '..', 'campaign.ts'), 'utf8')
const actBody = source.slice(source.indexOf('async function act ('), source.indexOf('let hunting = false'))

async function receipt (detail, method = 'eat') {
  const rows = [], logs = []
  const state = { dimension: 'the_nether', health: 15, food: 12, inventory: { cooked_mutton: 5 }, playPolicy: { mode: 'speedrun' } }
  const result = { status: 'done', detail, state, events: [] }
  const ctx: any = {
    process: { env: {} }, state, sit: {}, stage: 'food', strategyExecuting: false, strategyInterrupted: false,
    died: false, resting: true, fighting: false, hunting: true, routeEntered: false, routeStepNow: null,
    REFUGE_PASS: new Set(), SELF_GUARDED: new Set(), mobInTheWay: async () => false, refugeRunning: () => false,
    dim: () => state.dimension, gameClock: { now: () => 1, wall: { now: () => 1 } },
    telemetry: { on: () => true, snapshot: () => ({}), delta: () => ({}), outcome: () => ({ status: result.status }), record: row => rows.push(row) },
    call: async () => result, acceptResult: () => {}, seamSnapshot: () => {}, telParams: JSON.stringify, log: line => logs.push(line)
  }
  vm.createContext(ctx)
  vm.runInContext(esbuild.transformSync(actBody, { loader: 'ts', format: 'cjs' }).code, ctx)
  assert.equal(await ctx.act(method, {}), result, 'logging must preserve the actual body result')
  return { rows, logs }
}

test('a failed meal keeps its physical failure and hand/window state in both existing logs', async () => {
  const detail = { ate: null, note: 'не поел', food: 12, tried: 'cooked_mutton', during: 'взять еду в руку',
    error: 'reflex: выбранного предмета больше нет', held: 'iron_sword', windowOpen: 'minecraft:crafting', busy: 'craft' }
  const r = await receipt(detail)
  assert.deepEqual(JSON.parse(JSON.stringify(r.rows[0].eatFailure)), {
    error: detail.error, during: detail.during, held: detail.held, windowOpen: detail.windowOpen, busy: detail.busy,
    tried: detail.tried, food: detail.food, note: detail.note
  })
  const line = r.logs.join('\n')
  for (const text of [detail.error, detail.during, detail.held, detail.windowOpen, detail.busy]) assert.ok(line.includes(text), text)
})

test('successful meals and unrelated actions do not gain an eating failure record', async () => {
  const cases: Array<[string, any]> = [['eat', { ate: 'cooked_mutton', gain: 6, spent: 1 }], ['observe', { ate: null, note: 'other action' }]]
  for (const [method, detail] of cases) {
    const r = await receipt(detail, method)
    assert.equal(r.rows[0].eatFailure, undefined)
    assert.equal(r.logs.some(line => line.includes('eatFailure:')), false)
  }
})


test('no-food failures retain an orphaned offhand stack in the existing diagnostic', async () => {
  const detail = { ate: null, note: 'еды в инвентаре нет', food: 6, offHand: { item: 'cooked_mutton', count: 6 } }
  const r = await receipt(detail)
  assert.deepEqual(JSON.parse(JSON.stringify(r.rows[0].eatFailure.offHand)), detail.offHand)
  assert.ok(r.logs.some(line => line.includes('cooked_mutton') && line.includes('count')))
})
