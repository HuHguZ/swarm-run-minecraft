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
      pearlsPending: () => bastionPearlsPending(), pauseBastion: ms => { bastionPausedUntil = gameClock.now() + ms },
      dugIn: pos => { blazeDugInAt = gameClock.now(); blazeDugInPos = pos },
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
  }, { env: { ND_BARTER_FLOW: '1', ND_BASTION_FIRST: '1', ND_NE_ROUTE: '1', ND_EYES_NEED: '10', ...env }, logs })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  return { c, state, logs, calls }
}
test('pearls and obsidian enough: the bastion is done without fire resistance (FR is priced, not required)', async () => {
  const { c } = fixture()
  await c.readMemory()
  assert.equal(c.needs('bastion'), false)
  assert.equal(c.done('bastion'), true)
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
  state.inventory.ender_pearl = 9
  await c.readMemory()
  assert.equal(c.needs('bastion'), true)
  assert.equal(c.done('bastion'), false)
  await c.runStage('bastion')
  const rpc = calls.find(([method]: any) => method === 'bastion')[1]
  assert.equal(rpc.exit, false)
  assert.equal(rpc.obsidian, 10)
  state.inventory.ender_pearl = 10
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
      // goto — ближе 16 бл.: без золотой вещи дальше идёт штрек (goToward), а здесь проверяется сам goto.
      pos: interrupted === 'goto' ? { x: 80, y: 35, z: 130 } : { x: 2, y: 63, z: 4 },
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

test('s1c: two dry calls defer the only mapped bastion (no endless re-calls when its gold has no path)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 80 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 2 }, armor: { feet: 'golden_boots' } }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 50, z: 80, dimension: 'the_nether', gold: [[101, 50, 80], [102, 50, 80]] } }
  const logs = []
  const c = campaign(state, { pickLeft: 300 }, (method) => {
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') return { goldBlocksDug: 0, ingotsTraded: 0, knownGoldLeft: 2, stopped: 'золото по памяти осталось (2), пути к нему нет' }
    return {} as Record<string, any>
  }, { env: { ND_BARTER_FLOW: '1', ND_BASTION_FIRST: '1', ND_NE_ROUTE: '1', ND_GOLD_FAST_SAFE: '1', ND_EYES_NEED: '12' }, logs })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('bastion')
  assert.equal(logs.some(l => /отложен/.test(l)), false, 'one dry call is not enough')
  await c.runStage('bastion')
  assert.ok(logs.some(l => /два законченных захода без добычи — отложен/.test(l)), 'the second dry call defers it')
})

test('s1c: enderman hunt goes to the warped forest known from the world copy, not around the portal', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 70, z: 0 },
    inventory: { iron_sword: 1, cooked_beef: 12, cobblestone: 64, blaze_rod: 6 }, armor: { feet: 'golden_boots' } }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'искажённый лес (ад)': { x: 200, y: 60, z: -40, dimension: 'the_nether' } }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'ne_route') { state.pos = { x: params.x, y: params.y, z: params.z }; return { ok: true } }
    return {} as Record<string, any>
  }, { env: { ND_ENDERMEN: '1', ND_NE_ROUTE: '1', ND_EYES_NEED: '12' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('pearls').catch(() => {})
  const route = calls.find(([m]: any) => m === 'ne_route')
  assert.ok(route, 'a route to the forest')
  assert.deepEqual([route[1].x, route[1].z], [200, -40])
  assert.ok(calls.findIndex(([m]: any) => m === 'pearls') > calls.indexOf(route), 'the hunt starts after the route')
})

test('s1c: low hp far from the Nether portal heals dug in on the spot, not by a long walk home', async () => {
  const state: Record<string, any> = { health: 8, food: 20, dimension: 'the_nether', pos: { x: 300, y: 70, z: 0 },
    inventory: { cooked_beef: 12, iron_sword: 1 }, armor: {} }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method) => {
    calls.push(method)
    if (method === 'ne_burrow') return { ok: true }
    if (method === 'wait') { state.health = 20; return {} }
    return {} as Record<string, any>
  }, { env: { ND_NE_ROUTE: '1', ND_NE_STAY: '0' } })
  c.known.netherPortal = { x: 0, y: 70, z: 0 }
  await c.rest()
  assert.ok(calls.includes('ne_burrow'))
  assert.equal(calls.includes('ne_route'), false)
})

