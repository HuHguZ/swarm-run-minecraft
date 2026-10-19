import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSkillSample } from '../../farm/analysis/strategy-costs'
import { learnCosts, applyCosts } from '../src/core/cost-model'
import { speedrunRegistry } from '../src/core/speedrun'
import { emptyWorld } from '../src/core/world-state'

test('cost import normalizes proven game duration and excludes unknown accelerated wall time or no-ops', () => {
  const row = { level: 'step', kind: 'village', sec: 2, ok: true, before: { dim: 'overworld', hp: 20 } }
  assert.equal(normalizeSkillSample(row), null)
  assert.equal(normalizeSkillSample(row, 20)?.ticks, 40)
  assert.equal(normalizeSkillSample({ ...row, clock: 'game', tickRate: 750 })?.ticks, 40)
  assert.equal(normalizeSkillSample({ ...row, clock: 'wall' }, 20), null)
  assert.equal(normalizeSkillSample({ ...row, clock: 'wall', tickRate: 200 })?.ticks, 400)
  assert.equal(normalizeSkillSample({ ...row, sec: 0 }, 20), null)
  assert.equal(normalizeSkillSample({ level: 'act', skill: 'goto', sec: 20, ok: true }, 20), null)
})

test('learned route costs use complete step durations and alter the registered graph cost', () => {
  const row = { level: 'step', kind: 'village', sec: 50, ok: true, before: { dim: 'overworld', hp: 20 } }
  const sample = normalizeSkillSample(row, 20)!
  const models = learnCosts(Array.from({ length: 10 }, () => sample))
  const registry = speedrunRegistry()
  const strategy = registry.get('VillageIron')!
  const world = emptyWorld()
  const before = strategy.estimateCost(world)
  applyCosts(registry, models)
  assert.equal(models.find(model => model.key === 'village')?.medianTicks, 1000)
  assert.notEqual(strategy.estimateCost(world), before)
  assert.ok(strategy.estimateCost(world) > 1000)
})

test('missing death fields cannot dilute mortality while explicitly observed survival can', () => {
  const row = { level: 'step', kind: 'village', sec: 50, ok: true }
  const registry = speedrunRegistry()
  const world = emptyWorld()
  const before = registry.get('VillageIron')!.estimateRisk(world)
  const samples = Array.from({ length: 10 }, () => normalizeSkillSample(row, 20)!)
  assert.equal(samples[0]!.death, undefined)
  const models = learnCosts(samples)
  assert.equal(models[0]!.deathSamples, 0)
  applyCosts(registry, models)
  assert.equal(registry.get('VillageIron')!.estimateRisk(world), before)
  const observed = speedrunRegistry()
  applyCosts(observed, learnCosts(samples.map(sample => ({ ...sample, death: false }))))
  assert.ok(observed.get('VillageIron')!.estimateRisk(world) < before)
})
