import test from 'node:test'
import assert from 'node:assert/strict'

// Настоящий RPC handler без bootstrap демона, сокетов и подключения к миру.
const { observationMethods }: typeof import('../src/rpc/observation') = require('../src/rpc/observation')
function status(bot: any) {
  const methods = observationMethods({ session: { bot, immediate: (fn: any) => fn() }, cfg: {}, state: { dangerWatch: null } })
  return methods.status
}

test('P7 ench status: реальные чары доходят до силы и физической готовности лаборатории', async () => {
  const { powerOf, labReady }: typeof import('../src/pvp/arms-graph') = require('../src/pvp/arms-graph')
  const observe = async (ench: Record<string, number>) => {
    const slots = Array(46).fill(null)
    slots[9] = { name: 'iron_sword', count: 1, componentMap: new Map([['enchantments', { data: {
      enchantments: Object.entries(ench).map(([id, level]) => ({ id: 'minecraft:' + id, level }))
    } }]]) }
    slots[10] = { name: 'lapis_lazuli', count: 3 }; slots[11] = { name: 'experience_bottle', count: 20 }
    return (await status({ inventory: { slots } })({ items: true })).items
  }
  const sharp = await observe({ sharpness: 5 }); const durable = await observe({ unbreaking: 3 }); const plain = await observe({})
  assert.equal(powerOf(sharp).total, 14.4)
  assert.equal(durable[0].ench.unbreaking, 3, 'небоевые чары тоже запрещают обычное повторное зачарование на столе')
  assert.equal(powerOf(durable).total, powerOf(plain).total)
  assert.equal(labReady(sharp), false)
  assert.equal(labReady(durable), false)
  assert.equal(labReady(plain), true)
})

test('Arms status: по запросу возвращает собственные заряды, звёзды и все слоты снаряжения', async () => {
  const slots = Array(46).fill(null)
  slots[0] = { name: 'diamond', count: 1 } // Результат крафта ещё не принадлежит инвентарю.
  slots[5] = { name: 'iron_helmet', count: 1 }
  slots[10] = { name: 'crossbow', count: 1, componentMap: new Map([['charged_projectiles', { data: {
    projectiles: [{ name: 'firework_rocket', components: [{ type: 'fireworks', data: { explosions: [{}, {}] } }] }]
  } }]]) }
  slots[36] = { name: 'firework_rocket', count: 7, componentMap: new Map([['fireworks', { data: { explosions: [{}, {}, {}] } }]]) }
  slots[45] = { name: 'spectral_arrow', count: 12 }
  const run = status({ inventory: { slots } })
  assert.equal((await run({})).items, undefined, 'описание инвентаря — только по запросу')
  const { items } = await run({ items: true })
  assert.deepEqual(Array.from(items, (item: any) => item.name), ['iron_helmet', 'crossbow', 'firework_rocket', 'spectral_arrow'])
  assert.equal(items[1].crossbow.loaded, true)
  assert.equal(items[1].crossbow.ammo, 'firework')
  assert.equal(items[1].crossbow.stars, 2)
  assert.equal(items[2].stars, 3)
  assert.equal(items[2].count, 7)
  assert.equal(items[3].count, 12)
})

test('Arms status: нет подключения — нет выдуманного собственного инвентаря', async () => {
  const result = await status(null)({ items: true })
  assert.equal(result.items.length, 0)
})

test('Arms storage contains exactly own slots 9..44 and marks component-bearing stacks as nonplain', async () => {
  const slots = Array(46).fill(null)
  slots[5] = { name: 'iron_helmet', count: 1 }
  slots[45] = { name: 'totem_of_undying', count: 1 }
  slots[9] = { name: 'arrow', count: 60, components: [], removedComponents: [], componentMap: new Map() }
  slots[10] = { name: 'arrow', count: 2, components: [{ type: 'custom_name', data: 'marked' }] }
  const run = status({ inventory: { slots } })
  assert.equal((await run({})).storage, undefined)
  const result = await run({ items: true })
  assert.equal(result.storage.length, 36)
  assert.equal(result.storage[0].name, 'arrow'); assert.equal(result.storage[0].plain, true)
  assert.equal(result.storage[1].plain, false)
  assert(result.storage.slice(2).every(i => i === null))
  assert.equal((await status(null)({ items: true })).storage, null, 'absent inventory is unknown capacity, not 36 free slots')
})