test('s1d: carried gold far from the bastion goes in a normal mining visit, not a 540 s barter-only approach', async () => {
  const { c, state, calls } = fixture()
  state.inventory.ender_pearl = 0
  state.pos = { x: 100, y: 50, z: 300 }
  await c.readMemory(); await c.runStage('bastion')
  const first = calls.find(([method]: any) => method === 'bastion') as any
  assert.ok(first, 'bastion called')
  assert.notEqual(first[1].mode, 'barter')
  const f2 = fixture()
  f2.state.inventory.ender_pearl = 0
  await f2.c.readMemory(); await f2.c.runStage('bastion')
  const near = f2.calls.find(([method]: any) => method === 'bastion') as any
  assert.equal(near && near[1].mode, 'barter', 'next to the bastion the carried gold is traded first')
})

test('s1d: three bastion calls without gold or trades are deferred even when the body moved inside the bastion', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 80 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 2 }, armor: { feet: 'golden_boots' } }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 50, z: 80, dimension: 'the_nether', gold: [[101, 50, 80], [101, 50, 120]] },
    'бастион 2 (ад)': { x: 300, y: 50, z: 80, dimension: 'the_nether', gold: [[301, 50, 80]] } }
  let k = 0
  const c = campaign(state, { pickLeft: 300 }, (method) => {
    if (method === 'recall') return { state: { places } }
    // Каждый заход — к другой гуще бастиона (≥ 8 бл. ближе к золоту = «подход» засчитан).
    if (method === 'bastion') { k++; state.pos = { x: 100, y: 50, z: k % 2 ? 120 : 80 }; return { goldBlocksDug: 0, ingotsTraded: 0, knownGoldLeft: 2, stopped: 'золото кончилось: видимых блоков больше нет' } }
    return {}
  }, { env: { ND_BARTER_FLOW: '1', ND_BASTION_FIRST: '1', ND_NE_ROUTE: '1', ND_GOLD_FAST_SAFE: '1', ND_EYES_NEED: '10' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  for (let i = 0; i < 3; i++) await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)')
})

test('s1e: a paused bastion is waited out without fire resistance only when the trades after it can bring FR (price, not a rule)', async () => {
  const { c, state } = fixture()
  state.inventory.ender_pearl = 4; state.inventory.gold_ingot = 99
  await c.readMemory()
  assert.equal(c.pearlsPending(), true)
  c.pauseBastion(300000)
  assert.equal(c.pearlsPending(), true, 'no FR, 99 ingots to trade: P(FR) ~0.94, gain ~1190 s > 5 min pause — wait')
  c.pauseBastion(40 * 60000)
  assert.equal(c.pearlsPending(), false, 'same gold, 40 min pause: the wait costs more than the risk it saves — blazes now')
  c.pauseBastion(300000)
  state.inventory.gold_ingot = 0; c.known.bastions.forEach(b => { b.gold = [] })
  assert.equal(c.pearlsPending(), false, 'no gold left to trade after the pause: waiting cannot bring FR — blazes now (the old rule held them closed)')
  state.inventory.gold_ingot = 99; state.inventory['potion'] = 1; state.potions = { fire_resistance: 1 }
  await c.readMemory()
  if (c.pearlsPending()) assert.fail('with fire resistance in the bag the pause is spent on blazes')
})

test('s1d: a bastion that cannot be worked (no iron pickaxe for gold) does not hold the blaze stage closed', async () => {
  const { c, state } = fixture()
  state.inventory.ender_pearl = 4; state.inventory.gold_ingot = 0; delete state.inventory.iron_pickaxe
  await c.readMemory()
  assert.equal(c.pearlsPending(), false)
})

test('s1d: low hp inside the blaze pit — heal in it, no refuge out under the blazes', async () => {
  const calls = []
  const state = { health: 8, food: 14, dimension: 'the_nether', pos: { x: -86, y: 72, z: 61 }, inventory: { cooked_beef: 4 } }
  const c = campaign(state, { foes: 3 }, (method, params) => { calls.push(method); return {} })
  c.dugIn({ x: -86, y: 72, z: 61 })
  await c.rest()
  assert.equal(calls.includes('refuge'), false, calls.join(','))
  assert.ok(calls.includes('wait'))
})

