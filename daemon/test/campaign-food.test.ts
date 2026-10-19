'use strict'
// Кампания: еда, кровати, крафт и набор (кирки, палки, верстак, печь, разгрузка), железо и плавка.
import test = require('node:test')
import assert = require('node:assert/strict')
import * as pack from '../src/pack'
import { campaign } from './campaign-fixture'

test('R5 kd2: five cooked porkchops need neither eight stock units nor a bed before entry', async () => {
  for (const enabled of [false, true]) {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { cooked_porkchop: 5, stone_pickaxe: 1, flint_and_steel: 1 } }
    const calls: string[] = []
    const c = campaign(state, { surface: true, foes: 0, night: false }, method => { calls.push(method); return {} }, { env: { ND_ENTRY_SUPPLIES: enabled ? '1' : '0', ND_NETHER_FOOD_POINTS: '1' } })
    c.known.portal = { x: 0, y: 64, z: 0 }
    assert.equal(c.ready('nether'), true)
    assert.equal(c.needs('food'), !enabled)
    assert.equal(c.done('prep'), enabled)
    if (enabled) { await c.runStage('prep'); assert.ok(!calls.some(method => ['explore', 'goto', 'fight', 'mine'].includes(method)), calls.join(',')) }
  }
})
test('R5: a manually retried food stage does not hunt wool when entry food already suffices', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { cooked_porkchop: 5, stone_pickaxe: 1, flint_and_steel: 1 } }
  const calls: string[] = []
  const c = campaign(state, { surface: true, foes: 0, night: false }, method => { calls.push(method); return {} }, { env: { ND_ENTRY_SUPPLIES: '1' } })
  c.known.portal = { x: 0, y: 64, z: 0 }
  await c.runStage('food')
  assert.ok(!calls.some(method => ['observe', 'explore', 'goto', 'fight'].includes(method)), calls.join(','))
})
test('R5: insufficient food, the old nutrition switch, and the later End stock retain their goals', () => {
  const make = (count, env: any = {}) => {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { cooked_porkchop: count, stone_pickaxe: 1, flint_and_steel: 1 } }
    const c = campaign(state, { surface: true, foes: 0, night: false }, undefined, { env: { ND_ENTRY_SUPPLIES: '1', ...env } })
    return c
  }
  const hungry = make(1); hungry.known.portal = { x: 0, y: 64, z: 0 }; assert.equal(hungry.needs('food'), true); assert.equal(hungry.done('prep'), false)
  const legacy = make(5, { ND_NETHER_FOOD_POINTS: '0' }); legacy.known.portal = { x: 0, y: 64, z: 0 }; assert.equal(legacy.needs('food'), true)
  const later = make(5); assert.equal(later.needs('food'), true, 'before the portal the old food stock remains')
  later.known.portal = { x: 0, y: 64, z: 0 }; assert.equal(later.needs('food'), false)
  later.wantBeds(5); assert.equal(later.needs('food'), true, 'End preparation still has its own food and wool goal')
})
test('R5: a hungry entry hunt takes the first food prey and stops at the existing nutrition reserve', async () => {
  const state: any = { health: 20, food: 20, biome: 'plains', dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { cooked_porkchop: 4, white_wool: 1, stone_pickaxe: 1, flint_and_steel: 1 } }
  const fights: any[] = []
  const c = campaign(state, { surface: true, foes: 0, night: false }, (method, params) => {
    if (method === 'recall') return { state: { places: { 'портал': { x: 0, y: 64, z: 0, dimension: 'overworld' } } } }
    if (method === 'observe') return { entities: [{ name: 'cow', dist: 3 }, { name: 'sheep', dist: 4 }] }
    if (method === 'fight') { fights.push(params); state.inventory.cooked_porkchop++; return {} }
    return {}
  }, { env: { ND_ENTRY_SUPPLIES: '1' } })
  c.known.portal = { x: 0, y: 64, z: 0 }
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  assert.equal(fights.length, 1)
  assert.equal(fights[0].target, 'cow', 'do not prefer a sheep for wool over the first food prey')
  assert.equal(fights[0].purpose, 'food')
  assert.equal(c.needs('food'), false)
})
test('R5: entry supplies keep the existing three-meal night portal state and the later End bed goal', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { cooked_porkchop: 3, stone_pickaxe: 1, flint_and_steel: 1 } }
  const c = campaign(state, { surface: true, foes: 0, night: true }, undefined, { env: { ND_ENTRY_SUPPLIES: '1' } })
  c.known.portal = { x: 0, y: 64, z: 0 }
  assert.equal(c.needs('food'), false)
  assert.equal(c.done('prep'), true)
  state.inventory.cooked_porkchop = 8
  const seen: any[] = []
  const f = campaign(state, { surface: true, foes: 0, night: false }, (method, params) => {
    if (method === 'observe') return { entities: [{ name: 'sheep', dist: 3 }] }
    if (method === 'fight') { seen.push(params); state.inventory.white_bed = 5; return {} }
    return {}
  }, { env: { ND_ENTRY_SUPPLIES: '1' } })
  f.known.portal = c.known.portal; f.wantBeds(5); f.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await f.runStage('food')
  assert.equal(seen.length, 1); assert.equal(seen[0].purpose, 'resource'); assert.equal(seen[0].resourceGoal.count, 15)
})
function earlyIronFixture(env: Record<string, string>, { surface = false, collect = true } = {}) {
  const inventory: any = { stone_pickaxe: 1, stone_sword: 1, oak_log: 8, oak_planks: 8, stick: 8, cobblestone: 64,
    furnace: 1, crafting_table: 1, flint: 1, coal: 2, cooked_beef: 8 }
  const state: any = { dimension: 'overworld', health: 20, food: 20, pos: { x: 0, y: surface ? 64 : 16, z: 0 }, inventory }
  const calls: any[] = []
  const c = campaign(state, { surface, night: false, foes: 0, pickLeft: 200 }, (method, p) => {
    calls.push({ method, p })
    if (method === 'mine_seen') return { spots: [] }
    if (method === 'mine') return { dug: 0 }
    if (method === 'explore' && p.block === 'iron_ore') { if (collect) inventory.raw_iron = 4; return { found: 'iron_ore', at: { x: 3, y: state.pos.y, z: 0 } } }
    if (method === 'tunnel') { state.pos.x += p.length; if (collect) inventory.raw_iron = 4; return { walked: p.length, dug: 2 * p.length } }
    if (method === 'smelt') { const n = Math.min(p.count, inventory.raw_iron || 0); inventory.raw_iron -= n; inventory.iron_ingot = (inventory.iron_ingot || 0) + n }
    if (method === 'craft' && p.item === 'bucket') { inventory.iron_ingot -= 3; inventory.bucket = 1 }
    if (method === 'craft' && p.item === 'flint_and_steel') { inventory.iron_ingot--; inventory.flint--; inventory.flint_and_steel = 1 }
    return {}
  }, { env })
  c.hooks({ spares: async () => {}, ensurePick: async () => true, recoverGuard: async () => {} })
  return { c, calls, state }
}
test('R6: early iron checks its seen vein within 16 blocks; default keeps 32', async () => {
  for (const enabled of [false, true]) {
    const f = earlyIronFixture({ ND_IRON_VISIBLE_LEGS: enabled ? '1' : '0' })
    await f.c.runStage('iron', true)
    assert.equal(f.calls.find(c => c.method === 'tunnel').p.length, enabled ? 16 : 32)
    assert.equal(f.state.inventory.bucket, 1); assert.equal(f.state.inventory.flint_and_steel, 1)
  }
})
test('R6: shorter iron legs preserve the original maximum search distance', async () => {
  for (const enabled of [false, true]) {
    const f = earlyIronFixture({ ND_IRON_VISIBLE_LEGS: enabled ? '1' : '0' }, { collect: false })
    await f.c.runStage('iron', true)
    const legs = f.calls.filter(c => c.method === 'tunnel')
    assert.equal(legs.length, enabled ? 28 : 14)
    assert.equal(legs.reduce((n, c) => n + c.p.length, 0), 448)
    assert.deepEqual(legs.map(c => c.p.direction), Array.from({ length: enabled ? 28 : 14 }, (_, i) =>
      ['north', 'east', 'south', 'west'][(enabled ? Math.floor(i / 2) : i) % 4]))
  }
})
test('R6: the staircase collects an actually remembered vein between spatial portions and stops at four iron', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, oak_log: 8, oak_planks: 8, crafting_table: 1, cobblestone: 64 } }
  const calls: any[] = []
  const c = campaign(state, { surface: false, night: false, foes: 0 }, (method, p) => {
    calls.push({ method, p })
    if (method === 'dig_down') { state.pos.y -= p.depth; return { steps: p.depth, dug: p.depth * 3 } }
    if (method === 'mine_seen' && p.limit) return { spots: state.pos.y <= 52 ? [{ name: 'iron_ore', fromMe: 3, at: { x: 3, y: 52, z: 0 } }] : [] }
    if (method === 'mine_seen' && p.at) state.inventory.raw_iron = 4
    return {}
  }, { env: { ND_IRON_VISIBLE_LEGS: '1' } })
  c.hooks({ spares: async () => {}, ensurePick: async () => true, recoverGuard: async () => {} })
  await c.descend(16, { oreRemaining: () => 4 - (state.inventory.raw_iron || 0) })
  assert.equal(state.inventory.raw_iron, 4)
  assert.equal(state.pos.y, 52, 'the inventory goal, not y16, ends this descent')
  assert.deepEqual(calls.filter(c => c.method === 'dig_down').map(c => c.p.depth), [12])
  assert.equal(calls.filter(c => c.method === 'mine_seen' && c.p.at).length, 1)
})
test('R6: a verified stale ore row advances to the next remembered vein without repeating that row', async () => {
  for (const enabled of [false, true]) {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 }, inventory: { stone_pickaxe: 1 } }
    const attempts: number[] = []
    const c = campaign(state, { surface: false, foes: 0, night: false }, (method, p) => {
      if (method !== 'mine_seen') return {}
      // The old row deliberately remains in this reply, modelling a stale RPC/list snapshot.
      if (p.limit) return { spots: [1, 2].map(x => ({ name: 'iron_ore', fromMe: x, at: { x, y: 16, z: 0 } })) }
      attempts.push(p.at.x)
      if (p.at.x === 1) return { gone: [{ at: p.at }] }
      state.inventory.raw_iron = 4
      return { dug: 4 }
    }, { env: { ND_IRON_STALE_LEDGER: enabled ? '1' : '0' } })
    await c.mineSeenAll('iron_ore', 24, () => 4 - (state.inventory.raw_iron || 0))
    assert.deepEqual(attempts, enabled ? [1, 2] : [1])
    assert.equal(state.inventory.raw_iron || 0, enabled ? 4 : 0)
  }
})
test('R6: a zero-gain physical refusal or tactical interruption still ends remembered ore collection', async () => {
  for (const interrupted of [false, true]) {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 }, inventory: { stone_pickaxe: 1 } }
    let attempts = 0
    const c = campaign(state, { surface: false, foes: 0, night: false }, (method, p) => {
      if (method !== 'mine_seen') return {}
      if (p.limit) return { spots: [1, 2].map(x => ({ name: 'iron_ore', fromMe: x, at: { x, y: 16, z: 0 } })) }
      attempts++
      return interrupted ? { rpcResult: { status: 'interrupted', detail: { gone: [{ at: p.at }] }, state, events: [] } } : { stopped: 'нет пути' }
    }, { env: { ND_IRON_STALE_LEDGER: '1' } })
    await c.mineSeenAll('iron_ore', 24, () => 4)
    assert.equal(attempts, 1)
  }
})

