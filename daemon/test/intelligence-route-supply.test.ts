import { campaignTs, setterSource } from './campaign-source'
import { declSource, functionSource } from './source-fixture'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as esbuild from 'esbuild'
import { Vec3 } from 'vec3'
const mcData = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
import * as items from '../src/items'
import tunnel = require('../src/tunnel')
import { netherToolsReady } from '../src/campaign/nether-supply'
import { speedrunRegistry } from '../src/core/speedrun'
import { plan } from '../src/core/strategy'
import { StrategicDirector } from '../src/core/strategy'
import { netherStageProgress } from '../src/campaign/nether-progress'
import { emptyWorld, fact, amount } from '../src/core/world-state'

function routeFixture(swings = 261, moveCount = 3) {
  const inventory: any[] = [
    { ...mcData.itemsByName.iron_pickaxe, count: 1, durabilityUsed: 0 },
    { ...mcData.itemsByName.stone_pickaxe, count: 1, durabilityUsed: 131 - (swings - 250) },
    { ...mcData.itemsByName.oak_planks, count: 8 }, { ...mcData.itemsByName.crafting_table, count: 1 },
    { ...mcData.itemsByName.iron_ingot, count: 7 }, { ...mcData.itemsByName.cobbled_deepslate, count: 2 }
  ]
  const bot = { game: { dimension: 'the_nether' }, health: 20, registry: mcData,
    ndPlayPolicy: { mode: 'speedrun' }, entities: {},
    entity: { position: new Vec3(-399.5, 20, 388.5), onGround: true },
    inventory: { items: () => inventory }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) }
  const session = { bot, mcData, playPolicy: { mode: 'speedrun' } }
  let now = 0; let executed = 0; let restocked = 0
  const grid = { mark() {} }
  const start = bot.entity.position.floored()
  const moves = Array.from({ length: moveCount }, (_, index) => ({ kind: 'flat', from: start.offset(-index, 0, 0),
    to: start.offset(-index - 1, 0, 0), dig: [[start.x - index - 1, 20, start.z], [start.x - index - 1, 21, start.z]] }))
  const planned = { path: moves, ok: false, limit: false, more: false, steps: moves.length }
  // routeTo — в nether-route/route.ts (фасад + части): текст функции по имени из склейки частей.
  const body = functionSource(path.join(__dirname, '../src/nether-route.js'), 'routeTo', { ts: true })
  assert.ok(body)
  const deps = {
    gameClock: { now: () => now }, gridOf: () => grid, C: { BLOCK: 1 }, feetCell: (current: typeof bot) => current.entity.position.floored(),
    budgetOn: () => false, bastionZones: () => [], liveDangers: () => [], spawnerHot: () => [],
    receiptCostFor: () => ({ context: 'fixture', costs: { seconds: () => 0 } }), log() {},
    inLava: () => false, syncAround: () => 0, plan: async () => planned, makeRoom: async () => undefined,
    threatCheck: async () => false, eatIfLow: async () => undefined,
    xyz: (position: { x: number; y: number; z: number }) => ({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }),
    async stepOne(_session: typeof session, _ctl: unknown, _grid: unknown, move: typeof moves[0], state: { dug: number }) {
      for (const ignored of move.dig) {
        const tool = inventory.find(item => item.name === 'stone_pickaxe') || inventory.find(item => item.name === 'iron_pickaxe')
        if (tool) { tool.durabilityUsed = (tool.durabilityUsed || 0) + 1; if (tool.durabilityUsed >= tool.maxDurability) inventory.splice(inventory.indexOf(tool), 1) }
        state.dug++
      }
      bot.entity.position = move.to.offset(.5, 0, .5); now += 1000; executed++
      return 'ok'
    }
  }
  const load = (name: string) => name === './ne-guard' ? { swatInstall() {}, attach() {}, hot: () => null, meleeFoes: () => [] }
    : name === './blaze' ? { hasEffect: () => false }
      : name === './tunnel' ? { ...tunnel, restockPicks: async () => { restocked++; return 0 } }
        : name === './sealed' ? { FILL_NAMES: ['netherrack'] } : require(path.join(__dirname, '../src', name))
  const compiled = esbuild.transformSync(body, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  const run = new Function('require', ...Object.keys(deps), compiled + '\nreturn routeTo')(load, ...Object.values(deps))
  return { bot, session, run: (reserved: boolean, target?: { x: number; y: number; z: number; r: number; dy: number }) => run(session, { aborted: false },
    { x: -415, y: 36, z: 414, r: 4, dy: 3, timeoutSeconds: 60, supplyReserve: reserved, ...target }),
    executed: () => executed, restocked: () => restocked }
}

