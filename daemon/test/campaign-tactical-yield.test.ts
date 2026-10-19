import { campaignTs, campaignSocket, campaignVm } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { withClockFixture } from './clock-fixture'

function fixture(receipt: any = {}, preflight = false) {
  const calls: string[] = [], recovery: string[] = []
  const state = { health: 12, food: 8, dimension: 'overworld', replanRevision: 0,
    inventory: { stone_sword: 1 }, pos: { x: 104, y: 53, z: 137 } }
  const socket = campaignSocket(method => {
    calls.push(method)
    return { status: 'done', state, events: [], detail: {}, ...(method === 'dig_down' ? receipt : {}) }
  })
  const context = campaignVm(`
    state = testState; sit = { foes: 1, surface: false }; stage = 'MineIron';
    if (preflight) state.busy = 'refuge';
    answerThreat = async () => { recovery.push('answerThreat') };
    afterRefuge = async () => { recovery.push('afterRefuge') };
    tunnelAway = async () => { recovery.push('tunnelAway'); return false };
    awaitRefuge = async () => { recovery.push('awaitRefuge'); acceptResult(receipt); return receipt };
    STAGES.push({ name: 'testMining', run: async () => { await act('dig_down', { mode: 'stairs', depth: 24 }); await act('mine', { block: 'iron_ore' }) } });
    module.exports = { executeStrategy, act };`, { socket, wrap: withClockFixture, globals: { testState: state, receipt, preflight, recovery } })
  return { calls, recovery, context, run: () => context.module.exports.executeStrategy({ skill: 'testMining' }, new AbortController().signal) }
}

for (const receipt of [
  { status: 'interrupted', code: 'TACTICAL', by: { type: 'tactical' }, events: [{ type: 'damage' }] },
  { status: 'interrupted', by: { type: 'emergency' }, events: [{ type: 'damage' }] },
  { status: 'done', events: [{ type: 'tactical_released' }, { type: 'damage' }] },
  { status: 'done', state: { health: 12, food: 8, replanRevision: 1, dimension: 'overworld', inventory: {}, pos: { x: 104, y: 53, z: 137 } } }
]) test(`actual campaign yields interrupted mining before legacy recovery: ${JSON.stringify(receipt)}`, async () => {
  const f = fixture(receipt)
  const result = await f.run()
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.deepEqual(f.calls, ['dig_down'])
  assert.deepEqual(f.recovery, [], 'receipt goes back to the graph before the recursive fight/refuge chain')
})

test('a tactical interruption during the preflight refuge wait yields before afterRefuge or mining', async () => {
  const f = fixture({ status: 'interrupted', by: { type: 'emergency' }, state: { health: 12, food: 8, inventory: {}, dimension: 'overworld' } }, true)
  assert.equal((await f.run()).outcome, 'INTERRUPTED')
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.recovery, ['awaitRefuge'])
})

test('ordinary mining still completes and legacy campaign still answers an unhandled damage receipt', async () => {
  const ordinary = fixture()
  assert.equal((await ordinary.run()).outcome, 'SUCCESS')
  assert.deepEqual(ordinary.calls, ['dig_down', 'mine'])
  const legacy = fixture({ status: 'done', events: [{ type: 'damage' }] })
  await legacy.context.module.exports.act('dig_down', {})
  assert.deepEqual(legacy.recovery, ['answerThreat'])
})

for (const only of [null, ['food']]) test(`campaign stage entry leaves recovery to the graph unless stages were explicitly selected: ${only}`, async () => {
  const source = campaignTs()
  const entry = source.indexOf('const attemptedKey = failureKey(s.name)')
  assert.ok(entry >= 0)
  const start = source.indexOf('try {', entry) + 'try {'.length
  const end = source.indexOf('} catch (e)', start)
  assert.ok(end > start)
  const calls: string[] = []
  await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, cjsContext({
    only, recoverGuard: async () => { calls.push('recoverGuard') }, s: { run: async () => { calls.push('run') } }
  }))
  assert.deepEqual(calls, only ? ['recoverGuard', 'run'] : ['run'])
})

test('legacy urgent food does not replace a graph step that prepares already carried ingredients', () => {
  const source = campaignTs()
  const start = source.indexOf('const urgent = weakAndHungry()')
  const end = source.indexOf('if (!s &&', start)
  assert.ok(start >= 0 && end > start)
  const food = { name: 'food', ready: () => true, defer: () => false }
  const context = { only: null, weakAndHungry: () => true, urgentOk: () => true, need: [food], cooling: () => false,
    selection: { stage: { name: 'PrepareBread' } }, intelligence: { wrap: () => ({ name: 'Recovery_food' }) } }
  assert.equal(vm.runInNewContext(`(() => { ${source.slice(start, end)}; return s.name })()`, cjsContext(context)), 'PrepareBread')
})
