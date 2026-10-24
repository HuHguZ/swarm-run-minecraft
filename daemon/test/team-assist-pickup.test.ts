import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { Vec3 } from 'vec3'
import { inPickup } from '../src/drops'

test('assist pickup frees capacity, reaches the native box and waits for its own slot receipt', async () => {
  for (const mode of ['full', 'full-generic', 'full-auto', 'below', 'delayed', 'foreign', 'cancelled']) {
    const item: any = { id: 10, name: 'item', position: new Vec3(.5, mode === 'below' ? 62.8 : 64.1, .5),
      getDroppedItem: () => ({ name: 'diamond_boots', count: 1 }) }
    const slots: any[] = Array(46).fill(null)
    if (mode.startsWith('full')) {
      for (let i = 9; i < 45; i++) slots[i] = { slot: i, name: 'stone_sword', count: 1 }
      slots[9] = { slot: 9, name: 'rotten_flesh', count: 64 }
    }
    const inventory = { slots, items: () => slots.slice(9, 45).filter(Boolean),
      emptySlotCount: () => slots.slice(9, 45).filter(i => !i).length }
    const ctl = { aborted: false }, bot: any = { inventory, entities: { 10: item },
      entity: { position: new Vec3(.5, 64, .5), onGround: true }, registry: { itemsByName: { diamond_boots: { stackSize: 1 } } },
      lookAt: async () => {}, tossStack: async i => {
        slots[i.slot] = mode === 'full-auto' ? { name: 'diamond_boots', count: 1 } : null
        if (mode === 'full-auto') delete bot.entities[10]
      } }
    let ticks = 0, moves = 0
    bot.waitForTicks = async () => {
      ticks++
      if (mode === 'cancelled' && ticks === 2) ctl.aborted = true
      const delayed = ['delayed', 'foreign', 'cancelled'].includes(mode)
      if (delayed && ticks === 1) delete bot.entities[10]
      if (mode !== 'foreign' && mode !== 'cancelled' && ticks >= (delayed ? 3 : 40) &&
          inventory.emptySlotCount() && inPickup(bot.entity.position, item.position)) {
        slots[slots.findIndex((i, k) => k >= 9 && k < 45 && !i)] = { name: 'diamond_boots', count: 1 }
        delete bot.entities[10]
      }
    }
    const file = path.resolve(__dirname, '../src/pvp/team-assist.ts'), local = createRequire(file)
    const overrides = { './vec3': { Vec3 }, '../pick': { canHit: () => true },
      '../navigation/geometry': { supportAt: () => ({ top: 63 }) },
      '../navigation/parkour': { ROUTE_FRAMES: 6000, executeJump: async (_bot, _ctl, at) => {
        moves++; bot.entity.position = at; return { ok: true }
      } } }
    const module = { exports: {} as any }
    const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
    vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(
      module.exports, id => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
    const result = await module.exports.pickup(bot, mode === 'full-generic' ? null : 'diamond_boots', 6, undefined, ctl)
    assert.equal(result.ok, !['foreign', 'cancelled'].includes(mode), mode)
    if (mode.startsWith('full')) assert.equal(slots.some(i => i?.name === 'rotten_flesh'), false)
    if (mode === 'below') assert.equal(moves, 1, '1.2 blocks below the feet is outside native pickup reach')
    if (mode === 'delayed') assert.equal(ticks, 3, 'wait for the slot after entity_destroy')
    if (mode === 'foreign') assert.ok(ticks <= 11, 'a disappearance without our inventory gain is bounded failure')
    if (mode === 'cancelled') assert.equal(ticks, 2, 'cancellation stops the receipt wait')
  }
})
