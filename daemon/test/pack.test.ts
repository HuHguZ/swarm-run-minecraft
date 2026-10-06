'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { tidy, outputSlots, ignoreDrop } = require('../src/pack')
function bag (stock) {
  const slots = Array(46).fill(null)
  stock.forEach((it, i) => { slots[i + 9] = { ...it, slot: i + 9, type: it.type || i + 1 } })
  const bot: Record<string, any> = { registry: { itemsByName: { bowl: { stackSize: 64 }, crafting_table: { stackSize: 64 } } },
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
test('equal-value craft room is opt-in and never permits valuable swaps or dropping protected ingredients', async () => {
  const full = extra => bag([...extra, ...Array.from({ length: 36 - extra.length }, () => ({ name: 'iron_sword', count: 1 }))])
  const ordinary = full([{ name: 'gilded_blackstone', count: 1 }])
  assert.equal((await makeRoom(ordinary, { slots: 1, forItem: 'stick' })).freed, 0, 'ordinary pickup retains its strict value ordering')
  assert.equal((await makeRoom(ordinary, { slots: 1, forItem: 'stick', allowEqual: true })).freed, 1)
  const protectedRecipe = full([{ name: 'oak_planks', count: 64 }])
  assert.equal((await makeRoom(protectedRecipe, { slots: 1, forItem: 'stick', allowEqual: true, preserve: new Set(['oak_planks']) })).freed, 0)
  const reserve = full([{ name: 'netherrack', count: 16 }])
  assert.equal((await makeRoom(reserve, { slots: 1, forItem: 'stick', allowEqual: true })).freed, 0, 'the emergency reserve cannot be exchanged for recipe output')
  const valuable = full([{ name: 'iron_nugget', count: 64 }])
  assert.equal((await makeRoom(valuable, { slots: 1, forItem: 'iron_ingot', allowEqual: true })).freed, 0, 'equal-value permission applies only to common outputs worth at most one')
})
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
test('место для результата крафта сохраняет остаток текущих ингредиентов', async () => {
  const stock = [{ name: 'blackstone', count: 15 }, { name: 'basalt', count: 8 }, { name: 'cobbled_deepslate', count: 64 }]
  for (let i = 0; i < 33; i++) stock.push({ name: 'iron_sword', count: 1 })
  const bot = bag(stock)
  const r = await makeRoom(bot, { slots: 1, forItem: 'stone_pickaxe', preserve: new Set(['blackstone', 'stick']) })
  assert.deepEqual(r.tossed, ['basalt×8'])
  assert.equal(bot.inventory.items().find(item => item.name === 'blackstone').count, 15)
})
test('запас: земля под ногами при недоборе запаса — не хлам', () => {
  const bot = bag([{ name: 'cobblestone', count: 8 }])
  bot.ndPlayPolicy = { mode: 'speedrun' }
  const drop = name => ({ getDroppedItem: () => ({ name, count: 1 }) })
  assert.equal(ignoreDrop(bot, drop('dirt')), false, '8 из 16 — подбирать')
  bot.inventory.slots[9].count = 64
  assert.equal(ignoreDrop(bot, drop('dirt')), true, 'запас полон — хлам')
})

for (const scenario of ['cliff', 'flat', 'cancelled']) test(`разгрузка: безопасный отход после выброса (${scenario})`, async () => {
  const { EventEmitter } = require('node:events')
  const { Vec3 } = require('vec3')
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const native = require('../src/tick-plugins').getPhysics()
  const clock = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const bot = Object.assign(new EventEmitter(), bag([]))
  const world = { getBlock(p) {
    const q = p.floored()
    const support = q.y === 63 && (scenario !== 'cliff' || q.x === 0 && q.z === 0)
    const block = Block.fromStateId(registry.blocksByName[support ? 'stone' : q.y === 32 ? 'lava' : 'air'].defaultState)
    block.position = q; return block
  } }
  const { IDLE } = require('../src/navigation/parkour')
  let control = { ...IDLE }
  Object.assign(bot, { version: '1.21.11', registry, health: 20, food: 20,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, -.0784000015258789, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    setControlState: (key, value) => { control[key] = value }, clearControlStates: () => { control = { ...IDLE } },
    look: async yaw => { bot.entity.yaw = yaw }
  })
  const step = () => {
    const state = new native.PlayerState(bot, control)
    bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick'); game.advanceTicks(1)
  }
  bot.waitForTicks = async ticks => { for (let i = 0; i < ticks; i++) step() }
  const pack = require('../src/pack'); const original = pack.tidy
  pack.tidy = async () => { if (scenario === 'cancelled') ctl.aborted = true; return { tossed: ['netherrack×10'] } }
  try {
    const session = { require: () => bot, runIntent: (_name, worker) => worker(ctl) }
    let done = false
    const work = require('../src/session/equipment').pack.call(session, { mode: 'tidy' }).finally(() => { done = true })
    for (let tick = 0; !done && tick < 3000; tick++) { await new Promise(resolve => setImmediate(resolve)); if (!done) step() }
    assert.equal(done, true, 'disposal must finish within its bounded movement')
    await work
    assert.equal(bot.entity.onGround, true, 'inventory disposal must preserve observed support above lava')
    assert.equal(bot.entity.position.y, 64)
    if (scenario === 'flat') assert.ok(bot.entity.position.distanceTo(new Vec3(.5, 64, .5)) > 1, 'safe terrain still allows leaving the discarded drop')
    else assert.ok(bot.entity.position.distanceTo(new Vec3(.5, 64, .5)) < .01, 'a cliff or cancellation must leave the body on its original support')
    assert.equal(control.forward, false)
  } finally { pack.tidy = original; game.dispose() }
})