test('an interrupted iron descent smelts its carried ore before repeating the water-blocked descent', async () => {
  const state: any = { health: 20, food: 19, dimension: 'overworld', pos: { x: 17, y: 33, z: -54 },
    inventory: { stone_pickaxe: 2, raw_iron: 4, furnace: 1, crafting_table: 1, coal: 7, cobblestone: 164, oak_log: 10, stick: 5 } }
  const calls: string[] = []
  const c = campaign(state, { free: 20, pickLeft: 200, surface: false, night: false }, (method, params) => {
    calls.push(method === 'craft' ? params.item : method)
    if (method === 'smelt') { state.inventory.raw_iron = 0; state.inventory.iron_ingot = 4 }
    if (method === 'craft' && params.item === 'bucket') { state.inventory.iron_ingot -= 3; state.inventory.bucket = 1 }
    assert.notEqual(method, 'dig_down', 'use carried ore before repeating the blocked descent')
    return {}
  })
  await c.runStage('iron')
  assert.equal(state.inventory.bucket, 1)
  assert.equal(state.inventory.iron_ingot, 1, 'retain iron for the lighter')
  assert.ok(calls.indexOf('smelt') < calls.indexOf('bucket'))
  assert.equal(calls.includes('dig_down'), false)
})

test('iron recovery after failed casting smelts the three bars needed for a pick even with a complete bucket kit', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 33, z: 0 },
    inventory: { stone_pickaxe: 1, raw_iron: 3, furnace: 1, crafting_table: 1, coal: 7, water_bucket: 1, lava_bucket: 1,
      flint_and_steel: 1, shield: 1, oak_planks: 12, stick: 5 } }
  const calls: string[] = []
  const c = campaign(state, { free: 30, surface: false, pickLeft: 100 }, (method, params) => {
    calls.push(method === 'craft' ? params.item : method)
    if (method === 'smelt') { state.inventory.raw_iron -= params.count; state.inventory.iron_ingot = params.count }
    if (method === 'craft' && params.item === 'iron_pickaxe') { state.inventory.iron_ingot -= 3; state.inventory.iron_pickaxe = 1 }
    assert.notEqual(method, 'dig_down', 'the remaining pick is crafted from carried ore')
    return {}
  }, { env: { ND_OW_DEEP: '1' } })
  c.stage('iron'); c.castFailed()
  assert.equal(c.needs('iron'), true)
  await c.runStage('iron')
  assert.equal(state.inventory.iron_pickaxe, 1)
  assert.equal(state.inventory.raw_iron, 0)
  assert.equal(c.needs('iron'), false)
  assert.deepEqual(calls, ['smelt', 'iron_pickaxe', 'armor'])
})

