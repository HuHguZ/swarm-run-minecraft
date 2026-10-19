'use strict'
import { campaignVm } from './campaign-source'

import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import { createRequire } from 'node:module'
const root = process.env.R4_SOURCE_ROOT || path.resolve(__dirname, '../..')
const nativeRequire = createRequire(path.join(root, 'daemon/campaign.js'))
function load (inventory: any = {} as Record<string, any>, env: any = {} as Record<string, any>, hooks: any = {} as Record<string, any>) {
  const requests = []
  const state = { inventory, health: 20, food: 20, pos: { x: 0.5, y: 65, z: 0.5 }, dimension: 'overworld' }
  const context = campaignVm(`
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
  `, { base: nativeRequire, dirname: path.join(root, 'daemon'), env: { ND_ROUTE: '1', ND_OW_DEEP: '1', ...env },
    globals: { fixtureState: state, fixtureRequests: requests, fixtureHooks: hooks } })
  return { ...context.module.exports, state, requests }
}

test('route wood: existing starter toolkit and 5 logs do not trigger a second log batch/pickaxe', async () => {
  const c: any = load({ oak_log: 5, oak_planks: 10, stick: 4, wooden_pickaxe: 1, crafting_table: 1 })
  await c.run('wood')
  assert.equal(c.requests.filter(([m]: any) => m === 'mine').length, 0)
  assert.equal(c.requests.filter(([m, p]: any) => m === 'craft' && p.item === 'wooden_pickaxe').length, 0)
})
test('wood once rollback preserves the original reserve and second pick', async () => {
  const c: any = load({ oak_log: 5, oak_planks: 10, stick: 4, wooden_pickaxe: 1, crafting_table: 1 },
    { ND_ROUTE_WOOD_ONCE: '0', ND_ROUTE_WOODN: '8' }, { mine: (_, s) => { s.inventory.oak_log += 4; return { status: 'done', detail: { dug: 4 } } } })
  await c.run('wood')
  assert.ok(c.requests.some(([m]: any) => m === 'mine'))
  assert.ok(c.requests.some(([m, p]: any) => m === 'craft' && p.item === 'wooden_pickaxe'))
})
test('a pickaxe without a table cannot skip the toolkit recipes', async () => {
  const c: any = load({ oak_log: 8, wooden_pickaxe: 1 })
  await c.run('wood')
  assert.ok(c.requests.some(([m, p]: any) => m === 'craft' && p.item === 'crafting_table'))
})
test('actual A7 starter inventory: collect only 2 more logs, keep fuel reserve, skip second toolkit', async () => {
  const c: any = load({ oak_log: 3, oak_planks: 7, stick: 2, wooden_pickaxe: 1, crafting_table: 1 }, {} as Record<string, any>, {
    mine: (p, s) => { s.inventory.oak_log += p.count; return { status: 'done', detail: { dug: p.count } } }
  })
  await c.run('wood')
  assert.equal(c.requests.find(([m]: any) => m === 'mine')[1].count, 2)
  assert.equal(c.state.inventory.oak_log, 5)
  assert.equal(c.requests.filter(([m]: any) => m === 'craft').length, 0)
})
