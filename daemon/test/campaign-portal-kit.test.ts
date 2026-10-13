import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { speedrunRegistry } from '../src/core/speedrun'
import { emptyWorld, applyEffect, amount } from '../src/core/world-state'
import { worldFromObservation } from '../src/environments/mineflayer'

const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
function fixture(extra: Record<string, number> = {}, env: Record<string, string> = {}) {
  const inventory: Record<string, number> = { iron_ingot: 7, flint: 1, oak_planks: 20, stone_pickaxe: 1, ...extra }
  const calls: Array<{ method: string, params: any }> = []
  const costs: Record<string, number> = { bucket: 3, flint_and_steel: 1, shield: 1, iron_pickaxe: 3, iron_sword: 2 }
  const context: any = { process: { env }, known: {}, state: { inventory }, OW_DEEP: true, castSurfaceFailed: false,
    PICK_IRON: /^(iron|diamond|netherite)_pickaxe$/, ARMOR_POINTS: {}, fightGearWanted: false,
    have: re => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? v : 0), 0),
    lighter: () => !!(inventory.flint_and_steel || inventory.fire_charge), worn: () => true,
    refresh: async () => {}, sticks: async () => {}, log() {}, planksFor: () => 'oak_planks',
    routeMod: { BUCKETS: () => env.ND_ROUTE_ONE === '0' ? 2 : 1 },
    craft: async (item, count = 1) => {
      if (item === 'iron_ingot') {
        const blocks = Math.min(inventory.iron_block || 0, Math.ceil(count / 9))
        if (blocks) { inventory.iron_block -= blocks; inventory.iron_ingot += blocks * 9 }
        else { const times = Math.min(Math.floor((inventory.iron_nugget || 0) / 9), count); inventory.iron_nugget -= times * 9; inventory.iron_ingot += times }
      } else { inventory.iron_ingot -= costs[item] || 0; inventory[item] = (inventory[item] || 0) + 1 }
    },
    act: async (method, params) => { calls.push({ method, params }); return { status: 'done', detail: {} } }
  }
  const helper = source.includes('const portalBuckets =') ? source.slice(source.indexOf('const portalBuckets ='), source.indexOf('async function spendIron ()')) : ''
  const spend = source.slice(source.indexOf('async function spendIron ()'), source.indexOf('const GEAR_CALC'))
  const smelt = source.slice(source.indexOf('const ironToSmelt ='), source.indexOf('async function smeltAll'))
  const casting = source.slice(source.indexOf("defStage('cast',"), source.indexOf("defStage('diamond',"))
  context.defStage = (_name, _needed, run) => { context.cast = run }
  Object.assign(context, { castRuns: 0, died: false, sit: { surface: true, night: false }, PICK_STONE: /_pickaxe$/,
    sense: async () => {}, weakAndHungry: () => false, readMemory: async () => {}, ensureFlint: async () => {},
    recoverGuard: async () => {}, unclutter: async () => {}, dim: () => 'overworld', y: () => 64,
    walkAway: async () => { calls.push({ method: 'walkAway', params: {} }) } })
  vm.createContext(context)
  vm.runInContext((helper + spend + smelt + casting).replace('(plan as any)', 'plan') + '\nthis.spend=spendIron;this.smelt=ironToSmelt', context)
  return { inventory, calls, context }
}

test('seven ingots fund one bucket, ignition and shield before spare combat gear', async () => {
  const f = fixture(); await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.equal(f.inventory.shield, 1)
})
test('smelting prices the selected missing buckets, lighter and shield', () => {
  const f = fixture({ iron_ingot: 0, water_bucket: 1, fire_charge: 1, shield: 1 })
  assert.equal(f.context.smelt(), 0)
  f.context.process.env.ND_ROUTE_ONE = '0'
  assert.equal(f.context.smelt(), 3)
})
test('a carried fire charge does not consume another ingot on a duplicate lighter', async () => {
  const f = fixture({ iron_ingot: 4, fire_charge: 1 }); await f.context.spend()
  assert.equal(f.inventory.flint_and_steel, undefined)
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.shield, 1)
})
test('blind main cast calls the one-bucket skill without a hidden-lava hint', async () => {
  const f = fixture({ water_bucket: 1 }); f.context.OW_DEEP = false
  f.context.act = async (method, params) => { f.calls.push({ method, params }); if (method === 'portal') f.context.known.portal = true; return { detail: {} } }
  await f.context.cast()
  assert.equal(f.calls.find(c => c.method === 'portal')?.params.one, true)
  assert.equal(f.calls.find(c => c.method === 'portal')?.params.hint, undefined)
})

