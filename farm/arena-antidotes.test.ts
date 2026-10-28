import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { KITS, worthOf } from './arena/gear'
import { makeStockChests } from './arena/loot'
import { generate } from '../daemon/arena/colosseum-arms'
import { REPO_ROOT } from '../daemon/src/paths'

const mc = require(path.join(REPO_ROOT, 'daemon/node_modules/minecraft-data'))('1.21.11')

async function stock(L: any, round: number, only = true, crystal = false) {
  const prior = { loot: process.env.ARMS_LOOT, caches: process.env.ARMS_CACHES, crystal: process.env.ARMS_CRYSTAL }
  delete process.env.ARMS_LOOT; process.env.ARMS_CACHES = '0'; process.env.ARMS_CRYSTAL = crystal ? '1' : '0'
  const chests = new Map<string, Map<number, { name: string; count: number }>>(), overflow: string[] = []
  const ctx: any = { i: 28, L, X: 600, Y: 120, Z: 600, log() {}, sleep: async () => {}, rcon: async (_slot, command: string) => {
    const clear = /^data merge block (.+) \{Items:\[\]\}$/.exec(command)
    if (clear) chests.set(clear[1], new Map())
    const item = /^item replace block (.+) container\.(\d+) with minecraft:([a-z_]+)(?:\[.*\])? (\d+)$/.exec(command)
    if (item) {
      const slots = chests.get(item[1]) ?? new Map(); chests.set(item[1], slots)
      if (+item[2] >= 27) overflow.push(command)
      slots.set(+item[2], { name: item[3], count: +item[4] })
    }
    return 'ok'
  } }
  try { await makeStockChests(ctx)(round, only ? L.chests : null); return { chests, overflow } }
  finally {
    for (const [key, value] of [['ARMS_LOOT', prior.loot], ['ARMS_CACHES', prior.caches], ['ARMS_CRYSTAL', prior.crystal]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

test('ordinary arena loadouts add one milk and two honey in exactly two slots and still fit an inventory', () => {
  for (const kit of ['sword', 'team', 'teamair', 'elytra']) {
    const items = KITS[kit].map((item: string) => { const [spec, count = '1'] = item.split(/ (?=\d+$)/); return { name: spec.split('[')[0], count: +count } })
    const milk = items.filter(item => item.name === 'milk_bucket'), honey = items.filter(item => item.name === 'honey_bottle')
    assert.deepEqual(milk, [{ name: 'milk_bucket', count: 1 }], kit)
    assert.deepEqual(honey, [{ name: 'honey_bottle', count: 2 }], kit)
    assert.equal([...milk, ...honey].reduce((n, item) => n + Math.ceil(item.count / mc.itemsByName[item.name].stackSize), 0), 2)
    assert.ok(items.reduce((n, item) => n + Math.ceil(item.count / mc.itemsByName[item.name].stackSize), 0) <= 36, `${kit} overflows inventory`)
  }
  for (const kit of ['crystal', 'teamcrystal']) assert.equal(KITS[kit].some(item => /^(milk_bucket|honey_bottle)\b/.test(item)), false)
})

test('normal and hidden chest refills at every tier stock a bounded complete antidote pair', async () => {
  const L = { seed: 'antidote-tiers', map: 'colosseum', chests: [0, 8, 16, 24, 31, 34].flatMap((y, tier) => ['normal', 'secret'].map((kind, k) => ({
    id: `${tier}-${kind}`, kind, x: tier * 2 + k, y, z: k * 3, room: 'fixture',
  }))) }
  for (const round of [1, 5, 17]) {
    const { chests, overflow } = await stock(L, round)
    assert.deepEqual(overflow, []); assert.equal(chests.size, 12)
    for (const [where, slots] of chests) {
      const milk = [...slots].filter(([, item]) => item.name === 'milk_bucket'), honey = [...slots].filter(([, item]) => item.name === 'honey_bottle')
      assert.equal(milk.length, 1, `${where} milk`); assert.equal(honey.length, 1, `${where} honey`)
      assert.equal(milk[0][1].count, 1); assert.equal(honey[0][1].count, 2)
      assert.equal(honey[0][0], milk[0][0] + 1, 'one capacity-checked group, not independently truncated extras')
      assert.ok(slots.size <= 27)
    }
  }
})

test('a complete ordinary round preserves chest reserves and whole antidote groups; crystal loot stays unchanged', async () => {
  const L = generate('antidote-reserve'), { chests, overflow } = await stock(L, 3, false)
  assert.deepEqual(overflow, [])
  let paired = 0
  for (const slots of chests.values()) {
    const values = [...slots.values()], milk = values.some(item => item.name === 'milk_bucket'), honey = values.some(item => item.name === 'honey_bottle')
    assert.equal(milk, honey, 'reserve pressure cannot strand half an antidote group')
    if (milk) paired++
    assert.ok(slots.size <= 27)
  }
  assert.ok(paired > 0, 'actual ordinary chest contents include both antidotes')
  const crystal = await stock(L, 3, true, true)
  for (const slots of crystal.chests.values()) assert.equal([...slots.values()].some(item => /^(milk_bucket|honey_bottle)$/.test(item.name)), false)
})

test('loot valuation keeps both antidotes above low-value filler alongside ordinary food', () => {
  const sorted = ['dirt', 'milk_bucket', 'honey_bottle'].sort((a, b) => worthOf(b) - worthOf(a))
  assert.equal(sorted[2], 'dirt')
  for (const name of ['milk_bucket', 'honey_bottle']) assert.ok(worthOf(name) >= worthOf('bread'))
})
