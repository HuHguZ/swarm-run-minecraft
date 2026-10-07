'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = process.env.R4_SOURCE_ROOT || path.resolve(__dirname, '../..')
const nativeRequire = createRequire(path.join(root, 'daemon/campaign.js'))
function load (inventory: any = {} as Record<string, any>, env: any = {} as Record<string, any>, hooks: any = {} as Record<string, any>) {
  const requests = []
  const state = { inventory, health: 20, food: 20, pos: { x: 0.5, y: 65, z: 0.5 }, dimension: 'overworld' }
  class Socket { constructor () {} on () {} }
  const context = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync () {} } : nativeRequire(name),
    __dirname: path.join(root, 'daemon'), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js'], env: { ND_ROUTE: '1', ND_OW_DEEP: '1', ...env } },
    console: { log () {}, error () {} }, setTimeout, Date,
    fixtureState: state, fixtureRequests: requests, fixtureHooks: hooks
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'daemon/campaign.js'), 'utf8') + `
    state = fixtureState; sit = { surface: true, night: false, inWater: false };
    refresh = async () => {}; sense = async () => {}; nightGuard = async () => {}; recoverGuard = async () => {};
    routeLeaveOutpost = async () => {}; routeGo = async () => true;
    routeHunt = async () => {}; leaveWater = async () => {}; ensureTable = async () => {};
    furnaceBack = async () => { fixtureRequests.push(['furnaceBack', {}]) };
    toSurface = async () => { fixtureRequests.push(['surface', {}]); return true };
    act = async (name, args = {}) => {
      fixtureRequests.push([name, args]);
      const h = fixtureHooks[name];
      return h ? await h(args, state) : { status: 'done', detail: {} };
    };
    craft = async (name, n = 1) => {
      fixtureRequests.push(['craft', { item: name, count: n }]);
      if (fixtureHooks.craft) await fixtureHooks.craft(name, n, state);
      else state.inventory[name] = (state.inventory[name] || 0) + n;
      return true;
    };
    sticks = async n => { state.inventory.stick = Math.max(state.inventory.stick || 0, n) };
    smeltAll = async (from, into, opts = {}) => {
      fixtureRequests.push(['smeltAll', { from, into, ...opts }]);
      const n = Math.min(state.inventory[from] || 0, opts.max ?? Infinity);
      state.inventory[from] = (state.inventory[from] || 0) - n;
      state.inventory[into] = (state.inventory[into] || 0) + n;
    };
    module.exports = { run: name => STAGES.find(s => s.name === name).run(), routeStep, routeFood, cook,
      setSituation: s => { sit = { ...sit, ...s } }, known,
      setRouteInfo: info => { routeInfoGet = () => info },
      getShaft: () => surfaceShaft,
      setClimber: f => { climbOwnShaft = f },
      setBlocks: f => { routeBlocks = f },
      setCast: f => { castOneAt = f },
      setWater: f => { routeWater = f },
      setHunt: f => { routeHunt = f },
      setStageRun: f => { stageRun = f },
      setRouteGo: f => { routeGo = f },
      setHook: (name, f) => { fixtureHooks[name] = f }
    };
  `, context)
  return { ...context.module.exports, state, requests }
}

test('healthy A7 median fixture: cook two mutton, keep three raw, collect the furnace', async () => {
  const c: any = load({ oak_log: 5, furnace: 1, mutton: 5 })
  c.state.health = 17; c.state.food = 12
  await c.routeFood()
  assert.equal(c.state.inventory.cooked_mutton, 2)
  assert.equal(c.state.inventory.mutton, 3)
  assert.ok(c.requests.some(([m]: any) => m === 'furnaceBack'))
})
test('health below 16 preserves full cooking for healing', async () => {
  const c: any = load({ oak_log: 5, furnace: 1, mutton: 5 })
  c.state.health = 15; c.state.food = 12
  await c.routeFood()
  assert.equal(c.state.inventory.cooked_mutton, 5)
})
test('existing cooked reserve and sufficient carried food do not cook/hunt again', async () => {
  const c: any = load({ furnace: 1, cooked_mutton: 2, mutton: 3 })
  let hunts = 0; c.setHunt(async () => { hunts++ })
  await c.routeStep({ kind: 'food' })
  assert.equal(c.requests.filter(([m]: any) => m === 'smeltAll').length, 0)
  assert.equal(hunts, 0)
})
test('rollback cooks all five and retains the old food target', async () => {
  const c: any = load({ oak_log: 5, furnace: 1, mutton: 5 }, { ND_ROUTE_COOK_RESERVE: '0' })
  await c.routeFood()
  assert.equal(c.state.inventory.cooked_mutton, 5)
})
test('raw chicken is fully cooked even with a sufficient safe reserve', async () => {
  const c: any = load({ furnace: 1, oak_log: 6, cooked_mutton: 2, chicken: 4 })
  await c.routeFood()
  assert.equal(c.state.inventory.cooked_chicken, 4)
})
test('hunger at 6 preserves full cooking; mixed meals do not duplicate the 12-point reserve', async () => {
  const hungry: any = load({ furnace: 1, oak_log: 6, mutton: 5 }); hungry.state.food = 6
  await hungry.routeFood(); assert.equal(hungry.state.inventory.cooked_mutton, 5)
  const mixed: any = load({ furnace: 1, oak_log: 6, cooked_mutton: 1, salmon: 3 })
  await mixed.routeFood(); assert.equal(mixed.state.inventory.cooked_salmon, 1)
  assert.equal(mixed.state.inventory.salmon, 2)
})
test('S8: cook without fuel does not dig stone for a new furnace (raw meat is still food)', async () => {
  const c: any = load({ beef: 4, oak_planks: 1 })
  await c.cook()
  assert.ok(!c.requests.some(([m, p]: any) => m === 'mine' && p.block === 'stone'), JSON.stringify(c.requests))
  assert.ok(!c.requests.some(([m]: any) => m === 'dig_down'))
})