test('a complete bucket kit does not finish iron recovery before the missing pick materials are acquired', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 },
    inventory: { stone_pickaxe: 1, raw_iron: 1, furnace: 1, crafting_table: 1, coal: 20, water_bucket: 1, lava_bucket: 1,
      flint_and_steel: 1, shield: 1, oak_planks: 12, stick: 5, torch: 16 } }
  let mined = 0
  const c = campaign(state, { free: 30, surface: false, pickLeft: 200 }, (method, params) => {
    if (method === 'smelt') { state.inventory.raw_iron -= params.count; state.inventory.iron_ingot = (state.inventory.iron_ingot || 0) + params.count }
    if (method === 'mine' && /iron_ore/.test(params.block)) { mined += params.count; state.inventory.raw_iron += params.count }
    if (method === 'craft' && params.item === 'iron_pickaxe') { state.inventory.iron_ingot -= 3; state.inventory.iron_pickaxe = 1 }
    return {}
  }, { env: { ND_OW_DEEP: '1', ND_DEATH_COST_MIN: '6' } })
  c.stage('iron'); c.castFailed()
  await c.runStage('iron')
  assert.equal(mined, 2)
  assert.equal(state.inventory.iron_pickaxe, 1)
  assert.equal(c.needs('iron'), false)
})

