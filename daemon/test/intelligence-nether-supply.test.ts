import test from 'node:test'
import assert from 'node:assert/strict'
import { netherToolsReady, replenishNetherTools, type NetherSupplyPort, type NetherSupplyState } from '../src/campaign/nether-supply'

function supplyFixture(blocked = false) {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20, inventory: { oak_planks: 2, iron_ingot: 4, blackstone: 12 }, pickSwings: 0 }
  const actions: string[] = []
  let now = 0
  let interrupted = false
  const port: NetherSupplyPort = { observe: async () => state, now: () => now, interrupted: () => interrupted, log() {},
    async act(method, params) {
      if (params.block === 'crafting_table') { now += 15000; actions.push('table-pickup'); return }
      now += 45000; actions.push(method)
      if (!blocked && method === 'mine') state.inventory.crimson_stem = 4
    },
    async craft(item, count) {
      actions.push(item)
      if (item === 'crimson_planks') { state.inventory.crimson_stem = 0; state.inventory.crimson_planks = count }
      else if (item === 'crafting_table') { state.inventory.crimson_planks -= 4; state.inventory.crafting_table = 1 }
      else if (item === 'stick') { state.inventory.crimson_planks -= 2; state.inventory.stick = (state.inventory.stick || 0) + 4 }
      else if (item === 'stone_pickaxe') {
        state.inventory.stick -= 2; state.inventory.blackstone -= 3
        state.inventory.stone_pickaxe = (state.inventory.stone_pickaxe || 0) + 1; state.pickSwings += 131
      } else if (item === 'iron_pickaxe') {
        state.inventory.stick -= 2; state.inventory.iron_ingot -= 3
        state.inventory.iron_pickaxe = 1; state.pickSwings += 250
      } else return false
      return true
    } }
  return { state, actions, port, interrupt: () => { interrupted = true } }
}

test('lost table and worn tools recover from honest Nether stems before selecting fortress travel', async () => {
  const f = supplyFixture()
  assert.equal(netherToolsReady(f.state), false)
  const result = await replenishNetherTools(f.port)
  assert.equal(result.ready, true)
  assert.equal(f.state.inventory.crafting_table, 1)
  assert.equal(f.state.inventory.iron_pickaxe, 1)
  assert.equal(f.state.inventory.stone_pickaxe, 1)
  assert.equal(netherToolsReady(f.state), true)
  assert.ok(f.actions.indexOf('mine') < f.actions.indexOf('crafting_table'))
  assert.equal(f.actions.includes('fortress'), false)
})

test('absence of accessible stems and tactical interruption cannot become supply success', async () => {
  const missing = supplyFixture(true)
  const outcome = await replenishNetherTools(missing.port)
  assert.equal(outcome.ready, false)
  assert.ok(missing.actions.filter(item => item === 'mine').length <= 2)
  const interrupted = supplyFixture()
  interrupted.interrupt()
  assert.equal((await replenishNetherTools(interrupted.port)).interrupted, true)
  assert.deepEqual(interrupted.actions, [])
})

