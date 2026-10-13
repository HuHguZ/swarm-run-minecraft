import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const esbuild = require('esbuild')
const actionsFile = path.resolve(__dirname, '../src/actions.ts')
const req = createRequire(actionsFile)
const text = fs.readFileSync(actionsFile, 'utf8')
const mealSource = text.slice(text.indexOf('const RISKY_FOOD ='), text.indexOf('async function drop (session'))
const handsFile = path.resolve(__dirname, '../src/consumable-hands.ts')
const hands = { exports: {} as any }
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(handsFile, 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: hands, exports: hands.exports, require: req })

function scene({ shield = false, resume = false, include45 = false, failed = false, count = 6, mainItem = 'iron_sword', returnBlocked = false, fullBag = false } = {}) {
  let time = 0, biteAt: number | null = null, useHand = 45
  const slots: any[] = Array(46).fill(null)
  slots[36] = { name: mainItem, type: 1, count: 1, slot: 36 }
  const food = { name: 'cooked_mutton', type: 2, count, slot: resume ? 45 : 9 }
  slots[food.slot] = food
  if (fullBag) for (let i = 9; i < 45; i++) if (!slots[i]) slots[i] = { name: 'dirt', type: 4, count: 64, slot: i }
  if (shield) slots[45] = { name: 'shield', type: 3, count: 1, slot: 45 }
  const bag = () => slots.slice(9, include45 ? 46 : 45).filter(Boolean)
  const move = (from: number, to: number) => {
    const item = slots[from], old = slots[to]; slots[to] = item; slots[from] = old
    if (item) item.slot = to
    if (old) old.slot = from
  }
  const putAway = async () => {
    if (fullBag) { slots[45] = null; return } // installed mineflayer.putAway drops it when no bag slot is free
    if (returnBlocked) throw new Error('inventory full')
    const empty = slots.findIndex((i, slot) => slot >= 9 && slot < 45 && !i)
    assert.ok(empty >= 9); move(45, empty)
  }
  const bot: any = { food: 6, health: 15, entity: { onGround: true }, usingHeldItem: false,
    inventory: { slots, items: bag, emptySlotCount: () => slots.slice(9, 45).filter(i => !i).length }, get heldItem() { return slots[36] },
    equip: async (item, destination) => move(item.slot, destination === 'off-hand' ? 45 : 36),
    activateItem: (off: boolean) => { assert.equal(off, true); useHand = 45; biteAt = time + 1600 },
    consume: async () => { useHand = 36; biteAt = time + 1600 },
    deactivateItem: () => { biteAt = null }, unequip: putAway }
  const clock = { now: () => time }
  const sleep = async (ms: number) => {
    await Promise.resolve(); time += ms
    if (!failed && biteAt !== null && time >= biteAt) {
      const item = slots[useHand]; item.count--; if (!item.count) slots[useHand] = null
      bot.food = Math.min(20, bot.food + 6); biteAt = null
    }
  }
  const module = { exports: {} as any }
  vm.runInNewContext(esbuild.transformSync(mealSource + '\nmodule.exports = {eat, bestFood}', { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, gameClock: clock, sleep,
      itemNamed: (b, name) => b.inventory.items().find(i => i.name === name),
      require: name => name === './consumable-hands' ? hands.exports : req(name) })
  return { bot, slots, food, bag, time: () => time, eat: params => module.exports.eat({ bot,
    mcData: { foodsByName: { cooked_mutton: { foodPoints: 6, saturation: 9.6 } } } }, params) }
}

for (const shield of [false, true]) test(`eat awaits a real bite with sword and ${shield ? 'shield' : 'empty offhand'}, keeps remaining stock`, async () => {
  const s = scene({ shield }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton')
  assert.equal(result.hand, 'off-hand', 'keep the sword available for a fall clutch')
  assert.equal(s.time(), 1600, 'equip is not evidence of consumption')
  assert.equal(result.gain, 6); assert.equal(result.spent, 1)
  assert.equal(s.bot.food, 12); assert.equal(s.bag().find(i => i.name === 'cooked_mutton').count, 5)
  assert.equal(s.slots[45]?.name ?? null, shield ? 'shield' : null)
  assert.equal(s.bot.heldItem.name, 'iron_sword')
})
for (const named of [false, true]) test(`eat resumes food already in offhand (${named ? 'named' : 'bestFood'}), returns remainder to bag`, async () => {
  const s = scene({ resume: true }), result = await s.eat(named ? { item: 'cooked_mutton' } : {})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.spent, 1)
  assert.equal(s.bot.food, 12); assert.equal(s.slots[45], null)
  assert.equal(s.bag().find(i => i.name === 'cooked_mutton').count, 5)
})
test('moving food to offhand never claims a bite when the server ignores use', async () => {
  const s = scene({ failed: true }), result = await s.eat({})
  assert.equal(result.ate, null); assert.equal(s.bot.food, 6)
  assert.equal(s.time(), 4000); assert.match(result.error, /сытость не выросла/)
  assert.equal(s.bag().find(i => i.name === 'cooked_mutton').count, 6)
})
test('counted offhand is not counted twice if an inventory provider includes slot45', async () => {
  const s = scene({ include45: true, resume: true }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.spent, 1)
})
test('the last offhand bite depletes the stack without attempting to move a nonexistent item', async () => {
  const s = scene({ count: 1 }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.spent, 1)
  assert.equal(s.slots[45], null); assert.equal(s.bag().some(i => i.name === 'cooked_mutton'), false)
})


test('food resumed from offhand restores a nonweapon main hand and returns its remainder', async () => {
  const s = scene({ resume: true, mainItem: 'stone_pickaxe' }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.hand, 'hand'); assert.equal(result.spent, 1)
  assert.equal(s.bot.heldItem.name, 'stone_pickaxe'); assert.equal(s.slots[45], null)
  assert.equal(s.bag().find(i => i.name === 'cooked_mutton').count, 5)
})
test('a failed return to a full bag does not invent extra consumed pieces', async () => {
  const s = scene({ returnBlocked: true }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.gain, 6); assert.equal(result.spent, 1)
  assert.match(result.handBack, /inventory full/); assert.equal(s.slots[45].count, 5)
  const again = await s.eat({})
  assert.equal(again.ate, 'cooked_mutton'); assert.equal(again.spent, 1); assert.equal(s.slots[45].count, 4)
})


test('a full bag keeps the edible offhand remainder instead of invoking mineflayer putAway which would drop it', async () => {
  const s = scene({ resume: true, fullBag: true }), result = await s.eat({})
  assert.equal(result.ate, 'cooked_mutton'); assert.equal(result.spent, 1)
  assert.equal(s.slots[45].name, 'cooked_mutton'); assert.equal(s.slots[45].count, 5)
  assert.equal(s.bot.food, 12)
})