test('восстановление здоровья во время еды прекращает ненужное строительство норы', async () => {
  const state: Record<string, any> = { health: 6, food: 17, dimension: 'overworld', pos: { x: -83, y: 75, z: 0 },
    inventory: { stone_pickaxe: 1, melon_slice: 9 } }
  const calls = []
  const c = campaign(state, { night: true, foes: 0 }, method => {
    calls.push(method)
    if (method === 'eat') { state.health = 20; state.food = 20 }
    return { sealed: false }
  })
  await c.rest()
  assert.equal(calls.includes('eat'), true)
  assert.equal(calls.includes('shelter'), false)
  assert.equal(calls.includes('wait'), false)
})

test('ночной сон с восстановленным здоровьем не запускает строительство норы', async () => {
  const state: Record<string, any> = { health: 6, food: 18, dimension: 'overworld', pos: { x: -83, y: 75, z: 0 },
    inventory: { stone_pickaxe: 1 } }
  const situation: Record<string, any> = { night: true, foes: 0, bed: true }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'sleep') { state.health = 20; state.food = 20; situation.night = false }
    return { sealed: false }
  })
  await c.rest()
  assert.equal(calls.includes('sleep'), true)
  assert.equal(calls.includes('shelter'), false)
})

test('перед дорогой к спавнеру и боем слабые порции доводят сытость до лечения', async () => {
  const state: Record<string, any> = { health: 16, food: 13, dimension: 'the_nether', pos: { x: -300, y: 64, z: -150 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' }, offHand: { item: 'shield' },
    inventory: { iron_pickaxe: 1, iron_sword: 1, melon_slice: 20, blaze_rod: 3, crafting_table: 1, oak_planks: 8 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false, pickLeft: 260 }, method => {
    calls.push(method)
    if (method === 'eat') { state.food += 2; state.inventory.melon_slice--; return { ate: 'melon_slice' } }
    if (method === 'fortress') {
      assert.ok(state.food >= 18, 'до длинного маршрута должен начаться реген здоровья')
      state.food = 15
      return { reached: true, spawner: { x: -404, y: 70, z: -200 }, dist: 3 }
    }
    if (method === 'blaze') {
      assert.ok(state.food >= 18, 'одна долька даёт только17: до боя нужна ещё одна')
      state.inventory.blaze_rod = 7
    }
    return {} as Record<string, any>
  })
  c.known.portal = { x: -19, y: 65, z: -24 }
  c.known.fortress = true
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  assert.equal(calls.filter(x => x === 'eat').length, 5)
  assert.equal(state.inventory.blaze_rod, 7)
})

test('отказ еды без роста сытости не запускает повторные укусы', async () => {
  const state: Record<string, any> = { health: 20, food: 13, inventory: { melon_slice: 9 } }
  let attempts = 0
  const c = campaign(state, { foes: 0 }, method => { if (method === 'eat') attempts++; return {} as Record<string, any> })
  assert.equal(await c.eatTo(18), false)
  assert.equal(attempts, 1)
})

test('the real supply adapter stops after interrupted table recovery even outside a graph execution', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', inventory: { oak_planks: 10, stick: 4, blackstone: 7, stone_pickaxe: 1 } }
  const calls: Array<{method: string; params: Record<string, unknown>}> = []
  const c = campaign(state, { pickLeft: 253 }, (method, params) => {
    calls.push({ method, params })
    return { rpcResult: { status: 'interrupted', code: 'TACTICAL', state, events: [] } }
  })
  const result = await c.replenishNetherSupply()
  assert.equal(result.interrupted, true)
  assert.equal(result.ready, false)
  assert.deepEqual(calls.map(call => call.method), ['mine'])
  assert.equal(calls[0].params.block, 'crafting_table')
  assert.equal(state.inventory.oak_planks, 10)
})

