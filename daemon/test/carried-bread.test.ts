import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { speedrunRegistry } from '../src/core/speedrun'
import { applyEffect, emptyWorld } from '../src/core/world-state'
import { worldFromObservation } from '../src/environments/mineflayer'
import { plan } from '../src/core/strategy'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
const effects = (strategy: any, state: any) => typeof strategy.expectedEffects === 'function' ? strategy.expectedEffects(state) : strategy.expectedEffects

test('carried hay becomes three real bread without pretending the player has already eaten', () => {
  const registry = speedrunRegistry(), prepare = registry.get('PrepareBread')
  assert.ok(prepare, 'the graph must know how to prepare carried food ingredients')
  const before = worldFromObservation({ state: { dimension: 'overworld', health: 9, food: 12, inventory: { hay_block: 1, crafting_table: 1 } } }, 0)
  assert.equal(before.resources.food, 0)
  assert.equal(prepare.preconditions(before), true)
  const after = applyEffect(before, effects(prepare, before))
  assert.equal(after.inventory.hay_block, 0)
  assert.equal(after.inventory.wheat, 0)
  assert.equal(after.inventory.bread, 3)
  assert.equal(after.resources.food, 2.5)
  assert.equal(after.resources.food_points, 15)
  assert.equal(after.hunger, 12)
  assert.equal(after.health, 9)
  assert.equal(prepare.preconditions(after), false, 'the same hay cannot be crafted twice in the forecast')
  assert.equal(prepare.successCondition(before, before), false)
  assert.equal(prepare.successCondition(before, after), true)
  assert.ok(registry.get('EatFood')!.preconditions(after))
  assert.ok(registry.get('Heal')!.preconditions(after))
  assert.equal(plan(registry, before, state => state.resources.food > 0, { maxDepth: 1 }).steps[0]?.id, 'PrepareBread')
})

test('bread preparation requires ingredients and a physically available crafting table recipe', () => {
  const prepare = speedrunRegistry().get('PrepareBread')
  assert.ok(prepare)
  for (const inventory of [{}, { wheat: 2, crafting_table: 1 }, { hay_block: 1 }]) {
    const before = emptyWorld(); before.inventory = inventory
    assert.equal(prepare.preconditions(before), false)
  }
  const before = emptyWorld(); before.inventory = { wheat: 3, bread: 4, crafting_table: 1 }
  assert.equal(prepare.preconditions(before), true)
  const after = applyEffect(before, effects(prepare, before))
  assert.equal(after.inventory.bread, 5, 'craft count is additive, not a target total')
  assert.equal(after.inventory.wheat, 0)
})

test('making a missing table conserves carried wood and a failed wheat conversion remains real progress', () => {
  const prepare = speedrunRegistry().get('PrepareBread')!
  const before = worldFromObservation({ state: { inventory: { hay_block: 1, oak_planks: 4 } } }, 0)
  assert.equal(prepare.preconditions(before), true)
  const after = applyEffect(before, effects(prepare, before))
  assert.equal(after.inventory.oak_planks, 0)
  assert.equal(after.inventory.crafting_table, 1)
  assert.equal(after.resources.wood, 0)
  assert.equal(after.resources.blocks, 0)
  const interrupted = { ...before, inventory: { wheat: 9, crafting_table: 1 } }
  assert.equal(prepare.progressCondition!(before, interrupted), true)
  assert.equal(prepare.successCondition(before, interrupted), false)
  assert.equal(prepare.preconditions(interrupted), true)
})

test('the actual bread executor uses the shared conversion plan and yields tactical cancellation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const executor = source.slice(source.indexOf('async function executeStrategy ('), source.indexOf('const intelligence = require('))
  const calls: any[] = []
  const state = { inventory: { hay_block: 1, crafting_table: 1 } }
  const context: any = { state, strategyExecuting: false, strategyInterrupted: false, STAGES: [],
    require, path, __dirname: path.resolve(__dirname, '..'),
    craft: async (...args: any[]) => { calls.push(args); state.inventory = { bread: 3, crafting_table: 1 } as any; return true } }
  vm.runInNewContext(executor, context)
  assert.equal((await context.executeStrategy({ skill: 'prepareBread' }, new AbortController().signal)).outcome, 'SUCCESS')
  assert.deepEqual(calls, [['bread', 3]])
  context.state.inventory = { hay_block: 1, crafting_table: 1 }
  context.craft = async () => { throw Object.assign(new Error('TACTICAL'), { strategyInterrupted: true }) }
  assert.equal((await context.executeStrategy({ skill: 'prepareBread' }, new AbortController().signal)).outcome, 'INTERRUPTED')
  context.craft = async () => false
  assert.equal((await context.executeStrategy({ skill: 'prepareBread' }, new AbortController().signal)).outcome, 'FAILURE')
})

test('campaign recovery prepares carried hay even while hunting is unavailable, then eats the real bread', async () => {
  const observation: any = { state: { dimension: 'overworld', health: 9, food: 12, inventory: { hay_block: 1, crafting_table: 1 } } }
  const calls: string[] = []
  const intelligence = createCampaignIntelligence({ eyes: 12, beds: 7, now: () => 0, sleep: async () => {}, record() {},
    observe: async () => observation, call: async () => ({}), execute: async command => {
      calls.push(command.skill)
      if (command.skill === 'prepareBread') observation.state.inventory = { bread: 3, crafting_table: 1 }
      if (command.skill === 'eatFood') { observation.state.food = 20; observation.state.inventory = { bread: 1, crafting_table: 1 } }
      return { outcome: 'SUCCESS', events: [] }
    } })
  intelligence.director.options.goal = state => state.hunger === 20
  const selected = await intelligence.select([], () => true)
  assert.equal(selected?.strategy?.id, 'PrepareBread')
  await selected!.stage.run()
  const eat = await intelligence.select([], () => true)
  assert.equal(eat?.strategy?.id, 'EatFood')
  await eat!.stage.run()
  assert.deepEqual(calls, ['prepareBread', 'eatFood'])
  assert.equal(observation.state.food, 20)
})
