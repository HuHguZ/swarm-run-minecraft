import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
const { transformSync } = require('esbuild')
const { withClockFixture } = require('./clock-fixture')

function fixture({ found = true, known = false, rodsFirst = false }: any = {}) {
  const at = { x: 14, y: 65, z: 91, dimension: 'the_nether' }
  const places: any = known ? { 'бастион (ад)': at } : {}
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 37, y: 65, z: 41 },
    inventory: { stone_pickaxe: 3, netherrack: 64, crafting_table: 1, oak_planks: 16, ...(rodsFirst ? { ender_pearl: 6 } : {}) },
    armor: {}, ...(rodsFirst ? { potions: { fire_resistance: 2 } } : {}) }
  const calls: any[] = []
  class Socket {
    listeners = new Map<string, (...args: any[]) => void>()
    on(name, fn) { this.listeners.set(name, fn) }
    send(raw) {
      const { id, method, params } = JSON.parse(raw)
      calls.push({ method, params })
      let detail: any = {}
      if (method === 'situation') detail = { pickLeft: 520, free: 30, foes: 0, surface: true }
      if (method === 'fortress') {
        if (found) places['бастион (ад)'] = at
        detail = { found, seconds: 75, ...(found ? { bastion: { nearest: at } } : {}) }
      }
      if (method === 'recall') detail = { state: { places } }
      if (method === 'observe') detail = { entities: [] }
      if (method === 'mine') detail = { dug: 0, stopped: 'виден взрослый пиглин в зоне злости' }
      queueMicrotask(() => this.listeners.get('message')!(JSON.stringify({ id, ok: true,
        result: { status: 'done', detail, state, events: [] } })))
    }
    close() {}
  }
  const context: any = { require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync() {} } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} }, process: { argv: ['node', 'campaign.js'], env: {} },
    console: { log() {}, error() {} }, setTimeout, Date, queueMicrotask, testState: state,
    testSituation: { pickLeft: 520, free: 30, foes: 0, surface: true }, testKnown: known, testAt: at, testRodsFirst: rodsFirst }
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code +
    `\nstate = testState; sit = testSituation;
    if (testKnown) known.bastions = [{ key: 'бастион (ад)', ...testAt }];
    if (testRodsFirst) known.fortress = { x: 100, y: 64, z: 100 };
    module.exports = { executeStrategy, known, legacy: stageRun('bastion') };`, withClockFixture(context))
  return { calls, known: context.module.exports.known,
    run: signal => context.module.exports.executeStrategy({ skill: 'findBastions', strategy: 'FindBastions', params: {} }, signal),
    legacy: context.module.exports.legacy }
}

for (const options of [{}, { known: true }, { rodsFirst: true }]) {
  test(`FindBastions returns the observed discovery to the graph before gold acquisition ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    const result = await f.run(new AbortController().signal)
    assert.equal(result.outcome, 'SUCCESS')
    assert.equal(f.known.bastions?.length, 1)
    assert.equal(f.calls.filter(c => c.method === 'fortress').length, options.known ? 0 : 1)
    assert.ok(!f.calls.some(c => ['mine', 'explore', 'bastion', 'craft', 'armor'].includes(c.method)), JSON.stringify(f.calls))
  })
}

test('an unfinished search reports no invented bastion and does not acquire gold', async () => {
  const f = fixture({ found: false })
  await f.run(new AbortController().signal)
  assert.equal(f.known.bastions?.length ?? 0, 0)
  assert.equal(f.calls.filter(c => c.method === 'fortress').length, 1)
  assert.ok(!f.calls.some(c => ['mine', 'explore', 'bastion', 'craft', 'armor'].includes(c.method)))
})

// Золото Ада — по пути (пользователь 14.10): этап берёт руду на виду рядом, отдельной разведки руды нет.
test('legacy bastion retains its acquisition stage: seen gold nearby, no ore search', async () => {
  const f = fixture()
  await f.legacy()
  assert.ok(f.calls.some(c => c.method === 'mine' && /nether_gold_ore/.test(c.params.block)))
  assert.equal(f.calls.some(c => c.method === 'explore' && c.params.block === 'nether_gold_ore'), false)
})

test('cancelled FindBastions does not start discovery or acquisition', async () => {
  const f = fixture(), ctl = new AbortController()
  ctl.abort('test')
  assert.equal((await f.run(ctl.signal)).outcome, 'INTERRUPTED')
  assert.equal(f.calls.length, 0)
})
