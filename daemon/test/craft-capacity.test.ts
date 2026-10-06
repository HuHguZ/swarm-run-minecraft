'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

function fixture ({ free = 0, output = true }: any = {} as Record<string, any>) {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const slots = Array(46).fill(null)
  slots[9] = { name: 'coal', type: 1, count: 8, slot: 9 }
  slots[10] = { name: 'stick', type: 2, count: 8, slot: 10 }
  let calls = 0
  const recipe = { result: { id: 3, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: -1 }, { id: 3, count: 4 }] }
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => free },
    recipesFor: () => [recipe], pathfinder: { setGoal () {} }, clearControlStates () {},
    async craft () {
      calls++
      slots[9].count--; slots[10].count--
      if (output) slots[11] = { name: 'torch', type: 3, count: 4, slot: 11 }
    }
  }
  const context = { module: { exports: {} as Record<string, any> }, console, Date, setTimeout, clearTimeout,
    require: n => n === './movement' ? { ...realRequire(n), sleep: async () => {} }
      : n === './pack' ? { outputSlots: () => 1, makeRoom: async () => ({ freed: 0, tossed: [], short: 1 }) }
        : realRequire(n) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const mcData = { itemsByName: { torch: { id: 3, stackSize: 64 } }, items: { 1: { name: 'coal' }, 2: { name: 'stick' }, 3: { name: 'torch' } } }
  return { bot, calls: () => calls, craft: () => context.module.exports.craft({ bot, mcData }, { aborted: false, onAbort: [] }, { item: 'torch', count: 4 }) }
}

test('нет места и нечего безопасно выбросить: рецепт не расходует материалы', async () => {
  const f = fixture()
  await assert.rejects(f.craft(), /мест|рюкзак/)
  assert.equal(f.calls(), 0)
  assert.equal(f.bot.inventory.slots[9].count, 8)
})

test('свободное место позволяет получить ровно один выход рецепта', async () => {
  const f = fixture({ free: 8 })
  const result = await f.craft()
  assert.equal(result.count, 4)
  assert.equal(f.calls(), 1)
})

test('материалы списались, результат отсутствует: отказ не советует повторить рецепт', async () => {
  const f = fixture({ free: 8, output: false })
  await assert.rejects(f.craft(), /материалы списаны/)
  assert.equal(f.calls(), 1)
})

test('the actual full Nether kit crafts four sticks after a pickup refills both output and cursor capacity', async () => {
  const { EventEmitter } = require('node:events')
  const bot: Record<string, any> = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'
  const Item = require('prismarine-item')(bot.registry)
  const stack = (name, count) => new Item(bot.registry.itemsByName[name].id, count)
  bot.inventory = require('prismarine-windows')(bot.registry).createWindow(0, 'minecraft:inventory', 'inventory')
  const stock = { iron_nugget: 91, potion: 5, string: 69, white_bed: 1, bucket: 1, iron_ingot: 7,
    splash_potion: 2, flint_and_steel: 1, cooked_beef: 12, crafting_table: 1, obsidian: 12, arrow: 44,
    spectral_arrow: 97, golden_chestplate: 1, ancient_debris: 1, water_bucket: 1, cooked_porkchop: 1,
    fire_charge: 12, crying_obsidian: 6, oak_planks: 12, iron_sword: 2, ender_pearl: 2,
    polished_blackstone_bricks: 2, iron_pickaxe: 1, stone_pickaxe: 1, cobbled_deepslate: 64, leather: 2 }
  let slot = 9
  for (const [name, count] of Object.entries(stock)) {
    const size = bot.registry.itemsByName[name].stackSize
    for (let left = count; left > 0; left -= size) bot.inventory.updateSlot(slot++, stack(name, Math.min(left, size)))
  }
  assert.equal(slot, 45, 'the native kit occupies exactly 36 inventory slots')
  const slots = [...bot.inventory.slots]
  let carried = null, stateId = 0, refilled = false
  const discarded = []
  const emit = () => bot._client.emit('window_items', { windowId: 0, stateId: ++stateId,
    items: slots.map(Item.toNotch), carriedItem: Item.toNotch(carried) })
  bot._client = new EventEmitter()
  bot._client.on('window_items', packet => packet.items.forEach((value, index) => bot.inventory.updateSlot(index, Item.fromNotch(value))))
  require('../src/invsync').install(bot)
  bot.tossStack = async item => { discarded.push(item.name); slots[item.slot] = null; emit() }
  bot.toss = async (type, metadata, count) => {
    const item = slots.find(item => item?.type === type && item.metadata === metadata)
    discarded.push(item.name); item.count -= count; if (!item.count) slots[item.slot] = null; emit()
  }
  await require('../src/pack').tidy(bot, { also: { leather: 0 } })
  const cleared = slots.findIndex((item, index) => index >= 9 && index < 45 && !item)
  slots[cleared] = stack('gilded_blackstone', 1); emit()
  assert.equal(bot.inventory.emptySlotCount(), 0, 'the observed new block refills the tidy slot')
  discarded.length = 0
  bot._client.write = (name, packet) => {
    if (name === 'close_window') { emit(); return }
    assert.equal(name, 'window_click')
    if (packet.slot === -999) { if (carried) discarded.push(carried.name); carried = null }
    else if (packet.slot === 0) {
      carried = slots[0]; slots[0] = null
      for (let index = 1; index <= 4; index++) slots[index] = null
      const free = slots.findIndex((item, index) => index >= 9 && index < 45 && !item)
      assert.ok(free >= 9, 'outputRoom must have made real space before recipe consumption')
      slots[free] = stack('gilded_blackstone', 1); refilled = true
    } else if (packet.mouseButton === 1 && carried && packet.slot < 5) {
      slots[packet.slot] = stack(carried.name, 1); carried.count--; if (!carried.count) carried = null
    } else { const old = slots[packet.slot]; slots[packet.slot] = carried; carried = old }
    if (slots[1]?.name === 'oak_planks' && slots[3]?.name === 'oak_planks') slots[0] = stack('stick', 4)
    emit()
  }
  bot.entity = { position: new Vec3(90.7, 71, 137.5) }
  bot.pathfinder = { setGoal() {} }; bot.clearControlStates = () => {}
  const planks = bot.registry.itemsByName.oak_planks.id, sticks = bot.registry.itemsByName.stick.id
  const recipe = { inShape: [[{ id: planks }], [{ id: planks }]], result: { id: sticks, count: 4 },
    delta: [{ id: planks, count: -2 }, { id: sticks, count: 4 }] }
  bot.recipesFor = () => [recipe]
  const made = await require('../src/actions').craft({ bot, mcData: bot.registry }, { aborted: false, onAbort: [] },
    { item: 'stick', count: 4, conversionStep: true })
  assert.equal(made.count, 4); assert.equal(refilled, true)
  assert.equal(bot.inventory.selectedItem, null)
  assert.deepEqual(discarded, ['polished_blackstone_bricks', 'gilded_blackstone'])
  assert.equal(bot.inventory.items().find(item => item.name === 'oak_planks').count, 10)
  assert.equal(bot.inventory.items().find(item => item.name === 'crafting_table').count, 1)
  assert.equal(bot.inventory.items().filter(item => /_pickaxe$/.test(item.name)).length, 2)
  assert.equal(bot.inventory.items().find(item => item.name === 'ender_pearl').count, 2)
  assert.ok(require('../src/pack').buildCount(bot) >= require('../src/pack').RESERVE.build)
})