for (const speedrun of [false, true]) {
  test(`night does not silently skip the portal selected by the speedrun graph; speedrun=${speedrun}`, async () => {
    const f = fixture({ water_bucket: 1 })
    f.context.OW_DEEP = false
    f.context.sit.night = true
    f.context.state.playPolicy = { mode: speedrun ? 'speedrun' : 'survival' }
    let guarded = 0
    f.context.nightGuard = async () => { guarded++ }
    f.context.PICK_DIAMOND = /^diamond_pickaxe$/
    f.context.surfaceLavaNear = () => true
    f.context.act = async (method, params) => { f.calls.push({ method, params }); if (method === 'portal') f.context.known.portal = true; return { detail: {} } }
    const deferred = source.slice(source.indexOf('const DEFER ='), source.indexOf('const DONE: any ='))
    vm.runInContext(deferred + '\nthis.deferredCast=DEFER.cast', f.context)
    assert.equal(f.context.deferredCast(), !speedrun)
    await f.context.cast()
    assert.equal(f.calls.some(c => c.method === 'portal'), speedrun)
    assert.equal(guarded, speedrun ? 0 : 6)
  })
}

test('night work does not discard food hunting in speedrun mode', () => {
  const f = fixture()
  Object.assign(f.context, { canWorkAtNight: () => false, NIGHT_DOWN2: () => true })
  f.context.state.food = 11
  f.context.sit.night = true
  vm.runInContext(source.slice(source.indexOf('const nightWork ='), source.indexOf('const FOOD_STOCK =')) + '\nthis.nightWork=nightWork', f.context)
  assert.equal(f.context.nightWork(), true)
  f.context.state.playPolicy = { mode: 'speedrun' }
  assert.equal(f.context.nightWork(), false)
})

for (const carried of [0, 2]) {
  test(`cast gathers only the missing visible filler, including dirt by hand; carried=${carried}`, async () => {
    const f = fixture({ water_bucket: 1, dirt: carried, stone_pickaxe: 0 })
    f.context.OW_DEEP = false
    f.context.COBBLE = /^(cobblestone|stone)$/
    f.context.act = async (method, params) => {
      f.calls.push({ method, params })
      if (method === 'mine' && params.block.split(',').includes('grass_block')) f.inventory.dirt += params.count
      if (method === 'portal' && f.inventory.dirt >= 3) f.context.known.portal = true
      return { detail: method === 'portal' && !f.context.known.portal ? { need: { what: 'cobblestone', count: 3, have: f.inventory.dirt } } : {} }
    }
    await f.context.cast()
    assert.equal(f.context.known.portal, true)
    const mine = f.calls.find(c => c.method === 'mine')!
    assert.equal(mine.params.count, 3 - carried)
    assert.ok(mine.params.timeoutSeconds <= 35)
    assert.equal(mine.params.dry, true)
    assert.equal(f.inventory.dirt, 3)
    assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
  })
}

test('cast does not credit a successful mining RPC without actually received filler', async () => {
  const f = fixture({ water_bucket: 1 })
  f.context.OW_DEEP = false
  f.context.COBBLE = /^(cobblestone|stone)$/
  f.context.act = async (method, params) => {
    f.calls.push({ method, params })
    return { status: 'done', detail: method === 'portal' ? { need: { what: 'cobblestone', count: 3, have: 0 } } : {} }
  }
  await f.context.cast()
  assert.equal(f.context.known.portal, undefined)
  assert.equal(f.calls.filter(c => c.method === 'mine').length, 1)
  const descent = f.calls.find(c => c.method === 'dig_down')!
  assert.ok(descent.params.timeoutSeconds <= 90)
  assert.equal(descent.params.maxFallHp, 0)
})

