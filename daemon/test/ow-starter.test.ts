import { REPO_ROOT } from '../src/paths'
export {}
'use strict'
// Runs the actual wood stage with 1.21.11 recipes, without a server or writes to daemon/.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module'), test = require('node:test'), assert = require('node:assert/strict')
const root = REPO_ROOT, req = createRequire(path.join(root, 'package.json'))
const { transformSync } = req('esbuild'), data = createRequire(path.join(root, 'daemon/package.json'))('minecraft-data')('1.21.11')
const file = 'daemon/campaign/stages/overworld.ts'
const overlay = process.env.S_BASELINE === '1' || !fs.existsSync(path.join(__dirname, 'S-wood.overlay.json')) ? {} : JSON.parse(fs.readFileSync(path.join(__dirname, 'S-wood.overlay.json'), 'utf8'))
const source = overlay[file] ?? fs.readFileSync(path.join(root, file), 'utf8')
const body = source.slice(source.indexOf('let woodRoofed ='), source.indexOf("defStage('stone'"))

function fixture(initial: Record<string, number> = {}, options: any = {}) {
  const inventory = { ...initial }, calls = [], state = { inventory, pos: { x: 0, y: 65, z: 0 }, playPolicy: { mode: options.mode || 'speedrun' } }
  const stages: any = {}
  // RegExps created inside vm belong to a different realm.
  const count = name => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof name === 'string' ? name === k : name.test(k)) ? v : 0), 0)
  const craft = async (name, amount = 1) => {
    calls.push(['craft', { item: name, count: amount }])
    const recipes = data.recipes[data.itemsByName[name]?.id] || []
    for (const recipe of recipes) {
      const ingredients = (recipe.ingredients || recipe.inShape.flat()).filter(i => i !== null)
      const times = Math.ceil(amount / recipe.result.count), costs: Record<string, number> = {}
      for (const id of ingredients) { const k = data.items[id].name; costs[k] = (costs[k] || 0) + times }
      if (Object.entries(costs).some(([k, n]) => (inventory[k] || 0) < n)) continue
      for (const [k, n] of Object.entries(costs)) inventory[k] -= n
      inventory[name] = (inventory[name] || 0) + times * recipe.result.count
      return true
    }
    return false
  }
  const ctx: any = {
    process: { env: { ...(!options.off ? { ND_OW_STARTER: '1' } : {}) } },
    state, sit: { surface: options.surface !== false, night: false }, known: {}, died: false, strategyInterrupted: false,
    have: count, dim: () => options.dimension || 'overworld', rodsNow: () => 0, shieldOn: () => false, owFastTrack: () => false,
    LOGS: /_(log|stem)$/, woodNow: () => count(/_(log|stem)$/) + Math.floor(count(/_planks$/) / 4),
    sense: async () => {}, nightGuard: async () => {}, recoverGuard: async () => {},
    toSurface: async () => { calls.push(['toSurface', {}]); return true }, canWorkAtNight: () => true,
    defStage: (name, ready, run) => { stages[name] = { ready, run } }, log: () => {},
    act: async (name, params) => {
      calls.push([name, params])
      if (name === 'mine' && params.block === 'any_log') {
        if (options.noWood) return { status: 'failed', error: 'не вижу any_log', detail: {} }
        inventory[options.log || 'mangrove_log'] = (inventory[options.log || 'mangrove_log'] || 0) + params.count
        return { status: 'done', detail: { dug: params.count } }
      }
      if (name === 'explore') return { status: 'done', detail: { found: 'spruce_log', at: { x: 110, y: 65, z: 0 } } }
      return { status: 'done', detail: {} }
    },
    walkAway: async () => {}, craft,
    planksFor: () => Object.keys(inventory).find(k => /_(log|stem)$/.test(k) && inventory[k])?.replace(/_(log|stem)$/, '_planks'),
    sticks: async n => {
      if (count('stick') >= n) return
      if (count(/_planks$/) < 2) { const k = ctx.planksFor(); if (k) await craft(k, 4) }
      if (count(/_planks$/) >= 2) await craft('stick', Math.max(4, n - count('stick')))
    }
  }
  vm.runInNewContext(transformSync(body, { loader: 'ts', format: 'cjs' }).code, ctx)
  return { run: () => stages.wood.run(options.bootstrap), calls, inventory, craft }
}