function carriedIronFixture(iron: Record<string, number>, confirmConversion = true) {
  const state: NetherSupplyState = { dimension: 'the_nether', health: 20, pickSwings: 167,
    inventory: { oak_log: 4, crafting_table: 1, iron_pickaxe: 1, stick: 3, ...iron } }
  const crafts: Array<{ item: string; count: number }> = []
  const actions: string[] = []
  const port: NetherSupplyPort = { observe: async () => state, now: () => 0, interrupted: () => false, log() {},
    async act(method, params) { actions.push(params.block === 'crafting_table' ? 'table-pickup' : method) },
    async craft(item, count) {
      crafts.push({ item, count })
      if (item === 'oak_planks') {
        state.inventory.oak_log -= count / 4
        state.inventory.oak_planks = (state.inventory.oak_planks || 0) + count
      } else if (item === 'iron_ingot') {
        if (!confirmConversion) return true
        if ((state.inventory.iron_nugget || 0) >= count * 9) {
          state.inventory.iron_nugget -= count * 9
          state.inventory.iron_ingot = (state.inventory.iron_ingot || 0) + count
        } else if ((state.inventory.iron_block || 0) >= Math.ceil(count / 9)) {
          state.inventory.iron_block -= Math.ceil(count / 9)
          state.inventory.iron_ingot = (state.inventory.iron_ingot || 0) + Math.ceil(count / 9) * 9
        } else return false
      } else if (item === 'iron_pickaxe') {
        if ((state.inventory.iron_ingot || 0) < 3 || state.inventory.stick < 2) return false
        state.inventory.iron_ingot -= 3; state.inventory.stick -= 2
        state.inventory.iron_pickaxe++; state.pickSwings += 250
      } else if (item === 'stick') {
        if ((state.inventory.oak_planks || 0) < 2) return false
        state.inventory.oak_planks -= 2; state.inventory.stick += 4
      } else if (item === 'stone_pickaxe') {
        if ((state.inventory.blackstone || 0) < 3 || state.inventory.stick < 2) return false
        state.inventory.blackstone -= 3; state.inventory.stick -= 2
        state.inventory.stone_pickaxe = (state.inventory.stone_pickaxe || 0) + 1; state.pickSwings += 131
      } else return false
      return true
    } }
  return { state, crafts, actions, port }
}

test('the actual two-ingot 64-nugget kit crafts only the missing ingot and a real replacement pick', async () => {
  const f = carriedIronFixture({ iron_ingot: 2, iron_nugget: 64 })
  assert.equal((await replenishNetherTools(f.port)).ready, true)
  assert.deepEqual(f.crafts, [{ item: 'oak_planks', count: 16 }, { item: 'iron_ingot', count: 1 }, { item: 'iron_pickaxe', count: 1 }])
  assert.equal(f.state.inventory.iron_nugget, 55)
  assert.equal(f.state.inventory.iron_ingot, 0)
  assert.equal(f.state.inventory.iron_pickaxe, 2)
  assert.equal(f.state.pickSwings, 417)
  assert.equal(f.state.inventory.oak_planks, 16)
  assert.equal(f.state.inventory.crafting_table, 1)
  assert.deepEqual(f.actions, [], 'carried recipe materials avoid another blackstone search')
})

test('one carried iron block supplies the pick while an incomplete nugget group stays untouched', async () => {
  const f = carriedIronFixture({ iron_ingot: 2, iron_nugget: 8, iron_block: 1 })
  assert.equal((await replenishNetherTools(f.port)).ready, true)
  assert.deepEqual(f.crafts.filter(c => c.item !== 'oak_planks'), [{ item: 'iron_ingot', count: 9 }, { item: 'iron_pickaxe', count: 1 }])
  assert.equal(f.state.inventory.iron_block, 0)
  assert.equal(f.state.inventory.iron_nugget, 8)
  assert.equal(f.state.inventory.iron_ingot, 8)
  assert.equal(f.state.inventory.oak_planks, 16)
  assert.equal(f.state.inventory.crafting_table, 1)
})

test('eight leftover nuggets and an unconfirmed conversion cannot invent pick readiness', async () => {
  const short = carriedIronFixture({ iron_ingot: 2, iron_nugget: 8 })
  assert.equal((await replenishNetherTools(short.port)).ready, false)
  assert.equal(short.crafts.some(c => c.item === 'iron_ingot' || c.item === 'iron_pickaxe'), false)
  assert.equal(short.state.inventory.iron_nugget, 8)
  assert.equal(short.state.pickSwings, 167)
  const unconfirmed = carriedIronFixture({ iron_ingot: 2, iron_nugget: 64 }, false)
  assert.equal((await replenishNetherTools(unconfirmed.port)).ready, false)
  assert.equal(unconfirmed.crafts.some(c => c.item === 'iron_pickaxe'), false)
  assert.equal(unconfirmed.state.inventory.oak_planks, 16)
  assert.equal(unconfirmed.state.inventory.crafting_table, 1)
})