test('Bastion route yields actual 259 swings to the existing supply graph before the next step', async () => {
  // A long plan (300 digs) still needs the full 260 reserve: the reserve follows the remaining digs (s1c 06.10), capped at 260.
  const f = routeFixture(261, 150)
  const result = await f.run(true)
  assert.equal(f.executed(), 1, 'one bounded step crosses the actual reserve; the next step must wait for supply')
  assert.equal(items.toolBudget(f.bot, 'pickaxe'), 259)
  assert.equal(result.supplyNeeded?.pickSwings, 259)
  assert.equal(result.ok, false)
  assert.ok(f.restocked() > 0, 'a calm nearby target must still try the existing replenisher')
  const inventory = items.countItems(f.bot)
  assert.equal(inventory.oak_planks, 8)
  assert.equal(inventory.crafting_table, 1)
  assert.equal(inventory.iron_ingot, 7)
  const state = emptyWorld()
  state.dimension = 'the_nether'; state.inventory = inventory; state.resources = { pearls: 2, wood: 8, stone_tool: 1, food: 10 }
  const ready = netherToolsReady({ dimension: state.dimension, health: state.health, inventory, pickSwings: items.toolBudget(f.bot, 'pickaxe') })
  state.facts = { bastion: fact(true, 'map', 0), nether_ready: fact(true, 'observed', 0),
    nether_tools_ready: fact(ready, 'observed', 0), nether_pick_swings: fact(259, 'observed', 0) }
  assert.equal(ready, false)
  assert.equal(plan(speedrunRegistry({ eyes: 10 }), state, current => amount(current, 'pearls') >= 10).steps[0]?.id, 'AcquireNetherTools')
})

test('exactly 260 actual swings permits one bounded step before truthful supply handoff', async () => {
  const f = routeFixture(260, 150)
  const result = await f.run(true)
  assert.equal(f.executed(), 1)
  assert.equal(result.supplyNeeded?.pickSwings, 258)
})

test('ordinary home routes retain their existing movement contract', async () => {
  const f = routeFixture()
  const result = await f.run(false)
  assert.equal(f.executed(), 3)
  assert.equal(result.supplyNeeded, undefined)
})

test('s1c: arrival is arrival — no supply stop invented after the target is reached; a short plan needs only its own digs', async () => {
  const f = routeFixture(261, 1)
  const result = await f.run(true, { x: -401, y: 20, z: 388, r: 0, dy: 0 })
  assert.equal(f.executed(), 1)
  assert.equal(result.ok, true)
  assert.equal(result.supplyNeeded, undefined)
  // 3 moves × 2 digs: 259 swings cover them many times over — the route goes on (was: stop at 259 / 260 by a fixed cap).
  const short = routeFixture(261, 3)
  const r2 = await short.run(true)
  assert.equal(short.executed(), 3)
  assert.equal(r2.supplyNeeded, undefined)
})

function restockSource(bot: ReturnType<typeof routeFixture>['bot']) {
  const source = fs.readFileSync(path.join(__dirname, '../src/tunnel.ts'), 'utf8')
  const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  const module = { exports: {} as typeof tunnel }
  const take = (name: string, count: number) => {
    const item = bot.inventory.items().find(owned => owned.name === name)
    assert.ok(item && item.count >= count)
    item.count -= count
    if (!item.count) bot.inventory.items().splice(bot.inventory.items().indexOf(item), 1)
  }
  const add = (name: string, count: number) => {
    const existing = bot.inventory.items().find(owned => owned.name === name)
    if (existing && !name.endsWith('_pickaxe')) existing.count += count
    else bot.inventory.items().push({ ...mcData.itemsByName[name], count, durabilityUsed: 0 })
  }
  const craft = async (_session: unknown, _ctl: unknown, { item }: { item: string }) => {
    if (item === 'stick') { take('oak_planks', 2); add('stick', 4) }
    else if (item === 'crafting_table') { take('oak_planks', 4); add(item, 1) }
    else if (item === 'stone_pickaxe') { take('blackstone', 3); take('stick', 2); add(item, 1) }
    else throw new Error('unexpected craft ' + item)
  }
  new Function('require', 'module', 'exports', compiled)(
    (name: string) => name === './actions' ? { craft } : require(path.join(__dirname, '../src', name)), module, module.exports)
  return module.exports
}

