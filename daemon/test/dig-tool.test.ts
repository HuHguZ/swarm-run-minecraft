'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { equipBestTool } from '../src/items'
import * as tools from '../src/tools'
const sword = { name: 'stone_sword', type: 1, maxDurability: 131 }
const log = { name: 'oak_log', type: 2 }
const shovel = { name: 'stone_shovel', type: 3, maxDurability: 131 }
function botWith (items) {
  const bot: Record<string, any> = { heldItem: sword, inventory: { items: () => items },
    async equip (it) { bot.heldItem = it }, async unequip () { bot.heldItem = null } }
  return bot
}
test('без лопаты земля копается предметом без прочности вместо оставшегося меча', async () => {
  const bot = botWith([sword, log])
  await equipBestTool(bot, { name: 'dirt' })
  assert.equal(bot.heldItem, log)
})
test('при наличии лопаты земля копается лопатой', async () => {
  const bot = botWith([sword, log, shovel])
  await equipBestTool(bot, { name: 'grass_block' })
  assert.equal(bot.heldItem, shovel)
})
test('без подходящего инструмента или обычного предмета освобождается рука', async () => {
  const bot = botWith([sword])
  await equipBestTool(bot, { name: 'dirt' })
  assert.equal(bot.heldItem, null)
})

test('общая копка не заменяет руку мечом ради небольшой прибавки скорости на земле', async () => {
  const bot = botWith([sword, log])
  const block = { name: 'dirt', hardness: 0.5, diggable: true, digTime: type => type === sword.type ? 500 : 1000, canHarvest: () => true }
  let used
  bot.dig = async () => { used = bot.heldItem }
  tools.install(bot)
  await bot.dig(block, true)
  assert.equal(used, log)
})

test('общая копка глины без лопаты убирает оставшуюся кирку', async () => {
  const pick = { name: 'stone_pickaxe', type: 4, maxDurability: 131 }
  const bot = botWith([pick, log])
  bot.heldItem = pick
  const block = { name: 'clay', hardness: 0.6, diggable: true, digTime: () => 900, canHarvest: () => true }
  let used
  bot.dig = async () => { used = bot.heldItem }
  tools.install(bot)
  await bot.dig(block, true)
  assert.equal(used, log)
})

test('меч остаётся допустимым инструментом для паутины', () => {
  const bot = botWith([sword, log])
  const block = { name: 'cobweb', hardness: 4, diggable: true, digTime: type => type === sword.type ? 400 : 20000, canHarvest: type => type === sword.type }
  assert.equal(tools.bestFor(bot, block).item, sword)
})

for (const [name, mode, worn, expected] of [
  ['stone', 'speedrun', 0, 'stone_pickaxe'],
  ['diamond_ore', 'speedrun', 0, 'iron_pickaxe'],
  ['stone', 'free', 0, 'iron_pickaxe'],
  ['stone', 'speedrun', 124, 'iron_pickaxe']
]) test(`общая копка ${name}, ${mode}, износ ${worn}: ${expected}`, async () => {
  const iron = { name: 'iron_pickaxe', type: 5, slot: 10, maxDurability: 250 }
  const stone = { name: 'stone_pickaxe', type: 4, slot: 11, maxDurability: 131, durabilityUsed: worn }
  const bot = botWith([iron, stone])
  bot.heldItem = iron
  bot.ndPlayPolicy = { mode }
  const block = { name, hardness: 1.5, diggable: true, digTime: type => type === 5 ? 250 : type === 4 ? 400 : 1000,
    canHarvest: type => name !== 'diamond_ore' || type === 5 }
  let used
  bot.dig = async () => { used = bot.heldItem }
  tools.install(bot)
  await bot.dig(block, true)
  assert.equal(used.name, expected)
})

test('копка, пережившая смерть, не вешает pathfinder: дальний блок — отказ сразу, смерть обрывает копку, флаг сбрасывается при возрождении', async () => {
  const { EventEmitter }: typeof import('node:events') = require('node:events')
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const bot = Object.assign(new EventEmitter(), botWith([log]))
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  let rawCalls = 0
  // Копка блока в выгруженном чанке после возрождения: промис mineflayer не кончается никогда.
  bot.dig = () => { rawCalls++; return new Promise<void>(() => {}) }
  tools.install(bot)
  const far = { name: 'stone', position: new Vec3(3049, 256, 3000), hardness: 1.5, diggable: true, digTime: () => 750, canHarvest: () => true }
  await assert.rejects(bot.dig(far, true), /вне досягаемости/)
  assert.equal(rawCalls, 0)
  const near = { ...far, position: new Vec3(1, 63, 0) }
  const p = bot.dig(near, true)
  await new Promise<any>(resolve => setImmediate(resolve))
  bot.emit('death')
  await assert.rejects(p, /смерть/)
  assert.equal(bot.listenerCount('death'), 0, 'слушатель смерти снят')
  // Флаг pathfinder'а, оставшийся без копки: сброс пути + diggingAborted (так снимает его сам pathfinder).
  let digging = true
  let goals = 0
  bot.targetDigBlock = null
  bot.pathfinder = { isMining: () => digging, setGoal: () => { goals++; bot.once('diggingAborted', () => { digging = false }) } }
  assert.equal(tools.unstickPathfinderDig(bot), true)
  assert.equal(goals, 1)
  assert.equal(tools.unstickPathfinderDig(bot), false, 'копки нет — трогать нечего')
})