test('s1e: a brute or wither skeleton in the Nether — into the rock by the expected fight damage, not by its name', async () => {
  const run = async (name, health, expectedDamage) => {
    const state: Record<string, any> = { health, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { iron_sword: 1, cooked_beef: 8 } }
    const fight: any = { first: { name, dist: 2 }, order: [{ name, dist: 2 }] }
    if (expectedDamage !== undefined) fight.expectedDamage = expectedDamage
    const calls = []
    const c = campaign(state, { foes: 1, armed: true, fight }, method => {
      calls.push(method)
      if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage' }, state, events: [] } }
      return {} as Record<string, any>
    })
    c.stage('nether')
    await c.act('mine').catch(() => {})
    return calls
  }
  assert.ok((await run('piglin_brute', 20, undefined)).includes('ne_burrow'), 'a full brute (~19 expected) at 20 hp — rock')
  const weak = await run('piglin_brute', 20, 4)
  assert.equal(weak.includes('ne_burrow'), false, 'a brute two blows from death (4 expected) at full hp — fight, the old rule burrowed at any hp')
  assert.ok(weak.includes('fight'), weak.join(','))
  assert.equal((await run('wither_skeleton', 14, 3)).includes('ne_burrow'), false, 'wither 3 + wither effect 4 < 14 − 6 — fight (old: hp < 16 → rock)')
  assert.ok((await run('wither_skeleton', 11, undefined)).includes('ne_burrow'))
})

test('s1e: two hunts in a row with no enderman in sight end the hunt there and the next stage takes another seen forest', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 70, z: 0 },
    inventory: { iron_sword: 1, cooked_beef: 12, cobblestone: 64, blaze_rod: 6 }, armor: { feet: 'golden_boots' } }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'искажённый лес (ад)': { x: 200, y: 60, z: -40, dimension: 'the_nether', by: 'sight', score: 30, alts: [{ x: -300, y: 50, z: 90, score: 12 }] } }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'ne_route' || method === 'goto') { state.pos = { x: params.x, y: params.y, z: params.z }; return { ok: true } }
    if (method === 'pearls') return { seenEndermen: 0, pearls: { gained: 0 } }
    return {} as Record<string, any>
  }, { env: { ND_ENDERMEN: '1', ND_NE_ROUTE: '1', ND_EYES_NEED: '12' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('pearls').catch(() => {})
  assert.equal(calls.filter(([m]: any) => m === 'pearls').length, 2, 'stop after two empty hunts (was up to 8)')
  calls.length = 0
  await c.runStage('pearls').catch(() => {})
  const route = calls.find(([m]: any) => m === 'ne_route')
  assert.ok(route, calls.map(([m]: any) => m).join(','))
  assert.deepEqual([route[1].x, route[1].z], [-300, 90], 'the empty forest is skipped — the other one seen')
})

test('s1e: a bastion waiting for tools that cannot be replenished here does not hold the blaze stage closed (s1e-B0-3 deadlock)', async () => {
  const { c, state, logs } = fixture({ ND_BARTER_FLOW: '0' })
  state.inventory = { ender_pearl: 0, cooked_beef: 12, iron_ingot: 1, crafting_table: 1 }
  await c.readMemory()
  assert.equal(c.pearlsPending(), true, 'a workable bastion first')
  await c.runStage('bastion').catch(() => {})
  assert.ok(logs.some(l => /откладываю до пополнения инструментов/.test(l)), logs.slice(-5).join(' | '))
  assert.equal(c.pearlsPending(), false, 'bastion blocked on tools — blazes are not held closed')
})

test('s1e: blazes behind the wall twice in a row — re-approach the spawner by tunnel with a hall breach, not the same call again', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { stone_pickaxe: 2, iron_pickaxe: 1, shield: 1, cooked_beef: 8, ender_pearl: 14,
    oak_planks: 32, stick: 12, crafting_table: 1, cobblestone: 64, iron_sword: 1 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'golden_helmet', feet: 'iron_boots' }, dimension: 'the_nether', pos: { x: -104, y: 79, z: -415 } }
  const calls = []
  const c = campaign(state, { pickLeft: 400 }, (method, params) => {
    calls.push([method, params])
    if (method === 'fortress') return { reached: true, spawner: { x: -104, y: 83, z: -412 }, dist: 3 }
    if (method === 'blaze') return { stopped: 'ифриты за стеной, доступной точки обзора нет — бой без прогресса прекращён', kills: 0 }
    return {} as Record<string, any>
  }, { env: { ND_EYES_NEED: '12' } })
  c.known.fortress = { x: -104, y: 70, z: -412 }
  c.hooks({ spares: async () => {}, recoverGuard: async () => {} })
  await c.runStage('nether').catch(() => {})
  const f = calls.filter(([m]: any) => m === 'fortress').map(([, p]: any) => p)
  assert.ok(f.some(p => p.tunnel === true && p.breach === true), JSON.stringify(calls.map(([m]: any) => m)))
  const firstBreach = calls.findIndex(([m, p]: any) => m === 'fortress' && p.breach)
  assert.equal(calls.slice(0, firstBreach).filter(([m]: any) => m === 'blaze').length, 2, 'after two blind calls')
})

