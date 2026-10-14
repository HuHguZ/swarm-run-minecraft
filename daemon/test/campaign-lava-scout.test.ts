import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import { emptyWorld, fact } from '../src/core/world-state'

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const branch = source.slice(source.indexOf("} else if (skill === 'scoutLava') {") + "} else if (skill === 'scoutLava') {".length,
    source.indexOf("} else if (skill === 'ruinedPortal') {"))
  const facts: Record<string, number> = {}
  const calls: Array<{ method: string, params: any }> = []
  let destination = { x: 0, y: 64, z: 0 }
  const context: any = { module: { exports: {} }, state: { pos: { ...destination } }, known: {},
    lavaScoutCells: new Set(), lavaScoutViews: 0, dim: () => 'overworld', skyLavaLook: async () => null,
    graphFact: (name, value) => { facts[name] = value },
    act: async (method, params) => { calls.push({ method, params }); if (method === 'explore') context.state.pos = { ...destination } }
  }
  vm.runInNewContext(transformSync(`module.exports = async () => { ${branch} }`, { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, facts, run: context.module.exports, destination: p => { destination = p } }
}

test('lava scouting credits newly observed sections, preserving the deadline and surface route', async () => {
  const f = fixture()
  f.destination({ x: 60, y: 64, z: 0 })
  await f.run()
  assert.equal(f.facts.lava_scout_views, 1)
  assert.equal(f.calls[1].params.timeoutSeconds, 90)
  assert.equal(f.calls[1].params.surface, true)
  f.destination({ x: 120, y: 64, z: 0 })
  await f.run()
  assert.equal(f.facts.lava_scout_views, 2)
})

test('standing still, drift within a section, and revisiting an old section do not advance lava scouting', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.facts.lava_scout_views, 0)
  f.destination({ x: 1, y: 64, z: 1 }); await f.run()
  assert.equal(f.facts.lava_scout_views, 0)
  f.destination({ x: 60, y: 64, z: 0 }); await f.run()
  f.destination({ x: 0, y: 64, z: 0 }); await f.run()
  assert.equal(f.facts.lava_scout_views, 1)
})

test('the actual director continues useful lava-search legs without its five-minute failure backoff', () => {
  const brain = createCampaignIntelligence({ observe: async () => ({ state: {} }), call: async () => ({}),
    execute: async () => ({ outcome: 'SUCCESS', events: [] }), now: () => 0, sleep: async () => {}, record() {}, eyes: 12, beds: 7 })
  const strategy = brain.registry.get('ScoutLava')!
  const before = emptyWorld()
  const stationary = structuredClone(before)
  stationary.facts.lava_scout_views = fact(0, 'observed', 0)
  assert.equal(strategy.progressCondition!(before, stationary), false)
  before.facts.lava_scout_views = fact(0, 'observed', 0)
  let previous = before
  for (let i = 1; i <= 6; i++) {
    const after = structuredClone(previous)
    after.facts.lava_scout_views = fact(i, 'observed', i)
    assert.equal(brain.director.verify(strategy, previous, after, { outcome: 'SUCCESS', events: [] }), 'PARTIAL')
    previous = after
  }
  assert.deepEqual(brain.director.exhaustedStrategies(), [])
  assert.equal(brain.director.verify(strategy, previous, previous, { outcome: 'SUCCESS', events: [] }), 'FAILURE')
  assert.equal(brain.director.verify(strategy, previous, previous, { outcome: 'SUCCESS', events: [] }), 'FAILURE')
  assert.deepEqual(brain.director.exhaustedStrategies(), ['ScoutLava'])
})
