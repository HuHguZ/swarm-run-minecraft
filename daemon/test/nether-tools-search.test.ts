import test from 'node:test'
import assert from 'node:assert/strict'
import { netherToolsReady, replenishNetherTools, type NetherSupplyPort, type NetherSupplyState } from '../src/campaign/nether-supply'
const mcData = require('minecraft-data')('1.21.11')

function fixture(material: string | null = 'blackstone', stop = false, slowCraft = false) {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20,
    inventory: { oak_planks: 16, stick: 8, crafting_table: 1, iron_ingot: 2 }, pickSwings: 0 }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let seen = false, interrupted = false, now = 0
  const port: NetherSupplyPort = { observe: async () => state, now: () => now, interrupted: () => interrupted, log() {},
    async act(method, params) {
      calls.push({ method, params })
      if (slowCraft) now += Number(params.timeoutSeconds) * 1000
      else now += 100
      if (method === 'explore') { seen = true; interrupted = stop }
      if (method === 'mine' && seen && material && String(params.block).split(',').includes(material)) {
        state.inventory[material] = (state.inventory[material] || 0) + Number(params.count)
      }
    },
    async craft(item, count) {
      calls.push({ method: 'craft', params: { item, count } })
      const pick = item === 'wooden_pickaxe' ? 'oak_planks' : item === 'stone_pickaxe' ? material : null
      if (!pick || (state.inventory[pick] || 0) < 3 || state.inventory.stick < 2) return false
      state.inventory[pick] -= 3; state.inventory.stick -= 2
      state.inventory[item] = (state.inventory[item] || 0) + 1
      state.pickSwings += mcData.itemsByName[item].maxDurability
      if (slowCraft) now += 200000
      return true
    } }
  return { state, port, calls, now: () => now }
}

test('J21 exhausted picks search a new view before giving up on unseen material', async () => {
  for (const material of ['blackstone', 'cobblestone', 'cobbled_deepslate']) {
    const f = fixture(material)
    const result = await replenishNetherTools(f.port)
    assert.equal(result.ready, true, material)
    assert.equal(f.state.inventory.stone_pickaxe, 2)
    assert.equal(f.state.inventory[material], 0)
    assert.equal(f.calls.filter(c => c.method === 'explore').length, 1)
    const search = f.calls.find(c => c.method === 'explore')!
    assert.equal(search.params.fair, true)
    assert.equal(search.params.dry, true)
    assert.equal(f.calls.some(c => c.params.at || c.params.force), false)
  }
})

test('no visible accessible material ends after one bounded search rather than an empty loop', async () => {
  const f = fixture(null)
  assert.equal((await replenishNetherTools(f.port)).ready, false)
  assert.equal(f.calls.filter(c => c.method === 'explore').length, 1)
  assert.equal(f.calls.filter(c => c.method === 'mine').length, 2)
  assert.equal(f.state.inventory.stone_pickaxe || 0, 0)
})

test('an interruption during material search stops before mining or another craft', async () => {
  const f = fixture('blackstone', true)
  const result = await replenishNetherTools(f.port)
  assert.equal(result.ready, false)
  assert.equal(result.interrupted, true)
  assert.equal(f.calls.at(-1)?.method, 'explore')
})

test('the material search receives only the remaining part of the existing 240 second budget', async () => {
  const f = fixture(null, false, true)
  await replenishNetherTools(f.port)
  const search = f.calls.find(c => c.method === 'explore')!
  assert.ok(search)
  assert.equal(search.params.timeoutSeconds, 5)
  assert.equal(f.now(), 240000)
  assert.equal(f.calls.at(-1)?.method, 'explore')
})

test('X24 usable picks cover the tool task without a new table or reserve wood', async () => {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20, pickSwings: 330,
    inventory: { stone_pickaxe: 3, oak_planks: 4, stick: 2, cobblestone: 8, cobbled_deepslate: 64, iron_ingot: 2 } }
  const calls: string[] = []
  const port: NetherSupplyPort = { observe: async () => state, now: () => 0,
    interrupted: () => false, log() {},
    act: async method => { calls.push(method) },
    craft: async item => { calls.push(item); return false } }
  assert.equal(netherToolsReady(state), true)
  assert.equal((await replenishNetherTools(port)).ready, true)
  assert.deepEqual(calls, [], 'no stem detour or speculative replacement craft before using the carried tools')
})

