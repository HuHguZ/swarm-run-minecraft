import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { speedrunRegistry } from '../src/core/speedrun'
import { emptyWorld, fact } from '../src/core/world-state'

function fixture(kind = 'village', completed = false) {
  const file = path.resolve(__dirname, '../campaign.ts')
  const source = fs.readFileSync(file, 'utf8')
  const start = source.indexOf('async function executeStrategy (')
  const end = source.indexOf('\nconst intelligence =', start)
  assert.ok(start >= 0 && end > start)
  let now = 34600
  const at = { x: 75, y: 65, z: 61 }
  const facts: any = { [kind]: fact(true, 'observed', 0), [`${kind}_position`]: fact(at, 'observed', 0) }
  const calls: any[] = []
  const state = { pos: { x: 21, y: 65, z: 28 } }
  const context: any = {
    module: { exports: {} }, require: createRequire(file), __dirname: path.dirname(file), path,
    strategyExecuting: false, strategyInterrupted: false, died: false,
    graphFacts: facts, graphFact(name, value) { facts[name] = fact(value, 'observed', now) },
    routeStructureSeconds: 34.6, routeDeadline: 0, stage: 'iron', state,
    gameClock: { now: () => now }, campaignMap: () => null, log() {},
    async routeStep() { now += 1000; return completed },
    async act(method, params) {
      calls.push({ method, params })
      if (method === 'structure' && params.mode === 'list') return { detail: { known: [{ kind: kind === 'treasure' ? 'buried_treasure' : kind, at, done: false }] } }
      if (method === 'explore') { now += params.timeoutSeconds * 1000; state.pos.x += 10 }
      return { detail: {} }
    }
  }
  vm.runInNewContext(transformSync(source.slice(start, end) + '\nmodule.exports = executeStrategy', { loader: 'ts', format: 'cjs' }).code, context, { filename: file })
  return { facts, calls, context, run: (skill: string, signal = new AbortController().signal) => context.module.exports({ skill, strategy: skill, params: { kind } }, signal) }
}

test('a failed physical approach does not exhaust an unvisited resource structure', async () => {
  const f = fixture()
  assert.equal((await f.run('structureIron')).outcome, 'FAILURE')
  assert.equal(f.facts.village_exhausted, undefined)
  assert.equal(f.context.routeStructureSeconds, 35.6)
  assert.equal(f.context.stage, 'iron')
})

test('a completed resource visit retains exhaustion and its actual spent budget', async () => {
  const f = fixture('village', true)
  assert.equal((await f.run('structureIron')).outcome, 'SUCCESS')
  assert.equal(f.facts.village_exhausted.value, true)
  assert.equal(f.context.routeStructureSeconds, 35.6)
})

for (const visited of [false, true]) test(`a tactical cancellation preserves interruption after visit=${visited}`, async () => {
  const f = fixture(), ctl = new AbortController()
  f.context.routeStep = async () => { ctl.abort('tactical'); return visited }
  assert.equal((await f.run('structureIron', ctl.signal)).outcome, 'INTERRUPTED')
  assert.equal(f.facts.village_exhausted, undefined)
})

for (const kind of ['village', 'shipwreck', 'treasure']) test(`scouting past an exhausted ${kind} spends its remaining budget on physical discovery`, async () => {
  const f = fixture(kind)
  f.facts[`${kind}_exhausted`] = fact(true, 'observed', 0)
  await f.run('scoutStructures')
  assert.ok(f.calls.some(call => call.method === 'explore'))
  assert.equal(f.context.routeStructureSeconds, 180)
})

test('a closer physical approach is useful structure-iron progress, while waiting and retreating are not', () => {
  const registry = speedrunRegistry()
  for (const [id, name] of [['VillageIron', 'village'], ['ShipwreckIron', 'shipwreck'], ['TreasureIron', 'treasure']]) {
    const before = emptyWorld()
    before.dimension = 'overworld'
    before.position = { x: 0, y: 64, z: 0 }
    before.facts[`${name}_position`] = fact({ x: 75, y: 65, z: 61 }, 'observed', 0)
    const after = structuredClone(before)
    const progress = registry.get(id)!.progressCondition
    assert.equal(!!progress?.(before, after), false)
    after.position = { x: 21, y: 65, z: 28 }
    assert.equal(!!progress?.(before, after), true)
    after.position = { x: -10, y: 64, z: 0 }
    assert.equal(!!progress?.(before, after), false)
    after.dimension = 'the_nether'
    assert.equal(!!progress?.(before, after), false)
  }
})
