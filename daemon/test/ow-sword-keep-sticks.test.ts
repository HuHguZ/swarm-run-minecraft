import test from 'node:test'
import assert from 'node:assert/strict'
import { toolPlan } from '../src/items'
const mcData = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')

// owC10-02/08: после деревянной кирки 3 доски + 2 палки; автопилот ковал из них деревянный меч — палок на каменную кирку нет.
const bot = (items: Record<string, number>) => ({
  inventory: { items: () => Object.entries(items).map(([name, count]) => ({ name, count, durabilityUsed: 0, maxDurability: mcData.itemsByName[name]?.maxDurability })) },
  findBlock: () => null
})

test('ND_OW_SWORD_KEEP_STICKS: no wooden sword before the stone pick; stone sword and the old behaviour stay', () => {
  const start = { wooden_pickaxe: 1, oak_planks: 3, stick: 2, crafting_table: 1 }
  delete process.env.ND_OW_SWORD_KEEP_STICKS
  assert.equal(toolPlan(bot(start), mcData)?.item, 'wooden_sword', 'flag off: the old wooden sword')
  process.env.ND_OW_SWORD_KEEP_STICKS = '1'
  try {
    assert.equal(toolPlan(bot(start), mcData), null)
    assert.equal(toolPlan(bot({ ...start, cobblestone: 2 }), mcData)?.item, 'stone_sword', 'rubble: the stone sword is made')
    assert.equal(toolPlan(bot({ stone_pickaxe: 1, oak_planks: 3, stick: 2, crafting_table: 1 }), mcData)?.item, 'wooden_sword')
  } finally { delete process.env.ND_OW_SWORD_KEEP_STICKS }
})
