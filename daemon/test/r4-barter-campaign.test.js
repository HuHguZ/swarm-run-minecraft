'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
function fakeDate (clock) { return class extends Date { static now () { return clock.t } } }

function campaign (state, situation, handle = () => ({}), { logs = null, env = {}, argv = [], clock = null, onStatus = null } = {}) {
  class Socket {
    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      const detail = method === 'situation' ? situation : method === 'status' ? ((onStatus && onStatus()) || {}) : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({
        id, ok: true, result: detail?.rpcResult || { status: 'done', detail, state, events: [] }
      })))
    }
    close () {}
  }
  const context = {
    require: name => path.basename(name) === 'barter-flow' ? { ...require(name), enabled: () => env.ND_BARTER_FLOW === '1' } : name === 'ws' ? Socket : name === 'fs' ? { appendFileSync (file, line) { if (logs) logs.push(String(line)) } } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
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
  `, Object.assign(context, { testState: state, testSituation: situation }))
  context.module.exports.init()
  return context.module.exports
}

function fixture (env = {}) {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 80 },
    inventory: { gold_ingot: 99, ender_pearl: 10, obsidian: 10, iron_pickaxe: 1, cooked_beef: 12 },
    armor: { feet: 'golden_boots' }, potions: {} }
  const places = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 50, z: 80, dimension: 'the_nether', gold: [[101, 50, 80]] },
    'бастион 2 (ад)': { x: 200, y: 50, z: 80, dimension: 'the_nether', gold: [[201, 50, 80]] },
    'крепость': { x: 1000, y: 0, z: 0, dimension: 'overworld' } }
  const logs = []; const calls = []
  const c = campaign(state, {}, (method, params) => {
    calls.push([method, params])
    if (method === 'recall') return { state: { places } }
    if (method === 'bastion') return { ingotsTraded: 0, goldBlocksDug: 0, knownGoldLeft: 1, barterRetry: 'нет места', stopped: 'бартер встал' }
    return {}
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
test('zero trades with carried gold rotates bastion without exhaustion checkpoint', async () => {
  const { c, calls } = fixture()
  await c.readMemory(); await c.runStage('bastion')
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)')
  assert.equal(calls.some(([method, p]) => method === 'remember' && /выработан/.test(p.place || '')), false)
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
  const rpc = calls.find(([method]) => method === 'bastion')[1]
  assert.equal(rpc.exit, false)
  assert.equal(rpc.obsidian, 10)
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)')
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
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 50, z: 80 }, inventory: {} }
  const calls = []
  const c = campaign(state, {}, (method, params) => {
    calls.push([method, params])
    if (method === 'stronghold' && params.mode === 'fill') {
      state.dimension = 'the_end'
      return { entered: true }
    }
    return {}
  }, { env: { ND_BARTER_FLOW: '1', ND_SH_NETHER: '1', ND_EXIT_KIT: '1', ND_END_ENTRY: '1', ND_ENDKIT: '0' } })
  c.known.endPortal = { ...state.pos, dimension: 'overworld' }
  assert.equal(c.needs('stronghold'), true)
  assert.equal(c.done('stronghold'), false)
  await c.runStage('stronghold')
  const portal = calls.filter(([method]) => method === 'stronghold')
  assert.deepEqual(portal.map(([, params]) => params.mode), ['room', 'fill'])
  assert.equal(portal[1][1].enter, true)
  assert.equal(c.done('stronghold'), true)
  assert.equal(c.needs('stronghold'), false)
})