test('cast replenishes a new shortage after the actual frame consumed its starter blocks', async () => {
  const f = fixture({ water_bucket: 1, dirt: 0 })
  f.context.OW_DEEP = false
  let casts = 0
  f.context.act = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'mine') f.inventory.dirt += params.count
    if (method === 'portal') {
      casts++
      if (casts === 2) f.inventory.dirt -= 2
      if (casts === 3 && f.inventory.dirt >= 8) f.context.known.portal = true
      if (!f.context.known.portal) return { detail: { need: { what: 'cobblestone', count: casts === 1 ? 3 : 8, have: f.inventory.dirt } } }
    }
    return { detail: {} }
  }
  await f.context.cast()
  assert.equal(f.context.known.portal, true)
  assert.deepEqual(f.calls.filter(c => c.method === 'mine').map(c => c.params.count), [3, 7])
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
  assert.equal(casts, 3)
})

test('cast can replenish the same remaining shortage after a different part of the frame consumed its blocks', async () => {
  const f = fixture({ water_bucket: 1, dirt: 0 })
  f.context.OW_DEEP = false
  let casts = 0
  f.context.act = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'mine') f.inventory.dirt += params.count
    if (method === 'portal') {
      casts++
      if (casts === 2 || casts === 3) f.inventory.dirt = 1
      if (casts === 4 && f.inventory.dirt >= 8) f.context.known.portal = true
      if (!f.context.known.portal) return { detail: { frame: `${casts === 1 ? 0 : casts === 2 ? 2 : 8}/10 обсидиан`, need: { what: 'cobblestone', count: casts === 1 ? 3 : 8, have: f.inventory.dirt } } }
    }
    return { detail: {} }
  }
  await f.context.cast()
  assert.equal(f.context.known.portal, true)
  assert.equal(casts, 4)
  assert.deepEqual(f.calls.filter(c => c.method === 'mine').map(c => c.params.count), [3, 7, 7])
})

