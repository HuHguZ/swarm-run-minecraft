import test from 'node:test'
import assert from 'node:assert/strict'
const { eat } = require('../src/actions')

test('ordinary food uses the free second hand and restores its shield without moving the sword', async () => {
  const sword = { name: 'iron_sword', type: 1, count: 1 }
  const shield = { name: 'shield', type: 2, count: 1 }
  const food = { name: 'bread', type: 3, count: 2 }
  const slots: any[] = []; slots[45] = shield
  const equips: string[] = []
  const activations: boolean[] = []
  const bot: any = { health: 20, food: 10, heldItem: sword, entity: { onGround: true },
    inventory: { slots, items: () => [sword, shield, food].filter(item => item.count > 0) },
    equip: async (item: any, destination: string) => { equips.push(destination); if (destination === 'off-hand') slots[45] = item; else bot.heldItem = item },
    activateItem: (off: boolean) => { activations.push(off); food.count--; bot.food += 5 },
    deactivateItem: () => {} }
  const result = await eat({ bot, mcData: { foodsByName: { bread: { foodPoints: 5, saturation: 6 } } } })
  assert.equal(result.ate, 'bread')
  assert.equal(result.hand, 'off-hand')
  assert.deepEqual(activations, [true])
  assert.deepEqual(equips, ['off-hand', 'off-hand'])
  assert.equal(bot.heldItem, sword)
  assert.equal(slots[45], shield)
})
