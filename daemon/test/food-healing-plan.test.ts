import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import { speedrunRegistry, dragonGoal } from '../src/core/speedrun'
import { emptyWorld, stateKey, fact, applyEffect } from '../src/core/world-state'
import { plan } from '../src/core/strategy'
import { applyCosts } from '../src/core/cost-model'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'

function depleted(health = 12) {
  const state = emptyWorld()
  Object.assign(state, { health, hunger: 8, position: { x: 68, y: 101, z: 116 }, structureSearchMs: 180550 })
  state.inventory = { iron_ingot: 1, iron_pickaxe: 1, iron_sword: 1, bucket: 1, cobblestone: 279, birch_log: 8 }
  state.resources = { wood: 10, stone_tool: 3, iron: 1, iron_pick: 1, food: 0, food_points: 0, bucket: 1, blocks: 313, shield: 1 }
  state.facts = { nether_tools_ready: fact(true, 'observed', 0), blaze_allowed: fact(true, 'observed', 0), night: fact(true, 'observed', 0) }
  return state
}

test('planning distinguishes the health restored by an eighteen-HP refuge', () => {
  assert.notEqual(stateKey(depleted(16)), stateKey(depleted(18)))
})
test('healing remains executable at twelve HP and only succeeds after its real target is reached', () => {
  const heal = speedrunRegistry().get('Heal')!, before = depleted()
  assert.equal(heal.preconditions(before), false, 'no carried food still cannot regenerate health')
  before.resources.food = 8
  assert.equal(heal.preconditions(before), true)
  assert.equal(heal.successCondition(before, before), false, 'unchanged HP must not report healing')
  assert.equal(heal.successCondition(before, { ...before, health: 18 }), true)
  assert.equal(heal.preconditions({ ...before, health: 18 }), false)
})
test('food acquisition predicts the body preparation target without inventing hunger or unseen items', () => {
  const before = depleted(), find = speedrunRegistry().get('FindFood')!
  const effects = typeof find.expectedEffects === 'function' ? find.expectedEffects(before) : find.expectedEffects
  const after = applyEffect(before, effects)
  assert.equal(after.resources.food, 8)
  assert.equal(after.resources.food_points, 16)
  assert.equal(after.hunger, 8)
  assert.deepEqual(after.inventory, before.inventory)
})
test('a missing flint prices exploration; a carried flint leaves the short recipe available', () => {
  const registry = speedrunRegistry(), kit = registry.get('CraftPortalKit')!, scout = registry.get('ScoutLava')!, before = depleted()
  assert.equal(kit.preconditions(before), true, 'low HP changes price, not recipe eligibility')
  assert.equal(kit.estimateCost(before), 400 + scout.estimateCost(before))
  assert.equal(kit.estimateRisk(before), scout.estimateRisk(before))
  const supplied = { ...before, inventory: { ...before.inventory, flint: 1 } }
  assert.equal(kit.estimateCost(supplied), 400)
  assert.equal(kit.estimateRisk(supplied), 0)
  const gravel = { ...before, inventory: { ...before.inventory, gravel: 8 } }
  assert.equal(kit.estimateCost(gravel), 400, 'carried gravel uses the local grinder without another exploration')
  assert.equal(kit.estimateRisk(gravel), 0)
})
test('remaining health continuously changes exposure instead of treating twelve HP as full health', () => {
  const scout = speedrunRegistry().get('ScoutLava')!
  assert.ok(scout.estimateRisk(depleted(20)) < scout.estimateRisk(depleted(16)))
  assert.ok(scout.estimateRisk(depleted(16)) < scout.estimateRisk(depleted(12)))
})
test('recorded food costs make a depleted run recover before flint search while a healthy run continues', () => {
  const registry = speedrunRegistry()
  // Fixed receipts from the failed farm continuation's imported food dataset.
  applyCosts(registry, [
    { key: 'food@overworld@healthy', samples: 93, successes: 25, deaths: 0, deathSamples: 93, medianTicks: 922, p90Ticks: 1422 },
    { key: 'food@overworld@wounded', samples: 21, successes: 0, deaths: 1, deathSamples: 21, medianTicks: 138, p90Ticks: 1294 }
  ])
  for (const health of [8, 12, 16]) {
    const selected = plan(registry, depleted(health), dragonGoal)
    assert.equal(selected.reason, 'goal')
    assert.deepEqual(selected.steps.slice(0, 3).map(s => s.id), ['FindFood', 'Heal', 'CraftPortalKit'])
  }
  assert.equal(plan(registry, depleted(20), dragonGoal).steps[0]?.id, 'CraftPortalKit')
})
test('the actual Heal executor asks the body for the same eighteen-HP target as the graph', async () => {
  const source = campaignTs()
  const executor = source.slice(source.indexOf('async function executeStrategy ('), source.indexOf('const intelligence = createCampaignIntelligence('))
  let target: number | undefined
  const context: any = { strategyExecuting: false, strategyInterrupted: false, rest: async (hp: number) => { target = hp } }
  vm.runInNewContext(executor, cjsContext(withSetters(context)))
  const result = await context.executeStrategy({ skill: 'heal' }, new AbortController().signal)
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(target, 18)
})
test('actual rest at sixteen HP continues to the selected target while ordinary rest keeps its sixteen-HP default', async () => {
  const source = campaignTs()
  const body = source.slice(source.indexOf('async function rest ('), source.indexOf('let nightSatUntil'))
  const context: any = { resting: false, died: false, state: { health: 16, food: 12, playPolicy: { mode: 'speedrun' } },
    sit: { foes: 0, night: false }, gameClock: { now: () => 1 }, blazeDugInAt: -Infinity, blazeDugInPos: null,
    sense: async () => {}, log: () => {}, dim: () => 'overworld', have: (pattern: RegExp) => pattern.test('bread') ? 8 : 0, FOOD: /bread/, RAW: /beef/,
    routeHealing: false, known: {}, process: { env: {} }, meals: 0, targets: [],
    act: async (skill: string) => { assert.equal(skill, 'eat'); context.meals++; context.state.food = 20 },
    refugeRun: async (_why: string, options: any) => { context.targets.push(options.minHp); context.state.health = options.minHp } }
  vm.runInNewContext(body, cjsContext(withSetters(context)))
  await context.rest()
  assert.equal(context.meals, 0)
  await context.rest(18)
  assert.equal(context.meals, 1)
  assert.deepEqual(context.targets, [18])
  assert.equal(context.state.health, 18)
  assert.equal(context.resting, false)
})
