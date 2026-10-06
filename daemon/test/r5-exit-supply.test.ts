'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { clockFixture } = require('./clock-fixture')
const path = require('node:path')
function fixture (inventory, { foes = 0, sealed = true, wood = true, stone = true, needsPick = false, target = { x: 0, z: 0 } }: any = {} as Record<string, any>) {
  const inv: Record<string, any> = { ...inventory }; const calls = []; let pickLeft = inventory.pickLeft || 0
  delete inv.pickLeft
  const state = { inventory: inv, pos: { x: 0, y: 64, z: 0 }, dimension: 'the_nether' }
  const sit: Record<string, any> = { pickLeft, foes }; const have = re => Object.entries<any>(inv).reduce((n, [k,v]: any) => n + ((typeof re === 'string' ? re === k : re.test(k)) ? v : 0), 0)
  const act = async (method, p) => {
    calls.push([method, p])
    if (method === 'ne_burrow') { sit.foes = sealed ? 0 : foes; return { detail: { ok: sealed } } }
    if (method === 'mine') {
      if (p.block === 'blackstone' && stone && (!needsPick || pickLeft > 0)) inv.blackstone = (inv.blackstone || 0) + p.count
      if (/stem/.test(p.block) && wood) inv.crimson_stem = (inv.crimson_stem || 0) + p.count
    }
    if (method === 'craft') {
      const n = p.count || 1
      if (p.item === 'iron_ingot') { const made = inv.iron_block ? 9 * inv.iron_block : Math.floor((inv.iron_nugget || 0) / 9); if (inv.iron_block) inv.iron_block = 0; else inv.iron_nugget = (inv.iron_nugget || 0) % 9; inv.iron_ingot = (inv.iron_ingot || 0) + Math.min(n, made) }
      if (p.item === 'crimson_planks' && inv.crimson_stem) { inv.crimson_stem--; inv.crimson_planks = (inv.crimson_planks || 0) + 4 }
      const spendPlanks = k => { for (const name of Object.keys(inv)) if (/_planks$/.test(name)) { const take = Math.min(inv[name], k); inv[name] -= take; k -= take } assert.equal(k, 0) }
      if (p.item === 'crafting_table') { spendPlanks(4); inv.crafting_table = 1 }
      if (p.item === 'stick') { spendPlanks(n / 2); inv.stick = (inv.stick || 0) + n }
      if (/_pickaxe$/.test(p.item)) {
        assert.ok(inv.stick >= 2); inv.stick -= 2
        if (p.item === 'iron_pickaxe') { assert.ok(inv.iron_ingot >= 3); inv.iron_ingot -= 3; pickLeft += 250 }
        else { assert.ok(have(/^(cobblestone|cobbled_deepslate|blackstone)$/) >= 3); for (const k of ['blackstone','cobblestone','cobbled_deepslate']) if ((inv[k] || 0) >= 3) { inv[k] -= 3; break } pickLeft += 131 }
        inv[p.item] = (inv[p.item] || 0) + 1; sit.pickLeft = pickLeft
      }
    }
    return { status: 'done', detail: {} as Record<string, any> }
  }
  const context: Record<string, any> = { state, sit, have, act, refresh: async () => state, sense: async () => sit, died: false, process,
    LOGS: /_(log|stem)$/, COBBLE: /^(cobblestone|cobbled_deepslate|blackstone)$/, planksFor: () => have('crimson_stem') ? 'crimson_planks' : null,
    lighter: () => true, log () {}, Date, Math }
  context.gameClock = clockFixture(context)
  const entry = path.join(__dirname, '../campaign.js')
  const { functionSource } = require('./source-fixture')
  const src = functionSource(entry, 'prepareExitSupply') + '\n' + functionSource(entry, 'prepareExitTools')
  vm.runInNewContext(src + '\nthis.prepare = prepareExitTools', context)
  return { calls, inv, run: () => context.prepare(target) }
}
test('ready picks cover the journey; twelve unused sticks are not an extra gate', async () => {
  const f = fixture({ crafting_table: 1, pickLeft: 250, stick: 0 })
  assert.equal(await f.run(), true); assert.equal(f.calls.length, 0)
})
test('no cobble: recover blackstone locally and craft instead of repeating an empty gate', async () => {
  const f = fixture({ crafting_table: 1, stick: 2, pickLeft: 20 }, { needsPick: true })
  assert.equal(await f.run(), true); assert.ok(f.calls.some(([m,p]: any) => m === 'mine' && p.block === 'blackstone'))
})
test('wood deficit: check structure loot before a bounded stem search', async () => {
  const f = fixture({ crafting_table: 1, blackstone: 3 })
  assert.equal(await f.run(), true)
  const loot = f.calls.findIndex(([m]: any) => m === 'chest_take'); const mine = f.calls.findIndex(([m,p]: any) => m === 'mine' && /stem/.test(p.block))
  assert.ok(loot >= 0 && mine > loot); assert.ok(f.calls[mine][1].timeoutSeconds <= 60)
})
test('iron from a structure block can supply a pick when no stone is present', async () => {
  const f = fixture({ crafting_table: 1, stick: 2, iron_block: 1 }, { stone: false })
  assert.equal(await f.run(), true); assert.ok(f.inv.iron_pickaxe)
})
test('enemy nearby: require confirmed shelter before supply crafts', async () => {
  const f = fixture({ crafting_table: 1, stick: 2, blackstone: 3 }, { foes: 1, sealed: false })
  assert.equal(await f.run(), false); assert.ok(f.calls.some(([m]: any) => m === 'ne_burrow')); assert.ok(!f.calls.some(([m]: any) => m === 'craft'))
})
test('missing wood remains a bounded, explicit refusal', async () => {
  const f = fixture({ crafting_table: 1, blackstone: 3 }, { wood: false })
  assert.equal(await f.run(), false); assert.ok(f.calls.length < 10)
})
test('col04N3ax25: unpack nuggets and bootstrap an iron pick before mining stone', async () => {
  const f = fixture({ crafting_table: 1, stick: 9, iron_nugget: 54, iron_ingot: 1 }, { needsPick: true, target: { x: 1952, z: 0 } })
  assert.equal(await f.run(), true)
  const iron = f.calls.findIndex(([m,p]: any) => m === 'craft' && p.item === 'iron_pickaxe')
  const mine = f.calls.findIndex(([m,p]: any) => m === 'mine' && p.block === 'blackstone')
  assert.ok(iron >= 0 && mine > iron); assert.equal(f.inv.iron_pickaxe, 2)
})
test('disable flag keeps the original twelve-stick gate', async () => {
  const old = process.env.ND_EXIT_SUPPLY; process.env.ND_EXIT_SUPPLY = '0'
  try { assert.equal(await fixture({ crafting_table: 1, pickLeft: 250, stick: 0 }).run(), false) }
  finally { if (old === undefined) delete process.env.ND_EXIT_SUPPLY; else process.env.ND_EXIT_SUPPLY = old }
})
