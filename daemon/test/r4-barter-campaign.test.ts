'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { withClockFixture } = require('./clock-fixture')
function fakeDate (clock) { return class extends Date { static now () { return clock.t } } }

function campaign (state, situation, handle: (...args: any[]) => any = () => ({} as Record<string, any>), { logs = null, env = {} as Record<string, any>, argv = [], clock = null, onStatus = null }: any = {} as Record<string, any>) {
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      const detail = method === 'situation' ? situation : method === 'status' ? ((onStatus && onStatus()) || {} as Record<string, any>) : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({
        id, ok: true, result: detail?.rpcResult || { status: 'done', detail, state, events: [] }
      })))
    }
    close () {}
  }
  const context = {
    require: name => path.basename(name) === 'barter-flow' ? { ...require(name), enabled: () => env.ND_BARTER_FLOW === '1' } : name === 'ws' ? Socket : name === 'fs' ? { appendFileSync (file, line) { if (logs) logs.push(String(line)) } } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js', ...argv], env },
    console: { log () {}, error () {} }, setTimeout, Date: clock ? fakeDate(clock) : Date, queueMicrotask
  }
  vm.runInNewContext(fs.readFileSync(process.env.CAMPAIGN_TEST_SOURCE || path.join(__dirname, '../campaign.js'), 'utf8') + `
    module.exports = { act, refresh, readMemory, nextBastion, died: () => died, stage: name => { stage = name }, craft, nightGuard, rest, eatTo, recoverGuard, descend, goToward, returnFromNether, spares, toSurface, unclutter, smeltAll, lightUp, known, makeBed,
      fightReady: () => fightReady(), gearWorth: (item, o) => gearWorth(item, o), wantFightGear: () => { fightGearWanted = true },
      runStage: name => STAGES.find(s => s.name === name).run(),
      needs: name => STAGES.find(s => s.name === name).needed(),
      done: name => DONE[name](),
      ready: name => STAGES.find(s => s.name === name).ready(),
      defers: name => STAGES.find(s => s.name === name).defer(),
      boot: () => ws.listeners.get('open')(),
      keepStages: names => { const keep = STAGES.filter(s => names.includes(s.name)); STAGES.splice(0, STAGES.length, ...keep) },
      ironOnly: run => { STAGES.splice(0, STAGES.length, { name: 'iron', needed: () => !have(PICK_IRON),
        ready: () => true, defer: () => false, done: () => have(PICK_IRON) > 0, run }); },
      hooks: h => { if (h.spares) spares = h.spares; if (h.ensurePick) ensurePick = h.ensurePick;
        if (h.recoverGuard) recoverGuard = h.recoverGuard; if (h.toSurface) toSurface = h.toSurface; },
      init: () => { state = testState; sit = testSituation; }
    }
  `, withClockFixture(Object.assign(context, { testState: state, testSituation: situation })))
  context.module.exports.init()
  return context.module.exports
}

