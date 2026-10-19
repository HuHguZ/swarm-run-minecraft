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

test('buried iron stops at the remaining 4 ingots and does not ask for a second batch', async () => {
  const c: any = load({ stone_pickaxe: 1, oak_log: 4, crafting_table: 1 }, {} as Record<string, any>, {
    tunnel: (p, s) => { if (p.direction === 'down') s.pos.y -= p.length; return { status: 'done', detail: {} as Record<string, any> } },
    mine: (p, s) => { if (p.block.includes('iron_ore')) s.inventory.raw_iron = (s.inventory.raw_iron || 0) + p.count; return { status: 'done', detail: { dug: p.count } } }
  })
  c.setClimber(async () => true)
  await c.routeStep({ kind: 'ore', buried: true, at: { x: 0, z: 0 }, top: 64, ore: { x: 0, y: 60, z: 0 }, depth: 4 })
  const mines = c.requests.filter(([m, p]: any) => m === 'mine' && p.block.includes('iron_ore'))
  assert.equal(mines.length, 1); assert.equal(mines[0][1].count, 4)
})
test('cast1 carry target is 16 (S8b: was 12); two-bucket casting keeps 24', async () => {
  const previous = process.env.ND_ROUTE_ONE
  try {
  for (const [env, want] of [[{}, 16], [{ ND_ROUTE_ONE: '0' }, 24], [{ ND_ROUTE_QUOTAS: '0' }, 24]] as [NodeJS.ProcessEnv, number][]) {
    // route.js executes in Node while campaign.js executes in the VM.
    // Give BUCKETS() the same environment as the VM for this integration case.
    if (env.ND_ROUTE_ONE === undefined) delete process.env.ND_ROUTE_ONE
    else process.env.ND_ROUTE_ONE = env.ND_ROUTE_ONE
    const c: any = load({ bucket: 1, water_bucket: 1 }, env)
    let target; c.setWater(async () => true); c.setBlocks(async n => { target = n }); c.setCast(async () => true)
    await c.routeStep({ kind: 'castSky', at: { x: 10, y: 64, z: 0 } })
    assert.equal(target, want)
  }
  } finally {
    if (previous === undefined) delete process.env.ND_ROUTE_ONE
    else process.env.ND_ROUTE_ONE = previous
  }
})
test('known structures are tried before cheaper ore, within the shared 180s search budget', () => {
  const route = nativeRequire('./src/route')
  const info = { seed: '1', spawn: { x: 0, z: 0 }, village: { x: 40, z: 0 },
    sky: { x: 50, y: 64, z: 0, src: 100 }, ores: { ironBuried: [{ x: 1, y: 60, z: 0, n: 8, depth: 4, top: 64 }] } }
  const p = route.plan(info, { have: { stone_pickaxe: 1 }, done: ['wood', 'stone', 'bed'] })
  const ids = p.steps.map(s => s.id)
  assert.ok(ids.includes('village')); assert.ok(!ids.some(id => id.startsWith('dig:')), ids.join(','))
})
test('structure priority rollback uses cheap ore again', () => {
  const previous = process.env.ND_ROUTE_STRUCTURES_FIRST
  process.env.ND_ROUTE_STRUCTURES_FIRST = '0'
  try {
    const route = nativeRequire('./src/route')
    const info = { seed: '1', spawn: { x: 0, z: 0 }, village: { x: 200, z: 0 },
      sky: { x: 50, y: 64, z: 0, src: 100 }, ores: { ironBuried: [{ x: 1, y: 60, z: 0, n: 8, depth: 4, top: 64 }] } }
    const ids = route.plan(info, { have: { stone_pickaxe: 1 }, done: ['wood', 'stone', 'bed'] }).steps.map(s => s.id)
    assert.ok(ids.some(id => id.startsWith('dig:')), ids.join(','))
  } finally {
    if (previous === undefined) delete process.env.ND_ROUTE_STRUCTURES_FIRST
    else process.env.ND_ROUTE_STRUCTURES_FIRST = previous
  }
})
