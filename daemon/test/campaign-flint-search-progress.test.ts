import { functionSource } from './source-fixture'
import { CAMPAIGN } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'

function fixture(kind = 'find') {
  const body = functionSource(CAMPAIGN, 'ensureFlint', { ts: true })
  const inventory: Record<string, number> = { iron_ingot: 1 }
  const calls: Array<{ method: string, params: any }> = []
  const facts: Record<string, number> = {}
  let now = 0, legs = 0
  const context: any = { state: { health: 20, pos: { x: 79, y: 65, z: 21 } }, known: {}, died: false, strategyInterrupted: false,
    flintSearchSeen: new Set<string>(), flintSearchViews: 0, dim: () => 'overworld',
    gameClock: { now: () => now }, have: name => inventory[name] || 0, log() {}, portalFar: () => 100,
    graphFact: (name, value) => { facts[name] = value }, refresh: async () => {},
    craft: async name => { assert.equal(inventory.flint, 1); inventory.flint--; inventory.iron_ingot--; inventory[name] = 1 },
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'mine') {
        if (kind === 'find' && legs >= 2) { inventory.gravel = 1; return { status: 'done', detail: { dug: 1 } } }
        return { status: 'failed', error: 'no visible gravel', detail: { dug: 0 } }
      }
      if (method === 'flint_grind') { inventory.flint = 1; inventory.gravel = 0; return { status: 'done', detail: { tries: 1 } } }
      assert.equal(method, 'explore'); legs++; now += 60000
      if (kind !== 'stationary') context.state.pos.x = kind === 'revisit' && legs >= 2 ? 79 : 79 + legs * 64
      return { status: kind === 'interrupted' ? 'interrupted' : 'done',
        detail: { found: kind === 'find' && legs >= 2 ? 'gravel' : null, stuck: kind === 'stuck' } }
    } }
  vm.runInNewContext(body + '\nmodule.exports = ensureFlint', cjsContext(Object.assign(context, { module: { exports: {} } })))
  return { run: context.module.exports, calls, facts, inventory, context, now: () => now, resetLegs: () => { legs = 0 } }
}

test('flint search continues through a new observed view within its budget and actually crafts the lighter', async () => {
  const f = fixture()
  assert.equal(await f.run(), true)
  assert.equal(f.calls.filter(c => c.method === 'explore').length, 2)
  assert.equal(f.facts.flint_search_views, 2)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.equal(f.inventory.iron_ingot, 0)
})

test('flint search stops on stationary, revisited, blocked, or interrupted views without invented progress', async () => {
  for (const kind of ['stationary', 'revisit', 'stuck', 'interrupted']) {
    const f = fixture(kind)
    assert.equal(await f.run(), false, kind)
    assert.equal(f.calls.filter(c => c.method === 'explore').length, kind === 'revisit' ? 2 : 1, kind)
    assert.equal(f.facts.flint_search_views || 0, kind === 'revisit' ? 1 : 0, kind)
    assert.equal(f.inventory.flint_and_steel || 0, 0, kind)
    assert.equal(f.inventory.iron_ingot, 1, kind)
  }
})

test('new flint views return to the graph at the existing finite search budget', async () => {
  const f = fixture('budget')
  assert.equal(await f.run(), false)
  assert.equal(f.calls.filter(c => c.method === 'explore').length, 3)
  assert.equal(f.now(), 180000)
  assert.equal(f.facts.flint_search_views, 3)
  assert.equal(f.inventory.flint_and_steel || 0, 0)
})

test('the same observed cells in a later flint turn do not postpone failure handling', async () => {
  const f = fixture('budget')
  await f.run()
  assert.equal(f.facts.flint_search_views, 3)
  f.context.state.pos = { x: 79, y: 65, z: 21 }
  f.resetLegs()
  const views = f.facts.flint_search_views
  await f.run()
  assert.equal(f.facts.flint_search_views, views)
})