test('the real crafting prehook retrieves a visible table without spending planks and stops on interruption', async () => {
  for (const interrupted of [false, true]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 106, y: 71, z: 137 },
      inventory: { oak_planks: 10, crafting_table: 0, stick: 4, blackstone: 7, iron_pickaxe: 1, stone_pickaxe: 1 } }
    const steps: Array<{ method: string; params: Record<string, any> }> = []
    const c = campaign(state, { surface: false, foes: 0, pickLeft: 253 }, (method, params) => {
      steps.push({ method, params })
      if (method === 'mine' && params.block === 'crafting_table') {
        assert.equal(params.radius, 3); assert.equal(params.fair, true); assert.equal(params.dry, true)
        if (interrupted) return { rpcResult: { status: 'interrupted', code: 'TACTICAL', by: { type: 'tactical' }, state, events: [] } }
        state.inventory.crafting_table = 1
      }
      if (method === 'craft' && params.item === 'stone_pickaxe') {
        state.inventory.stick -= 2; state.inventory.blackstone -= 3; state.inventory.stone_pickaxe++
      }
      return {}
    })
    assert.equal(await c.craft('stone_pickaxe'), !interrupted)
    assert.equal(state.inventory.oak_planks, 10)
    assert.equal(steps.some(step => step.method === 'craft' && step.params.item === 'crafting_table'), false)
    assert.equal(steps.some(step => step.method === 'craft' && step.params.item === 'stone_pickaxe'), !interrupted)
  }
})

function inventoryBot (inventory) {
  const slots = Array(46).fill(null)
  let slot = 9
  for (const [name, count] of Object.entries<any>(inventory)) {
    for (let remaining = count; remaining > 0;) {
      const n = Math.min(64, remaining)
      slots[slot] = { name, count: n, slot: slot++ }
      remaining -= n
    }
  }
  return {
    inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(x => !x).length },
    async tossStack (item) { slots[item.slot] = null; inventory[item.name] -= item.count; if (!inventory[item.name]) delete inventory[item.name] }
  }
}

test('видимые арбузы дают еду до пустой прогулки за животными', async () => {
  const state: Record<string, any> = { health: 20, food: 16, dimension: 'overworld', biome: 'jungle', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 1, stone_axe: 1, oak_planks: 30, white_bed: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'observe') return { entities: [], blocks: [{ name: 'melon', dist: 12, nearest: { x: 12, y: 70, z: 0 } }] }
    // Запас — по сытости: 27 долек = 9 кусков (8 нужно); 9 долек — лишь 3.
    if (method === 'mine' && params.block === 'melon') { state.inventory.melon_slice = 27; return { dug: 5 } }
    return {} as Record<string, any>
  })
  c.hooks({ recoverGuard: async () => {}, toSurface: async () => true })
  await c.runStage('food')
  assert.equal(calls.filter(x => x.method === 'mine' && x.params.block === 'melon').length, 1)
  assert.equal(calls.some(x => x.method === 'goto'), false)
  assert.equal(c.needs('food'), false)
})

test('достаточный запас прочности не расходует дерево на ненужные палки', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { oak_planks: 8, crafting_table: 1, iron_pickaxe: 2 } }
  const calls = []
  const c = campaign(state, { pickLeft: 400, free: 12 }, (method, params) => {
    calls.push([method, params])
    if (method === 'craft') state.inventory[params.item] = params.count || 1
    return {} as Record<string, any>
  })
  await c.spares(200)
  assert.equal(calls.filter(([method]: any) => method === 'craft').length, 0)
})

test('разгрузка кампании оставляет один переносной верстак и одну печь', async () => {
  let caps
  const c = campaign({ health: 20, food: 20, dimension: 'overworld', inventory: {} as Record<string, any> }, { free: 0 }, (method, params) => {
    if (method === 'pack') caps = params.also
    return {} as Record<string, any>
  })
  await c.unclutter()
  assert.match(caps, /crafting_table:1(?:,|$)/)
  assert.match(caps, /furnace:1(?:,|$)/)
})

