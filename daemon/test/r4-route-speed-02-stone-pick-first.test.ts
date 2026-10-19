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

test('route stone: mine 3 with wood, craft stone pick, mine the remaining stone with it', async () => {
  const c: any = load({ oak_log: 4, wooden_pickaxe: 1, crafting_table: 1 }, { ND_ROUTE_STONETUN: '0' }, {
    mine: (p, s) => { s.inventory.cobblestone = (s.inventory.cobblestone || 0) + p.count; return { status: 'done', detail: { dug: p.count } } },
    craft: (name, n, s) => { s.inventory[name] = n; if (name === 'stone_pickaxe') s.inventory.cobblestone -= 3 }
  })
  await c.run('stone')
  const mines = c.requests.filter(([m, p]: any) => m === 'mine' && p.block === 'stone')
  assert.equal(mines[0][1].count, 3)
  const craft = c.requests.findIndex(([m, p]: any) => m === 'craft' && p.item === 'stone_pickaxe')
  const second = c.requests.findIndex(([m, p]: any, i) => i > craft && m === 'mine' && p.block === 'stone')
  assert.ok(craft > 0 && second > craft)
})
test('rollback mines the old 13-block initial batch', async () => {
  const c: any = load({ oak_log: 4, wooden_pickaxe: 1, crafting_table: 1 }, { ND_ROUTE_PICK_FIRST: '0', ND_ROUTE_STONETUN: '0' }, {
    mine: (p, s) => { s.inventory.cobblestone = 13; return { status: 'done', detail: { dug: p.count } } }
  })
  await c.run('stone')
  assert.equal(c.requests.find(([m]: any) => m === 'mine')[1].count, 13)
})
test('partial first batch upgrades the pick before asking for a second mine', async () => {
  let n = 0
  const c: any = load({ oak_log: 4, wooden_pickaxe: 1, crafting_table: 1 }, { ND_ROUTE_STONETUN: '0' }, {
    mine: (p, s) => { s.inventory.cobblestone = ++n === 1 ? 3 : 13; return { status: 'done', detail: { dug: n === 1 ? 3 : 10 } } }
  })
  await c.run('stone')
  const firstPick = c.requests.findIndex(([m, p]: any) => m === 'craft' && p.item === 'stone_pickaxe')
  const mines = c.requests.map(([m]: any, i) => m === 'mine' ? i : -1).filter(i => i >= 0)
  assert.ok(firstPick > mines[0] && firstPick < mines[1])
})
test('S8 ND_ROUTE_STONETUN=1: route stone takes 5 cobble (pick + sword), no furnace or axe in this stage', async () => {
  const c: any = load({ oak_log: 4, wooden_pickaxe: 1, crafting_table: 1, stick: 4 }, { ND_ROUTE_STONETUN: '1' }, {
    mine: (p, s) => { s.inventory.cobblestone = (s.inventory.cobblestone || 0) + p.count; return { status: 'done', detail: { dug: p.count } } },
    craft: (name, n, s) => { s.inventory[name] = n; if (name === 'stone_pickaxe') s.inventory.cobblestone -= 3; if (name === 'stone_sword') s.inventory.cobblestone -= 2 }
  })
  await c.run('stone')
  const mined = c.requests.filter(([m, p]: any) => m === 'mine' && p.block === 'stone').reduce((n, [, p]: any) => n + p.count, 0)
  assert.equal(mined, 5)
  assert.ok(!c.requests.some(([m, p]: any) => m === 'craft' && (p.item === 'furnace' || p.item === 'stone_axe')))
  assert.ok(c.state.inventory.stone_pickaxe && c.state.inventory.stone_sword)
})
