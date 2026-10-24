import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStockChests } from './arena/loot'
import { generate } from '../daemon/arena/colosseum-arms'

test('mixed Colosseum loot supplies paired pearl-trap and crystal kits in bounded stacks', async () => {
  const L = generate('team1'), chests = new Map<string, Map<string, number>>()
  const ctx: any = { i: 31, L, X: 600, Y: 120, Z: 600, log() {}, sleep: async () => {},
    rcon: async (_slot, command: string) => {
      const match = /^item replace block (.+) container\.\d+ with minecraft:([a-z_]+)(?:\[.*\])? (\d+)$/.exec(command)
      if (match) { const items = chests.get(match[1]) || new Map<string, number>(); items.set(match[2], Number(match[3])); chests.set(match[1], items) }
      return 'ok'
    } }
  await makeStockChests(ctx)(1, L.chests)
  for (const item of ['soul_sand', 'water_bucket', 'end_crystal', 'obsidian', 'respawn_anchor', 'glowstone'])
    assert.ok([...chests.values()].some(items => items.has(item)), `missing ${item}`)
  for (const items of chests.values()) {
    if (items.has('soul_sand')) { assert.equal(items.get('soul_sand'), 4); assert.equal(items.get('water_bucket'), 1) }
    if (items.has('end_crystal')) { assert.ok([2, 3, 4].includes(items.get('end_crystal')!)); assert.ok(items.get('obsidian')! >= 4) }
    if (items.has('respawn_anchor')) { assert.equal(items.get('respawn_anchor'), 1); assert.ok([4, 8].includes(items.get('glowstone')!)) }
    if (items.has('mace')) assert.ok(items.has('wind_charge'))
  }
})
