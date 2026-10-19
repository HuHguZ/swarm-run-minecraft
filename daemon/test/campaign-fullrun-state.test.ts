import { declarationsOf } from './source-fixture'
import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'

const source = campaignTs(process.env.CAMPAIGN_R4_SOURCE)
function load(start: string, end: string, context: any) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first)
  return run(source.slice(first, last), context)
}
// Объявления по именам: части daemon/campaign/ разнесли бывших соседей по текстам.
function run(code: string, context: any) {
  vm.runInNewContext(transformSync(code, { loader: 'ts' }).code, cjsContext(withSetters(context)))
  return context
}
const quantity = (inventory: any) => (name: any) => typeof name === 'string' ? inventory[name] || 0 :
  Object.entries(inventory).reduce((n, [item, count]) => n + (name.test(item) ? Number(count) : 0), 0)
function gear(env: any = {}, inventory: any = { iron_ingot: 1 }, armor: any = {}) {
  return run(declarationsOf(source, 'GEAR_CALC', 'ARMOR_POINTS', 'ARMOR_COST', 'ARMOR_SLOT', 'armorPointsNow', 'armorCut', 'gearWorth'),
    { process: { env }, state: { armor }, have: quantity(inventory) }).gearWorth('iron_chestplate')
}

test('fp1-s13: legacy armor estimate remains 18 minutes when the flag is off', () => {
  assert.ok(Math.abs(gear().gain - 18) < 1e-9)
  assert.equal(gear().take, true)
  assert.equal(gear({ ND_ARMOR_FIRST_DEATH: '0' }).take, true)
})
test('fp1-s13: first-death hazard estimate does not buy an 11.7-minute mining trip', () => {
  const result = gear({ ND_ARMOR_FIRST_DEATH: '1' })
  assert.ok(Math.abs(result.cost - 11.7) < 1e-9)
  assert.ok(Math.abs(result.gain - (Math.exp(-2.2) - Math.exp(-2.5)) * 60) < 1e-9)
  assert.equal(result.take, false)
  assert.match(result.line, /риск первой смерти/)
})
test('first-death pricing still crafts carried armor and does not buy a duplicate', () => {
  assert.equal(gear({ ND_ARMOR_FIRST_DEATH: '1' }, { iron_ingot: 8 }).take, true)
  assert.equal(gear({ ND_ARMOR_FIRST_DEATH: '1' }, { iron_ingot: 8 }, { torso: 'iron_chestplate' }).take, false)
})

async function heal(env: any, options: any = {}) {
  const state: any = { health: 13, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { cooked_beef: 7 }, ...options.state }
  const calls: string[] = []
  const ctx: any = { state, sit: { foes: 0, night: true }, process: { env }, resting: false, died: false,
    have: quantity(state.inventory), FOOD: /^(cooked_beef|bread)$/, RAW: /^beef$/, dim: () => state.dimension,
    sense: async () => {}, refresh: async () => {}, log: () => {}, cook: async () => {},
    blazeDugInAt: -Infinity, blazeDugInPos: null, gameClock: { now: () => 0 }, known: { netherPortal: { x: 55, z: 0 } },
    routeHealing: false, restIdleUntil: 0,
    act: async (method: string) => {
      calls.push(method)
      if (method === 'ne_burrow') { if (!options.hungry) state.health = 20; if (options.die) ctx.died = true }
      if (method === 'wait' && options.regen) state.health++
      return { status: 'done', detail: options.regen ? { ok: true } : {} }
    },
    returnFromNether: async () => { calls.push('returnFromNether'); state.dimension = 'overworld'; return true }
  }
  load('async function rest (', '\nlet nightSatUntil', ctx)
  await ctx.rest(16)
  assert.equal(ctx.resting, false)
  return { state, calls }
}
test('fp1-s13 54m: burrow already restored HP; state flag avoids the pointless return', async () => {
  const fixed = await heal({ ND_HEAL_WORLD_STATE: '1' })
  assert.equal(fixed.state.health, 20)
  assert.equal(fixed.state.dimension, 'the_nether')
  assert.equal(fixed.calls.includes('returnFromNether'), false)
  assert.equal((await heal({})).calls.includes('returnFromNether'), true)
})
test('fp1-s13 74m: hunger 16 and no food cannot be healed by twelve waits', async () => {
  const options = { hungry: true, state: { health: 9, food: 16, inventory: {} } }
  assert.equal((await heal({ ND_HEAL_WORLD_STATE: '1' }, options)).calls.filter(x => x === 'wait').length, 0)
  assert.equal((await heal({}, options)).calls.filter(x => x === 'wait').length, 12)
})
test('the natural regeneration boundary remains 18, and death during burrow ends rest', async () => {
  const fixed = await heal({ ND_HEAL_WORLD_STATE: '1' }, { hungry: true, regen: true, state: { health: 13, food: 18, inventory: {} } })
  assert.equal(fixed.state.health, 16)
  assert.equal(fixed.calls.filter(x => x === 'wait').length, 3)
  assert.equal((await heal({ ND_HEAL_WORLD_STATE: '1' }, { die: true })).calls.includes('returnFromNether'), false)
})

async function enter(env: any, options: any = {}) {
  const state: any = { dimension: options.dimension || 'overworld', inventory: options.inventory || { beef: 8 } }
  const calls: string[] = []
  const ctx: any = { state, process: { env }, sit: { foes: options.foes || 0 }, known: {}, died: false, strategyInterrupted: false,
    dim: () => state.dimension, have: quantity(state.inventory), RAW: /^beef$/, lighter: () => true,
    log: () => {}, refresh: async () => {}, shieldOn: () => true, goldOn: () => true,
    cook: async () => { calls.push('cook'); if (options.interrupt) ctx.strategyInterrupted = true },
    act: async (method: string) => { calls.push(method); return { status: 'done', detail: { went: true } } }
  }
  run(declarationsOf(source, 'enterNether'), ctx)
  await ctx.enterNether()
  return calls
}
test('raw Nether food is cooked at entry even if preparation was interrupted', async () => {
  assert.deepEqual(await enter({ ND_NETHER_COOK: '1' }), ['cook', 'portal'])
  assert.deepEqual(await enter({}), ['portal'])
})
test('entry cooking does not start under hostiles, without raw meat, or in the Nether', async () => {
  for (const options of [{ foes: 1 }, { inventory: { cooked_beef: 8 } }, { dimension: 'the_nether' }]) {
    assert.deepEqual(await enter({ ND_NETHER_COOK: '1' }, options), ['portal'])
  }
  assert.deepEqual(await enter({ ND_NETHER_COOK: '1' }, { interrupt: true }), ['cook'])
})