test('three carried logs become a pick immediately, before any further walk', async () => {
  const f = fixture({ mangrove_log: 3 })
  await f.run()
  assert.equal(f.inventory.wooden_pickaxe, 1)
  assert.equal(f.calls.filter(([n]) => /mine|explore|goto|toSurface/.test(n)).length, 0)
  assert.equal(f.inventory.mangrove_planks, 3)
  assert.equal(f.inventory.stick, 2)
  f.inventory.cobblestone = 6
  assert.equal(await f.craft('stone_pickaxe'), true)
  assert.equal(await f.craft('stick', 4), true)
  assert.equal(await f.craft('stone_pickaxe'), true, 'a stone pick and one replacement are affordable')
})

test('empty inventory requests the physical three logs, not the five-log kit budget', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.calls.find(([n]) => n === 'mine')[1].count, 3)
  assert.equal(f.inventory.wooden_pickaxe, 1)
})

test('the actual AcquireWood bridge argument of five does not override the affordable starter recipe', async () => {
  const f = fixture({}, { bootstrap: 5 })
  await f.run()
  assert.equal(f.calls.find(([n]) => n === 'mine')[1].count, 3)
  assert.equal(f.inventory.wooden_pickaxe, 1)
})

test('carried sticks lower the actual physical minimum to two logs', async () => {
  const f = fixture({ spruce_log: 2, stick: 2 })
  await f.run()
  assert.equal(f.calls.filter(([n]) => n === 'mine').length, 0)
  assert.equal(f.inventory.wooden_pickaxe, 1)
})

test('plank-only inventory and a carried table do not trigger another tree search', async () => {
  const f = fixture({ crafting_table: 1, spruce_planks: 5 })
  await f.run()
  assert.equal(f.calls.filter(([n]) => n === 'mine').length, 0)
  assert.equal(f.inventory.wooden_pickaxe, 1)
})

test('a canopy does not trigger a hand ascent before chopping the visible logs', async () => {
  const f = fixture({}, { surface: false })
  await f.run()
  assert.equal(f.calls.filter(([n]) => n === 'toSurface').length, 0)
  assert.equal(f.inventory.wooden_pickaxe, 1)
})

test('scouting includes the full render range and requests a dry surface approach', async () => {
  const f = fixture({}, { noWood: true })
  await assert.rejects(f.run(), /брёвен нет/)
  const e = f.calls.find(([n]) => n === 'explore')[1]
  assert.equal(e.radius, 128)
  assert.equal(e.surface, true)
  assert.equal(e.dry, true)
})

for (const options of [{ off: true }, { mode: 'survival' }, { dimension: 'the_nether' }]) {
  test(`legacy stock objective remains intact: ${JSON.stringify(options)}`, async () => {
    const f = fixture({}, options)
    await f.run()
    // Бюджет дерева (ND_OW_WOOD_BUDGET) удалён 21.10: прежняя цель этапа — 6 брёвен в спидране, 14 вне его.
    assert.equal(f.calls.find(([n]) => n === 'mine')[1].count, (options as any).mode === 'survival' ? 14 : 6)
  })
}

const foodFile = 'daemon/campaign/food.ts'
const foodSource = overlay[foodFile] ?? fs.readFileSync(path.join(root, foodFile), 'utf8')
const foodBody = foodSource.slice(foodSource.indexOf('async function foodRun ()'), foodSource.indexOf('async function quickHunt ()'))
async function foodFixture(logs, off = false) {
  const calls = [], inv = { mangrove_log: logs }
  const count = name => Object.entries(inv).reduce((n, [k, v]) => n + ((typeof name === 'string' ? name === k : name.test(k)) ? v : 0), 0)
  const ctx: any = {
    process: { env: off ? {} : { ND_OW_STARTER: '1' } }, dim: () => 'overworld',
    state: { inventory: inv, playPolicy: { mode: 'speedrun' } }, known: {}, died: false, strategyInterrupted: false,
    LOGS: /_(log|stem)$/, have: count,
    ensurePick: async () => { calls.push('pick'); return true },
    cook: async () => { calls.push('cook') }, makeBed: async () => {}, foodShort: () => 0,
    entrySupplies: () => true
  }
  vm.runInNewContext(transformSync(foodBody + '\nglobalThis.run = foodRun', { loader: 'ts', format: 'cjs' }).code, ctx)
  await ctx.run()
  return calls
}
test('an interrupted wood stage with three logs buys the pick before the next food walk', async () => {
  assert.deepEqual(await foodFixture(3), ['pick', 'cook'])
})
test('unaffordable crafting never delays food when only two logs were collected', async () => {
  assert.deepEqual(await foodFixture(2), ['cook'])
})
test('the food handoff flag is off by default', async () => {
  assert.deepEqual(await foodFixture(3, true), ['cook'])
})
