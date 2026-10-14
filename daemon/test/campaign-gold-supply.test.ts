'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { withClockFixture } = require('./clock-fixture')
const data = require('minecraft-data')('1.21.11')

function fixture(inventory, { worn = false, rejectConversion = false, ore = false, piglinAt = null }: any = {}) {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
    inventory: { crafting_table: 1, ...inventory }, armor: worn ? { head: { item: 'golden_helmet' } } : {} }
  const situation = { pickLeft: 520, free: 36, foes: 0, surface: true }
  const calls: any[] = []
  const physicalCrafts: any[] = []
  const logs: string[] = []
  // Recipe output count is additional inventory, as on the real craft RPC.
  // Use 1.21.11 recipes to consume inputs rather than granting the requested item.
  function craft(params) {
    if (rejectConversion && params.item === 'gold_ingot') return { need: 'server did not confirm conversion' }
    const item = data.itemsByName[params.item]
    for (const recipe of data.recipes[item.id] || []) {
      const needed: Record<string, number> = {}
      for (const id of recipe.ingredients || (recipe.inShape || []).flat()) {
        if (id == null || id < 0) continue
        const name = data.items[id].name
        needed[name] = (needed[name] || 0) + 1
      }
      const times = Math.ceil((params.count ?? 1) / recipe.result.count)
      if (!Object.entries(needed).every(([name, count]) => (state.inventory[name] || 0) >= count * times)) continue
      for (const [name, count] of Object.entries(needed)) {
        state.inventory[name] -= count * times
        if (!state.inventory[name]) delete state.inventory[name]
      }
      const produced = recipe.result.count * times
      state.inventory[params.item] = (state.inventory[params.item] || 0) + produced
      physicalCrafts.push({ item: params.item, requested: params.count ?? 1, produced, inputs: needed, times })
      return { made: produced }
    }
    return { need: 'missing ingredients' }
  }
  class Socket {
    listeners = new Map<string, (...args: any[]) => void>()
    on(name, fn) { this.listeners.set(name, fn) }
    send(raw) {
      const { id, method, params } = JSON.parse(raw)
      calls.push({ method, params })
      let detail: any = {}
      if (method === 'situation') detail = situation
      if (method === 'observe') detail = { entities: ore ? [] : [{ name: 'Piglin', dist: 4, ...(piglinAt ? { pos: piglinAt } : {}) }] }
      if (method === 'mine') detail = { dug: 0, stopped: 'виден взрослый пиглин в зоне злости' }
      if (method === 'craft') detail = craft(params)
      if (method === 'armor' && state.inventory.golden_boots) {
        state.inventory.golden_boots--
        if (!state.inventory.golden_boots) delete state.inventory.golden_boots
        state.armor.feet = { item: 'golden_boots' }
      }
      queueMicrotask(() => this.listeners.get('message')!(JSON.stringify({ id, ok: true,
        result: { status: 'done', detail, state, events: [] } })))
    }
    close() {}
  }
  const context: any = { require: name => name === 'ws' ? Socket : name === 'fs'
    ? { appendFileSync(_file, line) { logs.push(String(line)) } } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: ['node', 'campaign.js'], env: {} }, console: { log() {}, error() {} }, setTimeout, Date, queueMicrotask,
    testState: state, testSituation: situation }
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code +
    '\nstate = testState; sit = testSituation; module.exports = { netherGold };', withClockFixture(context))
  return { state, calls, physicalCrafts, logs, run: () => context.module.exports.netherGold() }
}

for (const [blocks, ingots] of [[1, 0], [2, 4]]) {
  test(`Nether gold armor converts ${blocks} carried blocks before ore search with ${ingots} loose ingots`, async () => {
    const f = fixture({ gold_block: blocks, iron_pickaxe: 1, ...(ingots ? { gold_ingot: ingots } : {}) })
    await f.run()
    // Из первого золота — ботинки за 4 слитка (координатор 14.10, Codex q10), не шлем за 5.
    assert.equal(f.state.armor.feet?.item, 'golden_boots')
    assert.equal(f.calls.some(call => call.method === 'mine' || call.method === 'explore'), false)
    assert.equal(f.state.inventory.gold_block || 0, 0)
    assert.equal(f.state.inventory.gold_ingot, blocks * 9 + ingots - 4)
    assert.deepEqual(f.physicalCrafts.map(craft => [craft.item, craft.produced]), [['gold_ingot', blocks * 9], ['golden_boots', 1]])
  })
}

test('already worn gold does not spend carried blocks or search ore', async () => {
  const f = fixture({ gold_block: 2 }, { worn: true })
  await f.run()
  assert.equal(f.state.inventory.gold_block, 2)
  assert.equal(f.physicalCrafts.length, 0)
  assert.equal(f.calls.some(call => call.method === 'mine' || call.method === 'explore'), false)
})

test('unconfirmed block conversion cannot claim gold armor or mine beside visible piglins', async () => {
  const f = fixture({ gold_block: 1 }, { rejectConversion: true })
  await f.run()
  assert.equal(f.state.armor.head, undefined)
  assert.equal(f.state.inventory.gold_block, 1)
  assert.equal(f.physicalCrafts.length, 0)
  assert.equal(f.calls.some(call => call.method === 'mine'), false)
})

// Золото Ада — по пути (пользователь 14.10): у входа в этап bastion только руда на виду рядом, осторожной копкой, без разведки.
test('campaign mines only seen gold nearby, cautiously, without an ore search', async () => {
  const f = fixture({ stone_pickaxe: 1 }, { ore: true })
  await f.run()
  const mines = f.calls.filter(call => call.method === 'mine')
  assert.equal(mines.length, 1)
  assert.ok(/nether_gold_ore/.test(mines[0].params.block) && mines[0].params.avoidPiglinAggro === true && mines[0].params.radius <= 10, JSON.stringify(mines[0].params))
  assert.equal(f.calls.some(call => call.method === 'explore'), false)
  assert.equal(f.state.armor.head, undefined)
})

test('piglins by the ore: the gold here is left, no walk away and no mining (gold comes on the way)', async () => {
  const f = fixture({ stone_pickaxe: 1 }, { piglinAt: { x: 4, y: 64, z: 0 } })
  await f.run()
  assert.equal(f.calls.some(call => call.method === 'goto'), false)
  assert.equal(f.calls.some(call => call.method === 'explore'), false)
  assert.equal(f.calls.some(call => call.method === 'mine'), false, 'never mines beside visible piglins')
})