for (const blocked of [false, true]) {
  test(`cast decomposes the approach to remembered deep lava; descent blocked=${blocked}`, async () => {
    const f = fixture({ water_bucket: 1, cobblestone: 24 })
    f.context.OW_DEEP = false
    f.context.known.lava = { x: 610, y: 11, z: 477 }
    f.context.state.pos = { x: 610, y: 46, z: 477 }
    f.context.y = () => f.context.state.pos.y
    f.context.goToward = async () => true // the native XZ fallback can report arrival 35 blocks above the source
    f.context.spares = async () => {}
    f.context.act = async (method, params) => {
      f.calls.push({ method, params })
      if (method === 'dig_down' && !blocked) f.context.state.pos.y -= params.depth
      if (method === 'explore' || (method === 'portal' && f.context.state.pos.y <= 14)) f.context.known.portal = true
      return { status: 'done', detail: method === 'portal' ? { stopped: 'не вижу лавы в 24 блоках' } : {} }
    }
    await f.context.cast()
    const legs = f.calls.filter(c => c.method === 'dig_down')
    assert.ok(legs.length > 0, 'XZ arrival cannot replace the missing physical descent')
    for (const leg of legs) {
      assert.equal(leg.params.mode, 'stairs'); assert.ok(leg.params.depth > 0 && leg.params.depth <= 12)
      assert.equal(leg.params.timeoutSeconds, 90); assert.equal(leg.params.maxFallHp, 0)
    }
    if (blocked) {
      assert.equal(f.calls.find(c => c.method === 'explore')!.params.surface, true)
      assert.equal(f.calls.find(c => c.method === 'explore')!.params.lavaSource, true)
    }
    else { assert.equal(f.context.state.pos.y, 14); assert.equal(legs.length, 3); assert.equal(f.calls.filter(c => c.method === 'observe').length, 3) }
    assert.equal(f.context.known.portal, true)
  })
}
test('a physically unusable one-bucket shore uses carried two-bucket casting', async () => {
  const f = fixture({ water_bucket: 1, bucket: 1 }); f.context.OW_DEEP = false
  f.context.act = async (method, params) => { f.calls.push({ method, params }); if (method === 'portal' && !params.one) f.context.known.portal = true; return { detail: { stopped: 'места на берегу нет: лавы в досягаемости всего 8' } } }
  await f.context.cast()
  assert.deepEqual(f.calls.filter(c => c.method === 'portal').map(c => c.params.one === true), [true, false])
})
test('carried two-bucket fallback cannot open a window selected by a hidden lava hint', async () => {
  const f = fixture({ water_bucket: 1, bucket: 1 })
  f.context.act = async (method, params) => { f.calls.push({ method, params }); return { detail: { stopped: 'места на берегу нет: берег не твёрдый' } } }
  await f.context.castForKit({ mode: 'cast', hint: { x: 11, y: -55, z: 0 }, windows: true })
  const fallback = f.calls[1].params
  assert.equal(fallback.one, undefined)
  assert.equal(fallback.hint, undefined)
  assert.equal(fallback.windows, false)
})
test('MineIron prices four missing portal ingots and accepts the actually crafted kit', () => {
  const r = speedrunRegistry(), s = emptyWorld(); s.resources = { stone_tool: 1, iron: 1 }; s.structureSearchMs = 180000
  const mine = r.get('MineIron')!, e = typeof mine.expectedEffects === 'function' ? mine.expectedEffects(s) : mine.expectedEffects
  assert.equal(amount(applyEffect(s, e), 'iron'), 4)
  const after = worldFromObservation({ state: { dimension: 'overworld', inventory: { water_bucket: 1, fire_charge: 1 } } }, 0)
  assert.equal(mine.successCondition(s, after), true)
})
test('legacy comparator needs two buckets in the graph; carried water and ignition reduce iron', () => {
  const r = speedrunRegistry({ portalBuckets: 2 }), s = emptyWorld(); s.resources = { bucket: 1, lighter: 1, iron: 3 }
  const kit = r.get('CraftPortalKit')!
  assert.equal(kit.preconditions(s), true)
  const e = typeof kit.expectedEffects === 'function' ? kit.expectedEffects(s) : kit.expectedEffects
  assert.equal(amount(applyEffect(s, e), 'bucket'), 2)
  assert.equal(amount(applyEffect(s, e), 'iron'), 0)
  s.facts.portal = { status: 'known', value: true, source: 'observed', at: 0, confidence: 1 }
  assert.equal(kit.preconditions(s), false)
})
test('partial portal inventory reduces MineIron while an explicit reserve remains its target', () => {
  for (const [bucket, lighter, expected] of [[0, 0, 4], [1, 0, 1], [0, 1, 3]]) {
    const s = emptyWorld(); s.resources = { bucket, lighter, stone_tool: 1 }; s.structureSearchMs = 180000
    const mine = speedrunRegistry().get('MineIron')!
    const e = typeof mine.expectedEffects === 'function' ? mine.expectedEffects(s) : mine.expectedEffects
    assert.equal(amount(applyEffect(s, e), 'iron'), expected)
    assert.equal(mine.successCondition(s, s), false)
    const reserve = speedrunRegistry({ iron: 7 }).get('MineIron')!
    const re = typeof reserve.expectedEffects === 'function' ? reserve.expectedEffects(s) : reserve.expectedEffects
    assert.equal(amount(applyEffect(s, re), 'iron'), 7)
    const kit = emptyWorld(); kit.resources = { bucket: 1, lighter: 1 }
    assert.equal(reserve.successCondition(s, kit), false, 'an explicit iron reserve was not acquired')
  }
})
test('iron stage retains the material value of buckets crafted during its mining loop', async () => {
  const f = fixture({ iron_ingot: 0 }); f.context.OW_DEEP = true
  const ironStage = source.slice(source.indexOf("defStage('iron',"), source.indexOf('async function bucketOnTheWay'))
  let tunnel = 0, mined = 0
  Object.assign(f.context, { ironRuns: 0, ironLeg: 0, ironBlocked: new Set(), state: { inventory:f.inventory, food:20, pos:{x:0,y:16,z:0} },
    y: () => 16, foodUnits: () => 10, cook: async () => {}, lightUp: async () => {}, spares: async () => {},
    foodHuntEmpty:0, gearWorth: () => ({missing:0}), ARMOR_SLOT:{}, OW_HEAR:false, LOGS:/_log$/, COBBLE:/cobblestone/,
    mineSeenAll: async () => {}, mobInTheWay: async () => false, torches: async () => {}, woodNow: () => 6, goldOn: () => false,
    bucketOnTheWay: async () => { f.inventory.bucket=1; f.inventory.iron_ingot=0 },
    smeltAll: async () => {},
    act: async (method,p) => { f.calls.push({method,params:p}); if (method==='tunnel') { tunnel++; f.inventory.iron_ingot=3 }
      if (method==='mine' && /iron_ore/.test(p.block)) { mined++; if(mined>1) f.inventory.iron_ingot=1 }; return {detail:{}} }
  })
  f.context.inventory = f.inventory
  f.context.defStage = (_n,_needed,run) => { f.context.iron = run }
  vm.runInContext(ironStage.replace('const r: any =','const r ='), f.context)
  await f.context.iron()
  assert.equal(tunnel, 1, 'three ingots became the carried bucket, one more completed the portal kit')
  assert.equal(f.calls.filter(c=>c.method==='mine'&&/iron_ore/.test(c.params.block)).at(-1)?.params.count,1)
})
test('MineIron subtracts the two ingots already carried as 24 ruin nuggets', async () => {
  const f = fixture({ iron_ingot: 0, iron_nugget: 24, fire_charge: 1 })
  const ironStage = source.slice(source.indexOf("defStage('iron',"), source.indexOf('async function bucketOnTheWay'))
  Object.assign(f.context, { ironRuns: 0, ironLeg: 0, ironBlocked: new Set(), state: { inventory: f.inventory, food: 20, pos: { x: 0, y: 16, z: 0 } },
    y: () => 16, foodUnits: () => 10, cook: async () => {}, lightUp: async () => {}, spares: async () => {},
    foodHuntEmpty: 0, gearWorth: () => ({ missing: 0 }), ARMOR_SLOT: {}, OW_HEAR: false, LOGS: /_log$/, COBBLE: /cobblestone/,
    mineSeenAll: async () => {}, mobInTheWay: async () => false, torches: async () => {}, woodNow: () => 6, goldOn: () => false,
    bucketOnTheWay: async () => {}, smeltAll: async () => {},
    act: async (method, p) => { f.calls.push({ method, params: p }); if (method === 'mine' && /iron_ore/.test(p.block)) f.inventory.iron_ingot += p.count; return { detail: {} } }
  })
  f.context.defStage = (_n, _needed, run) => { f.context.iron = run }
  vm.runInContext(ironStage.replace('const r: any =', 'const r ='), f.context)
  await f.context.iron()
  const mined = f.calls.filter(c => c.method === 'mine' && /iron_ore/.test(c.params.block))
  assert.equal(mined[0].params.count, 1)
  assert.equal(f.inventory.bucket, 1)
})
test('a failed single-bucket shore is approached again without demanding another bucket', async () => {
  const f = fixture({ water_bucket: 1 }); f.context.OW_DEEP = false
  f.context.act = async (method, params) => { f.calls.push({ method, params }); return { detail: { stopped: 'места на берегу нет: берег не твёрдый' } } }
  await f.context.cast()
  assert.equal(f.calls.filter(c => c.method === 'walkAway').length, 6)
  assert.ok(f.calls.filter(c => c.method === 'portal').every(c => c.params.one === true))
})

test('ruin nuggets counted by the graph become the real bucket before the portal kit succeeds', async () => {
  const f = fixture({ iron_ingot: 0, iron_nugget: 31, fire_charge: 1 })
  await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.iron_nugget, 4)
  assert.equal(f.inventory.iron_ingot, 0)
})

test('carried iron blocks fund the actual kit and sub-ingot nuggets remain intact', async () => {
  const f = fixture({ iron_ingot: 0, iron_block: 1, iron_nugget: 8 })
  await f.context.spend()
  assert.equal(f.inventory.bucket, 1)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.equal(f.inventory.shield, 1)
  assert.equal(f.inventory.iron_block, 0)
  assert.equal(f.inventory.iron_nugget, 8)
})