test('еда полна без кровати — этап еды не нужен, и сборы за кроватью не охотятся (путь спидраннеров, 30.09)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 2, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, oak_log: 4, cooked_beef: 8, shield: 1, flint_and_steel: 1 } }
  const places = { 'портал': { x: 0, y: 64, z: 0, dimension: 'overworld' } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'observe') return { entities: [{ name: 'sheep', dist: 3, pos: { x: 3, y: 64, z: 0 } }] }
    if (method === 'fight') state.inventory.white_wool = 3
    if (method === 'craft') {
      state.inventory[params.item] = params.count || 1
      if (params.item === 'white_bed') delete state.inventory.white_wool
    }
    if (method === 'sleep' && params.mode === 'spawn') places['точка возрождения'] = { x: 1, y: 64, z: 1, dimension: 'overworld' }
    return {} as Record<string, any>
  })
  c.hooks({ recoverGuard: async () => {}, toSurface: async () => true })
  await c.readMemory()
  assert.equal(c.needs('food'), false, 'восемь кусков еды — запас набран, кровать тут ни при чём')
  // Решение пользователя 30.09: в Ад — кирка, ведро, еда; охота за шерстью на кровать — не условие входа.
  assert.equal(c.needs('prep'), false, 'огниво и еда есть — сборы не нужны')
  // Шерсть в рюкзаке уже есть — кровать делается попутно, без охоты.
  state.inventory.white_wool = 3
  state.inventory.shield = 0
  state.inventory.iron_ingot = 1
  assert.equal(c.needs('prep'), true, 'слиток в рюкзаке — щит сборов почти даром')
  await c.runStage('prep')
  assert.equal(calls.filter(x => x.method === 'fight').length, 0, 'за шерстью не охотится')
  assert.equal(state.inventory.white_bed, 1)
  assert.equal(state.inventory.shield, 1, 'щит — из слитка в рюкзаке')
})
test('древесный уголь на факелы получает место в рюкзаке до загрузки печки', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 6, oak_planks: 4, furnace: 1, torch: 1 } }
  const situation: Record<string, any> = { free: 0 }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'pack') situation.free = 4
    if (method === 'smelt') {
      assert.ok(situation.free > 0, 'уголь не должен остаться в полной печке')
      state.inventory.charcoal = 2
    }
    if (method === 'craft') state.inventory.torch = 9
    return {} as Record<string, any>
  })
  await c.lightUp()
  assert.ok(calls.indexOf('pack') < calls.indexOf('smelt'))
})

test('крафт освобождает место до расхода материалов, а не повторяет потерянный результат', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', inventory: { cobblestone: 64, stick: 64, crafting_table: 1, netherrack: 2112 } }
  const situation: Record<string, any> = { free: 0 }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'pack') situation.free = 8
    if (method === 'craft') {
      assert.ok(situation.free > 0, 'полный рюкзак выбрасывает новый инструмент на землю')
      state.inventory.stone_pickaxe = 1
    }
    return {} as Record<string, any>
  })
  assert.equal(await c.craft('stone_pickaxe'), true)
  assert.ok(calls.indexOf('pack') < calls.indexOf('craft'))
  assert.equal(calls.filter(x => x === 'craft').length, 1)
})

test('восстановление у существующего портала пополняет дерево до поломки последних кирок', () => {
  const state: Record<string, any> = { health: 19, food: 17, inventory: { stone_pickaxe: 2, stone_axe: 1, blaze_rod: 2 } }
  const c = campaign(state, {} as Record<string, any>)
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.needs('wood'), true, 'без дерева нельзя восстановить щит или переплавить железо')
  state.inventory.oak_log = 4
  assert.equal(c.needs('wood'), false, 'пополнение не требует исходных 14 брёвен')
})

test('пополнение дерева сохраняет брёвна для щита и не создаёт лишнюю деревянную кирку', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 2, stone_axe: 1 } }
  let crafts = 0
  const c = campaign(state, { surface: true }, method => {
    if (method === 'mine') { state.inventory.oak_log = 4; return { dug: 4 } }
    if (method === 'craft') crafts++
    return {} as Record<string, any>
  })
  c.known.portal = { x: 0, y: 65, z: 0 }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('wood')
  assert.equal(state.inventory.oak_log, 4)
  assert.equal(crafts, 0)
})

test('разгрузка перед плавкой освобождает место, сохраняя предметы прохождения', async () => {
  const inventory = {
    raw_copper: 101, leaf_litter: 43, cobblestone: 256, netherrack: 192,
    magma_block: 3, nether_brick_fence: 1, nether_bricks: 12, granite: 2,
    raw_iron: 4, coal: 32, birch_log: 7, stick: 6, crafting_table: 1,
    iron_pickaxe: 1, iron_chestplate: 1, shield: 1, water_bucket: 1,
    blaze_rod: 7, ender_pearl: 14, ender_eye: 2, obsidian: 3, gold_ingot: 5,
    arrow: 32, bow: 1, white_wool: 3, string: 6, potion: 1
  }
  const bot = inventoryBot(inventory)
  const state: Record<string, any> = { health: 20, food: 20, inventory, dimension: 'overworld' }
  const situation: Record<string, any> = { free: bot.inventory.emptySlotCount() }
  const c = campaign(state, situation, (method, params) => {
    if (method === 'pack') {
      // RPC асинхронен; ниже отдельный await для реального алгоритма рюкзака.
      const also = Object.fromEntries(params.also.split(',').map(x => x.trim().split(':')).map(([k, v]: any) => [k, +v]))
      situation.also = also
    }
    return {} as Record<string, any>
  })
  await c.unclutter()
  await pack.tidy(bot, { also: situation.also })
  assert.ok(bot.inventory.emptySlotCount() >= 8, 'нужно место под добычу, плавку и крафт')
  assert.equal(inventory.raw_copper || 0, 0)
  assert.equal(inventory.leaf_litter || 0, 0)
  assert.ok(inventory.cobblestone >= 128)
  for (const [name, count] of Object.entries<any>({ raw_iron: 4, coal: 32, birch_log: 7, iron_pickaxe: 1,
    blaze_rod: 7, ender_pearl: 14, ender_eye: 2, obsidian: 3, gold_ingot: 5,
    white_wool: 3, string: 6, potion: 1, arrow: 32 })) assert.equal(inventory[name], count, name)
})