test('the native fourteen-plank kit restores the pick in cover without searching for unnecessary stems', async () => {
  const f = carriedIronFixture({ oak_log: 0, oak_planks: 14, stick: 1, blackstone: 4, iron_nugget: 28, stone_pickaxe: 1 })
  f.state.pickSwings = 176
  assert.equal((await replenishNetherTools(f.port)).ready, true)
  assert.deepEqual(f.actions, [], 'an adequate recipe and reserve must not issue mine or explore before crafting')
  assert.deepEqual(f.crafts, [{ item: 'stick', count: 4 }, { item: 'stone_pickaxe', count: 1 }])
  assert.equal(f.state.pickSwings, 307)
  assert.equal(f.state.inventory.oak_planks, 12)
  assert.equal(f.state.inventory.stick, 3)
  assert.equal(f.state.inventory.blackstone, 1)
  assert.equal(f.state.inventory.iron_nugget, 28)
  assert.equal(f.state.inventory.crafting_table, 1)
})

test('a nearby visible table returns before the interrupted native kit requests more wood', async () => {
  for (const mode of ['confirmed', 'absent', 'unconfirmed', 'interrupted'] as const) {
    const f = carriedIronFixture({ oak_log: 0, oak_planks: 10, crafting_table: 0, stick: 4, blackstone: 7, stone_pickaxe: 1 })
    f.state.pickSwings = 253
    let interrupted = false
    f.port.interrupted = () => interrupted
    f.port.act = async (method, params) => {
      f.actions.push(`${method}:${params.block ?? ''}`)
      if (params.block !== 'crafting_table') return
      assert.deepEqual(params, { block: 'crafting_table', count: 1, radius: 3, fair: true, dry: true, timeoutSeconds: 15 })
      if (mode === 'confirmed') f.state.inventory.crafting_table = 1
      if (mode === 'interrupted') interrupted = true
    }
    const result = await replenishNetherTools(f.port)
    assert.equal(result.ready, mode === 'confirmed')
    assert.equal(result.interrupted, mode === 'interrupted')
    assert.equal(f.state.inventory.oak_planks, 10)
    assert.equal(f.actions[0], 'mine:crafting_table')
    if (mode === 'confirmed') {
      assert.deepEqual(f.crafts, [{ item: 'stone_pickaxe', count: 1 }])
      assert.equal(f.state.pickSwings, 384)
      assert.equal(f.state.inventory.crafting_table, 1)
      assert.equal(f.actions.length, 1)
    } else {
      // Без своего стола 10 досок хватает на новый (резерв 4 + 4 на стол): лишь отказ стенда считать столы.
      assert.deepEqual(f.crafts, mode === 'interrupted' ? [] : [{ item: 'crafting_table', count: 1 }])
      assert.equal(f.state.pickSwings, 253)
      if (mode === 'interrupted') assert.equal(f.actions.length, 1)
    }
  }
})

test('real missing stick or table costs cannot spend the four-plank reserve while wood is inaccessible', async () => {
  for (const stock of [{ oak_planks: 5, crafting_table: 1, stick: 1 }, { oak_planks: 7, crafting_table: 0, stick: 3 }]) {
    const f = carriedIronFixture({ oak_log: 0, blackstone: 4, ...stock })
    f.state.pickSwings = 176
    assert.equal((await replenishNetherTools(f.port)).ready, false)
    assert.ok(f.actions.includes('mine'))
    assert.ok(f.actions.filter(action => action === 'mine').length <= 2)
    assert.deepEqual(f.crafts, [], 'an unaffordable recipe must not consume the required reserve')
    assert.equal(f.state.inventory.oak_planks, stock.oak_planks)
    assert.equal(f.state.inventory.crafting_table, stock.crafting_table)
    assert.equal(f.state.pickSwings, 176)
  }
})

