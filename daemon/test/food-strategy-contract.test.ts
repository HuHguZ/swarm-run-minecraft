import { declarationsOf } from './source-fixture'
import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import { worldFromObservation } from '../src/environments/mineflayer'
import { speedrunRegistry, travelTicks } from '../src/core/speedrun'
import { applyEffect, emptyWorld, fact, type WorldState } from '../src/core/world-state'
import { plan } from '../src/core/strategy'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { foodUnits } from '../src/play-policy'
const effect = (strategy: any, state: WorldState) => typeof strategy.expectedEffects === 'function' ? strategy.expectedEffects(state) : strategy.expectedEffects

test('graph food stock uses the same units as the body, including berries, melons and raw chicken', () => {
  for (const inventory of [{ sweet_berries: 18 }, { melon_slice: 18 }, { bread: 6 }, { chicken: 6 }]) {
    const world = worldFromObservation({ state: { health: 19, food: 6, inventory } }, 0)
    assert.equal(world.resources.food, foodUnits(inventory))
  }
})
test('eating a carried meal at high HP consumes real inventory and takes seven 32-tick bites', () => {
  const before = worldFromObservation({ state: { dimension: 'overworld', health: 19, food: 6, inventory: { sweet_berries: 18 } } }, 0)
  const eat = speedrunRegistry().get('EatFood')!
  assert.ok(eat)
  assert.equal(eat.preconditions(before), true)
  const after = applyEffect(before, effect(eat, before))
  assert.equal(eat.estimateCost(before), 7 * 32)
  assert.equal(after.hunger, 20)
  assert.equal(after.health, 19, 'a bite does not promise immediate regeneration')
  assert.equal(after.inventory.sweet_berries, 11)
  assert.equal(after.resources.food_points, 22)
  assert.ok(Math.abs(after.resources.food - foodUnits({ sweet_berries: 11 })) < .011)
})
test('one steak raises 12 hunger to 20 and cannot be eaten repeatedly in a predicted state', () => {
  const before = worldFromObservation({ state: { health: 19, food: 12, inventory: { cooked_beef: 1 } } }, 0)
  const eat = speedrunRegistry().get('EatFood')!
  assert.ok(eat)
  const after = applyEffect(before, effect(eat, before))
  assert.equal(after.hunger, 20)
  assert.equal(after.resources.food, 0)
  assert.equal(after.resources.food_points, 0)
  assert.equal(after.inventory.cooked_beef, 0)
  assert.equal(eat.preconditions(after), false)
  assert.equal(eat.preconditions(emptyWorld()), false)
})
test('dried kelp uses the native sixteen-tick consumable duration', () => {
  const before = worldFromObservation({ state: { health: 19, food: 6, inventory: { dried_kelp: 24 } } }, 0)
  const eat = speedrunRegistry().get('EatFood')!
  assert.equal(eat.estimateCost(before), 14 * 16)
  assert.equal(applyEffect(before, effect(eat, before)).inventory.dried_kelp, 10)
})
test('FindFood adds stock without inventing a full hunger bar or a specific unseen food', () => {
  const before = emptyWorld(); before.hunger = 6
  const registry = speedrunRegistry()
  const after = applyEffect(before, effect(registry.get('FindFood'), before))
  assert.equal(after.hunger, 6)
  assert.deepEqual(after.inventory, {})
  assert.ok(registry.get('EatFood'))
  assert.equal(registry.get('EatFood')!.preconditions(after), true)
  const eaten = applyEffect(after, effect(registry.get('EatFood'), after))
  assert.ok(eaten.hunger > after.hunger && eaten.hunger <= 20)
  assert.ok(eaten.resources.food < after.resources.food)
})
test('PrepareNether prices its actual hunt and never grants an uncrafted iron pick', () => {
  const registry = speedrunRegistry()
  const prep = registry.get('PrepareNether')!
  const before = emptyWorld(); before.resources.stone_tool = 1; before.facts.portal = fact(true, 'observed', 0)
  const supplied = { ...before, resources: { ...before.resources, food: 8 } }
  const after = applyEffect(before, effect(prep, before))
  assert.equal(after.resources.iron_pick ?? 0, 0)
  assert.equal(prep.preconditions(before), true, 'insufficient food still leaves the real preparation alternative executable')
  assert.equal(prep.estimateCost(before) - prep.estimateCost(supplied), registry.get('FindFood')!.estimateCost(before))
})
test('eating competes with travel time: distant travel eats first, a short trip continues hungry', () => {
  const registry = speedrunRegistry()
  const world = worldFromObservation({ state: { dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, health: 19, food: 6,
    inventory: { sweet_berries: 18, water_bucket: 1, fire_charge: 1, stone_pickaxe: 1 } }, known: { lava: { x: 1000, y: 64, z: 0 } } }, 0)
  assert.deepEqual(plan(registry, world, s => s.facts.portal?.value === true).steps.map(s => s.id), ['EatFood', 'LavaPoolPortal'])
  world.facts.lava_position.value = { x: 1, y: 64, z: 0 }
  assert.deepEqual(plan(registry, world, s => s.facts.portal?.value === true).steps.map(s => s.id), ['LavaPoolPortal'])
  const fed = { ...world, hunger: 20 }
  assert.equal(travelTicks(world, 'LavaPoolPortal') / travelTicks(fed, 'LavaPoolPortal'), 1.3)
})
function bodyFixture(afterBite: (signal: AbortController) => void = () => {}) {
  const source = campaignTs()
  const helper = declarationsOf(source, 'eatTo') + '\n'
  const executor = source.slice(source.indexOf('async function executeStrategy ('), source.indexOf('const intelligence = require('))
  const controller = new AbortController()
  const context: Record<string, any> = { state: { health: 19, food: 6 }, died: false, strategyExecuting: false, strategyInterrupted: false,
    FOOD: /dried_kelp/, RAW: /beef|chicken/, bites: 0, have: () => 24, rest: async () => assert.fail('high HP meal must not call the early-returning rest'),
    act: async (skill: string) => { assert.equal(skill, 'eat'); context.bites++; context.state.food++; afterBite(controller) } }
  vm.runInNewContext(helper + executor, cjsContext(withSetters(context)))
  return { context, controller }
}
test('the actual campaign EatFood executor fills high-HP hunger using fourteen one-point bites', async () => {
  const { context, controller } = bodyFixture()
  const result = await context.executeStrategy({ skill: 'eatFood' }, controller.signal)
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(context.state.food, 20)
  assert.equal(context.bites, 14, 'the old six-bite cap leaves the real bar at 12')
})
test('the actual EatFood executor yields immediately after cancellation between bites', async () => {
  const { context, controller } = bodyFixture(signal => signal.abort('tactical'))
  const result = await context.executeStrategy({ skill: 'eatFood' }, controller.signal)
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.equal(context.bites, 1)
})
test('the actual meal continues when a delayed slot receipt confirms food spent without a new bar packet', async () => {
  const { context, controller } = bodyFixture()
  context.act = async () => {
    context.bites++
    if (context.bites === 2) return { detail: { spent: 1 } }
    context.state.food = Math.min(20, context.state.food + 2)
    return { detail: { spent: 1 } }
  }
  await context.executeStrategy({ skill: 'eatFood' }, controller.signal)
  assert.equal(context.state.food, 20)
  assert.equal(context.bites, 8)
})
test('the actual meal accepts raw meat when it is the only carried edible food', async () => {
  const { context, controller } = bodyFixture()
  context.have = (re: RegExp) => re.test('beef') ? 6 : 0
  context.act = async () => { context.bites++; context.state.food = Math.min(20, context.state.food + 3); return { detail: { spent: 1 } } }
  await context.executeStrategy({ skill: 'eatFood' }, controller.signal)
  assert.equal(context.state.food, 20)
  assert.equal(context.bites, 5)
})
test('slot acknowledgements cannot exhaust the meal loop before twenty actual one-point bites', async () => {
  const { context, controller } = bodyFixture()
  context.state.food = 0
  context.act = async () => {
    context.bites++
    if (context.bites % 2) context.state.food++
    return { detail: { spent: 1 } }
  }
  await context.executeStrategy({ skill: 'eatFood' }, controller.signal)
  assert.equal(context.state.food, 20)
  assert.equal(context.bites, 39)
})
test('the real Session cannot enable sprint from carried food at hunger six', () => {
  const { Session }: typeof import('../src/session') = require('../src/session')
  const { Vec3 }: typeof import('vec3') = require('vec3')
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const session = new Session({ lowHealth: 8 }, { drain: () => [] }, { state: {}, patch() {} })
  const bot: any = { version: '1.21.11', health: 19, food: 6, registry, game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [{ name: 'bread', count: 6, type: registry.itemsByName.bread.id }] },
    entities: {}, world: { getColumn: () => null }, blockAt: () => null, pathfinder: { setMovements(m: any) { this.movements = m } } }
  session.bot = bot; session.bridgeWanted = false
  session.updateMovements(true)
  assert.equal(bot.pathfinder.movements.allowSprinting, false)
  bot.food = 7
  session.updateMovements(true)
  assert.equal(bot.pathfinder.movements.allowSprinting, true)
})
