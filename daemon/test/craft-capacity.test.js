'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

function fixture ({ free = 0, output = true } = {}) {
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
  const context = { module: { exports: {} }, console, Date, setTimeout, clearTimeout,
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