test('usable tool budget does not require any consumable wood until replacement is needed', () => {
  assert.equal(netherToolsReady({ dimension: 'the_nether', health: 20,
    inventory: { stone_pickaxe: 2 }, pickSwings: 262 }), true)
  assert.equal(netherToolsReady({ dimension: 'the_nether', health: 20,
    inventory: { stone_pickaxe: 2, oak_planks: 32 }, pickSwings: 259 }), false)
  assert.equal(netherToolsReady({ dimension: 'the_nether', health: 20,
    inventory: { oak_planks: 32 }, pickSwings: 330 }), false, 'estimated swings cannot replace an actual pick')
})

test('worn picks with unavailable replacement ingredients still end the bounded supply attempt', async () => {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20,
    inventory: { stone_pickaxe: 1 }, pickSwings: 80 }
  const calls: string[] = []
  let now = 0
  const port: NetherSupplyPort = { observe: async () => state, now: () => now,
    interrupted: () => false, log() {},
    act: async method => { calls.push(method); now += 10000 },
    craft: async item => { calls.push(item); return false } }
  assert.equal((await replenishNetherTools(port)).ready, false)
  assert.equal(calls.filter(method => method === 'explore').length, 1)
  assert.equal(calls.some(method => method === 'stone_pickaxe'), false)
  assert.ok(now <= 240000)
})

function carriedRecipeFixture({ planks = 4, interruptedAfterTable = false, tableAck = true, pickAck = true, craftError = false }: any = {}) {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20, pickSwings: 242,
    inventory: { stone_pickaxe: 3, oak_planks: planks, stick: 2, cobblestone: 8, cobbled_deepslate: 64, iron_ingot: 2 } }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let interrupted = false, now = 0
  const port: NetherSupplyPort = { observe: async () => state, now: () => now, interrupted: () => interrupted, log() {},
    async act(method,params) { calls.push({ method,params }); now += 100 },
    async craft(item,count) {
      calls.push({ method: 'craft',params: { item,count } }); now += 100
      if (craftError) throw new Error('native craft denied')
      if (item === 'crafting_table') {
        if (state.inventory.oak_planks < 4) return false
        if (tableAck) { state.inventory.oak_planks -= 4; state.inventory.crafting_table = 1 }
        interrupted = interruptedAfterTable
        return true
      }
      if (item === 'stone_pickaxe') {
        if (!state.inventory.crafting_table || state.inventory.cobblestone < 3 || state.inventory.stick < 2) return false
        if (pickAck) {
          state.inventory.cobblestone -= 3; state.inventory.stick -= 2
          state.inventory.stone_pickaxe++; state.pickSwings += mcData.itemsByName.stone_pickaxe.maxDurability
        }
        return true
      }
      return false
    }
  }
  return { state,port,calls }
}

test('saved Y24 replenishes 242 swings with its carried table recipe and one physical stone pick before searching for future wood', async () => {
  const f = carriedRecipeFixture()
  const result = await replenishNetherTools(f.port)
  assert.equal(result.ready,true)
  assert.equal(f.state.pickSwings,373)
  assert.equal(f.state.inventory.stone_pickaxe,4)
  assert.equal(f.state.inventory.oak_planks,0)
  assert.equal(f.state.inventory.stick,0)
  assert.equal(f.state.inventory.cobblestone,5)
  assert.deepEqual(f.calls.filter(c => c.method === 'craft').map(c => c.params.item),['crafting_table','stone_pickaxe'])
  assert.equal(f.calls.some(c => c.method === 'explore' || String(c.params.block).includes('stem')),false)
})

test('an actually missing table plank cannot be replaced by the carried recipe shortcut', async () => {
  const f = carriedRecipeFixture({ planks: 3 })
  assert.equal((await replenishNetherTools(f.port)).ready,false)
  assert.equal(f.calls.some(c => c.method === 'craft'),false)
  assert.equal(f.state.pickSwings,242)
})

test('the carried recipe respects Tactical cancellation and actual table and pick receipts', async () => {
  for (const options of [{ interruptedAfterTable: true }, { tableAck: false }, { pickAck: false }]) {
    const f = carriedRecipeFixture(options)
    const result = await replenishNetherTools(f.port)
    assert.equal(result.ready,false)
    assert.equal(result.interrupted,!!options.interruptedAfterTable)
    assert.equal(f.state.pickSwings,242)
    if (options.interruptedAfterTable || options.tableAck === false) assert.equal(f.calls.some(c => c.params.item === 'stone_pickaxe'),false)
  }
})

test('a denied native carried-recipe craft propagates its error before another physical action', async () => {
  const f = carriedRecipeFixture({ craftError: true })
  await assert.rejects(replenishNetherTools(f.port),/native craft denied/)
  assert.equal(f.calls.at(-1)?.params.item,'crafting_table')
  assert.equal(f.state.pickSwings,242)
})
