'use strict'
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'

import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
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
  vm.runInNewContext(campaignScript() + `
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
  `, cjsContext(context))
  return { ...context.module.exports, state, requests }
}

test('movement captures only a completed vertical descent in the same column', () => {
  const m = nativeRequire('./src/movement')
  assert.deepEqual(m.shaftFromDescent({ x: .5, y: 65, z: .5 }, { x: .5, y: 51, z: .5 }),
    { x: 0, z: 0, top: 65, bottom: 51 })
  assert.equal(m.shaftFromDescent({ x: -.2, y: 65, z: .5 }, { x: .2, y: 51, z: .5 }), null)
  assert.equal(m.shaftFromDescent({ x: .5, y: 65, z: .5 }, { x: .5, y: 66, z: .5 }), null)
  assert.equal(m.shaftFromDescent({ x: .5, y: NaN, z: .5 }, { x: .5, y: 51, z: .5 }), null)
})
test('route dig gives the climber its actual shaft and bottom after mining', async () => {
  const c: any = load({ stone_pickaxe: 1, oak_log: 4, crafting_table: 1 }, {} as Record<string, any>, {
    tunnel: (p, s) => { if (p.direction === 'down') s.pos.y -= p.length; return { status: 'done', detail: {} as Record<string, any> } },
    mine: (p, s) => { s.inventory.raw_iron = 4; return { status: 'done', detail: { dug: 4 } } }
  })
  c.setSituation({ surface: false })
  let shaft; c.setClimber(async () => { shaft = c.getShaft(); return true })
  await c.routeStep({ kind: 'ore', buried: true, at: { x: 0, z: 0 }, top: 64, ore: { x: 0, y: 60, z: 0 }, depth: 4 })
  assert.ok(shaft); assert.equal(shaft.top, 65); assert.equal(shaft.bottom, 61)
  assert.ok(!c.requests.some(([m]: any) => m === 'surface'))
})
test('climber failure keeps the existing surface fallback and clears the stale shaft', async () => {
  const c: any = load({ stone_pickaxe: 1, oak_log: 4, crafting_table: 1 }, {} as Record<string, any>, {
    tunnel: (p, s) => { s.pos.y -= p.length; return { status: 'done', detail: {} as Record<string, any> } },
    mine: (_, s) => { s.inventory.raw_iron = 4; return { status: 'done', detail: { dug: 4 } } }
  })
  c.setSituation({ surface: false }); c.setClimber(async () => false)
  await c.routeStep({ kind: 'ore', buried: true, at: { x: 0, z: 0 }, top: 64, ore: { x: 0, y: 60, z: 0 }, depth: 4 })
  assert.ok(c.requests.some(([m]: any) => m === 'surface'))
  assert.equal(c.getShaft(), null)
})
test('rollback leaves route shaft recording disabled', async () => {
  const c: any = load({ stone_pickaxe: 1, oak_log: 4, crafting_table: 1 }, { ND_ROUTE_SHAFT_BACK: '0' }, {
    tunnel: (p, s) => { s.pos.y -= p.length; return { status: 'done', detail: {} as Record<string, any> } },
    mine: (_, s) => { s.inventory.raw_iron = 4; return { status: 'done', detail: { dug: 4 } } }
  })
  c.setSituation({ surface: false }); let shaft; c.setClimber(async () => { shaft = c.getShaft(); return false })
  await c.routeStep({ kind: 'ore', buried: true, at: { x: 0, z: 0 }, top: 64, ore: { x: 0, y: 60, z: 0 }, depth: 4 })
  assert.equal(shaft, null)
})