test('a second stick batch replenishes only its actual shortfall and preserves the reserve through the bounded pick loop', async () => {
  for (const blocked of [false, true]) {
    const f = carriedIronFixture({ oak_log: 0, oak_planks: 9, iron_pickaxe: 0, stick: 0 })
    f.state.pickSwings = 0
    const craft = f.port.craft
    f.port.craft = async (item, count) => {
      let made: boolean
      if (item === 'wooden_pickaxe') {
        f.crafts.push({ item, count })
        assert.ok(f.state.inventory.oak_planks >= 3 && f.state.inventory.stick >= 2)
        f.state.inventory.oak_planks -= 3; f.state.inventory.stick -= 2
        f.state.inventory.wooden_pickaxe = 1; f.state.pickSwings += 59
        made = true
      } else if (item === 'crimson_planks') {
        f.crafts.push({ item, count })
        assert.equal(f.state.inventory.crimson_stem, count / 4)
        f.state.inventory.crimson_stem -= count / 4
        f.state.inventory.crimson_planks = (f.state.inventory.crimson_planks || 0) + count
        made = true
      } else made = await craft(item, count)
      if (made) assert.ok((f.state.inventory.oak_planks || 0) + (f.state.inventory.crimson_planks || 0) >= 4)
      return made
    }
    f.port.act = async (method, params) => {
      f.actions.push(method)
      if (method === 'mine' && params.block === 'blackstone') {
        assert.equal(f.state.pickSwings, 59)
        f.state.inventory.blackstone = 6
        f.state.pickSwings -= 6
      } else {
        assert.equal(f.state.pickSwings, 184, 'stem search belongs after the first replacement, not before the affordable bootstrap')
        if (!blocked && method === 'mine') f.state.inventory.crimson_stem = 1
      }
    }
    assert.equal((await replenishNetherTools(f.port)).ready, !blocked)
    assert.deepEqual(f.crafts.slice(0, 3), [{ item: 'stick', count: 4 }, { item: 'wooden_pickaxe', count: 1 }, { item: 'stone_pickaxe', count: 1 }])
    assert.equal(f.state.inventory.crafting_table, 1)
    if (blocked) {
      assert.equal(f.state.inventory.oak_planks, 4)
      assert.equal(f.state.pickSwings, 184)
      assert.equal(f.crafts.length, 3)
      assert.deepEqual(f.actions, ['mine', 'mine', 'explore', 'mine'])
    } else {
      assert.deepEqual(f.actions, ['mine', 'mine'])
      assert.deepEqual(f.crafts.slice(3), [{ item: 'crimson_planks', count: 4 }, { item: 'stick', count: 4 }, { item: 'stone_pickaxe', count: 1 }])
      assert.equal(f.state.inventory.oak_planks + f.state.inventory.crimson_planks, 6)
      assert.equal(f.state.pickSwings, 315)
    }
  }
})

test('a failed nugget conversion falls back to stone picks when the bag holds stone (s1-full48)', async () => {
  const f = carriedIronFixture({ iron_ingot: 2, iron_nugget: 64, iron_pickaxe: 0, blackstone: 64, stick: 4 }, false)
  f.state.pickSwings = 0
  const result = await replenishNetherTools(f.port)
  assert.equal(result.ready, true)
  assert.equal(f.crafts.filter(c => c.item === 'stone_pickaxe').length, 2)
  assert.equal(f.crafts.some(c => c.item === 'iron_pickaxe'), false)
  assert.equal(f.state.pickSwings, 262)
  assert.equal(f.state.inventory.iron_nugget, 64)
})

test('s1c: wood is a reserve for new picks, not a gate — 6 planks + 2 sticks without a table, or ample swings, are ready', () => {
  const base = { dimension: 'the_nether', health: 20, pickSwings: 378 }
  assert.equal(netherToolsReady({ ...base, inventory: { iron_pickaxe: 2, oak_planks: 6, stick: 2 } }), true, 's1c-B-4: 7/8 used to defer the spawner')
  assert.equal(netherToolsReady({ ...base, inventory: { iron_pickaxe: 2, oak_planks: 3 } }), false, 'no table and too little wood to make one')
  assert.equal(netherToolsReady({ ...base, pickSwings: 520, inventory: { iron_pickaxe: 3 } }), true, 'double swing reserve needs no wood')
  assert.equal(netherToolsReady({ ...base, pickSwings: 200, inventory: { iron_pickaxe: 1, oak_planks: 16, crafting_table: 1 } }), false)
})
