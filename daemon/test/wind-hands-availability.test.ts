import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureHotbar } from '../src/mace/hands'

function fixture() {
  const names = ['netherite_sword', 'mace', 'netherite_axe', 'bow', 'crossbow', 'golden_apple', 'water_bucket', 'ender_pearl', 'shield']
  const slots: any[] = []
  names.forEach((name, i) => { slots[36 + i] = { name, slot: 36 + i, count: 1 } })
  slots[9] = { name: 'wind_charge', slot: 9, count: 1 }
  const moved: number[][] = []
  const bot: any = { quickBarSlot: 0, inventory: { slots, items: () => slots.filter(Boolean) },
    moveSlotItem: async (from, to) => {
      moved.push([from, to]); [slots[from], slots[to]] = [slots[to], slots[from]]
      if (slots[from]) slots[from].slot = from
      if (slots[to]) slots[to].slot = to
    } }
  return { bot, slots, moved }
}

test('a packed valued hotbar can swap in its last wind charge without losing items or the held weapon', async () => {
  const f = fixture(), before = f.slots.filter(Boolean).slice()
  assert.equal(await ensureHotbar(f.bot, ['wind_charge']), true)
  assert.equal(f.slots[36].name, 'netherite_sword')
  assert.equal(f.slots[9].name, 'shield')
  assert.equal(f.slots[44].name, 'wind_charge')
  assert.deepEqual(f.moved, [[9, 44]])
  assert.equal(f.slots.filter(Boolean).length, before.length)
  assert.ok(before.every(item => f.slots.includes(item)))
})

test('hotbar fallback preserves another requested tool while permitting duplicate tools to be swapped', async () => {
  const f = fixture()
  for (let i = 1; i < 9; i++) f.slots[36 + i] = { name: 'mace', slot: 36 + i, count: 1 }
  assert.equal(await ensureHotbar(f.bot, ['mace', 'wind_charge']), true)
  assert.equal(f.slots[37].name, 'mace')
  assert.equal(f.slots[44].name, 'wind_charge')
  assert.equal(f.slots[36].name, 'netherite_sword')
})

test('hotbar fallback still rejects an open window, carried cursor item, missing charge or failed swap', async () => {
  for (const key of ['currentWindow', 'cursor', 'missing', 'failed']) {
    const f = fixture()
    if (key === 'currentWindow') f.bot.currentWindow = {}
    if (key === 'cursor') f.bot.inventory.selectedItem = {}
    if (key === 'missing') f.slots[9] = null
    if (key === 'failed') f.bot.moveSlotItem = async () => { throw Error('native swap failed') }
    assert.equal(await ensureHotbar(f.bot, ['wind_charge']), false, key)
    assert.equal(f.slots[36].name, 'netherite_sword')
    assert.notEqual(f.slots[44].name, 'wind_charge')
  }
})