test('shared restock retains eight planks only for the explicit resource route', async () => {
  const reserved = routeFixture()
  reserved.bot.inventory.items().push({ ...mcData.itemsByName.blackstone, count: 6 })
  const source = restockSource(reserved.bot)
  assert.equal(await source.restockPicks(reserved.session, { aborted: false }, 2, { reservePlanks: 8 }), 0)
  assert.equal(source.pickBudget(reserved.bot, mcData, { reservePlanks: 8 }).craftable, 0)
  assert.equal(items.countItems(reserved.bot).oak_planks, 8)
  assert.equal(items.countItems(reserved.bot).crafting_table, 1)
  const ordinary = routeFixture()
  ordinary.bot.inventory.items().push({ ...mcData.itemsByName.blackstone, count: 6 })
  assert.equal(await restockSource(ordinary.bot).restockPicks(ordinary.session, { aborted: false }, 2), 2)
  assert.equal(items.countItems(ordinary.bot).oak_planks, 6, 'ordinary callers keep their existing optional-reserve contract')
})

test('missing table costs four additional planks in both the budget and actual replenisher', async () => {
  const f = routeFixture()
  f.bot.inventory.items().splice(f.bot.inventory.items().findIndex(item => item.name === 'crafting_table'), 1)
  f.bot.inventory.items().push({ ...mcData.itemsByName.stick, count: 8 }, { ...mcData.itemsByName.blackstone, count: 6 })
  const source = restockSource(f.bot)
  assert.equal(source.pickBudget(f.bot, mcData, { reservePlanks: 8 }).craftable, 0)
  assert.equal(await source.restockPicks(f.session, { aborted: false }, 2, { reservePlanks: 8 }), 0)
  assert.equal(items.countItems(f.bot).oak_planks, 8)
  assert.ok(source.pickBudget(f.bot, mcData).craftable > 0)
})

test('Bastion saves confirmed route cells and returns supplyNeeded before legacy fallback', async () => {
  // Ход по сетке к известному золоту — routeToGold в bastion/run-approach.ts (подход — a, состояние вызова bastion() — bx).
  const source = declSource(require.resolve('../src/bastion/run-approach'), 'routeToGold')
  assert.ok(source.includes('async function routeToGold('))
  const f = routeFixture()
  const supplyNeeded = { pickSwings: 259, requiredSwings: 260, woodEquivalent: 8, requiredWood: 8, table: true }
  const own = new Set(['-399,20,388', '-399,21,388'])
  let saved = false; let receivedFlag = false
  const state: Record<string, any> = {}
  const a = { nearG: { x: -415, y: 36, z: 414 }, far1: 30, goal: { x: -415, y: 36, z: 414 }, KG0: [{ x: -415, y: 36, z: 414 }], routed: false,
    NR: { enabled: () => true, gridOf: () => ({}), async routeTo(_session: unknown, _ctl: unknown, params: { supplyReserve: boolean }) {
      receivedFlag = params.supplyReserve; return { ok: false, why: 'supply', own, supplyNeeded } } } }
  const bx = { bot: f.bot, session: f.session, ctl: { aborted: false }, st: state, deadline: 1000000 }
  const deps = { gameClock: { now: () => 0 },
    lavaWatched: async (_bot: unknown, ctl: unknown, run: (ctl: unknown) => Promise<unknown>) => run(ctl),
    report: (_bx: unknown, stopped: string) => ({ stopped, supplyNeeded: state.supplyNeeded }), log() {} }
  const routeToGold = new Function('require', ...Object.keys(deps), source + '\nreturn routeToGold')(
    (name: string) => name.endsWith('sealed') ? { exposure: () => [] } : name.endsWith('tunnel') ? { rememberOwn: () => { saved = true } } : require(name),
    ...Object.values(deps))
  const result = (await routeToGold(bx, a)) || { fallback: true }
  assert.equal(receivedFlag, true)
  assert.equal(result.fallback, undefined)
  assert.equal(result.supplyNeeded, supplyNeeded)
  assert.equal(saved, true)
  assert.deepEqual(state.sealedState.own, own)
})

