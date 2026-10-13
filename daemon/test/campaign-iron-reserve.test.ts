export {}
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const mc = require('minecraft-data')('1.21.11')
const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
const declaration = (name: string) => {
  const start = source.indexOf(`async function ${name} (`)
  assert.ok(start >= 0)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
const buckets = source.match(/^const portalBuckets = .+$/m)[0]
const smeltStart = source.indexOf('const ironToSmelt =')
const smelt = source.slice(smeltStart, source.indexOf('\n}', smeltStart) + 2)
const iron = source.slice(source.indexOf("defStage('iron'"), source.indexOf('\nasync function bucketOnTheWay'))
const noop = async () => {}

function fixture (extra: Record<string, number> = {}, known = {}, water = false) {
  const inventory: Record<string, number> = { iron_ingot: 3, oak_planks: 4, stick: 2, stone_pickaxe: 1, ...extra }
  const calls: any[] = []
  const context: any = {
    known, state: { inventory, pos: { x: 170, y: 23, z: 262 }, health: 20, food: 20 }, sit: { surface: false, night: false },
    OW_DEEP: false, OW_HEAR: false, castSurfaceFailed: false, PICK_IRON: /^(iron|diamond|netherite)_pickaxe$/,
    ARMOR_POINTS: {}, ARMOR_SLOT: {}, ARMOR_COST: {}, fightGearWanted: false, LOGS: /_log$/, FOOD: /^(bread|cooked_)/,
    died: false, ironRuns: 0, ironLeg: 0, ironBlocked: new Set(), process: { env: {} }, stage: 'iron',
    log: () => {}, refresh: noop, sense: noop, cook: noop, recoverGuard: noop, unclutter: noop, spares: noop,
    lightUp: noop, mineSeenAll: noop, sticks: noop, readMemory: noop, torches: noop, bucketOnTheWay: noop,
    gearWorth: () => ({ missing: true, take: false }), worn: () => false, goldOn: () => true,
    planksFor: () => null, woodNow: () => 0, mobInTheWay: async () => false, weakAndHungry: () => false,
    have: (item: string | RegExp) => typeof item === 'string' ? (inventory[item] || 0) : Object.entries(inventory).reduce((sum, [name, n]) => sum + (item.test(name) ? n : 0), 0),
    lighter: () => !!(inventory.flint_and_steel || inventory.fire_charge), y: () => context.state.pos.y, dim: () => 'overworld',
    smeltAll: async () => { if (inventory.raw_iron) { inventory.iron_ingot += inventory.raw_iron; inventory.raw_iron = 0 } },
    craft: async (name: string) => {
      const recipes: Array<{ recipe: any, need: Record<string, number> }> = (mc.recipes[mc.itemsByName[name].id] || []).map((recipe: any) => {
        const need: Record<string, number> = {}
        for (const cell of recipe.inShape ? recipe.inShape.flat() : recipe.ingredients || []) {
          if (cell == null) continue
          const key = mc.items[typeof cell === 'number' ? cell : cell.id].name
          need[key] = (need[key] || 0) + (cell.count || 1)
        }
        return { recipe, need }
      })
      const hit = recipes.find(({ need }) => Object.entries(need).every(([key, n]) => (inventory[key] || 0) >= n))
      calls.push({ method: 'craft', item: name, confirmed: !!hit })
      if (!hit) return { status: 'failed' }
      for (const [key, n] of Object.entries(hit.need)) inventory[key] -= n
      inventory[name] = (inventory[name] || 0) + hit.recipe.result.count
      return { status: 'done' }
    },
    act: async (method: string, params: any = {}) => {
      calls.push({ method, params: { ...params } })
      if (method === 'tunnel') {
        if (params.direction === 'south') { inventory.raw_iron = (inventory.raw_iron || 0) + 1; return { status: 'done', detail: { walked: 1 } } }
        if (water && params.direction === 'east') { context.state.pos.x += 8; return { status: 'done', detail: { walked: 8, stopped: 'вода у 179,22,262' } } }
        return { status: 'done', detail: { walked: 0, stopped: 'вода у 170,25,261' } }
      }
      return { status: 'done', detail: {} }
    },
    defStage: (_name: string, _needed: () => boolean, executor: () => Promise<void>) => { context.runIron = executor }
  }
  vm.runInNewContext(transformSync(buckets + '\n' + smelt + '\n' + declaration('spendIron') + '\n' + iron + '\nthis.spend=spendIron', { loader: 'ts' }).code, context)
  return { context, inventory, calls }
}

test('three bucket ingots survive a physically impossible shield recipe and optional sword', async () => {
  const f = fixture(); await f.context.spend()
  assert.equal(f.inventory.iron_sword || 0, 0)
  assert.equal(f.inventory.iron_ingot, 3)
})

test('missing bucket and lighter remain funded when extra iron can pay for a shield', async () => {
  const f = fixture({ iron_ingot: 5, oak_planks: 6 }); await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.shield, 1)
  assert.equal(f.inventory.iron_ingot, 1)
  assert.equal(f.inventory.iron_sword || 0, 0)
})

test('a carried ignition charge releases its ingot reserve', async () => {
  const f = fixture({ iron_ingot: 5, fire_charge: 1 }); await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.iron_sword, 1)
})

test('an existing portal permits optional sword spending', async () => {
  const f = fixture({ iron_ingot: 3 }, { portal: true }); await f.context.spend()
  assert.equal(f.inventory.iron_sword, 1)
  assert.equal(f.inventory.iron_ingot, 1)
})

test('a requested second bucket retains its three physical ingots', async () => {
  const f = fixture({ iron_ingot: 6 }); f.context.process.env.ND_ROUTE_ONE = '0'
  await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.iron_ingot, 3)
  assert.equal(f.inventory.iron_sword || 0, 0)
})

test('ordinary iron search remembers a blocked leg from an earlier attempt at this pose', async () => {
  const f = fixture(); f.context.ironBlocked.add('170,262:north')
  await f.context.runIron()
  assert.deepEqual(f.calls.filter(c => c.method === 'tunnel').map(c => c.params.direction), ['east', 'south'])
  assert.equal(f.inventory.bucket, 1)
})

for (const moved of [false, true]) test(`ordinary iron search tries the unvisited south leg after water; moved=${moved}`, async () => {
  const f = fixture({}, {}, moved); await f.context.runIron()
  const legs = f.calls.filter(c => c.method === 'tunnel').map(c => c.params.direction)
  assert.deepEqual(legs, ['north', 'east', 'south'])
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.iron_ingot, 1)
  assert.equal(f.calls.filter(c => c.method === 'mine' && c.params.block.includes('iron_ore')).every(c => c.params.count === 1), true)
})
