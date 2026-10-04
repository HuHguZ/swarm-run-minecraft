'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { tidy, outputSlots, ignoreDrop } = require('../src/pack')
function bag (stock) {
  const slots = Array(46).fill(null)
  stock.forEach((it, i) => { slots[i + 9] = { ...it, slot: i + 9, type: it.type || i + 1 } })
  const bot = { registry: { itemsByName: { bowl: { stackSize: 64 }, crafting_table: { stackSize: 64 } } },
    inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(x => !x).length },
    async moveSlotItem (a, b) { slots[b].count += slots[a].count; slots[a] = null },
    async tossStack (it) { slots[it.slot] = null },
    async toss (type, metadata, count) {
      const it = slots.find(i => i && i.type === type && i.metadata === metadata)
      it.count -= count
      if (!it.count) slots[it.slot] = null
    }
  }
  return bot
}
test('уборка соединяет одинаковые стопки, сохраняя их предметы', async () => {
  const bot = bag([{ name: 'bowl', type: 10, count: 1 }, { name: 'bowl', type: 10, count: 2 }])
  await tidy(bot)
  assert.equal(bot.inventory.items().length, 1)
  assert.equal(bot.inventory.items()[0].count, 3)
})

test('место на выход рецепта учитывает остаток стопки и размер предметов', () => {
  const bot = bag([{ name: 'bowl', count: 63 }])
  bot.registry.itemsByName.stone_pickaxe = { stackSize: 1 }
  assert.equal(outputSlots(bot, 'bowl', 1), 0)
  assert.equal(outputSlots(bot, 'bowl', 2), 1)
  assert.equal(outputSlots(bot, 'stone_pickaxe', 2), 2)
})

test('следующий подбор не преследует лишний верстак, но возвращает потерянный последний', async () => {
  const bot = bag([{ name: 'crafting_table', count: 2 }, { name: 'blaze_rod', count: 2 }])
  bot.ndPlayPolicy = { mode: 'speedrun' }
  await tidy(bot, { also: { crafting_table: 1 } })
  const drop = name => ({ getDroppedItem: () => ({ name, count: 1 }) })
  assert.equal(ignoreDrop(bot, drop('crafting_table')), true)
  assert.equal(ignoreDrop(bot, drop('blaze_rod')), false)
  bot.inventory.slots[9] = null
  assert.equal(ignoreDrop(bot, drop('crafting_table')), false)
  bot.ndPlayPolicy.mode = 'free'
  assert.equal(ignoreDrop(bot, drop('dirt')), false)
})
test('стопки с разными компонентами не смешиваются', async () => {
  const bot = bag([{ name: 'bowl', type: 10, count: 1, components: [{ name: 'custom_name', data: 'A' }] }, { name: 'bowl', type: 10, count: 2 }])
  await tidy(bot)
  assert.equal(bot.inventory.items().length, 2)
})
test('явный лимит убирает избыток даже из одной стопки, сохраняя стержни и оружие', async () => {
  const bot = bag([{ name: 'crafting_table', count: 7 }, { name: 'blaze_rod', count: 2 }, { name: 'stone_sword', count: 1, maxDurability: 131 }])
  await tidy(bot, { also: { crafting_table: 2 } })
  assert.deepEqual(bot.inventory.items().map(i => [i.name, i.count]), [['crafting_table', 2], ['blaze_rod', 2], ['stone_sword', 1]])
})
test('почти сломанная каменная кирка убирается лишь при рабочей замене', async () => {
  const old = { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 128 }
  const bot = bag([old, { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 20 }])
  await tidy(bot)
  assert.equal(bot.inventory.items().length, 1)
  const last = bag([old])
  await tidy(last)
  assert.equal(last.inventory.items().length, 1)
})

// Аварийный запас (research/05-synthesis.md F.5): блоков стройки ≥ 16, кирка ≥ 1,
// еды ≥ 2 — любая разгрузка его не пробивает (коробке отхода нужны блоки).
const { RESERVE, makeRoom, buildCount, tossPlan } = require('../src/pack')
test('запас: разгрузка хлама оставляет не меньше 16 блоков стройки', async () => {
  const bot = bag([{ name: 'dirt', count: 20 }, { name: 'gravel', count: 5 }, { name: 'andesite', count: 4 }])
  await tidy(bot)
  assert.equal(RESERVE.build, 16)
  const left = Object.fromEntries(bot.inventory.items().map(i => [i.name, i.count]))
  assert.equal(left.gravel, undefined, 'гравий — не блок стройки, уходит')
  assert.equal(left.andesite, undefined, 'лишний диорит/андезит уходит, пока запас цел')
  assert.equal(left.dirt, 20, 'земля — последний запас на коробку')
  assert.ok(buildCount(bot) >= RESERVE.build)
})
test('запас: явный лимит кампании (also) не выкидывает блоки и еду ниже запаса', async () => {
  const bot = bag([{ name: 'cobblestone', count: 64 }, { name: 'bread', count: 5 }])
  await tidy(bot, { also: { cobblestone: 0, bread: 0 } })
  const left = Object.fromEntries(bot.inventory.items().map(i => [i.name, i.count]))
  assert.equal(left.cobblestone, RESERVE.build)
  assert.equal(left.bread, RESERVE.food)
})
test('запас: место под предмет не освобождается ценой последних блоков', async () => {
  const stock = [{ name: 'netherrack', count: 12 }]
  for (let i = 0; i < 35; i++) stock.push({ name: 'diamond', count: 1 })
  const bot = bag(stock)
  bot.entity = { position: { x: 0, y: 64, z: 0, offset () { return this } } }
  const r = await makeRoom(bot, { slots: 1, forItem: 'diamond' })
  assert.equal(r.freed, 0, 'незерак — весь запас коробки')
  assert.equal(tossPlan(bot, { below: 3 }).length, 0)
})
test('запас: земля под ногами при недоборе запаса — не хлам', () => {
  const bot = bag([{ name: 'cobblestone', count: 8 }])
  bot.ndPlayPolicy = { mode: 'speedrun' }
  const drop = name => ({ getDroppedItem: () => ({ name, count: 1 }) })
  assert.equal(ignoreDrop(bot, drop('dirt')), false, '8 из 16 — подбирать')
  bot.inventory.slots[9].count = 64
  assert.equal(ignoreDrop(bot, drop('dirt')), true, 'запас полон — хлам')
})