function campaignSupplyReceipt(state, needed: boolean) {
  const source = campaignTs()
  const start = source.indexOf('    const d = r.detail || {}', source.indexOf("const r = await act('bastion', { x: b.x"))
  const end = source.indexOf('    const approached =', start)
  const execute = source.match(/^async function executeStrategy\b[\s\S]*?^}/m)?.[0]
  assert.ok(start > 0 && end > start && execute)
  const body = `let strategyExecuting = false, strategyInterrupted = false, died = false, bastionGoldDug = 0, bastionIngotsTraded = 0;
    ${setterSource()}
    async function receipt() { ${source.slice(start, end)} }
    const STAGES = [{ name: 'bastion', run: receipt }];
    ${execute}\nreturn executeStrategy;`
  const compiled = esbuild.transformSync(body, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  let sensedSwings = 261
  const deps = { r: { status: 'done', detail: needed ? { supplyNeeded: { pickSwings: 259 } } : {} },
    b: { key: 'бастион 2 (ад)' }, netherSupplyState: () => ({ dimension: state.dimension, health: state.health,
      inventory: state.inventory, pickSwings: sensedSwings }), sense: async () => { sensedSwings = state.facts.nether_pick_swings.value }, log() {} }
  const run = new Function(...Object.keys(deps), compiled)(...Object.values(deps))
  return run({ skill: 'bastion' }, new AbortController().signal)
}

test('two resource handoffs keep the same B2 eligible after actual supply without resetting real failures', async () => {
  const state = emptyWorld()
  state.dimension = 'the_nether'; state.inventory = { oak_planks: 8, crafting_table: 1, stone_pickaxe: 1, iron_pickaxe: 1 }
  state.resources = { pearls: 2, wood: 8, food: 10, stone_tool: 2 }
  state.facts = { bastion: fact(true, 'map', 0), nether_ready: fact(true, 'observed', 0), nether_tools_ready: fact(true, 'observed', 0),
    nether_pick_swings: fact(261, 'observed', 0), bastion_position: fact({ x: -411, y: 36, z: 413 }, 'map', 0) }
  let handoff = false
  const registry = speedrunRegistry({ eyes: 10 })
  const bastion = registry.get('BastionBarter')
  bastion.progressCondition = (before, after) => netherStageProgress('bastion', before, after)
  const environment = { observe: async () => state, cancel: async () => {}, sleep: async () => {}, now: () => 0,
    async execute() {
      if (handoff) { state.facts.nether_pick_swings = fact(259, 'observed', 1); state.facts.nether_tools_ready = fact(false, 'observed', 1) }
      return campaignSupplyReceipt(state, handoff)
    } }
  const director = new StrategicDirector(registry, environment, { goal: current => amount(current, 'pearls') >= 10 })
  assert.equal((await director.run(bastion)).outcome, 'FAILURE', 'one stationary refusal remains one real failure')
  handoff = true
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await director.run(bastion)
    assert.equal(result.outcome, 'INTERRUPTED')
    assert.match(result.result.reason, /ресурсный запас/)
    assert.deepEqual(result.result.events, [], 'resource replanning is not a fake tactical event')
    assert.equal(director.decide(state).steps[0]?.id, 'AcquireNetherTools')
    state.facts.nether_pick_swings = fact(261, 'observed', 2)
    state.facts.nether_tools_ready = fact(true, 'observed', 2)
    assert.equal(director.canRun(bastion, state), true)
  }
  handoff = false
  assert.equal((await director.run(bastion)).outcome, 'FAILURE')
  assert.equal(director.canRun(bastion, state), false, 'two true stationary failures still quarantine the same site')
})
