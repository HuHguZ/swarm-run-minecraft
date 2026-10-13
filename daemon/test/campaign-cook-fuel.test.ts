import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
const { transformSync } = require('esbuild')
const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
const declaration = (name: string) => {
  const start = source.indexOf(`async function ${name} (`)
  assert.ok(start >= 0)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}

function fixture(extra: Record<string, number> = {}, { food = 10, hp = 20 } = {}) {
  const inventory: Record<string, number> = { mutton: 8, oak_log: 1, oak_planks: 2, crafting_table: 1, furnace: 1, stone_pickaxe: 1, water_bucket: 1, flint_and_steel: 1, ...extra }
  const calls: Array<{ method: string, params?: any }> = []
  const count = re => Object.entries(inventory).reduce((n, [name, have]) => n + ((typeof re === 'string' ? name === re : re.test(name)) ? have : 0), 0)
  const burn = (name: string) => name === 'coal' || name === 'charcoal' ? 8 : name === 'lava_bucket' ? 100 : /_planks$|_log$/.test(name) && !/^(crimson|warped)_/.test(name) ? 1.5 : 0
  const ctx: any = { state: { inventory, health: hp, food }, OW_DEEP: true, known: {}, LOGS: /_(log|stem)$/, RAW: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/, COBBLE: /^(cobblestone|blackstone)$/, ROUTE_COOKED_HUNGER: { cooked_mutton: 6 },
    have: count, planksFor: () => 'oak_planks', routeCookedHunger: () => count('cooked_mutton') * 6,
    refresh: async () => {}, unclutter: async () => {}, mineSeenAll: async () => {}, furnaceBack: async () => {}, log() {},
    ensureTable: async () => {
      calls.push({ method: 'ensureTable' })
      if (!inventory.crafting_table) {
        if (count(/_planks$/) < 4 && inventory.oak_log) { inventory.oak_log--; inventory.oak_planks += 4 }
        if (count(/_planks$/) < 4) return false
        inventory.oak_planks -= 4; inventory.crafting_table = 1
      }
      return true
    },
    craft: async (name, amount) => { calls.push({ method: 'craft', params: { item: name, count: amount } }); assert.ok(inventory.oak_log > 0); inventory.oak_log--; inventory[name] = (inventory[name] || 0) + 4 },
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'smelt') {
        if (!inventory.furnace && (!inventory.crafting_table || count('cobblestone') < 8)) return { status: 'failed', detail: { made: 0 } }
        if (!inventory.furnace) { inventory.cobblestone -= 8; inventory.furnace = 1 }
        const from = params.item === 'iron_ingot' ? 'raw_iron' : params.item.replace(/^cooked_/, ''), fuel = params.fuel || (inventory.coal ? 'coal' : 'charcoal')
        const units = Math.min(inventory[fuel] || 0, Math.ceil(params.count / burn(fuel)))
        const made = Math.min(inventory[from] || 0, params.count, Math.floor(units * burn(fuel)))
        inventory[fuel] -= units; inventory[from] -= made; inventory[params.item] = (inventory[params.item] || 0) + made
        return { status: 'done', detail: { made } }
      } else if (method === 'mine') inventory.cobblestone = 8
      return { status: 'done', detail: {} }
    }
  }
  vm.runInNewContext(transformSync(declaration('cook') + '\n' + declaration('smeltAll') + '\nthis.cook=cook;this.smeltAll=smeltAll', { loader: 'ts' }).code, ctx)
  return { ctx, inventory, calls }
}

test('Y22 cooking uses its one log and two planks instead of refusing future depth reserve', async () => {
  const f = fixture()
  await f.ctx.cook()
  assert.equal(f.inventory.cooked_mutton, 8)
  assert.equal(f.inventory.stone_pickaxe, 1)
  assert.equal(f.inventory.water_bucket, 1)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.ok(f.calls.some(c => c.method === 'smelt' && c.params.fuel === 'oak_planks'))
})

test('carried coal cooks before converting or burning tool wood', async () => {
  const f = fixture({ coal: 2 })
  await f.ctx.cook()
  assert.equal(f.inventory.cooked_mutton, 8)
  assert.equal(f.inventory.oak_log, 1)
  assert.equal(f.inventory.oak_planks, 2)
  assert.equal(f.calls.filter(c => c.method === 'craft').length, 0)
})

test('food can use a burning lava bucket and return the physical bucket through the existing smelt RPC', async () => {
  const f = fixture({ oak_log: 0, oak_planks: 0, lava_bucket: 1 })
  await f.ctx.cook()
  assert.equal(f.inventory.cooked_mutton, 8)
  assert.equal(f.calls.find(c => c.method === 'smelt')?.params.fuel, 'lava_bucket')
})

test('ordinary iron smelting keeps its existing tool wood policy', async () => {
  const f = fixture({ mutton: 0, raw_iron: 3, oak_log: 0 })
  await f.ctx.smeltAll('raw_iron', 'iron_ingot')
  assert.equal(f.inventory.iron_ingot || 0, 0)
})

test('Nether stems and planks cannot be counted as furnace fuel', async () => {
  const f = fixture({ oak_log: 0, oak_planks: 0, crimson_stem: 1, warped_planks: 2 })
  await f.ctx.cook()
  assert.equal(f.inventory.cooked_mutton || 0, 0)
  assert.equal(f.calls.filter(c => c.method === 'smelt').length, 0)
})

test('five Nether stems do not start an impossible charcoal batch before using the one real plank', async () => {
  const f = fixture({ oak_log: 0, oak_planks: 1, stripped_crimson_stem: 5 })
  await f.ctx.cook()
  assert.equal(f.calls.some(c => c.method === 'smelt' && c.params.item === 'charcoal'), false)
  assert.equal(f.inventory.cooked_mutton, 1)
})

test('missing furnace prepares its table and obtains real stone before cooking', async () => {
  const f = fixture({ furnace: 0, crafting_table: 0, cobblestone: 0 })
  await f.ctx.cook()
  assert.equal(f.inventory.cooked_mutton, 3)
  assert.equal(f.inventory.crafting_table, 1)
  assert.equal(f.inventory.furnace, 1)
  const smelt = f.calls.findIndex((c, i) => c.method === 'smelt' && i > f.calls.findIndex(c => c.method === 'mine'))
  assert.ok(f.calls.findIndex(c => c.method === 'ensureTable') < smelt)
  assert.ok(f.calls.findIndex(c => c.method === 'mine') < smelt)
})