function fixture (env: any = {} as Record<string, any>) {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 80 },
    inventory: { gold_ingot: 99, ender_pearl: 10, obsidian: 10, iron_pickaxe: 1, cooked_beef: 12,
      oak_planks: 16, crafting_table: 1, stick: 2 },
    armor: { feet: 'golden_boots' }, potions: {} as Record<string, any> }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 50, z: 80, dimension: 'the_nether', gold: [[101, 50, 80]] },
    'бастион 2 (ад)': { x: 200, y: 50, z: 80, dimension: 'the_nether', gold: [[201, 50, 80]] },
    'крепость': { x: 1000, y: 0, z: 0, dimension: 'overworld' } }
  const logs = []; const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') return { ingotsTraded: 0, goldBlocksDug: 0, knownGoldLeft: 1, barterRetry: 'нет места', stopped: 'бартер встал' }
    return {} as Record<string, any>
  }, { env: { ND_BARTER_FLOW: '1', ND_BASTION_FIRST: '1', ND_FR_STRICT: '1', ND_NE_ROUTE: '1', ND_EYES_NEED: '10', ...env }, logs })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  return { c, state, logs, calls }
}
test('FR strict keeps bastion actionable when pearls and obsidian are already enough', async () => {
  const { c, state } = fixture()
  await c.readMemory()
  assert.equal(c.needs('bastion'), true)
  state.potions = { fire_resistance: 2 }
  assert.equal(c.needs('bastion'), false)
})
test('zero trades with carried gold preserves the nearby Bastion without asserting exhaustion', async () => {
  const { c, state, calls } = fixture()
  state.inventory.ender_pearl = 0
  await c.readMemory(); await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион (ад)')
  assert.equal(calls.some(([method, p]: any) => method === 'remember' && /выработан/.test(p.place || '')), false)
})
test('a real partial approach with carried gold continues the same remote barter site before rotating', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 2, y: 63, z: 4 },
    inventory: { gold_ingot: 44, iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 2 },
    armor: { feet: 'golden_boots' } }
  const places = {
    'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether', gold: [[87, 35, 139]] },
    'бастион 2 (ад)': { x: 545, y: 48, z: -99, dimension: 'the_nether', gold: [[545, 48, -99]] }
  }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') {
      state.pos = { x: 24, y: 57, z: 39 }
      return { goldBlocksDug: 0, ingotsTraded: 0, barterRetry: 'время вышло',
        stopped: 'подход к защищённому бартеру не завершён', tunnel: { ok: false, steps: 42, dug: 106 } }
    }
    return {}
  }, { env: { ND_BARTER_FLOW: '1', ND_BASTION_FIRST: '1', ND_NE_ROUTE: '1', ND_EYES_NEED: '10' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион (ад)', 'actual approach progress preserves its destination')
  assert.equal(state.inventory.gold_ingot, 44, 'approach is not reported as a handoff')
  assert.equal(c.done('bastion'), false)
  await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)', 'a genuinely stationary dry site retains the existing bounded deferral')
  assert.equal(calls.some(([method, params]: any) => method === 'remember' && /выработан/.test(params.place || '')), false)
})
test('ND_BARTER_FLOW=0 keeps previous bastion eligibility', async () => {
  const { c } = fixture({ ND_BARTER_FLOW: '0' })
  await c.readMemory()
  assert.equal(c.needs('bastion'), false)
})

test('barter retry preserves exit-kit RPC and all completion gates together', async () => {
  const { c, state, calls } = fixture({ ND_SH_NETHER: '1', ND_EXIT_KIT: '1', ND_END_ENTRY: '1' })
  state.inventory.flint_and_steel = 1
  await c.readMemory()
  assert.equal(c.needs('bastion'), true)
  assert.equal(c.done('bastion'), false)
  await c.runStage('bastion')
  const rpc = calls.find(([method]: any) => method === 'bastion')[1]
  assert.equal(rpc.exit, false)
  assert.equal(rpc.obsidian, 10)
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)', 'only fire resistance remains; the bounded dry trade site can rotate')
  state.potions = { fire_resistance: 2 }
  await c.refresh()
  assert.equal(c.needs('bastion'), false)
  assert.equal(c.done('bastion'), true)
  delete state.inventory.flint_and_steel
  await c.refresh()
  assert.equal(c.needs('bastion'), true)
  assert.equal(c.done('bastion'), false)
})
test('barter flow preserves mapped-portal entry and completion only in the End', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 50, z: 80 }, inventory: {} as Record<string, any> }
  const calls = []
  const c = campaign(state, {} as Record<string, any>, (method, params) => {
    calls.push([method, params])
    if (method === 'stronghold' && params.mode === 'fill') {
      state.dimension = 'the_end'
      return { entered: true }
    }
    return {} as Record<string, any>
  }, { env: { ND_BARTER_FLOW: '1', ND_SH_NETHER: '1', ND_EXIT_KIT: '1', ND_END_ENTRY: '1', ND_ENDKIT: '0' } })
  c.known.endPortal = { ...state.pos, dimension: 'overworld' }
  assert.equal(c.needs('stronghold'), true)
  assert.equal(c.done('stronghold'), false)
  await c.runStage('stronghold')
  const portal = calls.filter(([method]: any) => method === 'stronghold')
  assert.deepEqual(portal.map(([, params]: any) => params.mode), ['room', 'fill'])
  assert.equal(portal[1][1].enter, true)
  assert.equal(c.done('stronghold'), true)
  assert.equal(c.needs('stronghold'), false)
})

