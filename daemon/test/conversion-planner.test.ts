import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { planConversion } from '../src/conversions/planner'
import { guaranteedDrops, conversionRecipes, conversionProvenance } from '../src/conversions/registry'
import { craftConverted, craftStepMismatch } from '../src/conversions/runtime'
import { EventEmitter } from 'node:events'

const mc = require('minecraft-data')('1.21.11')
const harvestTools = Object.fromEntries(Object.entries(mc.blocksByName).map(([name, block]: [string, any]) => [name, Object.keys(block.harvestTools ?? {}).map(id => mc.items[id].name)]))

test('runtime crafting witness rejects duplicated ingredients even when output looks sufficient', () => {
  const step = planConversion({ iron_ingot: 9 }, 'iron_nugget', 81).steps[0]
  assert.equal(craftStepMismatch({ iron_ingot: 9 }, { iron_nugget: 81 }, step), null)
  assert.match(craftStepMismatch({ iron_ingot: 9 }, { iron_ingot: 27, iron_nugget: 81 }, step)!, /iron_ingot/)
  assert.match(craftStepMismatch({ iron_ingot: 9 }, { iron_nugget: 72 }, step)!, /iron_nugget/)
})

test('a real own collect receipt preserves exact crafting consumption without concealing output duplication', () => {
  const drops = require('../src/drops')
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter(); bot.registry = mc; bot.entity = { id: 1 }
  bot.entities = { 10: { id: 10, name: 'item', position: new (require('vec3'))(0, 0, 0), getDroppedItem: () => ({ name: 'blackstone', count: 10 }) } }
  const mark = drops.pickupMark(bot)
  bot._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 10, pickupItemCount: 10 })
  const step = planConversion({ blackstone: 64, stick: 2, crafting_table: 1 }, 'stone_pickaxe', 1, { table: true }).steps[0]
  const before = { blackstone: 64, stick: 2 }
  const after = { blackstone: 71, stick: 0, stone_pickaxe: 1 }
  assert.equal(craftStepMismatch(before, after, step, drops.pickupDelta(bot, mark)), null)
  assert.match(craftStepMismatch(before, after, step)!, /blackstone/)
  assert.match(craftStepMismatch(before, { ...after, blackstone: 74 }, step, drops.pickupDelta(bot, mark))!, /blackstone/)
  assert.match(craftStepMismatch(before, { ...after, stone_pickaxe: 2 }, step, { blackstone: 10, stone_pickaxe: 1 })!, /stone_pickaxe/)
  bot._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 99, pickupItemCount: 10 })
  assert.match(craftStepMismatch(before, after, step, drops.pickupDelta(bot, mark))!, /blackstone/)
})

test('the runtime accounts for witnessed ingredient pickup and exposes the receipt range in its existing result', async t => {
  const Item = require('prismarine-item')(mc)
  const windows = require('prismarine-windows')(mc)
  const Vec3 = require('vec3')
  t.mock.method(require('../src/invsync'), 'refresh', async () => true)
  t.mock.method(require('../src/actions'), 'craft', async (session: any) => {
    const bot = session.bot
    bot.inventory.updateSlot(9, new Item(mc.itemsByName.blackstone.id, 61))
    bot.inventory.updateSlot(11, null)
    bot.inventory.updateSlot(13, new Item(mc.itemsByName.stone_pickaxe.id, bot.mode === 'duplicate' ? 2 : 1))
    bot._client.emit('collect', { collectorEntityId: bot.mode === 'foreign' ? 2 : 1, collectedEntityId: 10, pickupItemCount: 10 })
    bot.inventory.updateSlot(9, new Item(mc.itemsByName.blackstone.id, 64))
    bot.inventory.updateSlot(10, new Item(mc.itemsByName.blackstone.id, 7))
    return { crafted: 'stone_pickaxe', count: 1 }
  })
  for (const mode of ['own', 'foreign', 'unknown', 'duplicate']) {
    const bot: any = new EventEmitter()
    bot._client = new EventEmitter(); bot.registry = mc; bot.version = '1.21.11'; bot.mode = mode
    bot.entity = { id: 1, position: new Vec3(0, 0, 0) }
    bot.entities = { 10: { id: 10, name: 'item', position: new Vec3(0, 0, 0),
      getDroppedItem: () => mode === 'unknown' ? null : new Item(mc.itemsByName.blackstone.id, 10) } }
    bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'inventory')
    for (const [slot, name, count] of [[9, 'blackstone', 64], [11, 'stick', 2], [12, 'crafting_table', 1]] as const) {
      bot.inventory.updateSlot(slot, new Item(mc.itemsByName[name].id, count))
    }
    bot.findBlock = () => ({ name: 'crafting_table', position: new Vec3(1, 0, 0) })
    const session: any = { bot, mcData: mc }
    const run = () => craftConverted(session, { aborted: false }, { item: 'stone_pickaxe', count: 1 })
    if (mode === 'own') {
      const result = await run()
      assert.deepEqual(result.conversion.steps[0].pickups, { items: { blackstone: 10 }, from: 1, to: 1, epoch: 0 })
      assert.deepEqual(session.lastConversion.completed[0].pickups, result.conversion.steps[0].pickups)
    } else await assert.rejects(run, /расход stone_pickaxe не подтверждён/)
  }
})

