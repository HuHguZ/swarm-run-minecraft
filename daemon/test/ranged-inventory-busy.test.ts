import test from 'node:test'
import assert from 'node:assert/strict'

const ranged = require('../src/ranged')
const registry = require('minecraft-data')('1.21.11')

const stack = (name: string, count: number, slot: number) => ({ name, count, slot, nbt: { private: 'not telemetry' } })
const brief = (item: any) => item ? { name: item.name, count: item.count, slot: item.slot } : null

for (const kind of ['window', 'cursor']) {
  test(`rocket load diagnostic identifies ${kind} at the actual guard before caller cleanup`, async () => {
    const crossbow = { name: 'crossbow', count: 1, slot: 36, componentMap: new Map() }
    const rocket = { ...stack('firework_rocket', 7, 9), componentMap: new Map([
      ['fireworks', { data: { flightDuration: 1, explosions: [{ shape: 'small_ball' }] } }]
    ]) }
    const inventoryCursor = kind === 'window' ? null : stack('oak_planks', 2, 12)
    const windowCursor = kind === 'window' ? stack('arrow', 1, 7) : null
    const window = kind === 'cursor' ? null : { id: 4, type: 'minecraft:generic_9x3', selectedItem: windowCursor, title: 'not telemetry', slots: [rocket] }
    const expected = { window: window ? { id: window.id, type: window.type } : null,
      inventoryCursor: brief(inventoryCursor), windowCursor: brief(windowCursor) }
    const slots: any[] = []; slots[9] = rocket; slots[36] = crossbow
    let equips = 0
    const bot: any = { registry, currentWindow: window,
      inventory: { selectedItem: inventoryCursor, slots, items: () => [rocket, crossbow] },
      equip: async () => { equips++ }
    }
    const messages: any[][] = []
    const oldLog = console.log
    const oldDebug = process.env.ND_DEBUG_PVP
    console.log = (...args: any[]) => { messages.push(args) }
    process.env.ND_DEBUG_PVP = '1'
    try {
      const stats: any = {}
      const result = await ranged.step(bot, { aborted: false }, { d: 12 }, {
        planned: { act: 'load', ammo: 'firework', item: crossbow }, stats,
        // Real step calls holdWeapon before logging. Preserve the guard's
        // evidence even if that cleanup changes the menu or cursor meanwhile.
        holdWeapon: async () => { bot.currentWindow = null; bot.inventory.selectedItem = null }
      })
      assert.equal(result.ok, false)
      assert.equal(result.why, 'курсор занят')
      assert.equal(equips, 0, 'occupied inventory still prevents rocket manipulation')
      assert.equal(stats.loadFails, 1)
      const line = messages.find(args => args[0] === '[xbow]' && args[1] === 'load')
      assert.ok(line, 'actual step emits its existing debug log')
      const logged = JSON.parse(line[2])
      assert.deepEqual(logged.inventoryBusy, expected)
      assert.equal(line[2].includes('not telemetry'), false, 'no NBT, title or inventory dump')
    } finally {
      console.log = oldLog
      if (oldDebug === undefined) delete process.env.ND_DEBUG_PVP
      else process.env.ND_DEBUG_PVP = oldDebug
    }
  })
}