test('completed travel toward known gold preserves Bastion until two genuinely dry stationary attempts', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 3, y: 69, z: 4 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 2 },
    armor: { feet: 'golden_boots' } }
  const places = {
    'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 71, y: 61, z: 135, dimension: 'the_nether', gold: [[87, 35, 139]] },
    'бастион 2 (ад)': { x: 500, y: 40, z: 140, dimension: 'the_nether', gold: [[501, 35, 140]] }
  }
  const positions = [{ x: 24, y: 58, z: 48 }, { x: 71, y: 44, z: 140 }]
  let attempts = 0
  const logs = []
  const c = campaign(state, { pickLeft: 300 }, (method) => {
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') {
      state.pos = positions[attempts++] || state.pos
      return { goldBlocksDug: 0, ingotsTraded: 0, knownGoldLeft: 17, stopped: 'золото по памяти осталось: 17, пути к нему нет' }
    }
    return {}
  }, { env: { ND_BASTION_FIRST: '1', ND_NE_ROUTE: '1', ND_GOLD_FAST_SAFE: '1', ND_EYES_NEED: '10' }, logs })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('bastion')
  await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион (ад)', 'native movement toward the actual gold is partial progress')
  assert.equal(c.done('bastion'), false, 'approach never fabricates acquired resources')
  assert.equal(logs.some(line => line.includes('отложен на бюджет')), false)
  await c.runStage('bastion')
  await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)', 'two completed stationary failures still bound this site')
  assert.equal(logs.some(line => line.includes('отложен на бюджет')), true)
  assert.equal(logs.some(line => /бастион \(ад\) выработан/.test(line)), false)
})

test('Nether movement yields its current intent on a native interruption instead of launching another controller', async () => {
  for (const cause of ['tactical', 'damage']) for (const interrupted of ['ne_route', 'nether_tunnel', 'goto']) {
    const state = { health: 20, food: 20, dimension: 'the_nether',
      pos: interrupted === 'goto' ? { x: 60, y: 35, z: 115 } : { x: 2, y: 63, z: 4 },
      inventory: { iron_pickaxe: 1, cooked_beef: 12 } }
    const movement = []
    const c = campaign(state, { foes: 0 }, (method) => {
      if (/^(ne_route|nether_tunnel|ne_burrow|goto)$/.test(method)) movement.push(method)
      if (method === interrupted) return { rpcResult: { status: 'interrupted', code: cause === 'tactical' ? 'TACTICAL' : 'DAMAGE', by: { type: cause }, events: [], state } }
      return {}
    }, { env: { ND_NE_ROUTE: interrupted === 'ne_route' ? '1' : '0' } })
    assert.equal(await c.goToward({ x: 87, y: 35, z: 139 }, 4), false)
    assert.deepEqual(movement, [interrupted], 'the old intent cannot switch to a tunnel, burrow or raw walking after native interruption')
  }
})

test('a completed Nether no-path failure still allows an observed alternative route', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 2, y: 63, z: 4 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12 } }
  const target = { x: 87, y: 35, z: 139 }
  const movement = []
  const c = campaign(state, { foes: 0 }, (method) => {
    if (/^(ne_route|nether_tunnel|ne_burrow|goto)$/.test(method)) movement.push(method)
    if (method === 'ne_route') return { rpcResult: { status: 'failed', detail: { why: 'пути нет' }, events: [], state } }
    if (method === 'nether_tunnel') return { ok: false, why: 'пути нет', dug: 1 }
    if (method === 'goto') state.pos = target
    return {}
  }, { env: { ND_NE_ROUTE: '1' } })
  assert.equal(await c.goToward(target, 4), true)
  assert.deepEqual(movement, ['ne_route', 'nether_tunnel', 'goto'])
})