test('s1e: blind bastion search is budgeted by search time (900 s), not cut at 3 short interrupted calls', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 70, z: 0 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 4, cobblestone: 64 }, armor: { feet: 'golden_boots' } }
  const calls = []
  let seconds = 10
  const c = campaign(state, { pickLeft: 400 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places: { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' } } } }
    if (method === 'fortress' && params.mode === 'bastion') return { found: false, stopped: 'бастиона не видно', seconds }
    return {} as Record<string, any>
  }, { env: { ND_EYES_NEED: '12' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  for (let i = 0; i < 5; i++) await c.runStage('bastion').catch(() => {})
  const searches = () => calls.filter(([m, p]: any) => m === 'fortress' && p.mode === 'bastion').length
  assert.equal(searches(), 5, 'short calls (10 s, counted as 30) keep the search alive past 3')
  seconds = 400
  for (let i = 0; i < 5; i++) await c.runStage('bastion').catch(() => {})
  assert.ok(searches() <= 8, String(searches()))
  assert.ok(searches() >= 7, 'budget 900 s: two long calls after the short ones')
})

test('s1e: leaving the Nether far from the own portal with obsidian and a lighter — a new portal on the spot (price), near — walk home', async () => {
  const { exitChoice } = require('../src/campaign/nether-pause')
  assert.equal(exitChoice({ homeDistance: 300, obsidian: 10, lighter: true }).build, true)
  assert.equal(exitChoice({ homeDistance: 40, obsidian: 10, lighter: true }).build, false, 'home is close — walk')
  assert.equal(exitChoice({ homeDistance: 300, obsidian: 9, lighter: true }).build, false, 'no frame without 10 obsidian')
  const run = async (pos: any) => {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos, inventory: { obsidian: 10, flint_and_steel: 1, ender_eye: 12 } }
    const calls = []
    const c = campaign(state, { pickLeft: 300 }, (method, params) => {
      calls.push([method, params])
      if (method === 'portal' && params.mode === 'enter') { state.dimension = 'overworld' }
      if (method === 'portal' && !params.mode) return { built: true, lit: true }
      return {} as Record<string, any>
    }, { env: { ND_EYES_NEED: '12' } })
    c.known.netherPortal = { x: 0, y: 70, z: 0 }
    await c.returnFromNether()
    return calls
  }
  const far = await run({ x: 300, y: 70, z: 0 })
  assert.deepEqual(far.filter(([m]: any) => m === 'portal').map(([, p]: any) => p.mode || 'build'), ['build', 'enter'])
  const near = await run({ x: 30, y: 70, z: 0 })
  assert.equal(near.some(([m, p]: any) => m === 'portal' && !p.mode), false)
})

test('s1e: a bastion seen from afar with no known gold is approached first, and dry calls from afar do not exhaust it', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 70, z: 0 },
    inventory: { iron_pickaxe: 1, cooked_beef: 12, oak_planks: 16, crafting_table: 1, stick: 4, cobblestone: 64, golden_helmet: 1 }, armor: { head: 'golden_helmet' } }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' }, 'бастион (ад)': { x: 100, y: 62, z: 0, dimension: 'the_nether' } }
  const calls = []; const logs = []
  const c = campaign(state, { pickLeft: 400 }, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') return { goldBlocksDug: 0, ingotsTraded: 0, stopped: 'золото кончилось: видимых блоков больше нет' }
    return {} as Record<string, any>
  }, { env: { ND_EYES_NEED: '12', ND_NE_ROUTE: '1', ND_GOLD_FAST_SAFE: '1' }, logs })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.readMemory()
  await c.runStage('bastion').catch(() => {})
  const firstBastion = calls.findIndex(([m]: any) => m === 'bastion')
  assert.ok(firstBastion > 0, calls.map(([m]: any) => m).join(','))
  assert.ok(calls.slice(0, firstBastion).some(([m, p]: any) => (m === 'ne_route' || m === 'goto') && p.x === 100), 'approach toward the seen bastion first')
  assert.equal(logs.some(l => /выработан/.test(l) && !/не выработан/.test(l)), false, logs.filter(l => /выработан/.test(l)).join(' | '))
})