test('плавка разгружает полный рюкзак до загрузки руды', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { raw_iron: 4, coal: 4, furnace: 1 }, dimension: 'overworld' }
  const situation: Record<string, any> = { free: 0 }
  const c = campaign(state, situation, method => {
    if (method === 'pack') situation.free = 8
    if (method === 'smelt') {
      delete state.inventory.raw_iron
      if (situation.free > 0) state.inventory.iron_ingot = 4
      return situation.free > 0 ? { gained: { iron_ingot: 4 } } : { stopped: 'инвентарь полон — выплавленное осталось в печке' }
    }
    return {} as Record<string, any>
  })
  await c.smeltAll('raw_iron', 'iron_ingot')
  assert.equal(state.inventory.iron_ingot, 4, 'добытое железо должно попасть в рюкзак')
})

test('изношенная кирка заменяется деревянной, если булыжника нет', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { wooden_pickaxe: 1, oak_planks: 4, stick: 9, crafting_table: 1 } }
  const situation: Record<string, any> = { pickLeft: 3 }
  const c = campaign(state, situation, (method, params) => {
    if (method === 'craft' && params.item === 'wooden_pickaxe') {
      state.inventory.wooden_pickaxe++
      state.inventory.oak_planks -= 3
      state.inventory.stick -= 2
      situation.pickLeft += 59
    }
    return {} as Record<string, any>
  })
  await c.spares(40)
  assert.ok(situation.pickLeft >= 40, 'наличие старой кирки не означает, что ей можно подняться')
})

test('частичная добыча железа позволяет продолжить этап без десятиминутного отдыха', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', inventory: {} as Record<string, any> }
  let attempts = 0
  let waits = 0
  const c = campaign(state, {} as Record<string, any>, method => { if (method === 'wait') waits++; return {} as Record<string, any> }, { argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => {
    attempts++
    state.inventory.raw_iron = attempts
    if (attempts === 3) state.inventory.iron_pickaxe = 1
  })
  await c.boot()
  assert.equal(state.inventory.iron_pickaxe, 1, 'добыча по частям должна довести до кирки')
  assert.equal(waits, 0, 'частичный полезный результат не является повторным провалом')
})

test('кровать делается из смешанной шерсти и костей без новой охоты', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { white_wool: 1, brown_wool: 2, light_gray_wool: 1,
    bone: 9, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {} as Record<string, any>, (method, p) => {
    if (method !== 'craft') return {} as Record<string, any>
    const inv = state.inventory
    if (p.item === 'bone_meal') { inv.bone--; inv.bone_meal = 3 }
    if (p.item === 'white_dye') { inv.bone_meal -= p.count; inv.white_dye = p.count }
    if (p.item === 'white_wool') { inv.brown_wool -= p.count; inv.white_dye -= p.count; inv.white_wool += p.count }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {} as Record<string, any>
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1)
  assert.equal(state.inventory.light_gray_wool, 1)
  assert.equal(state.inventory.bone, 8)
})

test('частичный выход красителя добирается по рюкзаку до окраски шерсти', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { white_wool: 1, brown_wool: 2,
    bone: 9, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {} as Record<string, any>, (method, p) => {
    if (method !== 'craft') return {} as Record<string, any>
    const inv = state.inventory
    if (p.item === 'bone_meal') { inv.bone--; inv.bone_meal = (inv.bone_meal || 0) + 3 }
    if (p.item === 'white_dye') { inv.bone_meal--; inv.white_dye = (inv.white_dye || 0) + 1 }
    if (p.item === 'white_wool' && inv.white_dye >= p.count) { inv.brown_wool -= p.count; inv.white_dye -= p.count; inv.white_wool += p.count }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {} as Record<string, any>
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1, 'done при одном красителе не означает, что готово два')
})