test('conversion baseline includes items returned by the confirmed inventory close', async t => {
  const Item = require('prismarine-item')(mc)
  const windows = require('prismarine-windows')(mc)
  const sync = require('../src/invsync')
  let crafts = 0
  t.mock.method(require('../src/actions'), 'craft', async (session: any) => {
    assert.equal(await sync.refresh(session.bot, 1000, true), true)
    const inventory = session.bot.inventory
    inventory.updateSlot(10, null); inventory.updateSlot(11, null)
    inventory.updateSlot(13, new Item(mc.itemsByName.stone_pickaxe.id, 1))
    crafts++
    return { crafted: 'stone_pickaxe', count: 1 }
  })
  const makeBot = (confirm = true) => {
    const bot: any = new EventEmitter()
    bot._client = new EventEmitter(); bot.registry = mc; bot.version = '1.21.11'
    bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'inventory')
    for (const [slot, name, count] of [[1, 'stone_pickaxe', 1], [10, 'blackstone', 3], [11, 'stick', 2], [12, 'crafting_table', 1]] as const) {
      bot.inventory.updateSlot(slot, new Item(mc.itemsByName[name].id, count))
    }
    const serverSlots = [...bot.inventory.slots]
    bot.findBlock = () => null
    bot._client.on('window_items', (packet: any) => packet.items.forEach((value: any, slot: number) => bot.inventory.updateSlot(slot, Item.fromNotch(value))))
    const packets: string[] = []
    bot._client.write = (name: string) => {
      packets.push(name)
      if (name === 'close_window' && serverSlots[1]) {
        serverSlots[9] = serverSlots[1]; serverSlots[1] = null
      } else if (name === 'window_click') {
        queueMicrotask(() => confirm ? bot._client.emit('window_items', { windowId: 0, stateId: packets.length, items: serverSlots.map(Item.toNotch), carriedItem: Item.toNotch(null) }) : bot.emit('end'))
      }
    }
    return { bot, packets }
  }
  const initial = makeBot()
  const plan = await craftConverted({ bot: initial.bot, mcData: mc }, { aborted: false }, { item: 'stone_pickaxe', count: 1, planOnly: true })
  assert.equal(plan.conversionPlan.ok, true)
  assert.deepEqual(initial.packets, [], 'a read-only plan must not close the inventory')
  const result = await craftConverted({ bot: initial.bot, mcData: mc }, { aborted: false }, { item: 'stone_pickaxe', count: 1 })
  assert.equal(result.count, 1)
  assert.equal(initial.bot.inventory.items().filter((item: any) => item.name === 'stone_pickaxe').length, 2)
  assert.equal(crafts, 1)
  const refused = makeBot(false)
  await assert.rejects(craftConverted({ bot: refused.bot, mcData: mc }, { aborted: false }, { item: 'stone_pickaxe', count: 1 }), /сервер не подтвердил/)
  assert.equal(crafts, 1, 'a missing inventory receipt must prevent crafting')
})

test('cobweb to bow plans sword harvesting, exact string yield and crafting consumption', () => {
  const plan = planConversion({ cobweb: 3, stick: 3, crafting_table: 1, diamond_sword: 1 }, 'bow', 1,
    { harvestTools, tools: [{ item: 'diamond_sword' }] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.deepEqual(plan.steps.map(step => [step.mechanism, step.output.item, step.output.count]), [['place-dig', 'string', 3], ['craft', 'bow', 1]])
  assert.equal(plan.steps[0].tool, 'diamond_sword')
  assert.equal(plan.inventory.cobweb, 0)
  assert.equal(plan.inventory.string, 0)
  assert.equal(plan.inventory.stick, 0)
  assert.equal(plan.inventory.bow, 1)
})

test('metal conversions conserve quantities and reject a cycle that creates matter', () => {
  const unpack = planConversion({ iron_block: 1 }, 'iron_nugget', 81)
  assert.equal(unpack.ok, true, JSON.stringify(unpack))
  assert.equal(unpack.inventory.iron_block, 0)
  assert.equal(unpack.inventory.iron_ingot, 0)
  assert.equal(unpack.inventory.iron_nugget, 81)
  const pack = planConversion({ iron_nugget: 81 }, 'iron_block', 1, { table: true })
  assert.equal(pack.ok, true, JSON.stringify(pack))
  assert.equal(pack.inventory.iron_nugget, 0)
  assert.equal(pack.inventory.iron_block, 1)
  const impossible = planConversion({ iron_block: 1 }, 'iron_block', 1, { maxBranches: 50 })
  assert.equal(impossible.ok, false)
  assert.ok(impossible.expanded <= 53)
})

test('data provenance, tool gates and unsupported mechanisms stay explicit', () => {
  assert.equal(conversionProvenance.version, '1.21.11')
  assert.match(conversionProvenance.jarSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(guaranteedDrops('cobweb', { item: 'shears' }), [{ item: 'cobweb', count: 1 }])
  assert.deepEqual(guaranteedDrops('cobweb', { item: 'diamond_sword', enchantments: { silk_touch: 1 } }), [{ item: 'cobweb', count: 1 }])
  assert.equal(planConversion({ cobweb: 3, stick: 3, crafting_table: 1 }, 'bow', 1, { harvestTools }).ok, false)
  assert.ok(conversionRecipes.some(r => r.mechanism === 'stonecutting' && !r.executable))
})

test('smelting plan includes fuel and furnace resource requirements', () => {
  const plan = planConversion({ raw_iron: 3, coal: 1, furnace: 1 }, 'iron_ingot', 3,
    { fuels: [{ item: 'coal', items: 8, spare: 1 }] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.steps[0].mechanism, 'smelt')
  assert.equal(plan.steps[0].fuel, 'coal')
  assert.equal(plan.inventory.raw_iron, 0)
  assert.equal(plan.inventory.coal, 0)
  assert.equal(plan.inventory.iron_ingot, 3)
})
