import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStockChests } from './arena/loot'
import { generate } from '../daemon/arena/colosseum-arms'

test('arena loot includes six tipped arrow types, Punch II catapult, and Lunge spears within chest capacity', async () => {
  const commands: string[] = [], L = generate('team1')
  const ctx: any = { i: 31, L, X: 600, Y: 120, Z: 600, log() {}, sleep: async () => {}, rcon: async (_slot, command) => { commands.push(command); return 'ok' } }
  await makeStockChests(ctx)(1, L.chests)
  for (const potion of ['swiftness', 'regeneration', 'slowness', 'weakness', 'poison', 'harming'])
    assert.ok(commands.some(c => c.includes(`tipped_arrow[potion_contents={potion:"minecraft:${potion}"}]`)), potion)
  assert.ok(commands.some(c => c.includes('bow[enchantments={punch:2}]')))
  assert.ok(commands.some(c => /_spear\[.*lunge:[123]/.test(c)))
  assert.ok(commands.filter(c => /riptide/.test(c)).every(c => !/loyalty|channeling/.test(c)), 'Riptide never with Loyalty or Channeling')
  const maces = commands.filter(c => /minecraft:mace\[/.test(c))
  assert.ok(maces.length && maces.every(c => /wind_burst:[123]/.test(c) && !(/density/.test(c) && /breach/.test(c))), 'every mace has Wind Burst; Density and Breach exclusive')
  for (const command of commands) {
    const slot = /container\.(\d+)/.exec(command)
    if (slot) assert.ok(Number(slot[1]) < 27, command)
  }
})

test('thirty complete rounds reserve actual chest capacity for tools, recipes and round additions', async () => {
  for (let round = 1; round <= 30; round++) {
    const L = generate('team' + round), chests = new Map<string, Set<string>>(), invalid: string[] = []
    const ctx: any = { i: 31, L, X: 600, Y: 120, Z: 600, log() {}, sleep: async () => {}, rcon: async (_slot, command: string) => {
      const match = /^item replace block (.+) container\.(\d+) with minecraft:([a-z_]+)/.exec(command)
      if (match) {
        if (Number(match[2]) >= 27) invalid.push(command)
        const items = chests.get(match[1]) || new Set<string>(); items.add(match[3]); chests.set(match[1], items)
      }
      return 'ok'
    } }
    await makeStockChests(ctx)(round)
    assert.deepEqual(invalid, [], `round ${round}: every item fits a real slot`)
    for (const items of chests.values()) {
      if (items.has('soul_sand')) assert.ok(items.has('water_bucket'), 'bubble-column pair')
      if (items.has('end_crystal')) assert.ok(items.has('obsidian'), 'crystal pair')
      if (items.has('respawn_anchor')) assert.ok(items.has('glowstone'), 'anchor pair')
      if (items.has('crafting_table')) assert.ok(items.has('stick') && (items.has('iron_ingot') || items.has('diamond')), 'tool crafting recipe')
    }
  }
})