test('смешанные цвета окрашиваются в несколько частичных крафтов до трёх белых', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { white_wool: 1, light_gray_wool: 1, brown_wool: 2,
    white_dye: 2, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {} as Record<string, any>, (method, p) => {
    if (method !== 'craft') return {} as Record<string, any>
    const inv = state.inventory
    if (p.item === 'white_wool' && inv.white_dye > 0) {
      const color = inv.light_gray_wool > 0 ? 'light_gray_wool' : 'brown_wool'
      inv[color]--; inv.white_dye--; inv.white_wool++
    }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {} as Record<string, any>
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1, 'после крафта одного цвета нужно использовать второй')
  assert.equal(state.inventory.brown_wool, 1)
})

test('охота заканчивается на запасе этапа еды и не добирает лишние шесть кусков', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 7, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  let fights = 0
  const c = campaign(state, { surface: true, free: 10 }, method => {
    if (method === 'observe') return { entities: [{ name: 'cow', dist: 3, pos: { x: 3, y: 65, z: 0 } }] }
    if (method === 'fight') { fights++; state.inventory.cooked_beef++ }
    return {} as Record<string, any>
  })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  assert.equal(c.needs('food'), false)
  assert.equal(fights, 1, 'после восьмого куска пора возвращаться к следующей цели')
})

test('готовый запас, щит, огниво и кровать не отправляют на вторую охоту в сборах', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld',
    inventory: { cooked_beef: 8, shield: 1, flint_and_steel: 1, stone_pickaxe: 2, white_bed: 1 } }
  const c = campaign(state, { surface: true })
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.needs('food'), false)
  assert.equal(c.needs('prep'), false, 'сборы не должны снова требовать 12 вместо уже собранных 8')
  assert.equal(c.needs('nether'), true)
})

test('пустая охота ограничена четырьмя новыми участками за попытку', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 5, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  let walks = 0
  const c = campaign(state, { surface: true, free: 10 }, method => {
    if (method === 'goto') { walks++; state.pos.x += 64 }
    return {} as Record<string, any>
  })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  assert.ok(walks > 0 && walks <= 4, `пустых переходов: ${walks}`)
})

test('охота с полным рюкзаком сначала освобождает место для добычи', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 5, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  const calls = []
  const sit: Record<string, any> = { surface: true, free: 0 }
  const c = campaign(state, sit, method => { calls.push(method); if (method === 'pack') sit.free = 8; return {} as Record<string, any> })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  const tidy = calls.indexOf('pack')
  const search = calls.indexOf('observe')
  assert.ok(tidy >= 0 && tidy < search, 'сначала место под мясо, потом поиск и убийство животных')
})

test('сырое железо без угля плавится досками сверх запаса, а не «дерево — запас на глубину» (cl-b 14.10)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 },
    inventory: { raw_iron: 6, oak_planks: 6, furnace: 1, crafting_table: 1, stone_pickaxe: 1 } }
  const fuels = []
  const c = campaign(state, { free: 30 }, (method, params) => {
    if (method === 'smelt') { fuels.push(params.fuel); state.inventory.iron_ingot = state.inventory.raw_iron; state.inventory.raw_iron = 0 }
    return {} as Record<string, any>
  })
  await c.smeltAll('raw_iron', 'iron_ingot')
  assert.deepEqual(fuels, ['oak_planks'])
  assert.equal(state.inventory.iron_ingot, 6)
})


test('neP-2: impossible sticks and pick recipes send no RPC; newly carried wood reopens the same recipe', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: -71, y: 76, z: 79 },
    inventory: { crafting_table: 1, cobblestone: 6 } }
  const crafts: string[] = []
  const c = campaign(state, { foes: 0 }, (method, params) => {
    if (method === 'craft') {
      crafts.push(params.item)
      if (params.item === 'stick' && state.inventory.oak_planks >= 2) { state.inventory.oak_planks -= 2; state.inventory.stick = 4 }
      if (params.item === 'stone_pickaxe' && state.inventory.stick >= 2) state.inventory.stone_pickaxe = 1
    }
    return {}
  })
  assert.equal(await c.ensurePick(), false); assert.equal(await c.ensurePick(), false)
  assert.equal(crafts.length, 0)
  state.inventory.oak_planks = 2
  assert.equal(await c.ensurePick(), true)
  assert.deepEqual(crafts, ['stick', 'stone_pickaxe'])
})

test('a missing table with no plank recipe is observed once without repeating impossible table crafts', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: -53, y: 87, z: 51 }, inventory: {} }
  const calls: string[] = []
  const c = campaign(state, { foes: 0 }, method => { calls.push(method); return {} })
  assert.equal(await c.ensureTable(), false)
  assert.equal(calls.filter(m => m === 'craft').length, 0)
  assert.equal(calls.filter(m => m === 'mine').length, 1, 'the physical nearby table can still be recovered')
})
