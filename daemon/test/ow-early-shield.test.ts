import { campaignScript } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { cjsContext } from './cjs-context'

function fixture(inventory: Record<string, number>, env = {}, fail = false) {
  const file = path.resolve(__dirname, '../campaign.js'), local = createRequire(file)
  class Socket { on() {} }
  const f: any = { state: { inventory: { ...inventory }, health: 20, food: 20, pos: { x: 1, y: 64, z: 1 }, dimension: 'overworld' }, calls: [], fail }
  const context: any = { require: id => id === 'ws' ? Socket : id === 'fs' ? { appendFileSync() {} } : local(id),
    __dirname: path.dirname(file), module: { exports: {} }, process: { argv: ['node', file], env },
    console: { log() {}, error() {} }, setTimeout, clearTimeout, Date, fixture: f }
  vm.runInNewContext(campaignScript() + `
    state = fixture.state; sit = { night: true, surface: true, foes: 0 };
    refresh = async () => {}; sense = async () => {}; ensureTable = async () => {};
    craft = async (item, count = 1) => {
      fixture.calls.push(item); const inv = state.inventory;
      if (fixture.fail) return false;
      if (item === 'shield') { if (inv.iron_ingot < 1 || inv.oak_planks < 6) return false; inv.iron_ingot--; inv.oak_planks -= 6; }
      if (item === 'bucket') { if (inv.iron_ingot < 3) return false; inv.iron_ingot -= 3; }
      if (item === 'flint_and_steel') { if (inv.iron_ingot < 1) return false; inv.iron_ingot--; }
      inv[item] = (inv[item] || 0) + count; return true;
    };
    act = async (method) => { fixture.calls.push(method); if (method === 'armor' && state.inventory.shield) {
      state.inventory.shield--; state.offHand = { item: 'shield' };
    } return { status: 'done', detail: {} }; };
    smeltAll = async () => { state.inventory.iron_ingot = (state.inventory.iron_ingot || 0) + (state.inventory.raw_iron || 0); state.inventory.raw_iron = 0; };
    module.exports = { earlyShield, spendIron, routeStep, move: () => { state.pos.x++; },
      change: values => { Object.assign(sit, values); } };
  `, cjsContext(context))
  return { ...context.module.exports, ...f }
}

test('campaign makes and wears the shield from its first usable ingot before another overworld leg', async () => {
  const f = fixture({ iron_ingot: 1, oak_planks: 6, crafting_table: 1 })
  assert.equal(await f.earlyShield(), true)
  assert.deepEqual(f.calls, ['shield', 'armor'])
  assert.equal(f.state.inventory.iron_ingot, 0); assert.equal(f.state.inventory.oak_planks, 0)
  assert.equal(f.state.offHand.item, 'shield')
  await f.earlyShield(); assert.equal(f.calls.length, 2)
})

test('the env control keeps the first ingot for the old kit and safe daylight can have the same price verdict', async () => {
  for (const env of [{ ND_OW_SHIELD: '0' }, {}]) {
    const f = fixture({ iron_ingot: 1, oak_planks: 6, crafting_table: 1 }, env)
    if (!env.ND_OW_SHIELD) f.change({ night: false, surface: true })
    assert.equal(await f.earlyShield(), false)
    assert.equal(f.state.inventory.iron_ingot, 1); assert.deepEqual(f.calls, [])
  }
})

test('an unchanged craft failure is retried only after its observed materials or location change', async () => {
  const f = fixture({ iron_ingot: 1, oak_planks: 6, crafting_table: 1 }, {}, true)
  assert.equal(await f.earlyShield(), false)
  await f.earlyShield(); assert.deepEqual(f.calls, ['shield'])
  f.move(); await f.earlyShield(); assert.deepEqual(f.calls, ['shield', 'shield'])
})

test('route smelting prices the shield before bucket spending, including when ingots appeared inside the step', async () => {
  const f = fixture({ raw_iron: 4, oak_planks: 6, crafting_table: 1, furnace: 1 })
  await f.routeStep({ kind: 'smelt' })
  assert.equal(f.calls[0], 'shield')
  assert.equal(f.calls[1], 'armor')
})

test('spendIron admits the same first-ingot price instead of reserving it unconditionally for the kit', async () => {
  const f = fixture({ iron_ingot: 1, oak_planks: 6, crafting_table: 1 })
  await f.spendIron()
  assert.equal(f.calls[0], 'shield')
  assert.equal(f.state.offHand.item, 'shield')
})
